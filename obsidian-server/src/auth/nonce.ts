import { random, toHex } from "../util/bytes.ts";

/**
 * Одноразовые challenge-nonce. Только в памяти: переживать перезапуск им не
 * нужно, а на диске это лишний след.
 */
export class NonceStore {
  readonly #issued = new Map<string, number>();
  readonly #ttlMs: number;

  constructor(ttlSec: number) {
    this.#ttlMs = ttlSec * 1000;
  }

  issue(now: number): Uint8Array {
    const nonce = random(32);
    this.#issued.set(toHex(nonce), now + this.#ttlMs);
    return nonce;
  }

  /** Возвращает true ровно один раз на каждый выданный nonce. */
  consume(nonce: Uint8Array, now: number): boolean {
    const key = toHex(nonce);
    const expires = this.#issued.get(key);
    if (expires === undefined) return false;
    this.#issued.delete(key);
    return expires > now;
  }

  sweep(now: number): void {
    for (const [key, expires] of this.#issued) {
      if (expires <= now) this.#issued.delete(key);
    }
  }

  get size(): number {
    return this.#issued.size;
  }
}
