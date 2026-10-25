import { decodeErrorResult, type Address, type Hex } from 'viem';
import { envelopeAbi, traderAbi } from './abi.js';
import { CONFIG, DEPLOYMENT } from './config.js';
import { executor, owner, publicClient, ownerAddress, executorAddress, FEE } from './chain.js';

export type Mandate = {
  account: Address;
  executor: Address;
  pair: Address;
  baseToken: Address;
  quoteToken: Address;
  maxPositionBps: number;
  maxDailyLossBps: number;
  maxSlippageBps: number;
  maxTradesPerHour: number;
  maxNotionalQuote: bigint;
  expiry: bigint;
  nonce: bigint;
};

export const MANDATE_TYPES = {
  Mandate: [
    { name: 'account', type: 'address' },
    { name: 'executor', type: 'address' },
    { name: 'pair', type: 'address' },
    { name: 'baseToken', type: 'address' },
    { name: 'quoteToken', type: 'address' },
    { name: 'maxPositionBps', type: 'uint16' },
    { name: 'maxDailyLossBps', type: 'uint16' },
    { name: 'maxSlippageBps', type: 'uint16' },
    { name: 'maxTradesPerHour', type: 'uint16' },
    { name: 'maxNotionalQuote', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

export const ENVELOPE = DEPLOYMENT.envelope as Address;
export const TRADER = DEPLOYMENT.trader as Address;
export const LEDGER = DEPLOYMENT.ledger as Address;

export const readMandate = async (): Promise<Mandate> => {
  const m: any = await publicClient.readContract({ address: ENVELOPE, abi: envelopeAbi, functionName: 'mandate' });
  return {
    account: m.account,
    executor: m.executor,
    pair: m.pair,
    baseToken: m.baseToken,
    quoteToken: m.quoteToken,
    maxPositionBps: Number(m.maxPositionBps),
    maxDailyLossBps: Number(m.maxDailyLossBps),
    maxSlippageBps: Number(m.maxSlippageBps),
    maxTradesPerHour: Number(m.maxTradesPerHour),
    maxNotionalQuote: m.maxNotionalQuote,
    expiry: m.expiry,
    nonce: m.nonce,
  };
};

export const readPosition = async () => {
  const [baseBalance, baseValueQuote, equityQuote, positionBps] = (await publicClient.readContract({
    address: ENVELOPE,
    abi: envelopeAbi,
    functionName: 'position',
  })) as [bigint, bigint, bigint, bigint];
  const [isActive, nonce, expiry, hour, tradesThisHour, equityNow, dayEquity] = (await publicClient.readContract({
    address: ENVELOPE,
    abi: envelopeAbi,
    functionName: 'state',
  })) as [boolean, bigint, bigint, bigint, number, bigint, bigint];
  const [quoteReserve, baseReserve] = (await publicClient.readContract({
    address: ENVELOPE,
    abi: envelopeAbi,
    functionName: 'price',
  })) as [bigint, bigint];
  const [count, head] = await Promise.all([
    publicClient.readContract({ address: LEDGER, abi: (await import('./abi.js')).ledgerAbi, functionName: 'count' }),
    publicClient.readContract({ address: LEDGER, abi: (await import('./abi.js')).ledgerAbi, functionName: 'head' }),
  ]);

  return {
    baseBalance,
    baseValueQuote,
    equityQuote,
    positionBps: Number(positionBps),
    isActive,
    nonce,
    expiry,
    tradesThisHour: Number(tradesThisHour),
    equityNow,
    dayEquity,
    quoteReserve,
    baseReserve,
    ledgerCount: Number(count),
    ledgerHead: head as Hex,
  };
};

export const hashMandate = (m: Mandate): Hex => {
  // purely informational: the on-chain digest is emitted in MandateSet
  return ('0x' + Buffer.from(JSON.stringify(m)).toString('hex').slice(0, 64)) as Hex;
};

export type MandatePatch = Partial<Pick<Mandate, 'maxPositionBps' | 'maxDailyLossBps' | 'maxSlippageBps' | 'maxTradesPerHour' | 'maxNotionalQuote'>> & {
  days?: number;
};

/** Re-sign and install a mandate. In production this call is made by a wallet (eip1193). */
export const buildNextMandate = async (patch: MandatePatch): Promise<Mandate> => {
  const current = await readMandate();
  return {
    account: current.account,
    executor: current.executor,
    pair: current.pair,
    baseToken: current.baseToken,
    quoteToken: current.quoteToken,
    maxPositionBps: clampBps(patch.maxPositionBps ?? current.maxPositionBps),
    maxDailyLossBps: clampBps(patch.maxDailyLossBps ?? current.maxDailyLossBps),
    maxSlippageBps: Math.min(2000, patch.maxSlippageBps ?? current.maxSlippageBps),
    maxTradesPerHour: Math.max(1, patch.maxTradesPerHour ?? current.maxTradesPerHour),
    maxNotionalQuote: patch.maxNotionalQuote ?? current.maxNotionalQuote,
    expiry: BigInt(Math.floor(Date.now() / 1000) + (patch.days ?? 14) * 86_400),
    nonce: current.nonce + 1n,
  };
};

export const readOwner = async (): Promise<Address> => {
  return (await publicClient.readContract({ address: ENVELOPE, abi: envelopeAbi, functionName: 'owner' })) as Address;
};

/** Everything a browser wallet needs to sign EIP-712 typed data. */
export const typedDataFor = (mandate: Mandate) => ({
  domain: {
    name: 'Envelope',
    version: '1',
    chainId: CONFIG.chainId,
    verifyingContract: ENVELOPE,
  },
  types: MANDATE_TYPES,
  primaryType: 'Mandate',
  message: {
    ...mandate,
    maxNotionalQuote: mandate.maxNotionalQuote.toString(),
    expiry: mandate.expiry.toString(),
    nonce: mandate.nonce.toString(),
  },
});

/**
 * Prepare a mandate for a human wallet to sign. Nothing is installed here:
 * the signature comes back from the browser and is relayed by `submitMandate`.
 */
export const prepareMandate = async (patch: MandatePatch) => {
  const mandate = await buildNextMandate(patch);
  const ownerAddress = await readOwner();
  return { mandate, typedData: typedDataFor(mandate), owner: ownerAddress };
};

/** Relay an owner-signed mandate. Anyone may send this; only the signature is trusted. */
export const submitMandate = async (mandate: Mandate, signature: Hex) => {
  const hash = await executor.writeContract({
    address: ENVELOPE,
    abi: envelopeAbi,
    functionName: 'setMandate',
    args: [mandate as any, signature],
    chain: null,
    account: executor.account!,
    gas: 600_000n,
    ...FEE,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { mandate, txHash: hash, blockNumber: Number(receipt.blockNumber) };
};

export const applyMandate = async (patch: MandatePatch) => {
  const next = await buildNextMandate(patch);

  const signature = await owner.signTypedData({
    domain: {
      name: 'Envelope',
      version: '1',
      chainId: CONFIG.chainId,
      verifyingContract: ENVELOPE,
    },
    types: MANDATE_TYPES,
    primaryType: 'Mandate',
    message: next,
  });

  const hash = await owner.writeContract({
    address: ENVELOPE,
    abi: envelopeAbi,
    functionName: 'setMandate',
    args: [next as any, signature],
    chain: null,
    account: owner.account!,
    gas: 600_000n,
    ...FEE,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { mandate: next, txHash: hash, blockNumber: Number(receipt.blockNumber), signer: ownerAddress };
};

const clampBps = (n: number) => Math.max(1, Math.min(10_000, Math.round(n)));

export type Intent = { isBuy: boolean; amountIn: bigint; minAmountOut: bigint; deadline: bigint };

export const trade = async (intent: Intent, decisionHash: Hex, opts: { simulate: boolean } = { simulate: true }) => {
  const deadline = intent.deadline || BigInt(Math.floor(Date.now() / 1000) + 300);

  if (opts.simulate) {
    const { request } = await publicClient.simulateContract({
      address: TRADER,
      abi: traderAbi,
      functionName: 'trade',
      args: [{ ...intent, deadline }, decisionHash],
      account: executor.account!,
    });
    const hash = await executor.writeContract({ ...request, chain: null, gas: 600_000n, ...FEE } as any);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return { hash, receipt, simulated: true as const };
  }

  const hash = await executor.writeContract({
    address: TRADER,
    abi: traderAbi,
    functionName: 'trade',
    args: [{ ...intent, deadline }, decisionHash],
    chain: null,
    account: executor.account!,
    gas: 600_000n,
    ...FEE,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // A mined-but-reverted transaction does not throw, so a refusal has to be read from the
  // receipt. The revert data is not retained, so replay the call to recover the named
  // error the envelope raised.
  if (receipt.status !== 'success') {
    try {
      await publicClient.simulateContract({
        address: TRADER,
        abi: traderAbi,
        functionName: 'trade',
        args: [{ ...intent, deadline }, decisionHash],
        account: executor.account!,
      });
    } catch (simulated) {
      throw simulated;
    }
    throw new Error(`trade reverted on chain in ${hash}`);
  }

  return { hash, receipt, simulated: false as const };
};

export const refuse = async (decisionHash: Hex, reason: string) => {
  const reasonCode = ('0x' + Buffer.from(reason.padEnd(32, '\0')).toString('hex').slice(0, 64)) as Hex;
  const hash = await executor.writeContract({
    address: TRADER,
    abi: traderAbi,
    functionName: 'refuse',
    args: [decisionHash, reasonCode],
    chain: null,
    account: executor.account!,
    gas: 300_000n,
    ...FEE,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, receipt };
};

/** Pull a human-readable custom error out of a viem failure. */
export const extractRevert = (error: unknown): { name: string; args: unknown[]; message: string } => {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  const hexes: Hex[] = [];

  while (queue.length && seen.size < 60) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (typeof value === 'string' && value.startsWith('0x') && value.length >= 10) hexes.push(value as Hex);
      else if (typeof value === 'object' && value) queue.push(value);
    }
  }

  for (const data of hexes) {
    for (const abi of [envelopeAbi, traderAbi]) {
      try {
        const decoded: any = decodeErrorResult({ abi, data });
        const args = (decoded.args ?? []).map((a: unknown) => (typeof a === 'bigint' ? a.toString() : a));
        const signature = `${decoded.errorName}(${args.join(', ')})`;
        return { name: decoded.errorName, args, message: signature };
      } catch {
        // try the next abi
      }
    }
  }

  const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
  return { name: 'UnknownError', args: [], message };
};

export { executorAddress, ownerAddress };
