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

export type TypedData = {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: { [key: string]: { name: string; type: string }[] };
  primaryType: string;
  message: { [key: string]: string | number };
};

export type WalletInfo = { owner: string; chainId: number; network: string; envelope: string };

export const getWallet = (): Promise<WalletInfo> => fetch('/api/wallet').then(json);

export const prepareMandate = (patch: unknown) =>
  fetch('/api/mandate/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch }),
  }).then(json) as Promise<{ owner: string; typedData: TypedData; mandate: { [key: string]: string | number } }>;

export const submitMandate = (mandate: unknown, signature: string) =>
  fetch('/api/mandate/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mandate, signature }),
  }).then(json);

/** Minimal EIP-1193 surface. Only what the desk actually calls. */
type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
};

export const injected = (): Eip1193 | null =>
  typeof window !== 'undefined' ? ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) : null;

export const connectWallet = async (): Promise<string> => {
  const provider = injected();
  if (!provider) throw new Error('No browser wallet found. Install MetaMask or Rabby.');
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts?.length) throw new Error('Wallet returned no account.');
  return accounts[0];
};

export const walletChainId = async (): Promise<number> => {
  const provider = injected();
  if (!provider) throw new Error('No browser wallet found.');
  const hex = (await provider.request({ method: 'eth_chainId' })) as string;
  return Number.parseInt(hex, 16);
};

const CHAINS: { [chainId: number]: { name: string; rpc: string; explorer: string; symbol: string } } = {
  133: {
    name: 'HSK Chain Testnet',
    rpc: 'https://testnet.hsk.xyz',
    explorer: 'https://testnet-explorer.hskchain.net',
    symbol: 'HSK',
  },
  177: {
    name: 'HashKey Chain',
    rpc: 'https://mainnet.hsk.xyz',
    explorer: 'https://hashkey.blockscout.com',
    symbol: 'HSK',
  },
};

export const switchToChain = async (chainId: number): Promise<void> => {
  const provider = injected();
  if (!provider) throw new Error('No browser wallet found.');
  const hex = `0x${chainId.toString(16)}`;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (error) {
    const meta = CHAINS[chainId];
    if (!meta) throw error;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hex,
          chainName: meta.name,
          nativeCurrency: { name: 'HSK', symbol: meta.symbol, decimals: 18 },
          rpcUrls: [meta.rpc],
          blockExplorerUrls: [meta.explorer],
        },
      ],
    });
  }
};

export const signTypedData = async (account: string, typedData: TypedData): Promise<string> => {
  const provider = injected();
  if (!provider) throw new Error('No browser wallet found.');
  return (await provider.request({
    method: 'eth_signTypedData_v4',
    params: [account, JSON.stringify(typedData)],
  })) as string;
};
