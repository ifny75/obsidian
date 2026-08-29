/**
 * Каталог юзернеймов — слой поиска, а не замена личности.
 *
 * Задач у сервера здесь три: не дать занять чужое имя, не отдавать скрытых
 * людей и не превращать поиск в способ перебирать существующие имена.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";

import { Store } from "../src/db/index.ts";
import { NonceStore } from "../src/auth/nonce.ts";
import { Registry, type Socket } from "../src/ws/registry.ts";
import { RateLimiter } from "../src/util/ratelimit.ts";
import { ConnectionCounter } from "../src/util/connections.ts";
import { authMessage, deviceCertMessage } from "../src/auth/verify.ts";
import { handleMessage, handleOpen, newConnData, type Deps } from "../src/ws/session.ts";
import { OP, jsonFrame } from "../src/proto/frames.ts";
import { ascii, fromHex, random, toHex } from "../src/util/bytes.ts";

class FakeSocket implements Socket {
  readonly sent: Uint8Array[] = [];
  closed: { code: number } | null = null;
  send(data: Uint8Array): number {
    this.sent.push(data.slice());
    return 1;
  }
  getBufferedAmount(): number {
    return 0;
  }
  end(code: number): void {
    this.closed = { code };
  }
  close(): void {
    this.closed = { code: 1006 };
  }
  take(op: number): Uint8Array {
    const found = this.sent.find((f) => f[0] === op);
    assert.ok(found, `нет кадра 0x${op.toString(16)}`);
    return found;
  }
  json(op: number): any {
    return JSON.parse(new TextDecoder().decode(this.take(op).subarray(1)));
  }
  has(op: number): boolean {
    return this.sent.some((f) => f[0] === op);
  }
  clear(): void {
    this.sent.length = 0;
  }
}

function makeDeps(store: Store): Deps {
  return {
    store,
    nonces: new NonceStore(30_000),
    registry: new Registry(),
    authLimiter: new RateLimiter(100, 60_000),
    recoveryLimiter: new RateLimiter(100, 3600_000),
    searchLimiter: new RateLimiter(100, 60_000),
    sendLimiter: new RateLimiter(1000, 60_000),
    postLimiter: new RateLimiter(1000, 60_000),
    connections: new ConnectionCounter(),
    now: () => Date.now(),
  };
}

function makeIdentity() {
  const idPriv = ed25519.utils.randomPrivateKey();
  const devPriv = ed25519.utils.randomPrivateKey();
  const idPub = ed25519.getPublicKey(idPriv);
  const devPub = ed25519.getPublicKey(devPriv);
  return { idPriv, devPriv, idPub, devPub };
}

function register(deps: Deps, store: Store, id: ReturnType<typeof makeIdentity>, handle: string) {
  const sock = new FakeSocket();
  const conn = newConnData("127.0.0.1");
  handleOpen(deps, sock, conn);
  const nonce = fromHex(sock.json(OP.HELLO).nonce, 32);

  const code = toHex(random(12));
  store.createInvite(sha256(ascii(code)), Date.now(), Date.now() + 3600_000);

  handleMessage(deps, sock, conn, jsonFrame(OP.AUTH, {
    v: 1,
    identity: toHex(id.idPub),
    device: toHex(id.devPub),
    deviceCert: toHex(ed25519.sign(deviceCertMessage(id.idPub, id.devPub), id.idPriv)),
    sig: toHex(ed25519.sign(authMessage(nonce, id.idPub, id.devPub), id.devPriv)),
    invite: code,
    handle,
  }));
  assert.ok(sock.has(OP.AUTH_OK), "регистрация не прошла");
  sock.clear();
  return { sock, conn };
}

/** Клиент считает хеш сам; сервер самого имени не видит. */
const nameHash = (name: string) => toHex(sha256(ascii("obsidian-username-v1" + name.toLowerCase())));

test("юзернейм занимается и находится по точному имени", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mira = makeIdentity();
  const seeker = makeIdentity();

  const m = register(deps, store, mira, "mira");
  handleMessage(deps, m.sock, m.conn, jsonFrame(OP.USERNAME_SET, { nameHash: nameHash("mira"), discoverable: true }));
  assert.equal(m.sock.json(OP.USERNAME_OK).cleared, false);

  const s = register(deps, store, seeker, "seeker");
  handleMessage(deps, s.sock, s.conn, jsonFrame(OP.USERNAME_LOOKUP, { nameHash: nameHash("MIRA") }));

  const found = s.sock.json(OP.USERNAME_FOUND);
  assert.equal(found.found, true, "регистр не должен мешать поиску");
  assert.equal(found.device, toHex(mira.devPub));
  assert.ok(found.chatCode, "код для начала чата обязан приехать");
  store.close();
});

/** Найденный человек ещё никого не одобрял: лишнего о нём отдавать нельзя. */
test("поиск не раскрывает ничего сверх профиля", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mira = makeIdentity();

  const m = register(deps, store, mira, "mira");
  handleMessage(deps, m.sock, m.conn, jsonFrame(OP.USERNAME_SET, { nameHash: nameHash("mira") }));

  const s = register(deps, store, makeIdentity(), "seeker");
  handleMessage(deps, s.sock, s.conn, jsonFrame(OP.USERNAME_LOOKUP, { nameHash: nameHash("mira") }));

  const found = s.sock.json(OP.USERNAME_FOUND);
  for (const leak of ["identity", "fingerprint", "handle", "online", "lastSeen", "contacts"]) {
    assert.equal(found[leak], undefined, `в ответе не должно быть ${leak}`);
  }
  store.close();
});

test("чужое имя не занять", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);

  const first = register(deps, store, makeIdentity(), "first");
  handleMessage(deps, first.sock, first.conn, jsonFrame(OP.USERNAME_SET, { nameHash: nameHash("mira") }));
  assert.ok(first.sock.has(OP.USERNAME_OK));

  const second = register(deps, store, makeIdentity(), "second");
  handleMessage(deps, second.sock, second.conn, jsonFrame(OP.USERNAME_SET, { nameHash: nameHash("mira") }));

  assert.equal(second.sock.json(OP.ERROR).code, "username_taken");
  assert.equal(second.sock.has(OP.USERNAME_OK), false);
  assert.equal(second.sock.closed, null, "занятое имя — не повод рвать соединение");
  store.close();
});

test("смена имени освобождает прежнее", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mira = makeIdentity();

  const m = register(deps, store, mira, "mira");
  handleMessage(deps, m.sock, m.conn, jsonFrame(OP.USERNAME_SET, { nameHash: nameHash("old") }));
  handleMessage(deps, m.sock, m.conn, jsonFrame(OP.USERNAME_SET, { nameHash: nameHash("new") }));

  const other = register(deps, store, makeIdentity(), "other");
  handleMessage(deps, other.sock, other.conn, jsonFrame(OP.USERNAME_SET, { nameHash: nameHash("old") }));
  assert.ok(other.sock.has(OP.USERNAME_OK), "освобождённое имя обязано быть свободным");
  store.close();
});

/** Скрытый и несуществующий отвечают одинаково — иначе поиск станет перебором. */
test("скрытый профиль неотличим от несуществующего", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);

  const hidden = register(deps, store, makeIdentity(), "hidden");
  handleMessage(deps, hidden.sock, hidden.conn,
    jsonFrame(OP.USERNAME_SET, { nameHash: nameHash("hidden"), discoverable: false }));

  const s = register(deps, store, makeIdentity(), "seeker");
  handleMessage(deps, s.sock, s.conn, jsonFrame(OP.USERNAME_LOOKUP, { nameHash: nameHash("hidden") }));
  const forHidden = s.sock.json(OP.USERNAME_FOUND);

  s.sock.clear();
  handleMessage(deps, s.sock, s.conn, jsonFrame(OP.USERNAME_LOOKUP, { nameHash: nameHash("такого-нет") }));
  const forMissing = s.sock.json(OP.USERNAME_FOUND);

  assert.deepEqual(forHidden, forMissing, "ответы обязаны совпадать");
  assert.equal(forHidden.found, false);
  store.close();
});

test("юзернейм можно убрать", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mira = makeIdentity();

  const m = register(deps, store, mira, "mira");
  handleMessage(deps, m.sock, m.conn, jsonFrame(OP.USERNAME_SET, { nameHash: nameHash("mira") }));
  handleMessage(deps, m.sock, m.conn, jsonFrame(OP.USERNAME_SET, { clear: true }));
  assert.equal(store.hasUsername(mira.idPub), false);

  const s = register(deps, store, makeIdentity(), "seeker");
  handleMessage(deps, s.sock, s.conn, jsonFrame(OP.USERNAME_LOOKUP, { nameHash: nameHash("mira") }));
  assert.equal(s.sock.json(OP.USERNAME_FOUND).found, false);
  store.close();
});

test("перебор упирается в ограничитель", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  deps.searchLimiter = new RateLimiter(3, 60_000);

  const s = register(deps, store, makeIdentity(), "seeker");
  for (let i = 0; i < 3; i++) {
    handleMessage(deps, s.sock, s.conn, jsonFrame(OP.USERNAME_LOOKUP, { nameHash: nameHash(`кандидат${i}`) }));
  }
  assert.equal(s.sock.sent.filter((f) => f[0] === OP.USERNAME_FOUND).length, 3);

  s.sock.clear();
  handleMessage(deps, s.sock, s.conn, jsonFrame(OP.USERNAME_LOOKUP, { nameHash: nameHash("ещё-один") }));
  assert.equal(s.sock.json(OP.ERROR).code, "search_rate_limited");
  assert.equal(s.sock.has(OP.USERNAME_FOUND), false, "после отказа ответа быть не должно");
  store.close();
});

test("поиск без входа не работает", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const sock = new FakeSocket();
  const conn = newConnData("127.0.0.1");
  handleOpen(deps, sock, conn);

  handleMessage(deps, sock, conn, jsonFrame(OP.USERNAME_LOOKUP, { nameHash: nameHash("mira") }));
  assert.equal(sock.closed?.code, 1008);
  store.close();
});

/*
  Переезд на дорогой хеш.

  Клиенты обновляются не одновременно, поэтому проверять надо не «работает ли
  новый хеш», а то, что старый и новый живут рядом и никто не теряется.
*/

/** Дорогой хеш здесь подделан: сервер его не считает и считать не может. */
const strongHash = (name: string) => toHex(sha256(ascii("argon-stub:" + name.toLowerCase())));

test("имя, занятое обеими формами, находится по дорогому хешу", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mira = makeIdentity();

  const m = register(deps, store, mira, "mira");
  handleMessage(deps, m.sock, m.conn, jsonFrame(OP.USERNAME_SET, {
    nameHash: nameHash("mira"),
    nameHash2: strongHash("mira"),
  }));
  assert.equal(m.sock.json(OP.USERNAME_OK).cleared, false);

  const s = register(deps, store, makeIdentity(), "seeker");
  handleMessage(deps, s.sock, s.conn, jsonFrame(OP.USERNAME_LOOKUP, {
    nameHash: nameHash("mira"),
    nameHash2: strongHash("mira"),
  }));
  assert.equal(s.sock.json(OP.USERNAME_FOUND).device, toHex(mira.devPub));
  store.close();
});

test("не обновившийся владелец по-прежнему находится", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mira = makeIdentity();

  // Старый клиент второго хеша не шлёт вовсе.
  const m = register(deps, store, mira, "mira");
  handleMessage(deps, m.sock, m.conn, jsonFrame(OP.USERNAME_SET, { nameHash: nameHash("mira") }));
  assert.equal(m.sock.json(OP.USERNAME_OK).cleared, false, "старый клиент обязан занимать имя");

  // Новый ищущий шлёт оба: находка обязана произойти по старому.
  const s = register(deps, store, makeIdentity(), "seeker");
  handleMessage(deps, s.sock, s.conn, jsonFrame(OP.USERNAME_LOOKUP, {
    nameHash: nameHash("mira"),
    nameHash2: strongHash("mira"),
  }));
  assert.equal(s.sock.json(OP.USERNAME_FOUND).device, toHex(mira.devPub));
  store.close();
});

test("не обновившийся ищущий находит обновившегося", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mira = makeIdentity();

  const m = register(deps, store, mira, "mira");
  handleMessage(deps, m.sock, m.conn, jsonFrame(OP.USERNAME_SET, {
    nameHash: nameHash("mira"),
    nameHash2: strongHash("mira"),
  }));

  // Старый клиент шлёт только прежний хеш — он обязан продолжать работать.
  const s = register(deps, store, makeIdentity(), "seeker");
  handleMessage(deps, s.sock, s.conn, jsonFrame(OP.USERNAME_LOOKUP, { nameHash: nameHash("mira") }));
  assert.equal(s.sock.json(OP.USERNAME_FOUND).device, toHex(mira.devPub));
  store.close();
});

test("владелец дозанимает своё имя, не теряя его", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mira = makeIdentity();

  const m = register(deps, store, mira, "mira");
  handleMessage(deps, m.sock, m.conn, jsonFrame(OP.USERNAME_SET, { nameHash: nameHash("mira") }));
  m.sock.clear();

  // Это и делает обновлённый клиент при первом заходе.
  handleMessage(deps, m.sock, m.conn, jsonFrame(OP.USERNAME_SET, {
    nameHash: nameHash("mira"),
    nameHash2: strongHash("mira"),
  }));
  assert.equal(m.sock.json(OP.USERNAME_OK).cleared, false, "своё имя перезанимается свободно");

  const s = register(deps, store, makeIdentity(), "seeker");
  handleMessage(deps, s.sock, s.conn, jsonFrame(OP.USERNAME_LOOKUP, {
    nameHash: nameHash("mira"),
    nameHash2: strongHash("mira"),
  }));
  assert.equal(s.sock.json(OP.USERNAME_FOUND).device, toHex(mira.devPub));
  store.close();
});

test("чужое имя не занять и дорогим хешем", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);

  const first = register(deps, store, makeIdentity(), "first");
  handleMessage(deps, first.sock, first.conn, jsonFrame(OP.USERNAME_SET, {
    nameHash: nameHash("mira"),
    nameHash2: strongHash("mira"),
  }));
  assert.equal(first.sock.json(OP.USERNAME_OK).cleared, false);

  const second = register(deps, store, makeIdentity(), "second");
  handleMessage(deps, second.sock, second.conn, jsonFrame(OP.USERNAME_SET, {
    nameHash: nameHash("mira"),
    nameHash2: strongHash("mira"),
  }));
  assert.equal(second.sock.json(OP.ERROR).code, "username_taken");
  store.close();
});
