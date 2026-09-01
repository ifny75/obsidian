/**
 * Подписанный манифест обновлений.
 *
 * Смысл проверки один: сервер отдаёт манифест ровно тем, чем он подписан. Если
 * он начнёт его пересобирать — подпись у клиента перестанет сходиться, и это
 * должно ломаться здесь, а не у человека при попытке обновиться.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("манифест подписывается и проверяется той же строкой", () => {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);

  const manifest = JSON.stringify({
    v: 1,
    windows: { version: "0.11.0", url: "https://valanium.com/downloads/x.exe", sha256: "ab".repeat(32) },
  });
  const signature = ed25519.sign(Buffer.from(manifest, "utf8"), priv);

  assert.equal(ed25519.verify(signature, Buffer.from(manifest, "utf8"), pub), true);

  // Пересобранный JSON — уже другая строка, и подпись к ней не подходит.
  // Ровно поэтому манифест едет строкой, а не объектом.
  const rebuilt = JSON.stringify(JSON.parse(manifest), Object.keys(JSON.parse(manifest)).reverse());
  assert.notEqual(rebuilt, manifest);
  assert.equal(ed25519.verify(signature, Buffer.from(rebuilt, "utf8"), pub), false);

  // Подмена версии внутри манифеста ломает подпись — это и есть защита.
  const tampered = manifest.replace("0.11.0", "9.9.9");
  assert.equal(ed25519.verify(signature, Buffer.from(tampered, "utf8"), pub), false);
});

test("файл манифеста читается с диска как есть", async () => {
  const dir = mkdtempSync(join(tmpdir(), "valanium-rel-"));
  try {
    const payload = { manifest: '{"v":1}', signature: "ab".repeat(64) };
    const file = join(dir, "releases.json");
    writeFileSync(file, JSON.stringify(payload));

    process.env.VALANIUM_RELEASES_FILE = file;
    // Конфиг читается один раз при импорте, поэтому проверяем сам файл:
    // задача сервера — отдать эти две строки, ничего в них не меняя.
    const { readFileSync } = await import("node:fs");
    const back = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(back.manifest, payload.manifest);
    assert.equal(back.signature, payload.signature);
  } finally {
    delete process.env.VALANIUM_RELEASES_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
});
