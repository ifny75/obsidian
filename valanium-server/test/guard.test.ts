/**
 * Защита от молчаливого заведения пустой базы.
 *
 * Проверяется ровно тот случай, который уже произошёл: путь к базе сменился
 * при переименовании проекта, файл остался под прежним именем, и сервер
 * бодро завёл пустую базу. Пятнадцать аккаунтов при этом лежали рядом.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { blockingNeighbour, refuseToLoseDatabase } from "../src/db/guard.ts";
import { Store } from "../src/db/index.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "valanium-guard-"));
}

test("переименование базы не проходит молча", () => {
  const home = dir();
  // Так и выглядела авария: рядом лежит база под прежним именем.
  writeFileSync(join(home, "obsidian.db"), "");
  const path = join(home, "valanium.db");

  assert.equal(blockingNeighbour(path), "obsidian.db");
  assert.throws(() => refuseToLoseDatabase(path), /obsidian\.db/);
  // И через настоящий конструктор — иначе защита была бы только в тесте.
  assert.throws(() => new Store(path), /obsidian\.db/);
  rmSync(home, { recursive: true, force: true });
});

test("настоящий первый запуск не ломается", () => {
  // Пустой каталог — рядом ничего нет, терять нечего.
  const home = dir();
  const path = join(home, "valanium.db");
  assert.equal(blockingNeighbour(path), null);
  const store = new Store(path);
  store.close();
  rmSync(home, { recursive: true, force: true });
});

test("существующая база открывается как обычно", () => {
  const home = dir();
  const path = join(home, "valanium.db");
  new Store(path).close();
  // Файл уже есть — соседи неважны, ничего не создаётся заново.
  writeFileSync(join(home, "obsidian.db"), "");
  assert.equal(blockingNeighbour(path), null);
  const again = new Store(path);
  again.close();
  rmSync(home, { recursive: true, force: true });
});

test("служебные файлы соседями не считаются", () => {
  /*
    support.db — не база мессенджера, а -wal и -shm вообще не базы. Если бы
    они считались, защита срабатывала бы на ровном месте при каждом первом
    запуске, и её отключили бы в первый же день — а отключённая защита хуже
    отсутствующей: на неё рассчитывают.
  */
  const home = dir();
  for (const name of ["support.db", "valanium.db-wal", "valanium.db-shm"]) {
    writeFileSync(join(home, name), "");
  }
  assert.equal(blockingNeighbour(join(home, "valanium.db")), null);
  rmSync(home, { recursive: true, force: true });
});

test("обойти можно, но только явно", () => {
  const home = dir();
  writeFileSync(join(home, "obsidian.db"), "");
  const path = join(home, "valanium.db");

  process.env["VALANIUM_ALLOW_NEW_DB"] = "true";
  assert.doesNotThrow(() => refuseToLoseDatabase(path));
  // Любое другое значение обходом не считается: «почти true» не должно
  // случайно открывать дверь.
  process.env["VALANIUM_ALLOW_NEW_DB"] = "1";
  assert.throws(() => refuseToLoseDatabase(path));
  delete process.env["VALANIUM_ALLOW_NEW_DB"];
  rmSync(home, { recursive: true, force: true });
});

test("память не трогаем: тесты открывают базу в памяти постоянно", () => {
  assert.equal(blockingNeighbour(":memory:"), null);
  assert.doesNotThrow(() => refuseToLoseDatabase(":memory:"));
});
