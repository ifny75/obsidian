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

/// Тот же ключ, но двадцатью четырьмя словами.
///
/// Формат BIP39: 256 бит ключа плюс восемь бит контрольной суммы дают ровно 24
/// слова из словаря в 2048 штук. Словарь не наш: он выверен так, что первые
/// четыре буквы у всех слов различны, а похожие пары в него не попали — это
/// именно то, чего нельзя добиться, придумав список за вечер.
///
/// Зачем рядом с кодом из 55 символов: строку `KQ3F7 XL2M9 …` человек
/// переписывает с бумаги по одному знаку и ошибается, а слова он читает. Ключ
/// за обоими стоит один и тот же — это две записи одного и того же, а не два
/// разных способа восстановления.
pub fn encode_words(identity: &SecretKey) -> String {
    // 32 байта — ровно та энтропия, которую BIP39 превращает в 24 слова.
    bip39::Mnemonic::from_entropy(&identity.to_bytes())
        .expect("32 байта — допустимая длина энтропии BIP39")
        .to_string()
}

/// Разбирает фразу из 24 слов.
///
/// Регистр и лишние пробелы не важны. Контрольная сумма BIP39 обязательна: без
/// неё опечатка в одном слове молча дала бы **другую** валидную личность.
pub fn decode_words(phrase: &str) -> Result<SecretKey> {
    let cleaned = phrase.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    let mnemonic = bip39::Mnemonic::parse_in_normalized(bip39::Language::English, &cleaned)
        .map_err(|_| CoreError::BadRecoveryCode("фраза введена с ошибкой"))?;

    let (entropy, len) = mnemonic.to_entropy_array();
    if len != KEY_LEN {
        // 12 слов — валидная мнемоника, но не наш ключ: чужую фразу лучше
        // отвергнуть, чем принять и завести пустую личность.
        return Err(CoreError::BadRecoveryCode("нужны 24 слова"));
    }
    SecretKey::from_bytes(&entropy[..KEY_LEN])
}

/// Сколько слов в фразе восстановления.
pub const WORDS: usize = 24;

/// Разбирает код, введённый человеком.
///
/// Пробелы, дефисы и регистр не важны: люди переписывают как придётся.
/// Контрольная сумма обязательна — без неё опечатка молча дала бы **другую**
/// валидную личность, и человек стал бы посторонним, не поняв почему.
pub fn decode(code: &str) -> Result<SecretKey> {
    // Человек вставляет то, что у него записано, и не обязан знать, как это
    // называется. Фразу узнаём по числу слов — у кода из 55 символов групп
    // одиннадцать, спутать нельзя.
    if code.split_whitespace().count() == WORDS {
        return decode_words(code);
    }

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

    // --- фраза из 24 слов ---------------------------------------------------

    #[test]
    fn a_phrase_survives_a_round_trip() {
        let identity = SecretKey::generate();
        let phrase = encode_words(&identity);
        assert_eq!(phrase.split_whitespace().count(), WORDS);
        assert_eq!(decode_words(&phrase).unwrap().to_bytes(), identity.to_bytes());
    }

    #[test]
    fn a_phrase_is_read_by_the_common_entrance_too() {
        // Человек вставляет то, что у него записано, не думая о формате.
        let identity = SecretKey::generate();
        let phrase = encode_words(&identity);
        assert_eq!(decode(&phrase).unwrap().to_bytes(), identity.to_bytes());
        // И код из 55 символов по-прежнему читается там же.
        let code = encode(&identity);
        assert_eq!(decode(&code).unwrap().to_bytes(), identity.to_bytes());
    }

    #[test]
    fn case_and_extra_spaces_do_not_matter() {
        let identity = SecretKey::generate();
        let phrase = encode_words(&identity);
        let mangled = format!("  {}  ", phrase.to_uppercase().replace(' ', "   "));
        assert_eq!(decode_words(&mangled).unwrap().to_bytes(), identity.to_bytes());
    }

    #[test]
    fn a_typo_in_one_word_is_caught() {
        // Подменяем одно слово на другое из словаря: контрольная сумма BIP39
        // обязана это заметить, иначе человек получил бы чужую личность.
        let identity = SecretKey::generate();
        let phrase = encode_words(&identity);
        let mut words: Vec<&str> = phrase.split(' ').collect();
        let replacement = if words[0] == "abandon" { "ability" } else { "abandon" };
        words[0] = replacement;
        assert!(decode_words(&words.join(" ")).is_err());
    }

    #[test]
    fn a_shorter_mnemonic_is_not_our_key() {
        // Валидная фраза BIP39 из 12 слов — чужая: у неё 16 байт энтропии.
        let twelve = "abandon abandon abandon abandon abandon abandon                       abandon abandon abandon abandon abandon about";
        let normalized = twelve.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(matches!(decode_words(&normalized), Err(CoreError::BadRecoveryCode(_))));
    }

    #[test]
    fn a_word_outside_the_list_is_refused() {
        let identity = SecretKey::generate();
        let phrase = encode_words(&identity);
        let spoiled = phrase.replacen(phrase.split(' ').next().unwrap(), "обсидиан", 1);
        assert!(decode_words(&spoiled).is_err());
    }
}
