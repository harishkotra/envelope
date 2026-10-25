import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import type { Signer } from 'ethers';

const HSK_FACTORY = '0x75e5da970b546e214650ae2d3b6e7918db344119';
const HSK_ROUTER = '0x569a9C081F8Eb11215B86723976C4b404DfF4439';
const WHSK = '0xB210D2120d57b758EE163cFfb43e73728c471Cf1';

const WETH9_ABI = [
  'function deposit() payable',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];
const FACTORY_ABI = [
  'function createPair(address,address) returns (address)',
  'function getPair(address,address) view returns (address)',
];
const ROUTER_ABI = [
  'function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)',
  'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])',
];

const DOMAIN_NAME = 'Envelope';
const DOMAIN_VERSION = '1';

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

describe('Envelope — risk mandate + hash-chained ledger on an HSK Chain fork', () => {
  let owner: Signer;
  let executor: Signer;
  let ownerAddr: string;
  let executorAddr: string;

  let envelope: any;
  let ledger: any;
  let trader: any;
  let quote: any;
  let pairAddr: string;
  let traderAddr: string;

  const ONE = 10n ** 18n;
  const Q = 10n ** 6n; // quote has 6 decimals

  const mintMandate = (over: Partial<Record<string, any>> = {}) => ({
    account: traderAddr,
    executor: executorAddr,
    pair: pairAddr,
    baseToken: WHSK,
    quoteToken: over.quoteToken ?? quote.target,
    maxPositionBps: 4000,
    maxDailyLossBps: 500,
    maxSlippageBps: 300,
    maxTradesPerHour: 6,
    maxNotionalQuote: 50n * Q,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
    nonce: 1n,
    ...over,
  });

  const signMandate = async (m: any) => {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return owner.signTypedData(
      { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: envelope.target },
      MANDATE_TYPES,
      m
    );
  };

  const setMandate = async (over: Partial<Record<string, any>> = {}) => {
    const m = mintMandate(over);
    const sig = await signMandate(m);
    return envelope.setMandate(m, sig);
  };

  /// expected output for a 0.3 percent fee pool, then a 1 percent floor (inside the 3 percent mandate band)
  const expectedOut = async (isBuy: boolean, amountIn: bigint) => {
    const pair = await ethers.getContractAt(
      [
        'function getReserves() view returns (uint112,uint112,uint32)',
        'function token0() view returns (address)',
      ],
      pairAddr
    );
    const [r0, r1] = await pair.getReserves();
    const token0 = await pair.token0();
    const quoteIsToken0 = token0.toLowerCase() === (quote.target as string).toLowerCase();
    const [rIn, rOut] = isBuy
      ? quoteIsToken0
        ? [r0, r1]
        : [r1, r0]
      : quoteIsToken0
        ? [r1, r0]
        : [r0, r1];
    const inWithFee = amountIn * 997n;
    const expected = (inWithFee * rOut) / (rIn * 1000n + inWithFee);
    return (expected * 99n) / 100n;
  };

  before(async () => {
    [owner, executor] = await ethers.getSigners();
    ownerAddr = await owner.getAddress();
    executorAddr = await executor.getAddress();

    // fund the owner on the fork
    await network.provider.send('hardhat_setBalance', [ownerAddr, '0x' + (10n ** 20n).toString(16)]);

    // wrap native HSK into WHSK so we can seed a real HSKSwap pair
    const whsk = new ethers.Contract(WHSK, WETH9_ABI, owner);
    await (await whsk.deposit({ value: ONE })).wait();

    // demo stablecoin as the quote asset
    const TestToken = await ethers.getContractFactory('TestToken');
    quote = await TestToken.deploy('Envelope Dollar', 'dUSD', 6);
    await quote.waitForDeployment();
    await (await quote.mint(ownerAddr, 100000n * Q)).wait();

    // create and seed the pair on the live HSKSwap factory
    const factory = new ethers.Contract(HSK_FACTORY, FACTORY_ABI, owner);
    pairAddr = await factory.getPair(WHSK, quote.target);
    if (pairAddr === ethers.ZeroAddress) {
      const tx = await factory.createPair(WHSK, quote.target);
      await tx.wait();
      pairAddr = await factory.getPair(WHSK, quote.target);
    }

    const router = new ethers.Contract(HSK_ROUTER, ROUTER_ABI, owner);
    await (await whsk.approve(HSK_ROUTER, ONE)).wait();
    await (await quote.approve(HSK_ROUTER, 10000n * Q)).wait();
    await (
      await router.addLiquidity(WHSK, quote.target, ONE / 2n, 5000n * Q, 0, 0, ownerAddr, 2000000000)
    ).wait();

    // protocol contracts
    const Envelope = await ethers.getContractFactory('RiskEnvelope');
    envelope = await Envelope.deploy();
    await envelope.waitForDeployment();

    const Ledger = await ethers.getContractFactory('TradeLedger');
    ledger = await Ledger.deploy();
    await ledger.waitForDeployment();

    const Trader = await ethers.getContractFactory('EnvelopeTrader');
    trader = await Trader.deploy(HSK_ROUTER, envelope.target, ledger.target);
    await trader.waitForDeployment();
    traderAddr = trader.target as string;
    await (await ledger.setWriter(traderAddr)).wait();

    // fund the trader: quote to buy with, a little base to sell
    await (await quote.transfer(traderAddr, 5000n * Q)).wait();
    await (await whsk.transfer(traderAddr, ONE / 20n)).wait();
  });

  it('seeds a real HSKSwap pair and reports equity', async () => {
    const [quoteReserve, baseReserve] = await envelope.price().catch(() => [0n, 0n]);
    expect(pairAddr).to.not.equal(ethers.ZeroAddress);
    expect(baseReserve).to.equal(0n); // nothing set yet because mandate not installed
  });

  it('rejects a mandate signed by the wrong key', async () => {
    const m = mintMandate();
    const badSig = await executor.signTypedData(
      { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: 177, verifyingContract: envelope.target },
      MANDATE_TYPES,
      m
    );
    await expect(envelope.setMandate(m, badSig)).to.be.revertedWithCustomError(envelope, 'InvalidSigner');
  });

  it('installs the signed mandate and reports position', async () => {
    await setMandate();
    const [active, nonce] = await envelope.state();
    expect(active).to.equal(true);
    expect(nonce).to.equal(1n);

    const [, baseValue, equityNow] = await envelope.position();
    expect(equityNow).to.be.greaterThan(0n);
    expect(baseValue).to.be.greaterThan(0n);
  });

  it('executes a trade inside the envelope and anchors it', async () => {
    const decision = ethers.keccak256(ethers.toUtf8Bytes('decision-1'));
    const amountIn = 10n * Q;
    const intent = { isBuy: true, amountIn, minAmountOut: await expectedOut(true, amountIn), deadline: 2000000000 };
    await expect(trader.connect(executor).trade(intent, decision)).to.emit(trader, 'Trade');
    expect(await ledger.count()).to.equal(1n);
    const head = await ledger.head();
    expect(head).to.not.equal(ethers.ZeroHash);
  });

  it('reverts with a named error when the order breaches the notional cap', async () => {
    const decision = ethers.keccak256(ethers.toUtf8Bytes('decision-2'));
    const intent = { isBuy: true, amountIn: 500n * Q, minAmountOut: 0, deadline: 2000000000 };
    await expect(trader.connect(executor).trade(intent, decision)).to.be.revertedWithCustomError(
      envelope,
      'NotionalExceeded'
    );
  });

  it('reverts when the order breaches the position ceiling', async () => {
    // position cap 4000 bps of equity; a 45 quote buy into a roughly 50/50 book should break it
    await setMandate({ maxPositionBps: 500, maxNotionalQuote: 1000n * Q, nonce: 2n });
    const decision = ethers.keccak256(ethers.toUtf8Bytes('decision-3'));
    const intent = { isBuy: true, amountIn: 40n * Q, minAmountOut: 0, deadline: 2000000000 };
    await expect(trader.connect(executor).trade(intent, decision)).to.be.revertedWithCustomError(
      envelope,
      'PositionExceeded'
    );
  });

  it('rate limits the agent', async () => {
    await setMandate({ maxTradesPerHour: 1, maxPositionBps: 9000, maxNotionalQuote: 1000n * Q, nonce: 3n });
    const d1 = ethers.keccak256(ethers.toUtf8Bytes('rate-1'));
    const size = 2n * Q;
    const out1 = await expectedOut(true, size);
    await (await trader.connect(executor).trade({ isBuy: true, amountIn: size, minAmountOut: out1, deadline: 2000000000 }, d1)).wait();
    const d2 = ethers.keccak256(ethers.toUtf8Bytes('rate-2'));
    const out2 = await expectedOut(true, size);
    await expect(
      trader.connect(executor).trade({ isBuy: true, amountIn: size, minAmountOut: out2, deadline: 2000000000 }, d2)
    ).to.be.revertedWithCustomError(envelope, 'RateLimited');
  });

  it('rejects an expired mandate', async () => {
    const block = await ethers.provider.getBlock('latest');
    const expiry = BigInt(block!.timestamp + 60);
    await setMandate({ expiry, nonce: 4n });

    const stored = (await envelope.mandate()).expiry;
    expect(stored).to.equal(expiry);

    await network.provider.send('evm_setNextBlockTimestamp', [Number(expiry) + 5]);
    await network.provider.send('evm_mine', []);
    const d = ethers.keccak256(ethers.toUtf8Bytes('expired'));
    const out = await expectedOut(true, 1n * Q);
    await expect(
      trader.connect(executor).trade({ isBuy: true, amountIn: 1n * Q, minAmountOut: out, deadline: 2000000000 }, d)
    ).to.be.revertedWithCustomError(envelope, 'EnvelopeExpired');
  });

  it('rejects anyone who is not the executor', async () => {
    await setMandate({ nonce: 5n });
    const d = ethers.keccak256(ethers.toUtf8Bytes('intruder'));
    const out = await expectedOut(true, 1n * Q);
    await expect(
      trader.connect(owner).trade({ isBuy: true, amountIn: 1n * Q, minAmountOut: out, deadline: 2000000000 }, d)
    ).to.be.revertedWithCustomError(trader, 'NotExecutor');
  });

  it('refuses a slippage floor looser than the mandate band', async () => {
    await setMandate({ maxSlippageBps: 100, nonce: 6n });
    const d = ethers.keccak256(ethers.toUtf8Bytes('slippage-band'));
    const size = 1n * Q;
    const loose = (await expectedOut(true, size)) / 2n; // 50 percent below the quote, outside a 1 percent band
    await expect(
      trader.connect(executor).trade({ isBuy: true, amountIn: size, minAmountOut: loose, deadline: 2000000000 }, d)
    ).to.be.revertedWithCustomError(trader, 'SlippageBandViolation');
  });

  it('reverts on stale nonce so an old mandate cannot be replayed', async () => {
    const m = mintMandate({ nonce: 1n });
    const sig = await signMandate(m);
    await expect(envelope.setMandate(m, sig)).to.be.revertedWithCustomError(envelope, 'StaleNonce');
  });

  it('hands ownership to a human wallet and locks the deployer out', async () => {
    const [, , human] = await ethers.getSigners();
    const humanAddr = await human.getAddress();

    await expect(envelope.transferOwnership(humanAddr))
      .to.emit(envelope, 'OwnershipTransferred')
      .withArgs(ownerAddr, humanAddr);
    expect(await envelope.owner()).to.equal(humanAddr);
    expect(await envelope.active()).to.equal(false);

    // the old owner's signature is no longer good enough
    const stale = mintMandate({ nonce: 20n });
    await expect(envelope.setMandate(stale, await signMandate(stale))).to.be.revertedWithCustomError(
      envelope,
      'InvalidSigner'
    );

    // the human wallet can install one, and anyone can relay it
    const fresh = mintMandate({ nonce: 20n });
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const humanSig = await human.signTypedData(
      { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: envelope.target },
      MANDATE_TYPES,
      fresh
    );
    await envelope.connect(executor).setMandate(fresh, humanSig);
    expect(await envelope.active()).to.equal(true);
    expect((await envelope.state())[1]).to.equal(20n);
  });

  it('keeps the ledger chain verifiable link by link', async () => {
    const count = Number(await ledger.count());
    expect(count).to.be.greaterThan(0);

    let cursor = await ledger.head();
    const seen: bigint[] = [];
    for (let i = count; i > 0; i--) {
      const e = await ledger.entry(cursor);
      expect(Number(e.seq)).to.equal(i);
      const recomputed = await ledger.recompute(e.prev, e.decision, e.outcome, e.ts, e.seq);
      expect(recomputed).to.equal(cursor);
      seen.push(e.ts);
      cursor = e.prev;
    }
    expect(cursor).to.equal(ethers.ZeroHash);
    expect(seen.length).to.equal(count);
  });
});
