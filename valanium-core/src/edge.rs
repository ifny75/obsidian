//! Cloudflare Access: service token на рукопожатии.
//!
//! Третий слой закрытого доступа (ARCHITECTURE.md §10.1). Незалогиненный запрос
//! не доходит до домашнего сервера вообще — это защита от сканеров и от дыры в
//! собственном коде, которая иначе была бы доступна всему интернету.
//!
//! **Токен здесь — не пользовательский секрет.** Он один на все сборки и лежит
//! внутри клиента, который любой может скачать и разобрать. Тайной он и не
//! задуман: его работа — отсечь ботов и сканеры до того, как их запрос коснётся
//! нашего кода. От целевой атаки он не защищает, и полагаться на него как на
//! пароль нельзя — вход по-прежнему даёт подпись на каждое соединение и инвайт
//! при регистрации. Ровно поэтому его допустимо вкомпилировать в клиент, а
//! ключи личности — нет и никогда.
//!
//! Токена может не быть: тогда заголовки не добавляются, и клиент ходит на
//! сервер без Access ровно как раньше. Это обычный случай для своего релея —
//! Cloudflare там может не быть вовсе.

use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};

use crate::error::{CoreError, Result};

/// Имена заголовков задаёт Cloudflare; свои придумать нельзя.
const HEADER_ID: HeaderName = HeaderName::from_static("cf-access-client-id");
const HEADER_SECRET: HeaderName = HeaderName::from_static("cf-access-client-secret");

/// Пара из панели Zero Trust.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceToken {
    pub client_id: String,
    pub client_secret: String,
}

impl ServiceToken {
    /// Обе половины или ничего: с одной Access всё равно не пропустит, а молча
    /// отправленная половинка выглядела бы как «токен настроен».
    pub fn new(client_id: &str, client_secret: &str) -> Option<Self> {
        let client_id = client_id.trim();
        let client_secret = client_secret.trim();
        if client_id.is_empty() || client_secret.is_empty() {
            return None;
        }
        Some(Self {
            client_id: client_id.to_owned(),
            client_secret: client_secret.to_owned(),
        })
    }
}

/// Откуда берётся токен.
///
/// Переменные окружения перекрывают вкомпилированный: так свой релей и стенд
/// проверяются без пересборки, а готовая сборка работает без настройки.
pub fn service_token() -> Option<ServiceToken> {
    let from_env = ServiceToken::new(
        &std::env::var("VALANIUM_ACCESS_CLIENT_ID").unwrap_or_default(),
        &std::env::var("VALANIUM_ACCESS_CLIENT_SECRET").unwrap_or_default(),
    );
    from_env.or_else(|| {
        ServiceToken::new(
            option_env!("VALANIUM_ACCESS_CLIENT_ID").unwrap_or_default(),
            option_env!("VALANIUM_ACCESS_CLIENT_SECRET").unwrap_or_default(),
        )
    })
}

/// Запрос на рукопожатие WebSocket — с заголовками Access, если токен есть.
pub fn ws_request(url: &str) -> Result<Request> {
    ws_request_with(url, service_token().as_ref())
}

/// То же, но с явным токеном: так это проверяется тестом, не трогая окружение
/// всего процесса.
pub fn ws_request_with(url: &str, token: Option<&ServiceToken>) -> Result<Request> {
    let mut request = url
        .into_client_request()
        .map_err(|err| CoreError::Transport(format!("неверный адрес сервера: {err}")))?;

    if let Some(token) = token {
        let headers = request.headers_mut();
        // Значение заголовка — из панели Cloudflare, и в нём не может быть
        // ничего, кроме hex и точек. Если вдруг может — лучше отказаться, чем
        // отправить обрезанный заголовок и гадать, почему Access не пускает.
        headers.insert(HEADER_ID, header_value(&token.client_id)?);
        headers.insert(HEADER_SECRET, header_value(&token.client_secret)?);
    }
    Ok(request)
}

fn header_value(raw: &str) -> Result<HeaderValue> {
    HeaderValue::from_str(raw)
        .map_err(|_| CoreError::Transport("service token содержит недопустимые символы".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "wss://valanium.com/ws";

    #[test]
    fn without_token_headers_are_absent() {
        let request = ws_request_with(URL, None).unwrap();
        assert!(request.headers().get(HEADER_ID).is_none());
        assert!(request.headers().get(HEADER_SECRET).is_none());
    }

    #[test]
    fn token_lands_in_headers() {
        let token = ServiceToken::new("id.access", "secret").unwrap();
        let request = ws_request_with(URL, Some(&token)).unwrap();
        assert_eq!(request.headers().get(HEADER_ID).unwrap(), "id.access");
        assert_eq!(request.headers().get(HEADER_SECRET).unwrap(), "secret");
        // Рукопожатие обязано остаться рукопожатием.
        assert_eq!(request.uri().to_string(), URL);
    }

    #[test]
    fn half_a_token_is_no_token() {
        assert!(ServiceToken::new("", "secret").is_none());
        assert!(ServiceToken::new("id", "").is_none());
        assert!(ServiceToken::new("  ", "  ").is_none());
        assert!(ServiceToken::new(" id ", " secret ").is_some());
    }

    #[test]
    fn broken_token_refuses_instead_of_truncating() {
        let token = ServiceToken::new("id\nx-injected: 1", "secret").unwrap();
        assert!(ws_request_with(URL, Some(&token)).is_err());
    }

    #[test]
    fn bad_url_is_reported_as_transport() {
        assert!(ws_request_with("не адрес", None).is_err());
    }
}
