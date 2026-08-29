//! Закрепление ключей: кого мы видели под этим именем в прошлый раз.
//!
//! # Зачем
//!
//! Юзернейм разрешает в ключ устройства **сервер**. Пока переписка не начата,
//! ничто не мешает ему ответить не тем ключом: MLS честно зашифрует письмо —
//! только не тому. Код сверки (`safety_number`) эту подмену показывает, но лишь
//! тому, кто действительно сверил его вслух, а так делает меньшинство.
//!
//! Закрепление — то, что работает без участия человека. При первом успешном
//! поиске имя и выданный ключ запоминаются. Со второго раза ответ сервера
//! сверяется с запомненным, и **смена ключа перестаёт быть незаметной**.
//!
//! # Чего это не даёт
//!
//! Первый контакт остаётся уязвимым: закреплять на нём ещё нечего. Здесь
//! помогает только сверка кода или прозрачный журнал ключей — и то, и другое
//! стоит несопоставимо дороже. Закрепление закрывает не всё, но закрывает
//! главное: подмену у пары, которая уже переписывается, и повторную выдачу
//! чужого ключа тому, кто ищет знакомого по имени.
//!
//! # Почему смена ключа — не ошибка
//!
//! Человек переставил систему, потерял телефон, завёл второе устройство — ключ
//! сменится законно, и это обычное дело. Поэтому смена не запрещает переписку,
//! а требует решения: подтвердить новый ключ или отказаться. Молча принимать
//! нельзя (тогда закрепление бессмысленно), молча запрещать — тоже (тогда
//! мессенджер ломается на ровном месте).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Что показал поиск по сравнению с тем, что мы помним.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PinState {
    /// Это имя встречается впервые — сравнивать не с чем.
    First,
    /// Ключ тот же, что и был.
    Same,
    /// Ключ другой. Требует решения человека.
    Changed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pin {
    /// Ключ устройства в hex — ровно то, что отдал сервер.
    pub device: String,
    /// Когда закрепили в первый раз.
    pub first_seen: i64,
    /// Когда в последний раз подтверждали смену.
    #[serde(default)]
    pub changed_at: Option<i64>,
}

/// Имя → закреплённый за ним ключ.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Pins {
    #[serde(default)]
    pub names: BTreeMap<String, Pin>,
}

impl Pins {
    /// Сверяет ответ сервера с тем, что помним, и запоминает первый.
    ///
    /// Первый ключ закрепляется молча: спрашивать человека там, где сравнивать
    /// не с чем, — значит приучать его нажимать «да», не читая.
    pub fn check(&mut self, name: &str, device: &str, now: i64) -> PinState {
        match self.names.get(name) {
            None => {
                self.names.insert(
                    name.to_owned(),
                    Pin { device: device.to_owned(), first_seen: now, changed_at: None },
                );
                PinState::First
            }
            Some(pin) if pin.device == device => PinState::Same,
            Some(_) => PinState::Changed,
        }
    }

    /// Человек подтвердил новый ключ. Возвращает false, если подтверждать нечего.
    pub fn accept(&mut self, name: &str, device: &str, now: i64) -> bool {
        match self.names.get_mut(name) {
            Some(pin) if pin.device != device => {
                pin.device = device.to_owned();
                pin.changed_at = Some(now);
                true
            }
            _ => false,
        }
    }

    /// Забыть имя целиком. Нужно, когда человека убирают из книги: держать
    /// закрепление того, с кем не переписываются, незачем.
    pub fn forget(&mut self, name: &str) -> bool {
        self.names.remove(name).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_key_is_pinned_silently() {
        let mut pins = Pins::default();
        assert_eq!(pins.check("mira", "aa", 1), PinState::First);
        // Со второго раза сравнивать уже есть с чем.
        assert_eq!(pins.check("mira", "aa", 2), PinState::Same);
        assert_eq!(pins.names["mira"].first_seen, 1, "время первой встречи не переписывается");
    }

    #[test]
    fn a_different_key_under_the_same_name_is_noticed() {
        let mut pins = Pins::default();
        pins.check("mira", "aa", 1);
        assert_eq!(pins.check("mira", "bb", 2), PinState::Changed);
        // И остаётся замеченной: без решения человека закрепление не меняется.
        assert_eq!(pins.check("mira", "bb", 3), PinState::Changed);
        assert_eq!(pins.names["mira"].device, "aa");
    }

    #[test]
    fn accepting_the_change_replaces_the_pin() {
        let mut pins = Pins::default();
        pins.check("mira", "aa", 1);
        assert!(pins.accept("mira", "bb", 5));
        assert_eq!(pins.check("mira", "bb", 6), PinState::Same);
        assert_eq!(pins.names["mira"].changed_at, Some(5));
        // Первая встреча остаётся первой: она говорит, как давно мы знакомы.
        assert_eq!(pins.names["mira"].first_seen, 1);
    }

    #[test]
    fn there_is_nothing_to_accept_when_the_key_did_not_change() {
        let mut pins = Pins::default();
        pins.check("mira", "aa", 1);
        assert!(!pins.accept("mira", "aa", 5), "подтверждать нечего");
        assert!(!pins.accept("незнакомец", "aa", 5), "неизвестное имя не подтверждают");
    }

    #[test]
    fn names_are_independent_of_each_other() {
        let mut pins = Pins::default();
        pins.check("mira", "aa", 1);
        assert_eq!(pins.check("lev", "bb", 2), PinState::First);
        assert_eq!(pins.check("mira", "aa", 3), PinState::Same);

        assert!(pins.forget("lev"));
        assert!(!pins.forget("lev"), "забывать дважды нечего");
        assert_eq!(pins.check("lev", "cc", 4), PinState::First, "забытое имя закрепляется заново");
    }
}
