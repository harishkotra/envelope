import { createPublicClient, createWalletClient, defineChain, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN, CONFIG } from './config.js';

export const chain = defineChain({
  ...CHAIN,
  id: CONFIG.chainId,
  rpcUrls: { default: { http: [CONFIG.rpcUrl] } },
});

export const publicClient = createPublicClient({
  chain,
  transport: http(CONFIG.rpcUrl, { timeout: 30_000, retryCount: 2 }),
});

const executorAccount = privateKeyToAccount(CONFIG.executorKey);
const ownerAccount = privateKeyToAccount(CONFIG.ownerKey);

export const executor = createWalletClient({ account: executorAccount, chain, transport: http(CONFIG.rpcUrl) });
export const owner = createWalletClient({ account: ownerAccount, chain, transport: http(CONFIG.rpcUrl) });

/**
 * This RPC's fee hints are unreliable (viem ends up below the 1 gwei base fee and the
 * node answers "replacement transaction underpriced"), so every write pins its fees.
 */
export const FEE = {
  gasPrice: 2_000_000_000n,
} as const;

export const executorAddress: Address = executorAccount.address;
export const ownerAddress: Address = ownerAccount.address;
