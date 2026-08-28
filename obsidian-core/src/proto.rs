//! Wire-протокол. Зеркало `obsidian-server/src/proto/frames.ts` — ARCHITECTURE.md §7.
//!
//! Любое расхождение здесь ловится тестом `tests/cross_language.rs`, который
//! гоняет настоящий сервер.

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};

pub const ID_LEN: usize = 16;
pub const KEY_LEN: usize = 32;

pub mod op {
    // сервер → клиент
    pub const HELLO: u8 = 0x01;
    pub const AUTH_OK: u8 = 0x03;
    pub const AUTH_ERR: u8 = 0x04;
    pub const PAY_INFO: u8 = 0x06;
    pub const PAY_OK: u8 = 0x07;
    pub const ENVELOPE: u8 = 0x11;
    pub const SEND_OK: u8 = 0x13;
    pub const PONG: u8 = 0x21;
    pub const ERROR: u8 = 0x30;
    pub const QUEUE_DONE: u8 = 0x31;
    pub const KEYPKG: u8 = 0x16;
    pub const PROFILE: u8 = 0x19;
    pub const RECOVERY_OK: u8 = 0x1c;
    pub const RECOVERY_BLOB: u8 = 0x1d;
    pub const USERNAME_OK: u8 = 0x24;
    pub const USERNAME_FOUND: u8 = 0x25;
    pub const ACCESS_OK: u8 = 0x2a;
    pub const ADMIN_OK: u8 = 0x2c;
    pub const CHANNEL_OK: u8 = 0x32;
    pub const CHANNEL_POST: u8 = 0x33;
    // клиент → сервер
    pub const AUTH: u8 = 0x02;
    pub const PAY_REQUEST: u8 = 0x05;
    pub const SEND: u8 = 0x10;
    pub const ACK: u8 = 0x12;
    pub const PING: u8 = 0x20;
    pub const KEYPKG_PUBLISH: u8 = 0x14;
    pub const KEYPKG_CLAIM: u8 = 0x15;
    pub const PROFILE_GET: u8 = 0x17;
    pub const PROFILE_SET: u8 = 0x18;
    pub const RECOVERY_SET: u8 = 0x1a;
    /// Единственный кадр, который сервер принимает до AUTH: тот, кто
    /// восстанавливается, ключей ещё не имеет и подписаться не может.
    pub const RECOVERY_GET: u8 = 0x1b;
    pub const USERNAME_SET: u8 = 0x22;
    pub const USERNAME_LOOKUP: u8 = 0x23;
    pub const ACCESS_SET: u8 = 0x26;
    pub const PASS_CREATE: u8 = 0x27;
    pub const PASS_REVOKE: u8 = 0x28;
    pub const PASS_PRESENT: u8 = 0x29;
    /// Кадры владельца сервера. Права проверяет сервер по ключу личности.
    pub const ADMIN_GET: u8 = 0x2b;
    pub const ADMIN_ACTION: u8 = 0x2d;
    /// Открытые каналы. Шифрования здесь нет — см. Command::ChannelPublish.
    pub const CHANNEL_CREATE: u8 = 0x34;
    pub const CHANNEL_PUBLISH: u8 = 0x35;
    pub const CHANNEL_LIST: u8 = 0x36;
    pub const CHANNEL_FEED: u8 = 0x37;
    pub const CHANNEL_SUB: u8 = 0x38;
    pub const CHANNEL_FIND: u8 = 0x39;
    pub const CHANNEL_DELETE_POST: u8 = 0x3a;
    pub const CHANNEL_DELETE: u8 = 0x3b;
    pub const CHANNEL_UPDATE: u8 = 0x3c;
    pub const CHANNEL_ADMIN: u8 = 0x3d;
}

#[derive(Debug, Deserialize)]
pub struct Hello {
    pub v: u32,
    pub nonce: String,
    #[serde(rename = "heartbeatSec")]
    pub heartbeat_sec: u64,
    #[serde(rename = "maxFrame")]
    pub max_frame: usize,
    #[serde(default)]
    pub entry: Entry,
    #[serde(default)]
    pub features: Features,
}

#[derive(Debug, Default, Deserialize)]
pub struct Entry {
    #[serde(default)]
    pub invite: bool,
    #[serde(default)]
    pub ton: bool,
}

#[derive(Debug, Default, Deserialize)]
pub struct Features {
    #[serde(default)]
    pub profiles: bool,
    /// Значок и цвет профиля. Старый сервер поля не присылает, и это не мелочь:
    /// он разбирает кадр профиля как «смена аватара» и рвёт соединение как на
    /// битом кадре. Поэтому спрашиваем заранее, а не пробуем наугад.
    #[serde(default)]
    pub decor: bool,
}

#[derive(Debug, Deserialize)]
pub struct ProfilePayload {
    pub device: String,
    #[serde(rename = "chatCode")]
    pub chat_code: String,
    pub handle: Option<String>,
    #[serde(rename = "avatarMime")]
    pub avatar_mime: Option<String>,
    #[serde(rename = "avatarBase64")]
    pub avatar_base64: Option<String>,
    /// Значок и цвет — метки из закрытого списка сервера. Незнакомую метку
    /// клиент просто не рисует: список у нового сервера может быть длиннее.
    #[serde(default)]
    pub emblem: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct AuthOk {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub token: String,
    pub queued: u64,
    /// Признаёт ли сервер это устройство владельцем. Решает сервер; клиент
    /// самому себе прав выдать не может.
    #[serde(default)]
    pub admin: bool,
    /// Сколько наших KeyPackages уже лежит на сервере. Старый сервер поля не
    /// присылает — тогда докладываем полную пачку, как раньше.
    #[serde(rename = "keyPackages", default)]
    pub key_packages: Option<usize>,
}

/// AUTH_ERR несёт новый challenge — повтор возможен на том же сокете.
#[derive(Debug, Deserialize)]
pub struct AuthErr {
    pub code: String,
    pub message: String,
    pub nonce: String,
}

#[cfg(feature = "ton")]
#[derive(Debug, Deserialize)]
pub struct PayInfo {
    #[serde(rename = "ref")]
    pub reference: String,
    pub address: String,
    #[serde(rename = "amountNano")]
    pub amount_nano: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
    pub paid: bool,
    pub nonce: String,
}

/// Ответ на RECOVERY_GET: запечатанный identity-ключ.
#[derive(Debug, Deserialize)]
pub struct RecoveryBlob {
    pub sealed: String,
}

/// Ответ на поиск по юзернейму. `found: false` одинаково означает и «нет
/// такого», и «человек скрыт»: различать их снаружи нельзя.
#[derive(Debug, Deserialize)]
pub struct UsernameFound {
    pub found: bool,
    #[serde(default)]
    pub device: Option<String>,
    #[serde(rename = "chatCode", default)]
    pub chat_code: Option<String>,
    #[serde(rename = "avatarMime", default)]
    pub avatar_mime: Option<String>,
    #[serde(rename = "avatarBase64", default)]
    pub avatar_base64: Option<String>,
    #[serde(default)]
    pub emblem: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

/// Ответ на любую операцию с доступом: политика, выпуск, отзыв, предъявление.
#[derive(Debug, Deserialize)]
pub struct AccessOk {
    #[serde(default)]
    pub admitted: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ServerError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct AuthRequest {
    pub v: u32,
    pub identity: String,
    pub device: String,
    #[serde(rename = "deviceCert")]
    pub device_cert: String,
    pub sig: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite: Option<String>,
    #[serde(rename = "paymentRef", skip_serializing_if = "Option::is_none")]
    pub payment_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
}

/// Доставленный конверт: идентификатор, серверное время, шифротекст.
#[derive(Debug)]
pub struct Envelope {
    pub id: [u8; ID_LEN],
    pub server_ts: u64,
    pub ciphertext: Vec<u8>,
}

pub fn frame(opcode: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + body.len());
    out.push(opcode);
    out.extend_from_slice(body);
    out
}

pub fn json_frame<T: Serialize>(opcode: u8, value: &T) -> Result<Vec<u8>> {
    Ok(frame(opcode, &serde_json::to_vec(value)?))
}

/// Кладёт посылку на сервер. Требует пройденного AUTH: строка привязывается
/// к личности из сессии, а не к присланной в кадре.
pub fn recovery_set_frame(
    login_id: &[u8],
    verifier: &[u8],
    sealed: &[u8],
    totp: Option<&str>,
    code: Option<&str>,
) -> Result<Vec<u8>> {
    json_frame(op::RECOVERY_SET, &serde_json::json!({
        "loginId": hex::encode(login_id),
        "verifier": hex::encode(verifier),
        "sealed": hex::encode(sealed),
        // Секрет и подтверждающий код едут вместе: сервер обязан убедиться, что
        // приложение выдаёт верные коды, до того как запрёт ими посылку.
        "totp": totp,
        "totpCode": code,
    }))
}

/// Снимает посылку с сервера. Отдельный кадр не нужен: тот же opcode с явным
/// признаком очистки — как у аватара, где `null` означает «убрать».
pub fn recovery_forget_frame() -> Result<Vec<u8>> {
    json_frame(op::RECOVERY_SET, &serde_json::json!({ "clear": true }))
}

/// Просит посылку обратно. `token` — доказательство знания пароля; сервер
/// сверяет его хеш со своим и только тогда отвечает.
pub fn recovery_get_frame(login_id: &[u8], token: &[u8], code: Option<&str>) -> Result<Vec<u8>> {
    json_frame(op::RECOVERY_GET, &serde_json::json!({
        "loginId": hex::encode(login_id),
        "token": hex::encode(token),
        "code": code,
    }))
}

/// Занимает юзернейм. На сервер уезжает хеш — самого имени он не увидит.
pub fn username_set_frame(name_hash: &[u8], discoverable: bool) -> Result<Vec<u8>> {
    json_frame(op::USERNAME_SET, &serde_json::json!({
        "nameHash": hex::encode(name_hash),
        "discoverable": discoverable,
    }))
}

pub fn username_clear_frame() -> Result<Vec<u8>> {
    json_frame(op::USERNAME_SET, &serde_json::json!({ "clear": true }))
}

pub fn username_lookup_frame(name_hash: &[u8]) -> Result<Vec<u8>> {
    json_frame(op::USERNAME_LOOKUP, &serde_json::json!({ "nameHash": hex::encode(name_hash) }))
}

pub fn access_set_frame(policy: &str) -> Result<Vec<u8>> {
    json_frame(op::ACCESS_SET, &serde_json::json!({ "dmPolicy": policy }))
}

/// Кладёт на сервер только хеш: сам пропуск остаётся у владельца.
pub fn pass_create_frame(pass_hash: &str, one_time: bool, ttl_sec: u64) -> Result<Vec<u8>> {
    json_frame(op::PASS_CREATE, &serde_json::json!({
        "passHash": pass_hash,
        "oneTime": one_time,
        "ttlSec": ttl_sec,
    }))
}

pub fn pass_revoke_frame(pass_hash: &str) -> Result<Vec<u8>> {
    json_frame(op::PASS_REVOKE, &serde_json::json!({ "passHash": pass_hash }))
}

pub fn pass_present_frame(recipient: &str, pass: &str) -> Result<Vec<u8>> {
    json_frame(op::PASS_PRESENT, &serde_json::json!({ "recipient": recipient, "pass": pass }))
}

pub fn profile_get_frame(query: &str) -> Result<Vec<u8>> {
    json_frame(op::PROFILE_GET, &serde_json::json!({ "query": query }))
}

pub fn profile_set_frame(avatar_mime: &Option<String>, avatar_base64: &Option<String>) -> Result<Vec<u8>> {
    json_frame(op::PROFILE_SET, &serde_json::json!({
        "avatarMime": avatar_mime,
        "avatarBase64": avatar_base64,
    }))
}

/// Значок и цвет отправляются отдельно от аватара: менять одно, не трогая
/// другое. Иначе смена значка стирала бы аватар.
pub fn profile_decor_frame(emblem: &Option<String>, color: &Option<String>) -> Result<Vec<u8>> {
    let mut body = serde_json::Map::new();
    if let Some(emblem) = emblem {
        body.insert("emblem".into(), serde_json::Value::String(emblem.clone()));
    }
    if let Some(color) = color {
        body.insert("color".into(), serde_json::Value::String(color.clone()));
    }
    json_frame(op::PROFILE_SET, &serde_json::Value::Object(body))
}

/// Кадры каналов. Тело собирается из того, что дал интерфейс: у канала нет
/// шифрования, и прятать здесь нечего — прятать надо было бы в диалоге.
pub fn channel_frame(opcode: u8, body: &serde_json::Value) -> Result<Vec<u8>> {
    json_frame(opcode, body)
}

pub fn admin_get_frame(offset: u64) -> Result<Vec<u8>> {
    json_frame(op::ADMIN_GET, &serde_json::json!({ "offset": offset }))
}

pub fn admin_action_frame(action: &str, reference: &str) -> Result<Vec<u8>> {
    json_frame(op::ADMIN_ACTION, &serde_json::json!({
        "action": action,
        "reference": reference,
    }))
}

/// `[16B clientRef][32B recipientDevicePub][4B ttlSec][ciphertext]`
pub fn send_frame(
    client_ref: &[u8; ID_LEN],
    recipient_device: &[u8; KEY_LEN],
    ttl_sec: u32,
    ciphertext: &[u8],
) -> Vec<u8> {
    let mut body = Vec::with_capacity(ID_LEN + KEY_LEN + 4 + ciphertext.len());
    body.extend_from_slice(client_ref);
    body.extend_from_slice(recipient_device);
    body.extend_from_slice(&ttl_sec.to_be_bytes());
    body.extend_from_slice(ciphertext);
    frame(op::SEND, &body)
}

pub fn ack_frame(envelope_id: &[u8; ID_LEN]) -> Vec<u8> {
    frame(op::ACK, envelope_id)
}

/// `[[4B len][bytes]]...` — пачка MLS KeyPackages одним кадром.
pub fn keypkg_publish_frame(packages: &[Vec<u8>]) -> Vec<u8> {
    let mut body = Vec::new();
    for package in packages {
        body.extend_from_slice(&(package.len() as u32).to_be_bytes());
        body.extend_from_slice(package);
    }
    frame(op::KEYPKG_PUBLISH, &body)
}

/// `[16B clientRef][32B devicePub]`
pub fn keypkg_claim_frame(client_ref: &[u8; ID_LEN], device_pub: &[u8; KEY_LEN]) -> Vec<u8> {
    let mut body = Vec::with_capacity(ID_LEN + KEY_LEN);
    body.extend_from_slice(client_ref);
    body.extend_from_slice(device_pub);
    frame(op::KEYPKG_CLAIM, &body)
}

/// `[16B clientRef][1B found][keyPackage]`. `None` — у сервера пакетов нет.
pub fn parse_keypkg(body: &[u8]) -> Result<([u8; ID_LEN], Option<Vec<u8>>)> {
    if body.len() < ID_LEN + 1 {
        return Err(CoreError::BadFrame);
    }
    let mut client_ref = [0u8; ID_LEN];
    client_ref.copy_from_slice(&body[..ID_LEN]);

    let package = match body[ID_LEN] {
        0 => None,
        1 => Some(body[ID_LEN + 1..].to_vec()),
        _ => return Err(CoreError::BadFrame),
    };
    Ok((client_ref, package))
}

/// Разбор с проверкой длины ДО обращения по смещению.
pub fn parse_envelope(body: &[u8]) -> Result<Envelope> {
    const HEADER: usize = ID_LEN + 8;
    if body.len() < HEADER {
        return Err(CoreError::BadFrame);
    }
    let mut id = [0u8; ID_LEN];
    id.copy_from_slice(&body[..ID_LEN]);
    let mut ts = [0u8; 8];
    ts.copy_from_slice(&body[ID_LEN..HEADER]);
    Ok(Envelope { id, server_ts: u64::from_be_bytes(ts), ciphertext: body[HEADER..].to_vec() })
}

/// `[16B clientRef][16B envelopeId]`
pub fn parse_send_ok(body: &[u8]) -> Result<([u8; ID_LEN], [u8; ID_LEN])> {
    if body.len() != ID_LEN * 2 {
        return Err(CoreError::BadFrame);
    }
    let mut client_ref = [0u8; ID_LEN];
    let mut envelope_id = [0u8; ID_LEN];
    client_ref.copy_from_slice(&body[..ID_LEN]);
    envelope_id.copy_from_slice(&body[ID_LEN..]);
    Ok((client_ref, envelope_id))
}

pub fn parse_json<T: for<'a> Deserialize<'a>>(body: &[u8]) -> Result<T> {
    Ok(serde_json::from_slice(body)?)
}

pub fn split(message: &[u8]) -> Result<(u8, &[u8])> {
    match message.split_first() {
        Some((opcode, body)) => Ok((*opcode, body)),
        None => Err(CoreError::BadFrame),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ответ на операции с доступом приходит в четырёх видах; разбор обязан
    /// переживать любой, иначе клиент спотыкается о собственный же пропуск.
    #[test]
    fn access_ok_parses_every_shape() {
        for body in [
            r#"{"dmPolicy":"passes"}"#,
            r#"{"created":true}"#,
            r#"{"revoked":false}"#,
            r#"{"admitted":true}"#,
        ] {
            assert!(parse_json::<AccessOk>(body.as_bytes()).is_ok(), "не разобрано: {body}");
        }
        assert_eq!(
            parse_json::<AccessOk>(br#"{"admitted":false}"#).unwrap().admitted,
            Some(false),
        );
        assert_eq!(parse_json::<AccessOk>(br#"{"created":true}"#).unwrap().admitted, None);
    }

    #[test]
    fn send_frame_layout_matches_spec() {
        let frame = send_frame(&[1u8; ID_LEN], &[2u8; KEY_LEN], 3600, b"cipher");
        assert_eq!(frame[0], op::SEND);
        assert_eq!(&frame[1..1 + ID_LEN], &[1u8; ID_LEN]);
        assert_eq!(&frame[1 + ID_LEN..1 + ID_LEN + KEY_LEN], &[2u8; KEY_LEN]);
        // ttl — big-endian
        assert_eq!(&frame[1 + ID_LEN + KEY_LEN..1 + ID_LEN + KEY_LEN + 4], &[0, 0, 0x0e, 0x10]);
        assert_eq!(&frame[1 + ID_LEN + KEY_LEN + 4..], b"cipher");
    }

    #[test]
    fn envelope_round_trip() {
        let mut body = Vec::new();
        body.extend_from_slice(&[9u8; ID_LEN]);
        body.extend_from_slice(&1234u64.to_be_bytes());
        body.extend_from_slice(b"payload");

        let envelope = parse_envelope(&body).unwrap();
        assert_eq!(envelope.id, [9u8; ID_LEN]);
        assert_eq!(envelope.server_ts, 1234);
        assert_eq!(envelope.ciphertext, b"payload");
    }

    #[test]
    fn empty_ciphertext_is_valid() {
        let mut body = vec![0u8; ID_LEN];
        body.extend_from_slice(&0u64.to_be_bytes());
        assert!(parse_envelope(&body).unwrap().ciphertext.is_empty());
    }

    #[test]
    fn truncated_frames_are_rejected_not_panicking() {
        assert!(parse_envelope(&[]).is_err());
        assert!(parse_envelope(&[0u8; ID_LEN]).is_err());
        assert!(parse_envelope(&[0u8; ID_LEN + 7]).is_err());
        assert!(parse_send_ok(&[0u8; ID_LEN]).is_err());
        assert!(parse_send_ok(&[0u8; ID_LEN * 2 + 1]).is_err());
        assert!(split(&[]).is_err());
    }

    #[test]
    fn send_ok_splits_two_ids() {
        let mut body = vec![1u8; ID_LEN];
        body.extend_from_slice(&[2u8; ID_LEN]);
        let (client_ref, envelope_id) = parse_send_ok(&body).unwrap();
        assert_eq!(client_ref, [1u8; ID_LEN]);
        assert_eq!(envelope_id, [2u8; ID_LEN]);
    }

    #[test]
    fn keypkg_publish_frames_each_package_with_its_length() {
        let frame = keypkg_publish_frame(&[b"aa".to_vec(), b"bbbb".to_vec()]);
        assert_eq!(frame[0], op::KEYPKG_PUBLISH);
        assert_eq!(&frame[1..5], &2u32.to_be_bytes());
        assert_eq!(&frame[5..7], b"aa");
        assert_eq!(&frame[7..11], &4u32.to_be_bytes());
        assert_eq!(&frame[11..15], b"bbbb");
    }

    #[test]
    fn keypkg_response_round_trip() {
        let mut body = vec![7u8; ID_LEN];
        body.push(1);
        body.extend_from_slice(b"package");
        let (client_ref, package) = parse_keypkg(&body).unwrap();
        assert_eq!(client_ref, [7u8; ID_LEN]);
        assert_eq!(package.unwrap(), b"package");

        // found = 0 — это не ошибка, а «пакетов нет».
        let mut empty = vec![7u8; ID_LEN];
        empty.push(0);
        assert!(parse_keypkg(&empty).unwrap().1.is_none());
    }

    #[test]
    fn keypkg_garbage_is_rejected() {
        assert!(parse_keypkg(&[]).is_err());
        assert!(parse_keypkg(&[0u8; ID_LEN]).is_err());
        let mut bad_flag = vec![0u8; ID_LEN];
        bad_flag.push(9);
        assert!(parse_keypkg(&bad_flag).is_err());
    }

    #[test]
    fn hello_parses_entry_flags() {
        let hello: Hello = parse_json(
            br#"{"v":1,"nonce":"aa","serverTime":0,"heartbeatSec":30,"maxFrame":1048576,
                 "entry":{"invite":true,"ton":false}}"#,
        )
        .unwrap();
        assert_eq!(hello.heartbeat_sec, 30);
        assert!(hello.entry.invite);
        assert!(!hello.entry.ton);
    }

    #[test]
    fn auth_request_omits_absent_fields() {
        let request = AuthRequest {
            v: 1,
            identity: "aa".into(),
            device: "bb".into(),
            device_cert: "cc".into(),
            sig: "dd".into(),
            invite: None,
            payment_ref: None,
            handle: None,
        };
        let json = serde_json::to_string(&request).unwrap();
        assert!(!json.contains("invite"));
        assert!(!json.contains("paymentRef"));
        assert!(!json.contains("handle"));
    }
}
