import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// secrets live at the repo root, not in this workspace
loadEnv({ path: resolve(__dirname, '../.env') });
loadEnv();

const PK = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = PK ? [PK] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      viaIR: true,
    },
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  networks: {
    hardhat: {
      // a local fork harness: hardhat has no hardfork history for chain 177, so this
      // sandbox runs as a dev chain. The mainnet deployment below is the real thing.
      chainId: 31337,
      forking: process.env.HSK_FORK === 'off'
        ? undefined
        : { url: process.env.HSK_MAINNET_RPC ?? 'https://mainnet.hsk.xyz' },
      allowUnlimitedContractSize: false,
      mining: { auto: true },
    },
    fork: {
      url: 'http://127.0.0.1:8545',
      chainId: 31337,
      accounts,
    },
    hsk: {
      url: process.env.HSK_MAINNET_RPC ?? 'https://mainnet.hsk.xyz',
      chainId: 177,
      accounts,
    },
    hsktest: {
      url: process.env.HSK_TESTNET_RPC ?? 'https://testnet.hsk.xyz',
      chainId: 133,
      accounts,
    },
  },
  mocha: { timeout: 180000 },
  // HSK Chain is an OP Stack L2 on cancun-era EVM. Hardhat has no built-in history
  // for chain 177, so declare it, otherwise every eth_call at a forked block fails.
  chains: {
    177: {
      hardforkHistory: {
        berlin: 0,
        london: 0,
        paris: 0,
        shanghai: 0,
        cancun: 0,
      },
    },
  },
};

export default config;
