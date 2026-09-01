/**
 * Почта поддержки.
 *
 * Проверяется главное: письма живут отдельно от мессенджера, панель открыта
 * только владельцу, а отвечать сервер не умеет и не притворяется, что умеет.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";

import { Store } from "../src/db/index.ts";
import { SupportStore } from "../src/support/store.ts";
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
  send(data: Uint8Array): number {
    this.sent.push(data.slice());
    return 1;
  }
  getBufferedAmount(): number { return 0; }
  end(): void {}
  close(): void {}
  json(op: number): any {
    const found = this.sent.find((f) => f[0] === op);
    assert.ok(found, `нет кадра 0x${op.toString(16)}`);
    return JSON.parse(new TextDecoder().decode(found.subarray(1)));
  }
  has(op: number): boolean { return this.sent.some((f) => f[0] === op); }
  clear(): void { this.sent.length = 0; }
}

function makeDeps(store: Store, support: SupportStore): Deps {
  return {
    store,
    support,
    nonces: new NonceStore(30_000),
    registry: new Registry(),
    authLimiter: new RateLimiter(100, 60_000),
    recoveryLimiter: new RateLimiter(100, 3600_000),
    searchLimiter: new RateLimiter(100, 60_000),
    sendLimiter: new RateLimiter(1000, 60_000),
    postLimiter: new RateLimiter(1000, 60_000),
    claimLimiter: new RateLimiter(1000, 3600_000),
    connections: new ConnectionCounter(),
    now: () => Date.now(),
  };
}

function makeIdentity() {
  const idPriv = ed25519.utils.randomPrivateKey();
  const devPriv = ed25519.utils.randomPrivateKey();
  return { idPriv, devPriv, idPub: ed25519.getPublicKey(idPriv), devPub: ed25519.getPublicKey(devPriv) };
}

function connect(deps: Deps, store: Store, id: ReturnType<typeof makeIdentity>, handle: string) {
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
  return { sock, conn };
}

test("письмо заводит переписку и считается непрочитанным", () => {
  const support = new SupportStore(":memory:");
  const thread = support.receive("stranger@example.org", "не приходит код", "жду минуту", Date.now());
  assert.equal(thread.address, "stranger@example.org");
  assert.equal(thread.unread, 1);
  assert.equal(support.unreadCount(), 1);

  // Второе письмо с того же адреса — та же переписка, а не новая.
  support.receive("stranger@example.org", "и ещё", "нашёл сам", Date.now() + 10);
  assert.equal(support.threads(10, 0).length, 1);
  assert.equal(support.messages(thread.id, 10).length, 2);
  support.close();
});

test("панель поддержки закрыта для постороннего", () => {
  const store = new Store(":memory:");
  const support = new SupportStore(":memory:");
  const deps = makeDeps(store, support);
  support.receive("stranger@example.org", "тема", "текст", Date.now());

  process.env.VALANIUM_ADMINS = "";
  const guest = connect(deps, store, makeIdentity(), "guest");
  guest.sock.clear();
  handleMessage(deps, guest.sock, guest.conn, jsonFrame(OP.SUPPORT_GET, {}));

  assert.equal(guest.sock.has(OP.SUPPORT_OK), false, "посторонний не должен видеть письма");
  store.close();
  support.close();
});

test("владелец видит переписку, чтение снимает непрочитанность", () => {
  const store = new Store(":memory:");
  const support = new SupportStore(":memory:");
  const deps = makeDeps(store, support);
  const owner = makeIdentity();
  process.env.VALANIUM_ADMINS = toHex(owner.idPub);

  const thread = support.receive("stranger@example.org", "не приходит код", "жду", Date.now());
  const o = connect(deps, store, owner, "owner");
  o.sock.clear();

  handleMessage(deps, o.sock, o.conn, jsonFrame(OP.SUPPORT_GET, {}));
  const list = o.sock.json(OP.SUPPORT_OK);
  assert.equal(list.threads.length, 1);
  assert.equal(list.threads[0].address, "stranger@example.org");
  assert.equal(list.unreadThreads, 1);
  o.sock.clear();

  handleMessage(deps, o.sock, o.conn, jsonFrame(OP.SUPPORT_GET, { thread: toHex(thread.id) }));
  const one = o.sock.json(OP.SUPPORT_OK);
  assert.equal(one.messages.length, 1);
  assert.equal(support.unreadCount(), 0, "открытая переписка перестаёт быть непрочитанной");

  process.env.VALANIUM_ADMINS = "";
  store.close();
  support.close();
});

test("сервер не принимает попытку ответить", () => {
  const store = new Store(":memory:");
  const support = new SupportStore(":memory:");
  const deps = makeDeps(store, support);
  const owner = makeIdentity();
  process.env.VALANIUM_ADMINS = toHex(owner.idPub);

  const thread = support.receive("stranger@example.org", "тема", "текст", Date.now());
  const o = connect(deps, store, owner, "owner");
  o.sock.clear();

  // Опкода отправки в протоколе нет: почта только принимается, отвечает
  // владелец из своего ящика. Старый клиент, который попробует, должен
  // получить отказ, а не молчание.
  handleMessage(deps, o.sock, o.conn, jsonFrame(0x42, {
    thread: toHex(thread.id),
    body: "ответ, которого протокол не знает",
  }));

  assert.equal(o.sock.has(OP.SUPPORT_OK), false, "отправки в протоколе быть не должно");
  assert.equal(support.messages(thread.id, 10).length, 1, "в базе только входящее");

  process.env.VALANIUM_ADMINS = "";
  store.close();
  support.close();
});

test("старая переписка убирается, непрочитанная остаётся", () => {
  const support = new SupportStore(":memory:");
  const old = Date.now() - 400 * 24 * 3600 * 1000;
  const stale = support.receive("old@example.org", "давно", "текст", old);
  support.markRead(stale.id);
  support.receive("fresh@example.org", "сейчас", "текст", Date.now());
  support.receive("waiting@example.org", "ждёт ответа", "текст", old);

  const removed = support.sweep(Date.now() - 180 * 24 * 3600 * 1000);
  assert.equal(removed, 1, "убирается только прочитанная и старая");
  const left = support.threads(10, 0).map((t) => t.address).sort();
  assert.deepEqual(left, ["fresh@example.org", "waiting@example.org"]);
  support.close();
});
