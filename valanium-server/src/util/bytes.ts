import { randomBytes, timingSafeEqual } from "node:crypto";

const HEX = /^[0-9a-f]+$/;

/** Строгий разбор hex: нижний регистр, точная длина. Всё внешнее — через это. */
export function fromHex(s: unknown, expectedBytes?: number): Uint8Array {
  if (typeof s !== "string") throw new BadInput("expected hex string");
  if (s.length % 2 !== 0) throw new BadInput("odd hex length");
  if (s.length !== 0 && !HEX.test(s)) throw new BadInput("not lowercase hex");
  if (expectedBytes !== undefined && s.length !== expectedBytes * 2) {
    throw new BadInput(`expected ${expectedBytes} bytes`);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("hex");
}

export function random(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

/** Сравнение секретов — только так (ARCHITECTURE.md §13.6). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export function ascii(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "ascii"));
}

export function readU32BE(b: Uint8Array, offset: number): number {
  if (offset + 4 > b.byteLength) throw new BadInput("truncated u32");
  return ((b[offset]! << 24) >>> 0) + (b[offset + 1]! << 16) + (b[offset + 2]! << 8) + b[offset + 3]!;
}

export function writeU64BE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, false);
  return out;
}

/**
 * Проверка длины ДО обращения по смещению (ARCHITECTURE.md §13.4).
 * Возвращает view без копирования — вызывающий обязан скопировать, если
 * буфер приехал из uWS.
 */
export function slice(b: Uint8Array, start: number, end: number): Uint8Array {
  if (start < 0 || end > b.byteLength || start > end) throw new BadInput("out of bounds");
  return b.subarray(start, end);
}

/** Ошибка разбора внешних данных. Никогда не несёт содержимого — только причину. */
export class BadInput extends Error {}
