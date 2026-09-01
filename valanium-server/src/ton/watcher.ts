import { log } from "../log.ts";
import type { Store } from "../db/index.ts";
import type { ChainSource } from "./source.ts";

/** Символы memo. Тот же алфавит, что и в генераторе счетов. */
const REF_RE = /^[abcdefghijkmnpqrstuvwxyz23456789]{10}$/;

export interface WatcherOptions {
  /** Допуск на комиссии, базисные пункты: 200 = принимаем от 98% суммы. */
  toleranceBp: number;
}

/**
 * Сверяет входящие переводы со счетами. Ничего не решает про регистрацию —
 * только проставляет `paid_at`; погашение счёта происходит в AUTH.
 */
export class PaymentWatcher {
  readonly #store: Store;
  readonly #source: ChainSource;
  readonly #onPaid: (ref: string) => void;
  readonly #toleranceBp: number;

  constructor(
    store: Store,
    source: ChainSource,
    onPaid: (ref: string) => void,
    options: WatcherOptions,
  ) {
    this.#store = store;
    this.#source = source;
    this.#onPaid = onPaid;
    this.#toleranceBp = options.toleranceBp;
  }

  /** Возвращает число закрытых счетов. Исключения наружу не выпускает. */
  async tick(now: number): Promise<number> {
    let scan;
    try {
      const cursor = this.#store.getCursor();
      scan = await this.#source.scan(cursor?.last_lt ?? null);
    } catch (err) {
      // Лайтсервер моргнул — не наша беда, попробуем на следующем такте.
      log.warn("ton poll failed", { reason: err instanceof Error ? err.name : "unknown" });
      return 0;
    }

    let credited = 0;
    for (const transfer of scan.transfers) {
      if (this.#credit(transfer.comment, transfer.amountNano, now)) credited += 1;
    }

    // Курсор двигаем всегда, когда источник сказал докуда досмотрел, — даже
    // если ни один перевод не подошёл. Иначе хвост перечитывается вечно.
    if (scan.cursor) this.#store.setCursor(scan.cursor.lt, scan.cursor.hash, now);

    if (credited > 0) log.info("ton payments credited", { credited });
    return credited;
  }

  #credit(comment: string, amountNano: bigint, now: number): boolean {
    const ref = comment.trim().toLowerCase();
    if (!REF_RE.test(ref)) return false;

    const payment = this.#store.getPayment(ref);
    if (!payment || payment.paid_at !== null) return false;
    if (payment.expires_at <= now) {
      // Деньги пришли после протухания счёта. Молча зачесть нельзя — клиент
      // выставит новый счёт, а этот разбирается вручную.
      log.warn("ton payment arrived after invoice expiry");
      return false;
    }
    if (amountNano < minAccepted(BigInt(payment.amount_nano), this.#toleranceBp)) {
      log.warn("ton payment underfunded");
      return false;
    }
    if (!this.#store.markPaid(ref, now)) return false;

    this.#onPaid(ref);
    return true;
  }
}

export function minAccepted(amountNano: bigint, toleranceBp: number): bigint {
  return (amountNano * BigInt(10_000 - toleranceBp)) / 10_000n;
}
