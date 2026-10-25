import { config as loadEnv } from 'dotenv';
import { privateKeyToAccount } from 'viem/accounts';

loadEnv({ path: new URL('../../.env', import.meta.url).pathname });

const API = process.env.AGENT_API ?? 'http://127.0.0.1:8788';

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<any>;
};

/**
 * Mirrors exactly what the desk UI does with a browser wallet:
 * prepare typed data, sign it with the owner key, hand the signature back to be relayed.
 */
const main = async () => {
  const key = process.env.OWNER_PRIVATE_KEY as `0x${string}`;
  if (!key) throw new Error('OWNER_PRIVATE_KEY missing');
  const account = privateKeyToAccount(key);

  const prepared = await post('/api/mandate/prepare', {
    patch: { maxPositionBps: 3500, maxTradesPerHour: 8, days: 10 },
  });
  if (prepared.error) throw new Error(JSON.stringify(prepared.error));

  console.log('owner of record', prepared.owner);
  console.log('signer        ', account.address);
  console.log('domain        ', JSON.stringify(prepared.typedData.domain));
  console.log('nonce         ', prepared.typedData.message.nonce);

  const message = { ...prepared.typedData.message };
  for (const field of ['maxNotionalQuote', 'expiry', 'nonce']) {
    (message as any)[field] = BigInt((message as any)[field]);
  }

  const signature = await account.signTypedData({
    domain: prepared.typedData.domain,
    types: prepared.typedData.types,
    primaryType: 'Mandate',
    message,
  });
  console.log('signature     ', signature.slice(0, 22) + '…');

  const submitted = await post('/api/mandate/submit', { mandate: prepared.mandate, signature });
  if (submitted.error) throw new Error(JSON.stringify(submitted.error));

  console.log('installed nonce', submitted.mandate.nonce, 'tx', submitted.txHash);
};

main().catch((error) => {
  console.error('FAILED', error.message ?? error);
  process.exitCode = 1;
});
