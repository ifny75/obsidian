import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2";
import type { HttpResponse, TemplatedApp } from "uWebSockets.js";
import { config, PROTOCOL_VERSION } from "../config.ts";
import { log } from "../log.ts";
import type { Store } from "../db/index.ts";
import type { SessionStore } from "../auth/sessions.ts";
import { BadInput, ascii, constantTimeEqual, random, toHex } from "../util/bytes.ts";

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
 * HTTP здесь ровно столько, сколько нельзя убрать.
 *
 * Всё, что умеет WebSocket, через HTTP больше не доступно: каталог, поиск по
 * имени и KeyPackages были вторым входом к тем же данным — со своей проверкой
 * прав по заголовку сессии, своим разбором тела и своими ошибками. Ядро ими не
 * пользовалось ни разу, а поверхность удваивали. Blob-эндпоинты убраны следом:
 * ядро их тоже не звало, а 16 МиБ на запрос копились в памяти целиком.
 *
 * Осталось три пути, и каждый — по необходимости:
 *   /v1/health           — туннель и мониторинг должны видеть живость без сессии;
 *   /v1/releases/latest   — обновление проверяет клиент, который может быть
 *                           старым и до сокета вообще не дойти;
 *   /v1/admin/invites     — единственный способ выписать инвайт; по WS такой
 *                           команды пока нет.
 *
 * Вложения, когда до них дойдут руки, поедут кадрами по сокету: предел кадра
 * 1 МиБ, значит нарезкой — а не вторым протоколом поверх HTTP.
 *
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


function safeEqualStrings(a: string, b: string): boolean {
  const ab = ascii(a);
  const bb = ascii(b);
  return ab.byteLength === bb.byteLength && constantTimeEqual(ab, bb);
}
