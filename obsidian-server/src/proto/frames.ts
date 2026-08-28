import { BadInput, concat, readU32BE, slice, toHex, writeU64BE } from "../util/bytes.ts";

/**
 * Wire-протокол из ARCHITECTURE.md §7.
 *
 *   байт 0    : opcode
 *   байты 1.. : body
 *
 * Целые — big-endian. Идентификаторы — 16 случайных байт.
 * Служебные кадры несут JSON, кадры данных — сырые байты.
 */
export const OP = {
  // сервер → клиент
  HELLO: 0x01,
  AUTH_OK: 0x03,
  AUTH_ERR: 0x04,
  ENVELOPE: 0x11,
  SEND_OK: 0x13,
  PONG: 0x21,
  ERROR: 0x30,
  QUEUE_DONE: 0x31,
  PAY_INFO: 0x06,
  PAY_OK: 0x07,
  KEYPKG: 0x16,
  PROFILE: 0x19,
  RECOVERY_OK: 0x1c,
  RECOVERY_BLOB: 0x1d,
  USERNAME_OK: 0x24,
  USERNAME_FOUND: 0x25,
  ACCESS_OK: 0x2a,
  ADMIN_OK: 0x2c,
  /** Ответ на любое действие с каналом: список, лента, подтверждение. */
  CHANNEL_OK: 0x32,
  /** Новый пост в канале, на который человек подписан. */
  CHANNEL_POST: 0x33,
  // клиент → сервер
  AUTH: 0x02,
  PAY_REQUEST: 0x05,
  SEND: 0x10,
  ACK: 0x12,
  PING: 0x20,
  KEYPKG_PUBLISH: 0x14,
  KEYPKG_CLAIM: 0x15,
  PROFILE_GET: 0x17,
  PROFILE_SET: 0x18,
  RECOVERY_SET: 0x1a,
  /** Единственный кадр, принимаемый до AUTH: восстанавливающемуся нечем подписаться. */
  RECOVERY_GET: 0x1b,
  USERNAME_SET: 0x22,
  USERNAME_LOOKUP: 0x23,
  ACCESS_SET: 0x26,
  PASS_CREATE: 0x27,
  PASS_REVOKE: 0x28,
  PASS_PRESENT: 0x29,
  /** Служебные кадры владельца сервера. Проверяются по identity, а не по имени. */
  ADMIN_GET: 0x2b,
  ADMIN_ACTION: 0x2d,
  /** Открытые каналы: завести, писать, читать, подписаться. */
  CHANNEL_CREATE: 0x34,
  CHANNEL_PUBLISH: 0x35,
  CHANNEL_LIST: 0x36,
  CHANNEL_FEED: 0x37,
  CHANNEL_SUB: 0x38,
  CHANNEL_FIND: 0x39,
  CHANNEL_DELETE_POST: 0x3a,
  CHANNEL_DELETE: 0x3b,
  CHANNEL_UPDATE: 0x3c,
  CHANNEL_ADMIN: 0x3d,
} as const;

export const ID_LEN = 16;
export const KEY_LEN = 32;
export const SIG_LEN = 64;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function frame(op: number, body?: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + (body?.byteLength ?? 0));
  out[0] = op;
  if (body) out.set(body, 1);
  return out;
}

export function jsonFrame(op: number, value: unknown): Uint8Array {
  return frame(op, encoder.encode(JSON.stringify(value)));
}

export function parseJsonBody(body: Uint8Array): unknown {
  if (body.byteLength === 0) throw new BadInput("empty json body");
  try {
    return JSON.parse(decoder.decode(body));
  } catch {
    throw new BadInput("malformed json");
  }
}

// --- разбор клиентских кадров ------------------------------------------------

export interface SendFrame {
  clientRef: Uint8Array;
  recipientDevice: Uint8Array;
  ttlSec: number;
  ciphertext: Uint8Array;
}

/** `[16B clientRef][32B recipientDevicePub][4B ttlSec][ciphertext]` */
export function parseSend(body: Uint8Array): SendFrame {
  const headerLen = ID_LEN + KEY_LEN + 4;
  if (body.byteLength <= headerLen) throw new BadInput("send: truncated");
  const ttlSec = readU32BE(body, ID_LEN + KEY_LEN);
  if (ttlSec === 0) throw new BadInput("send: zero ttl");
  return {
    clientRef: slice(body, 0, ID_LEN),
    recipientDevice: slice(body, ID_LEN, ID_LEN + KEY_LEN),
    ttlSec,
    ciphertext: slice(body, headerLen, body.byteLength),
  };
}

/**
 * `[[4B len][bytes]]...` — пачка MLS KeyPackages одним кадром.
 *
 * Они нужны, чтобы вообще завести шифрованный диалог, поэтому ходят по тому же
 * сокету, что и всё остальное: второй транспорт означал бы второй TLS-клиент и
 * второй путь аутентификации в ядре.
 *
 * `maxCount` — предел разбора кадра, а не свободного места в хранилище. Это
 * разные вещи: прислать больше, чем сейчас влезает, — не нарушение протокола, и
 * рвать за это соединение нельзя. Сколько принять, решает вызывающий.
 */
export function parseKeyPackages(body: Uint8Array, maxCount: number, maxSize: number): Uint8Array[] {
  const packages: Uint8Array[] = [];
  let offset = 0;
  while (offset < body.byteLength) {
    const length = readU32BE(body, offset);
    offset += 4;
    if (length === 0 || length > maxSize) throw new BadInput("keypkg: bad length");
    packages.push(slice(body, offset, offset + length));
    offset += length;
    if (packages.length > maxCount) throw new BadInput("keypkg: too many");
  }
  if (packages.length === 0) throw new BadInput("keypkg: empty");
  return packages;
}

/** `[16B clientRef][32B devicePub]` */
export function parseKeyPackageClaim(body: Uint8Array): { clientRef: Uint8Array; devicePub: Uint8Array } {
  if (body.byteLength !== ID_LEN + KEY_LEN) throw new BadInput("claim: bad length");
  return {
    clientRef: slice(body, 0, ID_LEN),
    devicePub: slice(body, ID_LEN, ID_LEN + KEY_LEN),
  };
}

/** `[16B clientRef][1B found][keyPackage]` — found=0 значит «пакетов нет». */
export function keyPackageFrame(clientRef: Uint8Array, keyPackage: Uint8Array | null): Uint8Array {
  const found = new Uint8Array([keyPackage === null ? 0 : 1]);
  return frame(OP.KEYPKG, concat(clientRef, found, keyPackage ?? new Uint8Array()));
}

/** `[16B envelopeId]` */
export function parseAck(body: Uint8Array): Uint8Array {
  if (body.byteLength !== ID_LEN) throw new BadInput("ack: bad length");
  return slice(body, 0, ID_LEN);
}

// --- сборка серверных кадров -------------------------------------------------

/** `[16B envelopeId][8B serverTs][ciphertext]` */
export function envelopeFrame(id: Uint8Array, serverTs: number, ciphertext: Uint8Array): Uint8Array {
  return frame(OP.ENVELOPE, concat(id, writeU64BE(BigInt(serverTs)), ciphertext));
}

/** `[16B clientRef][16B envelopeId]` */
export function sendOkFrame(clientRef: Uint8Array, envelopeId: Uint8Array): Uint8Array {
  return frame(OP.SEND_OK, concat(clientRef, envelopeId));
}

export function errorFrame(code: string, message: string): Uint8Array {
  return jsonFrame(OP.ERROR, { code, message });
}

/** Несёт новый challenge — клиент повторяет AUTH, не переподключаясь. */
export function authErrFrame(code: string, message: string, nonce: Uint8Array): Uint8Array {
  return jsonFrame(OP.AUTH_ERR, { code, message, nonce: toHex(nonce) });
}

/** Коды close. Fail closed: разбираемся не «как получится», а рвём соединение. */
export const CLOSE = {
  PROTOCOL: 1002,
  POLICY: 1008,
  TOO_BIG: 1009,
  /** Сервер перегружен этим адресом — 1013 «try again later». */
  BUSY: 1013,
} as const;
