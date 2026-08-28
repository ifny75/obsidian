import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";

import { config } from "../src/config.ts";
import { Store } from "../src/db/index.ts";
import { NonceStore } from "../src/auth/nonce.ts";
import { SessionStore } from "../src/auth/sessions.ts";
import { Registry, type Socket } from "../src/ws/registry.ts";
import { RateLimiter } from "../src/util/ratelimit.ts";
import { ConnectionCounter } from "../src/util/connections.ts";
import { authMessage, deviceCertMessage, verify } from "../src/auth/verify.ts";
import { handleClose, handleMessage, handleOpen, newConnData, type ConnData, type Deps } from "../src/ws/session.ts";
import { ID_LEN, KEY_LEN, OP, frame, jsonFrame } from "../src/proto/frames.ts";
import { ascii, concat, fromHex, random, toHex } from "../src/util/bytes.ts";

class FakeSocket implements Socket {
  readonly sent: Uint8Array[] = [];
  closed: { code: number; reason: string } | null = null;

  send(data: Uint8Array): number {
    this.sent.push(data.slice());
    return 1;
  }
  getBufferedAmount(): number {
    return 0;
  }
  end(code: number, reason = ""): void {
    this.closed = { code, reason };
  }
  close(): void {
    this.closed = { code: 1006, reason: "" };
  }

  /** Первый кадр с данным опкодом, иначе — падаем с внятным сообщением. */
  take(op: number): Uint8Array {
    const found = this.sent.find((f) => f[0] === op);
    assert.ok(found, `no frame with opcode 0x${op.toString(16)}, got ${this.opcodes()}`);
    return found.subarray(1);
  }
  has(op: number): boolean {
    return this.sent.some((f) => f[0] === op);
  }
  opcodes(): string {
    return this.sent.map((f) => `0x${f[0]!.toString(16)}`).join(",");
  }
  json(op: number): any {
    return JSON.parse(new TextDecoder().decode(this.take(op)));
  }
  latestJson(op: number): any {
    const frames = this.sent.filter((f) => f[0] === op);
    assert.ok(frames.length > 0, `no frame with opcode 0x${op.toString(16)}`);
    return JSON.parse(new TextDecoder().decode(frames[frames.length - 1]!.subarray(1)));
  }
}

interface Identity {
  idPriv: Uint8Array;
  idPub: Uint8Array;
  devPriv: Uint8Array;
  devPub: Uint8Array;
  cert: Uint8Array;
}

function makeIdentity(): Identity {
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

function connect(deps: Deps): { sock: FakeSocket; conn: ConnData; nonce: Uint8Array } {
  const sock = new FakeSocket();
  const conn = newConnData("127.0.0.1");
  handleOpen(deps, sock, conn);
  const hello = sock.json(OP.HELLO);
  return { sock, conn, nonce: fromHex(hello.nonce, 32) };
}

function authFrame(id: Identity, nonce: Uint8Array, extra: Record<string, unknown> = {}): Uint8Array {
  return jsonFrame(OP.AUTH, {
    v: 1,
    identity: toHex(id.idPub),
    device: toHex(id.devPub),
    deviceCert: toHex(id.cert),
    sig: toHex(ed25519.sign(authMessage(nonce, id.idPub, id.devPub), id.devPriv)),
    ...extra,
  });
}

function newInvite(store: Store): string {
  const code = toHex(random(12));
  store.createInvite(sha256(ascii(code)), Date.now(), Date.now() + 3600_000);
  return code;
}

/** Регистрирует личность и оставляет соединение живым. */
function register(deps: Deps, store: Store, id: Identity, handle: string) {
  const { sock, conn, nonce } = connect(deps);
  handleMessage(deps, sock, conn, authFrame(id, nonce, { invite: newInvite(store), handle }));
  assert.ok(sock.has(OP.AUTH_OK), `registration failed: ${sock.opcodes()}`);
  return { sock, conn };
}

test("регистрация требует пропуск: инвайт или оплаченный счёт", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const alice = makeIdentity();

  const { sock, conn, nonce } = connect(deps);
  handleMessage(deps, sock, conn, authFrame(alice, nonce, { handle: "alice" }));

  assert.equal(sock.json(OP.AUTH_ERR).code, "entry_required");
  assert.equal(sock.has(OP.AUTH_OK), false);
  store.close();
});

test("инвайт одноразовый", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const code = newInvite(store);

  const alice = makeIdentity();
  const a = connect(deps);
  handleMessage(deps, a.sock, a.conn, authFrame(alice, a.nonce, { invite: code, handle: "alice" }));
  assert.ok(a.sock.has(OP.AUTH_OK));

  const bob = makeIdentity();
  const b = connect(deps);
  handleMessage(deps, b.sock, b.conn, authFrame(bob, b.nonce, { invite: code, handle: "bob" }));
  assert.equal(b.sock.json(OP.AUTH_ERR).code, "invite_invalid");
  store.close();
});

test("подпись чужим ключом отвергается", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const alice = makeIdentity();
  const mallory = makeIdentity();

  const { sock, conn, nonce } = connect(deps);
  const bad = jsonFrame(OP.AUTH, {
    v: 1,
    identity: toHex(alice.idPub),
    device: toHex(alice.devPub),
    deviceCert: toHex(alice.cert),
    // подпись сделана ключом устройства Mallory
    sig: toHex(ed25519.sign(authMessage(nonce, alice.idPub, alice.devPub), mallory.devPriv)),
    invite: newInvite(store),
    handle: "alice",
  });
  handleMessage(deps, sock, conn, bad);

  assert.equal(sock.json(OP.AUTH_ERR).code, "bad_signature");
  store.close();
});

test("сертификат устройства, не подписанный identity-ключом, отвергается", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const alice = makeIdentity();
  const mallory = makeIdentity();
  alice.cert = ed25519.sign(deviceCertMessage(alice.idPub, alice.devPub), mallory.idPriv);

  const { sock, conn, nonce } = connect(deps);
  handleMessage(deps, sock, conn, authFrame(alice, nonce, { invite: newInvite(store), handle: "alice" }));

  assert.equal(sock.json(OP.AUTH_ERR).code, "bad_cert");
  store.close();
});

test("повтор перехваченного AUTH на новом соединении не проходит", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const alice = makeIdentity();

  const { sock, conn, nonce } = connect(deps);
  const replay = authFrame(alice, nonce, { invite: newInvite(store), handle: "alice" });
  handleMessage(deps, sock, conn, replay);
  assert.ok(sock.has(OP.AUTH_OK));

  // У нового соединения свой challenge, поэтому старая подпись под ним не сходится.
  const second = connect(deps);
  handleMessage(deps, second.sock, second.conn, replay);
  assert.equal(second.sock.json(OP.AUTH_ERR).code, "bad_signature");
  assert.equal(second.sock.has(OP.AUTH_OK), false);
  store.close();
});

test("занятый handle не сжигает инвайт, и AUTH_ERR даёт новый challenge", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  register(deps, store, makeIdentity(), "alice");

  const code = newInvite(store);
  const bob = makeIdentity();
  const { sock, conn, nonce } = connect(deps);
  handleMessage(deps, sock, conn, authFrame(bob, nonce, { invite: code, handle: "alice" }));

  const err = sock.json(OP.AUTH_ERR);
  assert.equal(err.code, "handle_taken");

  // Тот же инвайт и то же соединение — вторая попытка с другим именем проходит.
  handleMessage(deps, sock, conn, authFrame(bob, fromHex(err.nonce, 32), { invite: code, handle: "bob" }));
  assert.ok(sock.has(OP.AUTH_OK), `retry failed: ${sock.opcodes()}`);
  store.close();
});

test("доставка онлайн: SEND_OK отправителю, ENVELOPE получателю", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const alice = makeIdentity();
  const bob = makeIdentity();

  const a = register(deps, store, alice, "alice");
  const b = register(deps, store, bob, "bob");

  const clientRef = random(ID_LEN);
  const ciphertext = ascii("ciphertext-blob");
  const ttl = new Uint8Array([0, 0, 0x0e, 0x10]); // 3600 с
  handleMessage(deps, a.sock, a.conn, frame(OP.SEND, concat(clientRef, bob.devPub, ttl, ciphertext)));

  const sendOk = a.sock.take(OP.SEND_OK);
  assert.equal(toHex(sendOk.subarray(0, ID_LEN)), toHex(clientRef));
  const envelopeId = sendOk.subarray(ID_LEN, ID_LEN * 2);

  const delivered = b.sock.take(OP.ENVELOPE);
  assert.equal(toHex(delivered.subarray(0, ID_LEN)), toHex(envelopeId));
  assert.equal(toHex(delivered.subarray(ID_LEN + 8)), toHex(ciphertext));

  // До ACK конверт живёт в очереди.
  assert.equal(store.countPending(bob.devPub, Date.now()), 1);
  handleMessage(deps, b.sock, b.conn, frame(OP.ACK, envelopeId));
  assert.equal(store.countPending(bob.devPub, Date.now()), 0);
  store.close();
});

test("перебор соединений с одного адреса упирается в потолок", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const limit = config.maxConnectionsPerIp;

  const held = [];
  for (let i = 0; i < limit; i += 1) {
    const sock = new FakeSocket();
    const conn = newConnData("198.51.100.4");
    handleOpen(deps, sock, conn);
    assert.equal(sock.closed, null, `соединение ${i} обязано открыться`);
    assert.ok(sock.has(OP.HELLO));
    held.push({ sock, conn });
  }

  const extra = new FakeSocket();
  const extraConn = newConnData("198.51.100.4");
  handleOpen(deps, extra, extraConn);
  assert.equal(extra.closed?.code, 1013);
  // HELLO лишнему не отдаём: перебирающему не нужен ответ, ему нужен наш сокет.
  assert.ok(!extra.has(OP.HELLO));

  // Другой адрес не задет: потолок на адрес, а не на сервер.
  const other = new FakeSocket();
  handleOpen(deps, other, newConnData("203.0.113.9"));
  assert.equal(other.closed, null);

  // Освободили один — место снова есть.
  handleClose(deps, held[0]!.sock, held[0]!.conn);
  const again = new FakeSocket();
  handleOpen(deps, again, newConnData("198.51.100.4"));
  assert.equal(again.closed, null);
  store.close();
});

test("частая отправка упирается в ограничитель", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  // Два письма в окно: третье должно упереться.
  deps.sendLimiter = new RateLimiter(2, 60_000);
  const alice = makeIdentity();
  const bob = makeIdentity();
  const a = register(deps, store, alice, "alice");
  register(deps, store, bob, "bob");

  const letter = () => frame(OP.SEND,
    concat(random(ID_LEN), bob.devPub, new Uint8Array([0, 0, 0x0e, 0x10]), ascii("x")));

  handleMessage(deps, a.sock, a.conn, letter());
  handleMessage(deps, a.sock, a.conn, letter());
  assert.ok(!a.sock.has(OP.ERROR), `первые два письма обязаны пройти: ${a.sock.opcodes()}`);

  handleMessage(deps, a.sock, a.conn, letter());
  assert.equal(a.sock.json(OP.ERROR).code, "send_rate_limited");
  // Третье письмо до очереди не дошло.
  assert.equal(store.countPending(bob.devPub, Date.now()), 2);
  store.close();
});

test("переполненная очередь получателя закрыта для любого отправителя", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const alice = makeIdentity();
  const carol = makeIdentity();
  const bob = makeIdentity();
  const a = register(deps, store, alice, "alice");
  const c = register(deps, store, carol, "carol");
  register(deps, store, bob, "bob");

  // Набиваем очередь Боба напрямую: через SEND это заняло бы тысячи кадров.
  const now = Date.now();
  const limit = config.maxQueuedPerDevice;
  for (let i = 0; i < limit; i += 1) {
    store.enqueue(bob.devPub, ascii(`old-${i}`), now, now + 3_600_000);
  }

  const letter = () => frame(OP.SEND,
    concat(random(ID_LEN), bob.devPub, new Uint8Array([0, 0, 0x0e, 0x10]), ascii("x")));

  handleMessage(deps, a.sock, a.conn, letter());
  assert.equal(a.sock.json(OP.ERROR).code, "recipient_queue_full");

  // И для другого отправителя тоже: потолок считается по получателю, иначе
  // несколько аккаунтов сложатся и обойдут его, оставаясь каждый в своём ведре.
  handleMessage(deps, c.sock, c.conn, letter());
  assert.equal(c.sock.json(OP.ERROR).code, "recipient_queue_full");
  assert.equal(store.countQueued(bob.devPub, now), limit);
  store.close();
});

test("оффлайн-очередь выдаётся при подключении", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const alice = makeIdentity();
  const bob = makeIdentity();

  const a = register(deps, store, alice, "alice");
  const b = register(deps, store, bob, "bob");
  deps.registry.remove(toHex(bob.devPub), b.sock); // Bob ушёл в оффлайн

  handleMessage(
    deps,
    a.sock,
    a.conn,
    frame(OP.SEND, concat(random(ID_LEN), bob.devPub, new Uint8Array([0, 0, 0x0e, 0x10]), ascii("later"))),
  );

  const back = connect(deps);
  handleMessage(deps, back.sock, back.conn, authFrame(bob, back.nonce, {}));
  assert.equal(back.sock.json(OP.AUTH_OK).queued, 1);
  assert.equal(toHex(back.sock.take(OP.ENVELOPE).subarray(ID_LEN + 8)), toHex(ascii("later")));
  assert.ok(back.sock.has(OP.QUEUE_DONE));
  store.close();
});

test("чужой ACK не удаляет конверт", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const alice = makeIdentity();
  const bob = makeIdentity();

  const a = register(deps, store, alice, "alice");
  register(deps, store, bob, "bob");

  handleMessage(
    deps,
    a.sock,
    a.conn,
    frame(OP.SEND, concat(random(ID_LEN), bob.devPub, new Uint8Array([0, 0, 0x0e, 0x10]), ascii("secret"))),
  );
  const envelopeId = a.sock.take(OP.SEND_OK).subarray(ID_LEN, ID_LEN * 2);

  handleMessage(deps, a.sock, a.conn, frame(OP.ACK, envelopeId)); // ACK от Alice
  assert.equal(store.countPending(bob.devPub, Date.now()), 1);
  store.close();
});

test("SEND без аутентификации закрывает соединение", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const { sock, conn } = connect(deps);

  handleMessage(deps, sock, conn, frame(OP.SEND, new Uint8Array(ID_LEN + KEY_LEN + 4 + 1)));

  assert.equal(sock.closed?.code, 1008);
  store.close();
});

test("обрезанный SEND и неизвестный опкод рвут соединение", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const alice = makeIdentity();
  const a = register(deps, store, alice, "alice");

  handleMessage(deps, a.sock, a.conn, frame(OP.SEND, new Uint8Array(4)));
  assert.equal(a.sock.closed?.code, 1002);

  const b = register(deps, store, makeIdentity(), "bob");
  handleMessage(deps, b.sock, b.conn, frame(0x7f));
  assert.equal(b.sock.closed?.code, 1002);
  store.close();
});

test("PING отвечает PONG", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const { sock, conn } = connect(deps);

  handleMessage(deps, sock, conn, frame(OP.PING));

  assert.ok(sock.has(OP.PONG));
  store.close();
});

test("ключи малого порядка отвергаются: их подпись подделает кто угодно", () => {
  // Все девять канонических кодировок точек малого порядка Ed25519.
  const smallOrder = [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0100000000000000000000000000000000000000000000000000000000000000",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  ];

  for (const hex of smallOrder) {
    const key = fromHex(hex, 32);
    assert.equal(verify(new Uint8Array(64), ascii("anything"), key), false, `принят ключ ${hex.slice(0, 8)}`);
    assert.equal(verify(concat(key, new Uint8Array(32)), ascii("anything"), key), false);
  }
});

test("регистрация с ключом из нулей не проходит", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const zeros = new Uint8Array(32);
  const { sock, conn } = connect(deps);

  handleMessage(
    deps,
    sock,
    conn,
    jsonFrame(OP.AUTH, {
      v: 1,
      identity: toHex(zeros),
      device: toHex(zeros),
      deviceCert: toHex(new Uint8Array(64)),
      sig: toHex(new Uint8Array(64)),
      invite: newInvite(store),
      handle: "attacker",
    }),
  );

  assert.equal(sock.json(OP.AUTH_ERR).code, "bad_cert");
  assert.equal(sock.has(OP.AUTH_OK), false);
  store.close();
});

test("утёкший инвайт можно отозвать до использования", () => {
  const store = new Store(":memory:");
  const code = toHex(random(12));
  const hash = sha256(ascii(code));
  store.createInvite(hash, Date.now(), Date.now() + 3600_000);

  assert.equal(store.countInvites(Date.now()), 1);
  assert.equal(store.revokeInvite(hash), true);
  assert.equal(store.countInvites(Date.now()), 0);

  // Отозванный код больше не пропускает.
  assert.equal(store.consumeInvite(hash, Date.now()), false);
  // Повторный отзыв — не ошибка, просто нечего отзывать.
  assert.equal(store.revokeInvite(hash), false);
  store.close();
});

test("профиль выдаёт короткий код, разрешает его в устройство и хранит аватар", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const alice = makeIdentity();
  const a = register(deps, store, alice, "alice");

  const own = a.sock.latestJson(OP.PROFILE);
  assert.match(own.chatCode, /^OBS-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  assert.equal(own.device, toHex(alice.devPub));

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  handleMessage(deps, a.sock, a.conn, jsonFrame(OP.PROFILE_SET, {
    avatarMime: "image/jpeg",
    avatarBase64: jpeg.toString("base64"),
  }));
  assert.equal(a.sock.latestJson(OP.PROFILE).avatarBase64, jpeg.toString("base64"));

  const bob = makeIdentity();
  const b = register(deps, store, bob, "bob");
  handleMessage(deps, b.sock, b.conn, jsonFrame(OP.PROFILE_GET, { query: own.chatCode }));
  const resolved = b.sock.latestJson(OP.PROFILE);
  assert.equal(resolved.device, toHex(alice.devPub));
  assert.equal(resolved.handle, "alice");
  assert.equal(resolved.avatarMime, "image/jpeg");
  store.close();
});

test("отзыв работает и по протухшему коду, в отличие от использования", () => {
  const store = new Store(":memory:");
  const hash = sha256(ascii("expired"));
  store.createInvite(hash, Date.now() - 7200_000, Date.now() - 3600_000);

  // Протухший код не пропускает и не считается живым...
  assert.equal(store.consumeInvite(hash, Date.now()), false);
  assert.equal(store.countInvites(Date.now()), 0);
  // ...но строка в базе есть, и отзыв её убирает.
  assert.equal(store.revokeInvite(hash), true);
  store.close();
});
