/**
 * Сколько сокетов держит один адрес.
 *
 * Ограничители в `ratelimit.ts` считают события в окне — попытки входа, поиски,
 * отправки. Соединение событием не является: его открывают один раз и держат
 * сколько угодно. Пока оно не прошло AUTH, оно ничего не стоит открывшему и
 * занимает у нас сокет, запись в user data и место в очереди эполла — до
 * `idleTimeout`, то есть полторы минуты. Тысяча таких с одной машины — и живым
 * людям не остаётся дескрипторов.
 *
 * Считается именно одновременность, а не частота: разорвать и открыть заново
 * ничего не даёт.
 */
export class ConnectionCounter {
  readonly #open = new Map<string, number>();

  /** Сколько сейчас держит адрес. */
  count(key: string): number {
    return this.#open.get(key) ?? 0;
  }

  add(key: string): number {
    const next = this.count(key) + 1;
    this.#open.set(key, next);
    return next;
  }

  /**
   * Ключ исчезает вместе с последним сокетом: иначе карта растёт по числу
   * увиденных адресов и становится своей собственной утечкой.
   */
  remove(key: string): void {
    const left = this.count(key) - 1;
    if (left > 0) this.#open.set(key, left);
    else this.#open.delete(key);
  }

  /** Для журнала: сколько адресов сейчас на связи. */
  get addresses(): number {
    return this.#open.size;
  }
}

/**
 * Настоящий адрес клиента.
 *
 * `CF-Connecting-IP` ставит Cloudflare, но поставить его может кто угодно, кто
 * дотянулся до сервера мимо туннеля: тогда он назначает себе любой адрес, и все
 * ограничители по IP превращаются в украшение. Поэтому заголовок принимается
 * только от того, кто сам пришёл с доверенного адреса — cloudflared ходит с
 * петли. Все остальные считаются по своему настоящему адресу, что бы они о себе
 * ни написали.
 */
export function clientAddress(peer: string, claimed: string, trusted: readonly string[]): string {
  if (claimed === "" || !trusted.includes(peer)) return peer;
  // Заголовок может прийти списком: первый в нём — исходный клиент.
  const first = claimed.split(",")[0]!.trim();
  return first === "" ? peer : first;
}

