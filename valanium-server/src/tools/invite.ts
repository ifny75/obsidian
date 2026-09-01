/**
 * Создание инвайта без поднятого сервера:
 *   npm run invite
 *
 * Код печатается один раз. В БД ложится только SHA-256 от него — восстановить
 * потерянный код нельзя, можно только выпустить новый.
 */
import { sha256 } from "@noble/hashes/sha2";
import { config } from "../config.ts";
import { Store } from "../db/index.ts";
import { ascii, random, toHex } from "../util/bytes.ts";

const store = new Store(config.dbPath);
const now = Date.now();
const code = toHex(random(12));

store.createInvite(sha256(ascii(code)), now, now + config.inviteTtlSec * 1000);
store.close();

process.stdout.write(`invite: ${code}\n`);
process.stdout.write(`expires: ${new Date(now + config.inviteTtlSec * 1000).toISOString()}\n`);
