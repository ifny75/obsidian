/**
 * Счётчики в памяти. Ключ (IP) никуда не пишется и не логируется — он живёт
 * до конца окна и исчезает (ARCHITECTURE.md §10, §13.1).
 *
 * У карты есть потолок, и он тут не для красоты. Ограничитель заводит запись на
 * каждый невиданный ключ, то есть его размером управляет тот, кого он
 * ограничивает: чистка идёт по таймеру, а записи появляются со скоростью
 * запросов. Владельцу IPv6-подсети такой карты хватило бы, чтобы съесть память
 * сервера, ни разу не превысив ни одного лимита.
 *
 * Половину проблемы снимает `limitKey`, схлопывающий IPv6 до /64. Вторую —
 * этот потолок: когда мест нет, вытесняется запись, которой и так осталось
 * жить меньше всех. Вытеснение — это подарок вытесненному (его счётчик
 * обнулился), поэтому потолок берётся с большим запасом: он спасает от
 * исчерпания памяти, а не заменяет собой лимит.
 */
export class RateLimiter {
  readonly #hits = new Map<string, { count: number; resetAt: number }>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;

  constructor(limit: number, windowMs: number, maxKeys = 100_000) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#maxKeys = maxKeys;
  }

  /**
   * true — запрос разрешён.
   *
   * `factor` расширяет потолок для этого вызова, не подменяя его. Нужен ровно
   * одному случаю: соединения из Tor делят один ключ на всех, и обычный потолок
   * закрыл бы им вход целиком, стоит появиться одному шумному.
   *
   * Именно множитель, а не абсолютное число: с числом настройка самого
   * ограничителя переставала бы что-либо значить, и потолок незаметно
   * переезжал бы в место вызова.
   */
  allow(key: string, now: number, factor = 1): boolean {
    const limit = this.#limit * factor;
    const entry = this.#hits.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      if (!this.#hits.has(key) && this.#hits.size >= this.#maxKeys) this.#evict(now);
      this.#hits.set(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  }

  /** Для наблюдения за тем, не упёрлись ли мы в потолок. */
  get size(): number {
    return this.#hits.size;
  }

  #evict(now: number): void {
    this.sweep(now);
    if (this.#hits.size < this.#maxKeys) return;
    // Просроченных не нашлось — уходит ближайший к истечению.
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, entry] of this.#hits) {
      if (entry.resetAt < oldestAt) {
        oldestAt = entry.resetAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.#hits.delete(oldestKey);
  }

  sweep(now: number): void {
    for (const [key, entry] of this.#hits) {
      if (entry.resetAt <= now) this.#hits.delete(key);
    }
  }
}
