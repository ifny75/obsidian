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
  #unauthenticated = 0;

  /** Сколько сейчас держит адрес. */
  count(key: string): number {
    return this.#open.get(key) ?? 0;
  }

  add(key: string): number {
    const next = this.count(key) + 1;
    this.#open.set(key, next);
    this.#unauthenticated += 1;
    return next;
  }

  /**
   * Сокет перестал быть анонимным: прошёл AUTH или закрылся.
   *
   * Считается отдельно от общего числа потому, что стоит совсем другого.
   * Соединение вошедшего человека привязано к личности, к ней же привязаны все
   * ведра ограничителей, и завести вторую личность стоит инвайта. Соединение,
   * которое ещё не назвалось, не стоит открывшему ничего — а нам стоит сокета,
   * записи в user data и выданного nonce.
   */
  settled(): void {
    if (this.#unauthenticated > 0) this.#unauthenticated -= 1;
  }

  /** Сколько сокетов сейчас висит, не назвавшись. */
  get unauthenticated(): number {
    return this.#unauthenticated;
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


/**
 * Ключ, по которому считаются лимиты.
 *
 * Для IPv4 это сам адрес. Для IPv6 — только первые 64 бита, и это не
 * придирка к формату: провайдеры раздают /64 одному абоненту, а иногда и /48.
 * Считая по полному адресу, мы бы считали по величине, которую владелец
 * подсети меняет бесплатно и бесконечно: и потолок соединений, и все ведра
 * ограничителей обходятся сменой последних четырёх групп. Схлопывание до /64
 * делает ключ тем, чем он и должен быть, — адресом абонента, а не сокета.
 *
 * Плата известна и принята: за одной /64 может сидеть несколько человек, и они
 * делят лимит. Это ровно та же плата, что мы уже платим за общий NAT в IPv4.
 */
export function limitKey(address: string): string {
  // Адрес IPv4, записанный как IPv6 (`::ffff:1.2.3.4`), — это IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1]!;
  if (!address.includes(":")) return address;

  const groups = expandV6(address);
  return groups === null ? address : `${groups.slice(0, 4).join(":")}::/64`;
}

/** Восемь групп IPv6 или null, если это не похоже на адрес. */
function expandV6(address: string): string[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : [];
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array<string>(missing).fill("0"), ...tail];
}
