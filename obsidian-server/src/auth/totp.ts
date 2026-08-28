/**
 * Одноразовые коды из приложения-аутентификатора (RFC 6238).
 *
 * **Что это защищает, а что нет.** Код не участвует в расшифровке: запечатанную
 * копию identity-ключа по-прежнему открывает только пароль, и сервер её открыть
 * не может — ни с кодом, ни без. Код стоит на другом: он решает, отдавать ли
 * посылку вообще. Логин угадывается, пароль перебирается, и единственное, что
 * стоит между чужим человеком и вашим шифротекстом, — ограничитель частоты.
 * Второй фактор превращает перебор в невозможный: угадать надо ещё и шесть
 * цифр, живущих тридцать секунд.
 *
 * **Секрет лежит на сервере открытым, и это нормально.** По-другому TOTP не
 * работает: обе стороны считают код из одного секрета. Кто добрался до базы
 * сервера, тот и так держит в руках запечатанную посылку — код ему ничего не
 * добавит, а пароль по-прежнему нужен. Ключей от переписки здесь нет и не
 * появляется.
 *
 * Реализовано на `node:crypto`: тянуть зависимость ради HMAC-SHA1 незачем.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** RFC 4648 §6. Так секрет показывают в приложениях-аутентификаторах. */
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Шаг из RFC 6238, он же используется всеми приложениями по умолчанию. */
export const STEP_SECONDS = 30;

/** Сколько цифр в коде. Шесть — то, что показывает Google Authenticator. */
export const DIGITS = 6;

/**
 * Насколько разрешено разойтись часам.
 *
 * Один шаг в обе стороны: телефон почти всегда отстаёт или спешит на
 * несколько секунд, и без допуска половина честных попыток отвергалась бы. Два
 * шага и больше — это уже минута с лишним, за которую подсмотренный код успеет
 * пригодиться постороннему.
 */
export const WINDOW = 1;

/** Длина секрета в байтах. 20 — размер выхода SHA-1, как советует RFC 4226. */
export const SECRET_BYTES = 20;

export function decodeBase32(input: string): Uint8Array | null {
  // Пробелы и дефисы люди вставляют сами, а `=` дописывают приложения.
  const cleaned = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (cleaned.length === 0) return null;

  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const symbol of cleaned) {
    const value = BASE32.indexOf(symbol);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  // Хвостовые биты обязаны быть нулевыми: иначе две разные записи дали бы один
  // секрет, и «неверный» секрет молча заработал бы.
  if (bits >= 5 || (buffer & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

export function encodeBase32(secret: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of secret) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(buffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 0x1f];
  return out;
}

/** Код для конкретного шага. Экспортируется ради тестов и проверки при заводе. */
export function codeFor(secret: Uint8Array, counter: number): string {
  // Счётчик — 8 байт big-endian. Пишем через BigInt: после 2^53 обычное число
  // перестало бы быть точным, и код разошёлся бы у всех разом в далёком будущем.
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", Buffer.from(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * Верен ли код прямо сейчас.
 *
 * Сравнение постоянного времени: разница в скорости ответа подсказала бы, какая
 * цифра угадана, и шесть цифр перебирались бы по одной.
 */
export function verify(secret: Uint8Array, code: string, now: number): boolean {
  const cleaned = code.replace(/[\s-]/g, "");
  if (!new RegExp(`^\\d{${DIGITS}}$`).test(cleaned)) return false;

  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  const given = Buffer.from(cleaned, "utf8");

  let ok = false;
  for (let shift = -WINDOW; shift <= WINDOW; shift += 1) {
    const expected = Buffer.from(codeFor(secret, counter + shift), "utf8");
    // Без раннего выхода: он вернул бы разницу во времени между «первый шаг
    // подошёл» и «подошёл последний».
    if (expected.length === given.length && timingSafeEqual(expected, given)) ok = true;
  }
  return ok;
}

/** Ссылка для QR-кода. Формат задан приложениями, не нами. */
export function otpauthUrl(secret: Uint8Array, label: string, issuer = "Obsidian"): string {
  const encode = encodeURIComponent;
  return `otpauth://totp/${encode(issuer)}:${encode(label)}`
    + `?secret=${encodeBase32(secret)}`
    + `&issuer=${encode(issuer)}`
    + `&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
