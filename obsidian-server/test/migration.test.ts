/**
 * Открытие базы, заведённой прежней версией.
 *
 * Юнит-тесты работают с `:memory:`, то есть всегда с чистой схемой, — и ровно
 * поэтому мимо них проходит целый класс ошибок: то, что ломается только на
 * базе, у которой уже есть данные. Этот файл существует, чтобы такие ошибки
 * ловились здесь, а не при перезапуске сервера.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../src/db/index.ts";
import { random } from "../src/util/bytes.ts";

/** Таблица имён в том виде, в каком её создавали до второго хеша. */
const OLD_SHAPE = `
CREATE TABLE users (
  identity   BLOB PRIMARY KEY,
  handle     TEXT UNIQUE,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE usernames (
  name_hash    BLOB PRIMARY KEY,
  identity     BLOB NOT NULL UNIQUE REFERENCES users(identity) ON DELETE CASCADE,
  discoverable INTEGER NOT NULL DEFAULT 1,
  updated_at   INTEGER NOT NULL
) WITHOUT ROWID;
`;

function scratch(): { dir: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), "obsidian-migrate-"));
  return { dir, db: join(dir, "old.db") };
}

test("база прежней версии открывается и дополняется на месте", () => {
  const { dir, db } = scratch();
  try {
    const identity = random(32);
    const nameHash = random(32);

    // Готовим базу так, как её оставила бы прежняя версия: со строкой в
    // таблице имён и без столбца name_hash2.
    const old = new DatabaseSync(db);
    old.exec(OLD_SHAPE);
    old.prepare("INSERT INTO users (identity, handle, created_at) VALUES (?, ?, ?)")
      .run(identity, "mira", Date.now());
    old.prepare(
      "INSERT INTO usernames (name_hash, identity, discoverable, updated_at) VALUES (?, ?, 1, ?)",
    ).run(nameHash, identity, Date.now());
    old.close();

    // Вот это и падало на живом сервере: индекс по столбцу, которого ещё нет.
    const store = new Store(db);

    // Столбец появился, строка на месте, и человек по-прежнему находится по
    // прежнему хешу — обновление сервера не должно отбирать у него имя.
    assert.deepEqual(
      Array.from(store.findByUsername(nameHash, null) ?? []),
      Array.from(identity),
      "имя обязано найтись по прежнему хешу",
    );
    // И по новому пути тоже: он просто не находит, а не падает.
    assert.equal(store.findByUsername(random(32), random(32)), undefined);
    store.close();

    const check = new DatabaseSync(db, { readOnly: true });
    const columns = (check.prepare("PRAGMA table_info(usernames)").all() as unknown as
      { name: string }[]).map((column) => column.name);
    assert.ok(columns.includes("name_hash2"), "столбец обязан добавиться");
    const indexes = (check.prepare("PRAGMA index_list(usernames)").all() as unknown as
      { name: string }[]).map((index) => index.name);
    assert.ok(indexes.includes("usernames_hash2"), "индекс обязан создаться");
    check.close();

    // Повторное открытие ничего не ломает: миграции обязаны быть идемпотентны.
    const again = new Store(db);
    assert.deepEqual(
      Array.from(again.findByUsername(nameHash, null) ?? []),
      Array.from(identity),
    );
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("пустой файл базы разворачивается с нуля", () => {
  const { dir, db } = scratch();
  try {
    const store = new Store(db);
    assert.equal(store.findByUsername(random(32), random(32)), undefined);
    store.close();

    // Второй запуск на той же базе — обычное дело при перезапуске сервера.
    const again = new Store(db);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
