import 'dotenv/config';
import { createPublicClient, http, formatUnits, parseAbi } from 'viem';

const RPC = process.env.HSK_MAINNET_RPC ?? 'https://mainnet.hsk.xyz';
const client = createPublicClient({ transport: http(RPC) });

const FACTORY = '0x75e5da970b546e214650ae2d3b6e7918db344119' as const;
const ROUTERS = [
  '0x569a9C081F8Eb11215B86723976C4b404DfF4439',
  '0xf4f8f4dD8337C000701C856DA8303a3284F57217',
] as const;

const factoryAbi = parseAbi([
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256) view returns (address)',
]);
const pairAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function totalSupply() view returns (uint256)',
]);
const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
]);

async function sym(a: `0x${string}`) {
  try {
    const [s, d] = await Promise.all([
      client.readContract({ address: a, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: a, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    return { symbol: s, decimals: d };
  } catch {
    return { symbol: '?', decimals: 18 };
  }
}

const main = async () => {
  const n = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'allPairsLength' });
  console.log(`factory ${FACTORY} pairs=${n}`);

  for (let i = 0; i < Number(n); i++) {
    const pair = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'allPairs', args: [BigInt(i)] });
    const [t0, t1, reserves, supply] = await Promise.all([
      client.readContract({ address: pair, abi: pairAbi, functionName: 'token0' }),
      client.readContract({ address: pair, abi: pairAbi, functionName: 'token1' }),
      client.readContract({ address: pair, abi: pairAbi, functionName: 'getReserves' }).catch(() => [0n, 0n, 0] as const),
      client.readContract({ address: pair, abi: pairAbi, functionName: 'totalSupply' }).catch(() => 0n),
    ]);
    const [a, b] = await Promise.all([sym(t0), sym(t1)]);
    console.log(`#${i} ${pair}`);
    console.log(`   ${a.symbol}(${a.decimals}) ${formatUnits(reserves[0], a.decimals)}  /  ${b.symbol}(${b.decimals}) ${formatUnits(reserves[1], b.decimals)}  lp=${supply}`);
  }

  for (const r of ROUTERS) {
    const code = await client.getCode({ address: r as `0x${string}` });
    console.log(`router ${r} codeLen=${code ? code.length : 0}`);
  }

  const gas = await client.getGasPrice();
  console.log('gasPrice', gas, '=', Number(gas) / 1e9, 'gwei');
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
