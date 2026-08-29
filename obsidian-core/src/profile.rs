//! Аватар, которого сервер не видит.
//!
//! # Зачем
//!
//! Правило `profile_avatar` по умолчанию стоит на «контакты» — и до сих пор
//! означало только то, что клиент не покажет аватар постороннему. Сам аватар
//! при этом лежал у сервера открытым: он его раздавал, значит и видел.
//!
//! Настройка, которую соблюдает лишь тот, кого она ограничивает, — не
//! настройка. Здесь она становится настоящей: аватар шифруется до отправки
//! ключом, который знают только контакты, а серверу достаётся непрозрачный
//! блоб. Ключ уезжает контактам служебным сообщением внутри шифрованного
//! канала — тем же путём, что и пропуска.
//!
//! # Чего это не делает
//!
//! Не прячет факт, что аватар есть, и его размер: блоб лежит у сервера, и
//! длину он видит. Не отменяет того, что аватар уже видели: ключ у контакта
//! остаётся, и картинка у него сохранена.
//!
//! И не работает, когда правило стоит на «всех». Там нечего прятать: аватар
//! показывается кому угодно, включая сервер, — и шифровать его было бы
//! спектаклем.

use crate::crypto::{random_bytes, MasterKey, KEY_LEN};
use crate::error::{CoreError, Result};

/// Тип содержимого, которым помечен запечатанный аватар.
///
/// Нужен, чтобы отличить его от настоящей картинки, ничего не расшифровывая, —
/// и чтобы клиент, который про шифрование не знает, показал пустой кружок с
/// инициалами, а не сломанное изображение.
pub const SEALED_MIME: &str = "application/vnd.obsidian.sealed-avatar";

/// AAD: привязывает блоб к назначению. Тем же ключом запечатанное что-то другое
/// этой парой не откроется.
const AAD: &[u8] = b"obsidian-avatar-v1";

/// Новый ключ профиля. Раздаётся контактам, меняется вместе с решением
/// «показывать заново».
pub fn new_key() -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&random_bytes(KEY_LEN));
    key
}

/// Запечатывает аватар. На входе и на выходе — base64: по проводу это одно и
/// то же поле, только внутри уже шифротекст.
///
/// Картинка шифруется сырыми байтами, а не своим base64: иначе шифротекст был
/// бы на треть длиннее самой картинки, и аватар, который прежде помещался в
/// отведённые серверу 256 КиБ, перестал бы помещаться.
///
/// Формат открытого текста: длина типа (1 байт), сам тип, дальше байты
/// картинки. Тип прячется вместе с ней — по нему видно, чем снимали.
pub fn seal(key: &[u8], mime: &str, base64_image: &str) -> Result<String> {
    let master = MasterKey::from_bytes(key)?;
    let image = base64_decode(base64_image)?;
    let mime = mime.as_bytes();
    if mime.len() > u8::MAX as usize {
        return Err(CoreError::BadFrame);
    }

    let mut plain = Vec::with_capacity(1 + mime.len() + image.len());
    plain.push(mime.len() as u8);
    plain.extend_from_slice(mime);
    plain.extend_from_slice(&image);

    Ok(base64_encode(&master.seal(AAD, &plain)?))
}

/// Разбирает запечатанный аватар обратно в пару «тип, картинка в base64».
pub fn open(key: &[u8], sealed_base64: &str) -> Result<(String, String)> {
    let master = MasterKey::from_bytes(key)?;
    let plain = master.open(AAD, &base64_decode(sealed_base64)?)?;

    let length = *plain.first().ok_or(CoreError::BadFrame)? as usize;
    if plain.len() < 1 + length {
        return Err(CoreError::BadFrame);
    }
    let mime = std::str::from_utf8(&plain[1..1 + length]).map_err(|_| CoreError::BadFrame)?;
    Ok((mime.to_owned(), base64_encode(&plain[1 + length..])))
}

/// Помечен ли профиль как запечатанный.
pub fn is_sealed(mime: Option<&str>) -> bool {
    mime == Some(SEALED_MIME)
}

// --- base64 ------------------------------------------------------------------
//
// Свой, потому что зависимости на base64 в ядре нет, а нужен он ровно здесь и
// ровно в одном виде: стандартный алфавит с выравниванием.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18 & 63) as usize] as char);
        out.push(ALPHABET[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[(n & 63) as usize] as char } else { '=' });
    }
    out
}

fn base64_decode(text: &str) -> Result<Vec<u8>> {
    let mut bits = 0u32;
    let mut have = 0u32;
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    for symbol in text.bytes() {
        if symbol == b'=' || symbol == b'\n' || symbol == b'\r' {
            continue;
        }
        let value = ALPHABET.iter().position(|c| *c == symbol).ok_or(CoreError::BadFrame)? as u32;
        bits = bits << 6 | value;
        have += 6;
        if have >= 8 {
            have -= 8;
            out.push((bits >> have) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Картинка в том же виде, в каком её носит команда: base64.
    const IMAGE: &str = "iVBORw0KGgoAAAANSUhEUg==";

    #[test]
    fn a_sealed_avatar_comes_back_whole() {
        let key = new_key();
        let sealed = seal(&key, "image/png", IMAGE).unwrap();
        assert_ne!(sealed, IMAGE, "шифротекст не должен совпадать с картинкой");
        assert!(!sealed.contains(IMAGE), "картинка не должна лежать внутри целиком");

        let (mime, data) = open(&key, &sealed).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(data, IMAGE);

        // Шифротекст не должен раздувать картинку: серверу отведено 256 КиБ,
        // и аватар, который помещался прежде, обязан помещаться и запечатанным.
        let image_bytes = IMAGE.len() * 3 / 4;
        let sealed_bytes = sealed.len() * 3 / 4;
        assert!(
            sealed_bytes < image_bytes + 128,
            "прибавка {} байт слишком велика",
            sealed_bytes - image_bytes,
        );
    }

    #[test]
    fn another_key_does_not_open_it() {
        let sealed = seal(&new_key(), "image/png", IMAGE).unwrap();
        assert!(open(&new_key(), &sealed).is_err(), "чужой ключ не должен открывать");
    }

    #[test]
    fn a_tampered_blob_is_refused() {
        let key = new_key();
        let sealed = seal(&key, "image/png", IMAGE).unwrap();

        // Правка любого символа обязана быть замечена: иначе сервер мог бы
        // подменить картинку, не зная ключа.
        let mut broken: Vec<char> = sealed.chars().collect();
        let last = broken.len() - 6;
        broken[last] = if broken[last] == 'A' { 'B' } else { 'A' };
        let spoiled: String = broken.into_iter().collect();
        assert!(open(&key, &spoiled).is_err());

        // И обрезанный тоже.
        assert!(open(&key, &sealed[..sealed.len() / 2]).is_err());
        assert!(open(&key, "не base64 вовсе").is_err());
    }

    #[test]
    fn the_marker_tells_a_sealed_avatar_from_a_picture() {
        assert!(is_sealed(Some(SEALED_MIME)));
        assert!(!is_sealed(Some("image/png")));
        assert!(!is_sealed(None));
    }

    #[test]
    fn base64_round_trips_every_length() {
        // Хвосты по одному и по два байта — то место, где такой код обычно и врёт.
        for length in 0..64usize {
            let bytes: Vec<u8> = (0..length).map(|i| (i * 7 % 251) as u8).collect();
            let text = base64_encode(&bytes);
            assert_eq!(base64_decode(&text).unwrap(), bytes, "длина {length}");
            assert_eq!(text.len() % 4, 0, "выравнивание обязано быть, длина {length}");
        }
    }
}
