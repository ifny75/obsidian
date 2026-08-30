/**
 * Вход через Tor.
 *
 * Проверяется то, ради чего он выделен в отдельное ведро: что метку входа
 * нельзя прислать самому, что адрес из заголовка при ней не берётся, и что
 * общий потолок при этом существует, а не «отключён для Tor».
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ONION_KEY, blindedClient, clientAddress, isOnion } from "../src/util/connections.ts";
import { RateLimiter } from "../src/util/ratelimit.ts";

const TRUSTED = ["127.0.0.1", "::1"];

test("метке входа верим только от своего же nginx", () => {
  // Так её ставит relay: запрос дошёл до приложения с петли.
  assert.equal(isOnion("127.0.0.1", "onion", TRUSTED), true);

  // А так её прислал бы кто-то, кто дотянулся до приложения мимо nginx.
  // Поверить ему значило бы отдать всем желающим щедрые лимиты Tor.
  assert.equal(isOnion("203.0.113.7", "onion", TRUSTED), false);

  // Чужая метка и пустая метка — обычный вход.
  assert.equal(isOnion("127.0.0.1", "cloudflare", TRUSTED), false);
  assert.equal(isOnion("127.0.0.1", "", TRUSTED), false);
});

test("через Tor адрес из заголовка не берётся", () => {
  /*
    Это и была дыра. На onion-входе Cloudflare нет, перезаписать CF-Connecting-IP
    некому, и клиент назначал бы себе любой адрес: обходил бы свои лимиты и
    приписывал бы трафик чужому IP.

    Теперь заголовок обнуляет nginx (см. deploy/mesh/obsidian-proxy.conf), а
    приложение таким соединениям адрес вообще не считает — у них общий ключ.
  */
  const forged = "203.0.113.7";
  const onion = isOnion("127.0.0.1", "onion", TRUSTED);
  const key = onion ? ONION_KEY : clientAddress("127.0.0.1", forged, TRUSTED);

  assert.equal(key, ONION_KEY);
  assert.notEqual(key, forged, "подделанный адрес не должен становиться ключом");

  // При этом обычный путь через Cloudflare заголовку по-прежнему верит:
  // там его ставит сам Cloudflare, перезаписывая присланное клиентом.
  assert.equal(clientAddress("127.0.0.1", forged, TRUSTED), forged);
});

test("общий ключ Tor щедрее обычного, но не безграничен", () => {
  const limiter = new RateLimiter(10, 60_000);
  const factor = 20;
  const now = 1_000;

  // Обычному адресу — свои десять.
  for (let i = 0; i < 10; i++) {
    assert.equal(limiter.allow("203.0.113.7", now), true, `попытка ${i + 1}`);
  }
  assert.equal(limiter.allow("203.0.113.7", now), false, "одиннадцатая должна упереться");

  // Общему ведру Tor — в двадцать раз больше, потому что за ним все сразу.
  for (let i = 0; i < 200; i++) {
    assert.equal(limiter.allow(ONION_KEY, now, factor), true, `Tor, попытка ${i + 1}`);
  }
  assert.equal(limiter.allow(ONION_KEY, now, factor), false, "потолок обязан быть и здесь");
});

test("множитель не подменяет настройку ограничителя", () => {
  // Иначе потолок незаметно переезжает из ограничителя в место вызова, и
  // настройка перестаёт что-либо значить.
  const strict = new RateLimiter(3, 60_000);
  assert.equal(strict.allow("k", 0), true);
  assert.equal(strict.allow("k", 0), true);
  assert.equal(strict.allow("k", 0), true);
  assert.equal(strict.allow("k", 0), false, "своя настройка обязана действовать");

  const shared = new RateLimiter(3, 60_000);
  for (let i = 0; i < 6; i++) assert.equal(shared.allow("k", 0, 2), true);
  assert.equal(shared.allow("k", 0, 2), false, "множитель считается от неё же");
});

/*
  Жетон вместо адреса.

  Настоящий IP до приложения больше не доезжает: узел заменяет его на HMAC.
  Проверяется то же, что и у метки входа, — что верим мы только своему nginx, —
  и что форма жетона задана нами, а не тем, кто его прислал.
*/

test("жетон принимается только от своего же nginx", () => {
  const token = "0123456789abcdef";
  assert.equal(blindedClient("127.0.0.1", token, TRUSTED), token);

  // Пришедший мимо узла назначил бы себе любой жетон и делил бы лимиты с кем
  // угодно — или, наоборот, выедал чужие.
  assert.equal(blindedClient("203.0.113.7", token, TRUSTED), null);
});

test("форму жетона задаём мы, а не отправитель", () => {
  // Шестнадцать шестнадцатеричных знаков — то, что выдаёт узел. Всё прочее
  // игнорируется: доверять форме, которую мы не выдавали, незачем.
  for (const bad of ["", "короткий", "0123456789ABCDEF", "0123456789abcdefff", "не жетон"]) {
    assert.equal(blindedClient("127.0.0.1", bad, TRUSTED), null, `принят негодный: ${bad}`);
  }
  // Пробелы по краям — обычное дело для заголовка.
  assert.equal(blindedClient("127.0.0.1", " 0123456789abcdef ", TRUSTED), "0123456789abcdef");
});

test("без жетона остаётся прежний путь по адресу", () => {
  // Прямое соединение мимо узла: разработческая машина или проверка руками.
  assert.equal(blindedClient("127.0.0.1", "", TRUSTED), null);
  assert.equal(clientAddress("127.0.0.1", "203.0.113.7", TRUSTED), "203.0.113.7");
});
