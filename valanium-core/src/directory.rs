//! Юзернеймы и отношения с собеседниками.
//!
//! Юзернейм — **слой поиска, а не личность**. Личность — это ключ; юзернейм
//! только помогает вас найти, его можно сменить, отдать и потерять, и ни одно
//! криптографическое решение на него не опирается. Найденный по имени человек
//! всё равно подтверждает себя ключом, и код сверки проверяется как обычно.
//!
//! # Почему на сервер уезжает хеш
//!
//! Поиск точный — по полному имени, — поэтому серверу достаточно хеша. Утечка
//! его базы тогда не отдаёт готовый справочник «кто есть кто».
//!
//! Одного хеша для этого мало. Пространство юзернеймов маленькое и предсказуемое
//! («alice», «bob123», словарь плюс цифры), а SHA-256 считается за микросекунды:
//! утёкшую таблицу перебирают целиком за вечер на одной машине. Ограничитель
//! частоты на сервере от этого не спасает — перебор идёт по украденной копии, а
//! не через сервер.
//!
//! Поэтому хеш имени считается Argon2id (см. [`username_hash_v2`]): тот же
//! перебор дорожает в миллионы раз, а стоит это доли секунды на клиенте — по
//! разу на занятие имени и на поиск. Соль здесь постоянная и обязана такой
//! быть: серверу нужно находить строку по хешу, а случайная соль сделала бы
//! хеш неповторимым и поиск невозможным. Значит, радужную таблицу под наш
//! домен построить можно — но строить её придётся той же ценой Argon2id за
//! каждое имя.
//!
//! # Отношения
//!
//! [`Relation`] из `privacy.rs` берётся отсюда. Без этого списка правила вроде
//! «только контакты» не значили бы ничего: некому было бы сказать, кто контакт.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, Result};
use crate::privacy::Relation;

const USERNAME_DOMAIN: &str = "valanium-username-v1";
/// Соль дорогого хеша. Постоянная по необходимости — см. пояснение в шапке.
/// Argon2id требует не меньше восьми байт.
const USERNAME_SALT: &str = "valanium-username-v2";

const MIN_LEN: usize = 3;
const MAX_LEN: usize = 20;

/// Приводит юзернейм к каноническому виду.
///
/// Алфавит узкий намеренно: имя переписывают с чужого экрана и диктуют вслух, а
/// похожие юникодные буквы дали бы другой хеш и необъяснимое «не найдено».
pub fn normalize_username(raw: &str) -> Result<String> {
    let name = raw.trim().trim_start_matches('@').to_lowercase();

    if name.chars().count() < MIN_LEN || name.chars().count() > MAX_LEN {
        return Err(CoreError::BadRecoveryCode("юзернейм от 3 до 20 символов"));
    }
    if !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
        return Err(CoreError::BadRecoveryCode("в юзернейме только латиница, цифры и _"));
    }
    if name.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return Err(CoreError::BadRecoveryCode("юзернейм не может начинаться с цифры"));
    }
    Ok(name)
}

/// Прежний хеш имени: быстрый SHA-256.
///
/// Остаётся ради тех, кто ещё не обновился: их имена лежат на сервере под ним,
/// и поиск обязан их находить. Новые имена занимаются обеими формами сразу, а
/// при первом подключении обновлённый клиент дозанимает своё имя по-новому.
/// Когда клиентов со старым хешем не останется, эту функцию можно убрать.
pub fn username_hash(normalized: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(USERNAME_DOMAIN.as_bytes());
    hasher.update(normalized.as_bytes());
    hasher.finalize().into()
}

/// Дорогой хеш имени: Argon2id.
///
/// Параметры (32 МиБ, 2 прохода) выбраны по тому, сколько человек согласен
/// ждать: это доли секунды на занятие имени и на каждый поиск. Меньше памяти —
/// и перебор дешевеет; больше — и поиск начинает ощущаться.
///
/// Соль — постоянная строка домена. Это не оплошность, а условие задачи:
/// сервер ищет строку по хешу и обязан получать один и тот же хеш от всех.
pub fn username_hash_v2(normalized: &str) -> Result<[u8; 32]> {
    let params = argon2::Params::new(32 * 1024, 2, 1, Some(32))
        .map_err(|_| CoreError::Transport("argon2 params".into()))?;
    let argon = argon2::Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        params,
    );
    let mut out = [0u8; 32];
    argon
        .hash_password_into(normalized.as_bytes(), USERNAME_SALT.as_bytes(), &mut out)
        .map_err(|_| CoreError::Transport("argon2 failed".into()))?;
    Ok(out)
}

/// Кем нам приходится собеседник. Хранится локально и никуда не уходит.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Standing {
    /// Добавлен в контакты.
    Contact,
    /// Запрос принят, но в контакты не добавлен.
    Approved,
    /// Запрос пришёл и ещё не рассмотрен.
    Pending,
    /// Заблокирован.
    Blocked,
}

impl Standing {
    /// Перевод в язык правил приватности.
    ///
    /// Заблокированный и нерассмотренный одинаково «неизвестны»: правило про
    /// круг доступа к ним не применяется, потому что блокировка проверяется
    /// раньше и отдельно.
    pub fn relation(self) -> Relation {
        match self {
            Standing::Contact => Relation::Contact,
            Standing::Approved => Relation::Approved,
            Standing::Pending | Standing::Blocked => Relation::Unknown,
        }
    }
}

/// Запись о собеседнике.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub standing: Standing,
    /// Имя, которое человек показывает. Подсказка для интерфейса, не более:
    /// сменить его может кто угодно и когда угодно.
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    /// Как он на нас вышел: по юзернейму, по коду, по приглашению.
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub noted_at: i64,
}

/// Локальная книга отношений: ключ устройства в hex → запись.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Directory {
    pub entries: BTreeMap<String, Entry>,
}

impl Directory {
    pub fn standing(&self, device: &str) -> Option<Standing> {
        self.entries.get(device).map(|entry| entry.standing)
    }

    /// Отношение для правил приватности. Незнакомец — тот, о ком записи нет.
    pub fn relation(&self, device: &str) -> Relation {
        self.standing(device).map_or(Relation::Unknown, Standing::relation)
    }

    pub fn is_blocked(&self, device: &str) -> bool {
        self.standing(device) == Some(Standing::Blocked)
    }

    /// Меняет положение, сохраняя всё, что уже знали о человеке.
    ///
    /// Заметки не стираются при блокировке намеренно: разблокировав, человек
    /// должен увидеть, кто это был, а не безымянный ключ.
    pub fn set(&mut self, device: &str, standing: Standing, now: i64) {
        let entry = self.entries.entry(device.to_owned()).or_insert_with(|| Entry {
            standing,
            display_name: None,
            username: None,
            origin: None,
            noted_at: now,
        });
        entry.standing = standing;
    }

    pub fn note(&mut self, device: &str, username: Option<String>, origin: Option<String>, now: i64) {
        let entry = self.entries.entry(device.to_owned()).or_insert_with(|| Entry {
            standing: Standing::Pending,
            display_name: None,
            username: None,
            origin: None,
            noted_at: now,
        });
        if username.is_some() {
            entry.username = username;
        }
        if origin.is_some() {
            entry.origin = origin;
        }
    }

    pub fn forget(&mut self, device: &str) {
        self.entries.remove(device);
    }

    pub fn with_standing(&self, standing: Standing) -> Vec<(&String, &Entry)> {
        self.entries.iter().filter(|(_, entry)| entry.standing == standing).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_expensive_hash_is_stable_and_unlike_the_cheap_one() {
        let first = username_hash_v2("mira").unwrap();
        assert_eq!(first, username_hash_v2("mira").unwrap(), "хеш обязан повторяться");
        assert_ne!(first, username_hash_v2("mirb").unwrap());
        // Соседняя форма того же имени — другой хеш: нормализация делается до.
        assert_ne!(first, username_hash_v2("Mira").unwrap());
        // И это не тот же самый хеш, что раньше: иначе переезд был бы бессмысленным.
        assert_ne!(first, username_hash("mira"));
    }

    #[test]
    fn the_expensive_hash_costs_something() {
        // Смысл замены — в цене. Если Argon2id вдруг настроят «побыстрее»,
        // перебор словаря снова станет вечерним занятием, и заметить это
        // должен тест, а не тот, у кого утекла база.
        let started = std::time::Instant::now();
        username_hash_v2("mira").unwrap();
        let spent = started.elapsed();
        assert!(
            spent >= std::time::Duration::from_millis(10),
            "хеш имени посчитался за {spent:?} — это слишком дёшево",
        );
    }

    #[test]
    fn usernames_are_normalized_forgivingly() {
        for raw in ["Mira", "  @mira ", "@MIRA", "mira"] {
            assert_eq!(normalize_username(raw).unwrap(), "mira", "вариант: {raw}");
        }
    }

    #[test]
    fn bad_usernames_are_refused_with_a_reason() {
        for bad in ["ab", &"x".repeat(21), "с-кириллицей", "две слова", "1mira", "mira!"] {
            assert!(matches!(normalize_username(bad), Err(CoreError::BadRecoveryCode(_))), "принят: {bad}");
        }
    }

    /// Одинаковое имя обязано давать одинаковый хеш на любом устройстве —
    /// иначе поиск не сойдётся.
    #[test]
    fn the_hash_is_stable_and_case_insensitive() {
        let a = username_hash(&normalize_username("Mira").unwrap());
        let b = username_hash(&normalize_username("@mira").unwrap());
        assert_eq!(a, b);
        assert_ne!(a, username_hash(&normalize_username("mira_").unwrap()));
    }

    /// Хеш не должен быть просто именем в другом виде.
    #[test]
    fn the_hash_hides_the_name() {
        let hash = username_hash("mira");
        assert!(!hash.windows(4).any(|window| window == b"mira"));
    }

    #[test]
    fn an_unknown_device_is_a_stranger() {
        let directory = Directory::default();
        assert_eq!(directory.relation("aa"), Relation::Unknown);
        assert!(!directory.is_blocked("aa"));
    }

    #[test]
    fn standing_maps_to_the_privacy_language() {
        let mut directory = Directory::default();
        directory.set("aa", Standing::Contact, 1);
        directory.set("bb", Standing::Approved, 1);
        directory.set("cc", Standing::Pending, 1);
        directory.set("dd", Standing::Blocked, 1);

        assert_eq!(directory.relation("aa"), Relation::Contact);
        assert_eq!(directory.relation("bb"), Relation::Approved);
        assert_eq!(directory.relation("cc"), Relation::Unknown);
        assert_eq!(directory.relation("dd"), Relation::Unknown);
        assert!(directory.is_blocked("dd"));
    }

    /// Разблокировав человека, надо увидеть, кто это был, а не голый ключ.
    #[test]
    fn blocking_keeps_what_we_knew() {
        let mut directory = Directory::default();
        directory.note("aa", Some("mira".into()), Some("по юзернейму".into()), 10);
        directory.set("aa", Standing::Contact, 10);
        directory.set("aa", Standing::Blocked, 20);

        let entry = &directory.entries["aa"];
        assert_eq!(entry.standing, Standing::Blocked);
        assert_eq!(entry.username.as_deref(), Some("mira"));
        assert_eq!(entry.origin.as_deref(), Some("по юзернейму"));
    }

    #[test]
    fn pending_requests_are_listable() {
        let mut directory = Directory::default();
        directory.set("aa", Standing::Pending, 1);
        directory.set("bb", Standing::Contact, 1);
        directory.set("cc", Standing::Pending, 1);

        let pending = directory.with_standing(Standing::Pending);
        assert_eq!(pending.len(), 2);
        assert!(pending.iter().all(|(device, _)| *device != "bb"));
    }

    /// Книга переживает запись и чтение: она лежит в запечатанной базе строкой.
    #[test]
    fn directory_round_trips() {
        let mut directory = Directory::default();
        directory.note("aa", Some("mira".into()), None, 5);
        directory.set("aa", Standing::Approved, 5);

        let text = serde_json::to_string(&directory).unwrap();
        assert_eq!(serde_json::from_str::<Directory>(&text).unwrap(), directory);
    }

    /// Запись, сделанная прошлой версией, обязана подниматься.
    #[test]
    fn an_older_entry_loads() {
        let saved = r#"{"aa":{"standing":"contact"}}"#;
        let directory: Directory = serde_json::from_str(saved).unwrap();
        assert_eq!(directory.relation("aa"), Relation::Contact);
        assert!(directory.entries["aa"].username.is_none());
    }
}
