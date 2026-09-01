import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HttpResponse, TemplatedApp } from "uWebSockets.js";
import { config, PROTOCOL_VERSION } from "../config.ts";
import { toHex } from "../util/bytes.ts";
import { log } from "../log.ts";
import type { SupportStore } from "../support/store.ts";
import { timingSafeEqual } from "node:crypto";

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
 *   /v1/support/inbound   — письмо в поддержку приносит Cloudflare Email Worker,
 *                           а он умеет только HTTPS: сокета у него нет и не
 *                           будет. Путь закрыт общим секретом и ничего не
 *                           отдаёт наружу — только принимает.
 *
 * Админского пути здесь больше нет. Выписывать инвайты снаружи было незачем:
 * то же самое делает `npm run invite` на самой машине, а открытый в интернет
 * эндпоинт, который заводит доступ на сервер, — это дверь, которую приходится
 * стеречь вечно. Дверь, которой нет, стеречь не надо.
 *
 * Вложения, когда до них дойдут руки, поедут кадрами по сокету: предел кадра
 * 1 МиБ, значит нарезкой — а не вторым протоколом поверх HTTP.
 *
 * CORS-заголовков здесь нет намеренно: клиенты — нативные (Rust-ядро), браузер
 * в цепочке не участвует. Появится `Access-Control-Allow-Origin: *` — это
 * значит, кто-то ходит на сервер не из ядра.
 */
export function registerRoutes(app: TemplatedApp, support: SupportStore): void {
  mkdirSync(config.blobDir, { recursive: true });

  /*
    Входящее письмо от Cloudflare Email Worker.
    
    Отвечает одинаково коротко и на успех, и на отказ: подробности здесь — это
    подсказка тому, кто подбирает секрет. По той же причине сравнение токена
    постоянное по времени.
  */
  app.post("/v1/support/inbound", (res, req) => {
    const authorization = req.getHeader("authorization");
    res.onAborted(() => ABORTED.add(res));

    const expected = config.support.inboundToken;
    const received = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (expected.length === 0 || !constantEquals(received, expected)) {
      json(res, 401, { ok: false });
      return;
    }

    readBody(res, config.support.maxBytes, (body) => {
      if (body === null) {
        json(res, 413, { ok: false });
        return;
      }
      let payload: { from?: unknown; subject?: unknown; text?: unknown };
      try {
        payload = JSON.parse(Buffer.from(body).toString("utf8")) as typeof payload;
      } catch {
        json(res, 400, { ok: false });
        return;
      }
      const from = typeof payload.from === "string" ? payload.from.trim().toLowerCase().slice(0, 320) : "";
      const subject = typeof payload.subject === "string" ? payload.subject.trim().slice(0, 200) : "";
      const text = typeof payload.text === "string" ? payload.text.slice(0, config.support.maxBytes) : "";
      if (from.length === 0 || text.length === 0) {
        json(res, 400, { ok: false });
        return;
      }
      support.receive(from, subject || "(без темы)", text, Date.now());
      // Ни адреса, ни темы в журнале: это ровно те данные, ради которых почта
      // и живёт в отдельной базе.
      log.info("support message received");
      json(res, 200, { ok: true });
    });
  });

  app.get("/v1/health", (res) => {
    json(res, 200, { ok: true, v: PROTOCOL_VERSION });
  });

  app.get("/v1/releases/latest", (res) => {
    json(res, 200, releasePayload(), true);
  });

  app.any("/*", (res) => {
    json(res, 404, { error: "not_found" });
  });
}

/*
  Что клиент узнаёт об обновлениях.

  Раньше сервер собирал этот ответ сам из переменных окружения — и значит,
  всякий, кто получил сервер, мог назвать любую версию и любую ссылку. Человек
  скачал бы троян с правильного адреса, и на этом закончилось бы всё
  остальное: и шифрование переписки, и замок приложения.

  Теперь версии и хеши подписаны ключом, которого на сервере нет
  (`deploy/sign-release.mjs`). Манифест отдаётся строкой байт в байт, вместе с
  подписью: подменить его незаметно нельзя, а подменить заметно — значит
  сломать проверку у клиента.

  Прежние поля остаются рядом для уже выпущенных клиентов: они про подпись не
  знают и разбирают именно их.
*/
function releasePayload(): Record<string, unknown> {
  const legacy = {
    channel: "public-beta",
    publishedAt: new Date().toISOString(),
    windows: { version: config.releases.windowsVersion, url: config.releases.windowsUrl },
    android: { version: config.releases.androidVersion, url: config.releases.androidUrl },
  };

  try {
    const signed = JSON.parse(readFileSync(config.releasesFile, "utf8")) as {
      manifest?: unknown;
      signature?: unknown;
    };
    if (typeof signed.manifest !== "string" || typeof signed.signature !== "string") {
      return legacy;
    }
    return { ...legacy, manifest: signed.manifest, signature: signed.signature };
  } catch {
    // Файла нет или он испорчен — отдаём то, что умели раньше. Клиент увидит
    // ответ без подписи и обновление предлагать не станет.
    return legacy;
  }
}

export function blobPath(id: Uint8Array): string {
  return join(config.blobDir, toHex(id));
}

export function removeBlobFile(id: Uint8Array): void {
  rmSync(blobPath(id), { force: true });
}

function constantEquals(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Собирает тело запроса, отдавая null, если оно переросло предел.
 *
 * uWebSockets отдаёт тело кусками и переиспользует буфер, поэтому каждый кусок
 * копируется: сохранить ссылку значило бы получить мусор к моменту сборки.
 */
function readBody(res: HttpResponse, limit: number, done: (body: Uint8Array | null) => void): void {
  const chunks: Buffer[] = [];
  let total = 0;
  res.onData((chunk, isLast) => {
    total += chunk.byteLength;
    if (total > limit) {
      if (!ABORTED.has(res)) done(null);
      ABORTED.add(res);
      return;
    }
    chunks.push(Buffer.from(new Uint8Array(chunk)));
    if (isLast && !ABORTED.has(res)) done(new Uint8Array(Buffer.concat(chunks)));
  });
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
