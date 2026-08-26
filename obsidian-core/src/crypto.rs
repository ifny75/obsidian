//! Запечатывание данных на диске.
//!
//! SQLCipher под MSVC требует сборки OpenSSL (nasm + windows-perl), а под
//! Android — отдельной возни с NDK. Вместо этого шифруется каждая запись:
//! XChaCha20-Poly1305, случайный nonce, AAD привязывает запись к её месту в
//! базе. На диске в открытом виде остаются только идентификаторы и время —
//! поверхность метаданных получается даже меньше, чем у SQLCipher, где
//! незашифрованным остаётся весь заголовок файла.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand_core::{OsRng, RngCore};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::{CoreError, Result};

pub const KEY_LEN: usize = 32;
pub const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;

/// Ключ базы. В памяти живёт только пока открыт стор.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct MasterKey([u8; KEY_LEN]);

impl MasterKey {
    /// Argon2id, 64 MiB / 3 прохода / 4 потока — параметры из ARCHITECTURE.md §5.
    pub fn derive(password: &[u8], salt: &[u8]) -> Result<Self> {
        let params = Params::new(64 * 1024, 3, 4, Some(KEY_LEN))
            .map_err(|_| CoreError::Transport("argon2 params".into()))?;
        let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut out = [0u8; KEY_LEN];
        argon
            .hash_password_into(password, salt, &mut out)
            .map_err(|_| CoreError::Transport("argon2 failed".into()))?;
        Ok(Self(out))
    }

    /// Ключ, выведенный где-то ещё. Нужен там, где Argon2id считается по
    /// другим параметрам, — например при восстановлении по паролю, где цена
    /// перебора важнее скорости открытия базы.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let mut key = [0u8; KEY_LEN];
        if bytes.len() != KEY_LEN {
            return Err(CoreError::BadKeyLength);
        }
        key.copy_from_slice(bytes);
        Ok(Self(key))
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new((&self.0).into())
    }

    /// `nonce(24) || ciphertext+tag`. AAD не хранится: её восстанавливает
    /// вызывающий из контекста, и подмена контекста ломает расшифровку.
    pub fn seal(&self, aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);
        let sealed = self
            .cipher()
            .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad })
            .map_err(|_| CoreError::StoreLocked)?;

        let mut out = Vec::with_capacity(NONCE_LEN + sealed.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&sealed);
        Ok(out)
    }

    pub fn open(&self, aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
        if sealed.len() <= NONCE_LEN {
            return Err(CoreError::StoreLocked);
        }
        let (nonce, body) = sealed.split_at(NONCE_LEN);
        self.cipher()
            .decrypt(XNonce::from_slice(nonce), Payload { msg: body, aad })
            .map_err(|_| CoreError::StoreLocked)
    }
}

pub fn random_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    salt
}

pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut out = vec![0u8; len];
    OsRng.fill_bytes(&mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> MasterKey {
        MasterKey::derive(b"correct horse", &[9u8; SALT_LEN]).unwrap()
    }

    #[test]
    fn seal_open_round_trip() {
        let key = key();
        let sealed = key.seal(b"ctx", b"hello").unwrap();
        assert_eq!(key.open(b"ctx", &sealed).unwrap(), b"hello");
    }

    #[test]
    fn ciphertext_does_not_contain_plaintext() {
        let sealed = key().seal(b"ctx", b"topsecret").unwrap();
        assert!(!sealed.windows(9).any(|w| w == b"topsecret"));
    }

    #[test]
    fn same_plaintext_seals_differently() {
        let key = key();
        assert_ne!(key.seal(b"ctx", b"same").unwrap(), key.seal(b"ctx", b"same").unwrap());
    }

    #[test]
    fn wrong_aad_fails() {
        let key = key();
        let sealed = key.seal(b"row-1", b"hello").unwrap();
        // Перенос записи в другое место базы обязан ломать расшифровку.
        assert!(key.open(b"row-2", &sealed).is_err());
    }

    #[test]
    fn wrong_password_fails() {
        let sealed = key().seal(b"ctx", b"hello").unwrap();
        let other = MasterKey::derive(b"wrong", &[9u8; SALT_LEN]).unwrap();
        assert!(other.open(b"ctx", &sealed).is_err());
    }

    #[test]
    fn tampering_is_detected() {
        let key = key();
        let mut sealed = key.seal(b"ctx", b"hello").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert!(key.open(b"ctx", &sealed).is_err());
    }

    #[test]
    fn truncated_input_is_rejected() {
        assert!(key().open(b"ctx", &[0u8; 8]).is_err());
        assert!(key().open(b"ctx", &[]).is_err());
    }

    #[test]
    fn salt_changes_the_key() {
        let a = MasterKey::derive(b"pw", &[1u8; SALT_LEN]).unwrap();
        let b = MasterKey::derive(b"pw", &[2u8; SALT_LEN]).unwrap();
        let sealed = a.seal(b"ctx", b"x").unwrap();
        assert!(b.open(b"ctx", &sealed).is_err());
    }
}
