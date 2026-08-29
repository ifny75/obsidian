/**
 * Запечатанные значок и цвет.
 *
 * Сервер хранит их блобом и не знает, что внутри. Проверяется ровно это: что
 * блоб доезжает обратно неизменным, что открытые поля при нём очищаются и что
 * бесконтрольным местом для хранения чего угодно поле не стало.
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
  latestJson(op: number): any {
    const found = [...this.sent].reverse().find((f) => f[0] === op);
    assert.ok(found, `нет кадра 0x${op.toString(16)}`);
    return JSON.parse(new TextDecoder().decode(found.subarray(1)));
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

function register(deps: Deps, store: Store) {
  const idPriv = ed25519.utils.randomPrivateKey();
  const devPriv = ed25519.utils.randomPrivateKey();
  const idPub = ed25519.getPublicKey(idPriv);
  const devPub = ed25519.getPublicKey(devPriv);

  const sock = new FakeSocket();
  const conn = newConnData("127.0.0.1");
  handleOpen(deps, sock, conn);
  const nonce = fromHex(sock.latestJson(OP.HELLO).nonce, 32);

  const code = toHex(random(12));
  store.createInvite(sha256(ascii(code)), Date.now(), Date.now() + 3600_000);
  handleMessage(deps, sock, conn, jsonFrame(OP.AUTH, {
    v: 1,
    identity: toHex(idPub),
    device: toHex(devPub),
    deviceCert: toHex(ed25519.sign(deviceCertMessage(idPub, devPub), idPriv)),
    sig: toHex(ed25519.sign(authMessage(nonce, idPub, devPub), devPriv)),
    invite: code,
  }));
  assert.ok(sock.has(OP.AUTH_OK), "регистрация не прошла");
  sock.clear();
  return { sock, conn, devPub };
}

/** Похоже на то, что присылает ядро: base64 шифротекста. */
const BLOB = Buffer.from(random(96)).toString("base64");

test("запечатанные украшения возвращаются как есть, открытые при этом гаснут", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mira = register(deps, store);

  // Сначала обычные значения — так делает клиент с правилом «видят все».
  handleMessage(deps, mira.sock, mira.conn, jsonFrame(OP.PROFILE_SET, {
    emblem: "flame",
    color: "coral",
  }));
  assert.equal(mira.sock.latestJson(OP.PROFILE).emblem, "flame");

  // Затем закрытые: блоб приходит вместо них, и открытые поля снимаются.
  mira.sock.clear();
  handleMessage(deps, mira.sock, mira.conn, jsonFrame(OP.PROFILE_SET, {
    decor: BLOB,
    emblem: "none",
    color: "none",
  }));
  const sealed = mira.sock.latestJson(OP.PROFILE);
  assert.equal(sealed.decor, BLOB, "блоб обязан вернуться байт в байт");
  assert.equal(sealed.emblem, null, "открытый значок обязан погаснуть");
  assert.equal(sealed.color, null);
  store.close();
});

test("смена одного цвета не стирает запечатанное", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mira = register(deps, store);

  handleMessage(deps, mira.sock, mira.conn, jsonFrame(OP.PROFILE_SET, { decor: BLOB }));
  mira.sock.clear();

  // Клиент прислал только цвет — блоб трогать нельзя.
  handleMessage(deps, mira.sock, mira.conn, jsonFrame(OP.PROFILE_SET, { color: "violet" }));
  assert.equal(mira.sock.latestJson(OP.PROFILE).decor, BLOB);
  store.close();
});

test("поле не годится для хранения чего угодно", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mira = register(deps, store);

  // Внутрь блоба сервер не смотрит, поэтому проверяет единственное, что может:
  // размер. Иначе это бесплатное место под что угодно.
  handleMessage(deps, mira.sock, mira.conn, jsonFrame(OP.PROFILE_SET, {
    decor: "A".repeat(4096),
  }));
  assert.equal(mira.sock.has(OP.PROFILE), false, "переросший блоб принимать нельзя");
  store.close();
});
