import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HttpResponse, TemplatedApp } from "uWebSockets.js";
import { config, PROTOCOL_VERSION } from "../config.ts";
import { toHex } from "../util/bytes.ts";

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
 * Осталось два пути, и каждый — по необходимости:
 *   /v1/health           — туннель и мониторинг должны видеть живость без сессии;
 *   /v1/releases/latest   — обновление проверяет клиент, который может быть
 *                           старым и до сокета вообще не дойти.
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
export function registerRoutes(app: TemplatedApp): void {
  mkdirSync(config.blobDir, { recursive: true });

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

function json(res: HttpResponse, status: number, value: unknown, publicCors = false): void {
  if (ABORTED.has(res)) return;
  res.cork(() => {
    res.writeStatus(STATUS[status] ?? `${status}`);
    res.writeHeader("content-type", "application/json");
    if (publicCors) res.writeHeader("access-control-allow-origin", "*");
    res.end(JSON.stringify(value));
  });
}
