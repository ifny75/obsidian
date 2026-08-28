/**
 * Обмен MLS KeyPackages по сокету. Сервер их не понимает и не обязан —
 * подлинность проверяет клиент, сверяя привязку пакета к ключу устройства.
 * Задача сервера ровно две: не дать залить пакеты за чужое устройство и не
 * выдать один и тот же пакет дважды.
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
import { ConnectionCounter } from "../src/util/connections.ts";
import { authMessage, deviceCertMessage } from "../src/auth/verify.ts";
import { handleMessage, handleOpen, newConnData, type Deps } from "../src/ws/session.ts";
import { ID_LEN, KEY_LEN, OP, frame, jsonFrame } from "../src/proto/frames.ts";
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
    assert.ok(found, `no frame 0x${op.toString(16)}, got ${this.sent.map((f) => "0x" + f[0]!.toString(16))}`);
    return found.subarray(1);
  }
  has(op: number): boolean {
    return this.sent.some((f) => f[0] === op);
  }
  json(op: number): any {
    return JSON.parse(new TextDecoder().decode(this.take(op)));
  }
}

function makeIdentity() {
  const idPriv = ed25519.utils.randomPrivateKey();
  const idPub = ed25519.getPublicKey(idPriv);
  const devPriv = ed25519.utils.randomPrivateKey();
  const devPub = ed25519.getPublicKey(devPriv);
  return { idPriv, idPub, devPriv, devPub, cert: ed25519.sign(deviceCertMessage(idPub, devPub), idPriv) };
}

function makeDeps(store: Store): Deps {
  return {
    store,
    nonces: new NonceStore(30),
    sessions: new SessionStore(3600),
    registry: new Registry(),
    authLimiter: new RateLimiter(1000, 60_000),
    recoveryLimiter: new RateLimiter(1000, 3_600_000),
    searchLimiter: new RateLimiter(1000, 3_600_000),
    sendLimiter: new RateLimiter(1000, 60_000),
    postLimiter: new RateLimiter(1000, 60_000),
    connections: new ConnectionCounter(),
    now: () => Date.now(),
  };
}

/** Регистрирует личность и возвращает живое авторизованное соединение. */
function register(deps: Deps, store: Store, id: ReturnType<typeof makeIdentity>, handle: string) {
  const sock = new FakeSocket();
  const conn = newConnData("127.0.0.1");
  handleOpen(deps, sock, conn);
  const nonce = fromHex(sock.json(OP.HELLO).nonce, 32);

  const code = toHex(random(12));
  store.createInvite(sha256(ascii(code)), Date.now(), Date.now() + 3600_000);

  handleMessage(
    deps,
    sock,
    conn,
    jsonFrame(OP.AUTH, {
      v: 1,
      identity: toHex(id.idPub),
      device: toHex(id.devPub),
      deviceCert: toHex(id.cert),
      sig: toHex(ed25519.sign(authMessage(nonce, id.idPub, id.devPub), id.devPriv)),
      invite: code,
      handle,
    }),
  );
  assert.ok(sock.has(OP.AUTH_OK), "регистрация не прошла");
  return { sock, conn };
}

/** `[[4B len][bytes]]...` */
function publishFrame(...packages: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const pkg of packages) {
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, pkg.byteLength, false);
    parts.push(length, pkg);
  }
  return frame(OP.KEYPKG_PUBLISH, concat(...parts));
}

function claimFrame(clientRef: Uint8Array, devicePub: Uint8Array): Uint8Array {
  return frame(OP.KEYPKG_CLAIM, concat(clientRef, devicePub));
}

/** `[16B clientRef][1B found][keyPackage]` */
function readKeyPackage(body: Uint8Array) {
  return {
    clientRef: body.subarray(0, ID_LEN),
    found: body[ID_LEN] === 1,
    keyPackage: body.subarray(ID_LEN + 1),
  };
}

test("опубликованный пакет выдаётся собеседнику", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const alice = makeIdentity();
  const bob = makeIdentity();

  const b = register(deps, store, bob, "bob");
  handleMessage(deps, b.sock, b.conn, publishFrame(ascii("bob-package-1")));

  const a = register(deps, store, alice, "alice");
  const clientRef = random(ID_LEN);
  handleMessage(deps, a.sock, a.conn, claimFrame(clientRef, bob.devPub));

  const result = readKeyPackage(a.sock.take(OP.KEYPKG));
  assert.equal(toHex(result.clientRef), toHex(clientRef));
  assert.equal(result.found, true);
  assert.equal(new TextDecoder().decode(result.keyPackage), "bob-package-1");
  store.close();
});

test("один пакет выдаётся ровно один раз", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const bob = makeIdentity();

  const b = register(deps, store, bob, "bob");
  handleMessage(deps, b.sock, b.conn, publishFrame(ascii("only-one")));

  const a = register(deps, store, makeIdentity(), "alice");
  handleMessage(deps, a.sock, a.conn, claimFrame(random(ID_LEN), bob.devPub));
  assert.equal(readKeyPackage(a.sock.take(OP.KEYPKG)).found, true);

  // Второй заход: пакет уже израсходован, переиспользование ломало бы FS.
  const c = register(deps, store, makeIdentity(), "carol");
  handleMessage(deps, c.sock, c.conn, claimFrame(random(ID_LEN), bob.devPub));
  assert.equal(readKeyPackage(c.sock.take(OP.KEYPKG)).found, false);
  store.close();
});

test("пакеты кладутся под своё устройство, а не под указанное в кадре", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mallory = makeIdentity();
  const bob = makeIdentity();

  register(deps, store, bob, "bob");
  const m = register(deps, store, mallory, "mallory");
  handleMessage(deps, m.sock, m.conn, publishFrame(ascii("подложный пакет")));

  // Пакет Мэллори ушёл под её собственное устройство, у Боба пусто.
  assert.equal(store.countKeyPackages(bob.devPub), 0);
  assert.equal(store.countKeyPackages(mallory.devPub), 1);
  store.close();
});

test("несколько пакетов одним кадром", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const bob = makeIdentity();

  const b = register(deps, store, bob, "bob");
  handleMessage(deps, b.sock, b.conn, publishFrame(ascii("one"), ascii("two"), ascii("three")));

  assert.equal(store.countKeyPackages(bob.devPub), 3);
  store.close();
});

/**
 * Регрессия. Клиент выкладывает пачку пакетов на каждом входе, и рано или
 * поздно присланное перестаёт помещаться в хранилище. Раньше разбор кадра шёл
 * по остатку места, переполнение считалось битым кадром и соединение
 * закрывалось. Клиент переподключался, снова выкладывал пачку, снова получал
 * закрытие — связь не жила дольше одного захода, очередь конвертов не
 * подтверждалась и стояла намертво.
 */
test("переполнение хранилища не рвёт соединение", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const bob = makeIdentity();
  const b = register(deps, store, bob, "bob");

  // Забиваем хранилище под потолок пачками по десять.
  for (let batch = 0; batch < 10; batch++) {
    const packages = Array.from({ length: 10 }, (_, i) => ascii(`пакет-${batch}-${i}`));
    handleMessage(deps, b.sock, b.conn, publishFrame(...packages));
  }
  assert.equal(store.countKeyPackages(bob.devPub), 100, "потолок обязан удерживаться");
  assert.equal(b.sock.closed, null);

  // Ещё пачка сверх потолка: соединение обязано выжить.
  handleMessage(deps, b.sock, b.conn, publishFrame(ascii("сверх-1"), ascii("сверх-2"), ascii("сверх-3")));

  assert.equal(b.sock.closed, null, "переполнение — не повод закрывать соединение");
  assert.equal(store.countKeyPackages(bob.devPub), 100, "потолок не должен быть превышен");

  // И связь остаётся рабочей: следующий кадр обрабатывается как обычно.
  handleMessage(deps, b.sock, b.conn, frame(OP.PING));
  assert.ok(b.sock.sent.some((f) => f[0] === OP.PONG), "сокет обязан отвечать после переполнения");
  store.close();
});

/** Клиенту нужно знать, сколько уже лежит, иначе он выкладывает пачку впустую. */
test("AUTH_OK сообщает число уже выложенных пакетов", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const bob = makeIdentity();

  const first = register(deps, store, bob, "bob");
  assert.equal(first.sock.json(OP.AUTH_OK).keyPackages, 0);

  handleMessage(deps, first.sock, first.conn, publishFrame(ascii("a"), ascii("b")));

  // Тот же владелец заходит снова: пропуск уже не спрашивается, handle не важен.
  const again = register(deps, store, bob, "bob");
  assert.equal(again.sock.json(OP.AUTH_OK).keyPackages, 2);
  store.close();
});

test("запрос пакетов до аутентификации закрывает соединение", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const sock = new FakeSocket();
  const conn = newConnData("127.0.0.1");
  handleOpen(deps, sock, conn);

  handleMessage(deps, sock, conn, claimFrame(random(ID_LEN), random(KEY_LEN)));

  assert.equal(sock.closed?.code, 1008);
  store.close();
});

test("битые кадры рвут соединение, а не разбираются наугад", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);

  const a = register(deps, store, makeIdentity(), "alice");
  // Заявленная длина больше самого тела.
  const lying = new Uint8Array(6);
  new DataView(lying.buffer).setUint32(0, 0xffff, false);
  handleMessage(deps, a.sock, a.conn, frame(OP.KEYPKG_PUBLISH, lying));
  assert.equal(a.sock.closed?.code, 1002);

  const b = register(deps, store, makeIdentity(), "bob");
  handleMessage(deps, b.sock, b.conn, frame(OP.KEYPKG_CLAIM, random(ID_LEN)));
  assert.equal(b.sock.closed?.code, 1002);

  const c = register(deps, store, makeIdentity(), "carol");
  handleMessage(deps, c.sock, c.conn, frame(OP.KEYPKG_PUBLISH, new Uint8Array()));
  assert.equal(c.sock.closed?.code, 1002);
  store.close();
});

test("запрос к устройству без пакетов отвечает found=0, а не ошибкой", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const a = register(deps, store, makeIdentity(), "alice");

  handleMessage(deps, a.sock, a.conn, claimFrame(random(ID_LEN), random(KEY_LEN)));

  assert.equal(readKeyPackage(a.sock.take(OP.KEYPKG)).found, false);
  assert.equal(a.sock.closed, null);
  store.close();
});
