import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const envPath = join(process.cwd(), '.env');

if (existsSync(envPath)) {
  const current = readFileSync(envPath, 'utf8');
  const match = current.match(/^DEPLOYER_PRIVATE_KEY=(.+)$/m);
  if (match) {
    const account = privateKeyToAccount(match[1].trim() as `0x${string}`);
    console.log('existing deployer:', account.address);
    process.exit(0);
  }
}

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
writeFileSync(envPath, `DEPLOYER_PRIVATE_KEY=${pk}\nOWNER_PRIVATE_KEY=${pk}\n`);
console.log('created .env');
console.log('deployer:', account.address);
