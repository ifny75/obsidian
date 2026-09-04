import { sha256 } from "@noble/hashes/sha2";
import { config, PROTOCOL_VERSION } from "../config.ts";
import { log } from "../log.ts";
import type { Store } from "../db/index.ts";
import type { SupportStore } from "../support/store.ts";
import type { NonceStore } from "../auth/nonce.ts";
import { authMessage, deviceCertMessage, revokeOtherDevicesMessage, verify } from "../auth/verify.ts";
import type { RateLimiter } from "../util/ratelimit.ts";
import { decodeBase32, verify as verifyTotp } from "../auth/totp.ts";
import type { ConnectionCounter } from "../util/connections.ts";
import { BadInput, ascii, concat, constantTimeEqual, fromHex, random, toHex } from "../util/bytes.ts";
import {
  CLOSE,
  ID_LEN,
  KEY_LEN,
  OP,
  SIG_LEN,
  authErrFrame,
  envelopeFrame,
  errorFrame,
  frame,
  jsonFrame,
  keyPackageFrame,
  parseAck,
  parseJsonBody,
  parseKeyPackageClaim,
  parseKeyPackages,
  parseSend,
  sendOkFrame,
} from "../proto/frames.ts";
import type { Registry } from "./registry.ts";
import type { Socket } from "./registry.ts";

/** Насколько время поста может расходиться с нашим. */
const POST_TIME_WINDOW_MS = 15 * 60 * 1000;
const DRAIN_BATCH = 200;
/** Выше этого не пампим очередь — клиент не успевает читать. */
const DRAIN_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
/** Алфавит memo: без символов, которые путаются при переписывании вручную. */
const REF_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const REF_LEN = 10;

export interface Deps {
  store: Store;
  support: SupportStore;
  nonces: NonceStore;
  registry: Registry;
  authLimiter: RateLimiter;
  recoveryLimiter: RateLimiter;
  searchLimiter: RateLimiter;
  sendLimiter: RateLimiter;
  postLimiter: RateLimiter;
  /** Выдача чужих KeyPackages: считается и по берущему, и по тому, у кого берут. */
  claimLimiter: RateLimiter;
  connections: ConnectionCounter;
  now: () => number;
}

/** Состояние одного соединения. Живёт в user data сокета. */
export interface ConnData {
  ip: string;
  authAttempts: number;
  nonce: Uint8Array | null;
  identity: Uint8Array | null;
  devicePub: Uint8Array | null;
  devicePubHex: string | null;
  /** Счёт, по которому это соединение ждёт зачисления. */
  paymentRef: string | null;
  /**
   * Получатели, к которым это соединение предъявило пропуск.
   *
   * Только в памяти и только на время соединения: запись на диск превратила бы
   * пропуск в постоянный след «кто кому пишет» — ровно ту метаданную, ради
   * отсутствия которой всё и затевалось.
   */
  admitted: Set<string>;
  /** Учтён ли этот сокет в счётчике адреса. Снимается ровно один раз. */
  counted: boolean;
  /** Числится ли он ещё среди неназвавшихся. Тоже снимается ровно один раз. */
  anonymous: boolean;
  /** Пришло ли соединение через onion-вход: у него свои потолки. */
  onion: boolean;
}

export function newConnData(ip: string, onion = false): ConnData {
  return {
    ip,
    onion,
    authAttempts: 0,
    nonce: null,
    identity: null,
    devicePub: null,
    devicePubHex: null,
    paymentRef: null,
    admitted: new Set(),
    counted: false,
    anonymous: false,
  };
}

export function handleOpen(deps: Deps, sock: Socket, conn: ConnData): void {
  // Считаем до HELLO: перебирающему не нужен даже ответ, ему нужен наш сокет.
  //
  // Сначала проверка, потом учёт: отвергнутый сокет учитывать нельзя. Он к нам
  // не подключился, а `counted` у него остаётся снятым — и позже, когда uWS
  // позовёт close на им же закрытое соединение, из счётчика не вычтется чужое.
  // У onion-входа потолок общий на всех: адреса, по которому их различить,
  // не существует. Поэтому и число другое — за ним стоит весь Tor сразу.
  const cap = conn.onion ? config.maxOnionConnections : config.maxConnectionsPerIp;
  if (deps.connections.count(conn.ip) >= cap) {
    sock.end(CLOSE.BUSY, "too many connections");
    return;
  }
  deps.connections.add(conn.ip);
  conn.counted = true;
  conn.anonymous = true;

  // Общий потолок неназвавшихся. Проверяется после потолка на адрес: тот
  // отсекает одну машину, этот — распределённую сеть, которой лимит на адрес
  // не мешает вовсе.
  if (deps.connections.unauthenticated > config.maxUnauthenticatedConnections) {
    sock.end(CLOSE.BUSY, "too many connections");
    return;
  }

  const now = deps.now();
  const nonce = deps.nonces.issue(now);
  if (nonce === null) {
    // Challenge-ов больше нет — войти всё равно нечем, и держать сокет незачем.
    sock.end(CLOSE.BUSY, "server busy");
    return;
  }
  conn.nonce = nonce;
  sock.send(
    jsonFrame(OP.HELLO, {
      v: PROTOCOL_VERSION,
      nonce: toHex(conn.nonce),
      serverTime: now,
      heartbeatSec: config.heartbeatSec,
      maxFrame: config.maxFrameBytes,
      /** Клиент сразу знает, какие способы входа доступны. */
      entry: { invite: !config.publicRegistration, ton: config.ton.address !== "" },
      features: { profiles: true, recovery: true, usernames: true, passes: true, decor: true },
      // Входы, о которых клиент иначе не узнает. Пустой список — просто нет
      // onion-входа: старый клиент поля не заметит, новый останется на своём
      // запасном адресе.
      //
      // Подпись сюда только передаётся. Считать её сервер не может и не должен:
      // ключ офлайн, у владельца. В этом весь смысл — сервер, умеющий подписать
      // список, увёл бы режим Tor куда угодно, а клиент бы не заметил.
      // Без подписи новый клиент список не примет; порядок адресов входит в
      // подписанные байты, поэтому отдаём их ровно как заданы.
      onion: config.onionHosts,
      onionSig: config.onionSignature,
      onionIssuedAt: config.onionIssuedAt,
    }),
    true,
  );
}

export function handleClose(deps: Deps, sock: Socket, conn: ConnData): void {
  // Только если этот сокет действительно был учтён: close приходит и на те,
  // что мы закрыли сами, и вычесть их дважды значило бы уйти в минус.
  if (conn.counted) {
    conn.counted = false;
    deps.connections.remove(conn.ip);
  }
  if (conn.anonymous) {
    conn.anonymous = false;
    deps.connections.settled();
  }
  if (conn.devicePubHex) deps.registry.remove(conn.devicePubHex, sock);
  if (conn.paymentRef) deps.registry.unwatchPayment(conn.paymentRef, sock);
}

/**
 * `msg` обязан быть копией: ArrayBuffer от uWS невалиден после возврата из
 * обработчика.
 */
export function handleMessage(deps: Deps, sock: Socket, conn: ConnData, msg: Uint8Array): void {
  if (msg.byteLength === 0) {
    sock.end(CLOSE.PROTOCOL, "empty frame");
    return;
  }
  const op = msg[0]!;
  const body = msg.subarray(1);

  try {
    switch (op) {
      case OP.PING:
        sock.send(frame(OP.PONG), true);
        return;
      case OP.AUTH:
        onAuth(deps, sock, conn, body);
        return;
      case OP.PAY_REQUEST:
        onPayRequest(deps, sock, conn, body);
        return;
      case OP.SEND:
        requireAuth(conn);
        onSend(deps, sock, conn, body);
        return;
      case OP.ACK:
        requireAuth(conn);
        onAck(deps, conn, body);
        return;
      case OP.KEYPKG_PUBLISH:
        requireAuth(conn);
        onKeyPackagePublish(deps, conn, body);
        return;
      case OP.KEYPKG_CLAIM:
        requireAuth(conn);
        onKeyPackageClaim(deps, sock, conn, body);
        return;
      case OP.PROFILE_GET:
        requireAuth(conn);
        onProfileGet(deps, sock, body);
        return;
      case OP.PROFILE_SET:
        requireAuth(conn);
        onProfileSet(deps, sock, conn, body);
        return;
      case OP.RECOVERY_SET:
        requireAuth(conn);
        onRecoverySet(deps, sock, conn, body);
        return;
      case OP.ACCESS_SET:
        requireAuth(conn);
        onAccessSet(deps, sock, conn, body);
        return;
      case OP.PASS_CREATE:
        requireAuth(conn);
        onPassCreate(deps, sock, conn, body);
        return;
      case OP.PASS_REVOKE:
        requireAuth(conn);
        onPassRevoke(deps, sock, conn, body);
        return;
      case OP.PASS_PRESENT:
        requireAuth(conn);
        onPassPresent(deps, sock, conn, body);
        return;
      case OP.USERNAME_SET:
        requireAuth(conn);
        onUsernameSet(deps, sock, conn, body);
        return;
      case OP.USERNAME_LOOKUP:
        requireAuth(conn);
        onUsernameLookup(deps, sock, conn, body);
        return;
      case OP.CHANNEL_CREATE:
        requireAuth(conn);
        onChannelCreate(deps, sock, conn, body);
        return;
      case OP.CHANNEL_PUBLISH:
        requireAuth(conn);
        onChannelPublish(deps, sock, conn, body);
        return;
      case OP.CHANNEL_LIST:
        requireAuth(conn);
        onChannelList(deps, sock, conn);
        return;
      case OP.CHANNEL_FEED:
        requireAuth(conn);
        onChannelFeed(deps, sock, conn, body);
        return;
      case OP.CHANNEL_SUB:
        requireAuth(conn);
        onChannelSub(deps, sock, conn, body);
        return;
      case OP.CHANNEL_FIND:
        requireAuth(conn);
        onChannelFind(deps, sock, conn, body);
        return;
      case OP.CHANNEL_DELETE:
        requireAuth(conn);
        onChannelDelete(deps, sock, conn, body);
        return;
      case OP.CHANNEL_UPDATE:
        requireAuth(conn);
        onChannelUpdate(deps, sock, conn, body);
        return;
      case OP.CHANNEL_ADMIN:
        requireAuth(conn);
        onChannelAdmin(deps, sock, conn, body);
        return;
      case OP.DEVICE_REVOKE_OTHERS:
        requireAuth(conn);
        onDeviceRevokeOthers(deps, sock, conn, body);
        return;
      case OP.SUPPORT_GET:
        requireAuth(conn);
        onSupportGet(deps, sock, conn, body);
        return;
      case OP.SUPPORT_MARK:
        requireAuth(conn);
        onSupportMark(deps, sock, conn, body);
        return;
      case OP.CHANNEL_DELETE_POST:
        requireAuth(conn);
        onChannelDeletePost(deps, sock, conn, body);
        return;
      case OP.ADMIN_GET:
        requireAuth(conn);
        onAdminGet(deps, sock, conn, body);
        return;
      case OP.ADMIN_ACTION:
        requireAuth(conn);
        onAdminAction(deps, sock, conn, body);
        return;
      case OP.RECOVERY_GET:
        // Единственный кадр без requireAuth: тому, кто потерял устройство,
        // подписаться нечем. Взамен — жёсткий ограничитель частоты и
        // доказательство знания пароля.
        onRecoveryGet(deps, sock, conn, body);
        return;
      default:
        sock.end(CLOSE.PROTOCOL, "unknown opcode");
        return;
    }
  } catch (err) {
    if (err instanceof BadInput) {
      // Fail closed: не пытаемся разобрать «как получится».
      sock.end(CLOSE.PROTOCOL, "bad frame");
      return;
    }
    if (err instanceof Unauthenticated) {
      sock.end(CLOSE.POLICY, "unauthenticated");
      return;
    }
    log.error("frame handler failed", { op });
    sock.end(CLOSE.PROTOCOL, "internal");
  }
}

class Unauthenticated extends Error {}

/**
 * Любая неудача AUTH выдаёт свежий nonce: клиент чинит повод (занятый handle,
 * неоплаченный счёт) и пробует снова на том же соединении. Челлендж каждый раз
 * новый, попытки ограничены — переиспользования подписи это не даёт.
 */
function authFail(deps: Deps, sock: Socket, conn: ConnData, code: string, message: string): void {
  const nonce = deps.nonces.issue(deps.now());
  if (nonce === null) {
    // Повторить попытку всё равно будет нечем: без challenge подпись не собрать.
    sock.end(CLOSE.BUSY, "server busy");
    return;
  }
  conn.nonce = nonce;
  sock.send(authErrFrame(code, message, nonce), true);
}

function requireAuth(conn: ConnData): void {
  if (!conn.devicePub) throw new Unauthenticated();
}

// --- проверка владения ключами ------------------------------------------------

interface SignedPayload {
  v: unknown;
  identity: unknown;
  device: unknown;
  deviceCert: unknown;
  sig: unknown;
  invite?: unknown;
  paymentRef?: unknown;
  handle?: unknown;
}

interface Credentials {
  identity: Uint8Array;
  devicePub: Uint8Array;
  cert: Uint8Array;
}

/**
 * Общая часть AUTH и PAY_REQUEST: доказательство владения identity-ключом и
 * ключом устройства. Подпись проверяется против nonce ЭТОГО соединения, а не
 * присланного клиентом, — перехваченный кадр на другом сокете не сойдётся.
 */
function checkCredentials(
  deps: Deps,
  sock: Socket,
  conn: ConnData,
  payload: SignedPayload,
): Credentials | null {
  const now = deps.now();

  if (payload === null || typeof payload !== "object" || payload.v !== PROTOCOL_VERSION) {
    authFail(deps, sock, conn, "bad_version", "unsupported protocol version");
    return null;
  }

  const identity = fromHex(payload.identity, KEY_LEN);
  const devicePub = fromHex(payload.device, KEY_LEN);
  const cert = fromHex(payload.deviceCert, SIG_LEN);
  const sig = fromHex(payload.sig, SIG_LEN);

  const nonce = conn.nonce;
  if (!nonce || !deps.nonces.consume(nonce, now)) {
    authFail(deps, sock, conn, "bad_nonce", "challenge expired");
    return null;
  }
  conn.nonce = null;

  if (!verify(cert, deviceCertMessage(identity, devicePub), identity)) {
    authFail(deps, sock, conn, "bad_cert", "device certificate rejected");
    return null;
  }
  if (!verify(sig, authMessage(nonce, identity, devicePub), devicePub)) {
    authFail(deps, sock, conn, "bad_signature", "challenge signature rejected");
    return null;
  }
  return { identity, devicePub, cert };
}

/**
 * Насколько щедрее считать этому соединению.
 *
 * У соединений из Tor ключ один на всех, поэтому обычный потолок закрыл бы им
 * вход целиком, стоит появиться одному шумному. Множитель разводит эти случаи,
 * не заводя второго набора ограничителей: ведро остаётся тем же, меняется
 * только его глубина.
 */
function limitFactor(conn: ConnData): number {
  return conn.onion ? config.onionLimitFactor : 1;
}

function rateOk(deps: Deps, sock: Socket, conn: ConnData): boolean {
  conn.authAttempts += 1;
  if (
    conn.authAttempts > config.maxAuthAttemptsPerConn ||
    !deps.authLimiter.allow(conn.ip, deps.now(), limitFactor(conn))
  ) {
    sock.end(CLOSE.POLICY, "rate limited");
    return false;
  }
  return true;
}

// --- платный вход -------------------------------------------------------------

function makeRef(): string {
  let out = "";
  for (const b of random(REF_LEN)) out += REF_ALPHABET[b % REF_ALPHABET.length];
  return out;
}

/**
 * Выставляет счёт. Счёт привязан к identity: memo лежит в блокчейне открыто,
 * и без привязки любой наблюдатель погасил бы чужую оплату своим ключом.
 */
function onPayRequest(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  if (config.ton.address === "") {
    sock.send(errorFrame("payment_disabled", "ton entry is not configured"), true);
    return;
  }
  if (conn.devicePub) {
    sock.end(CLOSE.POLICY, "already authenticated");
    return;
  }
  if (!rateOk(deps, sock, conn)) return;

  const creds = checkCredentials(deps, sock, conn, parseJsonBody(body) as SignedPayload);
  if (!creds) return;

  const now = deps.now();
  if (deps.store.userExists(creds.identity)) {
    sock.send(errorFrame("already_registered", "identity already has access"), true);
    return;
  }

  // Пока прошлый счёт жив — отдаём его же, а не плодим новые memo.
  let payment = deps.store.pendingPayment(creds.identity, now);
  if (!payment) {
    const ref = makeRef();
    deps.store.createPayment(
      ref,
      creds.identity,
      config.ton.priceNano,
      now,
      now + config.ton.invoiceTtlSec * 1000,
    );
    payment = deps.store.getPayment(ref)!;
  }

  if (conn.paymentRef) deps.registry.unwatchPayment(conn.paymentRef, sock);
  conn.paymentRef = payment.ref;
  deps.registry.watchPayment(payment.ref, sock);

  // Новый challenge: следующий шаг клиента — AUTH, а nonce мы только что сожгли.
  const nonce = deps.nonces.issue(now);
  if (nonce === null) {
    sock.end(CLOSE.BUSY, "server busy");
    return;
  }
  conn.nonce = nonce;
  sock.send(
    jsonFrame(OP.PAY_INFO, {
      ref: payment.ref,
      address: config.ton.address,
      amountNano: payment.amount_nano,
      expiresAt: payment.expires_at,
      paid: payment.paid_at !== null,
      nonce: toHex(nonce),
    }),
    true,
  );
}

/** Вызывается наблюдателем за блокчейном, когда счёт закрыт. */
export function notifyPaid(deps: Deps, ref: string): void {
  deps.registry.notifyPayment(ref, jsonFrame(OP.PAY_OK, { ref }));
}

// --- AUTH ---------------------------------------------------------------------

function onAuth(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  if (conn.devicePub) {
    sock.end(CLOSE.POLICY, "already authenticated");
    return;
  }
  if (!rateOk(deps, sock, conn)) return;

  const payload = parseJsonBody(body) as SignedPayload;
  const creds = checkCredentials(deps, sock, conn, payload);
  if (!creds) return;

  const now = deps.now();
  const { identity, devicePub, cert } = creds;

  const existing = deps.store.getDeviceRecord(devicePub);
  if (existing && !constantTimeEqual(existing.identity, identity)) {
    // Один device key не может кочевать между личностями.
    authFail(deps, sock, conn, "device_conflict", "device bound to another identity");
    return;
  }
  if (existing?.revoked_at !== null && existing?.revoked_at !== undefined) {
    authFail(deps, sock, conn, "device_revoked", "device has been revoked");
    return;
  }

  if (deps.store.userExists(identity) && deps.store.isBlocked(identity)) {
    // Закрытая дверь, а не молчание: человек должен понимать, что его не
    // пускают, иначе он будет считать это поломкой связи и стучаться вечно.
    authFail(deps, sock, conn, "blocked", "account blocked by the server owner");
    return;
  }

  if (!deps.store.userExists(identity) && !admit(deps, sock, conn, payload, identity, now)) return;

  if (!existing && deps.store.countActiveDevices(identity) >= config.maxDevicesPerIdentity) {
    authFail(deps, sock, conn, "device_limit", "too many devices; revoke an old device first");
    return;
  }
  const deviceId = existing ? existing.id : deps.store.createDevice(identity, devicePub, cert, now);
  deps.store.touchDevice(devicePub, now);

  const devicePubHex = toHex(devicePub);
  // Сокет назвался: из числа анонимных он выходит, дальше за него отвечают
  // ограничители по личности.
  if (conn.anonymous) {
    conn.anonymous = false;
    deps.connections.settled();
  }
  conn.identity = identity;
  conn.devicePub = devicePub;
  conn.devicePubHex = devicePubHex;
  deps.registry.add(devicePubHex, sock);
  if (conn.paymentRef) {
    deps.registry.unwatchPayment(conn.paymentRef, sock);
    conn.paymentRef = null;
  }

  sock.send(
    jsonFrame(OP.AUTH_OK, {
      deviceId: toHex(deviceId),
      // Поле мертво: клиенты его не читают, а сервер больше ничего за ним
      // не хранит. Оставлено пустым только потому, что разбор AUTH_OK у уже
      // выпущенных клиентов требует его наличия. Убрать вместе с полем в
      // `proto.rs`, когда Android догонит ядро.
      token: "",
      queued: deps.store.countPending(devicePub, now),
      // Сколько KeyPackages уже лежит. Без этого числа клиент не знает,
      // сколько ему доложить, и выкладывает полную пачку на каждый вход.
      keyPackages: deps.store.countKeyPackages(devicePub),
      // Панель владельца существует только тогда, когда так решил сервер.
      // Клиент об этом не догадывается и сам себе прав не выдаёт.
      admin: config.admins.includes(toHex(identity)),
    }),
    true,
  );

  sendProfile(sock, deps.store.ensureProfile(identity, now), devicePub);

  drainQueue(deps, sock, devicePub, now);
}

const CHAT_CODE_RE = /^OBS-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/;
const MAX_AVATAR_BYTES = 256 * 1024;
/**
 * Что принимается в качестве аватара.
 *
 * Последний тип — не картинка, а шифротекст: клиент, у которого правило
 * «аватар видят контакты», запечатывает его ключом, известным только им.
 * Серверу достаётся блоб, и это ровно то, чего мы добивались, — но из этого
 * следует и цена: подпись формата у такого аватара не проверить, потому что
 * никакого формата снаружи нет. Остаётся ограничение размера, и его хватает:
 * блоб всё равно нельзя отдать браузеру как картинку.
 */
const SEALED_AVATAR_MIME = "application/vnd.valanium.sealed-avatar";
const AVATAR_MIMES = new Set([
  "image/jpeg", "image/png", "image/webp", SEALED_AVATAR_MIME,
]);

function normalizeChatCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return CHAT_CODE_RE.test(code) ? code : null;
}

function onProfileGet(deps: Deps, sock: Socket, body: Uint8Array): void {
  const payload = parseJsonBody(body) as { query?: unknown };
  if (!payload || typeof payload !== "object" || typeof payload.query !== "string") {
    throw new BadInput("profile query required");
  }
  const query = payload.query.trim();
  let profile;
  if (/^[0-9a-fA-F]{64}$/.test(query)) {
    const device = fromHex(query, KEY_LEN);
    profile = deps.store.profileByDevice(device);
  } else {
    const code = normalizeChatCode(query);
    if (!code) throw new BadInput("bad chat code");
    profile = deps.store.profileByChatCode(code);
  }
  if (!profile) {
    sock.send(errorFrame("profile_not_found", "profile not found"), true);
    return;
  }
  const device = deps.store.activeDevice(profile.identity);
  if (!device) {
    sock.send(errorFrame("profile_not_found", "profile has no active device"), true);
    return;
  }
  sendProfile(sock, profile, device);
}

/**
 * Значки и цвета — закрытые списки, а не произвольные строки.
 *
 * Это поле видит собеседник, и произвольный текст здесь означал бы, что любой
 * может показать соседу что угодно рядом со своим именем. Клиенты рисуют метку
 * по своему справочнику: сервер хранит слово, а не картинку.
 */
const EMBLEMS = new Set([
  "none", "star", "moon", "leaf", "flame", "drop", "bolt", "heart", "anchor", "crown", "orbit",
  "shield",
]);
const PROFILE_COLORS = new Set([
  "none", "white", "blue", "violet", "green", "coral", "amber", "teal", "rose",
]);

function onProfileSet(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as {
    avatarMime?: unknown; avatarBase64?: unknown; emblem?: unknown; color?: unknown;
    decor?: unknown;
  };
  if (!payload || typeof payload !== "object") throw new BadInput("profile payload required");

  // Значок и цвет приходят отдельно от аватара: менять одно, не трогая другое.
  if ("emblem" in payload || "color" in payload || "decor" in payload) {
    const emblem = payload.emblem === undefined ? undefined : String(payload.emblem);
    const color = payload.color === undefined ? undefined : String(payload.color);
    if (emblem !== undefined && !EMBLEMS.has(emblem)) throw new BadInput("unknown emblem");
    if (color !== undefined && !PROFILE_COLORS.has(color)) throw new BadInput("unknown color");

    /*
      Запечатанные украшения. Внутрь мы не смотрим и смотреть не можем — там
      шифротекст, — поэтому проверяем единственное, что поддаётся проверке:
      размер. Значок и цвет короткие, килобайта хватает с запасом, а без
      предела это поле стало бы бесплатным местом для хранения чего угодно.
    */
    let decor: Uint8Array | null = null;
    if (payload.decor !== undefined && payload.decor !== null) {
      if (typeof payload.decor !== "string" || payload.decor.length > 1024) {
        throw new BadInput("bad decor blob");
      }
      decor = Buffer.from(payload.decor, "base64");
    }
    const current = deps.store.ensureProfile(conn.identity!, deps.now());
    const profile = deps.store.updateDecoration(
      conn.identity!,
      emblem === undefined ? current.emblem : (emblem === "none" ? null : emblem),
      color === undefined ? current.color : (color === "none" ? null : color),
      deps.now(),
      // Блоб не присылали — оставляем прежний: смена только цвета не должна
      // стирать запечатанное.
      decor ?? current.decor,
    );
    sendProfile(sock, profile, conn.devicePub!);
    return;
  }

  const clear = payload.avatarMime === null && payload.avatarBase64 === null;
  let mime: string | null = null;
  let avatar: Uint8Array | null = null;
  if (!clear) {
    if (typeof payload.avatarMime !== "string" || !AVATAR_MIMES.has(payload.avatarMime)) {
      throw new BadInput("unsupported avatar mime");
    }
    if (typeof payload.avatarBase64 !== "string" || payload.avatarBase64.length > 360_000) {
      throw new BadInput("bad avatar data");
    }
    const decoded = Buffer.from(payload.avatarBase64, "base64");
    if (decoded.byteLength === 0 || decoded.byteLength > MAX_AVATAR_BYTES) {
      sock.send(errorFrame("avatar_too_large", "avatar must be at most 256 KiB"), true);
      return;
    }
    // Запечатанный аватар — шифротекст, и подписи формата у него нет по
    // определению. Проверять её здесь значило бы требовать, чтобы шифротекст
    // начинался с байтов PNG.
    if (payload.avatarMime !== SEALED_AVATAR_MIME) {
      validateAvatarMagic(payload.avatarMime, decoded);
    }
    mime = payload.avatarMime;
    avatar = decoded;
  }
  const profile = deps.store.updateAvatar(conn.identity!, mime, avatar, deps.now());
  sendProfile(sock, profile, conn.devicePub!);
}

function validateAvatarMagic(mime: string, bytes: Uint8Array): void {
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50
    && bytes[2] === 0x4e && bytes[3] === 0x47;
  const webp = bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF"
    && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
  if ((mime === "image/jpeg" && !jpeg) || (mime === "image/png" && !png)
      || (mime === "image/webp" && !webp)) {
    throw new BadInput("avatar signature does not match mime");
  }
}

function sendProfile(
  sock: Socket,
  profile: { identity: Uint8Array; chat_code: string; avatar_mime: string | null;
    avatar: Uint8Array | null; emblem: string | null; color: string | null;
    decor: Uint8Array | null; updated_at: number },
  device: Uint8Array,
): void {
  sock.send(jsonFrame(OP.PROFILE, {
    device: toHex(device),
    chatCode: profile.chat_code,
    // Всегда пусто: человекочитаемое имя сервер больше не хранит. Поле
    // осталось в кадре ради выпущенных клиентов — они его разбирают, а
    // отсутствие поля приняли бы за битый профиль.
    handle: null,
    avatarMime: profile.avatar_mime,
    avatarBase64: profile.avatar ? Buffer.from(profile.avatar).toString("base64") : null,
    emblem: profile.emblem,
    color: profile.color,
    decor: profile.decor ? Buffer.from(profile.decor).toString("base64") : null,
    updatedAt: profile.updated_at,
  }), true);
}

// --- кому можно писать --------------------------------------------------------

const PASS_HASH_LEN = 32;
const PASS_LEN = 32;
/** Больше держать незачем: пропуска раздают по числу собеседников. */
const MAX_PASSES = 500;
const DM_POLICIES = new Set(["everyone", "passes"]);

function onAccessSet(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as { dmPolicy?: unknown };
  if (!payload || typeof payload !== "object") throw new BadInput("access payload required");
  if (typeof payload.dmPolicy !== "string" || !DM_POLICIES.has(payload.dmPolicy)) {
    throw new BadInput("unknown dm policy");
  }
  deps.store.setDmPolicy(conn.identity!, payload.dmPolicy, deps.now());
  sock.send(jsonFrame(OP.ACCESS_OK, { dmPolicy: payload.dmPolicy }), true);
}

/** Владелец кладёт хеш пропуска; сам секрет остаётся у него и у того, кому он его отдаст. */
function onPassCreate(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as
    { passHash?: unknown; oneTime?: unknown; ttlSec?: unknown };
  if (!payload || typeof payload !== "object") throw new BadInput("pass payload required");

  if (deps.store.countPasses(conn.identity!) >= MAX_PASSES) {
    sock.send(errorFrame("passes_full", "too many passes issued"), true);
    return;
  }

  const passHash = fromHex(payload.passHash, PASS_HASH_LEN);
  const oneTime = payload.oneTime === true;
  const now = deps.now();
  // 0 или отсутствие — бессрочный пропуск: срок задаёт владелец, а не сервер.
  const ttl = typeof payload.ttlSec === "number" && payload.ttlSec > 0
    ? Math.min(payload.ttlSec, 10 * 365 * 24 * 3600)
    : 10 * 365 * 24 * 3600;

  deps.store.addPass(passHash, conn.identity!, oneTime, now, now + ttl * 1000);
  sock.send(jsonFrame(OP.ACCESS_OK, { created: true }), true);
}

function onPassRevoke(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as { passHash?: unknown };
  if (!payload || typeof payload !== "object") throw new BadInput("pass payload required");
  const passHash = fromHex(payload.passHash, PASS_HASH_LEN);
  sock.send(jsonFrame(OP.ACCESS_OK, {
    revoked: deps.store.revokePass(passHash, conn.identity!),
  }), true);
}

/**
 * Предъявляет пропуск. Успех действует до конца соединения и никуда не пишется.
 *
 * Проверяется не только годность пропуска, но и то, что он выписан именно тем,
 * кому собираются писать: иначе один общий пропуск открывал бы дорогу ко всем.
 */
function onPassPresent(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as { recipient?: unknown; pass?: unknown };
  if (!payload || typeof payload !== "object") throw new BadInput("pass payload required");

  const recipient = fromHex(payload.recipient, KEY_LEN);
  const pass = fromHex(payload.pass, PASS_LEN);
  const now = deps.now();

  const owner = deps.store.redeemPass(sha256(concat(ascii("valanium-pass-v1"), pass)), now);
  const device = deps.store.getDevice(recipient);
  const admitted = owner !== undefined && device !== undefined
    && constantTimeEqual(device.identity, owner);

  if (admitted) conn.admitted.add(toHex(recipient));
  // Ответ одинаков по форме: годность пропуска — не повод для разных кодов.
  sock.send(jsonFrame(OP.ACCESS_OK, { admitted }), true);
}

// --- юзернеймы ----------------------------------------------------------------

const USERNAME_HASH_LEN = 32;

/**
 * Занимает юзернейм. Сервер видит только хеш — самого имени он не знает и
 * восстановить его не может.
 */
function onUsernameSet(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as
    { nameHash?: unknown; nameHash2?: unknown; discoverable?: unknown; clear?: unknown };
  if (!payload || typeof payload !== "object") throw new BadInput("username payload required");

  if (payload.clear === true) {
    deps.store.releaseUsername(conn.identity!);
    sock.send(jsonFrame(OP.USERNAME_OK, { cleared: true }), true);
    return;
  }

  const nameHash = fromHex(payload.nameHash, USERNAME_HASH_LEN);
  // Второй хеш необязателен: старый клиент его не шлёт, и отказывать ему из-за
  // этого нельзя — он лишится имени на ровном месте.
  const nameHash2 = payload.nameHash2 === undefined || payload.nameHash2 === null
    ? null
    : fromHex(payload.nameHash2, USERNAME_HASH_LEN);
  const discoverable = payload.discoverable !== false;

  if (!deps.store.claimUsername(nameHash, nameHash2, conn.identity!, discoverable, deps.now())) {
    sock.send(errorFrame("username_taken", "this username is already taken"), true);
    return;
  }
  sock.send(jsonFrame(OP.USERNAME_OK, { cleared: false }), true);
}

/**
 * Поиск по точному имени.
 *
 * Возвращается ровно то, что владелец согласился показывать: профиль и активное
 * устройство. Ни отпечатка, ни присутствия, ни списка контактов здесь нет и
 * появиться не должно — найденный человек ещё никого не одобрял.
 *
 * Ненайденное и скрытое отвечают одинаково: разные ответы превратили бы поиск
 * в способ проверять существование юзернеймов.
 */
function onUsernameLookup(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as { nameHash?: unknown; nameHash2?: unknown };
  if (!payload || typeof payload !== "object") throw new BadInput("username query required");
  const nameHash = fromHex(payload.nameHash, USERNAME_HASH_LEN);
  const nameHash2 = payload.nameHash2 === undefined || payload.nameHash2 === null
    ? null
    : fromHex(payload.nameHash2, USERNAME_HASH_LEN);
  const now = deps.now();

  // Перебор по словарю ограничивается здесь: хеш имени подобрать несложно.
  if (!deps.searchLimiter.allow(conn.ip, now, limitFactor(conn))) {
    sock.send(errorFrame("search_rate_limited", "too many lookups, try later"), true);
    return;
  }

  const identity = deps.store.findByUsername(nameHash, nameHash2);
  const device = identity ? deps.store.activeDevice(identity) : undefined;
  if (!identity || !device) {
    sock.send(jsonFrame(OP.USERNAME_FOUND, { found: false }), true);
    return;
  }

  const profile = deps.store.ensureProfile(identity, now);
  sock.send(jsonFrame(OP.USERNAME_FOUND, {
    found: true,
    device: toHex(device),
    chatCode: profile.chat_code,
    avatarMime: profile.avatar_mime,
    avatarBase64: profile.avatar ? Buffer.from(profile.avatar).toString("base64") : null,
    emblem: profile.emblem,
    color: profile.color,
    decor: profile.decor ? Buffer.from(profile.decor).toString("base64") : null,
  }), true);
}

// --- устройства ---------------------------------------------------------------

function onDeviceRevokeOthers(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as { signature?: unknown };
  const signature = fromHex(payload?.signature, SIG_LEN);
  if (!verify(signature, revokeOtherDevicesMessage(conn.identity!, conn.devicePub!), conn.identity!)) {
    sock.send(errorFrame("bad_signature", "identity signature rejected"), true);
    return;
  }
  const revoked = deps.store.revokeOtherDevices(conn.identity!, conn.devicePub!, deps.now());
  for (const device of revoked) deps.registry.disconnect(toHex(device));
  sock.send(jsonFrame(OP.DEVICE_OK, { revoked: revoked.length }), true);
}

// --- каналы -------------------------------------------------------------------

/**
 * Открытая лента, которую ведёт один человек.
 *
 * Содержимое лежит у сервера в открытом виде — и это не упущение, а условие
 * задачи: подписаться может кто угодно, поэтому ключ пришлось бы отдать любому
 * желающему. Шифровать вещание для неизвестного круга — самообман, и хуже того,
 * обман читателя, которому пообещали защиту.
 *
 * Отсюда обязанность клиента: канал должен быть подписан как открытый. За этим
 * следит интерфейс; сервер со своей стороны ничего не обещает.
 */
const HANDLE = /^[a-z][a-z0-9_]{2,29}$/;
const MAX_TITLE = 64;
const MAX_ABOUT = 280;
const MAX_POST = 4096;
const FEED_PAGE = 30;

/** Владелец и редакция пишут, остальные читают. */
function mayPublish(deps: Deps, channel: { id: Uint8Array; owner: Uint8Array },
  identity: Uint8Array): boolean {
  return constantTimeEqual(channel.owner, identity)
    || deps.store.isChannelAdmin(channel.id, identity);
}

function channelView(deps: Deps, row: { id: Uint8Array; owner: Uint8Array; handle: string;
  title: string; about: string | null; icon_mime?: string | null; icon_base64?: string | null;
  created_at: number; updated_at: number },
  identity: Uint8Array): Record<string, unknown> {
  const owner = constantTimeEqual(row.owner, identity);
  return {
    id: toHex(row.id),
    handle: row.handle,
    title: row.title,
    about: row.about,
    iconMime: row.icon_mime ?? null,
    iconBase64: row.icon_base64 ?? null,
    owner,
    // Роль важнее флага «владелец»: интерфейсу нужно знать, показывать ли
    // поле ввода, а писать могут двое разных по правам людей.
    role: owner ? "owner" : deps.store.isChannelAdmin(row.id, identity) ? "admin" : "reader",
    ownerCode: deps.store.ensureProfile(row.owner, deps.now()).chat_code,
    // Ключ владельца — то, с чем читатель сверяет подписи постов. Новой
    // связи это не создаёт: владелец канала и так назван кодом чата.
    ownerIdentity: toHex(row.owner),
    // Состав редакции показываем только владельцу: читателю он не нужен, а
    // список тех, кто ведёт канал, — это лишние связи между людьми.
    admins: owner
      ? deps.store.channelAdmins(row.id)
        .map((admin) => deps.store.ensureProfile(admin, deps.now()).chat_code)
      : undefined,
    subscribed: deps.store.isSubscribed(row.id, identity),
    // Счётчики для карточки канала: подписчики и посты.
    ...deps.store.channelCounts(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function postView(row: { seq: number; id: Uint8Array; channel: Uint8Array; body: string;
  author: Uint8Array | null; signature: Uint8Array | null;
  created_at: number; edited_at: number | null }): Record<string, unknown> {
  return {
    seq: row.seq,
    id: toHex(row.id),
    channel: toHex(row.channel),
    body: row.body,
    // Кто подписал и чем. Проверяет читатель: подтверждать авторство самим
    // себе — ровно то, чего мы и хотели избежать.
    author: row.author ? toHex(row.author) : null,
    signature: row.signature ? toHex(row.signature) : null,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };
}

function onChannelCreate(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as { handle?: unknown; title?: unknown; about?: unknown };
  if (!payload || typeof payload !== "object") throw new BadInput("channel payload required");
  const handle = String(payload.handle ?? "").trim().toLowerCase();
  const title = String(payload.title ?? "").trim();
  const about = payload.about === undefined || payload.about === null
    ? null : String(payload.about).trim().slice(0, MAX_ABOUT);
  if (!HANDLE.test(handle)) throw new BadInput("bad channel handle");
  if (title.length === 0 || title.length > MAX_TITLE) throw new BadInput("bad channel title");

  // Заведение канала ничего не стоит отправителю и занимает имя навсегда:
  // без потолка один аккаунт разбирает весь словарь коротких имён.
  if (deps.store.countOwnedChannels(conn.identity!) >= config.maxChannelsPerIdentity) {
    sock.send(errorFrame("channels_full", "too many channels"), true);
    return;
  }

  const created = deps.store.createChannel(random(ID_LEN), conn.identity!, handle, title, about,
    deps.now());
  if (!created) {
    sock.send(errorFrame("channel_taken", "handle already used"), true);
    return;
  }
  sock.send(jsonFrame(OP.CHANNEL_OK, {
    channels: deps.store.channelsFor(conn.identity!)
      .map((row) => channelView(deps, row, conn.identity!)),
    opened: channelView(deps, created, conn.identity!),
  }), true);
}

function onChannelList(deps: Deps, sock: Socket, conn: ConnData): void {
  sock.send(jsonFrame(OP.CHANNEL_OK, {
    channels: deps.store.channelsFor(conn.identity!)
      .map((row) => channelView(deps, row, conn.identity!)),
  }), true);
}

function channelFrom(deps: Deps, sock: Socket, value: unknown): ReturnType<typeof deps.store.channelById> {
  if (typeof value !== "string") throw new BadInput("channel id required");
  const channel = deps.store.channelById(fromHex(value, ID_LEN));
  if (!channel) {
    sock.send(errorFrame("channel_missing", "no such channel"), true);
    return undefined;
  }
  return channel;
}

function onChannelPublish(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as {
    channel?: unknown; body?: unknown; id?: unknown; createdAt?: unknown; signature?: unknown;
  };
  if (!payload || typeof payload !== "object") throw new BadInput("post payload required");
  const channel = channelFrom(deps, sock, payload.channel);
  if (!channel) return;
  if (!mayPublish(deps, channel, conn.identity!)) {
    // Писать в канал может владелец и те, кого он позвал в редакцию.
    // Остальные читают: это лента, а не переписка.
    sock.send(errorFrame("channel_not_writer", "only the owner and admins post here"), true);
    return;
  }
  const text = String(payload.body ?? "").trim();
  if (text.length === 0 || text.length > MAX_POST) throw new BadInput("bad post body");

  if (!deps.postLimiter.allow(toHex(conn.identity!), deps.now())) {
    sock.send(errorFrame("post_rate_limited", "slow down"), true);
    return;
  }

  /*
    Идентификатор и время называет автор, а не мы.

    Иначе ему нечего подписывать: подпись должна покрывать то, что читатель
    увидит, а увидит он и время, и то, в каком канале пост стоит. Сервер здесь
    только не пускает откровенную ложь — время дальше четверти часа от
    нашего. Порядок ленты всё равно задаёт seq, а не это поле.
  */
  const now = deps.now();
  const cutoff = now - config.channelPostTtlSec * 1000;
  const usage = deps.store.channelPostUsage(channel.id, cutoff);
  const postBytes = Buffer.byteLength(text, "utf8");
  if (usage.count >= config.maxPostsPerChannel || usage.bytes + postBytes > config.maxChannelBytes) {
    sock.send(errorFrame("channel_storage_full", "channel retention quota reached"), true);
    return;
  }
  const postId = payload.id === undefined ? random(ID_LEN) : fromHex(payload.id, ID_LEN);
  const createdAt = typeof payload.createdAt === "number" ? payload.createdAt : now;
  if (Math.abs(createdAt - now) > POST_TIME_WINDOW_MS) {
    throw new BadInput("post timestamp out of range");
  }
  // Подпись мы не проверяем и проверить не можем: ключ личности автора нам
  // известен, но смысл подписи в том, что её проверяет читатель, а не мы.
  // Наше дело — не потерять её и не подменить.
  const signature = payload.signature === undefined || payload.signature === null
    ? null
    : fromHex(payload.signature, SIG_LEN);

  const post = deps.store.addPost(
    postId, channel.id, text, createdAt, conn.identity!, signature,
  );
  const frame = jsonFrame(OP.CHANNEL_POST, {
    channel: toHex(channel.id),
    handle: channel.handle,
    title: channel.title,
    post: postView(post),
  });
  // Читателям, кто сейчас на связи, — сразу. Остальные увидят при открытии:
  // канал открыт, доставлять его через очередь конвертов незачем.
  for (const device of deps.store.channelReaderDevices(channel.id)) {
    deps.registry.deliver(toHex(device), frame);
  }
  sock.send(jsonFrame(OP.CHANNEL_OK, {
    channel: toHex(channel.id),
    published: postView(post),
  }), true);
}

function onChannelFeed(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as { channel?: unknown; before?: unknown };
  if (!payload || typeof payload !== "object") throw new BadInput("feed payload required");
  const channel = channelFrom(deps, sock, payload.channel);
  if (!channel) return;
  const before = typeof payload.before === "number" && Number.isFinite(payload.before)
    ? Math.floor(payload.before) : null;
  const posts = deps.store.posts(
    channel.id, FEED_PAGE + 1, before, deps.now() - config.channelPostTtlSec * 1000,
  );

  sock.send(jsonFrame(OP.CHANNEL_OK, {
    channel: channelView(deps, channel, conn.identity!),
    posts: posts.slice(0, FEED_PAGE).map(postView),
    more: posts.length > FEED_PAGE,
  }), true);
}

function onChannelSub(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as { channel?: unknown; subscribe?: unknown };
  if (!payload || typeof payload !== "object") throw new BadInput("subscription payload required");
  const channel = channelFrom(deps, sock, payload.channel);
  if (!channel) return;

  if (payload.subscribe === false) {
    if (constantTimeEqual(channel.owner, conn.identity!)) {
      sock.send(errorFrame("channel_owner_stays", "the owner cannot leave their own channel"), true);
      return;
    }
    deps.store.unsubscribeChannel(channel.id, conn.identity!);
  } else {
    deps.store.subscribeChannel(channel.id, conn.identity!, deps.now());
  }
  sock.send(jsonFrame(OP.CHANNEL_OK, {
    channels: deps.store.channelsFor(conn.identity!)
      .map((row) => channelView(deps, row, conn.identity!)),
    opened: channelView(deps, channel, conn.identity!),
  }), true);
}

function onChannelFind(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as { handle?: unknown };
  if (!payload || typeof payload !== "object") throw new BadInput("handle required");
  const handle = String(payload.handle ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!HANDLE.test(handle)) throw new BadInput("bad channel handle");

  // Каналы ищутся по имени целиком, как и люди: перебор здесь никому не нужен,
  // а ограничитель частоты у нас уже есть.
  if (!deps.searchLimiter.allow(conn.ip, deps.now(), limitFactor(conn))) {
    sock.send(errorFrame("search_rate_limited", "too many lookups, try later"), true);
    return;
  }
  const channel = deps.store.channelByHandle(handle);
  sock.send(jsonFrame(OP.CHANNEL_OK, {
    query: handle,
    found: channel ? channelView(deps, channel, conn.identity!) : null,
  }), true);
}

function onChannelDeletePost(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as { channel?: unknown; post?: unknown };
  if (!payload || typeof payload !== "object") throw new BadInput("post reference required");
  const channel = channelFrom(deps, sock, payload.channel);
  if (!channel) return;
  if (!constantTimeEqual(channel.owner, conn.identity!)) {
    sock.send(errorFrame("channel_not_owner", "only the owner edits this channel"), true);
    return;
  }
  if (typeof payload.post !== "string") throw new BadInput("post id required");
  const removed = deps.store.deletePost(fromHex(payload.post, ID_LEN), channel.id);
  sock.send(jsonFrame(OP.CHANNEL_OK, {
    channel: toHex(channel.id),
    removed: removed ? payload.post : null,
  }), true);
}

function onChannelDelete(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as { channel?: unknown };
  if (!payload || typeof payload !== "object") throw new BadInput("channel required");
  const channel = channelFrom(deps, sock, payload.channel);
  if (!channel) return;
  if (!constantTimeEqual(channel.owner, conn.identity!)) {
    sock.send(errorFrame("channel_not_owner", "only the owner removes this channel"), true);
    return;
  }

  // Читателям говорим до удаления: после — уже некому и не о чем. Владельца
  // среди них нет: ему тем же опкодом уходит собственный ответ ниже.
  const readers = deps.store.channelReaderDevices(channel.id, conn.identity!);
  deps.store.deleteChannel(channel.id);
  const gone = jsonFrame(OP.CHANNEL_OK, { closed: toHex(channel.id), handle: channel.handle });
  for (const device of readers) deps.registry.deliver(toHex(device), gone);

  sock.send(jsonFrame(OP.CHANNEL_OK, {
    closed: toHex(channel.id),
    channels: deps.store.channelsFor(conn.identity!)
      .map((row) => channelView(deps, row, conn.identity!)),
  }), true);
}

/**
 * Правка канала владельцем: название, описание, значок.
 *
 * Имя канала (`handle`) не меняется: по нему построена ссылка, и переезд
 * сломал бы её у всех, кто уже поделился. Заводится новый канал.
 */
function onChannelUpdate(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as {
    channel?: unknown; title?: unknown; about?: unknown; icon?: unknown;
  };
  if (!payload || typeof payload !== "object") throw new BadInput("channel required");
  const channel = channelFrom(deps, sock, payload.channel);
  if (!channel) return;
  if (!constantTimeEqual(channel.owner, conn.identity!)) {
    sock.send(errorFrame("channel_not_owner", "only the owner edits this channel"), true);
    return;
  }

  const patch: { title?: string; about?: string | null; icon?: { mime: string; base64: string } | null } = {};
  if (payload.title !== undefined) {
    const title = String(payload.title).trim();
    if (title.length === 0 || title.length > MAX_TITLE) throw new BadInput("bad channel title");
    patch.title = title;
  }
  if (payload.about !== undefined) {
    patch.about = payload.about === null ? null : String(payload.about).trim().slice(0, MAX_ABOUT);
  }
  if (payload.icon !== undefined) {
    if (payload.icon === null) {
      patch.icon = null;
    } else {
      const icon = payload.icon as { mime?: unknown; base64?: unknown };
      const mime = String(icon.mime ?? "");
      const base64 = String(icon.base64 ?? "");
      if (!AVATAR_MIMES.has(mime)) throw new BadInput("bad icon type");
      let decoded: Uint8Array;
      try {
        decoded = Buffer.from(base64, "base64");
      } catch {
        throw new BadInput("bad icon");
      }
      if (decoded.byteLength === 0 || decoded.byteLength > MAX_AVATAR_BYTES) {
        throw new BadInput("icon too large");
      }
      patch.icon = { mime, base64 };
    }
  }

  deps.store.updateChannel(channel.id, patch, deps.now());
  const updated = deps.store.channelById(channel.id)!;
  // Читателям — новое состояние: у них в списке висит прежнее название.
  for (const reader of deps.store.channelReaders(channel.id, conn.identity!)) {
    const view = jsonFrame(OP.CHANNEL_OK, { updated: channelView(deps, updated, reader.identity) });
    deps.registry.deliver(toHex(reader.device_pub), view);
  }
  sock.send(jsonFrame(OP.CHANNEL_OK, {
    updated: channelView(deps, updated, conn.identity!),
    channels: deps.store.channelsFor(conn.identity!)
      .map((row) => channelView(deps, row, conn.identity!)),
  }), true);
}

/**
 * Редакция канала: кто ещё может писать.
 *
 * Состав меняет только владелец. Позванный получает право писать, но не
 * править канал и не звать других: иначе «дать написать пост» незаметно
 * означало бы «отдать канал».
 */
function onChannelAdmin(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as { channel?: unknown; who?: unknown; admin?: unknown };
  if (!payload || typeof payload !== "object") throw new BadInput("channel required");
  const channel = channelFrom(deps, sock, payload.channel);
  if (!channel) return;
  if (!constantTimeEqual(channel.owner, conn.identity!)) {
    sock.send(errorFrame("channel_not_owner", "only the owner changes the writers"), true);
    return;
  }

  const identity = deps.store.identityByReference(String(payload.who ?? "").trim());
  if (!identity) {
    sock.send(errorFrame("channel_no_such_user", "no such person"), true);
    return;
  }
  if (constantTimeEqual(identity, channel.owner)) {
    // Владелец и так пишет; строка в таблице только запутала бы список.
    sock.send(errorFrame("channel_owner_writes", "the owner already writes here"), true);
    return;
  }

  if (payload.admin === false) deps.store.removeChannelAdmin(channel.id, identity);
  else deps.store.addChannelAdmin(channel.id, identity, deps.now());

  const updated = deps.store.channelById(channel.id)!;
  sock.send(jsonFrame(OP.CHANNEL_OK, {
    updated: channelView(deps, updated, conn.identity!),
  }), true);
}

// --- панель владельца ---------------------------------------------------------

/**
 * Владельца определяет ключ личности, а не имя.
 *
 * Юзернейм можно освободить и занять заново — привязка к нему означала бы, что
 * права владельца достаются тому, кто первым перехватит освободившееся имя.
 * Список задаётся при запуске сервера и в базе не хранится: строку в базе можно
 * было бы дописать, получив доступ к диску, а переменную окружения — нет.
 */
function isAdmin(conn: ConnData): boolean {
  return conn.identity !== null && conn.identity !== undefined
    && config.admins.includes(toHex(conn.identity));
}

function requireAdmin(sock: Socket, conn: ConnData): boolean {
  if (isAdmin(conn)) return true;
  // Тот же ответ, что и на неизвестный запрос: посторонний не должен по ответу
  // понять, что такая панель вообще существует.
  sock.send(errorFrame("unknown_request", "unsupported request"), true);
  return false;
}

const ADMIN_PAGE = 40;

function onAdminGet(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  if (!requireAdmin(sock, conn)) return;
  const payload = (body.byteLength > 0 ? parseJsonBody(body) : {}) as { offset?: unknown };
  const offset = typeof payload?.offset === "number" && Number.isFinite(payload.offset)
    ? Math.max(0, Math.floor(payload.offset))
    : 0;
  sock.send(jsonFrame(OP.ADMIN_OK, adminReport(deps, offset)), true);
}

function adminReport(deps: Deps, offset: number): Record<string, unknown> {
  const users = deps.store.adminUsers(ADMIN_PAGE + 1, offset);
  const page = users.slice(0, ADMIN_PAGE);
  return {
    counts: deps.store.adminCounts(deps.now()),
    online: deps.registry.size(),
    startedAt: STARTED_AT,
    offset,
    more: users.length > ADMIN_PAGE,
    users: page.map((row) => ({
      identity: toHex(row.identity),
      chatCode: row.chat_code,
      devices: row.devices,
      lastSeen: row.last_seen,
      createdAt: row.created_at,
      blocked: row.blocked > 0,
      hasUsername: row.has_username > 0,
    })),
  };
}

function onAdminAction(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  if (!requireAdmin(sock, conn)) return;
  const payload = parseJsonBody(body) as { action?: unknown; reference?: unknown };
  if (!payload || typeof payload !== "object" || typeof payload.action !== "string"
      || typeof payload.reference !== "string") {
    throw new BadInput("admin action required");
  }
  const identity = deps.store.identityByReference(payload.reference.trim());
  if (!identity) {
    sock.send(errorFrame("admin_not_found", "no such account"), true);
    return;
  }
  if (payload.action === "block") {
    if (config.admins.includes(toHex(identity))) {
      // Иначе владелец запирает сам себя, и открыть будет нечем.
      sock.send(errorFrame("admin_self", "cannot block an owner"), true);
      return;
    }
    deps.store.block(identity, deps.now());
  } else if (payload.action === "unblock") {
    deps.store.unblock(identity);
  } else {
    throw new BadInput("unknown admin action");
  }
  sock.send(jsonFrame(OP.ADMIN_OK, {
    ...adminReport(deps, 0),
    done: payload.action,
    identity: toHex(identity),
  }), true);
}

const SUPPORT_PAGE = 40;
/** Переписку читают целиком, но не бесконечно: очень длинная режется. */
const SUPPORT_THREAD_LIMIT = 200;

/**
 * Список переписок либо одна переписка целиком.
 *
 * Адрес человека уезжает в панель открытым, и иначе нельзя: без него отвечать
 * некому. Именно поэтому доступ сюда — только владельческий, тот же
 * `requireAdmin`, что и у списка учёток.
 */
function onSupportGet(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  if (!requireAdmin(sock, conn)) return;
  const payload = (body.byteLength > 0 ? parseJsonBody(body) : {}) as
    { offset?: unknown; thread?: unknown };

  if (typeof payload?.thread === "string") {
    const id = fromHex(payload.thread, ID_LEN);
    const thread = deps.support.thread(id);
    if (!thread) {
      sock.send(errorFrame("support_not_found", "no such thread"), true);
      return;
    }
    deps.support.markRead(id);
    sock.send(jsonFrame(OP.SUPPORT_OK, {
      thread: supportThreadView({ ...thread, unread: 0 }),
      messages: deps.support.messages(id, SUPPORT_THREAD_LIMIT).reverse().map((row) => ({
        id: toHex(row.id),
        subject: row.subject,
        body: row.body,
        createdAt: row.created_at,
      })),
      unreadThreads: deps.support.unreadCount(),
    }), true);
    return;
  }

  const offset = typeof payload?.offset === "number" && Number.isFinite(payload.offset)
    ? Math.max(0, Math.floor(payload.offset))
    : 0;
  sock.send(jsonFrame(OP.SUPPORT_OK, supportList(deps, offset)), true);
}

function supportThreadView(row: {
  id: Uint8Array; address: string; subject: string;
  created_at: number; updated_at: number; unread: number; closed: number;
}): Record<string, unknown> {
  return {
    id: toHex(row.id),
    address: row.address,
    subject: row.subject,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    unread: row.unread,
    closed: row.closed > 0,
  };
}

function supportList(deps: Deps, offset: number): Record<string, unknown> {
  const rows = deps.support.threads(SUPPORT_PAGE + 1, offset);
  return {
    offset,
    more: rows.length > SUPPORT_PAGE,
    unreadThreads: deps.support.unreadCount(),
    threads: rows.slice(0, SUPPORT_PAGE).map(supportThreadView),
  };
}

function onSupportMark(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  if (!requireAdmin(sock, conn)) return;
  const payload = parseJsonBody(body) as { thread?: unknown; closed?: unknown };
  if (typeof payload?.thread !== "string") {
    sock.send(errorFrame("bad_input", "thread required"), true);
    return;
  }
  const id = fromHex(payload.thread, ID_LEN);
  if (!deps.support.thread(id)) {
    sock.send(errorFrame("support_not_found", "no such thread"), true);
    return;
  }
  if (typeof payload.closed === "boolean") deps.support.setClosed(id, payload.closed);
  else deps.support.markRead(id);
  sock.send(jsonFrame(OP.SUPPORT_OK, supportList(deps, 0)), true);
}

const STARTED_AT = Date.now();

// --- восстановление по логину и паролю ----------------------------------------

/** Тот же домен, что в valanium-core/src/passphrase.rs. Расхождение = отказ входа. */
const RECOVERY_VERIFIER_DOMAIN = ascii("valanium-recovery-verifier-v1");
const RECOVERY_ID_LEN = 32;
const RECOVERY_VERIFIER_LEN = 32;
const RECOVERY_TOKEN_LEN = 32;
/** nonce(24) + ключ(32) + тег(16). Ровно, чтобы не принимать ничего лишнего. */
const RECOVERY_SEALED_LEN = 72;

/**
 * Кладёт запечатанную личность. Сервер видит три непрозрачных значения и не
 * может ни открыть посылку, ни узнать логин: у него только хеши.
 */
function onRecoverySet(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as
    {
      loginId?: unknown; verifier?: unknown; sealed?: unknown;
      clear?: unknown; totp?: unknown; totpCode?: unknown;
    };
  if (!payload || typeof payload !== "object") throw new BadInput("recovery payload required");

  if (payload.clear === true) {
    deps.store.deleteRecovery(conn.identity!);
    sock.send(frame(OP.RECOVERY_OK), true);
    return;
  }

  const loginId = fromHex(payload.loginId, RECOVERY_ID_LEN);
  const verifier = fromHex(payload.verifier, RECOVERY_VERIFIER_LEN);
  const sealed = fromHex(payload.sealed, RECOVERY_SEALED_LEN);

  /*
    Второй фактор необязателен. Секрет придумывает клиент и присылает сюда в
    base32 — том же виде, в каком показывает человеку для переноса в
    приложение-аутентификатор. Сервер его хранит открытым: иначе TOTP не
    работает, обе стороны считают код из одного секрета. Ключей от переписки
    это не касается — посылку рядом по-прежнему открывает только пароль.
  */
  let totpSecret: Uint8Array | null = null;
  if (payload.totp !== undefined && payload.totp !== null && payload.totp !== "") {
    if (typeof payload.totp !== "string") throw new BadInput("bad totp secret");
    const decoded = decodeBase32(payload.totp);
    if (!decoded || decoded.byteLength < 10 || decoded.byteLength > 64) {
      throw new BadInput("bad totp secret");
    }
    totpSecret = decoded;

    /*
      Код обязателен вместе с секретом.

      Иначе человек включает второй фактор, ошибается при переносе секрета в
      приложение — и узнаёт об этом через полгода, когда восстановление уже
      понадобилось, а посылку ему больше не отдадут. Проверка здесь стоит
      ровно одну строку и снимает целый класс потерянных аккаунтов.
    */
    const proof = typeof payload.totpCode === "string" ? payload.totpCode : "";
    if (!verifyTotp(totpSecret, proof, deps.now())) {
      sock.send(errorFrame("totp_code_wrong", "one-time code does not match the secret"), true);
      return;
    }
  }

  if (!deps.store.setRecovery(loginId, conn.identity!, verifier, sealed, deps.now(), totpSecret)) {
    sock.send(errorFrame("login_taken", "this login is already used by another account"), true);
    return;
  }
  sock.send(jsonFrame(OP.RECOVERY_OK, { totp: totpSecret !== null }), true);
}

/**
 * Отдаёт посылку тому, кто доказал знание пароля.
 *
 * Ограничитель бьёт по двум ключам сразу: по IP — против одного упорного
 * перебора, по логину — против распределённого. Ответ на неверное
 * доказательство и на несуществующий логин одинаков: иначе сервер сам
 * подсказывал бы, какие логины заняты.
 */
function onRecoveryGet(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const payload = parseJsonBody(body) as
    { loginId?: unknown; token?: unknown; code?: unknown };
  if (!payload || typeof payload !== "object") throw new BadInput("recovery query required");

  const loginId = fromHex(payload.loginId, RECOVERY_ID_LEN);
  const token = fromHex(payload.token, RECOVERY_TOKEN_LEN);
  const now = deps.now();

  // Проверка частоты идёт до обращения к базе: иначе разница во времени ответа
  // сама рассказала бы, существует логин или нет.
  // Послабление касается только ведра входа. Счётчик на конкретный логин
  // остаётся прежним: именно он стоит между чужим человеком и личностью, и
  // ослаблять его из-за того, что запрос пришёл через Tor, нельзя.
  const withinLimit = deps.recoveryLimiter.allow(conn.ip, now, limitFactor(conn))
    && deps.recoveryLimiter.allow(`login:${toHex(loginId)}`, now);
  if (!withinLimit) {
    sock.send(errorFrame("recovery_rate_limited", "too many attempts, try later"), true);
    return;
  }

  const row = deps.store.getRecovery(loginId);
  if (!row || !constantTimeEqual(sha256(concat(RECOVERY_VERIFIER_DOMAIN, token)), row.verifier)) {
    sock.send(errorFrame("recovery_not_found", "login or password is wrong"), true);
    return;
  }

  /*
    Второй фактор проверяется после пароля, а не до.

    Иначе ответ «нужен код» сам рассказывал бы, что такой логин существует и
    что у него включены одноразовые коды, — причём любому спрашивающему.
    Здесь про второй фактор узнаёт только тот, кто пароль уже знает; для него
    это не новость.
  */
  if (row.totp_secret) {
    const code = typeof payload.code === "string" ? payload.code : "";
    if (code === "") {
      sock.send(errorFrame("recovery_totp_required", "one-time code required"), true);
      return;
    }
    if (!verifyTotp(row.totp_secret, code, now)) {
      sock.send(errorFrame("recovery_totp_wrong", "one-time code is wrong"), true);
      return;
    }
  }

  sock.send(jsonFrame(OP.RECOVERY_BLOB, { sealed: toHex(row.sealed) }), true);
}

/**
 * Пропуск нового пользователя: оплаченный счёт в TON либо инвайт-код. Оба
 * расходуются последними, уже после всех проверок, — иначе занятое имя сжигало
 * бы оплату.
 */
function admit(
  deps: Deps,
  sock: Socket,
  conn: ConnData,
  payload: SignedPayload,
  identity: Uint8Array,
  now: number,
): boolean {
  /*
    Поле `handle` из кадра AUTH намеренно игнорируется.

    Раньше оно ложилось в базу открытым текстом рядом с ключом личности —
    связка «как человека зовут ↔ кто он криптографически», которую никто не
    читал: находят людей через usernames, где лежат хеши. Старые сборки это
    поле ещё присылают, и отказывать им из-за него нельзя; мы просто ничего с
    ним не делаем.
  */

  if (typeof payload.paymentRef === "string" && payload.paymentRef.length > 0) {
    const payment = deps.store.getPayment(payload.paymentRef);
    // Чужой и несуществующий счёт неотличимы в ответе — незачем подсказывать.
    if (!payment || !constantTimeEqual(payment.identity, identity) || payment.expires_at <= now) {
      authFail(deps, sock, conn, "payment_invalid", "invoice unknown or expired");
      return false;
    }
    if (payment.paid_at === null) {
      authFail(deps, sock, conn, "payment_pending", "invoice not funded yet");
      return false;
    }
    if (!deps.store.consumePayment(payment.ref, identity, now)) {
      authFail(deps, sock, conn, "payment_invalid", "invoice unknown or expired");
      return false;
    }
  } else if (typeof payload.invite === "string" && payload.invite.length > 0) {
    if (!deps.store.consumeInvite(sha256(ascii(payload.invite)), now)) {
      authFail(deps, sock, conn, "invite_invalid", "invite unknown, used or expired");
      return false;
    }
  } else if (!config.publicRegistration) {
    authFail(deps, sock, conn, "entry_required", "provide an invite code or a funded invoice");
    return false;
  }

  deps.store.createUser(identity, now);
  log.info("user registered");
  return true;
}


// --- SEND / ACK ---------------------------------------------------------------

function onSend(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const now = deps.now();

  // Ведро по личности, а не по соединению и не по IP: соединений человек
  // открывает сколько хочет, а IP за Cloudflare мы знаем только со слов
  // заголовка. Личность подтверждена подписью — обойти её нельзя, не заведя
  // второй аккаунт по инвайту.
  if (!deps.sendLimiter.allow(toHex(conn.identity!), now)) {
    sock.send(errorFrame("send_rate_limited", "slow down"), true);
    return;
  }

  const parsed = parseSend(body);

  const recipient = deps.store.getDevice(parsed.recipientDevice);
  if (!recipient) {
    sock.send(errorFrame("unknown_recipient", "no such device"), true);
    return;
  }

  // Потолок очереди получателя. Ведро отправителя его не заменяет: десять
  // аккаунтов в пределах своих вёдер сложатся и всё равно зальют одного
  // человека, а разгребать очередь ему.
  if (deps.store.countQueued(parsed.recipientDevice, now) >= config.maxQueuedPerDevice) {
    sock.send(errorFrame("recipient_queue_full", "recipient has too much undelivered mail"), true);
    return;
  }
  const payloadBytes = parsed.ciphertext.byteLength;
  if (deps.store.queuedBytes(parsed.recipientDevice, now) + payloadBytes
      > config.maxQueuedBytesPerDevice
      || deps.store.queuedBytesForIdentity(recipient.identity, now) + payloadBytes
      > config.maxQueuedBytesPerIdentity) {
    sock.send(errorFrame("recipient_queue_full", "recipient storage quota reached"), true);
    return;
  }

  // Политика получателя. Проверять надо здесь, до постановки в очередь: иначе
  // «кто может мне писать» было бы обещанием, которое ничего не значит.
  if (deps.store.dmPolicy(recipient.identity) === "passes"
      && !conn.admitted.has(toHex(parsed.recipientDevice))) {
    sock.send(errorFrame("dm_not_allowed", "recipient does not accept messages from you"), true);
    return;
  }

  const ttlSec = Math.min(parsed.ttlSec, config.envelopeTtlSec);
  // Копия обязательна: parsed.* — это view в буфер uWS.
  const payload = parsed.ciphertext.slice();
  const envelopeId = deps.store.enqueue(parsed.recipientDevice, payload, now, now + ttlSec * 1000);

  sock.send(sendOkFrame(parsed.clientRef, envelopeId), true);
  deps.registry.deliver(toHex(parsed.recipientDevice), envelopeFrame(envelopeId, now, payload));
}

function onAck(deps: Deps, conn: ConnData, body: Uint8Array): void {
  const id = parseAck(body);
  // Проверка владения внутри запроса: чужой конверт не удалить.
  deps.store.ack(id, conn.devicePub!);
}

// --- MLS KeyPackages ----------------------------------------------------------

/** Больше держать незачем: собеседников у одного устройства не бесконечно. */
export const MAX_KEY_PACKAGES = 100;
const MAX_KEY_PACKAGE_BYTES = 16 * 1024;

/**
 * Публикуются только свои пакеты: устройство берётся из сессии, а не из кадра.
 * Иначе кто угодно залил бы подложные KeyPackages за чужое устройство.
 */
function onKeyPackagePublish(deps: Deps, conn: ConnData, body: Uint8Array): void {
  const devicePub = conn.devicePub!;

  // Разбираем по пределу кадра. Раньше пределом было свободное место, и когда
  // его оставалось меньше присланного, разбор падал как «битый кадр» — а это
  // закрытие соединения. Клиент переподключался, снова выкладывал пакеты,
  // снова получал закрытие: связь не держалась дольше одного захода, очередь
  // не подтверждалась и стояла намертво. Лишние пакеты — это не нарушение
  // протокола, а всего лишь лишние пакеты.
  const packages = parseKeyPackages(body, MAX_KEY_PACKAGES, MAX_KEY_PACKAGE_BYTES);

  // Копия обязательна: тело — view в буфер uWS.
  deps.store.addKeyPackages(devicePub, packages.map((p) => p.slice()), deps.now(), MAX_KEY_PACKAGES);
}

/**
 * Выдаёт один чужой пакет и сразу его удаляет: переиспользование KeyPackage
 * ломает forward secrecy в MLS. Подлинность проверяет клиент — он сверяет
 * привязку пакета к ключу устройства и серверу здесь не верит.
 */
function onKeyPackageClaim(deps: Deps, sock: Socket, conn: ConnData, body: Uint8Array): void {
  const { clientRef, devicePub } = parseKeyPackageClaim(body);
  const now = deps.now();

  /*
    Два ведра, и они про разное.

    Первое — по тому, кто берёт: один аккаунт не должен опустошать запасы
    подряд у всех. Второе — по тому, у кого берут: оно и защищает человека,
    потому что десять аккаунтов уложатся в первое ведро каждый по-своему, а
    жертва у них будет одна.

    Отказ выглядит как «пакетов нет»: разные ответы рассказали бы берущему,
    упёрся он в предел или человек действительно исчерпал запас, а знать ему
    этого незачем.
  */
  const mine = deps.claimLimiter.allow(`claim:${toHex(conn.identity!)}`, now);
  const theirs = deps.claimLimiter.allow(
    `claimed:${toHex(devicePub)}`,
    now,
    config.maxClaimsPerDevicePerHour / config.maxClaimsPerHour,
  );
  if (!mine || !theirs) {
    sock.send(keyPackageFrame(clientRef, null), true);
    return;
  }

  const keyPackage = deps.store.claimKeyPackage(devicePub);
  sock.send(keyPackageFrame(clientRef, keyPackage ?? null), true);
}

/** Отдаём накопившееся, пока клиент успевает читать. Остаток — по реконнекту. */
function drainQueue(deps: Deps, sock: Socket, devicePub: Uint8Array, now: number): void {
  const pending = deps.store.pending(devicePub, now, DRAIN_BATCH);
  for (const row of pending) {
    if (sock.getBufferedAmount() > DRAIN_BACKPRESSURE_BYTES) return;
    sock.send(envelopeFrame(row.id, row.created_at, row.payload), true);
  }
  if (pending.length < DRAIN_BATCH) sock.send(frame(OP.QUEUE_DONE), true);
}
