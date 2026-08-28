/**
 * Проверка по эталонным векторам RFC 6238 приложения B.
 *
 * Самодельный TOTP, который «вроде считает», — худший вид готового кода: он
 * молча расходится с приложением пользователя, и виноватым выглядит человек.
 * Поэтому здесь не свои примеры, а те, что напечатаны в стандарте.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  codeFor,
  decodeBase32,
  encodeBase32,
  otpauthUrl,
  STEP_SECONDS,
  verify,
} from "../src/auth/totp.ts";

/** Секрет из RFC 6238: ASCII «12345678901234567890». */
const RFC_SECRET = new TextEncoder().encode("12345678901234567890");

test("совпадает с эталонными векторами RFC 6238", () => {
  // Время в секундах → ожидаемый восьмизначный код из таблицы стандарта.
  // Мы отдаём шесть цифр, поэтому сравниваем с шестью младшими.
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  for (const [seconds, eight] of vectors) {
    const counter = Math.floor(seconds / STEP_SECONDS);
    assert.equal(codeFor(RFC_SECRET, counter), eight.slice(-6), `время ${seconds}`);
  }
});

test("код принимается в своём окне и рядом с ним", () => {
  const now = 1111111109_000;
  const counter = Math.floor(now / 1000 / STEP_SECONDS);

  assert.ok(verify(RFC_SECRET, codeFor(RFC_SECRET, counter), now), "текущий шаг");
  // Часы телефона почти всегда немного расходятся с сервером.
  assert.ok(verify(RFC_SECRET, codeFor(RFC_SECRET, counter - 1), now), "шаг назад");
  assert.ok(verify(RFC_SECRET, codeFor(RFC_SECRET, counter + 1), now), "шаг вперёд");

  // А вот минутой раньше код уже не должен подходить: подсмотренный код не
  // обязан работать вечно.
  assert.ok(!verify(RFC_SECRET, codeFor(RFC_SECRET, counter - 3), now), "три шага назад");
  assert.ok(!verify(RFC_SECRET, codeFor(RFC_SECRET, counter + 3), now), "три шага вперёд");
});

test("мусор вместо кода не проходит", () => {
  const now = Date.now();
  for (const bad of ["", "12345", "1234567", "abcdef", "12 34 56 78", "٠١٢٣٤٥"]) {
    assert.equal(verify(RFC_SECRET, bad, now), false, `принято: ${bad}`);
  }
  // Пробелы и дефисы внутри шести цифр человек ставит сам — их прощаем.
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  const code = codeFor(RFC_SECRET, counter);
  assert.ok(verify(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now));
});

test("base32 ходит туда и обратно", () => {
  const secret = Uint8Array.from({ length: 20 }, (_, i) => (i * 7 + 3) & 0xff);
  assert.deepEqual(decodeBase32(encodeBase32(secret)), secret);
  // Так секрет выглядит в приложении: группами и в любом регистре.
  const shown = encodeBase32(secret);
  const typed = `${shown.slice(0, 4)} ${shown.slice(4, 8)} ${shown.slice(8)}`.toLowerCase();
  assert.deepEqual(decodeBase32(typed), secret);
});

test("испорченный base32 отвергается, а не угадывается", () => {
  assert.equal(decodeBase32(""), null);
  assert.equal(decodeBase32("0189"), null, "цифры вне алфавита");
  assert.equal(decodeBase32("ABC!"), null);
  // Ненулевой хвост: иначе две разные записи дали бы один секрет.
  assert.equal(decodeBase32("ABCDEFGH" + "B"), null);
});

test("ссылка для QR содержит всё, что нужно приложению", () => {
  const url = otpauthUrl(RFC_SECRET, "obsidian:alice");
  assert.match(url, /^otpauth:\/\/totp\/Obsidian:obsidian%3Aalice\?/);
  assert.match(url, /secret=[A-Z2-7]+/);
  assert.match(url, /issuer=Obsidian/);
  assert.match(url, /digits=6/);
  assert.match(url, /period=30/);
});
