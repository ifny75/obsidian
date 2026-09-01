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

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.split(",").map((item) => item.trim()).filter((item) => item !== "");
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
  nonceTtlSec: num("OBSIDIAN_NONCE_TTL_SEC", 30),

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
   * Одновременных сокетов с одного адреса.
   *
   * 32 — с запасом на общий NAT: за одним адресом живёт целая квартира, общежитие
   * или офис, и резать их до единиц значит выключить мессенджер честным людям.
   * От перебора это всё равно защищает: тысячу висящих сокетов с одной машины
   * больше не открыть.
   */
  maxConnectionsPerIp: num("OBSIDIAN_MAX_CONNECTIONS_PER_IP", 32),
  /**
   * Сколько сокетов всего может висеть, не назвавшись.
   *
   * Потолок на адрес считает по ключу, а ключей у распределённой сети столько,
   * сколько машин: тысяча адресов по тридцать два сокета — это тридцать две
   * тысячи сокетов, и каждый из них до `idleTimeout` держит nonce и запись в
   * памяти. Этот потолок общий и потому переживает такое: вошедших он не
   * трогает вовсе, а новым в разгар атаки отвечает «занято» — что честнее,
   * чем упасть по памяти для всех сразу.
   */
  maxUnauthenticatedConnections: num("OBSIDIAN_MAX_UNAUTH_CONNECTIONS", 4096),
  /**
   * Сколько соединений держит onion-вход целиком.
   *
   * Не «на адрес»: адреса у соединений из Tor нет, они считаются одним ведром.
   * Поэтому число заметно больше обычного потолка на адрес — за ним стоят все
   * пользователи Tor сразу, — но оно есть, иначе вход мимо Cloudflare остался
   * бы единственным местом без потолка вообще.
   */
  maxOnionConnections: num("OBSIDIAN_MAX_ONION_CONNECTIONS", 512),
  /**
   * Onion-адреса входных узлов: клиент узнаёт их в HELLO.
   *
   * Держать этот список в клиенте нельзя — точнее, можно, но тогда смена
   * адреса или потеря узла требуют новой сборки и рассылки всем. Сервер знает
   * свою же сеть и называет её сам; в клиенте остаётся только запасной адрес
   * на случай, когда до HELLO ещё не дошли.
   */
  onionHosts: list("OBSIDIAN_ONION_HOSTS", []),
  /**
   * Во сколько раз щедрее лимиты частоты для того же общего ведра.
   *
   * Двадцать — это ровно та величина, при которой один шумный клиент Tor не
   * закрывает вход остальным, а перебор через Tor всё равно упирается в
   * счётчики на логин и на личность, которые считаются отдельно от входа.
   */
  onionLimitFactor: num("OBSIDIAN_ONION_LIMIT_FACTOR", 20),
  /**
   * Потолки карт в памяти. Оба берутся с запасом: они спасают от исчерпания
   * памяти, а не ограничивают поведение — за это отвечают лимиты выше.
   */
  maxRateLimitKeys: num("OBSIDIAN_MAX_RATE_KEYS", 100_000),
  maxOutstandingNonces: num("OBSIDIAN_MAX_NONCES", 50_000),
  /**
   * Доверять ли `CF-Connecting-IP`.
   *
   * Заголовок ставит Cloudflare, и подделать его может кто угодно, кто дотянется
   * до сервера мимо туннеля. Поэтому он принимается только от петли: cloudflared
   * ходит с localhost. Появится другой обратный прокси — его адрес сюда.
   */
  trustedProxies: list("OBSIDIAN_TRUSTED_PROXIES", ["127.0.0.1", "::1", "::ffff:127.0.0.1"]),

  /**
   * Отправка. До этого «сколько угодно и как быстро угодно» было единственной
   * командой без потолка: каждый конверт ложится на диск и лежит до ACK.
   *
   * 120 в минуту — это два сообщения в секунду непрерывно; живой переписке
   * столько не нужно даже в горячем споре, а скрипту этого мало, чтобы
   * навредить.
   */
  maxSendPerMinute: num("OBSIDIAN_MAX_SEND_PER_MIN", 120),
  /**
   * Потолок очереди на устройство. Считается по получателю, а не по
   * отправителю: иначе десять аккаунтов сложатся и обойдут ограничение,
   * которое как раз получателя и защищает.
   */
  maxQueuedPerDevice: num("OBSIDIAN_MAX_QUEUED_PER_DEVICE", 5000),
  /** Активных устройств на одну identity. Отозванные tombstone сюда не входят. */
  maxDevicesPerIdentity: num("OBSIDIAN_MAX_DEVICES_PER_IDENTITY", 8),
  /** Байтов недоставленной очереди: отдельно на устройство и на identity. */
  maxQueuedBytesPerDevice: num("OBSIDIAN_MAX_QUEUED_BYTES_PER_DEVICE", 256 * 1024 * 1024),
  maxQueuedBytesPerIdentity: num("OBSIDIAN_MAX_QUEUED_BYTES_PER_IDENTITY", 512 * 1024 * 1024),
  /** Посты в каналах: rate-limit не заменяет дисковую квоту. */
  maxPostsPerMinute: num("OBSIDIAN_MAX_POSTS_PER_MIN", 20),
  maxPostsPerChannel: num("OBSIDIAN_MAX_POSTS_PER_CHANNEL", 50_000),
  maxChannelBytes: num("OBSIDIAN_MAX_CHANNEL_BYTES", 64 * 1024 * 1024),
  /** Открытая лента — не бессрочный архив. */
  channelPostTtlSec: num("OBSIDIAN_CHANNEL_POST_TTL_SEC", 90 * 24 * 3600),
  /** Каналов на личность. Их заведение ничего не стоит, а место занимает. */
  maxChannelsPerIdentity: num("OBSIDIAN_MAX_CHANNELS", 20),
  /**
   * Сколько чужих KeyPackages можно забрать за час.
   *
   * Пакет одноразовый: взял — он исчез, иначе ломается forward secrecy. Из
   * этого следует и способ навредить: вычерпать чужой запас и держать его
   * пустым, чтобы с человеком нельзя было начать новую переписку. Считается
   * по двум ключам сразу — по тому, кто берёт, и по тому, у кого берут:
   * первый ограничивает одного жадного, второй защищает жертву от десятка
   * аккаунтов.
   *
   * Живому человеку столько не нужно: пакет тратится один раз на нового
   * собеседника, а не на сообщение.
   */
  maxClaimsPerHour: num("OBSIDIAN_MAX_CLAIMS_PER_HOUR", 60),
  /** То же, но со стороны того, чей запас берут. */
  maxClaimsPerDevicePerHour: num("OBSIDIAN_MAX_CLAIMS_PER_DEVICE_HOUR", 120),

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

  /**
   * Подписанный манифест релизов. Кладётся рядом с базой и обновляется
   * выкладкой; ключа для его подписи на сервере нет и быть не должно.
   */
  releasesFile: resolve(root, str("OBSIDIAN_RELEASES_FILE", "data/releases.json")),

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
