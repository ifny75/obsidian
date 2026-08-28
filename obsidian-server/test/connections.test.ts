/**
 * Учёт соединений и выбор настоящего адреса клиента.
 *
 * Оба относятся к одному: ограничители считают по адресу, и всё держится на
 * том, что адрес нельзя себе назначить.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ConnectionCounter, clientAddress } from "../src/util/connections.ts";

const TRUSTED = ["127.0.0.1", "::1"];

test("адрес берётся из заголовка только у доверенного прокси", () => {
  // cloudflared с петли — верим тому, что он пишет.
  assert.equal(clientAddress("127.0.0.1", "203.0.113.7", TRUSTED), "203.0.113.7");

  // Кто пришёл мимо туннеля — считается по своему настоящему адресу, что бы
  // он о себе ни написал. Иначе ограничители обходятся одним заголовком.
  assert.equal(clientAddress("198.51.100.4", "203.0.113.7", TRUSTED), "198.51.100.4");
  assert.equal(clientAddress("198.51.100.4", "127.0.0.1", TRUSTED), "198.51.100.4");

  // Заголовка нет — остаётся настоящий адрес.
  assert.equal(clientAddress("198.51.100.4", "", TRUSTED), "198.51.100.4");
  assert.equal(clientAddress("127.0.0.1", "", TRUSTED), "127.0.0.1");
});

test("из списка адресов берётся первый — исходный клиент", () => {
  assert.equal(clientAddress("127.0.0.1", "203.0.113.7, 70.41.3.18", TRUSTED), "203.0.113.7");
  // Пустой заголовок от доверенного прокси не должен давать пустой ключ:
  // все безымянные соединения слились бы в один счётчик.
  assert.equal(clientAddress("127.0.0.1", " , 70.41.3.18", TRUSTED), "127.0.0.1");
});

test("счётчик растёт и убывает, а пустой ключ исчезает", () => {
  const counter = new ConnectionCounter();
  assert.equal(counter.count("a"), 0);

  assert.equal(counter.add("a"), 1);
  assert.equal(counter.add("a"), 2);
  assert.equal(counter.add("b"), 1);
  assert.equal(counter.addresses, 2);

  counter.remove("a");
  assert.equal(counter.count("a"), 1);

  counter.remove("a");
  assert.equal(counter.count("a"), 0);
  // Ключ обязан уйти вместе с последним сокетом, иначе карта растёт по числу
  // увиденных адресов и становится своей собственной утечкой.
  assert.equal(counter.addresses, 1);

  counter.remove("b");
  assert.equal(counter.addresses, 0);
});

test("лишний remove не уводит счётчик в минус", () => {
  const counter = new ConnectionCounter();
  counter.remove("a");
  counter.remove("a");
  assert.equal(counter.count("a"), 0);
  assert.equal(counter.addresses, 0);

  assert.equal(counter.add("a"), 1);
});
