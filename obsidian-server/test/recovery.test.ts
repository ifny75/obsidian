import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";

import { codeFor, encodeBase32, STEP_SECONDS } from "../src/auth/totp.ts";
import { Store } from "../src/db/index.ts";
import { NonceStore } from "../src/auth/nonce.ts";
import { Registry, type Socket } from "../src/ws/registry.ts";
import { RateLimiter } from "../src/util/ratelimit.ts";
import { ConnectionCounter } from "../src/util/connections.ts";
import { authMessage, deviceCertMessage } from "../src/auth/verify.ts";
import { handleMessage, handleOpen, newConnData, type ConnData, type Deps } from "../src/ws/session.ts";
import { OP, jsonFrame } from "../src/proto/frames.ts";
import { ascii, concat, fromHex, random, toHex } from "../src/util/bytes.ts";

/**
 * Восстановление по логину и паролю — серверная половина.
 *
 * Криптография живёт в obsidian-core/src/passphrase.rs и покрыта там. Здесь
 * важно другое: сервер не должен превращаться в оракул. Он не рассказывает,
 * какие логины заняты, не отдаёт посылку без доказательства и не даёт затереть
 * чужую строку.
 */

const VERIFIER_DOMAIN = ascii("obsidian-recovery-verifier-v1");

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
  has(op: number): boolean {
    return this.sent.some((f) => f[0] === op);
  }
  opcodes(): string {
    return this.sent.map((f) => "0x" + f[0]!.toString(16)).join(",");
  }
  latestJson(op: number): any {
    const frames = this.sent.filter((f) => f[0] === op);
    assert.ok(frames.length > 0, "нет кадра, есть: " + this.opcodes());
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
  return {
    idPriv,
    idPub,
    devPriv,
    devPub,
    cert: ed25519.sign(deviceCertMessage(idPub, devPub), idPriv),
  };
}

function makeDeps(store: Store, recoveryLimit = 1000): Deps {
  return {
    store,
    nonces: new NonceStore(30),
    registry: new Registry(),
    authLimiter: new RateLimiter(1000, 60_000),
    recoveryLimiter: new RateLimiter(recoveryLimit, 3_600_000),
    searchLimiter: new RateLimiter(recoveryLimit, 3_600_000),
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
  const hello = JSON.parse(new TextDecoder().decode(sock.sent[0]!.subarray(1)));
  return { sock, conn, nonce: fromHex(hello.nonce, 32) };
}

function register(deps: Deps, store: Store, id: Identity, handle: string) {
  const { sock, conn, nonce } = connect(deps);
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
  assert.ok(sock.has(OP.AUTH_OK), "регистрация не прошла: " + sock.opcodes());
  return { sock, conn };
}

/** Клиентская половина: сервер видит только эти три непрозрачных значения. */
function sealedBox(loginId: Uint8Array, token: Uint8Array) {
  return {
    loginId: toHex(loginId),
    verifier: toHex(sha256(concat(VERIFIER_DOMAIN, token))),
    sealed: toHex(random(72)),
  };
}

function recoveryGet(loginId: Uint8Array, token: Uint8Array, code?: string): Uint8Array {
  return jsonFrame(OP.RECOVERY_GET, {
    loginId: toHex(loginId),
    token: toHex(token),
    ...(code === undefined ? {} : { code }),
  });
}

test("одноразовый код закрывает выдачу посылки", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const { sock, conn } = register(deps, store, makeIdentity(), "alice");

  const loginId = random(32);
  const token = random(32);
  const secret = random(20);
  const now = deps.now();
  const step = Math.floor(now / 1000 / STEP_SECONDS);

  // Включить второй фактор без подтверждения нельзя: иначе человек запрёт
  // посылку секретом, который его приложение не выдаёт.
  const unproven = { ...sealedBox(loginId, token), totp: encodeBase32(secret) };
  handleMessage(deps, sock, conn, jsonFrame(OP.RECOVERY_SET, unproven));
  assert.equal(sock.latestJson(OP.ERROR).code, "totp_code_wrong");

  const box = { ...unproven, totpCode: codeFor(secret, step) };
  handleMessage(deps, sock, conn, jsonFrame(OP.RECOVERY_SET, box));
  assert.equal(sock.latestJson(OP.RECOVERY_OK).totp, true);

  // Пароль верен, кода нет — посылку не отдаём.
  const first = connect(deps);
  handleMessage(deps, first.sock, first.conn, recoveryGet(loginId, token));
  assert.equal(first.sock.latestJson(OP.ERROR).code, "recovery_totp_required");
  assert.ok(!first.sock.has(OP.RECOVERY_BLOB), "посылка утекла без кода");

  // Код неверный — тоже нет.
  const second = connect(deps);
  handleMessage(deps, second.sock, second.conn, recoveryGet(loginId, token, "000000"));
  assert.ok(!second.sock.has(OP.RECOVERY_BLOB), "посылка утекла с чужим кодом");

  // Верный код из приложения — отдаём.
  const third = connect(deps);
  handleMessage(deps, third.sock, third.conn,
    recoveryGet(loginId, token, codeFor(secret, step)));
  assert.equal(third.sock.latestJson(OP.RECOVERY_BLOB).sealed, box.sealed);
  store.close();
});

test("про второй фактор узнаёт только тот, кто знает пароль", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const { sock, conn } = register(deps, store, makeIdentity(), "alice");

  const loginId = random(32);
  const token = random(32);
  const secret = random(20);
  handleMessage(deps, sock, conn, jsonFrame(OP.RECOVERY_SET, {
    ...sealedBox(loginId, token),
    totp: encodeBase32(secret),
    totpCode: codeFor(secret, Math.floor(deps.now() / 1000 / STEP_SECONDS)),
  }));

  // Неверный пароль — обычный recovery_not_found, без намёка на то, что логин
  // существует и что у него включены коды.
  const stranger = connect(deps);
  handleMessage(deps, stranger.sock, stranger.conn, recoveryGet(loginId, random(32)));
  assert.equal(stranger.sock.latestJson(OP.ERROR).code, "recovery_not_found");
  store.close();
});

test("посылка выдаётся только по верному доказательству", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const { sock, conn } = register(deps, store, makeIdentity(), "alice");

  const loginId = random(32);
  const token = random(32);
  const box = sealedBox(loginId, token);
  handleMessage(deps, sock, conn, jsonFrame(OP.RECOVERY_SET, box));
  assert.ok(sock.has(OP.RECOVERY_OK), "посылка не принята: " + sock.opcodes());

  // Ключей у восстанавливающегося ещё нет — и не должно быть нужно.
  const fresh = connect(deps);
  handleMessage(deps, fresh.sock, fresh.conn, recoveryGet(loginId, token));
  assert.equal(fresh.sock.latestJson(OP.RECOVERY_BLOB).sealed, box.sealed);
  store.close();
});

test("неверное доказательство и чужой логин отвечают одинаково", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const { sock, conn } = register(deps, store, makeIdentity(), "alice");

  const loginId = random(32);
  handleMessage(deps, sock, conn, jsonFrame(OP.RECOVERY_SET, sealedBox(loginId, random(32))));

  const wrongToken = connect(deps);
  handleMessage(deps, wrongToken.sock, wrongToken.conn, recoveryGet(loginId, random(32)));

  const unknownLogin = connect(deps);
  handleMessage(deps, unknownLogin.sock, unknownLogin.conn, recoveryGet(random(32), random(32)));

  // Разные коды означали бы, что по серверу можно перебирать логины.
  assert.equal(wrongToken.sock.latestJson(OP.ERROR).code, "recovery_not_found");
  assert.equal(unknownLogin.sock.latestJson(OP.ERROR).code, "recovery_not_found");
  assert.equal(wrongToken.sock.has(OP.RECOVERY_BLOB), false);
  store.close();
});

test("чужой логин нельзя занять поверх: это лишило бы человека доступа", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);

  const alice = register(deps, store, makeIdentity(), "alice");
  const loginId = random(32);
  const token = random(32);
  handleMessage(deps, alice.sock, alice.conn, jsonFrame(OP.RECOVERY_SET, sealedBox(loginId, token)));
  assert.ok(alice.sock.has(OP.RECOVERY_OK));

  const mallory = register(deps, store, makeIdentity(), "mallory");
  handleMessage(
    deps,
    mallory.sock,
    mallory.conn,
    jsonFrame(OP.RECOVERY_SET, sealedBox(loginId, random(32))),
  );
  assert.equal(mallory.sock.latestJson(OP.ERROR).code, "login_taken");

  // Строка Алисы цела: её доказательство по-прежнему открывает посылку.
  const fresh = connect(deps);
  handleMessage(deps, fresh.sock, fresh.conn, recoveryGet(loginId, token));
  assert.ok(fresh.sock.has(OP.RECOVERY_BLOB), "посылку Алисы затёрли");
  store.close();
});

test("свою посылку можно заменить и убрать", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const { sock, conn } = register(deps, store, makeIdentity(), "alice");

  const first = random(32);
  handleMessage(deps, sock, conn, jsonFrame(OP.RECOVERY_SET, sealedBox(first, random(32))));

  // Смена логина не должна оставлять хвост под старым именем.
  const second = random(32);
  const secondToken = random(32);
  handleMessage(deps, sock, conn, jsonFrame(OP.RECOVERY_SET, sealedBox(second, secondToken)));

  const stale = connect(deps);
  handleMessage(deps, stale.sock, stale.conn, recoveryGet(first, random(32)));
  assert.equal(stale.sock.has(OP.RECOVERY_BLOB), false, "старый логин всё ещё работает");

  handleMessage(deps, sock, conn, jsonFrame(OP.RECOVERY_SET, { clear: true }));

  const afterClear = connect(deps);
  handleMessage(deps, afterClear.sock, afterClear.conn, recoveryGet(second, secondToken));
  assert.equal(afterClear.sock.has(OP.RECOVERY_BLOB), false, "посылка осталась после удаления");
  store.close();
});

test("перебор упирается в ограничитель, а не в стойкость пароля", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store, 3);
  const { sock, conn } = register(deps, store, makeIdentity(), "alice");

  const loginId = random(32);
  const token = random(32);
  handleMessage(deps, sock, conn, jsonFrame(OP.RECOVERY_SET, sealedBox(loginId, token)));

  const attacker = connect(deps);
  const guess = () =>
    handleMessage(deps, attacker.sock, attacker.conn, recoveryGet(loginId, random(32)));

  for (let i = 0; i < 3; i++) guess();
  assert.equal(attacker.sock.latestJson(OP.ERROR).code, "recovery_not_found");

  guess();
  assert.equal(attacker.sock.latestJson(OP.ERROR).code, "recovery_rate_limited");

  // Даже верное доказательство теперь не проходит: окно закрыто для всех.
  handleMessage(deps, attacker.sock, attacker.conn, recoveryGet(loginId, token));
  assert.equal(attacker.sock.has(OP.RECOVERY_BLOB), false);
  store.close();
});

test("RECOVERY_SET без входа не принимается", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const { sock, conn } = connect(deps);

  handleMessage(deps, sock, conn, jsonFrame(OP.RECOVERY_SET, sealedBox(random(32), random(32))));
  assert.equal(sock.closed?.code, 1008, "неаутентифицированный кадр обязан рвать соединение");
  store.close();
});
