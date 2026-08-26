import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2";
import type { HttpRequest, HttpResponse, TemplatedApp } from "uWebSockets.js";
import { config, PROTOCOL_VERSION } from "../config.ts";
import { log } from "../log.ts";
import type { Store } from "../db/index.ts";
import type { SessionStore, Session } from "../auth/sessions.ts";
import { BadInput, ascii, constantTimeEqual, fromHex, random, toHex } from "../util/bytes.ts";
import { MAX_KEY_PACKAGES } from "../ws/session.ts";
import { KEY_LEN, ID_LEN } from "../proto/frames.ts";

const ABORTED = new WeakSet<HttpResponse>();

const STATUS: Record<number, string> = {
  200: "200 OK",
  400: "400 Bad Request",
  401: "401 Unauthorized",
  404: "404 Not Found",
  409: "409 Conflict",
  413: "413 Payload Too Large",
  500: "500 Internal Server Error",
};

export interface HttpDeps {
  store: Store;
  sessions: SessionStore;
  now: () => number;
}

/**
 * CORS-заголовков здесь нет намеренно: клиенты — нативные (Rust-ядро), браузер
 * в цепочке не участвует. Появится `Access-Control-Allow-Origin: *` — это
 * значит, кто-то ходит на сервер не из ядра.
 */
export function registerRoutes(app: TemplatedApp, deps: HttpDeps): void {
  mkdirSync(config.blobDir, { recursive: true });

  app.get("/v1/health", (res) => {
    json(res, 200, { ok: true, v: PROTOCOL_VERSION });
  });

  app.get("/v1/releases/latest", (res) => {
    json(res, 200, {
      channel: "public-beta",
      publishedAt: new Date().toISOString(),
      windows: {
        version: config.releases.windowsVersion,
        url: config.releases.windowsUrl,
      },
      android: {
        version: config.releases.androidVersion,
        url: config.releases.androidUrl,
      },
    }, true);
  });

  app.get("/v1/directory/:identity", (res, req) => {
    const identityHex = req.getParameter(0) ?? "";
    if (!authed(res, req, deps)) return;
    guard(res, () => {
      const identity = fromHex(identityHex, KEY_LEN);
      if (!deps.store.userExists(identity)) return json(res, 404, { error: "not_found" });
      json(res, 200, directory(deps, identity));
    });
  });

  app.get("/v1/handle/:handle", (res, req) => {
    const handle = (req.getParameter(0) ?? "").toLowerCase();
    if (!authed(res, req, deps)) return;
    guard(res, () => {
      const identity = deps.store.resolveHandle(handle);
      if (!identity) return json(res, 404, { error: "not_found" });
      json(res, 200, directory(deps, identity));
    });
  });

  // Загрузка своих MLS KeyPackages. Чужие загружать нельзя — только под своим ключом.
  app.post("/v1/keypackages", (res, req) => {
    const session = authed(res, req, deps);
    if (!session) return;
    readBody(res, 1024 * 1024, (body) => {
      guard(res, () => {
        const parsed = JSON.parse(new TextDecoder().decode(body)) as { packages?: unknown };
        if (!Array.isArray(parsed.packages) || parsed.packages.length === 0) {
          throw new BadInput("packages must be a non-empty array");
        }
        if (parsed.packages.length > 100) throw new BadInput("too many packages");
        const decoded = parsed.packages.map((p) => fromHex(p));
        deps.store.addKeyPackages(session.devicePub, decoded, deps.now(), MAX_KEY_PACKAGES);
        json(res, 200, { stored: decoded.length, total: deps.store.countKeyPackages(session.devicePub) });
      });
    });
  });

  // Забрать один KeyPackage чужого устройства. Выдаётся ровно один раз.
  app.post("/v1/keypackages/:device/claim", (res, req) => {
    const deviceHex = req.getParameter(0) ?? "";
    if (!authed(res, req, deps)) return;
    guard(res, () => {
      const devicePub = fromHex(deviceHex, KEY_LEN);
      const pkg = deps.store.claimKeyPackage(devicePub);
      if (!pkg) return json(res, 409, { error: "no_key_packages" });
      json(res, 200, { keyPackage: toHex(pkg) });
    });
  });

  app.post("/v1/blobs", (res, req) => {
    const session = authed(res, req, deps);
    if (!session) return;
    readBody(res, config.maxBlobBytes, (body) => {
      guard(res, () => {
        if (body.byteLength === 0) throw new BadInput("empty blob");
        const now = deps.now();
        const id = random(ID_LEN);
        // Сервер не знает ни имени файла, ни типа — только непрозрачные байты.
        writeFileSync(blobPath(id), body, { flag: "wx" });
        deps.store.addBlob(id, body.byteLength, now, now + config.blobTtlSec * 1000);
        json(res, 200, { id: toHex(id) });
      });
    });
  });

  app.get("/v1/blobs/:id", (res, req) => {
    const idHex = req.getParameter(0) ?? "";
    if (!authed(res, req, deps)) return;
    guard(res, () => {
      const id = fromHex(idHex, ID_LEN);
      if (!deps.store.blobExists(id, deps.now())) return json(res, 404, { error: "not_found" });
      const path = blobPath(id);
      if (!existsSync(path)) return json(res, 404, { error: "not_found" });
      res.cork(() => {
        res.writeStatus("200 OK");
        res.writeHeader("content-type", "application/octet-stream");
        res.end(readFileSync(path));
      });
    });
  });

  app.post("/v1/admin/invites", (res, req) => {
    const provided = req.getHeader("x-admin-token");
    if (config.adminToken === "" || !safeEqualStrings(provided, config.adminToken)) {
      return json(res, 404, { error: "not_found" });
    }
    guard(res, () => {
      const now = deps.now();
      const code = toHex(random(12));
      // В БД только SHA-256 — сам код существует лишь в этом ответе.
      deps.store.createInvite(sha256(ascii(code)), now, now + config.inviteTtlSec * 1000);
      json(res, 200, { code, expiresAt: now + config.inviteTtlSec * 1000 });
    });
  });

  app.any("/*", (res) => {
    json(res, 404, { error: "not_found" });
  });
}

export function blobPath(id: Uint8Array): string {
  return join(config.blobDir, toHex(id));
}

export function removeBlobFile(id: Uint8Array): void {
  rmSync(blobPath(id), { force: true });
}

function directory(deps: HttpDeps, identity: Uint8Array) {
  return {
    identity: toHex(identity),
    handle: deps.store.getUserHandle(identity),
    devices: deps.store.listDevices(identity).map((d) => ({
      devicePub: toHex(d.device_pub),
      cert: toHex(d.cert),
      keyPackages: deps.store.countKeyPackages(d.device_pub),
    })),
  };
}

/** Заголовки читаются только синхронно: `req` невалиден после возврата. */
function authed(res: HttpResponse, req: HttpRequest, deps: HttpDeps): Session | null {
  const header = req.getHeader("authorization");
  const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
  const session = deps.sessions.get(token, deps.now());
  if (!session) {
    json(res, 401, { error: "unauthorized" });
    return null;
  }
  return session;
}

function guard(res: HttpResponse, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof BadInput || err instanceof SyntaxError) {
      return json(res, 400, { error: "bad_request" });
    }
    log.error("http handler failed");
    json(res, 500, { error: "internal" });
  }
}

function json(res: HttpResponse, status: number, value: unknown, publicCors = false): void {
  if (ABORTED.has(res)) return;
  res.cork(() => {
    res.writeStatus(STATUS[status] ?? `${status}`);
    res.writeHeader("content-type", "application/json");
    if (publicCors) res.writeHeader("access-control-allow-origin", "*");
    res.end(JSON.stringify(value));
  });
}

/**
 * Тело собирается в память с жёстким лимитом. Чанки от uWS невалидны после
 * возврата из колбэка — копируем сразу.
 */
function readBody(res: HttpResponse, maxBytes: number, done: (body: Uint8Array) => void): void {
  const chunks: Uint8Array[] = [];
  let total = 0;
  res.onAborted(() => {
    ABORTED.add(res);
  });
  res.onData((chunk, isLast) => {
    if (ABORTED.has(res)) return;
    total += chunk.byteLength;
    if (total > maxBytes) {
      json(res, 413, { error: "too_large" });
      ABORTED.add(res);
      return;
    }
    chunks.push(new Uint8Array(chunk.slice(0)));
    if (!isLast) return;
    const body = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      body.set(c, off);
      off += c.byteLength;
    }
    done(body);
  });
}

function safeEqualStrings(a: string, b: string): boolean {
  const ab = ascii(a);
  const bb = ascii(b);
  return ab.byteLength === bb.byteLength && constantTimeEqual(ab, bb);
}
