import { ethers, network } from 'hardhat';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WHSK = '0xB210D2120d57b758EE163cFfb43e73728c471Cf1';
const FACTORY = process.env.HSK_FACTORY ?? '0x75e5da970b546e214650ae2d3b6e7918db344119';
const ROUTER = process.env.HSK_ROUTER ?? '0x569a9C081F8Eb11215B86723976C4b404DfF4439';
const USDC_E = '0x054ed45810DbBAb8B27668922D110669c9D88D0a';

const WETH9 = ['function deposit() payable', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'];
const FACTORY_ABI = ['function createPair(address,address) returns (address)', 'function getPair(address,address) view returns (address)'];
const ROUTER_ABI = [
  'function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)',
];
const ERC20 = [
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address,uint256) returns (bool)',
  'function mint(address,uint256)',
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

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`network=${network.name} chainId=${net.chainId} deployer=${deployer.address}`);

  if (network.name === 'hardhat' || network.name === 'fork') {
    await network.provider.send('hardhat_setBalance', [deployer.address, '0x' + (10n ** 20n).toString(16)]);
  }

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`native balance ${ethers.formatEther(balance)} HSK`);
  if (balance === 0n) throw new Error('deployer has no HSK for gas');

  if ((process.env.DRY_RUN ?? '') === '1') {
    const quoteAddress = process.env.QUOTE_TOKEN ?? '(will deploy TestToken)';
    console.log('--- DRY RUN, no transactions sent ---');
    console.log(`router   ${ROUTER}`);
    console.log(`factory  ${FACTORY}`);
    console.log(`quote    ${quoteAddress}`);
    console.log(`deployer ${deployer.address}`);
    console.log(`wrap     ${process.env.SEED_HSK ?? '6'} HSK into WHSK`);
    console.log('plan     createPair if missing, seed liquidity, deploy envelope/ledger/trader, fund, sign mandate');
    return;
  }

  // ---- base asset: wrapped HSK
  const whsk = new ethers.Contract(WHSK, WETH9, deployer);
  const wrapAmount = ethers.parseEther(process.env.SEED_HSK ?? '6');
  const whskBal = await whsk.balanceOf(deployer.address);
  if (whskBal < wrapAmount) {
    await (await whsk.deposit({ value: wrapAmount - whskBal })).wait();
  }
  console.log(`WHSK ${ethers.formatEther(await whsk.balanceOf(deployer.address))}`);

  // ---- quote asset
  let quoteAddress = process.env.QUOTE_TOKEN ?? '';
  let quoteSymbol = 'dUSD';
  let quoteDecimals = 6;
  let quote: any;

  if (!quoteAddress) {
    const TestToken = await ethers.getContractFactory('TestToken');
    quote = await TestToken.deploy('Envelope Dollar', 'dUSD', 6);
    await quote.waitForDeployment();
    quoteAddress = quote.target as string;
    console.log(`deployed quote token ${quoteAddress}`);
  } else {
    quote = new ethers.Contract(quoteAddress, ERC20, deployer);
    quoteSymbol = await quote.symbol();
    quoteDecimals = Number(await quote.decimals());
    console.log(`using quote token ${quoteSymbol} ${quoteAddress}`);
  }

  // ---- pair on the live HSKSwap factory
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, deployer);
  let pair = await factory.getPair(WHSK, quoteAddress);
  if (pair === ethers.ZeroAddress) {
    await (await factory.createPair(WHSK, quoteAddress)).wait();
    pair = await factory.getPair(WHSK, quoteAddress);
    console.log(`created pair ${pair}`);
  } else {
    console.log(`existing pair ${pair}`);
  }

  // ---- seed liquidity if the pool is empty
  const pairAbi = ['function getReserves() view returns (uint112,uint112,uint32)'];
  const pairContract = new ethers.Contract(pair, pairAbi, deployer);
  let [r0, r1] = await pairContract.getReserves();
  if (r0 === 0n || r1 === 0n) {
    const baseIn = ethers.parseEther(process.env.SEED_HSK ?? '6');
    const quoteIn = BigInt(process.env.SEED_QUOTE ?? '600000'); // 0.6 dUSD for 6 HSK = 0.1 quote per base
    if (quoteAddress === USDC_E) {
      const bal = await quote.balanceOf(deployer.address);
      if (bal < quoteIn) throw new Error(`need ${quoteIn} USDC.e to seed, have ${bal}`);
    } else {
      await (await quote.mint(deployer.address, quoteIn * 100n)).wait();
    }
    await (await whsk.approve(ROUTER, baseIn)).wait();
    await (await quote.approve(ROUTER, quoteIn)).wait();
    const router = new ethers.Contract(ROUTER, ROUTER_ABI, deployer);
    await (await router.addLiquidity(WHSK, quoteAddress, baseIn, quoteIn, 0, 0, deployer.address, 2000000000)).wait();
    [r0, r1] = await pairContract.getReserves();
    console.log(`seeded pool reserves ${r0} / ${r1}`);
  } else {
    console.log(`pool already has liquidity ${r0} / ${r1}`);
  }

  // ---- protocol
  const Envelope = await ethers.getContractFactory('RiskEnvelope');
  const envelope = await Envelope.deploy();
  await envelope.waitForDeployment();

  const Ledger = await ethers.getContractFactory('TradeLedger');
  const ledger = await Ledger.deploy();
  await ledger.waitForDeployment();

  const Trader = await ethers.getContractFactory('EnvelopeTrader');
  const trader = await Trader.deploy(ROUTER, envelope.target, ledger.target);
  await trader.waitForDeployment();

  await (await ledger.setWriter(trader.target)).wait();

  const envelopeAddr = envelope.target as string;
  const traderAddr = trader.target as string;
  console.log(`envelope ${envelopeAddr}`);
  console.log(`ledger   ${ledger.target}`);
  console.log(`trader   ${traderAddr}`);

  // ---- fund the trader
  const fundQuote = BigInt(process.env.FUND_QUOTE ?? '300000'); // 0.3 quote units
  if (quoteAddress !== USDC_E) {
    await (await quote.mint(deployer.address, fundQuote)).wait();
  }
  await (await quote.transfer(traderAddr, fundQuote)).wait();
  const fundBase = ethers.parseEther(process.env.FUND_BASE ?? '0.5');
  await (await whsk.transfer(traderAddr, fundBase)).wait();

  // ---- mandate, signed by the owner key
  const ownerKey = process.env.OWNER_PRIVATE_KEY;
  if (!ownerKey) throw new Error('OWNER_PRIVATE_KEY missing');
  const owner = new ethers.Wallet(ownerKey, ethers.provider);

  const executor = process.env.EXECUTOR_ADDRESS ?? owner.address;
  const mandate = {
    account: traderAddr,
    executor,
    pair,
    baseToken: WHSK,
    quoteToken: quoteAddress,
    maxPositionBps: 4000,
    maxDailyLossBps: 500,
    maxSlippageBps: 300,
    maxTradesPerHour: 6,
    maxNotionalQuote: BigInt(process.env.MAX_NOTIONAL ?? '60000'),
    expiry: BigInt(Math.floor(Date.now() / 1000) + Number(process.env.MANDATE_DAYS ?? 14) * 86400),
    nonce: 1n,
  };

  const signature = await owner.signTypedData(
    { name: 'Envelope', version: '1', chainId: net.chainId, verifyingContract: envelopeAddr },
    MANDATE_TYPES,
    mandate
  );
  await (await envelope.setMandate(mandate, signature)).wait();
  console.log(`mandate installed, executor=${executor}`);

  const token0 = await new ethers.Contract(pair, ['function token0() view returns (address)'], deployer).token0();

  const out = {
    network: network.name,
    chainId: Number(net.chainId),
    router: ROUTER,
    factory: FACTORY,
    pair,
    baseToken: WHSK,
    quoteToken: quoteAddress,
    baseSymbol: 'WHSK',
    quoteSymbol,
    baseDecimals: 18,
    quoteDecimals,
    envelope: envelopeAddr,
    ledger: ledger.target,
    trader: traderAddr,
    baseIsToken0: token0.toLowerCase() === WHSK.toLowerCase(),
    seededAt: new Date().toISOString(),
  };

  const dir = join(__dirname, '../deployments');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));
  console.log(`wrote deployments/${network.name}.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
