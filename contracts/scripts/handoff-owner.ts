import { ethers } from 'hardhat';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Hand envelope ownership to a human wallet (MetaMask, Rabby, anything EIP-1193).
 *
 *   HANDOFF_TO=0xYourWallet npx hardhat run scripts/handoff-owner.ts --network hsktest
 *
 * After this the deployer and the agent key can no longer install a mandate.
 * The new owner signs mandates from the desk UI.
 */
async function main() {
  const to = process.env.HANDOFF_TO?.trim();
  if (!to || !ethers.isAddress(to)) throw new Error('HANDOFF_TO must be a valid address');

  const network = process.env.NETWORK ?? 'testnet';
  const file = join(__dirname, `../deployments/${network}.json`);
  const deployment = JSON.parse(readFileSync(file, 'utf8'));

  const [deployer] = await ethers.getSigners();
  const envelope = await ethers.getContractAt('RiskEnvelope', deployment.envelope);

  const current = await envelope.owner();
  console.log(`network ${network} envelope ${deployment.envelope}`);
  console.log(`current owner ${current} | signer ${deployer.address}`);

  if (current.toLowerCase() === to.toLowerCase()) {
    console.log('already handed off');
    return;
  }
  if (current.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error('signer is not the current owner; use the wallet that owns it');
  }

  const tx = await envelope.transferOwnership(to);
  const receipt = await tx.wait();
  console.log(`ownership transferred to ${to} in ${receipt!.hash}`);
  console.log('the envelope is now inactive: sign a fresh mandate from that wallet in the desk UI');
}

main().catch((error) => {
  console.error(error.shortMessage ?? error.message ?? error);
  process.exitCode = 1;
});
