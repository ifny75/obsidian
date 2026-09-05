//! Заголовки Cloudflare Access доезжают до сети, а не только до структуры.
//!
//! Модульный тест в `edge.rs` проверяет, что заголовки попали в объект запроса.
//! Этого мало: между объектом и сокетом лежит tokio-tungstenite, и вопрос «а
//! отправит ли он то, что мы положили» — ровно тот, ради которого всё писалось.
//! Здесь мы поднимаем настоящий TCP-слушатель и читаем байты рукопожатия.

use std::time::Duration;

use valanium_core::edge::{ws_request_with, ServiceToken};
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;

/// Читает первый запрос, который придёт на порт, и возвращает его как текст.
async fn capture_handshake() -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("порт не занят");
    let port = listener.local_addr().unwrap().port();

    let handle = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("клиент не пришёл");
        let mut buffer = vec![0u8; 4096];
        let read = socket.read(&mut buffer).await.unwrap_or(0);
        String::from_utf8_lossy(&buffer[..read]).into_owned()
    });

    (format!("ws://127.0.0.1:{port}/ws"), handle)
}

#[tokio::test]
async fn service_token_reaches_the_wire() {
    let (url, server) = capture_handshake().await;
    let token = ServiceToken::new("valanium.access", "s3cret-value").unwrap();
    let request = ws_request_with(&url, Some(&token)).expect("запрос собран");

    // Рукопожатие не завершится: слушатель ничего не отвечает. Нам нужны только
    // байты, которые клиент успел отправить.
    let _ = tokio::time::timeout(
        Duration::from_secs(3),
        tokio_tungstenite::connect_async(request),
    )
    .await;

    let sent = tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .expect("сервер не дождался запроса")
        .expect("задача сервера упала");

    let lowered = sent.to_lowercase();
    assert!(
        lowered.contains("cf-access-client-id: valanium.access"),
        "в рукопожатии нет client id:\n{sent}"
    );
    assert!(
        lowered.contains("cf-access-client-secret: s3cret-value"),
        "в рукопожатии нет client secret:\n{sent}"
    );
    // Это по-прежнему апгрейд до WebSocket, а не что-то другое.
    assert!(lowered.contains("upgrade: websocket"), "не рукопожатие:\n{sent}");
}

#[tokio::test]
async fn without_a_token_nothing_is_added() {
    let (url, server) = capture_handshake().await;
    let request = ws_request_with(&url, None).expect("запрос собран");

    let _ = tokio::time::timeout(
        Duration::from_secs(3),
        tokio_tungstenite::connect_async(request),
    )
    .await;

    let sent = tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .expect("сервер не дождался запроса")
        .expect("задача сервера упала");

    let lowered = sent.to_lowercase();
    assert!(!lowered.contains("cf-access-client"), "лишние заголовки:\n{sent}");
    assert!(lowered.contains("upgrade: websocket"), "не рукопожатие:\n{sent}");
}
