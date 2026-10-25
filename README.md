# Envelope

**A trading agent that cannot break its mandate.**

Envelope is an autonomous trading agent on HSK Chain whose every order must satisfy a signed, on-chain risk mandate, and whose every decision is written to a hash-chained public ledger. The agent can reason freely. It cannot widen its own limits, and it cannot quietly forget a loss.

Built for the HashKey Chain Horizon Hackathon, Mumbai edition, Track 1: AI Agent Trading.

---

## The problem

Every "AI trading agent" shipping today enforces risk in one of two places: a database owned by the operator, or a sentence in a prompt. Both are unverifiable. When the agent loses money, there is no artifact that proves what it knew, what it intended, and what it was allowed to do. The operator's risk limits are a promise, not a constraint.

Envelope moves the limits into a contract and the reasoning into a ledger.

## The three primitives

| Primitive | Contract | What it guarantees |
|---|---|---|
| **Mandate** | `RiskEnvelope.sol` | The owner signs an EIP-712 risk envelope. The executor contract checks it against live pool reserves and live balances before every swap. A breach is a reverted transaction. |
| **Desk** | `EnvelopeTrader.sol` | The only address that can move funds. It authorises, swaps, re-baselines equity, then anchors the decision, all in one transaction. |
| **Ledger** | `TradeLedger.sol` | Append-only hash chain. `newHead = keccak256(prev ‖ decision ‖ outcome ‖ ts ‖ seq)`. Fills, refusals and losses are all in it. |

## Enforced limits

Checked on-chain, per order, against live state:

- target pair, and therefore the target asset (changing it needs a new signature)
- maximum notional per trade
- maximum position as a share of equity
- maximum daily loss, measured against the day's opening equity
- maximum trades per hour
- per-trade slippage band, computed from pool reserves in exact integer maths
- hard expiry
- one authorised executor address, and a strictly increasing nonce so an old mandate cannot be replayed

Each violation is a named custom error with arguments, so the UI can say `NotionalExceeded(600000, 150000)` instead of "transaction failed".

## How a decision becomes evidence

```
agent                envelope            router / pool           ledger
  │  snapshot pool        │                     │                   │
  │  ask the model        │                     │                   │
  │  hash the preimage ──►│                     │                   │
  │                       │ consume(): reverts on breach             │
  │                       │────────────────────►│ swap              │
  │                       │ settle(): re-baseline equity            │
  │                       │                     │        anchor() ──►│
```

The decision hash is written on-chain before the first external swap call, inside the same transaction. That ordering is what makes the record tamper-evident: a decision cannot be back-filled after its outcome is known.

The preimage (market snapshot, model, thesis, confidence, sizes, reasoning hash) lives in `agent/data/records.jsonl`. Any third party can recompute `keccak256` of the canonical JSON and compare it to the on-chain value. `GET /api/verify` does exactly that, walking the whole chain and recomputing every link.

## Layout

```
contracts/   Hardhat + Solidity: RiskEnvelope, EnvelopeTrader, TradeLedger
             tests run against a fork of HSK mainnet and the real HSKSwap contracts
agent/       Node + TypeScript: market snapshot, Particle inference, signing, execution
web/         Vite + React + TypeScript: the desk
scripts/     demo.sh, wallet generator, introspection
```

## Run it

```bash
cp .env.example .env      # add PARTICLE_API_KEY, then: pnpm wallet
pnpm install
bash scripts/demo.sh      # chain + deploy + agent + desk
```

Desk on `http://localhost:5199`, agent API on `http://127.0.0.1:8788`.

Three things to try:

1. **Run one cycle.** The agent reads the pool, asks the model, sizes an order, submits it, anchors the receipt.
2. **Ask for 4× the mandate.** A real oversized order is submitted. The chain rejects it with `NotionalExceeded`.
3. **Type a change.** "be more aggressive, 8 trades an hour." The model proposes a mandate patch; signing it is a separate, explicit act.

## Contracts

Local demo deployment (fresh chain each run, so addresses change):

```
Envelope  0x12f267D0440770A0833FEd823153f1A26F55EDd6
Trader    0xf170E508c9Eb9B3862a595b5ffE3c85E62B0D877
Ledger    0x3B3665a5467059f5A9F3948efE328FaD936C357a
Pool      0xF176c4643bE02aFb454F87690496B1749FcdDbAA
```

Mainnet deployment uses `contracts/scripts/deploy.ts` against the real HSKSwap router `0x569a9C081F8Eb11215B86723976C4b404DfF4439` and factory `0x75e5da970b546e214650ae2d3b6e7918db344119` (chain 177), and writes `contracts/deployments/hsk.json`.

## Tests

```bash
pnpm --filter @envelope/contracts test
```

Twelve tests run against a forked snapshot of HSK Chain mainnet, seeding a pair through the live HSKSwap factory and router, then proving each limit: wrong-key signature, position ceiling, notional ceiling, rate limit, expiry, non-executor, slippage band, nonce replay, and a full ledger walk that recomputes every link back to the zero hash.

## Honest limitations

- **The venue is thin.** HSKSwap's live factory holds three pairs, and the only funded one holds about one cent of liquidity. A taker agent has nothing to trade, so the demo deploys its own pool and seeds it. On mainnet the same contracts point at the real HSKSwap router; the pool is seeded from the deployer wallet.
- **Flow is synthetic in the demo.** `NOISE_TRADER=true` makes small real swaps so the pool actually moves and the agent has something to react to. Every record that came from it is still a real on-chain action.
- **The owner key is server-side in this build** so the demo can sign without a wallet popup. In production the mandate signature moves to `eip1193` and the key never leaves the wallet; the contract already supports it.
- **HSP is not used here.** This is a Track 1 submission. The mandate object is deliberately shaped so the same envelope can be expressed as an HSP mandate if the desk is extended to Track 2.
- **The pool price is the reference.** There is no external oracle in the demo loop, because the venue's own reserves are the only price the trader can actually transact at. A Supra feed is wired as an optional cross-check.

## License

MIT.

---

Built By Harish Kotra — [harishkotra.me](https://harishkotra.me)

Checkout my other builds — [dailybuild.xyz](https://dailybuild.xyz)
