//! Встроенный Tor: локальный SOCKS5 поверх Arti.
//!
//! # Зачем в ядре
//!
//! На Windows Tor приезжает отдельной программой, на Android — не может:
//! система с Android 10 запрещает исполнять файлы из каталога данных
//! приложения. Значит, на телефоне Tor обязан жить внутри библиотеки.
//!
//! Реализация при этом нужна одна. Разложить её по двум местам значило бы
//! чинить каждую находку дважды и однажды забыть про вторую.
//!
//! # Почему именно SOCKS, а не прямой вызов
//!
//! Клиент уже умеет ходить через SOCKS5 — так он работает с Tor Browser и
//! Orbot. Подняв свой SOCKS рядом и назвав его адрес, мы включаем Tor, не
//! трогая сетевой слой вовсе. Стоит это одного лишнего соединения по петле,
//! а экономит развилку «через Arti или через прокси» в каждом месте, где
//! открывается сокет.
//!
//! # Что здесь важно для приватности
//!
//! Каталог состояния задаёт вызывающий. Arti по умолчанию кладёт его в профиль
//! пользователя, и там живёт `guards.json` — список входных узлов этого
//! человека, то есть постоянный след «пользовался Tor, вот через кого».
//! Приложение обязано положить его туда, где умеет вычистить.
//!
//! Слушаем только петлю: привязка к `0.0.0.0` раздала бы Tor всей сети.
//! И пропускаем только `.onion` — выход в открытый интернет от нашего имени
//! нам не нужен, а всякий, кто найдёт порт, им бы воспользовался.

use std::net::SocketAddr;
use std::path::Path;

use arti_client::config::TorClientConfigBuilder;
use arti_client::TorClient;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tor_rtcompat::PreferredRuntime;

use crate::error::{CoreError, Result};

/// Поднимает Tor и локальный SOCKS5, возвращает его адрес.
///
/// Блокирует поток на время построения цепи: первая занимает около минуты,
/// последующие — секунды. Вызывать только с фонового потока.
///
/// Слушатель остаётся жить после возврата: он и есть то, ради чего звали.
pub fn start(data_dir: &Path) -> Result<SocketAddr> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|err| CoreError::Transport(format!("не поднять рантайм: {err}")))?;

    let config = TorClientConfigBuilder::from_directories(
        data_dir.join("state"),
        data_dir.join("cache"),
    )
    .build()
    .map_err(|err| CoreError::Transport(format!("настройка Tor: {err}")))?;

    let (client, listener) = runtime.block_on(async {
        let client = TorClient::create_bootstrapped(config)
            .await
            .map_err(|err| CoreError::Transport(format!("Tor не построил цепь: {err}")))?;
        // Порт выбирает система: 9050 занимает системный Tor, 9150 — Tor
        // Browser, и фиксированный номер означал бы либо отказ подняться, либо
        // увод чужого трафика.
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|err| CoreError::Transport(format!("не занять порт: {err}")))?;
        Ok::<_, CoreError>((client, listener))
    })?;

    let address = listener
        .local_addr()
        .map_err(|err| CoreError::Transport(err.to_string()))?;

    // Рантайм отдаём потоку: уронив его здесь, мы закрыли бы и слушатель.
    std::thread::Builder::new()
        .name("valanium-tor".into())
        .spawn(move || {
            runtime.block_on(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else { return };
                    let client = client.isolated_client();
                    tokio::spawn(async move {
                        let _ = serve(socket, client).await;
                    });
                }
            });
        })
        .map_err(|err| CoreError::Transport(err.to_string()))?;

    Ok(address)
}

/// Минимальный SOCKS5: только CONNECT и только без аутентификации.
///
/// Вручную намеренно: нужен ровно один сценарий, и разбор его короче, чем
/// подключение библиотеки. Слушаем петлю, поэтому разбираем только то, что
/// прислал наш же клиент.
async fn serve(mut socket: TcpStream, client: TorClient<PreferredRuntime>) -> Result<()> {
    let bad = |what: &str| CoreError::Transport(what.to_owned());

    let mut head = [0u8; 2];
    socket.read_exact(&mut head).await.map_err(|_| bad("обрыв приветствия"))?;
    if head[0] != 0x05 {
        return Err(bad("не SOCKS5"));
    }
    let mut methods = vec![0u8; head[1] as usize];
    socket.read_exact(&mut methods).await.map_err(|_| bad("обрыв методов"))?;
    socket.write_all(&[0x05, 0x00]).await.map_err(|_| bad("обрыв ответа"))?;

    let mut request = [0u8; 4];
    socket.read_exact(&mut request).await.map_err(|_| bad("обрыв запроса"))?;
    if request[1] != 0x01 {
        let _ = socket.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        return Err(bad("поддерживается только CONNECT"));
    }

    let host = match request[3] {
        0x01 => {
            let mut raw = [0u8; 4];
            socket.read_exact(&mut raw).await.map_err(|_| bad("обрыв адреса"))?;
            std::net::Ipv4Addr::from(raw).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            socket.read_exact(&mut len).await.map_err(|_| bad("обрыв длины"))?;
            let mut raw = vec![0u8; len[0] as usize];
            socket.read_exact(&mut raw).await.map_err(|_| bad("обрыв имени"))?;
            String::from_utf8(raw).map_err(|_| bad("имя не UTF-8"))?
        }
        0x04 => {
            let mut raw = [0u8; 16];
            socket.read_exact(&mut raw).await.map_err(|_| bad("обрыв адреса"))?;
            std::net::Ipv6Addr::from(raw).to_string()
        }
        _ => {
            let _ = socket.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
            return Err(bad("неизвестный тип адреса"));
        }
    };

    let mut port = [0u8; 2];
    socket.read_exact(&mut port).await.map_err(|_| bad("обрыв порта"))?;
    let port = u16::from_be_bytes(port);

    // Только скрытые сервисы. Открытый выход через нас — это чужой трафик от
    // нашего имени и жалобы нам же.
    if !host.ends_with(".onion") {
        let _ = socket.write_all(&[0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        return Err(bad("не onion-адрес"));
    }

    let mut tunnel = match client.connect((host.as_str(), port)).await {
        Ok(stream) => stream,
        Err(_) => {
            let _ = socket.write_all(&[0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
            return Err(bad("узел недоступен"));
        }
    };

    socket
        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|_| bad("обрыв подтверждения"))?;

    tokio::io::copy_bidirectional(&mut socket, &mut tunnel)
        .await
        .map_err(|_| bad("соединение закрыто"))?;
    Ok(())
}
