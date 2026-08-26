import { resolve } from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be a boolean`);
}

const root = resolve(import.meta.dirname, "..");

export const config = {
  host: str("OBSIDIAN_HOST", "127.0.0.1"),
  port: num("OBSIDIAN_PORT", 8787),

  dbPath: resolve(root, str("OBSIDIAN_DB", "data/obsidian.db")),
  blobDir: resolve(root, str("OBSIDIAN_BLOBS", "data/blobs")),

  /** Больше — только через blob-эндпоинт. */
  maxFrameBytes: num("OBSIDIAN_MAX_FRAME", 1024 * 1024),
  /** Cloudflare free: тело запроса <= 100 MB. Держим запас. */
  maxBlobBytes: num("OBSIDIAN_MAX_BLOB", 16 * 1024 * 1024),

  /** Клиент обязан слать PING чаще: CF рвёт WS после ~100 с простоя. */
  heartbeatSec: num("OBSIDIAN_HEARTBEAT_SEC", 30),
  /** uWS закроет сокет сам, если тишина дольше. */
  idleTimeoutSec: num("OBSIDIAN_IDLE_TIMEOUT_SEC", 90),

  envelopeTtlSec: num("OBSIDIAN_ENVELOPE_TTL_SEC", 14 * 24 * 3600),
  blobTtlSec: num("OBSIDIAN_BLOB_TTL_SEC", 30 * 24 * 3600),
  inviteTtlSec: num("OBSIDIAN_INVITE_TTL_SEC", 7 * 24 * 3600),
  /** Открытая beta: новый аккаунт можно создать без инвайта и оплаты. */
  publicRegistration: bool("OBSIDIAN_PUBLIC_REGISTRATION", false),
  sessionTtlSec: num("OBSIDIAN_SESSION_TTL_SEC", 24 * 3600),
  nonceTtlSec: num("OBSIDIAN_NONCE_TTL_SEC", 30),

  /** Пусто => админские эндпоинты выключены. Инвайты тогда только через CLI. */
  adminToken: str("OBSIDIAN_ADMIN_TOKEN", ""),

  maxAuthAttemptsPerConn: num("OBSIDIAN_MAX_AUTH_ATTEMPTS", 5),
  maxAuthPerMinutePerIp: num("OBSIDIAN_MAX_AUTH_PER_MIN", 20),

  /**
   * Попыток восстановления по паролю в час — на IP и отдельно на логин.
   * Считается низким намеренно: это единственный кадр, который принимается без
   * подписи, и он же единственная дверь, за которой пароль пользователя стоит
   * между чужим человеком и личностью целиком. Своих попыток тут нужно
   * две-три, чужому — тысячи.
   */
  maxRecoveryPerHour: num("OBSIDIAN_MAX_RECOVERY_PER_HOUR", 10),

  /**
   * Поисков по юзернейму в минуту на IP. Каталог хранит хеши, но словарь имён
   * невелик, и без ограничителя его перебрали бы целиком за вечер.
   */
  maxSearchPerMinute: num("OBSIDIAN_MAX_SEARCH_PER_MIN", 20),

  /**
   * Кто владеет сервером: список identity в hex через запятую.
   *
   * Именно identity, а не юзернейм: имя можно освободить и занять заново, а
   * ключ личности — это и есть аккаунт. Пустой список означает, что панели нет
   * ни у кого, и это правильное значение по умолчанию.
   */
  get admins(): string[] {
    return str("OBSIDIAN_ADMINS", "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => /^[0-9a-f]{64}$/.test(entry));
  },

  cleanupIntervalSec: num("OBSIDIAN_CLEANUP_SEC", 3600),

  releases: {
    windowsVersion: str("OBSIDIAN_WINDOWS_VERSION", "0.6.3"),
    windowsUrl: str("OBSIDIAN_WINDOWS_URL", "https://getobsidian.xyz/downloads/Obsidian-Setup.exe"),
    androidVersion: str("OBSIDIAN_ANDROID_VERSION", "0.5.6"),
    androidUrl: str("OBSIDIAN_ANDROID_URL", "https://getobsidian.xyz/downloads/Obsidian.apk"),
  },

  ton: {
    /** Пустой адрес => платный вход выключен, остаются только инвайты. */
    address: str("OBSIDIAN_TON_ADDRESS", ""),
    /**
     * Цена задаётся в TON, а не в долларах: курсовой оракул — это ещё одна
     * внешняя зависимость и ещё один наблюдатель. Админ пересчитывает сам.
     */
    priceNano: tonToNano(str("OBSIDIAN_TON_PRICE", "3.0")),
    /** Допуск на пересылочные комиссии и дробление, базисные пункты. */
    toleranceBp: num("OBSIDIAN_TON_TOLERANCE_BP", 200),
    /** Сколько живёт выставленный счёт. */
    invoiceTtlSec: num("OBSIDIAN_TON_INVOICE_TTL_SEC", 3600),
    pollSec: num("OBSIDIAN_TON_POLL_SEC", 20),
    /** Свой лайтсервер = никто не видит, чей кошелёк мы опрашиваем. */
    configUrl: str("OBSIDIAN_TON_CONFIG", "https://ton.org/global.config.json"),
  },
} as const;

/** "3.5" -> 3500000000n. Без плавающей точки: деньги через float — это баг. */
export function tonToNano(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(trimmed)) {
    throw new Error(`OBSIDIAN_TON_PRICE must be a decimal with <=9 fraction digits, got ${trimmed}`);
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
}

export const PROTOCOL_VERSION = 1;
