/**
 * Потолки карт в памяти.
 *
 * Ограничитель и хранилище challenge-ов заводят запись на каждый невиданный
 * ключ — то есть их размером управляет тот, кого они ограничивают. Проверяется
 * ровно это: что расти бесконечно они не могут и что при переполнении ведут
 * себя предсказуемо, а не как придётся.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { RateLimiter } from "../src/util/ratelimit.ts";
import { NonceStore } from "../src/auth/nonce.ts";

test("карта ограничителя не растёт выше потолка", () => {
  const limiter = new RateLimiter(5, 60_000, 10);
  const now = 1_000;

  for (let i = 0; i < 1000; i += 1) {
    assert.equal(limiter.allow(`адрес-${i}`, now), true, "новый ключ обязан проходить");
  }
  assert.equal(limiter.size, 10, "размер карты задаёт потолок, а не поток запросов");
});

test("при переполнении уходит ближайший к истечению, а не свежий", () => {
  const limiter = new RateLimiter(5, 60_000, 2);

  // Окно у каждого своё, потому что заведены они в разное время.
  limiter.allow("старый", 0);
  limiter.allow("свежий", 10_000);

  // Третий ключ вытесняет того, кому осталось жить меньше всех.
  limiter.allow("новый", 11_000);
  assert.equal(limiter.size, 2);

  // «Свежий» свой счёт сохранил: следующий его запрос — второй, а не первый.
  for (let i = 0; i < 4; i += 1) limiter.allow("свежий", 11_000);
  assert.equal(limiter.allow("свежий", 11_000), false, "счётчик свежего не должен обнуляться");
});

test("просроченные уходят раньше живых", () => {
  const limiter = new RateLimiter(5, 1_000, 2);
  limiter.allow("протух", 0);
  limiter.allow("живой", 900);

  // К этому времени первое окно закрыто — вытеснять живого незачем.
  limiter.allow("новый", 1_500);
  assert.equal(limiter.size, 2);
  for (let i = 0; i < 4; i += 1) limiter.allow("живой", 1_500);
  assert.equal(limiter.allow("живой", 1_500), false, "живой счётчик обязан был уцелеть");
});

test("исчерпанный запас challenge-ов отвечает отказом, а не молча растёт", () => {
  const nonces = new NonceStore(30, 3);
  const now = 1_000;

  assert.ok(nonces.issue(now));
  assert.ok(nonces.issue(now));
  assert.ok(nonces.issue(now));
  assert.equal(nonces.size, 3);

  // Мест нет и просроченных нет — честный отказ. Соединение после него
  // закрывается: без challenge войти всё равно нечем.
  assert.equal(nonces.issue(now), null);
  assert.equal(nonces.size, 3, "отказ не должен ничего добавлять");
});

test("место освобождается, когда challenge-ы протухают", () => {
  const nonces = new NonceStore(30, 2);
  assert.ok(nonces.issue(0));
  assert.ok(nonces.issue(0));
  assert.equal(nonces.issue(0), null);

  // Тридцать секунд спустя оба протухли — вход снова открыт, и чистка
  // происходит сама, без ожидания таймера.
  const later = 31_000;
  assert.ok(nonces.issue(later));
  assert.equal(nonces.size, 1);
});

test("выданный challenge по-прежнему принимается ровно один раз", () => {
  const nonces = new NonceStore(30, 10);
  const nonce = nonces.issue(0);
  assert.ok(nonce);
  assert.equal(nonces.consume(nonce, 1_000), true);
  assert.equal(nonces.consume(nonce, 1_000), false, "повтор недопустим");
});
