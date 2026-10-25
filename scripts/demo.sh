#!/usr/bin/env bash
# Envelope — one command demo.
# Boots a local HSK-style chain, deploys the protocol, starts the agent and the desk UI.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

NODE_PID=""; AGENT_PID=""; WEB_PID=""
cleanup() {
  echo ""
  echo "shutting down…"
  [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null || true
  [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null || true
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ ! -f "$ROOT/.env" ]; then
  echo "missing .env. Copy .env.example to .env and add your Particle key."
  exit 1
fi

echo "[1/4] clearing old processes"
pkill -f "hardhat node" 2>/dev/null || true
pkill -f "tsx src/index.ts" 2>/dev/null || true
pkill -f "vite.js --port 5199" 2>/dev/null || true
sleep 1

echo "[2/4] chain"
( cd "$ROOT/contracts" && HSK_FORK=off npx hardhat node > /tmp/envelope-chain.log 2>&1 ) &
NODE_PID=$!
for i in $(seq 1 40); do
  if curl -s -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    http://127.0.0.1:8545 > /dev/null 2>&1; then break; fi
  sleep 1
done

echo "[3/4] deploy"
( cd "$ROOT/contracts" && npx hardhat run scripts/deploy-local.ts --network fork 2>&1 | tail -6 )

echo "[4/4] agent + desk"
( cd "$ROOT/agent" && AUTO_START=true npx tsx src/index.ts > /tmp/envelope-agent.log 2>&1 ) &
AGENT_PID=$!
( cd "$ROOT/web" && node ./node_modules/vite/bin/vite.js --port 5199 > /tmp/envelope-web.log 2>&1 ) &
WEB_PID=$!

sleep 6
echo ""
echo "  desk   http://localhost:5199"
echo "  api    http://127.0.0.1:8788/api/state"
echo "  logs   /tmp/envelope-agent.log  /tmp/envelope-web.log  /tmp/envelope-chain.log"
echo ""
echo "press ctrl-c to stop"
wait
