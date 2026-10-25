import { formatUnits } from 'viem';
import type { Address, Hex } from 'viem';
import { CONFIG, DEPLOYMENT } from './config.js';
import { snapshot, type Snapshot } from './market.js';
import { reason, fallbackProposal, type Proposal } from './particle.js';
import { canonical, hashOutcome, hashPreimage, hashReasoning, type DecisionPreimage } from './ledger.js';
import { applyMandate, extractRevert, readMandate, readPosition, refuse, trade } from './envelope.js';
import { allRecords, saveRecord, updateRecord, type DecisionRecord } from './store.js';
import { nudge } from './noise.js';

const SYSTEM = `You are Envelope, an autonomous market operator on HSK Chain.
You trade one constant-product pool: base asset WHSK against a stablecoin quote asset.
A signed on-chain risk mandate binds you. You cannot raise your own limits, and any order
outside the mandate reverts on-chain.

Your job each cycle: read the market snapshot, decide BUY, SELL or HOLD, and size the order
as a percentage of your per-trade notional ceiling.

Rules:
- Prefer HOLD. Only trade when the numbers give you an edge you can state in one sentence.
- sizePct is 0-100 and means percent of the per-trade notional ceiling. Never exceed it.
- A BUY increases exposure to the base asset; a SELL reduces it. Your position ceiling is enforced.
- Your thesis must be under 40 words and must cite at least two numbers from the snapshot.
- riskFlags: short snake_case tags for anything that made you hesitate.

Reply with JSON only:
{"action":"BUY|SELL|HOLD","sizePct":number,"confidence":0-1,"thesis":"...","riskFlags":["..."]}`;

export const buildUserPrompt = (s: Snapshot, limits: any, recent: DecisionRecord[]) => {
  const payload = {
    market: {
      price_quote_per_base: round(s.price, 6),
      reference_price: round(s.referencePrice, 6),
      imbalance_pct: round(s.imbalancePct, 3),
      pool_quote_reserve: round(s.quoteReserve, 6),
      pool_base_reserve: round(s.baseReserve, 6),
      pool_depth_quote: round(s.depthQuote, 6),
      swaps_last_window: s.flow.swaps,
      buy_ratio: round(s.flow.buyRatio, 3),
      base_volume_window: round(s.flow.baseVolume, 6),
    },
    book: {
      equity_quote: round(s.equityQuote, 6),
      position_bps: s.positionBps,
      base_balance: round(s.baseBalance, 6),
      quote_balance: round(s.quoteBalance, 6),
    },
    mandate: {
      max_position_bps: limits.maxPositionBps,
      max_daily_loss_bps: limits.maxDailyLossBps,
      max_slippage_bps: limits.maxSlippageBps,
      max_trades_per_hour: limits.maxTradesPerHour,
      max_notional_quote: formatUnits(limits.maxNotionalQuote, DEPLOYMENT.quoteDecimals),
      trades_this_hour: s.tradesThisHour,
      expires_in_seconds: Number(limits.expiry) - Math.floor(Date.now() / 1000),
    },
    recent_decisions: recent.slice(-3).map((r) => ({
      action: r.preimage.action,
      outcome: r.outcome,
      thesis: r.preimage.thesis,
    })),
  };
  return JSON.stringify(payload, null, 2);
};

const round = (n: number, d: number) => Number(n.toFixed(d));

/** Constant-product quote with the 0.3 percent fee, matching the router. */
export const quoteOut = (s: Snapshot, isBuy: boolean, amountInQuoteUnits: number): number => {
  const rIn = isBuy ? s.quoteReserve : s.baseReserve;
  const rOut = isBuy ? s.baseReserve : s.quoteReserve;
  if (rIn <= 0 || rOut <= 0) return 0;
  const inWithFee = amountInQuoteUnits * 997;
  return (inWithFee * rOut) / (rIn * 1000 + inWithFee);
};

export type CycleResult = { record: DecisionRecord };

let inFlight = false;

export const runCycle = async (
  opts: { forceAction?: 'BUY' | 'SELL'; forceSizePct?: number; simulate?: boolean; noise?: boolean } = {}
): Promise<CycleResult> => {
  if (inFlight) throw new Error('cycle already running');
  inFlight = true;

  try {
    let flowTx: string | undefined;
    const wantNoise = opts.noise ?? CONFIG.loop.noise;
    if (wantNoise) {
      try {
        const n = await nudge();
        flowTx = n.txHash;
      } catch (error) {
        console.warn('[agent] flow generator skipped:', (error as Error).message);
      }
    }

    const [limits, position, snap] = await Promise.all([readMandate(), readPosition(), snapshot()]);
    const recent = allRecords().slice(-3);

    const user = buildUserPrompt(snap, limits, recent);
    const llm = await reason(SYSTEM, user, fallbackProposal(snap.imbalancePct));

    let proposal: Proposal = llm.proposal;
    if (opts.forceAction) {
      proposal = { ...proposal, action: opts.forceAction, sizePct: opts.forceSizePct ?? proposal.sizePct };
    }

    const quoteLimit = Number(formatUnits(limits.maxNotionalQuote, DEPLOYMENT.quoteDecimals));
    const sizePct = Math.max(0, Math.min(100, opts.forceSizePct ?? proposal.sizePct));
    const amountInQuote = (quoteLimit * sizePct) / 100;

    const isBuy = proposal.action === 'BUY';
    const early = proposal.action === 'HOLD' || amountInQuote <= 0;

    // The model call takes seconds and the pool can move inside it, so the slippage
    // floor is quoted against reserves read immediately before sizing, not the snapshot
    // the model reasoned about.
    const fresh = early ? null : await readPosition();

    // convert to base units for a SELL
    const amountIn = early
      ? 0n
      : isBuy
        ? BigInt(Math.floor(amountInQuote * 10 ** DEPLOYMENT.quoteDecimals))
        : BigInt(Math.floor(((amountInQuote / snap.price) || 0) * 10 ** DEPLOYMENT.baseDecimals));

    const expectedOut = early ? 0 : quoteOut(snap, isBuy, amountInQuote);

    // The mandate enforces its own slippage band, computed from raw reserves in exact
    // integer maths. Mirror that formula and stay one wei above it, so the agent never
    // trips the band on a rounding artefact.
    let minAmountOut = 0n;
    if (!early) {
      const rawQuote = fresh?.quoteReserve ?? position.quoteReserve;
      const rawBase = fresh?.baseReserve ?? position.baseReserve;
      const rIn = isBuy ? rawQuote : rawBase;
      const rOut = isBuy ? rawBase : rawQuote;
      const inFee = amountIn * 997n;
      const expectedRaw = rIn > 0n && rOut > 0n ? (inFee * rOut) / (rIn * 1000n + inFee) : 0n;
      const floorRaw = (expectedRaw * BigInt(10_000 - limits.maxSlippageBps)) / 10_000n;
      minAmountOut = floorRaw > 0n ? floorRaw + 1n : 0n;
    }

    const preimage: DecisionPreimage = {
      v: 1,
      ts: snap.ts,
      network: CONFIG.network,
      chainId: CONFIG.chainId,
      pair: DEPLOYMENT.pair,
      action: early ? 'HOLD' : proposal.action,
      sizePct: Number(sizePct.toFixed(3)),
      amountIn: amountIn.toString(),
      minAmountOut: minAmountOut.toString(),
      price: snap.price,
      referencePrice: snap.referencePrice,
      imbalancePct: snap.imbalancePct,
      quoteReserve: snap.quoteReserve,
      baseReserve: snap.baseReserve,
      swapsInWindow: snap.flow.swaps,
      buyRatio: snap.flow.buyRatio,
      equityQuote: snap.equityQuote,
      positionBps: snap.positionBps,
      model: llm.model,
      confidence: proposal.confidence,
      thesis: proposal.thesis,
      riskFlags: proposal.riskFlags,
      reasoningHash: hashReasoning(llm.reasoning),
    };

    const decisionHash = hashPreimage(preimage);
    const record: DecisionRecord = saveRecord({
      id: `${preimage.ts}-${decisionHash.slice(2, 10)}`,
      ts: preimage.ts,
      decisionHash,
      outcome: 'ERROR',
      preimage,
      reasoning: llm.reasoning,
      proposal,
      model: llm.model,
      usedFallback: llm.usedFallback,
      latencyMs: llm.latencyMs,
      tokens: llm.tokens,
      intent: early ? undefined : { isBuy, amountIn: amountIn.toString(), minAmountOut: minAmountOut.toString() },
    });

    if (early) {
      try {
        const anchored = await refuse(decisionHash, 'HOLD');
        updateRecord(record.id, { outcome: 'REFUSED', txHash: anchored.hash, head: undefined });
      } catch (error) {
        updateRecord(record.id, { outcome: 'REFUSED', error: extractRevert(error) });
      }
      return { record: updateRecord(record.id, {})! };
    }

    try {
      const { hash } = await trade(
        { isBuy, amountIn, minAmountOut, deadline: BigInt(Math.floor(Date.now() / 1000) + 300) },
        decisionHash,
        { simulate: opts.simulate ?? true }
      );
      const updated = updateRecord(record.id, { outcome: 'FILLED', txHash: hash });
      return { record: updated! };
    } catch (error) {
      const decoded = extractRevert(error);
      // a breached envelope is evidence, not an accident: anchor the refusal too
      let anchoredHash: string | undefined;
      try {
        const anchored = await refuse(decisionHash, decoded.name);
        anchoredHash = anchored.hash;
      } catch {
        anchoredHash = undefined;
      }
      const updated = updateRecord(record.id, {
        outcome: 'BREACH_REVERTED',
        error: decoded,
        txHash: anchoredHash,
      });
      return { record: updated! };
    }
  } finally {
    inFlight = false;
  }
};

/** Deliberate breach for the demo: same code path, no simulation, oversized order. */
export const breakEnvelope = async (sizePct = 400) => {
  const snap = await snapshot();
  const limits = await readMandate();
  const quoteLimit = Number(formatUnits(limits.maxNotionalQuote, DEPLOYMENT.quoteDecimals));
  const amountInQuote = (quoteLimit * sizePct) / 100;
  const amountIn = BigInt(Math.floor(amountInQuote * 10 ** DEPLOYMENT.quoteDecimals));

  const preimage: DecisionPreimage = {
    v: 1,
    ts: snap.ts,
    network: CONFIG.network,
    chainId: CONFIG.chainId,
    pair: DEPLOYMENT.pair,
    action: 'BUY',
    sizePct,
    amountIn: amountIn.toString(),
    minAmountOut: '0',
    price: snap.price,
    referencePrice: snap.referencePrice,
    imbalancePct: snap.imbalancePct,
    quoteReserve: snap.quoteReserve,
    baseReserve: snap.baseReserve,
    swapsInWindow: snap.flow.swaps,
    buyRatio: snap.flow.buyRatio,
    equityQuote: snap.equityQuote,
    positionBps: snap.positionBps,
    model: 'operator-override',
    confidence: 1,
    thesis: `Operator asked for a ${sizePct} percent position. The envelope decides whether that is allowed.`,
    riskFlags: ['operator_override'],
    reasoningHash: hashReasoning('operator override'),
  };

  const decisionHash = hashPreimage(preimage);

  try {
    await trade({ isBuy: true, amountIn, minAmountOut: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 300) }, decisionHash, {
      simulate: false,
    });
    return { breached: false, decisionHash, preimage };
  } catch (error) {
    const decoded = extractRevert(error);
    saveRecord({
      id: `${preimage.ts}-${decisionHash.slice(2, 10)}`,
      ts: preimage.ts,
      decisionHash,
      outcome: 'BREACH_REVERTED',
      preimage,
      reasoning: 'Operator override attempted outside the mandate.',
      proposal: { action: 'BUY', sizePct, confidence: 1, thesis: preimage.thesis, riskFlags: ['operator_override'] },
      model: 'operator-override',
      usedFallback: false,
      latencyMs: 0,
      tokens: 0,
      error: decoded,
    });
    return { breached: true, decisionHash, preimage, error: decoded };
  }
};

/** Natural language control surface. Returns the reply and the mandate patch it implies. */
export const interpretChat = async (message: string) => {
  const limits = await readMandate();
  const current = {
    max_position_bps: limits.maxPositionBps,
    max_daily_loss_bps: limits.maxDailyLossBps,
    max_slippage_bps: limits.maxSlippageBps,
    max_trades_per_hour: limits.maxTradesPerHour,
    max_notional_quote: formatUnits(limits.maxNotionalQuote, DEPLOYMENT.quoteDecimals),
  };

  const system = `You translate an operator's plain-English instruction into changes to a signed
risk mandate. Current mandate: ${JSON.stringify(current)}.
Reply with JSON only: {"reply":"one sentence, concrete","patch":{"maxPositionBps":number|null,"maxDailyLossBps":number|null,"maxSlippageBps":number|null,"maxTradesPerHour":number|null,"maxNotionalQuote":string|null,"days":number|null}}
Use null for anything the operator did not ask to change. Interpret loosely quantified wishes sensibly
("more aggressive" raises position and notional, "safer" lowers them). Never invent a patch for a question.`;

  const out = await reason(system, message, fallbackProposal(0));
  try {
    const parsed = JSON.parse(out.raw || '{}');
    return { reply: String(parsed.reply ?? 'No change proposed.'), patch: parsed.patch ?? {} };
  } catch {
    return { reply: 'I could not turn that into a mandate change.', patch: {} };
  }
};

export const applyChatPatch = async (patch: any) => {
  const normalised: any = {};
  if (patch.maxPositionBps != null) normalised.maxPositionBps = Number(patch.maxPositionBps);
  if (patch.maxDailyLossBps != null) normalised.maxDailyLossBps = Number(patch.maxDailyLossBps);
  if (patch.maxSlippageBps != null) normalised.maxSlippageBps = Number(patch.maxSlippageBps);
  if (patch.maxTradesPerHour != null) normalised.maxTradesPerHour = Number(patch.maxTradesPerHour);
  if (patch.maxNotionalQuote != null) {
    normalised.maxNotionalQuote = BigInt(
      Math.floor(Number(patch.maxNotionalQuote) * 10 ** DEPLOYMENT.quoteDecimals)
    );
  }
  if (patch.days != null) normalised.days = Number(patch.days);
  return applyMandate(normalised);
};
