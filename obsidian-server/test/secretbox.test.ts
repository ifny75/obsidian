/**
 * Секрет одноразовых кодов в базе.
 *
 * Проверять надо не «шифруется ли» в отрыве, а то, ради чего это делалось: что
 * дамп `obsidian.db` не отдаёт вторые факторы, что старая база переезжает сама
 * и что без ключа второй фактор не обходится, а перестаёт проходить.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../src/db/index.ts";
import { SecretBox, isSealed } from "../src/db/secretbox.ts";
import { random } from "../src/util/bytes.ts";

/** Секрет, как его выдаёт ядро: двадцать байт RFC 6238. */
const SECRET = new Uint8Array([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
]);

function scratch(): { dir: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), "obsidian-box-"));
  return { dir, db: join(dir, "test.db") };
}

/** Что лежит в файле на самом деле — в обход всякого расшифровывания. */
function rawSecret(dbPath: string): Uint8Array {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT totp_secret FROM recoveries").get() as
    { totp_secret: Uint8Array } | undefined;
  db.close();
  assert.ok(row, "строка восстановления обязана существовать");
  return row.totp_secret;
}

function seed(store: Store, secret: Uint8Array | null): Uint8Array {
  const identity = random(32);
  const loginId = random(32);
  store.createUser(identity, null, Date.now());
  assert.equal(
    store.setRecovery(loginId, identity, random(32), random(64), Date.now(), secret),
    true,
  );
  return loginId;
}

test("в файле базы секрета второго фактора нет", () => {
  const { dir, db } = scratch();
  try {
    const store = new Store(db);
    const loginId = seed(store, SECRET);
    store.close();

    const stored = rawSecret(db);
    assert.ok(isSealed(stored), "запись обязана быть закрытой");
    assert.notDeepEqual(Array.from(stored), Array.from(SECRET));
    // Главное: секрет не должен встречаться в файле даже кусками.
    assert.equal(
      Buffer.from(stored).includes(Buffer.from(SECRET)),
      false,
      "открытый секрет не должен лежать внутри шифротекста",
    );

    // А сервер по-прежнему читает его целым.
    const back = new Store(db);
    assert.deepEqual(Array.from(back.getRecovery(loginId)!.totp_secret!), Array.from(SECRET));
    back.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("старая база с открытыми секретами закрывается при первом запуске", () => {
  const { dir, db } = scratch();
  try {
    // Заводим строку и подменяем её содержимое на то, как это лежало раньше.
    const store = new Store(db);
    const loginId = seed(store, SECRET);
    store.close();

    const plain = new DatabaseSync(db);
    plain.prepare("UPDATE recoveries SET totp_secret = ?").run(SECRET);
    plain.close();
    assert.equal(isSealed(rawSecret(db)), false, "подготовка: секрет лежит открытым");

    const migrated = new Store(db);
    assert.ok(isSealed(rawSecret(db)), "переезд обязан закрыть старую запись");
    // И, что важнее переезда, — секрет остался тем же самым: коды, которые
    // человек видит в приложении, обязаны продолжать подходить.
    assert.deepEqual(Array.from(migrated.getRecovery(loginId)!.totp_secret!), Array.from(SECRET));
    migrated.close();

    // Повторный запуск ничего не портит: закрытое остаётся закрытым.
    const again = new Store(db);
    assert.deepEqual(Array.from(again.getRecovery(loginId)!.totp_secret!), Array.from(SECRET));
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("без ключа второй фактор не обходится, а перестаёт проходить", () => {
  const { dir, db } = scratch();
  try {
    const store = new Store(db);
    const loginId = seed(store, SECRET);
    store.close();

    // Ключ подменён — примерно так выглядит переезд базы без файла ключа.
    writeFileSync(join(dir, "secret.key"), Buffer.from(random(32)).toString("hex"));

    const broken = new Store(db);
    const row = broken.getRecovery(loginId)!;
    // Второй фактор обязан остаться требуемым: null здесь означал бы «его нет»,
    // то есть пропустить человека мимо проверки. Пусть лучше не пройдёт никто.
    assert.notEqual(row.totp_secret, null, "потеря ключа не должна выключать второй фактор");
    assert.notDeepEqual(Array.from(row.totp_secret!), Array.from(SECRET));
    broken.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("подменённый шифротекст не открывается", () => {
  const box = new SecretBox(Buffer.from(random(32)));
  const sealed = box.seal(SECRET);
  assert.deepEqual(Array.from(box.open(sealed)!), Array.from(SECRET));

  // GCM аутентифицирован: правка любого байта обязана быть замечена, иначе
  // строку в базе можно было бы подменить на секрет злоумышленника.
  assert.equal(box.open(flipBit(sealed, sealed.length - 1)), null, "правка метки");
  assert.equal(box.open(flipBit(sealed, 8)), null, "правка вектора");
  assert.equal(box.open(flipBit(sealed, sealed.length - 20)), null, "правка тела");

  // Чужой ключ тоже не открывает.
  assert.equal(new SecretBox(Buffer.from(random(32))).open(sealed), null);
});

/** Копия с испорченным байтом. */
function flipBit(source: Uint8Array, at: number): Uint8Array {
  const copy = Uint8Array.from(source);
  copy[at] = (copy[at] ?? 0) ^ 1;
  return copy;
}
