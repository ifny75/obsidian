import uWS from "uWebSockets.js";
import type { us_listen_socket } from "uWebSockets.js";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { Store } from "./db/index.ts";
import { NonceStore } from "./auth/nonce.ts";
import { SessionStore } from "./auth/sessions.ts";
import { RateLimiter } from "./util/ratelimit.ts";
import { Registry, type Socket } from "./ws/registry.ts";
import {
  handleClose,
  handleMessage,
  handleOpen,
  newConnData,
  notifyPaid,
  type ConnData,
  type Deps,
} from "./ws/session.ts";
import { registerRoutes, removeBlobFile } from "./http/routes.ts";

const store = new Store(config.dbPath);
const nonces = new NonceStore(config.nonceTtlSec);
const sessions = new SessionStore(config.sessionTtlSec);
const registry = new Registry();
const authLimiter = new RateLimiter(config.maxAuthPerMinutePerIp, 60_000);
const recoveryLimiter = new RateLimiter(config.maxRecoveryPerHour, 3_600_000);
const searchLimiter = new RateLimiter(config.maxSearchPerMinute, 60_000);
const sendLimiter = new RateLimiter(config.maxSendPerMinute, 60_000);
const postLimiter = new RateLimiter(config.maxPostsPerMinute, 60_000);
const now = () => Date.now();

const deps: Deps = {
  store, nonces, sessions, registry,
  authLimiter, recoveryLimiter, searchLimiter, sendLimiter, postLimiter, now,
};

const app = uWS.App();

app.ws<ConnData>("/ws", {
  compression: uWS.DISABLED,
  maxPayloadLength: config.maxFrameBytes,
  idleTimeout: config.idleTimeoutSec,
  maxBackpressure: 8 * 1024 * 1024,
  sendPingsAutomatically: false,

  upgrade: (res, req, context) => {
    // req невалиден после возврата — всё нужное снимаем здесь и сейчас.
    const key = req.getHeader("sec-websocket-key");
    const protocol = req.getHeader("sec-websocket-protocol");
    const extensions = req.getHeader("sec-websocket-extensions");
    // За Cloudflare Tunnel настоящий адрес приходит заголовком. Используется
    // только для счётчика в памяти и никуда не пишется.
    const ip =
      req.getHeader("cf-connecting-ip") ||
      Buffer.from(res.getRemoteAddressAsText()).toString("utf8");
    res.upgrade<ConnData>(newConnData(ip), key, protocol, extensions, context);
  },

  open: (ws) => {
    handleOpen(deps, ws as unknown as Socket, ws.getUserData());
  },

  message: (ws, message, isBinary) => {
    if (!isBinary) {
      ws.end(1003, "binary frames only");
      return;
    }
    // Копия обязательна: ArrayBuffer от uWS невалиден после возврата.
    handleMessage(deps, ws as unknown as Socket, ws.getUserData(), new Uint8Array(message.slice(0)));
  },

  close: (ws) => {
    handleClose(deps, ws as unknown as Socket, ws.getUserData());
  },
});

registerRoutes(app, { store, sessions, now });

// --- наблюдатель за оплатами -------------------------------------------------

let paymentTimer: NodeJS.Timeout | null = null;

/**
 * Платный вход выключен, пока не задан OBSIDIAN_TON_ADDRESS. Модули TON
 * грузятся динамически именно поэтому: при пустом адресе ни ton-lite-client,
 * ни @ton/core не нужны, и сервер поднимается с `npm ci --omit=optional`.
 * Сама логика проверки оплаты никуда не делась и покрыта тестами.
 */
async function startPaymentWatcher(): Promise<void> {
  if (config.ton.address === "") {
    log.info("ton entry disabled, invites only");
    return;
  }
  const [{ LiteChainSource }, { PaymentWatcher }] = await Promise.all([
    import("./ton/source.ts"),
    import("./ton/watcher.ts"),
  ]);

  const watcher = new PaymentWatcher(
    store,
    new LiteChainSource(config.ton.address, config.ton.configUrl),
    (ref) => notifyPaid(deps, ref),
    { toleranceBp: config.ton.toleranceBp },
  );
  let running = false;
  paymentTimer = setInterval(() => {
    // Такты не должны накладываться: лайтсервер бывает медленным.
    if (running) return;
    running = true;
    void watcher.tick(now()).finally(() => {
      running = false;
    });
  }, config.ton.pollSec * 1000);
  paymentTimer.unref();
  log.info("ton entry enabled", { pollSec: config.ton.pollSec });
}

void startPaymentWatcher().catch(() => {
  // Не роняем мессенджер из-за платёжного шлюза: инвайты работают всегда.
  log.error("ton entry failed to start, continuing invite-only");
});

let listenSocket: us_listen_socket | null = null;

app.listen(config.host, config.port, (token) => {
  if (!token) {
    log.error("listen failed", { port: config.port });
    process.exit(1);
  }
  listenSocket = token;
  log.info("obsidian-server up", { port: config.port, heartbeatSec: config.heartbeatSec });
});

const cleanup = setInterval(() => {
  const ts = now();
  for (const id of store.expiredBlobs(ts)) removeBlobFile(id);
  const swept = store.sweep(ts);
  nonces.sweep(ts);
  sessions.sweep(ts);
  authLimiter.sweep(ts);
  recoveryLimiter.sweep(ts);
  searchLimiter.sweep(ts);
  sendLimiter.sweep(ts);
  postLimiter.sweep(ts);
  log.info("sweep", { ...swept, online: registry.onlineDevices });
}, config.cleanupIntervalSec * 1000);
cleanup.unref();

function shutdown(signal: string): void {
  log.info("shutting down", { signal });
  clearInterval(cleanup);
  if (paymentTimer) clearInterval(paymentTimer);
  if (listenSocket) uWS.us_listen_socket_close(listenSocket);
  store.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
