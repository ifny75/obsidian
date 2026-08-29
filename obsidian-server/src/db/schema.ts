/**
 * Схема ровно из ARCHITECTURE.md §8.
 *
 * Чего здесь нет и не должно появиться: отправителя конверта, контакт-листов,
 * IP-адресов, любого plaintext. Добавление такого поля — блокер, а не фича.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  identity   BLOB PRIMARY KEY,
  handle     TEXT UNIQUE,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS devices (
  id         BLOB PRIMARY KEY,
  identity   BLOB NOT NULL REFERENCES users(identity) ON DELETE CASCADE,
  device_pub BLOB NOT NULL UNIQUE,
  cert       BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS devices_identity ON devices(identity);

-- Публичный профиль пользователя. Chat code заменяет неудобный 64-символьный
-- device key в интерфейсе, но разрешается сервером обратно в активное
-- устройство. Аватар намеренно ограничен и доступен только после AUTH.
CREATE TABLE IF NOT EXISTS profiles (
  identity    BLOB PRIMARY KEY REFERENCES users(identity) ON DELETE CASCADE,
  chat_code   TEXT NOT NULL UNIQUE,
  avatar_mime TEXT,
  avatar      BLOB,
  -- Значок и цвет — короткие метки из закрытого списка, не произвольный текст.
  -- Их видят собеседники, поэтому произвольную строку сюда пускать нельзя.
  emblem      TEXT,
  color       TEXT,
  updated_at  INTEGER NOT NULL
) WITHOUT ROWID;

-- Кого не пускать. Заводится только владельцем сервера и хранит ровно личность
-- и время: ни причины, ни переписки здесь нет и быть не может.
CREATE TABLE IF NOT EXISTS blocks (
  identity   BLOB PRIMARY KEY REFERENCES users(identity) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS profiles_chat_code ON profiles(chat_code);

-- Восстановление по логину и паролю. Сервер держит запечатанный identity-ключ,
-- но открыть его не может: ключ шифрования выводится из пароля на устройстве и
-- сюда не попадает.
--
-- verifier — хеш доказательства знания пароля. Без него любой, кто угадал бы
-- логин, скачал бы посылку и перебирал пароль офлайн; с ним каждая попытка
-- проходит через ограничитель частоты.
--
-- Чего здесь нет: логина в открытом виде и пароля в любом виде. Что здесь есть
-- и является осознанной платой за удобство: связь «личность ↔ хеш логина».
CREATE TABLE IF NOT EXISTS recoveries (
  login_id   BLOB PRIMARY KEY,
  identity   BLOB NOT NULL UNIQUE REFERENCES users(identity) ON DELETE CASCADE,
  verifier   BLOB NOT NULL,
  sealed     BLOB NOT NULL,
  -- Секрет одноразовых кодов, если человек их включил. Лежит открытым: иначе
  -- TOTP не работает — обе стороны считают код из одного секрета. Ключей от
  -- переписки здесь нет, посылку рядом по-прежнему открывает только пароль.
  totp_secret BLOB,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Кому разрешено писать. Политика хранится, пары «кто с кем» — нет.
CREATE TABLE IF NOT EXISTS access (
  identity   BLOB PRIMARY KEY REFERENCES users(identity) ON DELETE CASCADE,
  dm_policy  TEXT NOT NULL DEFAULT 'everyone',
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Пропуска: непрозрачные предъявительские секреты, которые владелец раздаёт
-- тем, кому разрешает себе писать.
--
-- Здесь лежит только ХЕШ пропуска и его владелец. Кому пропуск отдан, сервер не
-- знает и узнать не может: он видит предъявленный секрет ровно в момент
-- проверки и ничего о паре не сохраняет. Связь «отправитель → получатель» он и
-- так видит транзитно в каждом SEND, поэтому новых следов пропуска не создают.
CREATE TABLE IF NOT EXISTS passes (
  pass_hash  BLOB PRIMARY KEY,
  identity   BLOB NOT NULL REFERENCES users(identity) ON DELETE CASCADE,
  one_time   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS passes_identity ON passes(identity);
CREATE INDEX IF NOT EXISTS passes_expiry ON passes(expires_at);

-- Каталог юзернеймов: слой поиска, не замена криптографической личности.
--
-- Хранится ХЕШ имени, а не само имя. Поиск всё равно точный — по полному
-- юзернейму, — поэтому хеша достаточно, а утечка базы не отдаёт готовый
-- справочник «кто есть кто».
--
-- Хешей два, и это не дублирование, а переезд. name_hash — прежний SHA-256:
-- быстрый, а значит перебираемый по словарю за вечер на украденной копии.
-- name_hash2 — Argon2id с той же солью у всех: тот же перебор дорожает в
-- миллионы раз. Считает оба клиент; сервер имени не знает и пересчитать не
-- может, поэтому старые строки дозанимает сам владелец при первом заходе
-- обновлённым клиентом. Когда клиентов со старым хешем не останется,
-- name_hash можно убрать.
--
-- discoverable: 0 — не показывать в поиске совсем. Клиент может сузить круг и
-- на своей стороне, но «никому» обязан проверять сервер: иначе настройка
-- ничего не значит.
CREATE TABLE IF NOT EXISTS usernames (
  name_hash    BLOB PRIMARY KEY,
  name_hash2   BLOB,
  identity     BLOB NOT NULL UNIQUE REFERENCES users(identity) ON DELETE CASCADE,
  discoverable INTEGER NOT NULL DEFAULT 1,
  updated_at   INTEGER NOT NULL
) WITHOUT ROWID;

-- Каналы: открытая лента, которую ведёт один человек.
--
-- Здесь, в отличие от переписки, содержимое лежит В ОТКРЫТОМ ВИДЕ. Это
-- осознанный размен: канал по смыслу публичен, подписаться может кто угодно, и
-- шифровать вещание для неизвестного круга — самообман: ключ пришлось бы отдать
-- каждому подписчику, а значит и любому, кто им станет.
--
-- Из этого следует правило, которое нельзя нарушать в интерфейсе: канал обязан
-- быть подписан как открытый. Человек должен понимать, что пост в канале — не
-- то же самое, что сообщение в диалоге.
CREATE TABLE IF NOT EXISTS channels (
  id         BLOB PRIMARY KEY,
  owner      BLOB NOT NULL REFERENCES users(identity) ON DELETE CASCADE,
  handle     TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  about      TEXT,
  -- Значок канала лежит здесь открытым, как и его посты: канал публичный,
  -- прятать от сервера картинку, которую он же и раздаёт всем читателям,
  -- было бы притворством.
  icon_mime  TEXT,
  icon_base64 TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Кто, кроме владельца, пишет в канал.
--
-- Владельца здесь нет: он определяется channels.owner и правами не может быть
-- лишён. Строка в этой таблице — только «пишет», не «управляет»: сменить
-- название, значок и состав редакции может по-прежнему один владелец.
CREATE TABLE IF NOT EXISTS channel_admins (
  channel    BLOB NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  identity   BLOB NOT NULL REFERENCES users(identity) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (channel, identity)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS channel_admins_identity ON channel_admins(identity);

CREATE INDEX IF NOT EXISTS channels_owner ON channels(owner);

-- Порядок постов задаёт seq по той же причине, что и в очереди: время в
-- миллисекундах не различает две записи подряд.
CREATE TABLE IF NOT EXISTS channel_posts (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         BLOB NOT NULL UNIQUE,
  channel    BLOB NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at  INTEGER
);

CREATE INDEX IF NOT EXISTS channel_posts_feed ON channel_posts(channel, seq);

-- Подписка — единственное место, где сервер знает про связь человека с чем-то
-- ещё. Это не связка «кто с кем переписывается»: канал открыт, и его читатели
-- ничем не отличаются от читателей открытого сайта.
CREATE TABLE IF NOT EXISTS channel_subs (
  channel    BLOB NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  identity   BLOB NOT NULL REFERENCES users(identity) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (channel, identity)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS channel_subs_reader ON channel_subs(identity);

CREATE TABLE IF NOT EXISTS key_packages (
  id         BLOB PRIMARY KEY,
  device_pub BLOB NOT NULL REFERENCES devices(device_pub) ON DELETE CASCADE,
  data       BLOB NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS key_packages_device ON key_packages(device_pub);

-- Очередь, а не архив. Строка живёт до ACK либо до expires_at.
--
-- Порядок доставки задаёт seq, а не created_at: время в миллисекундах не
-- различает кадры, отправленные подряд, а для MLS порядок критичен —
-- приглашение обязано прийти раньше первого сообщения, иначе его нечем
-- расшифровать. AUTOINCREMENT нужен именно здесь: без него SQLite
-- переиспользует освободившиеся после ACK номера, и очередь перемешается.
CREATE TABLE IF NOT EXISTS envelopes (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  id               BLOB NOT NULL UNIQUE,
  recipient_device BLOB NOT NULL,
  payload          BLOB NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS envelopes_recipient ON envelopes(recipient_device, seq);
CREATE INDEX IF NOT EXISTS envelopes_expiry ON envelopes(expires_at);

-- Использованный инвайт удаляется, а не помечается: строка used_by связывала бы
-- код с личностью, а это ровно та метаданная, которой здесь быть не должно.
CREATE TABLE IF NOT EXISTS invites (
  code_hash  BLOB PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Счёт на оплату входа. Привязан к identity: memo виден в блокчейне всем, и без
-- привязки любой наблюдатель угнал бы оплаченный слот под свой ключ.
-- Строка удаляется в момент регистрации — связка «кошелёк ↔ личность» не живёт
-- дольше, чем нужно для проверки.
CREATE TABLE IF NOT EXISTS payments (
  ref         TEXT PRIMARY KEY,
  identity    BLOB NOT NULL,
  amount_nano TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  paid_at     INTEGER
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS payments_identity ON payments(identity);

-- Докуда просмотрен счёт получателя. lt — uint64, поэтому TEXT: в double он
-- теряет точность.
CREATE TABLE IF NOT EXISTS chain_cursor (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  last_lt    TEXT NOT NULL,
  last_hash  BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blobs (
  id         BLOB PRIMARY KEY,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS blobs_expiry ON blobs(expires_at);
`;
