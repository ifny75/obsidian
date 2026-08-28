/**
 * End-to-end проверка живого сервера: поднимает процесс, проходит регистрацию
 * по инвайту через настоящий WebSocket, шлёт конверт себе и подтверждает его.
 *
 *   npm run smoke
 *
 * Юнит-тесты дёргают обработчики напрямую и не покрывают обвязку uWS —
 * upgrade, бинарные фреймы, HTTP-роуты. Это покрывает.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";

import { authMessage, deviceCertMessage } from "../src/auth/verify.ts";
import { ID_LEN, OP } from "../src/proto/frames.ts";
import { concat, fromHex, random, toHex } from "../src/util/bytes.ts";

const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = toHex(random(16));
const dataDir = mkdtempSync(join(tmpdir(), "obsidian-smoke-"));

const server = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "index.ts")], {
  env: {
    ...process.env,
    OBSIDIAN_PORT: String(PORT),
    OBSIDIAN_DB: join(dataDir, "smoke.db"),
    OBSIDIAN_BLOBS: join(dataDir, "blobs"),
    OBSIDIAN_ADMIN_TOKEN: ADMIN,
  },
  stdio: ["ignore", "pipe", "inherit"],
});

// --- утилиты -----------------------------------------------------------------

class Frames {
  readonly #queue: Uint8Array[] = [];
  readonly #waiters: (() => void)[] = [];

  constructor(ws: WebSocket) {
    ws.onmessage = (ev) => {
      this.#queue.push(new Uint8Array(ev.data as ArrayBuffer));
      this.#waiters.shift()?.();
    };
  }

  async frame(op: number, timeoutMs = 5000): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.#queue.findIndex((f) => f[0] === op);
      if (idx >= 0) return this.#queue.splice(idx, 1)[0]!.subarray(1);
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for 0x${op.toString(16)}; got ${this.#queue.map((f) => "0x" + f[0]!.toString(16))}`);
      }
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  async json(op: number): Promise<any> {
    return JSON.parse(new TextDecoder().decode(await this.frame(op)));
  }
}

function jsonFrame(op: number, value: unknown): Uint8Array {
  return concat(new Uint8Array([op]), new TextEncoder().encode(JSON.stringify(value)));
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/v1/health`);
      if (res.ok) return;
    } catch {
      // сервер ещё поднимается
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}


async function post<T>(path: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(BASE + path, { method: "POST", headers });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return (await res.json()) as T;
}


const steps: string[] = [];
function ok(label: string): void {
  steps.push(label);
  process.stdout.write(`  ok  ${label}\n`);
}

try {
  await waitForHealth();
  ok("health отвечает");

  const invite = await post<{ code: string }>("/v1/admin/invites", { "x-admin-token": ADMIN });
  ok("инвайт выпущен");

  const notFound = await fetch(`${BASE}/v1/admin/invites`, { method: "POST" });
  assert.equal(notFound.status, 404, "админский путь без токена обязан отдавать 404");
  ok("админский путь без токена скрыт");

  const idPriv = ed25519.utils.randomPrivateKey();
  const idPub = ed25519.getPublicKey(idPriv);
  const devPriv = ed25519.utils.randomPrivateKey();
  const devPub = ed25519.getPublicKey(devPriv);
  const cert = ed25519.sign(deviceCertMessage(idPub, devPub), idPriv);

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.binaryType = "arraybuffer";
  const inbox = new Frames(ws);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws connect failed"));
  });

  const hello = await inbox.json(OP.HELLO);
  assert.equal(hello.v, 1);
  ok(`HELLO получен, heartbeat=${hello.heartbeatSec}s`);

  const nonce = fromHex(hello.nonce, 32);
  ws.send(
    jsonFrame(OP.AUTH, {
      v: 1,
      identity: toHex(idPub),
      device: toHex(devPub),
      deviceCert: toHex(cert),
      sig: toHex(ed25519.sign(authMessage(nonce, idPub, devPub), devPriv)),
      invite: invite.code,
      handle: "smoke",
    }),
  );
  const authOk = await inbox.json(OP.AUTH_OK);
  ok(`AUTH_OK, queued=${authOk.queued}`);

  ws.send(new Uint8Array([OP.PING]));
  await inbox.frame(OP.PONG);
  ok("PING/PONG");

  const clientRef = random(ID_LEN);
  const ciphertext = random(512);
  ws.send(
    concat(new Uint8Array([OP.SEND]), clientRef, devPub, new Uint8Array([0, 0, 0x0e, 0x10]), ciphertext),
  );
  const sendOk = await inbox.frame(OP.SEND_OK);
  assert.equal(toHex(sendOk.subarray(0, ID_LEN)), toHex(clientRef));
  const envelopeId = sendOk.subarray(ID_LEN, ID_LEN * 2);
  ok("SEND_OK с нашим clientRef");

  const envelope = await inbox.frame(OP.ENVELOPE);
  assert.equal(toHex(envelope.subarray(0, ID_LEN)), toHex(envelopeId));
  assert.equal(toHex(envelope.subarray(ID_LEN + 8)), toHex(ciphertext), "шифротекст доехал байт в байт");
  ok("ENVELOPE доставлен без искажений");

  ws.send(concat(new Uint8Array([OP.ACK]), envelopeId));

  // Каталог, KeyPackages и blob-эндпоинты убраны: всё это умеет сокет, а по
  // HTTP было вторым входом к тем же данным. Проверяем, что их правда нет —
  // иначе они однажды вернутся незамеченными вместе с чужим патчем.
  for (const path of [
    `/v1/directory/${toHex(idPub)}`,
    "/v1/handle/alice",
    "/v1/keypackages",
    `/v1/blobs/${toHex(random(16))}`,
  ]) {
    const gone = await fetch(`${BASE}${path}`, {
      headers: { authorization: `Bearer ${authOk.token}` },
    });
    assert.equal(gone.status, 404, `${path} обязан отсутствовать`);
  }
  ok("HTTP-двойники сокета убраны");

  ws.close();
  process.stdout.write(`\nsmoke: ${steps.length} проверок пройдено\n`);
} catch (err) {
  process.exitCode = 1;
  process.stderr.write(`
smoke FAILED: ${err instanceof Error ? err.stack : String(err)}
`);
} finally {
  // Сначала дожидаемся смерти процесса: он держит файл БД, и rmSync иначе
  // упадёт с EPERM, замаскировав настоящую ошибку.
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  server.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

