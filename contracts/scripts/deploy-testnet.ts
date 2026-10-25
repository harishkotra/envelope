import { ethers } from 'hardhat';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Testnet deployment: HSK Chain testnet (chainId 133) has no HSKSwap deployment,
 * so this script ships a self-contained venue (MiniDEX) plus the protocol contracts.
 * Everything here is a real transaction on a real chain.
 *
 * HANDOFF_TO=<metamask address> hands envelope ownership to a human wallet. In that case
 * the mandate is NOT installed here: it must be signed by that wallet (the desk UI does it).
 */

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

let gasTotal = 0n;

/**
 * This network's eth_estimateGas under-reports for calls that deploy a contract
 * internally (createPair) and for plain deploys, so every transaction carries an
 * explicit ceiling. Measured usage is logged alongside.
 */
const GAS = {
  deploy: 5_000_000n,
  createPair: 3_000_000n,
  call: 400_000n,
  mandate: 500_000n,
};
const countDeploy = async (contract: any) => {
  const tx = contract.deploymentTransaction();
  if (!tx) return;
  const receipt = await tx.wait();
  gasTotal += receipt.gasUsed;
  return receipt;
};
const send = async (label: string, p: Promise<any>) => {
  const receipt = await (await p).wait();
  gasTotal += receipt.gasUsed;
  console.log(`  ${label.padEnd(22)} gas ${receipt.gasUsed}`);
  return receipt;
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);
  const gasPrice = (await ethers.provider.getFeeData()).gasPrice ?? 1_000_000_000n;

  console.log(`chainId=${net.chainId} deployer=${deployer.address}`);
  console.log(`balance ${ethers.formatEther(balance)} HSK | gas price ${Number(gasPrice) / 1e9} gwei`);

  if ((process.env.DRY_RUN ?? '') === '1') {
    console.log(`plan: deploy venue + protocol, seed pool, fund desk, ${process.env.HANDOFF_TO ? `hand ownership to ${process.env.HANDOFF_TO}` : 'install mandate'}`);
    return;
  }
  if (net.chainId === 133n && balance === 0n) {
    throw new Error('deployer has no testnet HSK. Claim from the faucet and resend.');
  }

  const executor = process.env.EXECUTOR_ADDRESS ?? deployer.address;

  // ---- venue tokens (testnet has no WHSK) ----
  const TestToken = await ethers.getContractFactory('TestToken');
  const base = await TestToken.deploy('Wrapped HSK', 'WHSK', 18, { gasLimit: GAS.deploy });
  await base.waitForDeployment();
  await countDeploy(base);
  const quote = await TestToken.deploy('Envelope Dollar', 'dUSD', 6, { gasLimit: GAS.deploy });
  await quote.waitForDeployment();
  await countDeploy(quote);
  console.log(`base ${base.target}\nquote ${quote.target}`);

  const DEX = await ethers.getContractFactory('MiniDEX');
  const dex = await DEX.deploy({ gasLimit: GAS.deploy });
  await dex.waitForDeployment();
  await countDeploy(dex);
  const dexAddr = dex.target as string;

  // eth_call against a just-written mapping has returned stale zeros on this network,
  // so take the pair address from the createPair receipt instead of reading it back.
  const pairReceipt = await send(
    'createPair',
    dex.createPair(base.target, quote.target, { gasLimit: GAS.createPair })
  );
  const pair = pairReceipt.logs
    .map((log: any) => {
      try {
        return dex.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed: any) => parsed?.name === 'PairCreated')?.args?.pair as string | undefined;
  if (!pair) throw new Error('PairCreated event missing from createPair receipt');
  console.log(`pair (from event) ${pair}`);
  console.log(`dex ${dexAddr}`);

  // seed: 20 WHSK against 2 dUSD so the pool prices at 0.10 quote per base
  const baseIn = ethers.parseEther('20');
  const quoteIn = 2_000_000n;
  await send('mint quote', quote.mint(deployer.address, quoteIn * 20n, { gasLimit: GAS.call }));
  await send('mint base', base.mint(deployer.address, baseIn, { gasLimit: GAS.call }));
  await send('approve base', base.approve(dexAddr, baseIn, { gasLimit: GAS.call }));
  await send('approve quote', quote.approve(dexAddr, quoteIn * 20n, { gasLimit: GAS.call }));
  await send('addLiquidity', dex.addLiquidity(base.target, quote.target, baseIn, quoteIn, deployer.address, { gasLimit: GAS.call }));
  console.log(`pair ${pair}`);

  // ---- protocol ----
  const Envelope = await ethers.getContractFactory('RiskEnvelope');
  const envelope = await Envelope.deploy({ gasLimit: GAS.deploy });
  await envelope.waitForDeployment();
  await countDeploy(envelope);

  const Ledger = await ethers.getContractFactory('TradeLedger');
  const ledger = await Ledger.deploy({ gasLimit: GAS.deploy });
  await ledger.waitForDeployment();
  await countDeploy(ledger);

  const Trader = await ethers.getContractFactory('EnvelopeTrader');
  const trader = await Trader.deploy(dexAddr, envelope.target, ledger.target, { gasLimit: GAS.deploy });
  await trader.waitForDeployment();
  await countDeploy(trader);
  await send('setWriter', ledger.setWriter(trader.target, { gasLimit: GAS.call }));

  const envelopeAddr = envelope.target as string;
  const traderAddr = trader.target as string;
  console.log(`envelope ${envelopeAddr}\nledger ${ledger.target}\ntrader ${traderAddr}`);

  // ---- fund the desk ----
  await send('fund quote', quote.mint(deployer.address, 500_000n, { gasLimit: GAS.call }));
  await send('send quote', quote.transfer(traderAddr, 500_000n, { gasLimit: GAS.call }));
  await send('mint base 5', base.mint(deployer.address, ethers.parseEther('5'), { gasLimit: GAS.call }));
  await send('send base', base.transfer(traderAddr, ethers.parseEther('1'), { gasLimit: GAS.call }));

  // ---- ownership ----
  const handoff = process.env.HANDOFF_TO?.trim();
  const block = await ethers.provider.getBlock('latest');
  const mandate = {
    account: traderAddr,
    executor,
    pair,
    baseToken: base.target as string,
    quoteToken: quote.target as string,
    maxPositionBps: 4000,
    maxDailyLossBps: 500,
    maxSlippageBps: 300,
    maxTradesPerHour: 6,
    maxNotionalQuote: 150_000n,
    expiry: BigInt(block!.timestamp + 14 * 86400),
    nonce: 1n,
  };

  if (handoff) {
    await send('transferOwnership', envelope.transferOwnership(handoff, { gasLimit: GAS.call }));
    console.log(`ownership handed to ${handoff} — the mandate must be signed from that wallet`);
  } else {
    const ownerKey = process.env.OWNER_PRIVATE_KEY;
    if (!ownerKey) throw new Error('OWNER_PRIVATE_KEY missing');
    const owner = new ethers.Wallet(ownerKey);
    const signature = await owner.signTypedData(
      { name: 'Envelope', version: '1', chainId: net.chainId, verifyingContract: envelopeAddr },
      MANDATE_TYPES,
      mandate
    );
    await send('setMandate', envelope.setMandate(mandate, signature, { gasLimit: GAS.mandate }));
  }

  const baseIsToken0 = (base.target as string).toLowerCase() < (quote.target as string).toLowerCase();

  const label = net.chainId === 133n ? 'testnet' : 'testnet-rehearsal';
  const out = {
    network: label,
    chainId: Number(net.chainId),
    router: dexAddr,
    factory: dexAddr,
    pair,
    baseToken: base.target,
    quoteToken: quote.target,
    baseSymbol: 'WHSK',
    quoteSymbol: 'dUSD',
    baseDecimals: 18,
    quoteDecimals: 6,
    envelope: envelopeAddr,
    ledger: ledger.target,
    trader: traderAddr,
    baseIsToken0,
    mandateInstalled: !handoff,
    owner: handoff ?? deployer.address,
    seededAt: new Date().toISOString(),
  };

  if (!handoff) {
    // this network's read replicas lag a few blocks behind writes, so poll briefly
    let installed: any = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      installed = await envelope.state();
      if (installed[0]) break;
      await new Promise((r) => setTimeout(r, 2500));
    }
    console.log(`mandate active=${installed?.[0]} nonce=${installed?.[1]}`);
    if (!installed?.[0]) throw new Error('mandate did not activate');
  }

  const dir = join(__dirname, '../deployments');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${label}.json`), JSON.stringify(out, null, 2));

  const cost = gasTotal * gasPrice;
  console.log(`\ntotal gas ${gasTotal} | cost ~${ethers.formatEther(cost)} HSK at ${Number(gasPrice) / 1e9} gwei`);
  console.log(`wrote deployments/${label}.json`);
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
