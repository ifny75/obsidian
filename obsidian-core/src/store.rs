//! Локальное хранилище. Всё содержательное лежит запечатанным (crypto.rs).
//!
//! В открытом виде на диске остаются только: соль, идентификаторы записей,
//! идентификатор беседы и время. Ни текстов, ни ключей, ни адресатов.

use rusqlite::{params, Connection, OptionalExtension};

use crate::crypto::{random_salt, MasterKey, SALT_LEN};
use crate::error::{CoreError, Result};
use crate::keys::{Credentials, SecretKey};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v BLOB NOT NULL
);

-- Приватные ключи. Ровно одна строка.
CREATE TABLE IF NOT EXISTS keyring (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  sealed BLOB NOT NULL
);

-- История. conversation — непрозрачный идентификатор, текст внутри sealed.
CREATE TABLE IF NOT EXISTS messages (
  id           BLOB PRIMARY KEY,
  conversation BLOB NOT NULL,
  outgoing     INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  sealed       BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation, created_at);

-- Состояние MLS одним запечатанным снимком: внутри эпохальные секреты,
-- приватные ключи листьев и ключ подписи. В открытом виде — только публичный
-- ключ подписи, он и так публичен.
CREATE TABLE IF NOT EXISTS mls_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  signer_public BLOB NOT NULL,
  sealed        BLOB NOT NULL
);

-- Какая MLS-группа обслуживает переписку с этим устройством.
CREATE TABLE IF NOT EXISTS conversations (
  device_pub BLOB PRIMARY KEY,
  group_id   BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS conversations_group ON conversations(group_id);

-- Группы и каналы. Состав хранит сам MLS, здесь — только название, вид и
-- владелец, и те запечатаны: название группы говорит о человеке не меньше,
-- чем список её участников.
CREATE TABLE IF NOT EXISTS groups (
  group_id   BLOB PRIMARY KEY,
  kind       TEXT NOT NULL,
  sealed     BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

-- Настройки, которые нельзя держать как обычные пожелания оформления: правила
-- приватности называют конкретных людей, а список исключений — это готовый
-- контакт-лист. Он лежит здесь запечатанным, а не в открытом файле рядом.
CREATE TABLE IF NOT EXISTS settings (
  k      TEXT PRIMARY KEY,
  sealed BLOB NOT NULL
);
";

pub struct Store {
    connection: Connection,
    key: MasterKey,
    /// Путь к файлу базы. Нужен, чтобы ответить на вопрос «сколько занято»:
    /// SQLite своего размера не сообщает, а спрашивают об этом из настроек.
    path: String,
}

pub struct Message {
    /// Позиция в базе. Наружу уходит только как непрозрачный курсор.
    pub seq: i64,
    pub id: Vec<u8>,
    pub outgoing: bool,
    pub created_at: i64,
    pub body: Vec<u8>,
}

impl Store {
    /// Сколько места занято на диске.
    ///
    /// Считается вместе с журналом WAL: свежие записи лежат именно там, и без
    /// него база с полной перепиской выглядела бы пустой.
    pub fn footprint(&self) -> u64 {
        let size = |suffix: &str| {
            std::fs::metadata(format!("{}{suffix}", self.path))
                .map(|meta| meta.len())
                .unwrap_or(0)
        };
        size("") + size("-wal") + size("-shm")
    }

    /// Сколько бесед и сообщений лежит на устройстве.
    pub fn counts(&self) -> Result<(u64, u64)> {
        let conversations: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM conversations", [], |row| row.get(0))?;
        let messages: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM messages", [], |row| row.get(0))?;
        Ok((conversations.max(0) as u64, messages.max(0) as u64))
    }

    /// Открывает или создаёт базу. Неверный пароль обнаруживается при первом
    /// же чтении запечатанной записи, а не молчаливо.
    pub fn open(path: &str, password: &[u8]) -> Result<Self> {
        let connection = Connection::open(path)?;
        connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        connection.execute_batch(SCHEMA)?;

        let salt = match Self::read_meta(&connection, "salt")? {
            Some(existing) => existing,
            None => {
                let fresh = random_salt().to_vec();
                connection.execute(
                    "INSERT INTO meta (k, v) VALUES ('salt', ?1)",
                    params![fresh],
                )?;
                fresh
            }
        };
        if salt.len() != SALT_LEN {
            return Err(CoreError::StoreLocked);
        }

        Ok(Self { key: MasterKey::derive(password, &salt)?, connection, path: path.to_string() })
    }

    fn read_meta(connection: &Connection, key: &str) -> Result<Option<Vec<u8>>> {
        Ok(connection
            .query_row("SELECT v FROM meta WHERE k = ?1", params![key], |row| row.get(0))
            .optional()?)
    }

    /// Ключи хранятся одной запечатанной записью: 32 байта identity + 32 device.
    pub fn save_credentials(&self, credentials: &Credentials) -> Result<()> {
        let mut plain = Vec::with_capacity(64);
        plain.extend_from_slice(&credentials.identity.to_bytes());
        plain.extend_from_slice(&credentials.device.to_bytes());

        let sealed = self.key.seal(b"keyring", &plain)?;
        self.connection.execute(
            "INSERT INTO keyring (id, sealed) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET sealed = excluded.sealed",
            params![sealed],
        )?;
        Ok(())
    }

    pub fn load_credentials(&self) -> Result<Credentials> {
        let sealed: Vec<u8> = self
            .connection
            .query_row("SELECT sealed FROM keyring WHERE id = 1", [], |row| row.get(0))
            .optional()?
            .ok_or(CoreError::NoCredentials)?;

        let plain = self.key.open(b"keyring", &sealed)?;
        if plain.len() != 64 {
            return Err(CoreError::StoreLocked);
        }
        Ok(Credentials {
            identity: SecretKey::from_bytes(&plain[..32])?,
            device: SecretKey::from_bytes(&plain[32..])?,
        })
    }

    pub fn has_credentials(&self) -> Result<bool> {
        Ok(self
            .connection
            .query_row("SELECT 1 FROM keyring WHERE id = 1", [], |_| Ok(()))
            .optional()?
            .is_some())
    }

    /// AAD привязывает запись к её id: перенос строки ломает расшифровку.
    pub fn insert_message(
        &self,
        id: &[u8],
        conversation: &[u8],
        outgoing: bool,
        created_at: i64,
        body: &[u8],
    ) -> Result<()> {
        let sealed = self.key.seal(id, body)?;
        self.connection.execute(
            "INSERT INTO messages (id, conversation, outgoing, created_at, sealed)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, conversation, outgoing as i64, created_at, sealed],
        )?;
        Ok(())
    }

    /// Страница истории, новейшие первыми.
    ///
    /// `before` — курсор из предыдущей страницы (`created_at`, `rowid`); `None`
    /// означает «с самого свежего». Пара, а не одно время: миллисекунды не
    /// различают сообщения, отправленные подряд, и по одному только времени
    /// страница либо теряла бы их, либо показывала дважды.
    pub fn list_messages(
        &self,
        conversation: &[u8],
        limit: i64,
        before: Option<(i64, i64)>,
    ) -> Result<Vec<Message>> {
        let (before_time, before_seq) = before.unwrap_or((i64::MAX, i64::MAX));
        let mut statement = self.connection.prepare(
            "SELECT id, outgoing, created_at, sealed, rowid FROM messages
             WHERE conversation = ?1 AND (created_at, rowid) < (?3, ?4)
             ORDER BY created_at DESC, rowid DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![conversation, limit, before_time, before_seq],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )?;

        let mut out = Vec::new();
        for row in rows {
            let (id, outgoing, created_at, sealed, seq) = row?;
            let body = self.key.open(&id, &sealed)?;
            out.push(Message { id, outgoing: outgoing != 0, created_at, body, seq });
        }
        Ok(out)
    }

    /// Запечатанная настройка. AAD — имя ключа: подменить одну запись другой,
    /// переставив строки, не выйдет.
    pub fn save_setting(&self, key: &str, value: &[u8]) -> Result<()> {
        let sealed = self.key.seal(key.as_bytes(), value)?;
        self.connection.execute(
            "INSERT INTO settings (k, sealed) VALUES (?1, ?2)
             ON CONFLICT(k) DO UPDATE SET sealed = excluded.sealed",
            params![key, sealed],
        )?;
        Ok(())
    }

    /// `None` — настройки ещё нет. Отличать от «пусто» обязательно: первая
    /// означает «взять значения по умолчанию», вторая — «человек так решил».
    pub fn load_setting(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let sealed: Option<Vec<u8>> = self
            .connection
            .query_row("SELECT sealed FROM settings WHERE k = ?1", params![key], |row| row.get(0))
            .optional()?;
        match sealed {
            Some(sealed) => Ok(Some(self.key.open(key.as_bytes(), &sealed)?)),
            None => Ok(None),
        }
    }

    // --- состояние MLS --------------------------------------------------------

    /// Снимок запечатывается тем же ключом, что и сообщения: на диске у него
    /// нет ни одного открытого байта, кроме публичного ключа подписи.
    pub fn save_mls(&self, signer_public: &[u8], snapshot: &[u8]) -> Result<()> {
        let sealed = self.key.seal(b"mls", snapshot)?;
        self.connection.execute(
            "INSERT INTO mls_state (id, signer_public, sealed) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET signer_public = excluded.signer_public,
                                           sealed = excluded.sealed",
            params![signer_public, sealed],
        )?;
        Ok(())
    }

    /// `(signer_public, snapshot)` либо `None`, если MLS ещё не заводили.
    pub fn load_mls(&self) -> Result<Option<(Vec<u8>, Vec<u8>)>> {
        let row: Option<(Vec<u8>, Vec<u8>)> = self
            .connection
            .query_row("SELECT signer_public, sealed FROM mls_state WHERE id = 1", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;

        match row {
            None => Ok(None),
            Some((public, sealed)) => Ok(Some((public, self.key.open(b"mls", &sealed)?))),
        }
    }

    // --- беседы ----------------------------------------------------------------

    pub fn set_conversation(&self, device_pub: &[u8], group_id: &[u8]) -> Result<()> {
        self.connection.execute(
            "INSERT INTO conversations (device_pub, group_id) VALUES (?1, ?2)
             ON CONFLICT(device_pub) DO UPDATE SET group_id = excluded.group_id",
            params![device_pub, group_id],
        )?;
        Ok(())
    }

    /// Обратный поиск: чья это беседа. Нужен проверкам при получении —
    /// состав группы сверяется с тем собеседником, которого мы там ждём.
    /// Запоминает группу. Повторный вызов обновляет название.
    pub fn save_group(&self, group_id: &[u8], kind: &str, meta: &[u8], created_at: i64)
        -> Result<()> {
        let sealed = self.key.seal(b"group", meta)?;
        self.connection.execute(
            "INSERT INTO groups (group_id, kind, sealed, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(group_id) DO UPDATE SET kind = excluded.kind, sealed = excluded.sealed",
            params![group_id, kind, sealed, created_at],
        )?;
        Ok(())
    }

    /// Вид и описание группы. `None` — такой группы у нас нет.
    pub fn group(&self, group_id: &[u8]) -> Result<Option<(String, Vec<u8>)>> {
        let row: Option<(String, Vec<u8>)> = self
            .connection
            .query_row(
                "SELECT kind, sealed FROM groups WHERE group_id = ?1",
                params![group_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match row {
            Some((kind, sealed)) => Ok(Some((kind, self.key.open(b"group", &sealed)?))),
            None => Ok(None),
        }
    }

    /// Все группы: идентификатор, вид, описание.
    pub fn list_groups(&self) -> Result<Vec<(Vec<u8>, String, Vec<u8>)>> {
        let mut statement = self
            .connection
            .prepare("SELECT group_id, kind, sealed FROM groups ORDER BY created_at")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })?;

        let mut groups = Vec::new();
        for row in rows {
            let (group_id, kind, sealed) = row?;
            groups.push((group_id, kind, self.key.open(b"group", &sealed)?));
        }
        Ok(groups)
    }

    /// Забывает группу вместе с её перепиской.
    pub fn forget_group(&self, group_id: &[u8]) -> Result<()> {
        self.connection
            .execute("DELETE FROM messages WHERE conversation = ?1", params![group_id])?;
        self.connection
            .execute("DELETE FROM groups WHERE group_id = ?1", params![group_id])?;
        Ok(())
    }

    pub fn peer_of_conversation(&self, group_id: &[u8]) -> Result<Option<Vec<u8>>> {
        Ok(self
            .connection
            .query_row(
                "SELECT device_pub FROM conversations WHERE group_id = ?1",
                params![group_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Все заведённые беседы. Нужен интерфейсу после перезапуска: события
    /// `conversation_started` живут только в текущей сессии.
    pub fn list_conversations(&self) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
        let mut statement = self
            .connection
            .prepare("SELECT device_pub, group_id FROM conversations ORDER BY device_pub")?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?)))?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn conversation_with(&self, device_pub: &[u8]) -> Result<Option<Vec<u8>>> {
        Ok(self
            .connection
            .query_row(
                "SELECT group_id FROM conversations WHERE device_pub = ?1",
                params![device_pub],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Физическое удаление. Флагов «удалено» здесь нет — как и на сервере.
    /// Удаляет одно сообщение. Возвращает, нашлось ли оно.
    ///
    /// Идентификатор здесь — тот, что интерфейс кладёт внутрь содержимого, а не
    /// первичный ключ записи: удалять человек просит именно то сообщение,
    /// которое видит.
    pub fn delete_message_by_id(&self, conversation: &[u8], logical_id: &str) -> Result<bool> {
        // Логический идентификатор лежит внутри запечатанного тела, поэтому
        // строку приходится искать перебором: снаружи он не виден, и это
        // правильно — иначе он лежал бы на диске открытым.
        for message in self.list_messages(conversation, i64::MAX, None)? {
            let body = String::from_utf8_lossy(&message.body);
            if !body.contains(logical_id) {
                continue;
            }
            self.connection
                .execute("DELETE FROM messages WHERE id = ?1", params![message.id])?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Убирает и переписку, и саму беседу: писать этому устройству заново
    /// придётся с нового приглашения MLS.
    pub fn forget_conversation(&self, conversation: &[u8]) -> Result<()> {
        self.delete_conversation(conversation)?;
        self.connection
            .execute("DELETE FROM conversations WHERE group_id = ?1", params![conversation])?;
        Ok(())
    }

    pub fn delete_conversation(&self, conversation: &[u8]) -> Result<usize> {
        Ok(self
            .connection
            .execute("DELETE FROM messages WHERE conversation = ?1", params![conversation])?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Файл базы, который сам за собой убирает. WAL оставляет ещё -wal и -shm,
    /// а Windows не отдаёт файл, пока жив Connection, — поэтому уборка идёт в
    /// Drop, уже после закрытия стора.
    struct TempDb(String);

    impl TempDb {
        fn new(name: &str) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!("obsidian-core-{name}-{}.db", std::process::id()));
            let path = path.to_string_lossy().into_owned();
            Self::cleanup(&path);
            Self(path)
        }

        fn path(&self) -> &str {
            &self.0
        }

        fn cleanup(path: &str) {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{path}{suffix}"));
            }
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            Self::cleanup(&self.0);
        }
    }

    #[test]
    fn credentials_survive_reopen() {
        let db = TempDb::new("creds");
        let path = db.path();
        let credentials = Credentials::generate();
        let identity = credentials.identity_pub();

        {
            let store = Store::open(path, b"pw").unwrap();
            assert!(!store.has_credentials().unwrap());
            store.save_credentials(&credentials).unwrap();
        }
        {
            let store = Store::open(path, b"pw").unwrap();
            assert!(store.has_credentials().unwrap());
            assert_eq!(store.load_credentials().unwrap().identity_pub(), identity);
        }
    }

    #[test]
    fn wrong_password_cannot_read_keys() {
        let db = TempDb::new("wrongpw");
        {
            let store = Store::open(db.path(), b"right").unwrap();
            store.save_credentials(&Credentials::generate()).unwrap();
        }
        let store = Store::open(db.path(), b"wrong").unwrap();
        // Строка на месте, но расшифровать её нечем.
        assert!(store.has_credentials().unwrap());
        assert!(matches!(store.load_credentials(), Err(CoreError::StoreLocked)));
    }

    #[test]
    fn missing_keyring_is_distinct_from_wrong_password() {
        let db = TempDb::new("nokeys");
        let store = Store::open(db.path(), b"pw").unwrap();
        assert!(matches!(store.load_credentials(), Err(CoreError::NoCredentials)));
    }

    #[test]
    fn messages_round_trip_and_stay_sealed_on_disk() {
        let db = TempDb::new("messages");
        let store = Store::open(db.path(), b"pw").unwrap();
        store.insert_message(b"id-0000000000001", b"conv", false, 100, b"topsecret").unwrap();
        store.insert_message(b"id-0000000000002", b"conv", true, 200, b"reply").unwrap();

        let messages = store.list_messages(b"conv", 10, None).unwrap();
        assert_eq!(messages.len(), 2);
        // Порядок — от новых к старым.
        assert_eq!(messages[0].body, b"reply");
        assert!(messages[0].outgoing);
        assert_eq!(messages[1].body, b"topsecret");

        drop(store);
        let raw = std::fs::read(db.path()).unwrap();
        assert!(!raw.windows(9).any(|w| w == b"topsecret"), "текст не должен лежать в файле открыто");
    }

    /// «Сколько занято» должно считать журнал WAL.
    ///
    /// Без него свежая переписка не видна вовсе: SQLite держит новые записи в
    /// отдельном файле, и настройки показывали бы почти пустую базу.
    #[test]
    fn footprint_counts_the_write_ahead_log() {
        let db = TempDb::new("footprint");
        let store = Store::open(db.path(), b"pw").unwrap();
        store.insert_message(b"id-0000000000001", b"conv", false, 100, &vec![7u8; 40_000]).unwrap();

        let (conversations, messages) = store.counts().unwrap();
        assert_eq!(messages, 1);
        assert_eq!(conversations, 0, "беседа заводится отдельно от сообщения");

        let main_only = std::fs::metadata(db.path()).map(|m| m.len()).unwrap_or(0);
        assert!(
            store.footprint() > main_only,
            "журнал не учтён: {} против {}",
            store.footprint(),
            main_only,
        );
    }

    #[test]
    fn mls_snapshot_is_sealed_on_disk() {
        let db = TempDb::new("mlsstate");
        {
            let store = Store::open(db.path(), b"pw").unwrap();
            assert!(store.load_mls().unwrap().is_none());
            store.save_mls(b"public-key", b"epoch-secret-material").unwrap();

            let (public, snapshot) = store.load_mls().unwrap().unwrap();
            assert_eq!(public, b"public-key");
            assert_eq!(snapshot, b"epoch-secret-material");
        }
        let raw = std::fs::read(db.path()).unwrap();
        assert!(
            !raw.windows(21).any(|w| w == b"epoch-secret-material"),
            "секреты MLS не должны лежать в файле открыто"
        );
    }

    #[test]
    fn mls_snapshot_needs_the_right_password() {
        let db = TempDb::new("mlspw");
        {
            let store = Store::open(db.path(), b"right").unwrap();
            store.save_mls(b"public", b"secret").unwrap();
        }
        let store = Store::open(db.path(), b"wrong").unwrap();
        assert!(matches!(store.load_mls(), Err(CoreError::StoreLocked)));
    }

    #[test]
    fn conversation_maps_device_to_group() {
        let db = TempDb::new("conv");
        let store = Store::open(db.path(), b"pw").unwrap();

        assert!(store.conversation_with(b"device-a").unwrap().is_none());
        store.set_conversation(b"device-a", b"group-1").unwrap();
        assert_eq!(store.conversation_with(b"device-a").unwrap().unwrap(), b"group-1");

        // Переустановка беседы заменяет группу, а не плодит вторую строку.
        store.set_conversation(b"device-a", b"group-2").unwrap();
        assert_eq!(store.conversation_with(b"device-a").unwrap().unwrap(), b"group-2");

        // И обратный поиск.
        assert_eq!(store.peer_of_conversation(b"group-2").unwrap().unwrap(), b"device-a");
        assert!(store.peer_of_conversation(b"no-such-group").unwrap().is_none());
    }

    #[test]
    fn conversations_are_listed() {
        let db = TempDb::new("convlist");
        let store = Store::open(db.path(), b"pw").unwrap();

        assert!(store.list_conversations().unwrap().is_empty());
        store.set_conversation(b"device-b", b"group-b").unwrap();
        store.set_conversation(b"device-a", b"group-a").unwrap();

        let listed = store.list_conversations().unwrap();
        assert_eq!(listed.len(), 2);
        // Порядок стабилен: интерфейсу не должно казаться, что список скачет.
        assert_eq!(listed[0].0, b"device-a");
        assert_eq!(listed[1].0, b"device-b");
    }

    #[test]
    fn conversations_are_isolated() {
        let db = TempDb::new("isolation");
        let store = Store::open(db.path(), b"pw").unwrap();
        store.insert_message(b"aaaaaaaaaaaaaaaa", b"conv-a", false, 1, b"a").unwrap();
        store.insert_message(b"bbbbbbbbbbbbbbbb", b"conv-b", false, 1, b"b").unwrap();

        assert_eq!(store.list_messages(b"conv-a", 10, None).unwrap().len(), 1);
        assert_eq!(store.delete_conversation(b"conv-a").unwrap(), 1);
        assert_eq!(store.list_messages(b"conv-a", 10, None).unwrap().len(), 0);
        assert_eq!(store.list_messages(b"conv-b", 10, None).unwrap().len(), 1);
    }

    /// Постраничная выдача не должна ни терять сообщения, ни повторять их —
    /// даже когда несколько отправлены в одну миллисекунду.
    /// Настройки приватности называют конкретных людей: список исключений —
    /// это готовый контакт-лист. На диске его в открытом виде быть не должно.
    #[test]
    fn settings_are_sealed_on_disk() {
        let db = TempDb::new("settings");
        let store = Store::open(db.path(), b"pw").unwrap();

        let document = r#"{"voice":{"scope":"nobody","deny":["секретный-собеседник"]}}"#.as_bytes();
        store.save_setting("privacy", document).unwrap();

        assert_eq!(store.load_setting("privacy").unwrap().unwrap(), document);
        assert!(store.load_setting("незаданное").unwrap().is_none(), "отсутствие отличимо от пустоты");

        drop(store);
        let raw = std::fs::read(db.path()).unwrap();
        let needle = "секретный-собеседник".as_bytes();
        assert!(
            !raw.windows(needle.len()).any(|window| window == needle),
            "исключение найдено в файле открытым текстом",
        );
    }

    /// Чужим паролем настройки не читаются — они запечатаны тем же ключом,
    /// что и переписка.
    #[test]
    fn settings_need_the_right_password() {
        let db = TempDb::new("settings-pw");
        {
            let store = Store::open(db.path(), b"pw").unwrap();
            store.save_setting("privacy", b"{}").unwrap();
        }
        let intruder = Store::open(db.path(), "другой пароль".as_bytes());
        match intruder {
            Err(_) => {}
            Ok(store) => assert!(store.load_setting("privacy").is_err(), "чужой пароль прочитал настройки"),
        }
    }

    #[test]
    fn paging_survives_identical_timestamps() {
        let db = TempDb::new("paging");
        let store = Store::open(db.path(), b"pw").unwrap();

        for index in 0..10u8 {
            // Время одно на всех: различить их может только rowid.
            store.insert_message(&[index; 16], b"conv", false, 1_000, &[index]).unwrap();
        }

        let mut seen = Vec::new();
        let mut cursor = None;
        loop {
            let page = store.list_messages(b"conv", 3, cursor).unwrap();
            if page.is_empty() {
                break;
            }
            cursor = page.last().map(|m| (m.created_at, m.seq));
            seen.extend(page.into_iter().map(|m| m.body[0]));
        }

        seen.sort_unstable();
        assert_eq!(seen, (0..10u8).collect::<Vec<_>>(), "страницы потеряли или повторили записи");
    }
}
