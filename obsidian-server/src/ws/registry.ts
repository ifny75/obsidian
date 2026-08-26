/**
 * Кто сейчас онлайн. Только в памяти и только для доставки — присутствие
 * никуда не сохраняется.
 */

export interface Socket {
  /** uWS: 1 = отправлено, 0 = backpressure, 2 = отброшено. */
  send(data: Uint8Array, isBinary: boolean): number;
  getBufferedAmount(): number;
  end(code: number, reason?: string): void;
  close(): void;
}

export const SEND_SUCCESS = 1;

export class Registry {
  readonly #byDevice = new Map<string, Set<Socket>>();
  readonly #byPayment = new Map<string, Set<Socket>>();

  /** Сколько устройств сейчас на связи. Только число: панели владельца хватает. */
  size(): number {
    return this.#byDevice.size;
  }

  add(devicePubHex: string, sock: Socket): void {
    let set = this.#byDevice.get(devicePubHex);
    if (!set) {
      set = new Set();
      this.#byDevice.set(devicePubHex, set);
    }
    set.add(sock);
  }

  remove(devicePubHex: string, sock: Socket): void {
    const set = this.#byDevice.get(devicePubHex);
    if (!set) return;
    set.delete(sock);
    if (set.size === 0) this.#byDevice.delete(devicePubHex);
  }

  /**
   * Доставка «на удачу»: конверт всё равно лежит в очереди до ACK, поэтому
   * backpressure и отброшенные кадры здесь не ошибка — клиент заберёт при
   * следующем подключении.
   */
  deliver(devicePubHex: string, frame: Uint8Array): void {
    const set = this.#byDevice.get(devicePubHex);
    if (!set) return;
    for (const sock of set) {
      try {
        sock.send(frame, true);
      } catch {
        // Сокет умер между проверкой и отправкой — close-хендлер уберёт его.
      }
    }
  }

  // --- ожидание оплаты ------------------------------------------------------
  // Плательщик ещё не зарегистрирован, устройства в БД нет — поэтому отдельная
  // карта по номеру счёта, живущая только пока висит соединение.

  watchPayment(ref: string, sock: Socket): void {
    let set = this.#byPayment.get(ref);
    if (!set) {
      set = new Set();
      this.#byPayment.set(ref, set);
    }
    set.add(sock);
  }

  unwatchPayment(ref: string, sock: Socket): void {
    const set = this.#byPayment.get(ref);
    if (!set) return;
    set.delete(sock);
    if (set.size === 0) this.#byPayment.delete(ref);
  }

  notifyPayment(ref: string, frame: Uint8Array): void {
    for (const sock of this.#byPayment.get(ref) ?? []) {
      try {
        sock.send(frame, true);
      } catch {
        // Клиент ушёл — увидит оплату при следующем PAY_REQUEST.
      }
    }
  }

  get onlineDevices(): number {
    return this.#byDevice.size;
  }
}
