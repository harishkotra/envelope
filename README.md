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
bash scripts/demo.sh      # local chain + deploy + agent + desk
```

Desk on `http://localhost:5199`, agent API on `http://127.0.0.1:8788`.

To run against the live testnet instead of a local chain, set `NETWORK=testnet`, `CHAIN_ID=133`, `RPC_URL=https://testnet.hsk.xyz` in `.env` and start the agent and desk without the local chain step.

Three things to try:

1. **Run one cycle.** The agent reads the pool, asks the model, sizes an order, submits it, anchors the receipt.
2. **Ask for 4× the mandate.** A real oversized order is submitted. The chain rejects it with `NotionalExceeded`.
3. **Type a change.** "be more aggressive, 8 trades an hour." The model proposes a mandate patch; signing it is a separate, explicit act.

## Deployments

**HSK Chain testnet (chainId 133)** — live, all addresses on chain.

```
Envelope  0x7b67AAd8eB08eF74EFe101325600B16dc5f95FFa
Trader    0xECf9c42e8beFB1b9508B9430D536BB369F7F9246
Ledger    0xD41eF582Cf592D7B67803864c271519fCbF620ac
Pool      0xA92D72d226cb655C1D25bDf2690d5E3D9Be26da6   (WHSK/dUSD)
Venue     0x048475cf2731ff2c032c7938d3e358eeeb6cc4a4
```

Explorer: `https://testnet-explorer.hsk.xyz/address/<address>`

The testnet has no HSKSwap deployment and no WHSK, so `scripts/deploy-testnet.ts` ships a self-contained venue (MiniDEX) and two test tokens, then the protocol on top. Every migration detail is the same as mainnet: the trader talks to a router, the envelope reads pair reserves.

**HSK Chain mainnet (chainId 177)** — `contracts/scripts/deploy.ts` points at the real HSKSwap router `0x569a9C081F8Eb11215B86723976C4b404DfF4439` and factory `0x75e5da970b546e214650ae2d3b6e7918db344119`. Run with `DRY_RUN=1` first to validate config, then for real. Mainnet gas is ~0.02 gwei, so a full deploy costs about 0.00014 HSK.

## Wallet ownership

The envelope owner is whoever can install a mandate. To hand it to a human wallet:

```bash
HANDOFF_TO=0xYourWallet pnpm --filter @envelope/contracts handoff
```

After that the deployer and the agent key are locked out, and the desk's **Connect wallet** button signs mandates with `eth_signTypedData_v4` through `setMandate`, which accepts any relayer as long as the owner's signature checks out. The agent keeps the ability to propose a mandate and loses the ability to grant one.

## Quirks of the HSK testnet RPC

Discovered while deploying, and worked around in code so the demo does not depend on them:

- **Reads lag writes by a few blocks.** A `view` call straight after a transaction can return pre-transaction state. The deploy script takes the pair address from the `PairCreated` event rather than reading it back, and polls for mandate activation.
- **`eth_estimateGas` under-reports for deploys and for calls that deploy a contract** (`createPair` was estimated at 23k gas). Every transaction sets an explicit gas ceiling.
- **Type-2 transactions are rejected** with "replacement transaction underpriced" even with a clean nonce. All writes use a legacy `gasPrice` of 2 gwei.

## Contracts (local demo)

The local demo deploys a fresh chain each run, so addresses change:

```
Envelope  0x12f267D0440770A0833FEd823153f1A26F55EDd6
Trader    0xf170E508c9Eb9B3862a595b5ffE3c85E62B0D877
Ledger    0x3B3665a5467059f5A9F3948efE328FaD936C357a
Pool      0xF176c4643bE02aFb454F87690496B1749FcdDbAA
```

## Tests

```bash
pnpm --filter @envelope/contracts test
```

Thirteen tests run against a forked snapshot of HSK Chain mainnet, seeding a pair through the live HSKSwap factory and router, then proving each limit: wrong-key signature, position ceiling, notional ceiling, rate limit, expiry, non-executor, slippage band, nonce replay, ownership handoff, and a full ledger walk that recomputes every link back to the zero hash.

## Honest limitations

- **The venue is thin.** HSKSwap's live factory holds three pairs, and the only funded one holds about one cent of liquidity. A taker agent has nothing to trade, so the demo deploys its own pool and seeds it. On mainnet the same contracts point at the real HSKSwap router; the pool is seeded from the deployer wallet.
- **Mainnet deployment is not done yet.** The testnet deployment is live and complete. The mainnet run needs a funded deployer and is a single command, but it has not been executed, so do not claim it has.
- **Flow is synthetic in the demo.** `NOISE_TRADER=true` makes small real swaps so the pool actually moves and the agent has something to react to. Every record that came from it is still a real on-chain action.
- **The owner key is server-side in this build** so the demo can sign without a wallet popup. In production the mandate signature moves to `eip1193` and the key never leaves the wallet; the contract already supports it.
- **HSP is not used here.** This is a Track 1 submission. The mandate object is deliberately shaped so the same envelope can be expressed as an HSP mandate if the desk is extended to Track 2.
- **The pool price is the reference.** There is no external oracle in the demo loop, because the venue's own reserves are the only price the trader can actually transact at. A Supra feed is wired as an optional cross-check.

## License

MIT.

---

Built By Harish Kotra — [harishkotra.me](https://harishkotra.me)

Checkout my other builds — [dailybuild.xyz](https://dailybuild.xyz)
