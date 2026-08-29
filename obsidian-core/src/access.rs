//! Пропуска: кому разрешено вам писать.
//!
//! Задача — дать серверу проверять право написать, не давая ему знать, кто с
//! кем переписывается.
//!
//! Пропуск — это 32 случайных байта. Владелец кладёт на сервер только их хеш;
//! сам секрет он раздаёт тем, кого пускает. Отправитель предъявляет секрет на
//! своём соединении, сервер сверяет хеш и запоминает допуск **в памяти, до
//! конца соединения**. На диске у сервера остаётся строка «хеш → владелец», из
//! которой нельзя узнать, кому пропуск отдан.
//!
//! Связку «отправитель → получатель» сервер и так видит транзитно в каждом
//! конверте — пропуск новых следов не добавляет.
//!
//! # Откуда пропуск берётся
//!
//! Два пути, и оба ведут к тому, что включение политики никого не отрезает:
//!
//! * **Выдача знакомым.** При каждом подключении клиент сверяет книгу
//!   отношений с [`Access::granted`] и выдаёт пропуск каждому контакту и
//!   одобренному, у кого его ещё нет. Пропуск уезжает служебным сообщением
//!   внутри шифрованного канала — сервер его не видит.
//! * **Ссылка-приглашение.** Пропуск можно выпустить отдельно, со сроком и
//!   признаком одноразовости, и передать любым способом. Так к вам пишет тот,
//!   кто ещё не знаком.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::crypto::random_bytes;

const PASS_DOMAIN: &str = "obsidian-pass-v1";
pub const PASS_LEN: usize = 32;

/// Кому позволено писать.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Policy {
    /// Любой, кто знает адрес. Значение по умолчанию: попасть в мессенджер
    /// можно только по приглашению, и запирать переписку ещё раз незачем.
    #[default]
    Everyone,
    /// Только предъявившие пропуск.
    Passes,
}

/// Выпущенная ссылка-приглашение.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invite {
    /// Сам секрет: без него ссылку не пересобрать и не показать повторно.
    pub pass: String,
    pub hash: String,
    #[serde(default)]
    pub label: Option<String>,
    pub one_time: bool,
    /// 0 — бессрочно.
    pub ttl_sec: u64,
    pub created_at: i64,
}

impl Invite {
    /// Ссылка в том виде, в каком её передают человеку.
    pub fn link(&self) -> String {
        format!("obsidian://invite/{}", self.pass)
    }
}

/// Всё, что нужно знать о доступе. Лежит в запечатанной базе.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Access {
    pub policy: Policy,
    /// Кому мы уже выдали пропуск: устройство → хеш, чтобы можно было отозвать.
    pub granted: BTreeMap<String, String>,
    /// Пропуска, выданные нам: устройство собеседника → секрет.
    pub held: BTreeMap<String, String>,
    pub invites: Vec<Invite>,
}

/// Хеш, который уезжает на сервер. Должен совпадать с серверным до байта.
pub fn pass_hash(pass: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(PASS_DOMAIN.as_bytes());
    hasher.update(pass);
    hasher.finalize().into()
}

/// Новый пропуск: секрет и его хеш, оба в hex.
pub fn new_pass() -> (String, String) {
    let pass = random_bytes(PASS_LEN);
    (hex::encode(&pass), hex::encode(pass_hash(&pass)))
}

impl Access {
    /// Кому ещё не выдан пропуск из тех, кому он полагается.
    ///
    /// Сверка идёт при каждом подключении, поэтому включение политики не
    /// отрезает уже знакомых: они получают пропуска тем же заходом. Это же
    /// чинит и пропущенную выдачу, если в прошлый раз связь оборвалась.
    pub fn missing_grants<'a>(
        &self,
        peers: impl Iterator<Item = &'a String>,
    ) -> Vec<String> {
        peers
            .filter(|device| !self.granted.contains_key(*device))
            .cloned()
            .collect()
    }

    pub fn remember_grant(&mut self, device: &str, hash: &str) {
        self.granted.insert(device.to_owned(), hash.to_owned());
    }

    /// Забирает пропуск обратно. Возвращает хеш, который нужно отозвать.
    pub fn take_grant(&mut self, device: &str) -> Option<String> {
        self.granted.remove(device)
    }

    pub fn hold(&mut self, device: &str, pass: &str) {
        self.held.insert(device.to_owned(), pass.to_owned());
    }

    /// Что предъявлять при подключении: пары «получатель → секрет».
    pub fn to_present(&self) -> Vec<(String, String)> {
        self.held.iter().map(|(device, pass)| (device.clone(), pass.clone())).collect()
    }
}

/// Служебное сообщение внутри шифрованного канала.
///
/// Префикс отличается от того, которым пользуется интерфейс, поэтому такое
/// сообщение до него не доходит и в переписке не появляется. Ядро разбирает его
/// само и наружу не отдаёт — человеку показывать нечего.
const CONTROL_PREFIX: &str = "\u{2063}OBSCTL1:";

pub fn pass_gift(pass: &str) -> String {
    format!("{CONTROL_PREFIX}{{\"pass\":\"{pass}\"}}")
}

/// Просьба удалить сообщения и у собеседника.
///
/// Именно просьба: выполнит её клиент собеседника, а не мы. Обещать большего
/// нельзя — копия уже у него, и запретить её сохранить мы не в силах.
pub fn delete_request(ids: &[String]) -> String {
    let list = serde_json::to_string(ids).unwrap_or_else(|_| "[]".into());
    format!("{CONTROL_PREFIX}{{\"delete\":{list}}}")
}

/// Просьба заменить у собеседника тело ранее отправленного сообщения.
///
/// Как и удаление у обоих, это именно просьба: выполнит её его клиент, а
/// проверить исполнение невозможно. Старое тело у него уже было — правка не
/// отменяет того, что он прочитал.
pub fn edit_request(id: &str, body: &str) -> String {
    let payload = serde_json::json!({ "edit": { "id": id, "body": body } });
    format!("{CONTROL_PREFIX}{payload}")
}

/// Ключ, которым открывается наш аватар.
///
/// Уезжает тем же шифрованным каналом, что и пропуск, и по той же причине: это
/// то, что собеседнику нужно от нас получить, а серверу видеть незачем.
pub fn profile_key_gift(key_hex: &str) -> String {
    format!("{CONTROL_PREFIX}{{\"profileKey\":\"{key_hex}\"}}")
}

/// «Печатает» и «перестал печатать».
///
/// Едет тем же шифрованным каналом, что и сообщения: сервер видит очередной
/// непрозрачный конверт и о наборе текста не узнаёт ничего.
pub fn typing_signal(active: bool) -> String {
    format!("{CONTROL_PREFIX}{{\"typing\":{active}}}")
}

/// «Я в сети».
///
/// Отправляется при подключении тем, кому это разрешено правилом. Обратного
/// сигнала «вышел» нет и быть не может: связь рвётся без предупреждения, и
/// отправить его в этот момент уже нечем. Поэтому получатель считает
/// присутствие устаревающим — «в сети» означает «объявился недавно», а не
/// «прямо сейчас держит соединение». Обещать второе значило бы врать.
pub fn presence_signal() -> String {
    format!("{CONTROL_PREFIX}{{\"online\":true}}")
}

/// Описание группы: название, вид и владелец.
///
/// Едет обычным шифрованным сообщением внутри самой группы: в приглашении MLS
/// места под название нет, а придумать его получатель не может.
pub fn group_signal(title: &str, kind: &str, owner: &str) -> String {
    let body = serde_json::json!({ "group": { "title": title, "kind": kind, "owner": owner } });
    format!("{CONTROL_PREFIX}{body}")
}

/// Что было в служебном сообщении.
#[derive(Debug, PartialEq, Eq)]
pub enum Control {
    Pass(String),
    /// Ключ от аватара собеседника.
    ProfileKey(String),
    Delete(Vec<String>),
    /// Правка уже отправленного: тот же логический идентификатор, новое тело.
    Edit { id: String, body: String },
    Typing(bool),
    Online,
    Group { title: String, kind: String, owner: String },
}

pub fn parse_signal(body: &str) -> Option<Control> {
    let payload = body.strip_prefix(CONTROL_PREFIX)?;
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;

    if let Some(pass) = value.get("pass").and_then(|v| v.as_str()) {
        // Длину проверяем здесь: мусор в этом поле стоил бы отказа при каждом
        // подключении, а починить его человек не смог бы — он его не видит.
        if pass.len() != PASS_LEN * 2 || hex::decode(pass).is_err() {
            return None;
        }
        return Some(Control::Pass(pass.to_owned()));
    }
    if let Some(key) = value.get("profileKey").and_then(|v| v.as_str()) {
        // Длина проверяется здесь по той же причине, что и у пропуска: мусор в
        // этом поле человек не видит и починить не может.
        if key.len() != 64 || hex::decode(key).is_err() {
            return None;
        }
        return Some(Control::ProfileKey(key.to_owned()));
    }
    if let Some(edit) = value.get("edit") {
        // Обе половины обязательны: правка без тела или без адресата — это
        // мусор, а не команда, и применять из него нечего.
        let (Some(id), Some(body)) = (
            edit.get("id").and_then(|v| v.as_str()),
            edit.get("body").and_then(|v| v.as_str()),
        ) else {
            return None;
        };
        if id.is_empty() || body.is_empty() {
            return None;
        }
        return Some(Control::Edit { id: id.to_owned(), body: body.to_owned() });
    }
    if let Some(ids) = value.get("delete").and_then(|v| v.as_array()) {
        return Some(Control::Delete(
            ids.iter().filter_map(|id| id.as_str().map(str::to_owned)).collect(),
        ));
    }
    if let Some(active) = value.get("typing").and_then(|v| v.as_bool()) {
        return Some(Control::Typing(active));
    }
    if value.get("online").and_then(|v| v.as_bool()) == Some(true) {
        return Some(Control::Online);
    }
    if let Some(group) = value.get("group") {
        return Some(Control::Group {
            title: group.get("title")?.as_str()?.to_string(),
            kind: group.get("kind")?.as_str()?.to_string(),
            owner: group.get("owner")?.as_str()?.to_string(),
        });
    }
    None
}

pub fn is_control(body: &str) -> bool {
    body.starts_with(CONTROL_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_key_travels_and_comes_back_whole() {
        let key = "ab".repeat(32);
        let signal = profile_key_gift(&key);
        assert!(is_control(&signal), "ключ обязан ехать служебным сообщением");
        assert_eq!(parse_signal(&signal), Some(Control::ProfileKey(key.clone())));
    }

    #[test]
    fn a_profile_key_of_the_wrong_shape_is_ignored() {
        // Мусор в этом поле человек не видит и починить не может, поэтому
        // разбирается он здесь и молча.
        for bad in ["", "короткий", &"zz".repeat(32), &"ab".repeat(31)] {
            let signal = format!("{CONTROL_PREFIX}{{\"profileKey\":\"{bad}\"}}");
            assert_eq!(parse_signal(&signal), None, "принят негодный ключ: {bad}");
        }
    }

    #[test]
    fn a_pass_is_random_and_its_hash_is_stable() {
        let (first, first_hash) = new_pass();
        let (second, _) = new_pass();
        assert_ne!(first, second, "пропуска обязаны быть разными");
        assert_eq!(first.len(), PASS_LEN * 2);
        assert_eq!(hex::encode(pass_hash(&hex::decode(&first).unwrap())), first_hash);
    }

    /// Хеш не должен быть пропуском в другом виде: сервер хранит именно его.
    #[test]
    fn the_hash_hides_the_pass() {
        let (pass, hash) = new_pass();
        assert_ne!(pass, hash);
    }

    #[test]
    fn grants_are_tracked_so_they_are_not_issued_twice() {
        let mut access = Access::default();
        let peers = vec!["aa".to_string(), "bb".to_string()];

        assert_eq!(access.missing_grants(peers.iter()).len(), 2);
        access.remember_grant("aa", "хеш");
        assert_eq!(access.missing_grants(peers.iter()), vec!["bb".to_string()]);

        access.remember_grant("bb", "хеш2");
        assert!(access.missing_grants(peers.iter()).is_empty());
    }

    /// Отзыв возвращает хеш: без него серверу нечего было бы сказать.
    #[test]
    fn taking_a_grant_back_yields_the_hash_to_revoke() {
        let mut access = Access::default();
        access.remember_grant("aa", "хеш");
        assert_eq!(access.take_grant("aa").as_deref(), Some("хеш"));
        assert_eq!(access.take_grant("aa"), None);
    }

    #[test]
    fn held_passes_are_presented_per_recipient() {
        let mut access = Access::default();
        access.hold("aa", "секрет-а");
        access.hold("bb", "секрет-б");

        let mut presented = access.to_present();
        presented.sort();
        assert_eq!(presented, vec![
            ("aa".to_string(), "секрет-а".to_string()),
            ("bb".to_string(), "секрет-б".to_string()),
        ]);
    }

    /// Служебное сообщение не должно доходить до интерфейса.
    #[test]
    fn a_gift_round_trips_and_is_recognisable() {
        let (pass, _) = new_pass();
        let body = pass_gift(&pass);

        assert!(is_control(&body));
        assert_eq!(parse_signal(&body), Some(Control::Pass(pass)));
    }

    #[test]
    fn a_delete_request_round_trips() {
        let ids = vec!["один".to_string(), "два".to_string()];
        assert_eq!(parse_signal(&delete_request(&ids)), Some(Control::Delete(ids)));
    }

    #[test]
    fn typing_round_trips_both_ways() {
        assert_eq!(parse_signal(&typing_signal(true)), Some(Control::Typing(true)));
        assert_eq!(parse_signal(&typing_signal(false)), Some(Control::Typing(false)));
    }

    #[test]
    fn presence_round_trips() {
        assert_eq!(parse_signal(&presence_signal()), Some(Control::Online));
    }

    /// Служебные сообщения не должны путаться между собой.
    #[test]
    fn signals_do_not_collide() {
        let (pass, _) = new_pass();
        assert!(matches!(parse_signal(&pass_gift(&pass)), Some(Control::Pass(_))));
        assert!(matches!(parse_signal(&typing_signal(true)), Some(Control::Typing(_))));
        assert!(matches!(parse_signal(&delete_request(&[])), Some(Control::Delete(_))));
        assert!(matches!(parse_signal(&presence_signal()), Some(Control::Online)));
    }

    #[test]
    fn ordinary_text_is_not_control() {
        for body in ["привет", "", "OBSCTL1:{}", "\u{2063}OBS1:{\"type\":\"text\"}"] {
            assert!(!is_control(body), "принято за служебное: {body}");
            assert!(parse_signal(body).is_none());
        }
    }

    /// Мусор в служебном поле человек не увидит и не починит — отвергаем молча.
    #[test]
    fn a_malformed_gift_is_refused() {
        for bad in [
            "\u{2063}OBSCTL1:не json",
            "\u{2063}OBSCTL1:{\"pass\":\"коротко\"}",
            "\u{2063}OBSCTL1:{\"pass\":\"ZZ\"}",
            "\u{2063}OBSCTL1:{}",
        ] {
            assert!(is_control(bad), "префикс обязан распознаваться: {bad}");
            assert!(parse_signal(bad).is_none(), "принят мусор: {bad}");
        }
    }

    #[test]
    fn an_invite_becomes_a_link() {
        let (pass, hash) = new_pass();
        let invite = Invite {
            pass: pass.clone(),
            hash,
            label: Some("для Миры".into()),
            one_time: true,
            ttl_sec: 3600,
            created_at: 0,
        };
        assert_eq!(invite.link(), format!("obsidian://invite/{pass}"));
    }

    /// Запись прошлой версии обязана подниматься с безопасным значением.
    #[test]
    fn an_older_record_loads_as_everyone() {
        let access: Access = serde_json::from_str("{}").unwrap();
        assert_eq!(access.policy, Policy::Everyone);
        assert!(access.granted.is_empty());
        assert!(access.held.is_empty());
    }

    #[test]
    fn access_round_trips() {
        let mut access = Access::default();
        access.policy = Policy::Passes;
        access.remember_grant("aa", "хеш");
        access.hold("bb", "секрет");

        let text = serde_json::to_string(&access).unwrap();
        assert_eq!(serde_json::from_str::<Access>(&text).unwrap(), access);
    }

    #[test]
    fn an_edit_request_survives_a_round_trip() {
        let body = edit_request("m-1", "исправленный текст");
        assert_eq!(
            parse_signal(&body),
            Some(Control::Edit { id: "m-1".into(), body: "исправленный текст".into() })
        );
    }

    #[test]
    fn half_an_edit_is_not_a_command() {
        // Без тела или без адресата применять нечего — это мусор, а не правка.
        for payload in [
            r#"{"edit":{"id":"m-1"}}"#,
            r#"{"edit":{"body":"текст"}}"#,
            r#"{"edit":{"id":"","body":"текст"}}"#,
            r#"{"edit":{"id":"m-1","body":""}}"#,
            r#"{"edit":"строка"}"#,
        ] {
            let body = format!("{CONTROL_PREFIX}{payload}");
            assert_eq!(parse_signal(&body), None, "принято: {payload}");
        }
    }
}
