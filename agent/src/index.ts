import { boot, startLoop } from './server.js';
import { CONFIG, DEPLOYMENT } from './config.js';

console.log(`[envelope] boot network=${CONFIG.network} chainId=${CONFIG.chainId} rpc=${CONFIG.rpcUrl}`);
console.log(`[envelope] pair=${DEPLOYMENT.pair} ${DEPLOYMENT.baseSymbol}/${DEPLOYMENT.quoteSymbol}`);

boot();

if (CONFIG.loop.autoStart) {
  startLoop();
  console.log(`[envelope] loop every ${CONFIG.loop.intervalMs} ms`);
}
