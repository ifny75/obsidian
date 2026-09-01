/**
 * Подписывает манифест релизов.
 *
 *   node deploy/sign-release.mjs windows 0.11.0 release/Valanium-Portable-Windows-0.11.0.exe \
 *                                android 0.6.2 release/Valanium-Android-arm64-0.6.2.apk
 *
 * Зачем это существует. Клиент скачивает сборку по ссылке с нашего же сервера,
 * и до сих пор ничто не мешало подменить файл тому, кто получил доступ к
 * серверу, к Cloudflare или к любому удостоверяющему центру: человек скачал бы
 * троян с правильного адреса. Это обесценивает всё остальное разом — и MLS, и
 * замок приложения, и шифрование хранилища.
 *
 * Поэтому версии и хеши подписываются ключом, которого на сервере нет и
 * никогда не будет. Открытая половина зашита в клиент; сервер отдаёт манифест
 * и подпись как есть, и подменить их незаметно не может.
 *
 * Приватный ключ лежит в ~/.valanium-release/signing.key и в репозиторий не
 * попадает. Потеряете — заведёте новый и выпустите клиент с новым открытым
 * ключом; до тех пор обновления перестанут подтверждаться.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "../valanium-server/node_modules/@noble/curves/ed25519.js";

const KEY_PATH = process.env.VALANIUM_SIGNING_KEY
  ?? join(homedir(), ".valanium-release", "signing.key");

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 3 !== 0) {
  process.stderr.write(
    "usage: node deploy/sign-release.mjs <платформа> <версия> <файл> [...]\n"
    + "платформа: windows | android\n",
  );
  process.exit(2);
}

/** Хеш файла — то, что человек сможет сверить со скачанным. */
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const platforms = {};
for (let i = 0; i < args.length; i += 3) {
  const [platform, version, file] = args.slice(i, i + 3);
  if (platform !== "windows" && platform !== "android") {
    process.stderr.write(`неизвестная платформа: ${platform}\n`);
    process.exit(2);
  }
  const name = platform === "windows"
    ? `Valanium-${version}.exe`
    : `Valanium-${version}.apk`;
  platforms[platform] = {
    version,
    url: `https://valanium.com/downloads/${name}`,
    sha256: sha256(file),
    bytes: readFileSync(file).length,
  };
}

/*
  Подпись считается по строке, а не по объекту: сервер отдаёт эту же строку
  байт в байт, и клиент проверяет ровно её. Иначе пришлось бы договариваться о
  каноническом виде JSON — а любое расхождение в нём означало бы либо ложную
  тревогу, либо, что хуже, молчаливо принятую подделку.
*/
const manifest = JSON.stringify({
  v: 1,
  channel: "public-beta",
  publishedAt: new Date().toISOString(),
  ...platforms,
});

const priv = Buffer.from(readFileSync(KEY_PATH, "utf8").trim(), "hex");
const signature = Buffer.from(ed25519.sign(Buffer.from(manifest, "utf8"), priv)).toString("hex");
const publicKey = Buffer.from(ed25519.getPublicKey(priv)).toString("hex");

const out = join("deploy", "releases.json");
writeFileSync(out, JSON.stringify({ manifest, signature }, null, 2) + "\n");

process.stdout.write(`${out}\n`);
process.stdout.write(`${manifest}\n`);
process.stdout.write(`открытый ключ: ${publicKey}\n`);
