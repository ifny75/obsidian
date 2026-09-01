import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { random } from "../util/bytes.ts";

/**
 * Почта поддержки живёт в СВОЕЙ базе, и это не вкусовщина.
 *
 * В `db/schema.ts` записано прямо: отправителя, контакт-листов и открытого
 * текста в базе мессенджера нет и быть не должно. Письмо в поддержку — ровно
 * это и есть: внешний адрес живого человека плюс произвольный текст. Положить
 * его рядом с личностями значило бы своими руками собрать связку, которой мы
 * везде избегаем, и превратить «изымать нечего» в «изымать есть что».
 *
 * Поэтому отдельный файл, отдельный срок хранения и никаких внешних ключей на
 * `users`: две базы не знают друг о друге. Утечка одной не вскрывает вторую.
 */
const SCHEMA = `
-- Переписка с одним человеком. Ключ — его адрес: другого устойчивого
-- идентификатора у почты нет, а Message-ID меняется от письма к письму.
CREATE TABLE IF NOT EXISTS threads (
  id          BLOB PRIMARY KEY,
  address     TEXT NOT NULL UNIQUE,
  subject     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  unread      INTEGER NOT NULL DEFAULT 0,
  closed      INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS threads_updated ON threads(updated_at DESC);

-- Письма от человека. Наших ответов здесь нет и колонки под них тоже: сервер
-- почту только принимает, а отвечает владелец из своего ящика, куда приходит
-- копия. Появится отправка — появится и столбец, гадать наперёд незачем.
--
-- seq, а не время: два письма в одну миллисекунду порядок бы потеряли, а
-- переписку читают сверху вниз и путаница здесь дороже лишнего столбца.
CREATE TABLE IF NOT EXISTS messages (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         BLOB NOT NULL UNIQUE,
  thread     BLOB NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread, seq);
`;

export interface ThreadRow {
  id: Uint8Array;
  address: string;
  subject: string;
  created_at: number;
  updated_at: number;
  unread: number;
  closed: number;
}

export interface MessageRow {
  seq: number;
  id: Uint8Array;
  thread: Uint8Array;
  subject: string;
  body: string;
  created_at: number;
}

export class SupportStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(SCHEMA);
    this.#restrict(path);
  }

  /**
   * Файл базы не должен читаться всеми на машине.
   *
   * SQLite создаёт его по umask, а это обычно 0644 — то есть адреса и тексты
   * писем открыты любой локальной учётке, включая www-data. Каталог `data`
   * закрыт правами, но полагаться на один рубеж там, где рубежей может быть
   * два, незачем: umask меняется, каталог однажды переедет.
   */
  #restrict(path: string): void {
    if (path === ":memory:") return;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        chmodSync(path + suffix, 0o600);
      } catch {
        // Файла может ещё не быть (-wal и -shm появляются при первой записи)
        // либо владелец другой. Не повод не стартовать.
      }
    }
  }

  close(): void {
    this.#db.close();
  }

  /**
   * Кладёт входящее письмо, заводя переписку при первом обращении.
   *
   * Тема берётся из последнего письма:человек может начать с «вопрос», а через
   * неделю писать про другое, и показывать в списке первую строку месячной
   * давности бесполезно.
   */
  receive(address: string, subject: string, body: string, now: number): ThreadRow {
    const existing = this.#db.prepare("SELECT * FROM threads WHERE address = ?")
      .get(address) as unknown as ThreadRow | undefined;
    const id = existing ? existing.id : random(16);
    if (existing) {
      this.#db.prepare("UPDATE threads SET subject = ?, updated_at = ?, unread = unread + 1, closed = 0 WHERE id = ?")
        .run(subject, now, id);
    } else {
      this.#db.prepare(
        "INSERT INTO threads (id, address, subject, created_at, updated_at, unread, closed) VALUES (?, ?, ?, ?, ?, 1, 0)",
      ).run(id, address, subject, now, now);
    }
    this.#db.prepare(
      "INSERT INTO messages (id, thread, subject, body, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(random(16), id, subject, body, now);
    return this.#db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as unknown as ThreadRow;
  }

  threads(limit: number, offset: number): ThreadRow[] {
    return this.#db.prepare("SELECT * FROM threads ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as unknown as ThreadRow[];
  }

  thread(id: Uint8Array): ThreadRow | undefined {
    return this.#db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as unknown as ThreadRow | undefined;
  }

  messages(thread: Uint8Array, limit: number): MessageRow[] {
    return this.#db.prepare("SELECT * FROM messages WHERE thread = ? ORDER BY seq DESC LIMIT ?")
      .all(thread, limit) as unknown as MessageRow[];
  }

  markRead(thread: Uint8Array): void {
    this.#db.prepare("UPDATE threads SET unread = 0 WHERE id = ?").run(thread);
  }

  setClosed(thread: Uint8Array, closed: boolean): void {
    this.#db.prepare("UPDATE threads SET closed = ? WHERE id = ?").run(closed ? 1 : 0, thread);
  }

  /** Сколько переписок ждёт ответа — счётчик для значка в панели. */
  unreadCount(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM threads WHERE unread > 0").get() as { n: number };
    return Number(row.n);
  }

  /**
   * Старое удаляется, а не архивируется.
   *
   * Переписка с поддержкой — не архив: через полгода она уже никому не нужна,
   * а адрес человека всё ещё лежит на диске. Хранить дольше, чем нужно для
   * работы, — это и есть та самая метаданная, которой мы избегаем везде.
   */
  sweep(cutoff: number): number {
    return Number(
      this.#db.prepare("DELETE FROM threads WHERE updated_at <= ? AND unread = 0").run(cutoff).changes,
    );
  }
}
