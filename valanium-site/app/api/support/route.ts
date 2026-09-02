const TON_ADDRESS = 'UQAbCn83LAZJaTpTD0Pb-D95YU5vbHg-7g6HLbiru_8qCovp';
const TON_RAW_ADDRESS = '0:1b0a7f372c0649693a530f43dbf83f79614e6f6c783eee0e872db8abbbff2a0a';
const TON_USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const TRON_ADDRESS = 'TRVp9AYLL1PkcCJWJWfEgpr1aSZtchjuZw';
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const GOAL = 20;

type TonHistory = {
  events?: Array<{
    in_progress?: boolean;
    actions?: Array<{
      type?: string;
      status?: string;
      JettonTransfer?: {
        amount?: string;
        recipient?: { address?: string };
        jetton?: { decimals?: number };
      };
    }>;
  }>;
};

type TronHistory = {
  data?: Array<{
    block_timestamp?: number;
    from?: string;
    to?: string;
    type?: string;
    value?: string;
    token_info?: { address?: string; decimals?: number; symbol?: string };
  }>;
};

type FundingData = {
  goal: number;
  total: number;
  ton: number;
  tron: number;
  month: string;
  updatedAt: string;
  sources: { ton: boolean; tron: boolean };
};

let cached: { expiresAt: number; data: FundingData } | null = null;

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Valanium-Support-Counter/1.0' },
    cache: 'no-store',
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
  return response.json() as Promise<T>;
}

async function getTonTotal(start: number, end: number) {
  const url = new URL(`https://tonapi.io/v2/jettons/${TON_USDT}/accounts/${TON_ADDRESS}/history`);
  url.searchParams.set('limit', '1000');
  url.searchParams.set('start_date', String(start));
  url.searchParams.set('end_date', String(end));
  const history = await getJson<TonHistory>(url.toString());

  return (history.events ?? []).reduce((sum, event) => {
    if (event.in_progress) return sum;
    return sum + (event.actions ?? []).reduce((eventSum, action) => {
      const transfer = action.JettonTransfer;
      if (action.type !== 'JettonTransfer' || action.status !== 'ok' || !transfer) return eventSum;
      if (transfer.recipient?.address?.toLowerCase() !== TON_RAW_ADDRESS) return eventSum;
      const amount = Number(transfer.amount ?? 0) / 10 ** (transfer.jetton?.decimals ?? 6);
      return eventSum + (Number.isFinite(amount) ? amount : 0);
    }, 0);
  }, 0);
}

async function getTronTotal(startMs: number, endMs: number) {
  const url = new URL(`https://api.trongrid.io/v1/accounts/${TRON_ADDRESS}/transactions/trc20`);
  url.searchParams.set('only_confirmed', 'true');
  url.searchParams.set('limit', '200');
  url.searchParams.set('contract_address', TRON_USDT);
  url.searchParams.set('min_timestamp', String(startMs));
  url.searchParams.set('max_timestamp', String(endMs));
  const history = await getJson<TronHistory>(url.toString());

  return (history.data ?? []).reduce((sum, transfer) => {
    if (transfer.to !== TRON_ADDRESS || transfer.token_info?.address !== TRON_USDT || transfer.type !== 'Transfer') return sum;
    const amount = Number(transfer.value ?? 0) / 10 ** (transfer.token_info?.decimals ?? 6);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
}

export async function GET() {
  const now = new Date();
  if (cached && cached.expiresAt > now.getTime()) {
    return Response.json(cached.data, { headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' } });
  }

  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1;
  const [tonResult, tronResult] = await Promise.allSettled([
    getTonTotal(Math.floor(start / 1000), Math.floor(end / 1000)),
    getTronTotal(start, end),
  ]);
  const ton = tonResult.status === 'fulfilled' ? tonResult.value : 0;
  const tron = tronResult.status === 'fulfilled' ? tronResult.value : 0;
  const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  const data: FundingData = {
    goal: GOAL,
    total: round(ton + tron),
    ton: round(ton),
    tron: round(tron),
    month: new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(now),
    updatedAt: now.toISOString(),
    sources: { ton: tonResult.status === 'fulfilled', tron: tronResult.status === 'fulfilled' },
  };
  cached = { expiresAt: now.getTime() + 5 * 60 * 1000, data };
  return Response.json(data, { headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' } });
}
