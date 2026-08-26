//! Восстановление личности по логину и паролю.
//!
//! Отличие от [`crate::recovery`] в том, где лежит секрет. Код восстановления —
//! это сам ключ, и человек обязан его хранить. Здесь ключ хранит сервер, но в
//! запечатанном виде: открыть посылку умеет только пароль, а он с устройства не
//! уходит.
//!
//! # Что видит сервер
//!
//! Строку `(login_id, verifier, sealed)`. `login_id` — хеш логина, `verifier` —
//! хеш доказательства, `sealed` — шифротекст identity-ключа. Ни логина, ни
//! пароля, ни ключа в открытом виде на сервере нет.
//!
//! # Зачем доказательство отдельно от ключа
//!
//! Argon2id выдаёт 64 байта, которые режутся пополам: `token` уходит на сервер,
//! `seal` не уходит никогда. Сервер сравнивает `SHA256(token)` со своим
//! `verifier` и только тогда отдаёт посылку.
//!
//! Без этого шага логин (а он угадывается — люди берут своё имя) позволял бы
//! кому угодно скачать посылку и перебирать пароль офлайн, на своём железе.
//! С ним каждая попытка стоит одного прогона Argon2id **и** одного запроса к
//! серверу, где стоит ограничитель частоты.
//!
//! # Честно о слабом месте
//!
//! Если база сервера утечёт, офлайн-перебор снова возможен: у атакующего будут
//! и `verifier`, и `sealed`. Цена перебора — 128 МиБ и три прохода Argon2id на
//! попытку, то есть словарь из простых паролей вскроется. **Стойкость этого
//! способа равна стойкости пароля**, и слабый пароль здесь опаснее, чем в
//! обычном мессенджере: он открывает не переписку, а личность целиком.
//! Поэтому короткие пароли не принимаются, а в интерфейсе способ подписан как
//! менее надёжный, чем код восстановления.

use argon2::{Algorithm, Argon2, Params, Version};
use sha2::{Digest, Sha256};

use crate::crypto::MasterKey;
use crate::error::{CoreError, Result};
use crate::keys::SecretKey;

/// Argon2id: 128 МиБ, 3 прохода. Вдвое тяжелее, чем у локальной базы, — там
/// параметры подобраны под открытие при каждом запуске, а здесь пересчёт
/// случается дважды за всю жизнь аккаунта, и цена перебора важнее скорости.
const MEMORY_KIB: u32 = 128 * 1024;
const PASSES: u32 = 3;
const LANES: u32 = 4;

const DERIVED_LEN: usize = 64;
pub const TOKEN_LEN: usize = 32;
pub const ID_LEN: usize = 32;

const SALT_DOMAIN: &str = "obsidian-recovery-salt-v1";
const LOGIN_DOMAIN: &str = "obsidian-recovery-login-v1";
const VERIFIER_DOMAIN: &str = "obsidian-recovery-verifier-v1";

/// Минимум для пароля. Не «сложность» с обязательной цифрой и заглавной —
/// такие правила гонят людей к `Password1!`, который перебирается первым.
/// Длина — единственное требование, которое действительно помогает.
pub const MIN_PASSWORD_LEN: usize = 10;

const MIN_LOGIN_LEN: usize = 3;
const MAX_LOGIN_LEN: usize = 32;

/// Всё, что нужно, чтобы положить посылку на сервер.
pub struct Sealed {
    /// Хеш логина. По нему сервер находит строку.
    pub login_id: [u8; ID_LEN],
    /// Доказательство знания пароля, которое сервер сравнивает со своим хешем.
    pub token: [u8; TOKEN_LEN],
    /// Запечатанный identity-ключ.
    pub sealed: Vec<u8>,
}

/// Приводит логин к каноническому виду.
///
/// Регистр и пробелы по краям не должны решать, откроется аккаунт или нет:
/// человек вводит логин через полгода и по памяти.
pub fn normalize_login(login: &str) -> Result<String> {
    let normalized: String = login.trim().to_lowercase();

    if normalized.chars().count() < MIN_LOGIN_LEN || normalized.chars().count() > MAX_LOGIN_LEN {
        return Err(CoreError::BadRecoveryCode("логин от 3 до 32 символов"));
    }
    // Алфавит узкий намеренно: логин переписывают руками, а похожие юникодные
    // буквы («а» кириллическая вместо латинской) дали бы другой хеш и
    // необъяснимое «не найдено».
    if !normalized.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) {
        return Err(CoreError::BadRecoveryCode("в логине только латиница, цифры и . _ -"));
    }
    Ok(normalized)
}

fn check_password(password: &str) -> Result<()> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(CoreError::BadRecoveryCode("пароль короче 10 символов"));
    }
    Ok(())
}

fn digest(domain: &str, input: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    hasher.update(input);
    hasher.finalize().into()
}

/// Хеш логина, по которому сервер ищет строку.
pub fn login_id(login_normalized: &str) -> [u8; ID_LEN] {
    digest(LOGIN_DOMAIN, login_normalized.as_bytes())
}

/// То, что сервер хранит вместо доказательства. Считается и на клиенте (для
/// тестов), и на сервере (при проверке).
pub fn verifier(token: &[u8]) -> [u8; 32] {
    digest(VERIFIER_DOMAIN, token)
}

/// Argon2id над паролем. Соль детерминированная — она выведена из логина,
/// потому что при восстановлении на чистом устройстве взять случайную соль
/// неоткуда, а спрашивать её у сервера до проверки пароля значило бы отдавать
/// её кому угодно.
fn derive(login_normalized: &str, password: &str) -> Result<[u8; DERIVED_LEN]> {
    let salt = digest(SALT_DOMAIN, login_normalized.as_bytes());

    let params = Params::new(MEMORY_KIB, PASSES, LANES, Some(DERIVED_LEN))
        .map_err(|_| CoreError::Transport("argon2 params".into()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut out = [0u8; DERIVED_LEN];
    argon
        .hash_password_into(password.as_bytes(), &salt, &mut out)
        .map_err(|_| CoreError::Transport("argon2 failed".into()))?;
    Ok(out)
}

/// AAD привязывает посылку к логину: подменить строку в базе, подставив чужой
/// шифротекст под свой `login_id`, не выйдет — расшифровка не сойдётся.
fn aad(login_id: &[u8; ID_LEN]) -> Vec<u8> {
    let mut out = Vec::with_capacity(VERIFIER_DOMAIN.len() + ID_LEN);
    out.extend_from_slice(LOGIN_DOMAIN.as_bytes());
    out.extend_from_slice(login_id);
    out
}

/// Готовит посылку для отправки на сервер.
pub fn seal(login: &str, password: &str, identity: &SecretKey) -> Result<Sealed> {
    let login = normalize_login(login)?;
    check_password(password)?;

    let derived = derive(&login, password)?;
    let (token_part, seal_part) = derived.split_at(TOKEN_LEN);

    let id = login_id(&login);
    let key = MasterKey::from_bytes(seal_part)?;
    let sealed = key.seal(&aad(&id), &identity.to_bytes())?;

    let mut token = [0u8; TOKEN_LEN];
    token.copy_from_slice(token_part);
    Ok(Sealed { login_id: id, token, sealed })
}

/// Что отправить серверу, чтобы он выдал посылку. Ключа расшифровки здесь нет:
/// он остаётся у вызывающего до ответа.
pub fn request(login: &str, password: &str) -> Result<([u8; ID_LEN], [u8; TOKEN_LEN], MasterKey)> {
    let login = normalize_login(login)?;
    // Длина пароля при восстановлении не проверяется: если аккаунт заведён
    // старым правилом, отказ на входе запер бы человека снаружи. Проверка
    // нужна на установке — там она ещё что-то меняет.
    let derived = derive(&login, password)?;
    let (token_part, seal_part) = derived.split_at(TOKEN_LEN);

    let mut token = [0u8; TOKEN_LEN];
    token.copy_from_slice(token_part);
    Ok((login_id(&login), token, MasterKey::from_bytes(seal_part)?))
}

/// Распечатывает посылку, полученную от сервера.
pub fn open(key: &MasterKey, login_id: &[u8; ID_LEN], sealed: &[u8]) -> Result<SecretKey> {
    let plaintext = key
        .open(&aad(login_id), sealed)
        .map_err(|_| CoreError::BadRecoveryCode("логин или пароль не подошли"))?;
    SecretKey::from_bytes(&plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_restores_the_same_identity() {
        let identity = SecretKey::generate();
        let box_ = seal("Alice", "правильный-пароль", &identity).unwrap();

        let (id, token, key) = request("alice", "правильный-пароль").unwrap();
        assert_eq!(id, box_.login_id, "логин обязан сойтись после нормализации");
        assert_eq!(token, box_.token, "доказательство обязано сойтись");

        let restored = open(&key, &id, &box_.sealed).unwrap();
        assert_eq!(restored.to_bytes(), identity.to_bytes());
    }

    /// Логин вводят по памяти — регистр и лишние пробелы не должны решать.
    #[test]
    fn login_normalization_is_forgiving() {
        let identity = SecretKey::generate();
        let box_ = seal("Bob.Smith", "достаточно-длинный", &identity).unwrap();

        for variant in ["bob.smith", "  BOB.SMITH  ", "Bob.Smith"] {
            let (id, token, key) = request(variant, "достаточно-длинный").unwrap();
            assert_eq!(token, box_.token, "вариант: {variant}");
            assert_eq!(open(&key, &id, &box_.sealed).unwrap().to_bytes(), identity.to_bytes());
        }
    }

    /// Главное свойство: без пароля посылка бесполезна, даже если она в руках.
    #[test]
    fn a_wrong_password_neither_proves_nor_opens() {
        let identity = SecretKey::generate();
        let box_ = seal("carol", "настоящий-пароль", &identity).unwrap();

        let (id, token, key) = request("carol", "неверный-пароль").unwrap();
        assert_eq!(id, box_.login_id, "логин тот же — строка находится");
        assert_ne!(token, box_.token, "сервер обязан отказать до выдачи посылки");
        // А если бы и выдал — открыть нечем.
        assert!(open(&key, &id, &box_.sealed).is_err());
    }

    /// Посылку нельзя переставить под другой логин: AAD её держит.
    #[test]
    fn a_sealed_box_is_bound_to_its_login() {
        let identity = SecretKey::generate();
        let box_ = seal("dave", "пароль-подлиннее", &identity).unwrap();

        let (other_id, _, _) = request("erin", "пароль-подлиннее").unwrap();
        let (_, _, key) = request("dave", "пароль-подлиннее").unwrap();
        assert!(open(&key, &other_id, &box_.sealed).is_err());
    }

    #[test]
    fn short_passwords_are_refused_at_setup() {
        let identity = SecretKey::generate();
        assert!(matches!(
            seal("frank", "korotkiy", &identity),
            Err(CoreError::BadRecoveryCode(_))
        ));
    }

    /// А при восстановлении длина уже не проверяется: аккаунт мог быть заведён
    /// по старому правилу, и отказ на входе запер бы человека снаружи.
    #[test]
    fn short_passwords_are_still_accepted_when_restoring() {
        assert!(request("frank", "korotkiy").is_ok());
    }

    #[test]
    fn logins_are_checked_before_any_expensive_work() {
        for bad in ["ab", "с-кириллицей", "пробел внутри", &"x".repeat(33)] {
            assert!(matches!(normalize_login(bad), Err(CoreError::BadRecoveryCode(_))), "принят: {bad}");
        }
    }

    #[test]
    fn different_logins_give_different_rows() {
        assert_ne!(login_id("alice"), login_id("bob"));
    }

    /// Сервер хранит хеш доказательства, а не само доказательство: утечка базы
    /// не должна сразу давать ключ от посылки.
    #[test]
    fn the_verifier_is_not_the_token() {
        let (_, token, _) = request("gina", "пароль-подлиннее").unwrap();
        assert_ne!(verifier(&token)[..], token[..]);
    }
}
