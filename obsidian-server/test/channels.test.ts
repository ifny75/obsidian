/**
 * Каналы — открытая лента, которую ведёт один человек.
 *
 * Проверяется то, на чём такая штука обычно и ломается: писать может только
 * владелец, короткое имя занимается один раз, подписка меняет список, а
 * читателю новый пост приходит сам.
 */
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
  all(op: number): any[] {
    return this.sent.filter((f) => f[0] === op)
      .map((f) => JSON.parse(new TextDecoder().decode(f.subarray(1))));
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
    sendLimiter: new RateLimiter(1000, 60_000),
    postLimiter: new RateLimiter(1000, 60_000),
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
  assert.ok(sock.has(OP.AUTH_OK), "вход не прошёл");
  sock.clear();
  return { sock, conn };
}

function createChannel(deps: Deps, owner: { sock: FakeSocket; conn: any }, handle: string) {
  owner.sock.clear();
  handleMessage(deps, owner.sock, owner.conn, jsonFrame(OP.CHANNEL_CREATE, {
    handle,
    title: "Заметки",
    about: "Открытая лента",
  }));
  return owner.sock.json(OP.CHANNEL_OK).opened;
}

test("частая публикация упирается в ограничитель", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  // Пост живёт вечно, поэтому частота — единственный тормоз.
  deps.postLimiter = new RateLimiter(2, 60_000);
  const owner = connect(deps, store, makeIdentity(), "owner");
  const channel = createChannel(deps, owner, "notes");

  const post = (text: string) => {
    owner.sock.clear();
    handleMessage(deps, owner.sock, owner.conn,
      jsonFrame(OP.CHANNEL_PUBLISH, { channel: channel.id, body: text }));
  };

  post("раз");
  assert.ok(!owner.sock.has(OP.ERROR), "первый пост обязан пройти");
  post("два");
  assert.ok(!owner.sock.has(OP.ERROR), "второй пост обязан пройти");

  post("три");
  assert.equal(owner.sock.json(OP.ERROR).code, "post_rate_limited");
  store.close();
});

test("число каналов на человека ограничено", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const owner = connect(deps, store, makeIdentity(), "owner");

  for (let i = 0; i < config.maxChannelsPerIdentity; i += 1) {
    owner.sock.clear();
    handleMessage(deps, owner.sock, owner.conn,
      jsonFrame(OP.CHANNEL_CREATE, { handle: `feed${i}`, title: "Лента" }));
    assert.ok(!owner.sock.has(OP.ERROR), `канал ${i} обязан завестись`);
  }

  owner.sock.clear();
  handleMessage(deps, owner.sock, owner.conn,
    jsonFrame(OP.CHANNEL_CREATE, { handle: "onemore", title: "Лента" }));
  assert.equal(owner.sock.json(OP.ERROR).code, "channels_full");
  // Занять имя неудавшийся канал не должен.
  assert.equal(store.channelByHandle("onemore"), undefined);
  store.close();
});

test("канал заводится, и владелец сразу его читает", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const owner = connect(deps, store, makeIdentity(), "owner");

  const channel = createChannel(deps, owner, "notes");
  assert.equal(channel.handle, "notes");
  assert.equal(channel.owner, true, "заводивший обязан числиться владельцем");
  assert.equal(channel.subscribed, true, "иначе канал не появится в его списке");

  owner.sock.clear();
  handleMessage(deps, owner.sock, owner.conn, jsonFrame(OP.CHANNEL_LIST, {}));
  assert.equal(owner.sock.json(OP.CHANNEL_OK).channels.length, 1);
  store.close();
});

test("короткое имя занимается один раз", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const first = connect(deps, store, makeIdentity(), "first");
  const second = connect(deps, store, makeIdentity(), "second");

  createChannel(deps, first, "notes");
  second.sock.clear();
  handleMessage(deps, second.sock, second.conn, jsonFrame(OP.CHANNEL_CREATE, {
    handle: "notes",
    title: "Чужие заметки",
  }));
  assert.equal(second.sock.has(OP.CHANNEL_OK), false);
  assert.equal(second.sock.json(OP.ERROR).code, "channel_taken");
  store.close();
});

test("писать может только владелец, читать — подписчик", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const owner = connect(deps, store, makeIdentity(), "owner");
  const reader = connect(deps, store, makeIdentity(), "reader");
  const channel = createChannel(deps, owner, "notes");

  // Посторонний пишет — отказ, и пост не появляется.
  reader.sock.clear();
  handleMessage(deps, reader.sock, reader.conn, jsonFrame(OP.CHANNEL_PUBLISH, {
    channel: channel.id,
    body: "чужой пост",
  }));
  assert.equal(reader.sock.json(OP.ERROR).code, "channel_not_writer");

  owner.sock.clear();
  handleMessage(deps, owner.sock, owner.conn, jsonFrame(OP.CHANNEL_PUBLISH, {
    channel: channel.id,
    body: "первый пост",
  }));
  assert.equal(owner.sock.json(OP.CHANNEL_OK).published.body, "первый пост");

  reader.sock.clear();
  handleMessage(deps, reader.sock, reader.conn, jsonFrame(OP.CHANNEL_FEED, { channel: channel.id }));
  const feed = reader.sock.json(OP.CHANNEL_OK);
  assert.equal(feed.posts.length, 1, "лента открыта всем, а не только подписчикам");
  assert.equal(feed.posts[0].body, "первый пост");
  assert.equal(feed.channel.owner, false, "читатель не владелец");
  store.close();
});

test("подписка добавляет канал в список и приносит новые посты", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const owner = connect(deps, store, makeIdentity(), "owner");
  const reader = connect(deps, store, makeIdentity(), "reader");
  const channel = createChannel(deps, owner, "notes");

  reader.sock.clear();
  handleMessage(deps, reader.sock, reader.conn, jsonFrame(OP.CHANNEL_SUB, {
    channel: channel.id,
    subscribe: true,
  }));
  assert.equal(reader.sock.json(OP.CHANNEL_OK).channels.length, 1);

  // Пост уходит подписчику сам, без запроса ленты.
  reader.sock.clear();
  handleMessage(deps, owner.sock, owner.conn, jsonFrame(OP.CHANNEL_PUBLISH, {
    channel: channel.id,
    body: "свежая запись",
  }));
  const pushed = reader.sock.json(OP.CHANNEL_POST);
  assert.equal(pushed.post.body, "свежая запись");
  assert.equal(pushed.handle, "notes");

  // Отписка убирает канал из списка.
  reader.sock.clear();
  handleMessage(deps, reader.sock, reader.conn, jsonFrame(OP.CHANNEL_SUB, {
    channel: channel.id,
    subscribe: false,
  }));
  assert.equal(reader.sock.json(OP.CHANNEL_OK).channels.length, 0);
  store.close();
});

test("канал находится по короткому имени, а владелец не может отписаться от себя", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const owner = connect(deps, store, makeIdentity(), "owner");
  const reader = connect(deps, store, makeIdentity(), "reader");
  const channel = createChannel(deps, owner, "notes");

  reader.sock.clear();
  handleMessage(deps, reader.sock, reader.conn, jsonFrame(OP.CHANNEL_FIND, { handle: "@notes" }));
  const found = reader.sock.json(OP.CHANNEL_OK).found;
  assert.equal(found.id, channel.id);
  assert.equal(found.subscribed, false);

  reader.sock.clear();
  handleMessage(deps, reader.sock, reader.conn, jsonFrame(OP.CHANNEL_FIND, { handle: "nosuch" }));
  assert.equal(reader.sock.json(OP.CHANNEL_OK).found, null);

  owner.sock.clear();
  handleMessage(deps, owner.sock, owner.conn, jsonFrame(OP.CHANNEL_SUB, {
    channel: channel.id,
    subscribe: false,
  }));
  assert.equal(owner.sock.json(OP.ERROR).code, "channel_owner_stays");
  store.close();
});

test("канал закрывается владельцем, и посты уходят вместе с ним", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const owner = connect(deps, store, makeIdentity(), "owner");
  const reader = connect(deps, store, makeIdentity(), "reader");
  const channel = createChannel(deps, owner, "notes");

  handleMessage(deps, reader.sock, reader.conn, jsonFrame(OP.CHANNEL_SUB, {
    channel: channel.id, subscribe: true,
  }));
  handleMessage(deps, owner.sock, owner.conn, jsonFrame(OP.CHANNEL_PUBLISH, {
    channel: channel.id, body: "запись",
  }));

  // Посторонний закрыть канал не может.
  reader.sock.clear();
  handleMessage(deps, reader.sock, reader.conn, jsonFrame(OP.CHANNEL_DELETE, {
    channel: channel.id,
  }));
  assert.equal(reader.sock.json(OP.ERROR).code, "channel_not_owner");

  owner.sock.clear();
  handleMessage(deps, owner.sock, owner.conn, jsonFrame(OP.CHANNEL_DELETE, {
    channel: channel.id,
  }));
  assert.equal(owner.sock.json(OP.CHANNEL_OK).closed, channel.id);
  assert.equal(owner.sock.json(OP.CHANNEL_OK).channels.length, 0);

  // Ленты больше нет — вместе с подписками и постами.
  owner.sock.clear();
  handleMessage(deps, owner.sock, owner.conn, jsonFrame(OP.CHANNEL_FEED, { channel: channel.id }));
  assert.equal(owner.sock.json(OP.ERROR).code, "channel_missing");
  store.close();
});

test("владелец убирает свой пост, посторонний — нет", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const owner = connect(deps, store, makeIdentity(), "owner");
  const stranger = connect(deps, store, makeIdentity(), "stranger");
  const channel = createChannel(deps, owner, "notes");

  owner.sock.clear();
  handleMessage(deps, owner.sock, owner.conn, jsonFrame(OP.CHANNEL_PUBLISH, {
    channel: channel.id,
    body: "запись",
  }));
  const post = owner.sock.json(OP.CHANNEL_OK).published;

  stranger.sock.clear();
  handleMessage(deps, stranger.sock, stranger.conn, jsonFrame(OP.CHANNEL_DELETE_POST, {
    channel: channel.id,
    post: post.id,
  }));
  assert.equal(stranger.sock.json(OP.ERROR).code, "channel_not_owner");

  owner.sock.clear();
  handleMessage(deps, owner.sock, owner.conn, jsonFrame(OP.CHANNEL_DELETE_POST, {
    channel: channel.id,
    post: post.id,
  }));
  assert.equal(owner.sock.json(OP.CHANNEL_OK).removed, post.id);

  owner.sock.clear();
  handleMessage(deps, owner.sock, owner.conn, jsonFrame(OP.CHANNEL_FEED, { channel: channel.id }));
  assert.equal(owner.sock.json(OP.CHANNEL_OK).posts.length, 0);
  store.close();
});

test("редакция канала: позванный пишет, остальные читают", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const owner = connect(deps, store, makeIdentity(), "owner");
  const writer = connect(deps, store, makeIdentity(), "writer");
  const reader = connect(deps, store, makeIdentity(), "reader");
  const channel = createChannel(deps, owner, "notes");

  // Пока не позвали — пишет только владелец.
  writer.sock.clear();
  handleMessage(deps, writer.sock, writer.conn, jsonFrame(OP.CHANNEL_PUBLISH, {
    channel: channel.id, body: "рано",
  }));
  assert.equal(writer.sock.json(OP.ERROR).code, "channel_not_writer");

  // Состав редакции меняет только владелец.
  reader.sock.clear();
  handleMessage(deps, reader.sock, reader.conn, jsonFrame(OP.CHANNEL_ADMIN, {
    channel: channel.id, who: store.ensureProfile(writer.conn.identity!, Date.now()).chat_code,
  }));
  assert.equal(reader.sock.json(OP.ERROR).code, "channel_not_owner");

  owner.sock.clear();
  handleMessage(deps, owner.sock, owner.conn, jsonFrame(OP.CHANNEL_ADMIN, {
    channel: channel.id, who: store.ensureProfile(writer.conn.identity!, Date.now()).chat_code,
  }));
  assert.equal(owner.sock.json(OP.CHANNEL_OK).updated.admins.length, 1);

  writer.sock.clear();
  handleMessage(deps, writer.sock, writer.conn, jsonFrame(OP.CHANNEL_PUBLISH, {
    channel: channel.id, body: "теперь можно",
  }));
  assert.equal(writer.sock.json(OP.CHANNEL_OK).published.body, "теперь можно");

  // Позванный пишет, но каналом не распоряжается.
  writer.sock.clear();
  handleMessage(deps, writer.sock, writer.conn, jsonFrame(OP.CHANNEL_UPDATE, {
    channel: channel.id, title: "Моё теперь",
  }));
  assert.equal(writer.sock.json(OP.ERROR).code, "channel_not_owner");

  // И его можно убрать обратно в читатели.
  owner.sock.clear();
  handleMessage(deps, owner.sock, owner.conn, jsonFrame(OP.CHANNEL_ADMIN, {
    channel: channel.id, who: store.ensureProfile(writer.conn.identity!, Date.now()).chat_code,
    admin: false,
  }));
  assert.equal(owner.sock.json(OP.CHANNEL_OK).updated.admins.length, 0);
  writer.sock.clear();
  handleMessage(deps, writer.sock, writer.conn, jsonFrame(OP.CHANNEL_PUBLISH, {
    channel: channel.id, body: "уже нельзя",
  }));
  assert.equal(writer.sock.json(OP.ERROR).code, "channel_not_writer");
  store.close();
});

test("владелец меняет название и значок, читатели узнают", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const owner = connect(deps, store, makeIdentity(), "owner");
  const reader = connect(deps, store, makeIdentity(), "reader");
  const channel = createChannel(deps, owner, "notes");
  handleMessage(deps, reader.sock, reader.conn, jsonFrame(OP.CHANNEL_SUB, {
    channel: channel.id, subscribe: true,
  }));

  reader.sock.clear();
  owner.sock.clear();
  const icon = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  handleMessage(deps, owner.sock, owner.conn, jsonFrame(OP.CHANNEL_UPDATE, {
    channel: channel.id, title: "Тетрадь", about: "Стало короче",
    icon: { mime: "image/png", base64: icon },
  }));
  const updated = owner.sock.json(OP.CHANNEL_OK).updated;
  assert.equal(updated.title, "Тетрадь");
  assert.equal(updated.iconBase64, icon);
  // Имя канала не менялось: на нём держится ссылка.
  assert.equal(updated.handle, "notes");
  assert.equal(reader.sock.json(OP.CHANNEL_OK).updated.title, "Тетрадь");

  // Значок снимается явным null, а не отсутствием поля.
  owner.sock.clear();
  handleMessage(deps, owner.sock, owner.conn, jsonFrame(OP.CHANNEL_UPDATE, {
    channel: channel.id, icon: null,
  }));
  assert.equal(owner.sock.json(OP.CHANNEL_OK).updated.iconBase64, null);
  assert.equal(owner.sock.json(OP.CHANNEL_OK).updated.title, "Тетрадь");
  store.close();
});
