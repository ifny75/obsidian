/**
 * Отзыв инвайта:
 *   npm run invite:revoke -- <код>
 *
 * Нужен, когда код куда-то утёк до использования: попал в переписку, в лог,
 * в скриншот. Ждать, пока он протухнет сам, в такой ситуации нечего.
 *
 * В базе лежит только SHA-256 от кода, поэтому отзыв работает по самому коду:
 * узнать по базе, какой код за какой строкой, невозможно — это и было целью.
 */
import { sha256 } from "@noble/hashes/sha2";
import { config } from "../config.ts";
import { Store } from "../db/index.ts";
import { ascii } from "../util/bytes.ts";

const code = process.argv[2];
if (!code) {
  process.stderr.write("usage: npm run invite:revoke -- <код>\n");
  process.exit(2);
}

const store = new Store(config.dbPath);
const revoked = store.revokeInvite(sha256(ascii(code.trim())));
const left = store.countInvites(Date.now());
store.close();

process.stdout.write(revoked ? "инвайт отозван\n" : "такого кода нет (уже использован, отозван или неверен)\n");
process.stdout.write(`живых кодов осталось: ${left}\n`);
process.exit(revoked ? 0 : 1);
