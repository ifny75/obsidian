import { random, toHex } from "../util/bytes.ts";

export interface Session {
  identity: Uint8Array;
  devicePub: Uint8Array;
  deviceId: Uint8Array;
  expiresAt: number;
}

/**
 * Bearer-токены для HTTP-эндпоинтов. Выдаются после успешного AUTH по WS,
 * живут в памяти: перезапуск сервера обрывает WS-сессии в любом случае.
 */
export class SessionStore {
  readonly #byToken = new Map<string, Session>();
  readonly #ttlMs: number;

  constructor(ttlSec: number) {
    this.#ttlMs = ttlSec * 1000;
  }

  create(session: Omit<Session, "expiresAt">, now: number): string {
    const token = toHex(random(32));
    this.#byToken.set(token, { ...session, expiresAt: now + this.#ttlMs });
    return token;
  }

  get(token: string | undefined, now: number): Session | undefined {
    if (!token) return undefined;
    const s = this.#byToken.get(token);
    if (!s) return undefined;
    if (s.expiresAt <= now) {
      this.#byToken.delete(token);
      return undefined;
    }
    return s;
  }

  revoke(token: string): void {
    this.#byToken.delete(token);
  }

  sweep(now: number): void {
    for (const [token, s] of this.#byToken) {
      if (s.expiresAt <= now) this.#byToken.delete(token);
    }
  }
}
