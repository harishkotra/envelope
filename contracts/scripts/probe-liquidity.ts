import { ethers } from 'hardhat';

/** Isolate the testnet addLiquidity revert: simulate first, then send. */
async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`chainId ${net.chainId} deployer ${deployer.address}`);

  const TestToken = await ethers.getContractFactory('TestToken');
  const base = await TestToken.deploy('Wrapped HSK', 'WHSK', 18);
  await base.waitForDeployment();
  const quote = await TestToken.deploy('Envelope Dollar', 'dUSD', 6);
  await quote.waitForDeployment();

  const DEX = await ethers.getContractFactory('MiniDEX');
  const dex = await DEX.deploy();
  await dex.waitForDeployment();
  const dexAddr = dex.target as string;

  await (await dex.createPair(base.target, quote.target)).wait();
  const pair = await dex.getPair(base.target, quote.target);
  console.log(`dex ${dexAddr}\npair ${pair}`);

  const baseIn = ethers.parseEther('20');
  const quoteIn = 2_000_000n;

  await (await base.mint(deployer.address, baseIn)).wait();
  await (await quote.mint(deployer.address, quoteIn)).wait();
  console.log('balances', await base.balanceOf(deployer.address), await quote.balanceOf(deployer.address));

  await (await base.approve(dexAddr, baseIn)).wait();
  await (await quote.approve(dexAddr, quoteIn)).wait();
  console.log('allowances', await base.allowance(deployer.address, dexAddr), await quote.allowance(deployer.address, dexAddr));

  try {
    const out = await dex.addLiquidity.staticCall(base.target, quote.target, baseIn, quoteIn, deployer.address);
    console.log('staticCall ok, liquidity', out.toString());
  } catch (error: any) {
    console.log('staticCall REVERTED');
    console.log('  shortMessage:', error.shortMessage);
    console.log('  reason:', error.reason);
    console.log('  data:', error.data ?? error.info?.error?.data);
    try {
      const pairC = new ethers.Contract(pair, ['function token0() view returns (address)', 'function token1() view returns (address)'], deployer);
      console.log('  token0', await pairC.token0(), 'token1', await pairC.token1());
    } catch {}
    return;
  }

  const tx = await dex.addLiquidity(base.target, quote.target, baseIn, quoteIn, deployer.address);
  const receipt = await tx.wait();
  console.log('addLiquidity mined', receipt!.hash, 'gas', receipt!.gasUsed.toString());

  const pairC = new ethers.Contract(pair, [
    'function getReserves() view returns (uint112,uint112,uint32)',
    'function token0() view returns (address)',
  ], deployer);
  const [r0, r1] = await pairC.getReserves();
  console.log(`reserves ${r0} / ${r1} | token0 ${await pairC.token0()}`);
}

main().catch((e) => {
  console.error('FAILED', e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
