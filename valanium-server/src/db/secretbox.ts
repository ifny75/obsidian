/**
 * Шифрование отдельных столбцов, которые сервер обязан уметь читать.
 *
 * Таких столбцов ровно один — секрет одноразовых кодов. Он симметричный: чтобы
 * проверить код, сервер должен знать то же самое, что знает телефон. Спрятать
 * его от самого сервера невозможно, и притворяться, что мы это умеем, не надо.
 *
 * Спрятать его от УТЕЧКИ БАЗЫ — можно, и это не мелочь: дамп `valanium.db`
 * уезжает с бэкапом, с диском, с копией для отладки, и уезжает целиком. Ключ
 * лежит отдельным файлом рядом, в бэкап базы не попадает, и без него утёкшая
 * таблица не отдаёт вторые факторы.
 *
 * Чего это не защищает: захват машины целиком. Кто прочитал файл ключа, тот
 * прочитал и секреты. Так и должно быть — это защита от копии базы, а не от
 * администратора.
 *
 * AES-256-GCM берётся из `node:crypto`: зависимостей не добавляет, режим
 * аутентифицирован, а подменить шифротекст в БД иначе было бы можно.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Метка формата в начале шифротекста: по ней видно, что запись уже закрыта. */
const MAGIC = Buffer.from("OTS1");
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.byteLength !== KEY_LEN) throw new Error("secret key must be 32 bytes");
    this.#key = key;
  }

  /**
   * Ключ из окружения, а если его там нет — из файла рядом с базой.
   *
   * Файл заводится сам при первом запуске. Это осознанный выбор в пользу того,
   * чтобы защита работала везде, а не только там, где кто-то не забыл выставить
   * переменную: забытая переменная означала бы тихое хранение секретов открытым
   * текстом, то есть ровно то, от чего мы уходим.
   */
  static load(dbPath: string): SecretBox {
    // База в памяти живёт до конца процесса — и ключ вместе с ней. Заводить
    // ради тестов файл в рабочем каталоге было бы неопрятно и незаметно.
    if (dbPath === ":memory:") return new SecretBox(randomBytes(KEY_LEN));

    const fromEnv = process.env.VALANIUM_SECRET_KEY;
    if (fromEnv !== undefined && fromEnv !== "") {
      return new SecretBox(Buffer.from(fromEnv, "hex"));
    }

    const dir = dirname(dbPath);
    const keyPath = join(dir, "secret.key");
    try {
      const raw = readFileSync(keyPath, "utf8").trim();
      return new SecretBox(Buffer.from(raw, "hex"));
    } catch {
      mkdirSync(dir, { recursive: true });
      const key = randomBytes(KEY_LEN);
      // `mode` в writeFileSync задаёт права только при создании файла, поэтому
      // chmod следом: на существующем файле с чужими правами он бы промолчал.
      writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
      try {
        chmodSync(keyPath, 0o600);
      } catch {
        // Windows прав не знает — на разработческой машине это нормально.
      }
      return new SecretBox(key);
    }
  }

  seal(plain: Uint8Array): Uint8Array {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
  }

  /**
   * Открывает запись. `null` — открыть не вышло: ключ не тот или запись битая.
   *
   * Различать эти случаи наружу незачем, а вот молча возвращать «секрета нет»
   * нельзя ни в каком: для второго фактора это означало бы пропустить того, у
   * кого кода нет.
   */
  open(stored: Uint8Array): Uint8Array | null {
    if (!isSealed(stored)) return null;
    const buffer = Buffer.from(stored);
    const iv = buffer.subarray(MAGIC.length, MAGIC.length + IV_LEN);
    const body = buffer.subarray(MAGIC.length + IV_LEN, buffer.length - TAG_LEN);
    const tag = buffer.subarray(buffer.length - TAG_LEN);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      return null;
    }
  }
}

/**
 * Похожа ли запись на закрытую.
 *
 * Нужно для переезда: в старых базах секреты лежат как есть, и отличить их
 * надо, ничего не сломав. Случайные двадцать байт начинаются с `OTS1` с
 * вероятностью один к четырём миллиардам, но и этот случай безопасен —
 * расшифровать такое не выйдет, и запись просто останется нечитаемой, как
 * любая другая порча.
 */
export function isSealed(stored: Uint8Array): boolean {
  if (stored.byteLength < MAGIC.length + IV_LEN + TAG_LEN) return false;
  return Buffer.from(stored.subarray(0, MAGIC.length)).equals(MAGIC);
}
