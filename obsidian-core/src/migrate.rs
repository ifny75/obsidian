//! Перенос аккаунта на другое устройство.
//!
//! Смысл файла переноса — не «резервная копия», а именно переезд: внутри
//! лежат приватные ключи личности и устройства, состояние MLS и вся история.
//! Кто получил файл и пароль к нему — получил переписку целиком.
//!
//! Поэтому файл запечатан отдельным паролем, который человек придумывает сам,
//! а не ключом базы: ключ базы выведен из секрета старой машины и на новой
//! бесполезен. Argon2id здесь тот же, что у хранилища (ARCHITECTURE.md §5) —
//! перебор пароля к файлу стоит столько же, сколько перебор пароля к базе.
//!
//! **Старое устройство после переезда должно замолчать.** Ключ устройства
//! становится общим для двух копий, а состояние MLS у каждой своё; если
//! писать с обеих, эпохи разъедутся и часть сообщений перестанет
//! расшифровываться. Это не ограничение реализации, а свойство MLS: лист в
//! дереве принадлежит устройству, а не человеку.

use serde::{Deserialize, Serialize};

use crate::crypto::{MasterKey, SALT_LEN};
use crate::error::{CoreError, Result};

/// Метка формата в начале файла: по ней видно, что подсунули не тот файл,
/// ещё до того, как пароль будет признан неверным.
const MAGIC: &[u8] = b"OBSIDIAN-ACCOUNT-1\n";

/// AAD архива. Привязывает шифротекст к назначению: тот же пароль не откроет
/// им что-то другое, запечатанное этим же ключом.
const AAD: &[u8] = b"obsidian-account-v1";

#[derive(Serialize, Deserialize)]
pub struct ArchiveMls {
    pub signer_public: String,
    pub snapshot: String,
}

#[derive(Serialize, Deserialize)]
pub struct ArchiveGroup {
    pub group_id: String,
    pub kind: String,
    pub meta: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize)]
pub struct ArchiveMessage {
    pub id: String,
    pub conversation: String,
    pub outgoing: bool,
    pub created_at: i64,
    pub body: String,
}

/// Содержимое аккаунта в открытом виде. Живёт только в памяти и только между
/// `Store::export_archive` и запечатыванием.
#[derive(Serialize, Deserialize)]
pub struct Archive {
    pub v: u32,
    pub identity: String,
    pub device: String,
    pub mls: Option<ArchiveMls>,
    pub conversations: Vec<(String, String)>,
    pub groups: Vec<ArchiveGroup>,
    pub messages: Vec<ArchiveMessage>,
    pub settings: Vec<(String, String)>,
}

/// `MAGIC || salt(16) || nonce+ciphertext`.
///
/// Соль своя на каждый файл: два экспорта под одним паролем не должны давать
/// один и тот же ключ.
pub fn seal(password: &str, archive: &Archive) -> Result<Vec<u8>> {
    if password.chars().count() < 8 {
        return Err(CoreError::Transport("пароль файла короче восьми знаков".into()));
    }
    let salt = crate::crypto::random_salt();
    let key = MasterKey::derive(password.as_bytes(), &salt)?;
    let plain = serde_json::to_vec(archive).map_err(|_| CoreError::BadFrame)?;
    let sealed = key.seal(AAD, &plain)?;

    let mut out = Vec::with_capacity(MAGIC.len() + SALT_LEN + sealed.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&sealed);
    Ok(out)
}

pub fn open(password: &str, file: &[u8]) -> Result<Archive> {
    if file.len() <= MAGIC.len() + SALT_LEN || !file.starts_with(MAGIC) {
        return Err(CoreError::Transport("это не файл переноса Obsidian".into()));
    }
    let salt = &file[MAGIC.len()..MAGIC.len() + SALT_LEN];
    let key = MasterKey::derive(password.as_bytes(), salt)?;
    let plain = key
        .open(AAD, &file[MAGIC.len() + SALT_LEN..])
        .map_err(|_| CoreError::Transport("неверный пароль файла".into()))?;
    let archive: Archive = serde_json::from_slice(&plain).map_err(|_| CoreError::BadFrame)?;
    if archive.v != 1 {
        return Err(CoreError::Transport("файл переноса новее этой версии".into()));
    }
    Ok(archive)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Archive {
        Archive {
            v: 1,
            identity: "aa".repeat(32),
            device: "bb".repeat(32),
            mls: None,
            conversations: vec![("cc".repeat(32), "dd".repeat(16))],
            groups: Vec::new(),
            messages: Vec::new(),
            settings: vec![("privacy".into(), "7b7d".into())],
        }
    }

    #[test]
    fn round_trip() {
        let file = seal("длинный пароль", &sample()).unwrap();
        let back = open("длинный пароль", &file).unwrap();
        assert_eq!(back.identity, sample().identity);
        assert_eq!(back.settings.len(), 1);
    }

    #[test]
    fn wrong_password_is_refused() {
        let file = seal("длинный пароль", &sample()).unwrap();
        assert!(open("другой пароль", &file).is_err());
    }

    #[test]
    fn short_password_is_refused() {
        assert!(seal("корот", &sample()).is_err());
    }

    #[test]
    fn foreign_file_is_refused() {
        assert!(open("длинный пароль", b"just some bytes here, not ours").is_err());
    }
}
