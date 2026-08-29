/**
 * Платный вход. Блокчейн подменён фейковым источником: проверяется логика
 * зачисления и погашения счёта, а не сеть.
 *
 * Конфиг читается на первом импорте, поэтому модули, зависящие от него,
 * подгружаются динамически — после установки переменных окружения.
 */
process.env["OBSIDIAN_TON_ADDRESS"] = "UQD__________________________________________0vo";
process.env["OBSIDIAN_TON_PRICE"] = "3.0";
process.env["OBSIDIAN_TON_TOLERANCE_BP"] = "200";
process.env["OBSIDIAN_LOG"] = "error";

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";

import { Store } from "../src/db/index.ts";
import { NonceStore } from "../src/auth/nonce.ts";
import { Registry, type Socket } from "../src/ws/registry.ts";
import { RateLimiter } from "../src/util/ratelimit.ts";
import { ConnectionCounter } from "../src/util/connections.ts";
import { authMessage, deviceCertMessage } from "../src/auth/verify.ts";
import { fromHex, random, toHex } from "../src/util/bytes.ts";
import type { ChainScan, ChainSource, ChainTransfer } from "../src/ton/source.ts";
import { PaymentWatcher, minAccepted } from "../src/ton/watcher.ts";

const { OP, jsonFrame } = await import("../src/proto/frames.ts");
const { handleMessage, handleOpen, newConnData, notifyPaid } = await import("../src/ws/session.ts");
type Deps = Parameters<typeof handleMessage>[0];

const PRICE_NANO = 3_000_000_000n;

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
    assert.ok(found, `no frame 0x${op.toString(16)}, got ${this.sent.map((f) => "0x" + f[0]!.toString(16))}`);
    return JSON.parse(new TextDecoder().decode(found.subarray(1)));
  }
  has(op: number): boolean {
    return this.sent.some((f) => f[0] === op);
  }
}

class FakeChain implements ChainSource {
  #transfers: ChainTransfer[] = [];
  calls = 0;

  push(comment: string, amountNano: bigint): void {
    this.head += 1;
    this.#transfers.push({ lt: String(this.head), hash: random(32), amountNano, comment });
  }

  /** Транзакции без memo фейк не хранит, поэтому «пустую» пачку задаёт head. */
  head = 0;

  advance(count: number): void {
    this.head += count;
  }

  async scan(cursorLt: string | null): Promise<ChainScan> {
    this.calls += 1;
    const cursor = cursorLt === null ? 0n : BigInt(cursorLt);
    const transfers = this.#transfers.filter((t) => BigInt(t.lt) > cursor);
    const top = Math.max(this.head, this.#transfers.length);
    return { transfers, scanned: transfers.length, cursor: top === 0 ? null : { lt: String(top), hash: random(32) } };
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

function connect(deps: Deps) {
  const sock = new FakeSocket();
  const conn = newConnData("127.0.0.1");
  handleOpen(deps, sock, conn);
  return { sock, conn, nonce: fromHex(sock.json(OP.HELLO).nonce, 32) };
}

function signed(id: ReturnType<typeof makeIdentity>, nonce: Uint8Array, extra: Record<string, unknown> = {}) {
  return {
    v: 1,
    identity: toHex(id.idPub),
    device: toHex(id.devPub),
    deviceCert: toHex(id.cert),
    sig: toHex(ed25519.sign(authMessage(nonce, id.idPub, id.devPub), id.devPriv)),
    ...extra,
  };
}

/** Проходит PAY_REQUEST и возвращает счёт вместе с живым соединением. */
function invoice(deps: Deps, id: ReturnType<typeof makeIdentity>) {
  const { sock, conn, nonce } = connect(deps);
  handleMessage(deps, sock, conn, jsonFrame(OP.PAY_REQUEST, signed(id, nonce)));
  const info = sock.json(OP.PAY_INFO);
  return { sock, conn, info, nonce: fromHex(info.nonce, 32) };
}

test("HELLO объявляет доступные способы входа", () => {
  const store = new Store(":memory:");
  const { sock } = connect(makeDeps(store));
  const hello = sock.json(OP.HELLO);
  assert.deepEqual(hello.entry, { invite: true, ton: true });
  store.close();
});

test("PAY_REQUEST выставляет счёт с адресом, суммой и memo", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const { info } = invoice(deps, makeIdentity());

  assert.match(info.ref, /^[abcdefghijkmnpqrstuvwxyz23456789]{10}$/);
  assert.equal(info.amountNano, PRICE_NANO.toString());
  assert.equal(info.paid, false);
  assert.ok(info.address.length > 0);
  assert.ok(info.nonce, "PAY_INFO обязан выдать новый challenge для AUTH");
  store.close();
});

test("повторный PAY_REQUEST отдаёт тот же счёт, а не новый memo", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const alice = makeIdentity();

  const first = invoice(deps, alice).info;
  const second = invoice(deps, alice).info;

  assert.equal(second.ref, first.ref);
  store.close();
});

test("AUTH по неоплаченному счёту не пускает", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const alice = makeIdentity();
  const { sock, conn, info, nonce } = invoice(deps, alice);

  handleMessage(deps, sock, conn, jsonFrame(OP.AUTH, signed(alice, nonce, { paymentRef: info.ref, handle: "alice" })));

  assert.equal(sock.json(OP.AUTH_ERR).code, "payment_pending");
  assert.equal(sock.has(OP.AUTH_OK), false);
  store.close();
});

test("перевод с нужным memo закрывает счёт и пускает в мессенджер", async () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const chain = new FakeChain();
  const paid: string[] = [];
  const watcher = new PaymentWatcher(store, chain, (ref) => {
    paid.push(ref);
    notifyPaid(deps, ref);
  }, { toleranceBp: 200 });

  const alice = makeIdentity();
  const { sock, conn, info } = invoice(deps, alice);

  chain.push(info.ref, PRICE_NANO);
  assert.equal(await watcher.tick(Date.now()), 1);
  assert.deepEqual(paid, [info.ref]);

  // Клиент, который ждал на сокете, получает PAY_OK без опроса.
  assert.equal(sock.json(OP.PAY_OK).ref, info.ref);

  const nonce = fromHex(sock.json(OP.PAY_INFO).nonce, 32);
  handleMessage(deps, sock, conn, jsonFrame(OP.AUTH, signed(alice, nonce, { paymentRef: info.ref, handle: "alice" })));
  assert.ok(sock.has(OP.AUTH_OK));

  // Счёт погашен: связка «оплата ↔ личность» в БД не остаётся.
  assert.equal(store.getPayment(info.ref), undefined);
  store.close();
});

test("memo с пробелами и в верхнем регистре всё равно засчитывается", async () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const chain = new FakeChain();
  const watcher = new PaymentWatcher(store, chain, () => {}, { toleranceBp: 200 });

  const { info } = invoice(deps, makeIdentity());
  chain.push(`  ${info.ref.toUpperCase()} `, PRICE_NANO);

  assert.equal(await watcher.tick(Date.now()), 1);
  store.close();
});

test("недоплата не закрывает счёт, допуск на комиссию работает", async () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const chain = new FakeChain();
  const watcher = new PaymentWatcher(store, chain, () => {}, { toleranceBp: 200 });

  const low = invoice(deps, makeIdentity()).info;
  chain.push(low.ref, PRICE_NANO / 2n);
  assert.equal(await watcher.tick(Date.now()), 0);
  assert.equal(store.getPayment(low.ref)!.paid_at, null);

  // 99% суммы — в пределах допуска в 2%.
  const edge = invoice(deps, makeIdentity()).info;
  chain.push(edge.ref, (PRICE_NANO * 99n) / 100n);
  assert.equal(await watcher.tick(Date.now()), 1);
  store.close();
});

test("чужой оплаченный счёт не погашается: memo лежит в блокчейне открыто", async () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const chain = new FakeChain();
  const watcher = new PaymentWatcher(store, chain, () => {}, { toleranceBp: 200 });

  const alice = makeIdentity();
  const { info } = invoice(deps, alice);
  chain.push(info.ref, PRICE_NANO);
  await watcher.tick(Date.now());

  // Mallory подсмотрел memo в обозревателе и пробует зайти по нему.
  const mallory = makeIdentity();
  const m = connect(deps);
  handleMessage(deps, m.sock, m.conn, jsonFrame(OP.AUTH, signed(mallory, m.nonce, { paymentRef: info.ref, handle: "mallory" })));

  assert.equal(m.sock.json(OP.AUTH_ERR).code, "payment_invalid");
  assert.equal(m.sock.has(OP.AUTH_OK), false);
  assert.notEqual(store.getPayment(info.ref), undefined, "счёт Алисы обязан уцелеть");
  store.close();
});

test("курсор не даёт зачесть одну транзакцию дважды", async () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const chain = new FakeChain();
  let credited = 0;
  const watcher = new PaymentWatcher(store, chain, () => credited++, { toleranceBp: 200 });

  const { info } = invoice(deps, makeIdentity());
  chain.push(info.ref, PRICE_NANO);

  assert.equal(await watcher.tick(Date.now()), 1);
  assert.equal(await watcher.tick(Date.now()), 0);
  assert.equal(credited, 1);
  store.close();
});

test("посторонние переводы двигают курсор и не ломают проход", async () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const chain = new FakeChain();
  const watcher = new PaymentWatcher(store, chain, () => {}, { toleranceBp: 200 });

  chain.push("привет", PRICE_NANO);
  chain.push("", PRICE_NANO);
  chain.push("zzzzzzzzzz", PRICE_NANO);
  assert.equal(await watcher.tick(Date.now()), 0);

  const { info } = invoice(deps, makeIdentity());
  chain.push(info.ref, PRICE_NANO);
  assert.equal(await watcher.tick(Date.now()), 1);
  store.close();
});

test("счёт нельзя погасить второй раз", async () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const chain = new FakeChain();
  const watcher = new PaymentWatcher(store, chain, () => {}, { toleranceBp: 200 });

  const alice = makeIdentity();
  const { sock, conn, info } = invoice(deps, alice);
  chain.push(info.ref, PRICE_NANO);
  await watcher.tick(Date.now());

  const nonce = fromHex(sock.json(OP.PAY_INFO).nonce, 32);
  handleMessage(deps, sock, conn, jsonFrame(OP.AUTH, signed(alice, nonce, { paymentRef: info.ref, handle: "alice" })));
  assert.ok(sock.has(OP.AUTH_OK));

  // Второе устройство той же личности заходит без счёта — он уже погашен,
  // но identity уже известна, поэтому пропуск не требуется.
  const second = makeIdentity();
  const cert = ed25519.sign(deviceCertMessage(alice.idPub, second.devPub), alice.idPriv);
  const c = connect(deps);
  handleMessage(
    deps,
    c.sock,
    c.conn,
    jsonFrame(OP.AUTH, {
      v: 1,
      identity: toHex(alice.idPub),
      device: toHex(second.devPub),
      deviceCert: toHex(cert),
      sig: toHex(ed25519.sign(authMessage(c.nonce, alice.idPub, second.devPub), second.devPriv)),
    }),
  );
  assert.ok(c.sock.has(OP.AUTH_OK), "второе устройство должно входить без оплаты");
  store.close();
});

test("вход без инвайта и без счёта отклоняется", () => {
  const store = new Store(":memory:");
  const deps = makeDeps(store);
  const { sock, conn, nonce } = connect(deps);

  handleMessage(deps, sock, conn, jsonFrame(OP.AUTH, signed(makeIdentity(), nonce, { handle: "nobody" })));

  assert.equal(sock.json(OP.AUTH_ERR).code, "entry_required");
  store.close();
});

test("minAccepted считает допуск без плавающей точки", () => {
  assert.equal(minAccepted(3_000_000_000n, 200), 2_940_000_000n);
  assert.equal(minAccepted(3_000_000_000n, 0), 3_000_000_000n);
});
