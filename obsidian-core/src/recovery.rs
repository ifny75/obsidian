//! Код восстановления личности.
//!
//! Это сам identity-ключ, записанный так, чтобы его можно было переписать на
//! бумагу и ввести обратно без ошибок. Отдельного «сида», из которого ключ
//! выводится, нет намеренно: тогда код умели бы получить только новые аккаунты,
//! а уже зарегистрированным пришлось бы менять личность. Здесь код умеет выдать
//! кто угодно и когда угодно.
//!
//! **Что код восстанавливает.** Личность и доступность для контактов: на новом
//! устройстве генерируется свой ключ устройства, подписывается восстановленным
//! identity-ключом, и сервер принимает его без инвайта — личность-то ему
//! известна. **Переписку он не восстанавливает и не может**: старые сообщения
//! защищены forward secrecy, ключи от них уничтожены вместе со старым
//! устройством. Это не недоделка, это то, ради чего всё затевалось.
//!
//! **Код равен личности.** Кто им владеет — тот может добавить себе устройство
//! от вашего имени. Контакты это заметят (код сверки сменится), но постфактум.

use sha2::{Digest, Sha256};

use crate::error::{CoreError, Result};
use crate::keys::SecretKey;

/// RFC 4648. Ни `0`/`O`, ни `1`/`I` — их путают при переписывании от руки.
const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const KEY_LEN: usize = 32;
/// Двух байт хватает: опечатка пройдёт с вероятностью 1/65536, а длина кода
/// от этого почти не растёт.
const CHECKSUM_LEN: usize = 2;
const PAYLOAD_LEN: usize = KEY_LEN + CHECKSUM_LEN;
/// `ceil(34 * 8 / 5)`
const CODE_LEN: usize = 55;
/// По сколько символов группировать при показе.
const GROUP: usize = 5;

const DOMAIN: &[u8] = b"obsidian-recovery-v1";

/// Код для показа пользователю — группами, через пробел.
pub fn encode(identity: &SecretKey) -> String {
    let key = identity.to_bytes();

    let mut payload = Vec::with_capacity(PAYLOAD_LEN);
    payload.extend_from_slice(&key);
    payload.extend_from_slice(&checksum(&key));

    let raw = base32_encode(&payload);
    raw.as_bytes()
        .chunks(GROUP)
        .map(|group| std::str::from_utf8(group).unwrap_or_default())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Разбирает код, введённый человеком.
///
/// Пробелы, дефисы и регистр не важны: люди переписывают как придётся.
/// Контрольная сумма обязательна — без неё опечатка молча дала бы **другую**
/// валидную личность, и человек стал бы посторонним, не поняв почему.
pub fn decode(code: &str) -> Result<SecretKey> {
    let cleaned: Vec<u8> = code
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace() && *byte != b'-' && *byte != b'_')
        .map(|byte| byte.to_ascii_uppercase())
        .collect();

    if cleaned.len() != CODE_LEN {
        return Err(CoreError::BadRecoveryCode("длина кода не та"));
    }

    let payload = base32_decode(&cleaned)?;
    if payload.len() < PAYLOAD_LEN {
        return Err(CoreError::BadRecoveryCode("код повреждён"));
    }

    let (key, tail) = payload.split_at(KEY_LEN);
    if tail[..CHECKSUM_LEN] != checksum(key) {
        return Err(CoreError::BadRecoveryCode("код введён с ошибкой"));
    }
    SecretKey::from_bytes(key)
}

fn checksum(key: &[u8]) -> [u8; CHECKSUM_LEN] {
    let mut hasher = Sha256::new();
    hasher.update(DOMAIN);
    hasher.update(key);
    let digest = hasher.finalize();
    [digest[0], digest[1]]
}

fn base32_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(CODE_LEN);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;

    for byte in input {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        // Хвост дополняется нулями: паддинга '=' здесь нет, длина фиксированная.
        out.push(ALPHABET[((buffer << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

fn base32_decode(input: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(PAYLOAD_LEN);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;

    for symbol in input {
        let value = ALPHABET
            .iter()
            .position(|candidate| candidate == symbol)
            .ok_or(CoreError::BadRecoveryCode("в коде посторонний символ"))?;

        buffer = (buffer << 5) | value as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }

    // Хвостовые биты обязаны быть нулевыми. Без этой проверки опечатка в
    // последнем символе — он несёт всего три значащих бита — меняла бы только
    // набивку и проходила бы мимо контрольной суммы.
    if bits > 0 && buffer & ((1 << bits) - 1) != 0 {
        return Err(CoreError::BadRecoveryCode("код введён с ошибкой"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_round_trips() {
        let identity = SecretKey::generate();
        let restored = decode(&encode(&identity)).unwrap();
        assert_eq!(restored.to_bytes(), identity.to_bytes());
        assert_eq!(restored.public(), identity.public());
    }

    #[test]
    fn code_is_readable_and_fixed_length() {
        let code = encode(&SecretKey::generate());
        assert_eq!(code.split(' ').count(), 11);
        assert_eq!(code.replace(' ', "").len(), CODE_LEN);
        assert!(code.chars().all(|c| c == ' ' || ALPHABET.contains(&(c as u8))));
    }

    /// Люди переписывают код как получится — разбор обязан это терпеть.
    #[test]
    fn formatting_does_not_matter() {
        let identity = SecretKey::generate();
        let code = encode(&identity);
        let expected = identity.to_bytes();

        for variant in [
            code.replace(' ', ""),
            code.replace(' ', "-"),
            code.to_lowercase(),
            format!("  {code}  "),
            code.replace(' ', "\n"),
        ] {
            assert_eq!(decode(&variant).unwrap().to_bytes(), expected, "вариант: {variant}");
        }
    }

    /// Главное свойство: опечатка обязана быть видна сразу, а не превратить
    /// человека в постороннего с валидным, но чужим ключом.
    #[test]
    fn a_single_typo_is_caught() {
        let code = encode(&SecretKey::generate()).replace(' ', "");

        let mut caught = 0;
        for position in 0..code.len() {
            let mut broken: Vec<u8> = code.bytes().collect();
            // Меняем символ на соседний по алфавиту.
            let current = ALPHABET.iter().position(|c| *c == broken[position]).unwrap();
            broken[position] = ALPHABET[(current + 1) % ALPHABET.len()];

            if decode(std::str::from_utf8(&broken).unwrap()).is_err() {
                caught += 1;
            }
        }
        // Контрольная сумма — два байта, поэтому пропуск теоретически возможен,
        // но на одиночных опечатках его быть не должно.
        assert_eq!(caught, code.len(), "не пойманы все одиночные опечатки");
    }

    #[test]
    fn garbage_is_rejected_with_a_reason() {
        for bad in ["", "слишком коротко", "0000", &"A".repeat(CODE_LEN)] {
            assert!(matches!(decode(bad), Err(CoreError::BadRecoveryCode(_))), "принято: {bad}");
        }
    }

    #[test]
    fn cyrillic_lookalikes_are_rejected_not_guessed() {
        // «А» кириллическая вместо латинской — код молча подменять нельзя.
        let code = encode(&SecretKey::generate()).replace(' ', "");
        let spoiled = format!("А{}", &code[1..]);
        assert!(decode(&spoiled).is_err());
    }

    #[test]
    fn different_identities_give_different_codes() {
        assert_ne!(encode(&SecretKey::generate()), encode(&SecretKey::generate()));
    }
}
