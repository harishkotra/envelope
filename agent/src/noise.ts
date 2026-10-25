import { parseAbi, type Address } from 'viem';
import { DEPLOYMENT } from './config.js';
import { owner, publicClient } from './chain.js';

/**
 * Demo flow generator.
 *
 * HSKSwap's live factory has one pool holding about a cent of liquidity, so an
 * autonomous trader has nothing to react to. This module creates genuine on-chain
 * flow in the demo pool (small real swaps) so the agent's decisions are reactions
 * to a moving market rather than a static quote. It is labelled everywhere as
 * synthetic flow, and it is off unless NOISE_TRADER=true.
 */

const ROUTER_ABI = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[])',
  'function addLiquidity(address a,address b,uint256 amtA,uint256 amtB,address to) returns (uint256)',
]);
const ERC20 = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

const rand = (min: number, max: number) => min + Math.random() * (max - min);

let approved = false;

const ensureApprovals = async () => {
  if (approved) return;
  const router = DEPLOYMENT.router as Address;
  for (const token of [DEPLOYMENT.baseToken, DEPLOYMENT.quoteToken] as Address[]) {
    const allowed = await publicClient.readContract({
      address: token,
      abi: ERC20,
      functionName: 'allowance',
      args: [owner.account!.address, router],
    });
    if (allowed < 10n ** 24n) {
      const hash = await owner.writeContract({
        address: token,
        abi: ERC20,
        functionName: 'approve',
        args: [router, 10n ** 30n],
        chain: null,
        account: owner.account!,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
  }
  approved = true;
};

export const nudge = async (): Promise<{ direction: 'into-base' | 'into-quote'; amountIn: string; txHash: string }> => {
  await ensureApprovals();

  const buy = Math.random() > 0.45;
  const amountIn = buy
    ? BigInt(Math.floor(rand(0.008, 0.03) * 10 ** DEPLOYMENT.quoteDecimals))
    : BigInt(Math.floor(rand(0.06, 0.28) * 10 ** DEPLOYMENT.baseDecimals));

  if (amountIn === 0n) throw new Error('noise amount rounded to zero');

  const path = buy
    ? [DEPLOYMENT.quoteToken as Address, DEPLOYMENT.baseToken as Address]
    : [DEPLOYMENT.baseToken as Address, DEPLOYMENT.quoteToken as Address];

  const hash = await owner.writeContract({
    address: DEPLOYMENT.router as Address,
    abi: ROUTER_ABI,
    functionName: 'swapExactTokensForTokens',
    args: [amountIn, 0n, path, owner.account!.address, BigInt(Math.floor(Date.now() / 1000) + 120)],
    chain: null,
    account: owner.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash });

  return { direction: buy ? 'into-base' : 'into-quote', amountIn: amountIn.toString(), txHash: hash };
};
