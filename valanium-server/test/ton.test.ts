/**
 * Разбор комментария TON. Здесь нет сети: ячейки собираются теми же
 * примитивами @ton/core, которыми их собирает кошелёк отправителя.
 *
 * Платный вход сейчас выключен, а его пакеты лежат в optionalDependencies —
 * при установке с `--omit=optional` этот файл пропускается целиком, а не падает.
 * Логика при этом никуда не делась: включается обратно одним VALANIUM_TON_ADDRESS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { minAccepted } from "../src/ton/watcher.ts";
import { tonToNano } from "../src/config.ts";

type TonCore = typeof import("@ton/core");
type Source = typeof import("../src/ton/source.ts");

let ton: TonCore | null = null;
let source: Source | null = null;
try {
  ton = await import("@ton/core");
  source = await import("../src/ton/source.ts");
} catch {
  // Пакеты TON не установлены — проверки разбора ячеек пропускаем.
}

const skip = ton === null ? "@ton/core не установлен (npm ci --omit=optional)" : false;

/** Так кошелёк кладёт текстовый memo: 32 нулевых бита, затем строка. */
function commentBody(text: string) {
  return ton!.beginCell().storeUint(0, 32).storeStringTail(text).endCell();
}

test("memo читается из тела сообщения", { skip }, () => {
  assert.equal(source!.readComment(commentBody("abcdefghij")), "abcdefghij");
});

test("длинный memo, размазанный по дочерним ячейкам, собирается целиком", { skip }, () => {
  // В одну ячейку влезает 127 байт, дальше идёт «змейка» из дочерних.
  const long = "x".repeat(500);
  assert.equal(source!.readComment(commentBody(long)), long);
});

test("пустое тело и тело без места под опкод дают null", { skip }, () => {
  assert.equal(source!.readComment(ton!.beginCell().endCell()), null);
  assert.equal(source!.readComment(ton!.beginCell().storeUint(0, 16).endCell()), null);
});

test("не-текстовое тело игнорируется, а не принимается за memo", { skip }, () => {
  // Любой ненулевой опкод — это уже не комментарий, а вызов контракта.
  const jettonTransfer = ton!.beginCell().storeUint(0x0f8a7ea5, 32).storeUint(42, 64).endCell();
  assert.equal(source!.readComment(jettonTransfer), null);
});

test("memo с юникодом не ломает разбор", { skip }, () => {
  assert.equal(source!.readComment(commentBody("счёт №7 ✓")), "счёт №7 ✓");
});

test("tonToNano не теряет точность на дробях", () => {
  assert.equal(tonToNano("3"), 3_000_000_000n);
  assert.equal(tonToNano("3.5"), 3_500_000_000n);
  assert.equal(tonToNano("0.000000001"), 1n);
  assert.equal(tonToNano("10.123456789"), 10_123_456_789n);
  assert.throws(() => tonToNano("3.1234567891"), /decimal/);
  assert.throws(() => tonToNano("abc"), /decimal/);
});

test("допуск считается в целых, без плавающей точки", () => {
  assert.equal(minAccepted(tonToNano("3"), 200), 2_940_000_000n);
  assert.equal(minAccepted(tonToNano("0.000000001"), 200), 0n);
});
