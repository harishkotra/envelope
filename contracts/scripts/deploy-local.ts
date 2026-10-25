import { ethers, network } from 'hardhat';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WHSK = '0xB210D2120d57b758EE163cFfb43e73728c471Cf1';

const ERC20 = [
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function mint(address,uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function symbol() view returns (string)',
];

const MANDATE_TYPES = {
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
};

/**
 * Self-contained demo deployment: a MiniDEX pool plus the protocol contracts.
 * Mainnet deployment (scripts/deploy.ts --network hsk) uses the real HSKSwap router.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`local deploy chainId=${net.chainId} deployer=${deployer.address}`);

  // a bare dev chain starts with no balance on the configured key
  if ((await ethers.provider.getBalance(deployer.address)) === 0n) {
    await network.provider.send('hardhat_setBalance', [deployer.address, '0x' + (10n ** 20n).toString(16)]);
  }

  const ownerKey = process.env.OWNER_PRIVATE_KEY;
  if (!ownerKey) throw new Error('OWNER_PRIVATE_KEY missing');
  const owner = new ethers.Wallet(ownerKey, ethers.provider);

  // base asset: wrapped HSK. On a bare local chain we deploy a WETH9 stand-in.
  const WETH9 = ['function deposit() payable', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
  let baseToken = WHSK;
  const existing = await ethers.provider.getCode(WHSK);
  if (existing === '0x') {
    const Mock = await ethers.getContractFactory('MockWHSK');
    const whskLocal = await Mock.deploy();
    await whskLocal.waitForDeployment();
    baseToken = whskLocal.target as string;
    console.log(`deployed local WHSK ${baseToken}`);
  }
  const whsk = new ethers.Contract(baseToken, WETH9, deployer);
  const wrap = ethers.parseEther('40');
  if ((await whsk.balanceOf(deployer.address)) < wrap) {
    await (await whsk.deposit({ value: wrap })).wait();
  }

  // venue
  const DEX = await ethers.getContractFactory('MiniDEX');
  const dex = await DEX.deploy();
  await dex.waitForDeployment();
  const dexAddr = dex.target as string;

  // quote asset
  const TestToken = await ethers.getContractFactory('TestToken');
  const quote = await TestToken.deploy('Envelope Dollar', 'dUSD', 6);
  await quote.waitForDeployment();
  const quoteAddr = quote.target as string;

  await (await dex.createPair(baseToken, quoteAddr)).wait();
  const pair = await dex.getPair(baseToken, quoteAddr);
  console.log(`dex ${dexAddr}\npair ${pair}`);

  // seed: 20 HSK against 2 dUSD, so 0.1 quote per base, close to the real HSK price
  const baseIn = ethers.parseEther('20');
  const quoteIn = 2_000_000n; // 2 dUSD at 6 decimals
  await (await quote.mint(deployer.address, quoteIn * 50n)).wait();
  await (await whsk.approve(dexAddr, baseIn)).wait();
  await (await quote.approve(dexAddr, quoteIn * 50n)).wait();
  await (await dex.addLiquidity(baseToken, quoteAddr, baseIn, quoteIn, deployer.address)).wait();
  console.log('seeded pool');

  // protocol
  const Envelope = await ethers.getContractFactory('RiskEnvelope');
  const envelope = await Envelope.deploy();
  await envelope.waitForDeployment();

  const Ledger = await ethers.getContractFactory('TradeLedger');
  const ledger = await Ledger.deploy();
  await ledger.waitForDeployment();

  const Trader = await ethers.getContractFactory('EnvelopeTrader');
  const trader = await Trader.deploy(dexAddr, envelope.target, ledger.target);
  await trader.waitForDeployment();
  await (await ledger.setWriter(trader.target)).wait();

  const envelopeAddr = envelope.target as string;
  const traderAddr = trader.target as string;

  // fund the desk
  const fundQuote = 500_000n; // 0.5 dUSD
  await (await quote.mint(deployer.address, fundQuote)).wait();
  await (await quote.transfer(traderAddr, fundQuote)).wait();
  await (await whsk.transfer(traderAddr, ethers.parseEther('1'))).wait();

  const executor = process.env.EXECUTOR_ADDRESS ?? owner.address;
  const block = await ethers.provider.getBlock('latest');
  const mandate = {
    account: traderAddr,
    executor,
    pair,
    baseToken,
    quoteToken: quoteAddr,
    maxPositionBps: 4000,
    maxDailyLossBps: 500,
    maxSlippageBps: 300,
    maxTradesPerHour: 6,
    maxNotionalQuote: 150_000n, // 0.15 dUSD per trade
    expiry: BigInt(block!.timestamp + 14 * 86400),
    nonce: 1n,
  };

  const signature = await owner.signTypedData(
    { name: 'Envelope', version: '1', chainId: net.chainId, verifyingContract: envelopeAddr },
    MANDATE_TYPES,
    mandate
  );
  await (await envelope.setMandate(mandate, signature)).wait();

  const token0 = await dex.getPair(baseToken, quoteAddr).then(async (p: string) => {
    const pairC = new ethers.Contract(p, ['function token0() view returns (address)'], deployer);
    return pairC.token0();
  });

  const out = {
    network: 'local',
    chainId: Number(net.chainId),
    router: dexAddr,
    factory: dexAddr,
    pair,
    baseToken,
    quoteToken: quoteAddr,
    baseSymbol: 'WHSK',
    quoteSymbol: 'dUSD',
    baseDecimals: 18,
    quoteDecimals: 6,
    envelope: envelopeAddr,
    ledger: ledger.target,
    trader: traderAddr,
    baseIsToken0: token0.toLowerCase() === baseToken.toLowerCase(),
    seededAt: new Date().toISOString(),
  };

  const dir = join(__dirname, '../deployments');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'local.json'), JSON.stringify(out, null, 2));
  console.log(`wrote deployments/local.json`);
  console.log(`envelope ${envelopeAddr}\nledger ${ledger.target}\ntrader ${traderAddr}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
