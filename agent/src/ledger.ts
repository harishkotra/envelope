import { encodePacked, keccak256, toHex, type Hex } from 'viem';

export type DecisionPreimage = {
  v: 1;
  ts: number;
  network: string;
  chainId: number;
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

/**
 * Canonical decision preimage. Sorted keys, no whitespace, no locale-dependent
 * formatting, so the hash is reproducible by any third party with the same JSON.
 */
export const canonical = (pre: DecisionPreimage): string => {
  const ordered: Record<string, unknown> = {
    v: pre.v,
    ts: pre.ts,
    network: pre.network,
    chainId: pre.chainId,
    pair: pre.pair,
    action: pre.action,
    sizePct: pre.sizePct,
    amountIn: pre.amountIn,
    minAmountOut: pre.minAmountOut,
    price: round(pre.price),
    referencePrice: round(pre.referencePrice),
    imbalancePct: round(pre.imbalancePct),
    quoteReserve: round(pre.quoteReserve),
    baseReserve: round(pre.baseReserve),
    swapsInWindow: pre.swapsInWindow,
    buyRatio: round(pre.buyRatio),
    equityQuote: round(pre.equityQuote),
    positionBps: pre.positionBps,
    model: pre.model,
    confidence: round(pre.confidence),
    thesis: pre.thesis,
    riskFlags: pre.riskFlags,
    reasoningHash: pre.reasoningHash,
  };
  return JSON.stringify(ordered);
};

const round = (n: number) => Number.isFinite(n) ? Math.round(n * 1e9) / 1e9 : 0;

export const hashPreimage = (pre: DecisionPreimage): Hex => keccak256(toHex(canonical(pre)));

export const hashReasoning = (reasoning: string): Hex => keccak256(toHex(reasoning ?? ''));

export const hashOutcome = (kind: 'FILLED' | 'REFUSED', value: bigint, ts: number): Hex =>
  keccak256(encodePacked(['string', 'uint256', 'uint256'], [kind, value, BigInt(ts)]));

export const hashRefusal = (reason: string, ts: number): Hex =>
  keccak256(encodePacked(['string', 'uint256'], [reason, BigInt(ts)]));

export const hashLink = (prev: Hex, decision: Hex, outcome: Hex, ts: number, seq: number): Hex =>
  keccak256(
    encodePacked(
      ['bytes32', 'bytes32', 'bytes32', 'uint64', 'uint32'],
      [prev, decision, outcome, BigInt(ts), seq]
    )
  );

export type ChainLink = {
  seq: number;
  prev: Hex;
  decision: Hex;
  outcome: Hex;
  ts: number;
};

/** Recompute a chain from its links, exactly as the contract does on-chain. */
export const verifyChain = (links: ChainLink[]): { ok: boolean; brokenAt?: number; head: Hex } => {
  let head: Hex = `0x${'0'.repeat(64)}` as Hex;
  for (const link of links) {
    const expected = hashLink(link.prev, link.decision, link.outcome, link.ts, link.seq);
    if (link.prev !== head) return { ok: false, brokenAt: link.seq, head };
    head = expected;
  }
  return { ok: true, head };
};
