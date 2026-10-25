import { formatUnits, parseAbiItem } from 'viem';
import { publicClient } from './chain.js';
import { DEPLOYMENT } from './config.js';
import { envelopeAbi, pairAbi } from './abi.js';

export type Flow = {
  windowBlocks: number;
  swaps: number;
  baseVolume: number;
  quoteVolume: number;
  buyRatio: number;
};

export type Snapshot = {
  ts: number;
  blockNumber: number;
  quoteReserve: number;
  baseReserve: number;
  price: number;
  referencePrice: number;
  imbalancePct: number;
  depthQuote: number;
  flow: Flow;
  equityQuote: number;
  positionBps: number;
  baseBalance: number;
  quoteBalance: number;
  tradesThisHour: number;
  maxTradesPerHour: number;
};

const SWAP_EVENT = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)'
);

const priceHistory: number[] = [];

export const toHuman = (raw: bigint, decimals: number) => Number(formatUnits(raw, decimals));

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const readFlow = async (fromBlock: bigint, toBlock: bigint): Promise<Flow> => {
  try {
    const logs = await publicClient.getLogs({
      address: DEPLOYMENT.pair as `0x${string}`,
      event: SWAP_EVENT,
      fromBlock,
      toBlock,
    });

    let baseVolume = 0;
    let quoteVolume = 0;
    let buys = 0;

    for (const log of logs) {
      const { amount0In, amount1In, amount0Out, amount1Out } = log.args as any;
      // base is token1 when baseIsToken0 is false
      const baseIn = Number(formatUnits(DEPLOYMENT.baseIsToken0 ? amount0In : amount1In, DEPLOYMENT.baseDecimals));
      const baseOut = Number(formatUnits(DEPLOYMENT.baseIsToken0 ? amount0Out : amount1Out, DEPLOYMENT.baseDecimals));
      const quoteIn = Number(formatUnits(DEPLOYMENT.baseIsToken0 ? amount1In : amount0In, DEPLOYMENT.quoteDecimals));
      const quoteOut = Number(formatUnits(DEPLOYMENT.baseIsToken0 ? amount1Out : amount0Out, DEPLOYMENT.quoteDecimals));

      baseVolume += baseIn + baseOut;
      quoteVolume += quoteIn + quoteOut;
      if (quoteIn > 0) buys += 1; // quote in means someone bought base
    }

    return {
      windowBlocks: Number(toBlock - fromBlock),
      swaps: logs.length,
      baseVolume,
      quoteVolume,
      buyRatio: logs.length ? buys / logs.length : 0.5,
    };
  } catch {
    return { windowBlocks: 0, swaps: 0, baseVolume: 0, quoteVolume: 0, buyRatio: 0.5 };
  }
};

export const snapshot = async (windowBlocks = 5000): Promise<Snapshot> => {
  const block = await publicClient.getBlockNumber();

  const [reserves, position, state] = await Promise.all([
    publicClient.readContract({ address: DEPLOYMENT.envelope as `0x${string}`, abi: envelopeAbi, functionName: 'price' }),
    publicClient.readContract({ address: DEPLOYMENT.envelope as `0x${string}`, abi: envelopeAbi, functionName: 'position' }),
    publicClient.readContract({ address: DEPLOYMENT.envelope as `0x${string}`, abi: envelopeAbi, functionName: 'state' }),
  ]);

  const [baseBalance, baseValueQuote, equityQuote, positionBps] = position as [bigint, bigint, bigint, bigint];
  const [quoteReserveRaw, baseReserveRaw] = reserves as [bigint, bigint];

  const quoteReserve = toHuman(quoteReserveRaw, DEPLOYMENT.quoteDecimals);
  const baseReserve = toHuman(baseReserveRaw, DEPLOYMENT.baseDecimals);
  const price = baseReserve > 0 ? quoteReserve / baseReserve : 0;

  priceHistory.push(price);
  if (priceHistory.length > 60) priceHistory.shift();
  const reference = priceHistory.length > 2 ? median(priceHistory.slice(0, -1)) : price;
  const imbalancePct = reference > 0 ? ((price - reference) / reference) * 100 : 0;

  const flow = await readFlow(block - BigInt(windowBlocks), block);

  const mandateState = state as [boolean, bigint, bigint, bigint, number, bigint, bigint];

  return {
    ts: Math.floor(Date.now() / 1000),
    blockNumber: Number(block),
    quoteReserve,
    baseReserve,
    price,
    referencePrice: reference,
    imbalancePct,
    depthQuote: quoteReserve,
    flow,
    equityQuote: toHuman(equityQuote, DEPLOYMENT.quoteDecimals),
    positionBps: Number(positionBps),
    baseBalance: toHuman(baseBalance, DEPLOYMENT.baseDecimals),
    quoteBalance: Math.max(0, toHuman(equityQuote - baseValueQuote, DEPLOYMENT.quoteDecimals)),
    tradesThisHour: Number(mandateState[4]),
    maxTradesPerHour: 0,
  };
};

export const priceSeries = () => [...priceHistory];
