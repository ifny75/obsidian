/**
 * Подписывает манифест встроенного Tor (valanium-onionize).
 *
 *   node deploy/sign-onionize.mjs 0.1.0 windows path/to/valanium-onionize.exe
 *
 * Зачем это существует. Приложение скачивает этот файл и **запускает** его.
 * Без подписи получилось бы вот что: тот, кто получит доступ к репозиторию,
 * к GitHub или к любому удостоверяющему центру, подменит файл — и получит
 * выполнение произвольного кода на машинах всех, кто включил Onion. То есть
 * удобство «не надо ставить Tor отдельно» стоило бы дороже, чем сам Tor.
 *
 * Ключ тот же, что у релизов: он офлайновый, и его открытая половина уже
 * зашита в клиент. Второй ключ здесь ничего не добавил бы — угроза одна и та
 * же, а лишний ключ это лишний способ его потерять.
 *
 * Файлы лежат в релизах репозитория onionize, но где именно — для безопасности
 * неважно: подпись защищает содержимое, а не место хранения.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "../valanium-server/node_modules/@noble/curves/ed25519.js";

const KEY_PATH = process.env.VALANIUM_SIGNING_KEY
  ?? join(homedir(), ".valanium-release", "signing.key");

const REPO = "https://github.com/valanium-project/valanium-onionize/releases/download";

/** Как называется собранный файл на каждой платформе. */
const FILENAME = {
  windows: "valanium-onionize-windows-x64.exe",
  linux: "valanium-onionize-linux-x64",
  macos: "valanium-onionize-macos-arm64",
};

const args = process.argv.slice(2);
const version = args.shift();
if (!version || args.length === 0 || args.length % 2 !== 0) {
  process.stderr.write(
    "usage: node deploy/sign-onionize.mjs <версия> <платформа> <файл> [...]\n"
    + `платформа: ${Object.keys(FILENAME).join(" | ")}\n`,
  );
  process.exit(2);
}

const platforms = {};
for (let i = 0; i < args.length; i += 2) {
  const [platform, file] = args.slice(i, i + 2);
  if (!(platform in FILENAME)) {
    process.stderr.write(`неизвестная платформа: ${platform}\n`);
    process.exit(2);
  }
  const bytes = readFileSync(file);
  platforms[platform] = {
    // Хеш — то, что приложение сверит со скачанным перед тем, как запустить.
    // Подписи манифеста мало: она говорит, какой файл правильный, но не
    // проверяет, тот ли файл приехал.
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    url: `${REPO}/v${version}/${FILENAME[platform]}`,
  };
}

/*
  Подпись считается по строке, а не по объекту: сервер отдаёт эту же строку
  байт в байт, и клиент проверяет ровно её. Иначе пришлось бы договариваться о
  каноническом виде JSON — а любое расхождение означало бы либо ложную тревогу,
  либо, что хуже, молчаливо принятую подделку.
*/
const manifest = JSON.stringify({
  v: 1,
  kind: "onionize",
  version,
  publishedAt: new Date().toISOString(),
  ...platforms,
});

const priv = Buffer.from(readFileSync(KEY_PATH, "utf8").trim(), "hex");
const signature = Buffer.from(ed25519.sign(Buffer.from(manifest, "utf8"), priv)).toString("hex");
const publicKey = Buffer.from(ed25519.getPublicKey(priv)).toString("hex");

// Сразу проверяем собственной же проверкой: подпись, которую не примет клиент,
// лучше увидеть здесь, а не в отчёте «Tor не ставится».
if (!ed25519.verify(Buffer.from(signature, "hex"), Buffer.from(manifest, "utf8"), Buffer.from(publicKey, "hex"))) {
  process.stderr.write("подпись не сходится собственной проверкой — не выкладывайте\n");
  process.exit(1);
}

const out = join("deploy", "onionize.json");
writeFileSync(out, JSON.stringify({ manifest, signature }, null, 2) + "\n");

process.stdout.write(`${out}\n`);
process.stdout.write(`${manifest}\n`);
process.stdout.write(`открытый ключ: ${publicKey}\n`);
process.stdout.write("Он обязан совпасть с RELEASE_PUBLIC_KEY в клиенте.\n");
