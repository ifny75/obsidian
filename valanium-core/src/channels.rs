//! Авторство постов в канале.
//!
//! # Зачем
//!
//! Канал открыт по замыслу: его содержимое не шифруется, потому что шифровать
//! вещание для неизвестного круга — самообман. Из этого, однако, не следует,
//! что автора можно не проверять.
//!
//! Право писать проверял только сервер: он смотрел, владелец ли это, и клал
//! текст в таблицу. Значит, захвативший сервер мог писать от имени любого
//! канала и переписывать историю задним числом, а читатель не отличил бы это
//! ни от чего. Открытость содержимого — размен, принятый осознанно; поддельное
//! авторство никем не принималось.
//!
//! Теперь автор подписывает пост своим ключом личности, а читатель проверяет
//! подпись сам. Сервер по-прежнему решает, кого пускать писать, — но подделать
//! подпись он не может, а без неё пост считается неподтверждённым.
//!
//! # Что подписывается
//!
//! Канал, идентификатор поста, время и текст — всё вместе. Не только текст:
//! иначе подписанный пост можно было бы перенести в другой канал, выдать за
//! более свежий или показать как ответ на что-то другое.
//!
//! # Чего это не делает
//!
//! Не мешает серверу удалить пост или не показать его: молчание подписью не
//! ловится. Не прячет содержимое — оно и не должно прятаться. И не решает, кто
//! такой владелец: ключ канала читатель закрепляет при первой встрече, как и
//! ключ собеседника (см. `pins.rs`).

use sha2::{Digest, Sha256};

use crate::error::{CoreError, Result};
use crate::keys::{self, SecretKey};

/// Привязка подписи к назначению: тем же ключом подписанное что-то другое
/// постом не станет.
const DOMAIN: &[u8] = b"valanium-channel-post-v1";

/// То, что подписывает автор.
fn digest(channel: &str, post_id: &str, created_at: i64, body: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(DOMAIN);
    // Длины перед полями: без них «канал `a`, пост `bc`» и «канал `ab`, пост
    // `c`» дали бы один и тот же хеш, а значит одну и ту же подпись.
    for field in [channel.as_bytes(), post_id.as_bytes(), body.as_bytes()] {
        hasher.update((field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    hasher.update(created_at.to_be_bytes());
    hasher.finalize().into()
}

/// Подписывает пост ключом личности автора.
pub fn sign(
    identity: &SecretKey,
    channel: &str,
    post_id: &str,
    created_at: i64,
    body: &str,
) -> String {
    hex::encode(identity.sign(&digest(channel, post_id, created_at, body)))
}

/// Проверяет подпись поста ключом личности заявленного автора.
///
/// `false` — не подтверждено: подпись не сходится, автор не тот, поле
/// испорчено или его нет вовсе. Различать эти случаи наружу незачем: пост либо
/// подтверждён, либо нет.
pub fn verify(
    author_identity: &str,
    signature: &str,
    channel: &str,
    post_id: &str,
    created_at: i64,
    body: &str,
) -> bool {
    let (Ok(author), Ok(signature)) = (hex::decode(author_identity), hex::decode(signature)) else {
        return false;
    };
    keys::verify(&signature, &digest(channel, post_id, created_at, body), &author)
}

/// Разбирает поле автора в пару «личность, подпись», если оба на месте.
pub fn author_of(post: &serde_json::Value) -> Option<(String, String)> {
    let author = post.get("author")?.as_str()?.to_owned();
    let signature = post.get("signature")?.as_str()?.to_owned();
    if author.len() != 64 || signature.len() != 128 {
        return None;
    }
    Some((author, signature))
}

/// Ключ личности из hex. Нужен там, где владельца канала называет сервер.
pub fn identity_from_hex(raw: &str) -> Result<Vec<u8>> {
    let bytes = hex::decode(raw).map_err(|_| CoreError::BadFrame)?;
    if bytes.len() != 32 {
        return Err(CoreError::BadFrame);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn author() -> SecretKey {
        SecretKey::generate()
    }

    #[test]
    fn a_signed_post_verifies_for_its_author() {
        let key = author();
        let identity = hex::encode(key.public());
        let signature = sign(&key, "chan", "post-1", 1_700_000_000, "привет, канал");

        assert!(verify(&identity, &signature, "chan", "post-1", 1_700_000_000, "привет, канал"));
    }

    #[test]
    fn every_field_is_covered_by_the_signature() {
        let key = author();
        let identity = hex::encode(key.public());
        let signature = sign(&key, "chan", "post-1", 1_700_000_000, "текст");

        // Перенос в другой канал, подмена поста, времени или текста — всё это
        // обязано ломать подпись, иначе подписанным оказывается не то.
        assert!(!verify(&identity, &signature, "other", "post-1", 1_700_000_000, "текст"));
        assert!(!verify(&identity, &signature, "chan", "post-2", 1_700_000_000, "текст"));
        assert!(!verify(&identity, &signature, "chan", "post-1", 1_700_000_001, "текст"));
        assert!(!verify(&identity, &signature, "chan", "post-1", 1_700_000_000, "другой текст"));
    }

    #[test]
    fn a_field_boundary_cannot_be_shifted() {
        // Без длин перед полями «ab|c» и «a|bc» дали бы одинаковый хеш, и
        // подпись от одного поста подошла бы к другому.
        let key = author();
        let identity = hex::encode(key.public());
        let signature = sign(&key, "ab", "c", 1, "тело");
        assert!(!verify(&identity, &signature, "a", "bc", 1, "тело"));
    }

    #[test]
    fn another_identity_does_not_pass() {
        let key = author();
        let signature = sign(&key, "chan", "post-1", 1, "текст");
        let stranger = hex::encode(author().public());
        assert!(!verify(&stranger, &signature, "chan", "post-1", 1, "текст"));
    }

    #[test]
    fn garbage_is_refused_rather_than_trusted() {
        let key = author();
        let identity = hex::encode(key.public());
        assert!(!verify(&identity, "не подпись", "chan", "post-1", 1, "текст"));
        assert!(!verify("не ключ", &sign(&key, "chan", "post-1", 1, "текст"), "chan", "post-1", 1, "текст"));
        assert!(!verify(&identity, "", "chan", "post-1", 1, "текст"));
    }

    #[test]
    fn the_author_field_is_read_only_when_it_is_whole() {
        let full = serde_json::json!({ "author": "ab".repeat(32), "signature": "cd".repeat(64) });
        assert!(author_of(&full).is_some());

        // Половина пары бесполезна, как и обрезки: пост считается
        // неподтверждённым, а не «почти подтверждённым».
        assert!(author_of(&serde_json::json!({ "author": "ab".repeat(32) })).is_none());
        assert!(author_of(&serde_json::json!({ "signature": "cd".repeat(64) })).is_none());
        assert!(author_of(&serde_json::json!({ "author": "ab", "signature": "cd".repeat(64) })).is_none());
        assert!(author_of(&serde_json::json!({})).is_none());
    }
}
