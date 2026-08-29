/**
 * Запечатанный аватар на сервере.
 *
 * Серверу он приходит шифротекстом, и проверять в нём нечего, кроме размера.
 * Проверяется именно это: что такой аватар принимается, что он возвращается
 * байт в байт и что послабление не распространилось на обычные картинки.
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

const SEALED = "application/vnd.obsidian.sealed-avatar";

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
  json(op: number): any {
    const found = this.sent.find((f) => f[0] === op);
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
    claimLimiter: new RateLimiter(1000, 3600_000),
    connections: new ConnectionCounter(),
    now: () => Date.now(),
  };
}

function register(deps: Deps, store: Store, handle: string) {
  const idPriv = ed25519.utils.randomPrivateKey();
  const devPriv = ed25519.utils.randomPrivateKey();
  const idPub = ed25519.getPublicKey(idPriv);
  const devPub = ed25519.getPublicKey(devPriv);

  const sock = new FakeSocket();
  const conn = newConnData("127.0.0.1");
  handleOpen(deps, sock, conn);
  const nonce = fromHex(sock.json(OP.HELLO).nonce, 32);

  const code = toHex(random(12));
  store.createInvite(sha256(ascii(code)), Date.now(), Date.now() + 3600_000);
  handleMessage(deps, sock, conn, jsonFrame(OP.AUTH, {
    v: 1,
    identity: toHex(idPub),
    device: toHex(devPub),
    deviceCert: toHex(ed25519.sign(deviceCertMessage(idPub, devPub), idPriv)),
    sig: toHex(ed25519.sign(authMessage(nonce, idPub, devPub), devPriv)),
    invite: code,
    handle,
  }));
  assert.ok(sock.has(OP.AUTH_OK), "регистрация не прошла");
  sock.clear();
  return { sock, conn, devPub };
}

test("запечатанный аватар принимается и возвращается неизменным", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mira = register(deps, store, "mira");

  // Шифротекст: ни подписи формата, ни чего-либо ещё узнаваемого в нём нет.
  const blob = Buffer.from(random(512)).toString("base64");
  handleMessage(deps, mira.sock, mira.conn, jsonFrame(OP.PROFILE_SET, {
    avatarMime: SEALED,
    avatarBase64: blob,
  }));
  const saved = mira.sock.json(OP.PROFILE);
  assert.equal(saved.avatarMime, SEALED, "тип обязан сохраниться");
  assert.equal(saved.avatarBase64, blob, "блоб обязан вернуться байт в байт");
  store.close();
});

test("обычной картинке подпись формата по-прежнему обязательна", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mira = register(deps, store, "mira");

  // Те же случайные байты, но заявленные как PNG, приниматься не должны:
  // послабление сделано только для шифротекста.
  handleMessage(deps, mira.sock, mira.conn, jsonFrame(OP.PROFILE_SET, {
    avatarMime: "image/png",
    avatarBase64: Buffer.from(random(512)).toString("base64"),
  }));
  assert.equal(mira.sock.has(OP.PROFILE), false, "подделка формата не должна проходить");
  store.close();
});

test("неизвестный тип аватара не принимается", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mira = register(deps, store, "mira");

  handleMessage(deps, mira.sock, mira.conn, jsonFrame(OP.PROFILE_SET, {
    avatarMime: "application/octet-stream",
    avatarBase64: Buffer.from(random(64)).toString("base64"),
  }));
  assert.equal(mira.sock.has(OP.PROFILE), false, "список типов остаётся закрытым");
  store.close();
});
