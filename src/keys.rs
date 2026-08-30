//! Ключи личности и устройства.
//!
//! Доменные префиксы обязаны совпадать с сервером байт в байт — иначе подписи
//! не сойдутся. Проверяется тестом `cross_language` против obsidian-server.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use zeroize::ZeroizeOnDrop;

use crate::error::{CoreError, Result};

pub const KEY_LEN: usize = 32;
pub const SIG_LEN: usize = 64;

/// `sign(identity_priv, "obsidian-device-v1" || identity_pub || device_pub)`
const DOMAIN_DEVICE: &[u8] = b"obsidian-device-v1";
/// `sign(device_priv, "obsidian-auth-v1" || nonce || identity_pub || device_pub)`
const DOMAIN_AUTH: &[u8] = b"obsidian-auth-v1";

/// Приватный ключ. Зануляется при уничтожении и никогда не сериализуется.
#[derive(ZeroizeOnDrop)]
pub struct SecretKey {
    #[zeroize(skip)]
    inner: SigningKey,
}

impl SecretKey {
    pub fn generate() -> Self {
        Self { inner: SigningKey::generate(&mut OsRng) }
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let array: [u8; KEY_LEN] = bytes.try_into().map_err(|_| CoreError::BadKeyLength)?;
        Ok(Self { inner: SigningKey::from_bytes(&array) })
    }

    pub fn to_bytes(&self) -> [u8; KEY_LEN] {
        self.inner.to_bytes()
    }

    pub fn public(&self) -> [u8; KEY_LEN] {
        self.inner.verifying_key().to_bytes()
    }

    pub fn sign(&self, message: &[u8]) -> [u8; SIG_LEN] {
        self.inner.sign(message).to_bytes()
    }
}

/// Сообщение, которое identity-ключ подписывает, разрешая работу устройству.
pub fn device_cert_message(identity_pub: &[u8], device_pub: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(DOMAIN_DEVICE.len() + KEY_LEN * 2);
    out.extend_from_slice(DOMAIN_DEVICE);
    out.extend_from_slice(identity_pub);
    out.extend_from_slice(device_pub);
    out
}

/// Сообщение, которым устройство отвечает на challenge сервера.
pub fn auth_message(nonce: &[u8], identity_pub: &[u8], device_pub: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(DOMAIN_AUTH.len() + nonce.len() + KEY_LEN * 2);
    out.extend_from_slice(DOMAIN_AUTH);
    out.extend_from_slice(nonce);
    out.extend_from_slice(identity_pub);
    out.extend_from_slice(device_pub);
    out
}

/// Строго по RFC 8032: verify_strict отвергает точки малого порядка.
///
/// Нестрогий verify следует правилам ZIP-215 и принимает, например, ключ из
/// одних нулей с подписью из одних нулей — такую личность подделает кто
/// угодно. Сервер настроен так же (zip215: false в noble).
pub fn verify(signature: &[u8], message: &[u8], public: &[u8]) -> bool {
    let (Ok(pub_bytes), Ok(sig_bytes)): (std::result::Result<[u8; KEY_LEN], _>, std::result::Result<[u8; SIG_LEN], _>) =
        (public.try_into(), signature.try_into())
    else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&pub_bytes) else {
        return false;
    };
    key.verify_strict(message, &Signature::from_bytes(&sig_bytes)).is_ok()
}

/// Пара «личность + устройство»: всё, что нужно, чтобы представиться серверу.
pub struct Credentials {
    pub identity: SecretKey,
    pub device: SecretKey,
}

impl Credentials {
    pub fn generate() -> Self {
        Self { identity: SecretKey::generate(), device: SecretKey::generate() }
    }

    pub fn identity_pub(&self) -> [u8; KEY_LEN] {
        self.identity.public()
    }

    pub fn device_pub(&self) -> [u8; KEY_LEN] {
        self.device.public()
    }

    /// Сертификат устройства. Сервер его только кэширует — доверять ему
    /// обязан клиент-отправитель, проверяя подпись сам.
    pub fn device_cert(&self) -> [u8; SIG_LEN] {
        self.identity.sign(&device_cert_message(&self.identity_pub(), &self.device_pub()))
    }

    pub fn auth_signature(&self, nonce: &[u8]) -> [u8; SIG_LEN] {
        self.device.sign(&auth_message(nonce, &self.identity_pub(), &self.device_pub()))
    }
}

/// Код для сверки пары устройств вслух или по другому каналу.
///
/// Считается от обоих ключей сразу, поэтому у собеседников он совпадает: порядок
/// нормализуется сортировкой, иначе Алиса и Боб видели бы разные числа. Если
/// коды разошлись — между вами кто-то третий.
pub fn safety_number(a: &[u8], b: &[u8]) -> String {
    let (first, second) = if a <= b { (a, b) } else { (b, a) };

    let mut hasher = Sha256::new();
    hasher.update(b"obsidian-safety-v1");
    hasher.update(first);
    hasher.update(second);
    let digest = hasher.finalize();

    digest
        .iter()
        .take(15)
        .map(|byte| format!("{byte:03}"))
        .collect::<Vec<_>>()
        .chunks(3)
        .map(|group| group.concat())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Отпечаток для ручной сверки контактов. Без неё сервер способен на MITM.
pub fn fingerprint(identity_pub: &[u8]) -> String {
    let digest = Sha256::digest(identity_pub);
    digest
        .iter()
        .take(10)
        .map(|byte| format!("{byte:03}"))
        .collect::<Vec<_>>()
        .chunks(2)
        .map(|pair| pair.concat())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_cert_verifies_under_identity_key() {
        let creds = Credentials::generate();
        let cert = creds.device_cert();
        let message = device_cert_message(&creds.identity_pub(), &creds.device_pub());
        assert!(verify(&cert, &message, &creds.identity_pub()));
    }

    #[test]
    fn device_cert_does_not_verify_under_device_key() {
        let creds = Credentials::generate();
        let message = device_cert_message(&creds.identity_pub(), &creds.device_pub());
        assert!(!verify(&creds.device_cert(), &message, &creds.device_pub()));
    }

    #[test]
    fn auth_signature_is_bound_to_nonce() {
        let creds = Credentials::generate();
        let nonce = [7u8; 32];
        let sig = creds.auth_signature(&nonce);

        assert!(verify(&sig, &auth_message(&nonce, &creds.identity_pub(), &creds.device_pub()), &creds.device_pub()));

        let other = [8u8; 32];
        assert!(!verify(&sig, &auth_message(&other, &creds.identity_pub(), &creds.device_pub()), &creds.device_pub()));
    }

    #[test]
    fn cert_of_one_identity_is_rejected_for_another() {
        let alice = Credentials::generate();
        let mallory = Credentials::generate();
        let message = device_cert_message(&mallory.identity_pub(), &alice.device_pub());
        assert!(!verify(&alice.device_cert(), &message, &mallory.identity_pub()));
    }

    #[test]
    fn secret_key_round_trips() {
        let key = SecretKey::generate();
        let restored = SecretKey::from_bytes(&key.to_bytes()).unwrap();
        assert_eq!(key.public(), restored.public());
    }

    #[test]
    fn short_key_is_rejected() {
        assert!(SecretKey::from_bytes(&[0u8; 16]).is_err());
    }

    #[test]
    fn garbage_signature_does_not_panic() {
        assert!(!verify(&[0u8; 64], b"x", &[0u8; 32]));
        assert!(!verify(&[], b"x", &[0u8; 32]));
        assert!(!verify(&[0u8; 64], b"x", &[]));
    }


    /// Ключи малого порядка обязаны отвергаться: их подпись подделает кто
    /// угодно, а значит такую личность можно захватить вместе с оплаченным
    /// счётом. Список тот же, что в тесте сервера, — стороны обязаны вести
    /// себя одинаково.
    #[test]
    fn low_order_keys_are_rejected() {
        const LOW_ORDER: [&str; 9] = [
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0100000000000000000000000000000000000000000000000000000000000000",
            "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
            "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
            "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
            "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
            "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
            "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
            "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        ];
        for encoded in LOW_ORDER {
            let key = hex::decode(encoded).unwrap();
            let mut signature = [0u8; SIG_LEN];
            signature[..KEY_LEN].copy_from_slice(&key);
            assert!(!verify(&[0u8; SIG_LEN], b"anything", &key), "accepted {encoded}");
            assert!(!verify(&signature, b"anything", &key), "accepted {encoded}");
        }
    }

    #[test]
    fn safety_number_is_the_same_on_both_sides() {
        let alice = SecretKey::generate().public();
        let bob = SecretKey::generate().public();

        // Порядок аргументов не должен влиять — иначе сверка вслух развалится.
        assert_eq!(safety_number(&alice, &bob), safety_number(&bob, &alice));
    }

    #[test]
    fn safety_number_differs_for_different_pairs() {
        let alice = SecretKey::generate().public();
        let bob = SecretKey::generate().public();
        let mallory = SecretKey::generate().public();

        assert_ne!(safety_number(&alice, &bob), safety_number(&alice, &mallory));
    }

    #[test]
    fn safety_number_is_grouped_for_reading_aloud() {
        let code = safety_number(&[1u8; 32], &[2u8; 32]);
        assert_eq!(code.split(' ').count(), 5);
        assert!(code.split(' ').all(|group| group.len() == 9));
    }

    #[test]
    fn fingerprint_is_stable_and_grouped() {
        let fp = fingerprint(&[0u8; 32]);
        assert_eq!(fp, fingerprint(&[0u8; 32]));
        assert_eq!(fp.split(' ').count(), 5);
    }
}
