/**
 * Огрубление времени последнего появления.
 *
 * Серверу оно нужно ровно для одного — понять, какое устройство отвечало
 * последним. С точностью до миллисекунды это распорядок дня человека, лежащий
 * на диске, поэтому в базу попадает только час.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Store, coarseTime } from "../src/db/index.ts";
import { random } from "../src/util/bytes.ts";

test("в базу попадает час, а не миллисекунда", () => {
  const store = new Store(":memory:");
  const identity = random(32);
  const devicePub = random(32);
  store.createUser(identity, Date.now());

  // 14:37:19.842 — по такому времени видно, когда человек взял телефон.
  const exact = Date.UTC(2026, 7, 30, 14, 37, 19, 842);
  store.createDevice(identity, devicePub, random(64), exact);

  const [device] = store.listDevices(identity);
  assert.ok(device);
  assert.equal(device.last_seen, Date.UTC(2026, 7, 30, 14, 0, 0, 0), "должен остаться только час");
  assert.notEqual(device.last_seen, exact);

  // То же и при обычном заходе.
  store.touchDevice(devicePub, Date.UTC(2026, 7, 30, 21, 59, 59, 999));
  const [after] = store.listDevices(identity);
  assert.equal(after!.last_seen, Date.UTC(2026, 7, 30, 21, 0, 0, 0));
  store.close();
});

test("выбор свежего устройства переживает огрубление", () => {
  const store = new Store(":memory:");
  const identity = random(32);
  const older = random(32);
  const newer = random(32);
  store.createUser(identity, Date.now());

  // Два устройства в пределах одного часа: время у них станет одинаковым, и
  // порядок обязан держаться на втором ключе сортировки, а не на удаче.
  const hour = Date.UTC(2026, 7, 30, 9, 0, 0, 0);
  store.createDevice(identity, older, random(64), hour + 60_000);
  store.createDevice(identity, newer, random(64), hour + 3_000_000);

  const [a, b] = store.listDevices(identity);
  assert.equal(a!.last_seen, b!.last_seen, "оба попали в один час");
  assert.deepEqual(
    Array.from(store.activeDevice(identity) ?? []),
    Array.from(newer),
    "активным обязано остаться то, что заведено позже",
  );
  store.close();
});

test("час считается от начала эпохи, без сюрпризов на границах", () => {
  assert.equal(coarseTime(0), 0);
  assert.equal(coarseTime(3599_999), 0);
  assert.equal(coarseTime(3600_000), 3600_000);
  assert.equal(coarseTime(3600_001), 3600_000);
});
