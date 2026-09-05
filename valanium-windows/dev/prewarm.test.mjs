/**
 * Прогрев цепи Tor: когда греем, а когда нет.
 *
 * Проверяется НАСТОЯЩИЙ кусок main.js, вырезанный из файла, а не его копия:
 * тест копии проверял бы копию и молчал бы ровно тогда, когда оригинал
 * разойдётся с ней.
 *
 * Полноценного DOM тут нет и не нужно: решение «греть или нет» зависит от
 * выбранного маршрута и состояния Tor, а не от разметки.
 *
 *   node valanium-windows/dev/prewarm.test.mjs
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");
const from = source.indexOf("const ONIONIZE_URL");
const to = source.indexOf('for (const button of document.querySelectorAll("#hop-segment');
assert.ok(from > 0 && to > from, "не нашёл блок onionize в main.js");
const block = source.slice(from, to);

/** Прогоняет блок с заданным состоянием и возвращает список вызванных команд. */
function run({ transport, installed, running }) {
  const calls = [];
  const element = () => ({
    classList: { toggle() {} },
    addEventListener() {},
    textContent: "",
    disabled: false,
  });
  const context = {
    preferences: { transport },
    $: () => element(),
    toast: () => {},
    fetch: async () => {
      throw new Error("прогрев не должен ходить в сеть");
    },
    invoke: async (name) => {
      calls.push(name);
      if (name === "onionize_status") return { installed, running, socks: null };
      if (name === "onionize_start") return "127.0.0.1:1";
      return null;
    },
  };
  // Блок заканчивается вызовами refreshOnionize/prewarmOnionize; даём циклу
  // событий провернуться, иначе увидим список команд до их завершения.
  const fn = new Function(
    ...Object.keys(context),
    `${block}\nreturn new Promise((done) => setTimeout(done, 0));`,
  );
  return fn(...Object.values(context)).then(() => calls);
}

const started = (calls) => calls.includes("onionize_start");

let calls = await run({ transport: "onion", installed: true, running: false });
assert.ok(started(calls), `выбран Onion и он поставлен — обязаны греть: ${calls}`);

// Держать Tor поднятым на обычных маршрутах значило бы тратить батарею и
// трафик на то, чем человек не пользуется, и оставлять след без спроса.
calls = await run({ transport: "basic", installed: true, running: false });
assert.ok(!started(calls), `маршрут не Onion — греть не должны: ${calls}`);

// Auto держит Tor запасным вариантом, а не основным.
calls = await run({ transport: "auto", installed: true, running: false });
assert.ok(!started(calls), `Auto — Tor запасной, греть не должны: ${calls}`);

calls = await run({ transport: "onion", installed: false, running: false });
assert.ok(!started(calls), `не установлен — запускать нечего: ${calls}`);

calls = await run({ transport: "onion", installed: true, running: true });
assert.ok(!started(calls), `уже работает — второй раз не поднимаем: ${calls}`);

process.stdout.write("все проверки прогрева прошли\n");
