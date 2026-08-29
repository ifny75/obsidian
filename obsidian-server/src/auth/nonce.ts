import { random, toHex } from "../util/bytes.ts";

/**
 * Одноразовые challenge-nonce. Только в памяти: переживать перезапуск им не
 * нужно, а на диске это лишний след.
 *
 * Потолок здесь нужен по той же причине, что и в ограничителе, но случай хуже:
 * nonce живёт свои тридцать секунд независимо от того, ушёл ли открывший.
 * Подключиться, забрать challenge и оборвать связь можно быстрее, чем протухает
 * предыдущий, — то есть число висящих задаётся не числом соединений, а
 * скоростью их открытия.
 *
 * Упершись в потолок, `issue` возвращает null, и соединение закрывается. Это
 * осознанный отказ: без challenge войти всё равно нельзя, и лучше сказать
 * «занято» одному, чем остаться без памяти для всех.
 */
export class NonceStore {
  readonly #issued = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #max: number;

  constructor(ttlSec: number, max = 50_000) {
    this.#ttlMs = ttlSec * 1000;
    this.#max = max;
  }

  issue(now: number): Uint8Array | null {
    if (this.#issued.size >= this.#max) {
      this.sweep(now);
      if (this.#issued.size >= this.#max) return null;
    }
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
