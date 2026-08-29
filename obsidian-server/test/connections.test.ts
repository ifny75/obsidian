/**
 * Учёт соединений и выбор настоящего адреса клиента.
 *
 * Оба относятся к одному: ограничители считают по адресу, и всё держится на
 * том, что адрес нельзя себе назначить.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ConnectionCounter, clientAddress, limitKey } from "../src/util/connections.ts";

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

test("IPv6 считается по /64, а не по полному адресу", () => {
  // Владельцу /64 последние четыре группы ничего не стоят: считая по полному
  // адресу, мы считали бы по величине, которую он меняет бесконечно.
  const one = limitKey("2001:db8:1234:5678:1:2:3:4");
  const other = limitKey("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");
  assert.equal(one, other, "адреса из одной /64 обязаны давать один ключ");

  // Соседняя /64 — уже другой абонент.
  assert.notEqual(one, limitKey("2001:db8:1234:5679:1:2:3:4"));
});

test("сокращённая запись IPv6 разворачивается перед обрезкой", () => {
  assert.equal(limitKey("2001:db8::1"), limitKey("2001:db8:0:0:ffff:ffff:ffff:ffff"));
  assert.equal(limitKey("::1"), limitKey("0:0:0:0:1:2:3:4"), "петля тоже адрес");
  // Хвост слева от `::` учитывается: две разные /64 не должны слиться.
  assert.notEqual(limitKey("2001:db8:1::1"), limitKey("2001:db8:2::1"));
});

test("IPv4 остаётся собой, в том числе записанный как IPv6", () => {
  assert.equal(limitKey("198.51.100.4"), "198.51.100.4");
  // uWS отдаёт адреса IPv4 в отображённом виде — это по-прежнему один хост,
  // и обрезать его до /64 значило бы слить весь IPv4 в один ключ.
  assert.equal(limitKey("::ffff:198.51.100.4"), "198.51.100.4");
  assert.notEqual(limitKey("::ffff:198.51.100.4"), limitKey("::ffff:198.51.100.5"));
});

test("мусор вместо адреса не превращается в общий ключ", () => {
  // Разобрать не вышло — ключом остаётся то, что пришло. Слить всё нераспознанное
  // в одну корзину нельзя: тогда один странный адрес выключал бы вход всем.
  assert.equal(limitKey("не адрес"), "не адрес");
  assert.equal(limitKey("1:2:3::4::5"), "1:2:3::4::5");
});

test("неназвавшиеся считаются отдельно и списываются ровно один раз", () => {
  const counter = new ConnectionCounter();
  counter.add("a");
  counter.add("a");
  counter.add("b");
  assert.equal(counter.unauthenticated, 3);

  counter.settled();
  assert.equal(counter.unauthenticated, 2, "вошедший перестаёт быть анонимным");

  // Лишний вызов не должен уводить счётчик в минус: иначе потолок перестал бы
  // работать после первой же рассинхронизации.
  counter.settled();
  counter.settled();
  counter.settled();
  assert.equal(counter.unauthenticated, 0);

  counter.add("c");
  assert.equal(counter.unauthenticated, 1);
});
