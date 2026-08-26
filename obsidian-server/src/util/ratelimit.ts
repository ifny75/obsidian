/**
 * Счётчики в памяти. Ключ (IP) никуда не пишется и не логируется — он живёт
 * до конца окна и исчезает (ARCHITECTURE.md §10, §13.1).
 */
export class RateLimiter {
  readonly #hits = new Map<string, { count: number; resetAt: number }>();
  readonly #limit: number;
  readonly #windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /** true — запрос разрешён. */
  allow(key: string, now: number): boolean {
    const entry = this.#hits.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      this.#hits.set(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.#limit;
  }

  sweep(now: number): void {
    for (const [key, entry] of this.#hits) {
      if (entry.resetAt <= now) this.#hits.delete(key);
    }
  }
}
