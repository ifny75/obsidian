//! Встроенный Tor: локальный SOCKS5 поверх Arti, внутри процесса.
//!
//! # Зачем внутри ядра
//!
//! На Windows Tor приезжает отдельной программой: скачали, запустили, показали
//! клиенту адрес её SOCKS5. На Android так нельзя — система с Android 10
//! запрещает исполнять файлы из каталога данных приложения, и скачанный бинарь
//! просто не запустится. Значит, там Tor обязан ехать внутри, и логика у обеих
//! платформ одна: поднять SOCKS5 на петле и сказать клиенту его адрес.
//!
//! Второй копии этой логики быть не должно. Разошлись бы они не сразу и не
//! очевидно — например, в том, какие адреса пропускать, — и на одной платформе
//! Onion молча стал бы слабее, чем на другой.
//!
//! # Что здесь важно для приватности
//!
//! **Каталог состояния задаёт вызывающий.** Arti по умолчанию кладёт его в
//! профиль пользователя, и там живёт `guards.json` — список входных узлов Tor
//! этого человека. Это ровно та метаданная, от которой Onion должен защищать:
//! постоянный след «пользовался Tor, вот через кого». Приложение кладёт его
//! туда же, где остальное, что оно умеет вычистить.
//!
//! **Слушаем только петлю.** Иначе это открытый Tor-прокси для всей сети.
//!
//! **Только .onion.** Пускать наружу произвольный трафик мы не обязаны, а
//! всякий, кто нашёл порт, тут же начал бы — и жалобы пришли бы нам.
//!
//! **Порт выбирает система.** Фиксированный номер занят на любой машине, где
//! уже стоит Tor Browser: проверено, 9150 и 9151 оказались заняты сразу.

use std::net::SocketAddr;
use std::path::Path;

use arti_client::config::TorClientConfigBuilder;
use arti_client::TorClient;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tor_rtcompat::PreferredRuntime;

use crate::error::{CoreError, Result};

/// Поднимает Tor и локальный SOCKS5. Возвращает адрес, на котором слушает.
///
/// Возврат происходит **после** построения цепи: до неё соединения принимать
/// бессмысленно, а сообщить «готово» раньше времени значит подсунуть клиенту
/// адрес, который откажет.
pub async fn start(data_dir: &Path) -> Result<SocketAddr> {
    // Разными каталогами: кэш каталога Tor можно потерять без последствий, а
    // состояние — это и есть входные узлы, и обращаться с ними надо иначе.
    let config = TorClientConfigBuilder::from_directories(
        data_dir.join("state"),
        data_dir.join("cache"),
    )
    .build()
    .map_err(|err| CoreError::Transport(format!("настройка Tor: {err}")))?;

    let client = TorClient::create_bootstrapped(config)
        .await
        .map_err(|err| CoreError::Transport(format!("цепь Tor не построилась: {err}")))?;

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|err| CoreError::Transport(err.to_string()))?;
    // Спрашиваем у сокета, а не печатаем то, что просили: порт выбрала система.
    let bound = listener.local_addr().map_err(|err| CoreError::Transport(err.to_string()))?;

    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            // Отдельная цепь на соединение: иначе два разных собеседника делили
            // бы один путь, и наблюдатель на нём видел бы их вместе.
            let client = client.isolated_client();
            tokio::spawn(async move {
                let _ = serve(socket, client).await;
            });
        }
    });

    Ok(bound)
}

/// Минимальный SOCKS5: только CONNECT и только без аутентификации.
///
/// Вручную намеренно: нужен ровно один сценарий, а библиотека ради него — это
/// больше кода и больше зависимостей, чем сам разбор. Слушаем петлю, поэтому
/// разбираем только то, что прислал наш же клиент.
async fn serve(mut socket: TcpStream, client: TorClient<PreferredRuntime>) -> std::io::Result<()> {
    let mut head = [0u8; 2];
    socket.read_exact(&mut head).await?;
    if head[0] != 0x05 {
        return Ok(());
    }
    let mut methods = vec![0u8; head[1] as usize];
    socket.read_exact(&mut methods).await?;
    socket.write_all(&[0x05, 0x00]).await?;

    let mut request = [0u8; 4];
    socket.read_exact(&mut request).await?;
    if request[1] != 0x01 {
        socket.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
        return Ok(());
    }

    let host = match request[3] {
        0x01 => {
            let mut raw = [0u8; 4];
            socket.read_exact(&mut raw).await?;
            std::net::Ipv4Addr::from(raw).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            socket.read_exact(&mut len).await?;
            let mut raw = vec![0u8; len[0] as usize];
            socket.read_exact(&mut raw).await?;
            match String::from_utf8(raw) {
                Ok(name) => name,
                Err(_) => {
                    socket.write_all(&[0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
                    return Ok(());
                }
            }
        }
        0x04 => {
            let mut raw = [0u8; 16];
            socket.read_exact(&mut raw).await?;
            std::net::Ipv6Addr::from(raw).to_string()
        }
        _ => {
            socket.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
            return Ok(());
        }
    };

    let mut port = [0u8; 2];
    socket.read_exact(&mut port).await?;
    let port = u16::from_be_bytes(port);

    // Только скрытые сервисы. Открытый выход в интернет через Tor от нашего
    // имени нам не нужен, а жалобы за него пришли бы нам.
    if !host.ends_with(".onion") {
        socket.write_all(&[0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
        return Ok(());
    }

    let mut tunnel = match client.connect((host.as_str(), port)).await {
        Ok(stream) => stream,
        Err(_) => {
            socket.write_all(&[0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
            return Ok(());
        }
    };

    socket.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
    tokio::io::copy_bidirectional(&mut socket, &mut tunnel).await?;
    Ok(())
}
