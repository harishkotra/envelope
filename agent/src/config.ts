import { config as loadEnv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineChain, type Address } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));

for (const candidate of [
  join(here, '../../.env'),
  join(here, '../../../.env'),
  resolve(process.cwd(), '.env'),
]) {
  if (existsSync(candidate)) {
    loadEnv({ path: candidate });
    break;
  }
}

const num = (v: string | undefined, fallback: number) => (v ? Number(v) : fallback);

export const CHAIN = defineChain({
  id: num(process.env.CHAIN_ID, 177),
  name: process.env.CHAIN_NAME ?? 'HSK Chain',
  nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? 'https://mainnet.hsk.xyz'] } },
  blockExplorers: {
    default: { name: 'Blockscout', url: process.env.EXPLORER_URL ?? 'https://hashkey.blockscout.com' },
  },
});

export type Deployment = {
  network: string;
  chainId: number;
  router: Address;
  factory: Address;
  pair: Address;
  baseToken: Address;
  quoteToken: Address;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  envelope: Address;
  ledger: Address;
  trader: Address;
  baseIsToken0: boolean;
  seededAt?: string;
};

const network = process.env.NETWORK ?? 'local';
const deploymentFile = join(here, `../../contracts/deployments/${network}.json`);

if (!existsSync(deploymentFile)) {
  throw new Error(
    `No deployment found for NETWORK=${network}. Run the deploy script first: pnpm --filter @envelope/contracts deploy:${network}`
  );
}

export const DEPLOYMENT: Deployment = JSON.parse(readFileSync(deploymentFile, 'utf8'));

export const CONFIG = {
  network,
  chainId: num(process.env.CHAIN_ID, DEPLOYMENT.chainId),
  rpcUrl: process.env.RPC_URL ?? 'https://mainnet.hsk.xyz',
  explorerUrl: process.env.EXPLORER_URL ?? 'https://hashkey.blockscout.com',
  port: num(process.env.AGENT_PORT, 8787),
  executorKey: (process.env.EXECUTOR_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY) as `0x${string}`,
  ownerKey: (process.env.OWNER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY) as `0x${string}`,
  particle: {
    apiKey: process.env.PARTICLE_API_KEY ?? '',
    baseUrl: process.env.PARTICLE_BASE_URL ?? 'https://api.particle.ai/v1',
    model: process.env.PARTICLE_MODEL ?? 'deepseek-v41-flash-1017',
    maxTokens: num(process.env.PARTICLE_MAX_TOKENS, 2200),
  },
  loop: {
    intervalMs: num(process.env.TICK_INTERVAL_MS, 90_000),
    autoStart: (process.env.AUTO_START ?? 'true') === 'true',
    noise: (process.env.NOISE_TRADER ?? 'true') === 'true',
  },
  dataDir: join(here, '../data'),
};

if (!CONFIG.particle.apiKey) {
  console.warn('[config] PARTICLE_API_KEY is missing, the agent will fall back to a deterministic policy');
}
