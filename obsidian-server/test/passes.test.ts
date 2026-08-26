/**
 * Пропуска: кому разрешено писать.
 *
 * Смысл механизма в том, что сервер проверяет право написать, но не запоминает,
 * кто кому пишет. Он хранит хеш пропуска и его владельца; предъявленный секрет
 * живёт ровно один кадр, а признак допуска — до конца соединения.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";

import { Store } from "../src/db/index.ts";
import { NonceStore } from "../src/auth/nonce.ts";
import { SessionStore } from "../src/auth/sessions.ts";
import { Registry, type Socket } from "../src/ws/registry.ts";
import { RateLimiter } from "../src/util/ratelimit.ts";
import { authMessage, deviceCertMessage } from "../src/auth/verify.ts";
import { handleMessage, handleOpen, newConnData, type Deps } from "../src/ws/session.ts";
import { ID_LEN, OP, frame, jsonFrame } from "../src/proto/frames.ts";
import { ascii, concat, fromHex, random, toHex } from "../src/util/bytes.ts";

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
    sessions: new SessionStore(3600_000),
    registry: new Registry(),
    authLimiter: new RateLimiter(100, 60_000),
    recoveryLimiter: new RateLimiter(100, 3600_000),
    searchLimiter: new RateLimiter(100, 60_000),
    now: () => Date.now(),
  };
}

function makeIdentity() {
  const idPriv = ed25519.utils.randomPrivateKey();
  const devPriv = ed25519.utils.randomPrivateKey();
  return {
    idPriv,
    devPriv,
    idPub: ed25519.getPublicKey(idPriv),
    devPub: ed25519.getPublicKey(devPriv),
  };
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

/** Хеш считает владелец пропуска; сервер получает только его. */
const hashOf = (pass: Uint8Array) => toHex(sha256(concat(ascii("obsidian-pass-v1"), pass)));

function sendFrame(recipient: Uint8Array) {
  const header = concat(random(ID_LEN), recipient, new Uint8Array([0, 0, 14, 16]));
  return frame(OP.SEND, concat(header, ascii("шифротекст")));
}

test("при политике «пропуска» посторонний не может писать", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const recipient = makeIdentity();
  const sender = makeIdentity();

  const r = register(deps, store, recipient, "recipient");
  handleMessage(deps, r.sock, r.conn, jsonFrame(OP.ACCESS_SET, { dmPolicy: "passes" }));
  assert.equal(r.sock.json(OP.ACCESS_OK).dmPolicy, "passes");

  const s = register(deps, store, sender, "sender");
  handleMessage(deps, s.sock, s.conn, sendFrame(recipient.devPub));

  assert.equal(s.sock.json(OP.ERROR).code, "dm_not_allowed");
  assert.equal(s.sock.has(OP.SEND_OK), false, "конверт не должен встать в очередь");
  assert.equal(store.countPending(recipient.devPub, Date.now()), 0);
  store.close();
});

test("с пропуском писать можно", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const recipient = makeIdentity();
  const sender = makeIdentity();
  const pass = random(32);

  const r = register(deps, store, recipient, "recipient");
  handleMessage(deps, r.sock, r.conn, jsonFrame(OP.ACCESS_SET, { dmPolicy: "passes" }));
  handleMessage(deps, r.sock, r.conn, jsonFrame(OP.PASS_CREATE, { passHash: hashOf(pass) }));

  const s = register(deps, store, sender, "sender");
  handleMessage(deps, s.sock, s.conn,
    jsonFrame(OP.PASS_PRESENT, { recipient: toHex(recipient.devPub), pass: toHex(pass) }));
  assert.equal(s.sock.json(OP.ACCESS_OK).admitted, true);

  s.sock.clear();
  handleMessage(deps, s.sock, s.conn, sendFrame(recipient.devPub));
  assert.ok(s.sock.has(OP.SEND_OK), "конверт обязан пройти");
  assert.equal(store.countPending(recipient.devPub, Date.now()), 1);
  store.close();
});

/** Общий пропуск не должен открывать дорогу ко всем сразу. */
test("пропуск действует только на того, кто его выписал", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const alice = makeIdentity();
  const bob = makeIdentity();
  const sender = makeIdentity();
  const pass = random(32);

  const a = register(deps, store, alice, "alice");
  handleMessage(deps, a.sock, a.conn, jsonFrame(OP.PASS_CREATE, { passHash: hashOf(pass) }));

  const b = register(deps, store, bob, "bob");
  handleMessage(deps, b.sock, b.conn, jsonFrame(OP.ACCESS_SET, { dmPolicy: "passes" }));

  // Пропуск Алисы предъявляем Бобу.
  const s = register(deps, store, sender, "sender");
  handleMessage(deps, s.sock, s.conn,
    jsonFrame(OP.PASS_PRESENT, { recipient: toHex(bob.devPub), pass: toHex(pass) }));
  assert.equal(s.sock.json(OP.ACCESS_OK).admitted, false);

  s.sock.clear();
  handleMessage(deps, s.sock, s.conn, sendFrame(bob.devPub));
  assert.equal(s.sock.json(OP.ERROR).code, "dm_not_allowed");
  store.close();
});

test("одноразовый пропуск гасится после первого предъявления", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const recipient = makeIdentity();
  const pass = random(32);

  const r = register(deps, store, recipient, "recipient");
  handleMessage(deps, r.sock, r.conn,
    jsonFrame(OP.PASS_CREATE, { passHash: hashOf(pass), oneTime: true }));

  const first = register(deps, store, makeIdentity(), "first");
  handleMessage(deps, first.sock, first.conn,
    jsonFrame(OP.PASS_PRESENT, { recipient: toHex(recipient.devPub), pass: toHex(pass) }));
  assert.equal(first.sock.json(OP.ACCESS_OK).admitted, true);

  const second = register(deps, store, makeIdentity(), "second");
  handleMessage(deps, second.sock, second.conn,
    jsonFrame(OP.PASS_PRESENT, { recipient: toHex(recipient.devPub), pass: toHex(pass) }));
  assert.equal(second.sock.json(OP.ACCESS_OK).admitted, false, "второй раз не должен пройти");
  store.close();
});

test("просроченный пропуск не действует", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const recipient = makeIdentity();
  const pass = random(32);

  const r = register(deps, store, recipient, "recipient");
  handleMessage(deps, r.sock, r.conn,
    jsonFrame(OP.PASS_CREATE, { passHash: hashOf(pass), ttlSec: 1 }));

  // Отматываем время вперёд.
  const later = Date.now() + 5000;
  deps.now = () => later;

  const s = register(deps, store, makeIdentity(), "sender");
  handleMessage(deps, s.sock, s.conn,
    jsonFrame(OP.PASS_PRESENT, { recipient: toHex(recipient.devPub), pass: toHex(pass) }));
  assert.equal(s.sock.json(OP.ACCESS_OK).admitted, false);
  store.close();
});

test("отозванный пропуск перестаёт работать", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const recipient = makeIdentity();
  const pass = random(32);

  const r = register(deps, store, recipient, "recipient");
  handleMessage(deps, r.sock, r.conn, jsonFrame(OP.PASS_CREATE, { passHash: hashOf(pass) }));
  r.sock.clear();
  handleMessage(deps, r.sock, r.conn, jsonFrame(OP.PASS_REVOKE, { passHash: hashOf(pass) }));
  assert.equal(r.sock.json(OP.ACCESS_OK).revoked, true);

  const s = register(deps, store, makeIdentity(), "sender");
  handleMessage(deps, s.sock, s.conn,
    jsonFrame(OP.PASS_PRESENT, { recipient: toHex(recipient.devPub), pass: toHex(pass) }));
  assert.equal(s.sock.json(OP.ACCESS_OK).admitted, false);
  store.close();
});

/** Чужой пропуск нельзя отозвать: иначе один пользователь запирал бы другого. */
test("отозвать можно только свой пропуск", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const owner = makeIdentity();
  const pass = random(32);

  const o = register(deps, store, owner, "owner");
  handleMessage(deps, o.sock, o.conn, jsonFrame(OP.PASS_CREATE, { passHash: hashOf(pass) }));

  const stranger = register(deps, store, makeIdentity(), "stranger");
  handleMessage(deps, stranger.sock, stranger.conn, jsonFrame(OP.PASS_REVOKE, { passHash: hashOf(pass) }));
  assert.equal(stranger.sock.json(OP.ACCESS_OK).revoked, false);
  assert.equal(store.countPasses(owner.idPub), 1, "чужой пропуск обязан уцелеть");
  store.close();
});

/** Значение по умолчанию: закрытый мессенджер не запирают дважды. */
test("без политики пишут все", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const recipient = makeIdentity();

  register(deps, store, recipient, "recipient");
  const s = register(deps, store, makeIdentity(), "sender");
  handleMessage(deps, s.sock, s.conn, sendFrame(recipient.devPub));

  assert.ok(s.sock.has(OP.SEND_OK));
  store.close();
});

test("политику и пропуска без входа не тронуть", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const sock = new FakeSocket();
  const conn = newConnData("127.0.0.1");
  handleOpen(deps, sock, conn);

  handleMessage(deps, sock, conn, jsonFrame(OP.ACCESS_SET, { dmPolicy: "passes" }));
  assert.equal(sock.closed?.code, 1008);
  store.close();
});

test("неизвестная политика — битый кадр, а не молчаливое согласие", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const r = register(deps, store, makeIdentity(), "recipient");

  handleMessage(deps, r.sock, r.conn, jsonFrame(OP.ACCESS_SET, { dmPolicy: "как-нибудь" }));
  assert.equal(r.sock.closed?.code, 1002);
  store.close();
});

/**
 * Главное свойство: в базе не должно появиться связи «отправитель → получатель».
 * Сервер видит её транзитно в SEND и обязан о ней забывать.
 */
test("предъявление пропуска не оставляет следов о паре", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const recipient = makeIdentity();
  const sender = makeIdentity();
  const pass = random(32);

  const r = register(deps, store, recipient, "recipient");
  handleMessage(deps, r.sock, r.conn, jsonFrame(OP.ACCESS_SET, { dmPolicy: "passes" }));
  handleMessage(deps, r.sock, r.conn, jsonFrame(OP.PASS_CREATE, { passHash: hashOf(pass) }));

  const s = register(deps, store, sender, "sender");
  handleMessage(deps, s.sock, s.conn,
    jsonFrame(OP.PASS_PRESENT, { recipient: toHex(recipient.devPub), pass: toHex(pass) }));

  // В таблице пропусков есть владелец — и больше ничего.
  assert.equal(store.countPasses(recipient.idPub), 1);
  assert.equal(store.countPasses(sender.idPub), 0, "пропуск не должен приписаться предъявителю");
  store.close();
});

/** Допуск живёт в соединении: новое соединение начинается с нуля. */
test("допуск не переживает переподключение", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const recipient = makeIdentity();
  const sender = makeIdentity();
  const pass = random(32);

  const r = register(deps, store, recipient, "recipient");
  handleMessage(deps, r.sock, r.conn, jsonFrame(OP.ACCESS_SET, { dmPolicy: "passes" }));
  handleMessage(deps, r.sock, r.conn, jsonFrame(OP.PASS_CREATE, { passHash: hashOf(pass) }));

  const first = register(deps, store, sender, "sender");
  handleMessage(deps, first.sock, first.conn,
    jsonFrame(OP.PASS_PRESENT, { recipient: toHex(recipient.devPub), pass: toHex(pass) }));
  handleMessage(deps, first.sock, first.conn, sendFrame(recipient.devPub));
  assert.ok(first.sock.has(OP.SEND_OK));

  // Тот же отправитель, новое соединение — пропуск надо предъявить снова.
  const again = register(deps, store, sender, "sender");
  handleMessage(deps, again.sock, again.conn, sendFrame(recipient.devPub));
  assert.equal(again.sock.json(OP.ERROR).code, "dm_not_allowed");
  store.close();
});
