#!/usr/bin/env bash
# Check every explorer link in the docs against the indexer's own API.
# A 200 on the HTML page is not enough (blockscout serves the SPA shell for unknown hashes),
# so this asserts the address or transaction is actually indexed.
set -uo pipefail

fail=0
checked=0

check_address() {
  local host="$1" addr="$2"
  checked=$((checked + 1))
  body=$(curl -s -m 25 "$host/api/v2/addresses/$addr")
  if echo "$body" | grep -qi "$addr"; then
    echo "  ok    address $addr"
  else
    echo "  FAIL  address $addr  (not indexed at $host)"; fail=1
  fi
}

check_tx() {
  local host="$1" hash="$2"
  checked=$((checked + 1))
  body=$(curl -s -m 25 "$host/api/v2/transactions/$hash")
  if echo "$body" | grep -qi "$hash"; then
    status=$(echo "$body" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('status'))" 2>/dev/null)
    echo "  ok    tx $hash  status=$status"
  else
    echo "  FAIL  tx $hash  (not indexed at $host)"; fail=1
  fi
}

# links straight out of the README and the demo sheet
links=$(grep -rEoh 'https://testnet-explorer\.[a-z.]+/(address|tx)/0x[a-fA-F0-9]{40,64}' README.md DEMO.md 2>/dev/null | sort -u)

if [ -z "$links" ]; then
  echo "no explorer links found"; exit 1
fi

total=$(printf '%s\n' "$links" | grep -c .)
echo "checking $total explorer links"
while IFS= read -r url; do
  [ -z "$url" ] && continue
  host=$(echo "$url" | cut -d/ -f1-3)
  kind=$(echo "$url" | cut -d/ -f4)
  id=$(echo "$url" | cut -d/ -f5)
  case "$kind" in
    address) check_address "$host" "$id" ;;
    tx)      check_tx "$host" "$id" ;;
  esac
done < <(printf '%s\n' "$links")

echo
echo "checked $checked links, failures: $fail"
exit $fail
