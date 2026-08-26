//! Правила приватности: кому что позволено.
//!
//! Одна модель на все разрешения, а не отдельная логика под каждое. Правило —
//! это базовый круг плюс именные исключения, и решение всегда принимается в
//! одном порядке: **сначала явный запрет, потом явное разрешение, потом круг**.
//! Запрет впереди намеренно: человек, которого внесли в «никогда», не должен
//! получить доступ из-за того, что он ещё и в контактах.
//!
//! # Где это работает, а где нет
//!
//! Правила делятся на два сорта, и путать их нельзя.
//!
//! **Проверяемые на устройстве** — типы содержимого: фото, голосовые, файлы,
//! превью ссылок. Сервер шифротекст не разбирает и разобрать не может, поэтому
//! отсеивать такое умеет только получатель. Это честная защита: отправитель не
//! обязан слушаться, но принятое всё равно не будет показано и сохранено.
//!
//! **Проверяемые сервером** — видимость в поиске: скрытого человека каталог не
//! отдаёт вовсе, и для ищущего он неотличим от несуществующего имени.
//!
//! **Пока не проверяемые никем** — «кто может писать». Сервер о правиле ещё не
//! знает, поэтому конверт доедет и ляжет в очередь; клиент может его спрятать,
//! но не может не дать его отправить. Такие правила видны через
//! [`Privacy::server_enforced`] — интерфейс обязан говорить об этом прямо, а не
//! изображать защиту, которой нет.

use serde::{Deserialize, Serialize};

/// Базовый круг доступа.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Everyone,
    /// Контакты и те, чей запрос принят.
    Approved,
    Contacts,
    Nobody,
}

/// Кем нам приходится собеседник.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relation {
    Contact,
    /// Запрос принят, но в контакты не добавлен.
    Approved,
    Unknown,
}

/// Одно правило.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub scope: Scope,
    /// Всегда разрешать — hex ключей устройств.
    #[serde(default)]
    pub allow: Vec<String>,
    /// Никогда не разрешать. Сильнее всего остального.
    #[serde(default)]
    pub deny: Vec<String>,
}

impl Rule {
    pub fn new(scope: Scope) -> Self {
        Self { scope, allow: Vec::new(), deny: Vec::new() }
    }

    /// Решение по конкретному собеседнику.
    pub fn permits(&self, peer: &str, relation: Relation) -> bool {
        if self.deny.iter().any(|entry| entry == peer) {
            return false;
        }
        if self.allow.iter().any(|entry| entry == peer) {
            return true;
        }
        match self.scope {
            Scope::Everyone => true,
            Scope::Approved => matches!(relation, Relation::Contact | Relation::Approved),
            Scope::Contacts => matches!(relation, Relation::Contact),
            Scope::Nobody => false,
        }
    }
}

/// Полный набор правил.
///
/// Каждое поле снабжено `serde(default)`: база, записанная прошлой версией, не
/// должна ломаться при добавлении нового правила, а недостающее должно
/// получать безопасное значение, а не «разрешено всем».
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Privacy {
    // --- кто может обращаться -------------------------------------------------
    /// Требует сервера: без него конверт всё равно доедет.
    pub direct_messages: Rule,
    /// Пускать ли тех, кто пришёл по коду приглашения, мимо запросов.
    pub invite_requests: bool,

    // --- типы содержимого (проверяются на устройстве) -------------------------
    pub media: Rule,
    pub voice: Rule,
    pub files: Rule,
    pub calls: Rule,
    /// Превью ссылок — единственное правило, где «разрешено» означает исходящий
    /// сетевой запрос к чужому сайту. Поэтому по умолчанию выключено.
    pub link_previews: Rule,

    // --- что видно обо мне ----------------------------------------------------
    pub presence: Rule,
    pub last_seen: Rule,
    pub read_receipts: Rule,
    pub typing: Rule,
    pub voice_recording_hint: Rule,

    // --- профиль и поиск ------------------------------------------------------
    /// Проверяется сервером: скрытого он не отдаёт из каталога совсем.
    pub discoverable: Rule,
    pub profile_avatar: Rule,
    pub profile_name: Rule,
    pub profile_username: Rule,
}

impl Default for Privacy {
    /// Значения по умолчанию выбраны в пользу приватности.
    ///
    /// Там, где ошибка в одну сторону означает «лишний человек увидел лишнее», а
    /// в другую — «пришлось зайти в настройки», выбрана вторая.
    fn default() -> Self {
        Self {
            // Мессенджер закрытый: попасть внутрь можно только по инвайту, и
            // запирать переписку ещё раз по умолчанию незачем.
            direct_messages: Rule::new(Scope::Everyone),
            invite_requests: true,

            // Незнакомец не должен присылать вложения до того, как его приняли.
            media: Rule::new(Scope::Approved),
            voice: Rule::new(Scope::Approved),
            files: Rule::new(Scope::Approved),
            calls: Rule::new(Scope::Approved),
            link_previews: Rule::new(Scope::Nobody),

            presence: Rule::new(Scope::Contacts),
            // Время последнего появления — самая охотно собираемая метаданная,
            // и по ней восстанавливают распорядок дня. По умолчанию — никому.
            last_seen: Rule::new(Scope::Nobody),
            read_receipts: Rule::new(Scope::Everyone),
            typing: Rule::new(Scope::Contacts),
            voice_recording_hint: Rule::new(Scope::Contacts),

            // Юзернейма по умолчанию нет вовсе; когда человек его заводит, он
            // тем самым и соглашается быть находимым.
            discoverable: Rule::new(Scope::Everyone),
            profile_avatar: Rule::new(Scope::Contacts),
            profile_name: Rule::new(Scope::Everyone),
            profile_username: Rule::new(Scope::Everyone),
        }
    }
}

impl Privacy {
    /// Правило по имени. Интерфейсу удобнее обращаться строкой: тогда экран
    /// настроек — это список, а не пятнадцать отдельных обработчиков.
    pub fn rule(&self, name: &str) -> Option<&Rule> {
        Some(match name {
            "direct_messages" => &self.direct_messages,
            "media" => &self.media,
            "voice" => &self.voice,
            "files" => &self.files,
            "calls" => &self.calls,
            "link_previews" => &self.link_previews,
            "presence" => &self.presence,
            "last_seen" => &self.last_seen,
            "read_receipts" => &self.read_receipts,
            "typing" => &self.typing,
            "voice_recording_hint" => &self.voice_recording_hint,
            "discoverable" => &self.discoverable,
            "profile_avatar" => &self.profile_avatar,
            "profile_name" => &self.profile_name,
            "profile_username" => &self.profile_username,
            _ => return None,
        })
    }

    /// Правила, которые сервер пока не проверяет.
    ///
    /// Список нужен интерфейсу, чтобы честно подписать такие настройки. Как
    /// только сервер научится их учитывать, имя уходит отсюда — и только тогда
    /// подпись исчезает.
    pub fn server_enforced(name: &str) -> bool {
        !matches!(name, "direct_messages")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALICE: &str = "aa";
    const BOB: &str = "bb";

    #[test]
    fn scope_decides_when_there_are_no_exceptions() {
        let rule = Rule::new(Scope::Contacts);
        assert!(rule.permits(ALICE, Relation::Contact));
        assert!(!rule.permits(ALICE, Relation::Approved));
        assert!(!rule.permits(ALICE, Relation::Unknown));
    }

    #[test]
    fn approved_covers_contacts_too() {
        let rule = Rule::new(Scope::Approved);
        assert!(rule.permits(ALICE, Relation::Contact));
        assert!(rule.permits(ALICE, Relation::Approved));
        assert!(!rule.permits(ALICE, Relation::Unknown));
    }

    /// Главное свойство модели: запрет сильнее всего остального.
    #[test]
    fn an_explicit_deny_beats_everything() {
        let mut rule = Rule::new(Scope::Everyone);
        rule.deny.push(ALICE.into());
        rule.allow.push(ALICE.into());
        assert!(!rule.permits(ALICE, Relation::Contact), "запрет обязан быть сильнее разрешения");
        assert!(rule.permits(BOB, Relation::Unknown));
    }

    #[test]
    fn an_explicit_allow_beats_the_scope() {
        let mut rule = Rule::new(Scope::Nobody);
        rule.allow.push(ALICE.into());
        assert!(rule.permits(ALICE, Relation::Unknown));
        assert!(!rule.permits(BOB, Relation::Contact));
    }

    #[test]
    fn nobody_means_nobody_without_exceptions() {
        let rule = Rule::new(Scope::Nobody);
        for relation in [Relation::Contact, Relation::Approved, Relation::Unknown] {
            assert!(!rule.permits(ALICE, relation));
        }
    }

    /// Значения по умолчанию — часть обещания, а не деталь реализации.
    #[test]
    fn defaults_are_the_private_ones() {
        let privacy = Privacy::default();
        assert_eq!(privacy.last_seen.scope, Scope::Nobody, "последняя активность — никому");
        assert_eq!(privacy.link_previews.scope, Scope::Nobody, "превью ссылок — внешний запрос");
        for name in ["media", "voice", "files", "calls"] {
            assert_eq!(
                privacy.rule(name).unwrap().scope,
                Scope::Approved,
                "{name}: незнакомец не должен слать вложения",
            );
        }
    }

    /// База прошлой версии обязана подниматься, а недостающие правила —
    /// получать безопасное значение, а не «разрешено всем».
    #[test]
    fn an_older_document_loads_with_safe_defaults() {
        let saved = r#"{"media":{"scope":"everyone","allow":[],"deny":["cc"]}}"#;
        let privacy: Privacy = serde_json::from_str(saved).unwrap();

        assert_eq!(privacy.media.scope, Scope::Everyone, "сохранённое обязано сохраниться");
        assert_eq!(privacy.media.deny, vec!["cc".to_string()]);
        assert_eq!(privacy.last_seen.scope, Scope::Nobody, "недостающее — по умолчанию");
        assert_eq!(privacy.voice.scope, Scope::Approved);
    }

    #[test]
    fn document_round_trips() {
        let mut privacy = Privacy::default();
        privacy.voice.allow.push(ALICE.into());
        privacy.typing.scope = Scope::Nobody;

        let text = serde_json::to_string(&privacy).unwrap();
        assert_eq!(serde_json::from_str::<Privacy>(&text).unwrap(), privacy);
    }

    /// Интерфейс обязан знать, где защита настоящая, а где только косметика.
    #[test]
    fn rules_the_server_ignores_are_marked() {
        assert!(!Privacy::server_enforced("direct_messages"));
        // Видимость в поиске сервер проверяет сам: скрытого он не отдаёт вовсе.
        assert!(Privacy::server_enforced("discoverable"));
        assert!(Privacy::server_enforced("voice"));
        assert!(Privacy::server_enforced("media"));
    }

    #[test]
    fn every_named_rule_resolves() {
        let privacy = Privacy::default();
        for name in [
            "direct_messages", "media", "voice", "files", "calls", "link_previews",
            "presence", "last_seen", "read_receipts", "typing", "voice_recording_hint",
            "discoverable", "profile_avatar", "profile_name", "profile_username",
        ] {
            assert!(privacy.rule(name).is_some(), "правило {name} не найдено по имени");
        }
        assert!(privacy.rule("выдуманное").is_none());
    }
}
