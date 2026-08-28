//! Секрет для приложения с одноразовыми кодами.
//!
//! Ядро его только **создаёт и показывает**: считать и проверять коды здесь
//! незачем, это делает сервер, когда решает, отдавать ли запечатанную посылку
//! (`obsidian-server/src/auth/totp.ts`).
//!
//! **Секрет — не ключ от переписки.** Он не участвует ни в шифровании, ни в
//! расшифровке: посылку с identity-ключом по-прежнему открывает только пароль.
//! Одноразовый код решает другое — отдавать ли посылку вообще. Логин
//! угадывается, пароль перебирается, и второй фактор превращает перебор из
//! долгого в невозможный.
//!
//! Случайность берётся оттуда же, откуда все ключи, — из `OsRng`. Своего
//! генератора «для мелочей» здесь нет и быть не должно.

use rand_core::{OsRng, RngCore};

/// RFC 4648 §6 — алфавит, в котором секрет показывают все аутентификаторы.
const BASE32: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// 20 байт — размер выхода SHA-1, как советует RFC 4226. Больше не вредно, но
/// и не полезно: код всё равно шестизначный.
const SECRET_BYTES: usize = 20;

/// Новый секрет: в base32 для человека и ссылкой для QR-кода.
pub struct Secret {
    /// То, что человек перепишет руками, если камеры под рукой нет.
    pub base32: String,
    /// То, что читает камера. Формат задан приложениями, не нами.
    pub url: String,
}

/// Заводит секрет для этой личности.
///
/// `label` попадает в приложение подписью под названием — по ней человек
/// отличит одну учётную запись от другой. Это логин восстановления, а не
/// адрес устройства: адрес в списке кодов ничего не скажет.
pub fn new_secret(label: &str) -> Secret {
    let mut raw = [0u8; SECRET_BYTES];
    OsRng.fill_bytes(&mut raw);

    let base32 = encode_base32(&raw);
    let url = format!(
        "otpauth://totp/Obsidian:{}?secret={}&issuer=Obsidian&algorithm=SHA1&digits=6&period=30",
        percent_encode(label),
        base32,
    );
    Secret { base32, url }
}

/// Группами по четыре: секрет переписывают руками, и сплошная строка из
/// тридцати двух знаков для этого не годится.
pub fn readable(base32: &str) -> String {
    base32
        .as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>()
        .join(" ")
}

fn encode_base32(input: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits = 0u32;

    for byte in input {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32[((buffer >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(BASE32[((buffer << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

/// Ровно столько, сколько нужно для метки в otpauth-ссылке.
fn percent_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_is_base32_of_the_right_length() {
        let secret = new_secret("alice");
        // 20 байт → 32 символа base32 без хвостового набивания.
        assert_eq!(secret.base32.len(), 32);
        assert!(secret.base32.bytes().all(|b| BASE32.contains(&b)), "{}", secret.base32);
    }

    #[test]
    fn two_secrets_are_not_the_same() {
        assert_ne!(new_secret("alice").base32, new_secret("alice").base32);
    }

    #[test]
    fn the_url_carries_what_the_app_needs() {
        let secret = new_secret("alice");
        assert!(secret.url.starts_with("otpauth://totp/Obsidian:alice?"));
        assert!(secret.url.contains(&format!("secret={}", secret.base32)));
        assert!(secret.url.contains("digits=6"));
        assert!(secret.url.contains("period=30"));
    }

    #[test]
    fn a_label_with_spaces_does_not_break_the_url() {
        let secret = new_secret("моя почта");
        assert!(!secret.url.contains(' '), "{}", secret.url);
        assert!(secret.url.contains("%20"), "{}", secret.url);
    }

    #[test]
    fn readable_groups_by_four() {
        assert_eq!(readable("ABCDEFGH"), "ABCD EFGH");
        // Хвост короче четырёх остаётся как есть, а не дополняется.
        assert_eq!(readable("ABCDEF"), "ABCD EF");
    }
}
