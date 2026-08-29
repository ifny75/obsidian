import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA } from "./schema.ts";
import { SecretBox, isSealed } from "./secretbox.ts";
import { log } from "../log.ts";
import { constantTimeEqual, random } from "../util/bytes.ts";

export type Bytes = Uint8Array;

export interface DeviceRow {
  id: Bytes;
  identity: Bytes;
  device_pub: Bytes;
  cert: Bytes;
  created_at: number;
  last_seen: number;
}

export interface PaymentRow {
  ref: string;
  identity: Bytes;
  amount_nano: string;
  created_at: number;
  expires_at: number;
  paid_at: number | null;
}

export interface EnvelopeRow {
  id: Bytes;
  payload: Bytes;
  created_at: number;
}

export interface ChannelRow {
  id: Bytes;
  owner: Bytes;
  handle: string;
  title: string;
  about: string | null;
  icon_mime: string | null;
  icon_base64: string | null;
  created_at: number;
  updated_at: number;
}

export interface PostRow {
  seq: number;
  id: Bytes;
  channel: Bytes;
  body: string;
  created_at: number;
  edited_at: number | null;
}

export interface ProfileRow {
  identity: Bytes;
  chat_code: string;
  avatar_mime: string | null;
  avatar: Bytes | null;
  emblem: string | null;
  color: string | null;
  updated_at: number;
}

const CHAT_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Весь SQL живёт здесь. Наружу торчат только эти методы — переезд на Postgres
 * это замена одного файла, остальной сервер про СУБД не знает.
 */
export class Store {
  readonly #db: DatabaseSync;
  /** Ключ для столбцов, которые сервер обязан читать сам. См. secretbox.ts. */
  readonly #secrets: SecretBox;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#dropLegacyEnvelopes();
    this.#db.exec(SCHEMA);
    this.#addProfileDecoration();
    this.#addChannelIcon();
    this.#addRecoveryTotp();
    this.#addUsernameHash2();
    this.#secrets = SecretBox.load(path);
    this.#sealStoredTotpSecrets();
  }

  close(): void {
    this.#db.close();
  }

  /**
   * Ранняя схема упорядочивала очередь по created_at и не имела seq.
   * `CREATE TABLE IF NOT EXISTS` такую таблицу не починит, поэтому она
   * сносится: envelopes — транзитная очередь с TTL, а не архив, и потерять
   * недоставленное при обновлении дешевле, чем оставить сервер со сломанным
   * порядком доставки.
   */
  #dropLegacyEnvelopes(): void {
    const columns = this.#db.prepare("PRAGMA table_info(envelopes)").all() as unknown as {
      name: string;
    }[];
    if (columns.length > 0 && !columns.some((column) => column.name === "seq")) {
      this.#db.exec("DROP TABLE envelopes");
    }
  }

  /**
   * Значок и цвет появились позже таблицы профилей.
   *
   * `CREATE TABLE IF NOT EXISTS` существующую таблицу не трогает, поэтому
   * столбцы добавляются отдельно — и только если их ещё нет. Сносить таблицу
   * нельзя: в ней коды чатов, по которым людей находят.
   */
  #addProfileDecoration(): void {
    const columns = this.#db.prepare("PRAGMA table_info(profiles)").all() as unknown as {
      name: string;
    }[];
    if (columns.length === 0) return;
    const has = (name: string) => columns.some((column) => column.name === name);
    if (!has("emblem")) this.#db.exec("ALTER TABLE profiles ADD COLUMN emblem TEXT");
    if (!has("color")) this.#db.exec("ALTER TABLE profiles ADD COLUMN color TEXT");
  }

  /**
   * Значок канала появился позже таблицы каналов — по той же причине, что и
   * значок профиля: столбцы добавляются отдельно, таблицу сносить нельзя,
   * в ней имена каналов, по которым на них ссылаются.
   */
  #addRecoveryTotp(): void {
    const columns = this.#db.prepare("PRAGMA table_info(recoveries)").all() as unknown as {
      name: string;
    }[];
    if (columns.length === 0) return;
    if (!columns.some((column) => column.name === "totp_secret")) {
      this.#db.exec("ALTER TABLE recoveries ADD COLUMN totp_secret BLOB");
    }
  }

  /**
   * Второй хеш имени появился позже таблицы. Заполнять его здесь нечем: имени
   * сервер не знает, и пересчитать хеш может только владелец.
   */
  #addUsernameHash2(): void {
    const columns = this.#db.prepare("PRAGMA table_info(usernames)").all() as unknown as {
      name: string;
    }[];
    if (columns.length === 0) return;
    if (!columns.some((column) => column.name === "name_hash2")) {
      this.#db.exec("ALTER TABLE usernames ADD COLUMN name_hash2 BLOB");
    }
    // Индекс создаётся здесь, а не в SCHEMA, и это не вкусовщина: SCHEMA
    // выполняется раньше этой миграции, а `CREATE TABLE IF NOT EXISTS` на
    // существующей базе столбец не добавляет — индекс по нему падал бы на
    // каждом запуске сервера, у которого уже есть данные.
    this.#db.exec("CREATE INDEX IF NOT EXISTS usernames_hash2 ON usernames(name_hash2)");
  }

  #addChannelIcon(): void {
    const columns = this.#db.prepare("PRAGMA table_info(channels)").all() as unknown as {
      name: string;
    }[];
    if (columns.length === 0) return;
    const has = (name: string) => columns.some((column) => column.name === name);
    if (!has("icon_mime")) this.#db.exec("ALTER TABLE channels ADD COLUMN icon_mime TEXT");
    if (!has("icon_base64")) this.#db.exec("ALTER TABLE channels ADD COLUMN icon_base64 TEXT");
  }

  /**
   * Переезд старых баз: секреты вторых факторов лежали открытыми.
   *
   * Делается один раз при запуске и по строкам, а не одним UPDATE: каждую надо
   * сначала распознать. Уже закрытые пропускаются, поэтому повторный запуск
   * ничего не портит.
   */
  #sealStoredTotpSecrets(): void {
    const rows = this.#db
      .prepare("SELECT login_id, totp_secret FROM recoveries WHERE totp_secret IS NOT NULL")
      .all() as unknown as { login_id: Bytes; totp_secret: Bytes }[];
    let sealed = 0;
    for (const row of rows) {
      if (isSealed(row.totp_secret)) continue;
      this.#db
        .prepare("UPDATE recoveries SET totp_secret = ? WHERE login_id = ?")
        .run(this.#secrets.seal(row.totp_secret), row.login_id);
      sealed += 1;
    }
    if (sealed > 0) log.info(`totp secrets sealed: ${sealed}`);
  }

  // --- пользователи и устройства -------------------------------------------

  userExists(identity: Bytes): boolean {
    return this.#db.prepare("SELECT 1 FROM users WHERE identity = ?").get(identity) !== undefined;
  }

  handleTaken(handle: string): boolean {
    return this.#db.prepare("SELECT 1 FROM users WHERE handle = ?").get(handle) !== undefined;
  }

  createUser(identity: Bytes, handle: string | null, now: number): void {
    this.#db
      .prepare("INSERT INTO users (identity, handle, created_at) VALUES (?, ?, ?)")
      .run(identity, handle, now);
  }

  getDevice(devicePub: Bytes): DeviceRow | undefined {
    return this.#db.prepare("SELECT * FROM devices WHERE device_pub = ?").get(devicePub) as
      | DeviceRow
      | undefined;
  }

  createDevice(identity: Bytes, devicePub: Bytes, cert: Bytes, now: number): Bytes {
    const id = random(16);
    this.#db
      .prepare(
        `INSERT INTO devices (id, identity, device_pub, cert, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, identity, devicePub, cert, now, now);
    return id;
  }

  touchDevice(devicePub: Bytes, now: number): void {
    this.#db.prepare("UPDATE devices SET last_seen = ? WHERE device_pub = ?").run(now, devicePub);
  }

  /** Каталог: отправитель обязан сам проверить cert, сервер здесь только кэш. */
  listDevices(identity: Bytes): DeviceRow[] {
    return this.#db
      .prepare("SELECT * FROM devices WHERE identity = ? ORDER BY created_at")
      .all(identity) as unknown as DeviceRow[];
  }

  getUserHandle(identity: Bytes): string | null {
    const row = this.#db.prepare("SELECT handle FROM users WHERE identity = ?").get(identity) as
      | { handle: string | null }
      | undefined;
    return row?.handle ?? null;
  }

  resolveHandle(handle: string): Bytes | undefined {
    const row = this.#db.prepare("SELECT identity FROM users WHERE handle = ?").get(handle) as
      | { identity: Bytes }
      | undefined;
    return row?.identity;
  }

  ensureProfile(identity: Bytes, now: number): ProfileRow {
    const existing = this.getProfile(identity);
    if (existing) return existing;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const bytes = random(10);
      let raw = "";
      for (const byte of bytes) raw += CHAT_ALPHABET[byte! % CHAT_ALPHABET.length];
      const chatCode = `OBS-${raw.slice(0, 5)}-${raw.slice(5)}`;
      try {
        this.#db
          .prepare("INSERT INTO profiles (identity, chat_code, updated_at) VALUES (?, ?, ?)")
          .run(identity, chatCode, now);
        return this.getProfile(identity)!;
      } catch (error) {
        if (!String(error).includes("UNIQUE constraint failed: profiles.chat_code")) throw error;
      }
    }
    throw new Error("cannot allocate chat code");
  }

  getProfile(identity: Bytes): ProfileRow | undefined {
    return this.#db.prepare("SELECT * FROM profiles WHERE identity = ?").get(identity) as
      | ProfileRow
      | undefined;
  }

  profileByChatCode(chatCode: string): ProfileRow | undefined {
    return this.#db.prepare("SELECT * FROM profiles WHERE chat_code = ?").get(chatCode) as
      | ProfileRow
      | undefined;
  }

  profileByDevice(devicePub: Bytes): ProfileRow | undefined {
    return this.#db
      .prepare(
        `SELECT p.* FROM profiles p
         JOIN devices d ON d.identity = p.identity
         WHERE d.device_pub = ?`,
      )
      .get(devicePub) as ProfileRow | undefined;
  }

  activeDevice(identity: Bytes): Bytes | undefined {
    const row = this.#db
      .prepare(
        `SELECT device_pub FROM devices WHERE identity = ?
         ORDER BY last_seen DESC, created_at DESC LIMIT 1`,
      )
      .get(identity) as { device_pub: Bytes } | undefined;
    return row?.device_pub;
  }

  updateAvatar(identity: Bytes, mime: string | null, avatar: Bytes | null, now: number): ProfileRow {
    this.ensureProfile(identity, now);
    this.#db
      .prepare(
        `UPDATE profiles SET avatar_mime = ?, avatar = ?, updated_at = ?
         WHERE identity = ?`,
      )
      .run(mime, avatar, now, identity);
    return this.getProfile(identity)!;
  }

  /** Значок и цвет. `null` в поле означает «убрать». */
  updateDecoration(identity: Bytes, emblem: string | null, color: string | null,
    now: number): ProfileRow {
    this.ensureProfile(identity, now);
    this.#db
      .prepare("UPDATE profiles SET emblem = ?, color = ?, updated_at = ? WHERE identity = ?")
      .run(emblem, color, now, identity);
    return this.getProfile(identity)!;
  }

  // --- каналы ----------------------------------------------------------------

  /** Заводит канал. `undefined` — короткое имя уже занято. */
  createChannel(id: Bytes, owner: Bytes, handle: string, title: string, about: string | null,
    now: number): ChannelRow | undefined {
    try {
      this.#db
        .prepare(
          `INSERT INTO channels (id, owner, handle, title, about, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, owner, handle, title, about, now, now);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return undefined;
      throw error;
    }
    // Владелец читает свой канал по умолчанию: иначе он не увидит его в списке.
    this.subscribeChannel(id, owner, now);
    return this.channelById(id);
  }

  channelById(id: Bytes): ChannelRow | undefined {
    return this.#db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as
      ChannelRow | undefined;
  }

  channelByHandle(handle: string): ChannelRow | undefined {
    return this.#db.prepare("SELECT * FROM channels WHERE handle = ?").get(handle.toLowerCase()) as
      ChannelRow | undefined;
  }

  /** Каналы, которые человек ведёт или читает. */
  /**
   * Сколько у канала подписчиков и постов.
   *
   * Числа, а не списки: сколько людей читает открытую ленту — сведение о ленте,
   * а кто именно — связь между людьми, и её сервер не рассказывает.
   */
  channelCounts(channel: Bytes): { subscribers: number; posts: number } {
    const row = this.#db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM channel_subs  s WHERE s.channel = ?1) AS subscribers,
                (SELECT COUNT(*) FROM channel_posts p WHERE p.channel = ?1) AS posts`,
      )
      .get(channel) as { subscribers: number; posts: number };
    return row;
  }

  /** Сколько каналов завёл этот человек — своих, не считая подписок. */
  countOwnedChannels(owner: Bytes): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM channels WHERE owner = ?")
      .get(owner) as { n: number };
    return row.n;
  }

  channelsFor(identity: Bytes): (ChannelRow & { subscribers: number; posts: number })[] {
    return this.#db
      .prepare(
        `SELECT c.*,
                (SELECT COUNT(*) FROM channel_subs s WHERE s.channel = c.id)  AS subscribers,
                (SELECT COUNT(*) FROM channel_posts p WHERE p.channel = c.id) AS posts
         FROM channels c
         WHERE c.owner = ?
            OR EXISTS (SELECT 1 FROM channel_subs s WHERE s.channel = c.id AND s.identity = ?)
         ORDER BY c.updated_at DESC`,
      )
      .all(identity, identity) as never;
  }

  /**
   * Меняет название, описание и значок канала.
   *
   * Каждое поле необязательно: интерфейс шлёт только то, что человек тронул.
   * `icon: null` — это «снять значок», а отсутствие поля — «не трогать»; без
   * этого различия значок нельзя было бы убрать, только заменить.
   */
  updateChannel(id: Bytes, patch: {
    title?: string;
    about?: string | null;
    icon?: { mime: string; base64: string } | null;
  }, now: number): void {
    const sets: string[] = [];
    const values: (string | null | number)[] = [];
    if (patch.title !== undefined) { sets.push("title = ?"); values.push(patch.title); }
    if (patch.about !== undefined) { sets.push("about = ?"); values.push(patch.about); }
    if (patch.icon !== undefined) {
      sets.push("icon_mime = ?", "icon_base64 = ?");
      values.push(patch.icon?.mime ?? null, patch.icon?.base64 ?? null);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(now, id as never);
    this.#db.prepare(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`).run(...values as never[]);
  }

  /** Кто пишет в канал, кроме владельца. */
  channelAdmins(channel: Bytes): Bytes[] {
    return (this.#db
      .prepare("SELECT identity FROM channel_admins WHERE channel = ? ORDER BY created_at")
      .all(channel) as { identity: Bytes }[]).map((row) => row.identity);
  }

  isChannelAdmin(channel: Bytes, identity: Bytes): boolean {
    return this.#db
      .prepare("SELECT 1 FROM channel_admins WHERE channel = ? AND identity = ?")
      .get(channel, identity) !== undefined;
  }

  addChannelAdmin(channel: Bytes, identity: Bytes, now: number): void {
    this.#db
      .prepare("INSERT OR IGNORE INTO channel_admins (channel, identity, created_at) VALUES (?, ?, ?)")
      .run(channel, identity, now);
    // Пишущий обязан и читать: иначе он не увидит канал у себя в списке.
    this.subscribeChannel(channel, identity, now);
  }

  removeChannelAdmin(channel: Bytes, identity: Bytes): void {
    this.#db.prepare("DELETE FROM channel_admins WHERE channel = ? AND identity = ?")
      .run(channel, identity);
  }

  subscribeChannel(channel: Bytes, identity: Bytes, now: number): void {
    this.#db
      .prepare("INSERT OR IGNORE INTO channel_subs (channel, identity, created_at) VALUES (?, ?, ?)")
      .run(channel, identity, now);
  }

  unsubscribeChannel(channel: Bytes, identity: Bytes): void {
    this.#db.prepare("DELETE FROM channel_subs WHERE channel = ? AND identity = ?")
      .run(channel, identity);
  }

  isSubscribed(channel: Bytes, identity: Bytes): boolean {
    return this.#db
      .prepare("SELECT 1 FROM channel_subs WHERE channel = ? AND identity = ?")
      .get(channel, identity) !== undefined;
  }

  /** Устройства читателей: им уходит весть о новом посте. */
  /**
   * Устройства подписчиков канала.
   *
   * `except` убирает из выборки одну личность — того, кто сам вызвал команду:
   * ему уходит собственный ответ, и получить рядом с ним ещё и рассылку
   * значило бы два разных кадра с одним опкодом подряд.
   */
  channelReaderDevices(channel: Bytes, except?: Bytes): Bytes[] {
    return (this.#db
      .prepare(
        `SELECT d.device_pub FROM channel_subs s
         JOIN devices d ON d.identity = s.identity
         WHERE s.channel = ? AND (?2 IS NULL OR s.identity != ?2)`,
      )
      .all(channel, except ?? null) as { device_pub: Bytes }[]).map((row) => row.device_pub);
  }

  addPost(id: Bytes, channel: Bytes, body: string, now: number): PostRow {
    this.#db
      .prepare("INSERT INTO channel_posts (id, channel, body, created_at) VALUES (?, ?, ?, ?)")
      .run(id, channel, body, now);
    this.#db.prepare("UPDATE channels SET updated_at = ? WHERE id = ?").run(now, channel);
    return this.#db.prepare("SELECT * FROM channel_posts WHERE id = ?").get(id) as never as PostRow;
  }

  deletePost(id: Bytes, channel: Bytes): boolean {
    const result = this.#db
      .prepare("DELETE FROM channel_posts WHERE id = ? AND channel = ?")
      .run(id, channel);
    return Number(result.changes) > 0;
  }

  /** Лента страницами: `before` — seq, с которого идти вглубь. */
  posts(channel: Bytes, limit: number, before: number | null): PostRow[] {
    return this.#db
      .prepare(
        `SELECT * FROM channel_posts
         WHERE channel = ? AND (? IS NULL OR seq < ?)
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(channel, before, before, limit) as never as PostRow[];
  }

  // --- владелец сервера ------------------------------------------------------

  isBlocked(identity: Bytes): boolean {
    return this.#db.prepare("SELECT 1 FROM blocks WHERE identity = ?").get(identity) !== undefined;
  }

  block(identity: Bytes, now: number): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO blocks (identity, created_at) VALUES (?, ?)")
      .run(identity, now);
  }

  unblock(identity: Bytes): void {
    this.#db.prepare("DELETE FROM blocks WHERE identity = ?").run(identity);
  }

  /**
   * Счётчики для панели владельца.
   *
   * Здесь намеренно только количества. Ни кто с кем переписывается, ни кто
   * сейчас на связи — сервер этого не хранит, и панель не должна создавать
   * впечатление, будто хранит.
   */
  adminCounts(now: number): Record<string, number> {
    const one = (sql: string, ...args: unknown[]) =>
      Number((this.#db.prepare(sql).get(...args as never[]) as { n: number }).n);
    return {
      users: one("SELECT COUNT(*) AS n FROM users"),
      devices: one("SELECT COUNT(*) AS n FROM devices"),
      profiles: one("SELECT COUNT(*) AS n FROM profiles"),
      usernames: one("SELECT COUNT(*) AS n FROM usernames"),
      recoveries: one("SELECT COUNT(*) AS n FROM recoveries"),
      blocked: one("SELECT COUNT(*) AS n FROM blocks"),
      queued: one("SELECT COUNT(*) AS n FROM envelopes WHERE expires_at > ?", now),
      seenDay: one("SELECT COUNT(*) AS n FROM devices WHERE last_seen > ?", now - 86_400_000),
      channels: one("SELECT COUNT(*) AS n FROM channels"),
      posts: one("SELECT COUNT(*) AS n FROM channel_posts"),
    };
  }

  /**
   * Список аккаунтов для панели владельца.
   *
   * Здесь ровно то, что сервер и так хранит: личность, код чата, число
   * устройств, когда последний раз заходили, и не закрыт ли вход. Юзернейма в
   * списке нет и быть не может — каталог хранит только хеши имён, и показать
   * имя сервер не в состоянии, даже если бы захотел.
   *
   * Прав это никому не добавляет: у владельца и так есть файл базы. Панель
   * лишь избавляет от необходимости лезть в неё руками.
   */
  adminUsers(limit: number, offset: number): {
    identity: Bytes; chat_code: string | null; devices: number;
    last_seen: number | null; created_at: number; blocked: number; has_username: number;
  }[] {
    return this.#db
      .prepare(
        `SELECT u.identity,
                p.chat_code                              AS chat_code,
                (SELECT COUNT(*) FROM devices d WHERE d.identity = u.identity)   AS devices,
                (SELECT MAX(d.last_seen) FROM devices d WHERE d.identity = u.identity) AS last_seen,
                u.created_at                             AS created_at,
                (SELECT COUNT(*) FROM blocks b WHERE b.identity = u.identity)    AS blocked,
                (SELECT COUNT(*) FROM usernames n WHERE n.identity = u.identity) AS has_username
         FROM users u
         LEFT JOIN profiles p ON p.identity = u.identity
         ORDER BY last_seen DESC NULLS LAST, u.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as never;
  }

  /**
   * Убирает канал целиком.
   *
   * Посты и подписки уходят следом по внешнему ключу: канала больше нет, и
   * держать его ленту незачем.
   */
  deleteChannel(id: Bytes): void {
    this.#db.prepare("DELETE FROM channels WHERE id = ?").run(id);
  }

  /** Личность по коду чата или по адресу устройства: чем владелец её и назовёт. */
  identityByReference(reference: string): Bytes | undefined {
    const chat = this.#db
      .prepare("SELECT identity FROM profiles WHERE chat_code = ?")
      .get(reference.toUpperCase()) as { identity: Bytes } | undefined;
    if (chat) return chat.identity;
    if (!/^[0-9a-f]{64}$/i.test(reference)) return undefined;
    const raw = Buffer.from(reference.toLowerCase(), "hex");
    const byIdentity = this.#db
      .prepare("SELECT identity FROM users WHERE identity = ?")
      .get(raw) as { identity: Bytes } | undefined;
    if (byIdentity) return byIdentity.identity;
    const byDevice = this.#db
      .prepare("SELECT identity FROM devices WHERE device_pub = ?")
      .get(raw) as { identity: Bytes } | undefined;
    return byDevice?.identity;
  }

  // --- восстановление по логину и паролю ------------------------------------

  /**
   * Кладёт или заменяет посылку.
   *
   * Возвращает false, если логин занят другой личностью. Это не косметика:
   * без проверки любой зарегистрированный пользователь мог бы угадать чужой
   * логин и затереть чужую строку, лишив человека способа восстановиться.
   */
  setRecovery(
    loginId: Bytes,
    identity: Bytes,
    verifier: Bytes,
    sealed: Bytes,
    now: number,
    totpSecret: Bytes | null = null,
  ): boolean {
    return this.#tx(() => {
      const owner = this.#db
        .prepare("SELECT identity FROM recoveries WHERE login_id = ?")
        .get(loginId) as { identity: Bytes } | undefined;
      if (owner !== undefined && !constantTimeEqual(owner.identity, identity)) return false;

      // Логин мог смениться: старая строка этой личности больше не нужна.
      this.#db.prepare("DELETE FROM recoveries WHERE identity = ?").run(identity);
      this.#db
        .prepare(
          `INSERT INTO recoveries (login_id, identity, verifier, sealed, totp_secret, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          loginId,
          identity,
          verifier,
          sealed,
          totpSecret === null ? null : this.#secrets.seal(totpSecret),
          now,
        );
      return true;
    });
  }

  getRecovery(loginId: Bytes): { verifier: Bytes; sealed: Bytes; totp_secret: Bytes | null }
    | undefined {
    const row = this.#db
      .prepare("SELECT verifier, sealed, totp_secret FROM recoveries WHERE login_id = ?")
      .get(loginId) as { verifier: Bytes; sealed: Bytes; totp_secret: Bytes | null } | undefined;
    if (row === undefined || row.totp_secret === null) return row;

    const opened = this.#secrets.open(row.totp_secret);
    if (opened === null) {
      // Ключ не подошёл. Второй фактор остаётся требуемым и заведомо
      // непроходимым: пропустить человека мимо него было бы хуже, чем не
      // пустить вовсе. В журнале это должно быть видно сразу.
      log.error("totp secret unreadable: wrong or missing secret.key");
      return row;
    }
    return { ...row, totp_secret: opened };
  }

  /** Есть ли у этой личности второй фактор. Нужно, чтобы показать состояние. */
  recoveryTotpEnabled(identity: Bytes): boolean {
    const row = this.#db
      .prepare("SELECT totp_secret FROM recoveries WHERE identity = ?")
      .get(identity) as { totp_secret: Bytes | null } | undefined;
    return row?.totp_secret != null;
  }

  deleteRecovery(identity: Bytes): void {
    this.#db.prepare("DELETE FROM recoveries WHERE identity = ?").run(identity);
  }

  hasRecovery(identity: Bytes): boolean {
    return this.#db.prepare("SELECT 1 FROM recoveries WHERE identity = ?").get(identity) !== undefined;
  }

  // --- кому можно писать ----------------------------------------------------

  /** `everyone` по умолчанию: закрытый мессенджер не запирают дважды. */
  dmPolicy(identity: Bytes): string {
    const row = this.#db
      .prepare("SELECT dm_policy FROM access WHERE identity = ?")
      .get(identity) as { dm_policy: string } | undefined;
    return row?.dm_policy ?? "everyone";
  }

  setDmPolicy(identity: Bytes, policy: string, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO access (identity, dm_policy, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(identity) DO UPDATE SET dm_policy = excluded.dm_policy,
                                             updated_at = excluded.updated_at`,
      )
      .run(identity, policy, now);
  }

  addPass(passHash: Bytes, identity: Bytes, oneTime: boolean, now: number, expiresAt: number): void {
    this.#db
      .prepare(
        `INSERT INTO passes (pass_hash, identity, one_time, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pass_hash) DO UPDATE SET expires_at = excluded.expires_at`,
      )
      .run(passHash, identity, oneTime ? 1 : 0, now, expiresAt);
  }

  /**
   * Владелец пропуска, если он ещё действует. Одноразовый при этом гасится.
   *
   * Возвращается именно личность, а не признак «годен»: проверять надо, что
   * пропуск выписан тем самым получателем, а не кем угодно.
   */
  redeemPass(passHash: Bytes, now: number): Bytes | undefined {
    return this.#tx(() => {
      const row = this.#db
        .prepare("SELECT identity, one_time, expires_at FROM passes WHERE pass_hash = ?")
        .get(passHash) as { identity: Bytes; one_time: number; expires_at: number } | undefined;
      if (!row || row.expires_at <= now) return undefined;
      if (row.one_time === 1) {
        this.#db.prepare("DELETE FROM passes WHERE pass_hash = ?").run(passHash);
      }
      return row.identity;
    });
  }

  revokePass(passHash: Bytes, identity: Bytes): boolean {
    const changes = this.#db
      .prepare("DELETE FROM passes WHERE pass_hash = ? AND identity = ?")
      .run(passHash, identity).changes;
    return Number(changes) > 0;
  }

  countPasses(identity: Bytes): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM passes WHERE identity = ?")
      .get(identity) as { n: number };
    return Number(row.n);
  }

  // --- юзернеймы ------------------------------------------------------------

  /**
   * Занимает или переносит юзернейм.
   *
   * false — имя занято другой личностью. Перенос своего же имени на себя
   * разрешён: так работает смена настройки видимости без освобождения имени.
   */
  claimUsername(
    nameHash: Bytes,
    nameHash2: Bytes | null,
    identity: Bytes,
    discoverable: boolean,
    now: number,
  ): boolean {
    return this.#tx(() => {
      const owner = this.#db
        .prepare("SELECT identity FROM usernames WHERE name_hash = ?")
        .get(nameHash) as { identity: Bytes } | undefined;
      if (owner !== undefined && !constantTimeEqual(owner.identity, identity)) return false;

      // Прошлое имя этой личности освобождается: один человек — один юзернейм.
      this.#db.prepare("DELETE FROM usernames WHERE identity = ?").run(identity);
      this.#db
        .prepare(
          `INSERT INTO usernames (name_hash, name_hash2, identity, discoverable, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(nameHash, nameHash2, identity, discoverable ? 1 : 0, now);
      return true;
    });
  }

  releaseUsername(identity: Bytes): void {
    this.#db.prepare("DELETE FROM usernames WHERE identity = ?").run(identity);
  }

  /**
   * Личность по хешу имени. `undefined` и «скрыт» неотличимы снаружи.
   *
   * Сначала по дорогому хешу, потом по прежнему: первый есть у тех, кто уже
   * перезанял имя обновлённым клиентом, второй — у всех остальных. Порядок
   * важен только для скорости; найденная строка в обоих случаях одна и та же.
   */
  findByUsername(nameHash: Bytes, nameHash2: Bytes | null): Bytes | undefined {
    if (nameHash2 !== null) {
      const strong = this.#db
        .prepare("SELECT identity FROM usernames WHERE name_hash2 = ? AND discoverable = 1")
        .get(nameHash2) as { identity: Bytes } | undefined;
      if (strong !== undefined) return strong.identity;
    }
    const row = this.#db
      .prepare("SELECT identity FROM usernames WHERE name_hash = ? AND discoverable = 1")
      .get(nameHash) as { identity: Bytes } | undefined;
    return row?.identity;
  }

  hasUsername(identity: Bytes): boolean {
    return this.#db.prepare("SELECT 1 FROM usernames WHERE identity = ?").get(identity) !== undefined;
  }

  // --- MLS KeyPackages ------------------------------------------------------

  /**
   * Кладёт пакеты и удерживает потолок, вытесняя самые старые.
   *
   * Вытеснение, а не отказ: пакет одноразовый, свежий полезнее залежавшегося, а
   * отказ на переполнении однажды уже стоил постоянного обрыва связи.
   */
  addKeyPackages(devicePub: Bytes, packages: Bytes[], now: number, limit: number): void {
    const insert = this.#db.prepare(
      "INSERT INTO key_packages (id, device_pub, data, created_at) VALUES (?, ?, ?, ?)",
    );
    this.#tx(() => {
      for (const data of packages) insert.run(random(16), devicePub, data, now);
      this.#db
        .prepare(
          `DELETE FROM key_packages WHERE id IN (
             SELECT id FROM key_packages WHERE device_pub = ?
             ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?
           )`,
        )
        .run(devicePub, limit);
    });
  }

  countKeyPackages(devicePub: Bytes): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM key_packages WHERE device_pub = ?")
      .get(devicePub) as { n: number };
    return row.n;
  }

  /** Выдаётся один раз и сразу удаляется — переиспользование ломает FS в MLS. */
  claimKeyPackage(devicePub: Bytes): Bytes | undefined {
    return this.#tx(() => {
      const row = this.#db
        .prepare("SELECT id, data FROM key_packages WHERE device_pub = ? ORDER BY created_at LIMIT 1")
        .get(devicePub) as { id: Bytes; data: Bytes } | undefined;
      if (!row) return undefined;
      this.#db.prepare("DELETE FROM key_packages WHERE id = ?").run(row.id);
      return row.data;
    });
  }

  // --- очередь конвертов ----------------------------------------------------

  enqueue(recipientDevice: Bytes, payload: Bytes, now: number, expiresAt: number): Bytes {
    const id = random(16);
    this.#db
      .prepare(
        `INSERT INTO envelopes (id, recipient_device, payload, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, recipientDevice, payload, now, expiresAt);
    return id;
  }

  /**
   * Сколько конвертов ждёт это устройство.
   *
   * Очередь — единственное место, где чужой отправитель занимает наш диск, и
   * занимает его до ACK либо до истечения TTL. Без потолка один аккаунт топит
   * выбранного человека: разгребать очередь тот будет дольше, чем её наливали.
   */
  countQueued(recipientDevice: Bytes, now: number): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM envelopes WHERE recipient_device = ? AND expires_at > ?")
      .get(recipientDevice, now) as { n: number };
    return row.n;
  }

  /** Строго в порядке постановки: seq монотонен, created_at — нет. */
  pending(recipientDevice: Bytes, now: number, limit: number): EnvelopeRow[] {
    return this.#db
      .prepare(
        `SELECT id, payload, created_at FROM envelopes
         WHERE recipient_device = ? AND expires_at > ?
         ORDER BY seq LIMIT ?`,
      )
      .all(recipientDevice, now, limit) as unknown as EnvelopeRow[];
  }

  countPending(recipientDevice: Bytes, now: number): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM envelopes WHERE recipient_device = ? AND expires_at > ?")
      .get(recipientDevice, now) as { n: number };
    return row.n;
  }

  /** Физический DELETE. Флага deleted нет: «удалено» значит удалено. */
  ack(id: Bytes, recipientDevice: Bytes): boolean {
    const res = this.#db
      .prepare("DELETE FROM envelopes WHERE id = ? AND recipient_device = ?")
      .run(id, recipientDevice);
    return res.changes > 0;
  }

  // --- инвайты --------------------------------------------------------------

  createInvite(codeHash: Bytes, now: number, expiresAt: number): void {
    this.#db
      .prepare("INSERT INTO invites (code_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .run(codeHash, now, expiresAt);
  }

  /**
   * Одноразовость обеспечивает сам DELETE: строки больше нет — значит, код
   * использован. Кто именно им воспользовался, не записывается никуда.
   */
  consumeInvite(codeHash: Bytes, now: number): boolean {
    const res = this.#db
      .prepare("DELETE FROM invites WHERE code_hash = ? AND expires_at > ?")
      .run(codeHash, now);
    return res.changes > 0;
  }

  /**
   * Отзыв: удаляет код независимо от срока. Нужен, когда инвайт куда-то утёк
   * до использования — ждать TTL в такой ситуации нечего.
   */
  revokeInvite(codeHash: Bytes): boolean {
    return this.#db.prepare("DELETE FROM invites WHERE code_hash = ?").run(codeHash).changes > 0;
  }

  /** Сколько живых кодов выпущено. Содержимое не отдаётся — его и нет. */
  countInvites(now: number): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM invites WHERE expires_at > ?")
      .get(now) as { n: number };
    return row.n;
  }

  // --- платный вход ---------------------------------------------------------

  createPayment(ref: string, identity: Bytes, amountNano: bigint, now: number, expiresAt: number): void {
    this.#db
      .prepare(
        `INSERT INTO payments (ref, identity, amount_nano, created_at, expires_at, paid_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(ref, identity, amountNano.toString(), now, expiresAt);
  }

  /** Незачем плодить счета: пока живёт прошлый, отдаём его же. */
  pendingPayment(identity: Bytes, now: number): PaymentRow | undefined {
    return this.#db
      .prepare(
        `SELECT * FROM payments WHERE identity = ? AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(identity, now) as PaymentRow | undefined;
  }

  getPayment(ref: string): PaymentRow | undefined {
    return this.#db.prepare("SELECT * FROM payments WHERE ref = ?").get(ref) as PaymentRow | undefined;
  }

  /** Идемпотентно: повторное зачисление той же транзакции ничего не меняет. */
  markPaid(ref: string, now: number): boolean {
    const res = this.#db
      .prepare("UPDATE payments SET paid_at = ? WHERE ref = ? AND paid_at IS NULL")
      .run(now, ref);
    return res.changes > 0;
  }

  /**
   * Счёт погашается только своей личностью и только оплаченный. Строка при этом
   * исчезает — связка «оплата ↔ личность» не переживает регистрацию.
   */
  consumePayment(ref: string, identity: Bytes, now: number): boolean {
    const res = this.#db
      .prepare(
        `DELETE FROM payments
         WHERE ref = ? AND identity = ? AND paid_at IS NOT NULL AND expires_at > ?`,
      )
      .run(ref, identity, now);
    return res.changes > 0;
  }

  // --- курсор по блокчейну ---------------------------------------------------

  getCursor(): { last_lt: string; last_hash: Bytes } | undefined {
    return this.#db.prepare("SELECT last_lt, last_hash FROM chain_cursor WHERE id = 1").get() as
      | { last_lt: string; last_hash: Bytes }
      | undefined;
  }

  setCursor(lastLt: string, lastHash: Bytes, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO chain_cursor (id, last_lt, last_hash, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_lt = excluded.last_lt,
                                       last_hash = excluded.last_hash,
                                       updated_at = excluded.updated_at`,
      )
      .run(lastLt, lastHash, now);
  }

  // --- блобы ----------------------------------------------------------------

  addBlob(id: Bytes, size: number, now: number, expiresAt: number): void {
    this.#db
      .prepare("INSERT INTO blobs (id, size, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(id, size, now, expiresAt);
  }

  blobExists(id: Bytes, now: number): boolean {
    return (
      this.#db.prepare("SELECT 1 FROM blobs WHERE id = ? AND expires_at > ?").get(id, now) !==
      undefined
    );
  }

  expiredBlobs(now: number): Bytes[] {
    const rows = this.#db.prepare("SELECT id FROM blobs WHERE expires_at <= ?").all(now) as unknown as {
      id: Bytes;
    }[];
    return rows.map((r) => r.id);
  }

  // --- уборка ---------------------------------------------------------------

  sweep(now: number): { envelopes: number; invites: number; blobs: number; payments: number } {
    return this.#tx(() => ({
      payments: Number(this.#db.prepare("DELETE FROM payments WHERE expires_at <= ?").run(now).changes),
      envelopes: Number(this.#db.prepare("DELETE FROM envelopes WHERE expires_at <= ?").run(now).changes),
      invites: Number(this.#db.prepare("DELETE FROM invites WHERE expires_at <= ?").run(now).changes),
      passes: Number(this.#db.prepare("DELETE FROM passes WHERE expires_at <= ?").run(now).changes),
      blobs: Number(this.#db.prepare("DELETE FROM blobs WHERE expires_at <= ?").run(now).changes),
    }));
  }

  #tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }
}
