/**
 * Снимок состояния сервера:
 *   npm run backup -- /var/backups/obsidian
 *
 * Обычным `cp` базу копировать нельзя: она в режиме WAL, и файл, снятый во
 * время записи, окажется битым или потеряет последние транзакции. `VACUUM INTO`
 * делает консистентный снимок прямо на работающей базе, не останавливая сервер.
 *
 * **Что бэкап спасает, а что нет.** Переписку он не восстановит никогда — у
 * сервера нет ключей, в очереди лежит только шифротекст. Он спасает
 * регистрации: без базы все устройства станут сервер неизвестны, и людям
 * придётся заходить заново по новым инвайтам.
 */
import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";

const target = process.argv[2];
if (!target) {
  process.stderr.write("usage: npm run backup -- <каталог>\n");
  process.exit(2);
}

/** Сколько снимков держать. Старые удаляются, иначе диск кончится молча. */
const KEEP = Number(process.env["OBSIDIAN_BACKUP_KEEP"] ?? 14);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(target, stamp);
mkdirSync(dir, { recursive: true });

// --- база -------------------------------------------------------------------

const db = new DatabaseSync(config.dbPath);
try {
  const snapshot = join(dir, "obsidian.db").replaceAll("'", "''");
  db.exec(`VACUUM INTO '${snapshot}'`);
} finally {
  db.close();
}

// --- вложения ---------------------------------------------------------------
// Это шифротексты: ключи от них лежат внутри переписки на клиентах, поэтому
// копировать их как есть безопасно.

if (existsSync(config.blobDir)) {
  cpSync(config.blobDir, join(dir, "blobs"), { recursive: true });
}

// --- ротация ----------------------------------------------------------------

const snapshots = readdirSync(target)
  .filter((name) => statSync(join(target, name)).isDirectory())
  .sort();

for (const old of snapshots.slice(0, Math.max(0, snapshots.length - KEEP))) {
  rmSync(join(target, old), { recursive: true, force: true });
}

process.stdout.write(`снимок: ${dir}\n`);
process.stdout.write(`хранится снимков: ${Math.min(snapshots.length, KEEP)} из ${KEEP}\n`);
