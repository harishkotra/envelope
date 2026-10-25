#!/usr/bin/env bash
# Verify Envelope's proof-of-work claims straight from the chain, without an explorer.
# Usage: bash scripts/verify-proof.sh [rpc-url]
set -euo pipefail

RPC="${1:-https://testnet.hsk.xyz}"

rpc() {
  curl -s -m 25 -X POST -H 'content-type: application/json' --data "$1" "$RPC"
}

call() {
  # call <to> <data>
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$1\",\"data\":\"$2\"},\"latest\"]}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('result','0x'))"
}

echo "rpc: $RPC"
echo -n "chain id: "
rpc '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | python3 -c "import sys,json;print(int(json.load(sys.stdin)['result'],16))"
echo

ENVELOPE=0x7b67AAd8eB08eF74EFe101325600B16dc5f95FFa
LEDGER=0xD41eF582Cf592D7B67803864c271519fCbF620ac
TRADER=0xECf9c42e8beFB1b9508B9430D536BB369F7F9246

echo "== deployed code =="
for pair in "Envelope $ENVELOPE" "Ledger $LEDGER" "Trader $TRADER"; do
  name=${pair%% *}; addr=${pair##* }
  size=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getCode\",\"params\":[\"$addr\",\"latest\"]}" \
    | python3 -c "import sys,json;c=json.load(sys.stdin)['result'];print((len(c)-2)//2)")
  echo "  $name $addr bytes=$size"
done
echo

echo "== ledger state =="
count_hex=$(call "$LEDGER" 0x06661abd)          # count()
head=$(call "$LEDGER" 0x8f7dcfa3)               # head()
owner=$(call "$ENVELOPE" 0x8da5cb5b)            # owner()
python3 - "$count_hex" "$head" "$owner" <<'PY'
import sys
count = int(sys.argv[1], 16) if sys.argv[1] != '0x' else 0
print(f"  links anchored: {count}")
print(f"  head: {sys.argv[2]}")
print(f"  envelope owner: 0x{sys.argv[3][-40:]}")
PY
echo

echo "== transactions =="
check() {
  label="$1"; hash="$2"
  out=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$hash\"]}" \
    | python3 -c "
import sys,json
r=json.load(sys.stdin).get('result')
if not r: print('missing'); raise SystemExit
print(('success' if r['status']=='0x1' else 'REVERTED'), 'block', int(r['blockNumber'],16), 'gas', int(r['gasUsed'],16))
")
  printf "  %-34s %s  %s\n" "$label" "$out" "${hash:0:18}…"
}
check "protocol deploy"   0x2b768c3866afd4fe998f90a358db8a77bd573abdfb63792f9075c62deab82874
check "venue + pair"      0xd1a9627d287a9fd43d001617031f53a1e106cc561f5999c6ad5b7e6a163a6a41
check "mandate v1"        0x1ec17966688df7e427ecdcfd9b9b7b345765e743506e536114900966277e583b
check "mandate v2"        0xb4155d3328e7fa977275337d05c192285eb119726e2c4e4afe52185dd435c573
check "allowed trade"     0x64b843c399818856419f6f3e06fda2534d4b15b4dc11c647ab4dbd2e2b39f7a9
check "order the chain refused" 0x17537070a513d5dd38c29eedc031470c3226914906ee194e8a3d7b40ed478712
echo
echo "A REVERTED line is the point: the agent sent the order and the envelope refused it."
