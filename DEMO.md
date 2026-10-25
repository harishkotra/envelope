# Demo run sheet

Demo Day: Nov 4, Mumbai. 20 finalists, roughly 12 minutes per team including handover, so target a 5 minute pitch plus Q&A. Three judges in the room, two on a remote feed. Everything below is readable on a projector at 1080p.

## Before you walk on

- [ ] `bash scripts/demo.sh` is running, desk loaded, and at least 8 records in the feed.
- [ ] Browser zoom at 100 percent, window at 1600x1000 or larger.
- [ ] The feed shows at least one `FILLED`, one `REFUSED`, and one `REVERTED`.
- [ ] Hard refresh the page once so the sparkline has history.
- [ ] Backup: a screen recording of the exact run, in case the venue wifi dies.
- [ ] MetaMask installed and switched to the chain the desk is on, so the ownership beat works live.
- [ ] Testnet contracts open in another tab: `https://testnet-explorer.hskchain.net/address/0x7b67AAd8eB08eF74EFe101325600B16dc5f95FFa`
- [ ] Mainnet deployment link ready too: a mainnet contract is required to be eligible for demo selection.

## The five minutes

**0:00 Problem (45s)**

"Every AI trading agent today enforces risk in a database or in a prompt. Both are unverifiable. When the agent loses money you cannot prove what it knew or what it was allowed to do. Envelope moves the limits into a contract and the reasoning into a ledger."

**0:45 The mandate (60s)**

Point at the risk envelope card. "The owner signs an EIP-712 mandate. Position cap, daily loss cap, per-trade ceiling, slippage band, rate limit, expiry. Not settings in a dashboard. Arguments in a contract that the trading desk must satisfy before it can move a single token."

**1:45 Live proof: it holds (90s)**

Click **Ask for 4× the mandate**. While it sends: "This is a real order, four times the per-trade ceiling. Nothing here is prevented by the interface."

When the red receipt appears with `NotionalExceeded(600000, 150000)`: "The chain rejected it. The agent cannot talk its way past this, and I cannot either."

**3:15 The record (60s)**

Click a `FILLED` row. "Every decision is hashed before the swap, inside the same transaction, then anchored to a hash chain. Here is the decision, the model's reasoning, the exact market snapshot it saw, and the transaction."

Click **show model reasoning**. "Including the ones that lost. This is a track record you can audit instead of a screenshot."

Then point at Proof of edge: "Both heads match. A broken link means someone reordered or back-filled the record."

**4:15 Control (30s)**

Type into the console: "eight trades an hour, but keep the position cap." Click **Interpret**, then **Sign in wallet and install** so MetaMask asks the room for a signature.

"The agent can propose a new envelope. It cannot grant one. Only a signature does that, and the nonce moves, so the old mandate dies. In this build the wallet is the owner, so my key, not the agent's, is the only thing that can move these limits."

**4:45 Close (15s)**

"The next thing this needs is more mouths to feed: HSP settlement on the same envelope, so a trading agent pays for its own data and compute under the same signed limits. That is the bridge to Track 2."

## If someone asks

- **"Is this real money?"** "Real contracts, real swaps, seeded pool. The venue has one funded pair with about a cent in it, which is why we seeded our own. The limits do not care whose liquidity it is."
- **"Why not just use a stop loss?"** "A stop loss is a rule the bot can skip. This is a precondition the transaction cannot skip."
- **"What stops the model from being wrong?"** "Nothing. It will be wrong. The point is that being wrong is bounded, and that every wrong decision is in the record with the reasoning attached."
- **"Who signs in production?"** "The user's wallet, via eip1193. The contract already supports it; the demo signs server-side to save a click."
- **"What is the business?"** "Risk-managed agent capital. Desks, funds and eventually retail users who will not hand a prompt their keys."

## Failure drills

- **Chain dies:** the receipt panel and the ledger still render from `agent/data/records.jsonl`; the on-chain proof card will show unverified. Say so plainly and switch to the recording.
- **Model is slow:** the agent falls back to a deterministic policy and every record is marked `model_unavailable`. That is a feature, not a crash: say the fallback is labelled.
- **A tick reverts unexpectedly:** it appears as `REVERTED` in the feed. Open it and read the error. A visible refusal is a better demo than a silent success.
