/**
 * Панель владельца.
 *
 * Проверяется три вещи, и все три — про границы власти: панель открывается по
 * ключу личности, а не по имени; постороннему она неотличима от несуществующей;
 * заблокированного не пускают, а владельца заблокировать нельзя.
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

test("панель открывается по ключу личности, а не по имени", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const owner = makeIdentity();
  process.env.VALANIUM_ADMINS = toHex(owner.idPub);

  const o = connect(deps, store, owner, "owner");
  assert.equal(o.sock.json(OP.AUTH_OK).admin, true);
  o.sock.clear();

  handleMessage(deps, o.sock, o.conn, jsonFrame(OP.ADMIN_GET, {}));
  const stats = o.sock.json(OP.ADMIN_OK);
  assert.equal(stats.counts.users, 1);
  assert.ok(stats.counts.queued === 0, "очередь пуста на пустом сервере");

  process.env.VALANIUM_ADMINS = "";
  store.close();
});

test("постороннему панель неотличима от несуществующей", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  process.env.VALANIUM_ADMINS = toHex(makeIdentity().idPub);

  const guest = connect(deps, store, makeIdentity(), "guest");
  assert.equal(guest.sock.json(OP.AUTH_OK).admin, false);
  guest.sock.clear();

  handleMessage(deps, guest.sock, guest.conn, jsonFrame(OP.ADMIN_GET, {}));
  assert.equal(guest.sock.has(OP.ADMIN_OK), false, "чужому статистику отдавать нельзя");
  assert.equal(guest.sock.json(OP.ERROR).code, "unknown_request");

  process.env.VALANIUM_ADMINS = "";
  store.close();
});

test("заблокированного не пускают, владельца заблокировать нельзя", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const owner = makeIdentity();
  const guest = makeIdentity();
  process.env.VALANIUM_ADMINS = toHex(owner.idPub);

  const g = connect(deps, store, guest, "guest");
  assert.ok(g.sock.has(OP.AUTH_OK));

  const o = connect(deps, store, owner, "owner");
  o.sock.clear();
  handleMessage(deps, o.sock, o.conn, jsonFrame(OP.ADMIN_ACTION, {
    action: "block",
    reference: toHex(guest.idPub),
  }));
  assert.equal(o.sock.json(OP.ADMIN_OK).done, "block");

  // Новый заход того же человека упирается в закрытую дверь.
  const again = connect(deps, store, guest, "guest");
  assert.equal(again.sock.has(OP.AUTH_OK), false);
  assert.equal(again.sock.json(OP.AUTH_ERR).code, "blocked");

  o.sock.clear();
  handleMessage(deps, o.sock, o.conn, jsonFrame(OP.ADMIN_ACTION, {
    action: "block",
    reference: toHex(owner.idPub),
  }));
  assert.equal(o.sock.json(OP.ERROR).code, "admin_self", "владелец не должен запирать сам себя");

  o.sock.clear();
  handleMessage(deps, o.sock, o.conn, jsonFrame(OP.ADMIN_ACTION, {
    action: "unblock",
    reference: toHex(guest.idPub),
  }));
  assert.equal(o.sock.json(OP.ADMIN_OK).done, "unblock");
  const back = connect(deps, store, guest, "guest");
  assert.ok(back.sock.has(OP.AUTH_OK), "разблокированный должен снова входить");

  process.env.VALANIUM_ADMINS = "";
  store.close();
});

test("список аккаунтов показывает то, что сервер и правда знает", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const owner = makeIdentity();
  const guest = makeIdentity();
  process.env.VALANIUM_ADMINS = toHex(owner.idPub);

  connect(deps, store, guest, "guest");
  const o = connect(deps, store, owner, "owner");
  o.sock.clear();

  handleMessage(deps, o.sock, o.conn, jsonFrame(OP.ADMIN_GET, {}));
  const report = o.sock.json(OP.ADMIN_OK);
  assert.equal(report.users.length, 2);
  assert.equal(report.more, false);

  const row = report.users.find((u: any) => u.identity === toHex(guest.idPub));
  assert.ok(row, "гость обязан быть в списке");
  assert.ok(row.chatCode.startsWith("OBS-"), "код чата — то, чем владелец узнает человека");
  assert.equal(row.devices, 1);
  assert.equal(row.blocked, false);
  // Юзернейма здесь нет и быть не может: каталог хранит только хеши имён.
  assert.equal("username" in row, false);
  assert.equal(row.hasUsername, false);

  process.env.VALANIUM_ADMINS = "";
  store.close();
});

test("значок и цвет берутся только из списка", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const mira = connect(deps, store, makeIdentity(), "mira");
  mira.sock.clear();

  handleMessage(deps, mira.sock, mira.conn, jsonFrame(OP.PROFILE_SET, {
    emblem: "moon",
    color: "violet",
  }));
  const profile = mira.sock.json(OP.PROFILE);
  assert.equal(profile.emblem, "moon");
  assert.equal(profile.color, "violet");

  // Произвольная строка рядом с чужим именем — не косметика, а способ показать
  // собеседнику что угодно. Такой кадр разбору не подлежит.
  mira.sock.clear();
  handleMessage(deps, mira.sock, mira.conn, jsonFrame(OP.PROFILE_SET, { emblem: "<img>" }));
  assert.ok(mira.sock.closed, "непонятный значок обязан закрыть соединение");
  store.close();
});
