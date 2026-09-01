import { Address, Cell, loadTransaction } from "@ton/core";
import type { Transaction } from "@ton/core";
import { LiteClient, LiteRoundRobinEngine, LiteSingleEngine } from "ton-lite-client";
import { log } from "../log.ts";

/** Входящий перевод на наш адрес. Всё, что нужно знать о нём платёжной логике. */
export interface ChainTransfer {
  lt: string;
  hash: Uint8Array;
  amountNano: bigint;
  comment: string;
}

/** Результат прохода: что нашли и докуда досмотрели. */
export interface ChainScan {
  /** Переводы с текстовым memo, от старых к новым. */
  transfers: ChainTransfer[];
  /** Сколько транзакций разобрано за проход. Нужно только для диагностики. */
  scanned: number;
  /**
   * Позиция просмотра. Возвращается всегда, даже когда ни один перевод не
   * подошёл: иначе курсор застрянет и хвост будет перечитываться вечно.
   */
  cursor: { lt: string; hash: Uint8Array } | null;
}

/**
 * Источник транзакций. Реальная реализация ходит в лайтсервер, тесты
 * подставляют свою — платёжная логика про сеть ничего не знает.
 */
export interface ChainSource {
  /** `null` — первый запуск: смотрим только текущую позицию, историю не читаем. */
  scan(cursorLt: string | null): Promise<ChainScan>;
}

interface GlobalConfig {
  liteservers: { ip: number; port: number; id: { key: string } }[];
}

/** Ограничение прохода: догоняем постепенно, а не одним рывком. */
const MAX_PAGES = 16;
const PAGE = 16;

/**
 * Прямой опрос блокчейна через ADNL: никаких сторонних HTTP-API, которые
 * решали бы за нас, оплачен ли счёт. Лайтсервер всё же видит, чей адрес мы
 * опрашиваем, — поэтому VALANIUM_TON_CONFIG стоит нацелить на свой узел.
 */
export class LiteChainSource implements ChainSource {
  #client: LiteClient | null = null;
  readonly #address: Address;
  readonly #configUrl: string;

  constructor(address: string, configUrl: string) {
    this.#address = Address.parse(address);
    this.#configUrl = configUrl;
  }

  async #connect(): Promise<LiteClient> {
    if (this.#client) return this.#client;

    const raw = this.#configUrl.startsWith("http")
      ? ((await (await fetch(this.#configUrl)).json()) as GlobalConfig)
      : (JSON.parse(await (await import("node:fs/promises")).readFile(this.#configUrl, "utf8")) as GlobalConfig);

    if (!Array.isArray(raw.liteservers) || raw.liteservers.length === 0) {
      throw new Error("ton config has no liteservers");
    }
    const engines = raw.liteservers.map(
      (ls) =>
        new LiteSingleEngine({
          host: `tcp://${intToIp(ls.ip)}:${ls.port}`,
          publicKey: Buffer.from(ls.id.key, "base64"),
        }),
    );
    this.#client = new LiteClient({ engine: new LiteRoundRobinEngine(engines) });
    log.info("ton liteservers connected", { count: engines.length });
    return this.#client;
  }

  async scan(cursorLt: string | null): Promise<ChainScan> {
    const client = await this.#connect();
    const master = await client.getMasterchainInfo();
    const state = await client.getAccountState(this.#address, master.last);
    if (!state.lastTx) return { transfers: [], scanned: 0, cursor: null };

    const head = { lt: state.lastTx.lt.toString(), hash: new Uint8Array(bigintToHash(state.lastTx.hash)) };

    // Первый запуск: встаём на текущую вершину и дальше смотрим только вперёд.
    // Читать историю целиком нельзя — публичные лайтсерверы неархивные и просто
    // ответят «cannot locate transaction», а старые оплаты нам и не нужны.
    if (cursorLt === null) return { transfers: [], scanned: 0, cursor: head };

    const cursor = BigInt(cursorLt);
    if (state.lastTx.lt <= cursor) return { transfers: [], scanned: 0, cursor: null };

    const found: ChainTransfer[] = [];
    let scanned = 0;
    let lt = state.lastTx.lt;
    let hash = bigintToHash(state.lastTx.hash);
    let pages = 0;

    // Идём от свежих к старым, пока не упрёмся в курсор или в лимит прохода.
    while (lt > cursor && pages < MAX_PAGES) {
      pages += 1;
      const page = await client.getAccountTransactions(this.#address, lt.toString(), hash, PAGE);
      const cells = Cell.fromBoc(page.transactions);
      if (cells.length === 0) break;

      let next: { lt: bigint; hash: Buffer } | null = null;
      for (const cell of cells) {
        const tx = loadTransaction(cell.beginParse());
        scanned += 1;
        if (tx.lt <= cursor) {
          next = null;
          break;
        }
        const transfer = toTransfer(tx);
        if (transfer) found.push(transfer);
        next =
          tx.prevTransactionLt === 0n
            ? null
            : { lt: tx.prevTransactionLt, hash: bigintToHash(tx.prevTransactionHash) };
      }
      if (!next) break;
      lt = next.lt;
      hash = next.hash;
    }

    // Наружу — по возрастанию lt. Курсор всегда на вершине: пропущенного между
    // ним и последним найденным переводом быть не может, мы шли сплошняком.
    return { transfers: found.reverse(), scanned, cursor: head };
  }
}

/**
 * Текстовый комментарий в TON — это тело сообщения с 32-битным нулевым опкодом
 * впереди; длинный текст продолжается в дочерних ячейках («змейкой»).
 * `null` — тела нет, оно не текстовое или битое.
 */
export function readComment(body: Cell): string | null {
  const slice = body.beginParse();
  if (slice.remainingBits < 32) return null;
  if (slice.loadUint(32) !== 0) return null;
  try {
    return slice.loadStringTail();
  } catch {
    return null;
  }
}

/** Возвращает `null` для всего, что не является входящим переводом с текстом. */
function toTransfer(tx: Transaction): ChainTransfer | null {
  const inMsg = tx.inMessage;
  if (!inMsg || inMsg.info.type !== "internal") return null;

  const comment = readComment(inMsg.body);
  if (comment === null) return null;

  return {
    lt: tx.lt.toString(),
    hash: new Uint8Array(tx.hash()),
    amountNano: inMsg.info.value.coins,
    comment,
  };
}

function bigintToHash(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(64, "0"), "hex");
}

function intToIp(int: number): string {
  // В глобальном конфиге адрес лежит знаковым int32.
  const unsigned = int >>> 0;
  return `${(unsigned >> 24) & 0xff}.${(unsigned >> 16) & 0xff}.${(unsigned >> 8) & 0xff}.${unsigned & 0xff}`;
}
