export type Outcome = 'FILLED' | 'REFUSED' | 'BREACH_REVERTED' | 'ERROR';

export type Record = {
  id: string;
  ts: number;
  decisionHash: string;
  outcome: Outcome;
  preimage: {
    v: number;
    ts: number;
    pair: string;
    action: 'BUY' | 'SELL' | 'HOLD' | 'REFUSE';
    sizePct: number;
    amountIn: string;
    minAmountOut: string;
    price: number;
    referencePrice: number;
    imbalancePct: number;
    quoteReserve: number;
    baseReserve: number;
    swapsInWindow: number;
    buyRatio: number;
    equityQuote: number;
    positionBps: number;
    model: string;
    confidence: number;
    thesis: string;
    riskFlags: string[];
    reasoningHash: string;
  };
  reasoning: string;
  model: string;
  usedFallback: boolean;
  latencyMs: number;
  tokens: number;
  intent?: { isBuy: boolean; amountIn: string; minAmountOut: string };
  txHash?: string;
  seq?: number;
  head?: string;
  error?: { name: string; message: string; args: unknown[] };
};

export type State = {
  deployment: {
    network: string;
    chainId: number;
    pair: string;
    baseToken: string;
    quoteToken: string;
    baseSymbol: string;
    quoteSymbol: string;
    baseDecimals: number;
    quoteDecimals: number;
    envelope: string;
    ledger: string;
    trader: string;
  };
  chain: { id: number; rpc: string; explorer: string };
  mandate: {
    maxPositionBps: number;
    maxDailyLossBps: number;
    maxSlippageBps: number;
    maxTradesPerHour: number;
    maxNotionalQuote: string;
    expiry: string;
    nonce: string;
    executor: string;
    account: string;
  };
  position: {
    equityQuote: string;
    baseValueQuote: string;
    positionBps: number;
    dayEquity: string;
    tradesThisHour: number;
    isActive: boolean;
  };
  market: {
    price: number;
    referencePrice: number;
    imbalancePct: number;
    quoteReserve: number;
    baseReserve: number;
    swaps: number;
    buyRatio: number;
    blockNumber: number;
    series: number[];
  };
  ledger: { count: number; head: string };
  agent: { running: boolean; intervalMs: number; lastTickAt: number; lastError: string | null; model: string };
  records: Record[];
};

export type VerifyResult = {
  count: number;
  onChainHead: string;
  recomputedHead: string;
  ok: boolean;
  brokenAt: number | null;
  links: { seq: number; prev: string; decision: string; outcome: string; ts: number }[];
};

const json = async (res: Response) => {
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? body?.error ?? 'request failed');
  return body;
};

export const getState = (): Promise<State> => fetch('/api/state').then(json);
export const getVerify = (): Promise<VerifyResult> => fetch('/api/verify').then(json);
export const tick = (body: { [key: string]: unknown } = {}) =>
  fetch('/api/tick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
export const breakEnvelope = (sizePct: number) =>
  fetch('/api/break', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sizePct }) }).then(json);
export const chat = (message: string) =>
  fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) }).then(json);
export const applyMandate = (patch: unknown) =>
  fetch('/api/mandate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch }) }).then(json);
export const setRunning = (run: boolean) =>
  fetch(run ? '/api/start' : '/api/stop', { method: 'POST' }).then(json);
