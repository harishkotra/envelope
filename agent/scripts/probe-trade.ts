import { config as loadEnv } from 'dotenv';
loadEnv({ path: new URL('../../.env', import.meta.url).pathname });
import { createPublicClient, createWalletClient, http, parseAbi, decodeErrorResult } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const dep = JSON.parse(readFileSync(new URL('../../contracts/deployments/local.json', import.meta.url), 'utf8'));
const account = privateKeyToAccount(process.env.EXECUTOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY);
const chain = { id: dep.chainId, name: 'local', nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } } };
const pub = createPublicClient({ chain, transport: http('http://127.0.0.1:8545') });

const traderAbi = parseAbi([
  'function trade((bool isBuy,uint256 amountIn,uint256 minAmountOut,uint256 deadline) intent, bytes32 decisionHash) returns (uint256,bytes32)',
]);
const pairAbi = parseAbi(['function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)']);

const [r0, r1] = await pub.readContract({ address: dep.pair, abi: pairAbi, functionName: 'getReserves' });
const t0 = await pub.readContract({ address: dep.pair, abi: pairAbi, functionName: 'token0' });
console.log('pair', dep.pair, 'token0', t0, 'baseIsToken0', dep.baseIsToken0);
console.log('reserves r0', r0.toString(), 'r1', r1.toString());

const amountIn = 37500n;
const rIn = t0.toLowerCase() === dep.quoteToken.toLowerCase() ? BigInt(r0) : BigInt(r1);
const rOut = t0.toLowerCase() === dep.quoteToken.toLowerCase() ? BigInt(r1) : BigInt(r0);
const inFee = amountIn * 997n;
const expected = (inFee * rOut) / (rIn * 1000n + inFee);
console.log('expected out', expected.toString(), 'floor 97%', ((expected * 9700n) / 10000n).toString());

try {
  const { request } = await pub.simulateContract({
    address: dep.trader,
    abi: traderAbi,
    functionName: 'trade',
    args: [
      { isBuy: true, amountIn, minAmountOut: (expected * 9700n) / 10000n, deadline: BigInt(Math.floor(Date.now() / 1000) + 300) },
      '0x' + '11'.repeat(32),
    ],
    account: account.address,
  });
  console.log('simulation ok', request);
} catch (error: any) {
  console.log('--- simulation failed ---');
  console.log('shortMessage:', error.shortMessage);
  console.log('details:', error.details);
  console.log('metaMessages:', error.metaMessages);
  const data = error.cause?.data ?? error.data;
  console.log('data:', data);
  if (typeof data === 'string' && data.startsWith('0x') && data.length > 138) {
    // Error(string) selector 0x08c379a0
    if (data.startsWith('0x08c379a0')) {
      const len = parseInt(data.slice(10, 74), 16);
      const msg = Buffer.from(data.slice(74, 74 + len * 2), 'hex').toString();
      console.log('revert reason:', msg);
    }
  }
}
