import express from 'express';
import cors from 'cors';
import { CONFIG, DEPLOYMENT } from './config.js';
import { readMandate, readPosition, extractRevert, prepareMandate, submitMandate, readOwner, type Mandate } from './envelope.js';
import { snapshot, priceSeries } from './market.js';
import { allRecords, findRecord } from './store.js';
import { applyChatPatch, breakEnvelope, interpretChat, runCycle } from './agent.js';
import { verifyChain, type ChainLink } from './ledger.js';
import { publicClient } from './chain.js';
import { ledgerAbi } from './abi.js';
import type { Address } from 'viem';

export const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

let running = CONFIG.loop.autoStart;
let lastError: string | null = null;
let lastTickAt = 0;
let timer: NodeJS.Timeout | null = null;

const formatter = (n: number, d = 4) => Number(n.toFixed(d));

const loop = async () => {
  if (!running) return;
  try {
    lastTickAt = Date.now();
    await runCycle();
    lastError = null;
  } catch (error) {
    lastError = (error as Error).message;
  }
};

export const startLoop = () => {
  running = true;
  if (timer) clearInterval(timer);
  timer = setInterval(loop, CONFIG.loop.intervalMs);
  return { running, intervalMs: CONFIG.loop.intervalMs };
};

export const stopLoop = () => {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  return { running };
};

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, network: CONFIG.network, chainId: CONFIG.chainId, uptime: process.uptime() });
});

app.get('/api/state', async (_req, res) => {
  try {
    const [mandate, position, snap] = await Promise.all([readMandate(), readPosition(), snapshot()]);
    const records = allRecords();

    res.json({
      deployment: DEPLOYMENT,
      chain: { id: CONFIG.chainId, rpc: CONFIG.rpcUrl, explorer: CONFIG.explorerUrl },
      mandate: {
        maxPositionBps: mandate.maxPositionBps,
        maxDailyLossBps: mandate.maxDailyLossBps,
        maxSlippageBps: mandate.maxSlippageBps,
        maxTradesPerHour: mandate.maxTradesPerHour,
        maxNotionalQuote: mandate.maxNotionalQuote.toString(),
        expiry: mandate.expiry.toString(),
        nonce: mandate.nonce.toString(),
        executor: mandate.executor,
        account: mandate.account,
      },
      position: {
        equityQuote: position.equityQuote.toString(),
        baseValueQuote: position.baseValueQuote.toString(),
        positionBps: position.positionBps,
        dayEquity: position.dayEquity.toString(),
        tradesThisHour: position.tradesThisHour,
        isActive: position.isActive,
      },
      market: {
        price: formatter(snap.price, 6),
        referencePrice: formatter(snap.referencePrice, 6),
        imbalancePct: formatter(snap.imbalancePct, 3),
        quoteReserve: formatter(snap.quoteReserve, 4),
        baseReserve: formatter(snap.baseReserve, 4),
        swaps: snap.flow.swaps,
        buyRatio: formatter(snap.flow.buyRatio, 3),
        blockNumber: snap.blockNumber,
        series: priceSeries().map((p) => formatter(p, 6)),
      },
      ledger: {
        count: position.ledgerCount,
        head: position.ledgerHead,
      },
      agent: {
        running,
        intervalMs: CONFIG.loop.intervalMs,
        lastTickAt,
        lastError,
        model: CONFIG.particle.model,
      },
      records: records.slice(-60).reverse(),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/records', (_req, res) => {
  res.json({ records: allRecords().slice().reverse() });
});

app.get('/api/replay/:id', async (req, res) => {
  const record = findRecord(req.params.id);
  if (!record) return res.status(404).json({ error: 'not found' });

  let chainEntry = null;
  if (record.seq !== undefined) {
    // best effort: walk the on-chain ledger from the head looking for our seq
    try {
      let cursor: any = await publicClient.readContract({ address: DEPLOYMENT.ledger as Address, abi: ledgerAbi, functionName: 'head' });
      for (let i = 0; i < 200 && cursor !== `0x${'0'.repeat(64)}`; i++) {
        const entry: any = await publicClient.readContract({
          address: DEPLOYMENT.ledger as Address,
          abi: ledgerAbi,
          functionName: 'entry',
          args: [cursor],
        });
        if (Number(entry.seq) === record.seq) {
          chainEntry = { ...entry, hash: cursor };
          break;
        }
        cursor = entry.prev;
      }
    } catch {
      chainEntry = null;
    }
  }

  res.json({ record, chainEntry, canonical: require_preimage(record) });
});

// helper kept tiny so the replay view can show the exact hashed bytes
function require_preimage(record: any) {
  // canonical() lives in ledger.ts; re-import lazily to avoid a cycle at module load
  return record.preimage;
}

app.get('/api/verify', async (_req, res) => {
  try {
    const count = Number(
      await publicClient.readContract({ address: DEPLOYMENT.ledger as Address, abi: ledgerAbi, functionName: 'count' })
    );
    const links: ChainLink[] = [];
    let cursor: any = await publicClient.readContract({
      address: DEPLOYMENT.ledger as Address,
      abi: ledgerAbi,
      functionName: 'head',
    });

    for (let i = count; i > 0; i--) {
      const entry: any = await publicClient.readContract({
        address: DEPLOYMENT.ledger as Address,
        abi: ledgerAbi,
        functionName: 'entry',
        args: [cursor],
      });
      links.unshift({ seq: Number(entry.seq), prev: entry.prev, decision: entry.decision, outcome: entry.outcome, ts: Number(entry.ts) });
      cursor = entry.prev;
    }

    const verdict = verifyChain(links);
    const onChainHead = await publicClient.readContract({
      address: DEPLOYMENT.ledger as Address,
      abi: ledgerAbi,
      functionName: 'head',
    });

    res.json({
      count,
      onChainHead,
      recomputedHead: verdict.head,
      ok: verdict.ok && verdict.head === onChainHead,
      brokenAt: verdict.brokenAt ?? null,
      links,
    });
  } catch (error) {
    res.status(500).json({ error: extractRevert(error) });
  }
});

app.post('/api/tick', async (req, res) => {
  try {
    const body = req.body ?? {};
    const result = await runCycle({
      forceAction: body.forceAction,
      forceSizePct: body.forceSizePct != null ? Number(body.forceSizePct) : undefined,
      noise: body.noise != null ? Boolean(body.noise) : undefined,
    });
    res.json(result);
  } catch (error) {
    const message = (error as Error).message ?? '';
    if (message.includes('cycle already running')) {
      return res.json({ skipped: true, reason: 'A cycle is already in flight.' });
    }
    res.status(400).json({ error: extractRevert(error) });
  }
});

app.post('/api/break', async (req, res) => {
  try {
    const sizePct = Number(req.body?.sizePct ?? 400);
    const result = await breakEnvelope(sizePct);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: extractRevert(error) });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const message = String(req.body?.message ?? '').trim();
    if (!message) return res.status(400).json({ error: 'message required' });
    const interpreted = await interpretChat(message);
    res.json(interpreted);
  } catch (error) {
    res.status(500).json({ error: extractRevert(error) });
  }
});

app.post('/api/mandate', async (req, res) => {
  try {
    const result = await applyChatPatch(req.body?.patch ?? {});
    res.json({
      ok: true,
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      signer: result.signer,
      mandate: {
        ...result.mandate,
        maxNotionalQuote: result.mandate.maxNotionalQuote.toString(),
        expiry: result.mandate.expiry.toString(),
        nonce: result.mandate.nonce.toString(),
      },
    });
  } catch (error) {
    res.status(400).json({ error: extractRevert(error) });
  }
});

app.post('/api/start', (_req, res) => res.json(startLoop()));
app.post('/api/stop', (_req, res) => res.json(stopLoop()));

/** Who is allowed to sign a mandate, and which chain the desk is on. */
app.get('/api/wallet', async (_req, res) => {
  try {
    const owner = await readOwner();
    res.json({
      owner,
      chainId: CONFIG.chainId,
      network: CONFIG.network,
      envelope: DEPLOYMENT.envelope,
    });
  } catch (error) {
    res.status(500).json({ error: extractRevert(error) });
  }
});

/**
 * Build the next mandate and hand back EIP-712 typed data.
 * The browser wallet signs it. The agent cannot produce this signature.
 */
app.post('/api/mandate/prepare', async (req, res) => {
  try {
    const patch = req.body?.patch ?? req.body ?? {};
    const prepared = await prepareMandate(patch);
    res.json({
      owner: prepared.owner,
      typedData: prepared.typedData,
      mandate: {
        ...prepared.mandate,
        maxNotionalQuote: prepared.mandate.maxNotionalQuote.toString(),
        expiry: prepared.mandate.expiry.toString(),
        nonce: prepared.mandate.nonce.toString(),
      },
    });
  } catch (error) {
    res.status(400).json({ error: extractRevert(error) });
  }
});

/** Relay a wallet-signed mandate. The contract checks the signature, not the sender. */
app.post('/api/mandate/submit', async (req, res) => {
  try {
    const raw = req.body?.mandate;
    const signature = req.body?.signature;
    if (!raw || !signature) return res.status(400).json({ error: 'mandate and signature required' });

    const mandate: Mandate = {
      account: raw.account,
      executor: raw.executor,
      pair: raw.pair,
      baseToken: raw.baseToken,
      quoteToken: raw.quoteToken,
      maxPositionBps: Number(raw.maxPositionBps),
      maxDailyLossBps: Number(raw.maxDailyLossBps),
      maxSlippageBps: Number(raw.maxSlippageBps),
      maxTradesPerHour: Number(raw.maxTradesPerHour),
      maxNotionalQuote: BigInt(raw.maxNotionalQuote),
      expiry: BigInt(raw.expiry),
      nonce: BigInt(raw.nonce),
    };

    const result = await submitMandate(mandate, signature);
    res.json({
      ok: true,
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      mandate: {
        ...result.mandate,
        maxNotionalQuote: result.mandate.maxNotionalQuote.toString(),
        expiry: result.mandate.expiry.toString(),
        nonce: result.mandate.nonce.toString(),
      },
    });
  } catch (error) {
    res.status(400).json({ error: extractRevert(error) });
  }
});

export const boot = () => {
  app.listen(CONFIG.port, () => {
    console.log(`[envelope] api on http://127.0.0.1:${CONFIG.port} network=${CONFIG.network} chainId=${CONFIG.chainId}`);
    console.log(`[envelope] envelope=${DEPLOYMENT.envelope} trader=${DEPLOYMENT.trader} ledger=${DEPLOYMENT.ledger}`);
    if (running) startLoop();
  });
};
