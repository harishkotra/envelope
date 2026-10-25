import { nudge } from '../src/noise.js';
try {
  const out = await nudge();
  console.log('nudge ok', out);
} catch (e: any) {
  console.log('nudge FAILED');
  console.log(' short:', e.shortMessage);
  console.log(' details:', String(e.details ?? '').slice(0, 200));
  console.log(' data:', typeof e.data === 'string' ? e.data : JSON.stringify(e.cause?.data));
}
