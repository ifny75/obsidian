/**
 * Проверка связи с блокчейном и разбора транзакций:
 *
 *   npm run ton:check -- <адрес>
 *
 * Без аргумента берёт VALANIUM_TON_ADDRESS. Ничего не пишет в БД — только
 * показывает, что лайтсерверы отвечают и входящие переводы разбираются.
 */
import { config } from "../config.ts";
import { LiteChainSource } from "../ton/source.ts";

const address = process.argv[2] ?? config.ton.address;
if (!address) {
  process.stderr.write("usage: npm run ton:check -- <address>\n");
  process.exit(2);
}

const source = new LiteChainSource(address, config.ton.configUrl);
const started = Date.now();
// Первый проход только встаёт на вершину — историю мы намеренно не читаем.
const head = await source.scan(null);
if (!head.cursor) {
  process.stdout.write("на счету нет транзакций\n");
  process.exit(0);
}

// Отступаем от вершины на заданное окно lt и проходим этот участок так же,
// как это делает боевой наблюдатель.
const window = BigInt(process.argv[3] ?? "10000");
const from = (BigInt(head.cursor.lt) - window).toString();
const scan = await source.scan(from);
const transfers = scan.transfers;

process.stdout.write(`адрес:      ${address}\n`);
process.stdout.write(`конфиг:     ${config.ton.configUrl}\n`);
process.stdout.write(`цена входа: ${config.ton.priceNano} nanoton\n`);
process.stdout.write(`вершина:    lt=${head.cursor.lt}, проход от lt=${from}\n`);
process.stdout.write(
  `разобрано:  ${scan.scanned} транзакций, из них ${transfers.length} входящих с текстом, ` +
    `за ${Date.now() - started} мс\n\n`,
);

for (const t of transfers.slice(-10)) {
  const ton = (Number(t.amountNano) / 1e9).toFixed(4);
  const memo = t.comment.replace(/\s+/g, " ").slice(0, 40);
  process.stdout.write(`  lt=${t.lt}  ${ton.padStart(12)} TON  memo="${memo}"\n`);
}

// Курсор двигается только вперёд — проверяем, что порядок возрастающий.
const lts = transfers.map((t) => BigInt(t.lt));
const sorted = lts.every((lt, i) => i === 0 || lt > lts[i - 1]!);
process.stdout.write(`\nпорядок по lt возрастающий: ${sorted ? "да" : "НЕТ — курсор сломается"}\n`);
process.exit(sorted ? 0 : 1);
