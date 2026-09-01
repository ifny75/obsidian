import uWS from "uWebSockets.js";
import type { us_listen_socket } from "uWebSockets.js";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { Store } from "./db/index.ts";
import { NonceStore } from "./auth/nonce.ts";
import { RateLimiter } from "./util/ratelimit.ts";
import {
  ConnectionCounter, ONION_KEY, blindedClient, clientAddress, isOnion, limitKey,
} from "./util/connections.ts";
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
import { SupportStore } from "./support/store.ts";

const store = new Store(config.dbPath);
const support = new SupportStore(config.support.dbPath);
const nonces = new NonceStore(config.nonceTtlSec, config.maxOutstandingNonces);
const registry = new Registry();
const authLimiter = new RateLimiter(config.maxAuthPerMinutePerIp, 60_000, config.maxRateLimitKeys);
const recoveryLimiter = new RateLimiter(config.maxRecoveryPerHour, 3_600_000, config.maxRateLimitKeys);
const searchLimiter = new RateLimiter(config.maxSearchPerMinute, 60_000, config.maxRateLimitKeys);
const sendLimiter = new RateLimiter(config.maxSendPerMinute, 60_000, config.maxRateLimitKeys);
const postLimiter = new RateLimiter(config.maxPostsPerMinute, 60_000, config.maxRateLimitKeys);
const claimLimiter = new RateLimiter(config.maxClaimsPerHour, 3_600_000, config.maxRateLimitKeys);
const connections = new ConnectionCounter();
const now = () => Date.now();

const deps: Deps = {
  store, support, nonces, registry,
  authLimiter, recoveryLimiter, searchLimiter, sendLimiter, postLimiter, claimLimiter,
  connections, now,
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
    /*
      За Cloudflare Tunnel настоящий адрес приходит заголовком. Используется
      только для счётчиков в памяти и никуда не пишется.

      Заголовку верим не всегда: поставить `CF-Connecting-IP` может кто угодно,
      кто дотянулся до сервера мимо туннеля, и тогда он назначает себе любой
      адрес — а все ограничители по IP превращаются в украшение. Верим только
      тому, кто пришёл с петли: cloudflared ходит именно оттуда. Кто пришёл
      иначе — учитывается по своему настоящему адресу, что бы он о себе ни
      написал.
    */
    const peer = Buffer.from(res.getRemoteAddressAsText()).toString("utf8");

    /*
      Вход через Tor считается отдельно, и это не поблажка, а необходимость.

      Adресa у такого соединения нет: за onion-входом не стоит Cloudflare,
      которому можно верить, и заголовок с адресом там обнуляет наш же nginx —
      иначе клиент назначал бы себе любой IP и обходил все лимиты разом, а заодно
      приписывал бы свой трафик чужому адресу. Взамен все соединения из Tor
      делят один ключ и свои, отдельные потолки.
    */
    const onion = isOnion(peer, req.getHeader("x-valanium-route"), config.trustedProxies);
    // Жетон вместо адреса. Схлопывание IPv6 до /64 сделано на узле, до
    // хеширования: иначе владелец подсети получал бы новый жетон на каждый
    // адрес и обходил любой потолок, ни разу его не превысив.
    const blinded = blindedClient(peer, req.getHeader("x-valanium-client"), config.trustedProxies);
    const ip = onion
      ? ONION_KEY
      : blinded
      // Прямое соединение мимо узла — считаем по настоящему адресу, как раньше.
      ?? limitKey(clientAddress(peer, req.getHeader("cf-connecting-ip"), config.trustedProxies));

    res.upgrade<ConnData>(newConnData(ip, onion), key, protocol, extensions, context);
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

registerRoutes(app, support);

// --- наблюдатель за оплатами -------------------------------------------------

let paymentTimer: NodeJS.Timeout | null = null;

/**
 * Платный вход выключен, пока не задан VALANIUM_TON_ADDRESS. Модули TON
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
  log.info("valanium-server up", { port: config.port, heartbeatSec: config.heartbeatSec });
});

const cleanup = setInterval(() => {
  const ts = now();
  for (const id of store.expiredBlobs(ts)) removeBlobFile(id);
  const swept = store.sweep(ts, ts - config.channelPostTtlSec * 1000);
  support.sweep(ts - config.support.ttlSec * 1000);
  nonces.sweep(ts);
  authLimiter.sweep(ts);
  recoveryLimiter.sweep(ts);
  searchLimiter.sweep(ts);
  sendLimiter.sweep(ts);
  postLimiter.sweep(ts);
  log.info("sweep", { ...swept, online: registry.onlineDevices, addresses: connections.addresses });
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
