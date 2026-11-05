# Survivor Engine — Design

An automated creator-fee mechanism for a future pump.fun token. The token
itself is a plain SPL / Token-2022 mint — it cannot carry logic — so every
rule below is executed by an off-chain engine whose only fuel is the token's
creator-fee stream. All rules are public, all outputs are published, and
every number on the public page can be recomputed from chain data.

**Status: v0.1, simulation-first.** The code in `tools/survivor/` reads chain
state and produces round reports, payout plans and a public page. It
contains **no signing, key-handling or broadcasting code at all** — live
execution is a separate future module (the go-live checklist lives in
the launch runbook; §6 covers the wallet the live module will use).

---

## 1. The mechanism in one paragraph

Every round (default 10 minutes) the engine claims the creator fees that
accrued since the last round and splits them three ways: **50% buyback &
burn** (deflation), **30% to "survivors"** — holders who hold at least the
minimum value and have not sold anything for 48 hours — weighted by
**√balance** (concave: a 4× bigger bag earns only 2× the share), and **20%
to a progressive jackpot** that is periodically drawn among survivors
weighted by **√balance × streak**, where a streak is the number of
consecutive rounds survived. Selling anything resets the streak to zero.
One offensive move exists: a survivor who *buys* at least $5 more during
a round gets a ×1.5 weight for that round (the Buy Boost, §3.6) — the
engine's only "attack" button, complementing the defensive streak game.
The design pays for one behavior — *not selling* — and turns it into a
public, escalating status game: burn counter, jackpot size, streak
leaderboard, winner announcements.

Why this shape (vs. the CALL pattern of paying holders to post callouts):
CALL pays for shouting; this pays for holding through volatility. It needs
no callout scraping — eligibility is decidable from chain data alone — and
the streak creates a sunk-cost identity ("I'm on day 9") that a flat
pro-rata drip does not.

---

## 2. Round lifecycle

1. **Measure the pot.** Live mode: trigger the permissionless fee
   collect/distribute so newly accrued fees land in the engine wallet; the
   pot is the amount that arrived since the last round. Simulation mode:
   the pot is `--pot`, a fixture value, or the current unclaimed balance
   measured read-only via the feelock toolkit (`measureFees`).
   - Fees accrue **per creator**, not per token (one shared creator vault
     for every token of that creator, plus a separate PumpSwap vault after
     graduation). The engine therefore assumes the creator wallet runs
     **one** mechanism token at a time (see also §8).
2. **Snapshot holders.** All token accounts for the mint across **both**
   token programs (pump.fun `create_v2` tokens are Token-2022 — verified
   live on LSCAN V2), merged per owner. Infrastructure is excluded and
   reported separately: bonding-curve account, canonical PumpSwap pool,
   burn/incinerator address, the pump/PumpSwap programs, the mint account,
   the creator (rule), the engine wallet, plus a config exclusion list.
   The round report includes a SHA-256 snapshot hash of
   `owner:balanceRaw` lines so anyone can verify the input set.
3. **Derive sell history.** Outbound movements since the last round (see
   §3.2) update each wallet's `last_sell_at`. Swap buys inside the round
   window are derived at the same time, from the same sources plus the
   on-chain vault-delta test, for the Buy Boost (§3.6).
4. **Determine survivors & streaks** (§3.1, §3.3).
5. **Split the pot** 50/30/20 with integer lamport math (largest-remainder;
   the three parts always sum exactly to the pot).
6. **Survivor distribution.** √balance weights (× `boostMultiplier` for
   boosted survivors, §3.6) → lamport shares (largest remainder, exact
   sum) → dust rule (§3.4) → payout plan batched at ≤ 18 recipients per
   transaction (CALL pattern).
7. **Buyback.** The burn slice is quoted via Jupiter (quote only in sim).
   Measured 2026-11-05: Jupiter *does* route the LSCAN V2 bonding curve
   (0.006788347 SOL → 239,745.396 tokens quoted, ~1.11% price impact), so
   a live buyback can execute through Jupiter or directly against the
   curve/PumpSwap pool. Bought tokens go to the incinerator address.
8. **Jackpot.** Accrue the 20% slice (plus any rollover, §3.5); draw when
   due (§3.5) using the latest finalized blockhash as public randomness.
9. **Publish.** Round report (JSON + Markdown) with the full payout list,
   the buyback quote, the draw record and the snapshot hash; the static
   public page is regenerated.

---

## 3. Rules

### 3.1 Survivor eligibility (evaluated at round close)
A wallet is a survivor for a round iff **all** hold:
- it holds the token (balance > 0) in the snapshot;
- the USD value of its balance is **≥ `minHoldUsd`** (default **$20** — the
  same floor pump.fun's native Holder Rewards and CALL use, so the number
  is already familiar to the market);
- it has **no outbound token movement** with timestamp in the trailing
  **`sellWindowHours`** (default **48 h**);
- it is not an excluded infrastructure/creator/engine address (§2, step 2).

### 3.2 What counts as a "sell"
**Any outbound movement of the token from the wallet** — a market sell, a
transfer to another wallet, a transfer to an exchange. This is deliberate:
it is decidable from balance deltas alone, and it closes the obvious game
of "holding" via a fresh wallet while the old wallet trades. Moving your
bag to a new wallet restarts you as a new wallet (new `first_seen`, streak
0, and you must re-clear the 48 h window from the receiving side's
perspective only if it also sold — receiving is not outbound, so the new
wallet can qualify after 48 h of *its own* stillness once it holds ≥ the
minimum; the old wallet's streak is gone either way).

Sources used to derive outbound events, in order: solbot collector swap
logs (a smart-money *sample* — coverage is partial), solbot per-wallet
tracked logs, and an on-chain fallback that scans each holder's token
account signatures (newest first, capped per round) and compares pre/post
token balances. Scan truncation is flagged per wallet in the round report,
never silently treated as "no sells". See §9 for coverage limits.

### 3.3 Streaks
- `streak(wallet)` = number of **consecutive rounds** in which the wallet
  was a survivor at round close.
- Any round in which the wallet is not a survivor — sold something, fell
  below the minimum, emptied the bag — resets the streak to **0**.
- Streaks are the jackpot weight multiplier and the public leaderboard's
  ranking key. They are identity, not just math: "day 9 survivor" is the
  story the mechanism sells.

### 3.4 Splits, dust, batches
- Split (basis points, configurable, must sum to 10 000):
  **burn 5000 · survivors 3000 · jackpot 2000**.
- Survivor shares are proportional to **√(balance in tokens)**, times the
  Buy Boost multiplier when the survivor swap-bought this round (§3.6).
- **Dust rule (CALL pattern):** a wallet is paid only when
  `share + carried_dust ≥ 0.0001 SOL` (`dustThresholdLamports = 100_000`);
  otherwise the share accumulates as carried dust in state. Dust is never
  forfeited.
- Payouts are planned in batches of **≤ 18 recipients per transaction**,
  largest first.

### 3.5 Jackpot
- The pool accrues 20% of every pot, plus rollovers (§3.7).
- A draw happens when **either** `jackpotEveryRounds` (default **144** =
  ~24 h at 10-minute rounds) rounds have passed since the last draw,
  **or** the pool reaches `jackpotTriggerLamports` (default **1 SOL**).
- Eligible: that round's survivors. Weight = **√(balance) × streak ×
  boost multiplier** (§3.6)
  (streak after this round's increment, so ≥ 1 for every survivor).
- Winner selection: `r = SHA-256(blockhash || ":" || round) mod
  total_weight`, walking cumulative weights. One winner takes the pool.
  The round report publishes the slot, blockhash, every entrant's weight
  and the snapshot hash, so **anyone can recompute the winner**.
- Randomness note: a finalized blockhash is public and unpredictable at
  snapshot time but is not a VRF; at jackpot sizes this mechanism targets
  (≤ a few SOL) the manipulation incentive is negligible. If pools grow
  large, swap in a VRF (e.g. Switchboard) — the pick function is isolated
  in `math.mjs` for exactly that reason.

### 3.6 Buy Boost — the attack move
Survival is defensive: you win by not selling. The Buy Boost is the one
offensive action the engine rewards.

- A **survivor** whose detected swap buys inside the current round
  window total **≥ `boostMinBuyUsd`** (default **$5**) gets **weight ×
  `boostMultiplier`** (default **1.5**) for **that round only** — in
  both the survivor distribution (§3.4) and the jackpot draw (§3.5).
- The boost is recomputed from scratch every round, from that round's
  buys, and is **never stored in state**. No fresh buy next round, no
  boost — it cannot be banked, carried or stacked across rounds.
- **What counts as a buy:** an actual swap buy. Log sources contribute
  `side: "buy"` swap rows; the on-chain fallback counts a balance
  increase only when the same transaction also **drained the
  bonding-curve / PumpSwap pool vault** (tokens left the vault as the
  wallet's balance rose — the sell side of a swap). Buys routed through
  aggregators still settle against the pool vault, so they are caught.
  All sources are deduplicated by transaction signature, so a swap seen
  twice counts once.
- **A plain transfer-in never counts.** Receiving tokens from another
  wallet leaves no vault trace, so shuffling a bag between your own
  wallets cannot farm the boost — and the sending side independently
  eats an outbound movement, which resets its streak and benches it
  for 48 h (§3.2). Farming the boost with wash transfers is strictly
  losing.
- **Buying never resets a streak** (only outbound movements do), and
  topping up is also how a survivor defends the $20 floor when the
  price dips. But **buy-then-sell inside the same round disqualifies
  as usual**: the sell is an outbound movement, the wallet is not a
  survivor that round, and the boost — which only ever applies to
  survivors — is void.
- **Valuation & coverage:** log rows carry their own USD value;
  on-chain buys are valued as tokens received × the round-close price.
  Coverage mirrors sell detection (§3.2) — collector logs are a
  smart-money sample, per-wallet logs cover tracked wallets, the
  on-chain scan is authoritative but capped per wallet, with
  truncation flagged in the round report. One extra limit: the
  on-chain vault test only sees the canonical pump/PumpSwap vaults,
  so post-graduation buys routed through other DEXs can be missed by
  that source.
- The round report carries a full Buy Boost audit section: the window,
  every boosted wallet with its `boughtUsd`, every detected buy, and
  the coverage record.

### 3.7 Rollovers and edge cases
- **No survivors in a round:** the 30% survivor slice rolls into the
  jackpot (it is not burned and never goes to the team). The burn and
  jackpot slices proceed normally.
- **Draw due but no survivors:** the draw is skipped and the pool carries.
- **Pot is zero:** the round still runs (snapshot, streaks, report) with
  zero splits; streaks are evaluated as usual — surviving a dead round
  still counts, which is the point.
- **Price unavailable:** survivor USD tests cannot be evaluated; the round
  report records `balanceUsd: null` and no wallet qualifies (fail-closed).
  (In sim this happened only if both Jupiter and DexScreener are down.)
- **Rounding:** all splits/allocations use largest-remainder integer math;
  parts sum exactly to the whole. Zero lamports are created or lost.

### 3.8 What the engine never does
- It never holds user funds and never needs anyone's keys. The only key it
  will ever use is its own engine wallet (§6).
- It never promises a yield. Every round pays out only what that round's
  fees actually brought in (the same "nothing is promised up front"
  framing CALL uses).

---

## 4. Parameters

| Parameter | Default | Meaning / rationale |
|---|---|---|
| `roundMinutes` | 10 | Round cadence. CALL pays every 60 s, but at small fee volumes a 10-min cadence keeps per-round amounts meaningful and RPC/tx costs sane. |
| `burnBps` | 5000 | 50% buyback & burn — the largest slice goes to the most legible, permanent signal (supply down). |
| `survivorBps` | 3000 | 30% direct survivor rewards. |
| `jackpotBps` | 2000 | 20% jackpot accrual. |
| `minHoldUsd` | 20 | Survivor floor; matches pump.fun Holder Rewards / CALL convention. |
| `sellWindowHours` | 48 | Sell-free window. 48 h is long enough to punish flip-outs, short enough to re-enter after a genuine exit. |
| `dustThresholdLamports` | 100 000 | 0.0001 SOL minimum payout (CALL pattern). |
| `batchMaxWallets` | 18 | Recipients per payout tx (CALL pattern; fits one tx with margin). |
| `jackpotEveryRounds` | 144 | ≈ 24 h between draws at 10-min rounds. |
| `jackpotTriggerLamports` | 1 000 000 000 | Early draw once the pool reaches 1 SOL — also caps the engine wallet's standing balance (§6). |
| `minClaimLamports` | 20 000 000 | Live mode: skip claiming below 0.02 SOL (tx-fee sanity). |
| `engineFloatLamports` | 500 000 000 | 0.5 SOL operating float for tx fees. |
| `sweepCapLamports` | 2 000 000 000 | Live mode: sweep engine balance above 2 SOL to the cold wallet (§6). |
| `excludeCreator` | true | The creator/dev wallet never earns survivor rewards (self-dealing optics). |
| `sellScanMaxSignatures` | 300 | Per-token-account cap for the on-chain sell scan; truncation is flagged. |
| `boostMinBuyUsd` | 5 | Minimum in-window swap-buy value that triggers the Buy Boost (§3.6). Reachable in a dip, high enough that dust buys are pointless. |
| `boostMultiplier` | 1.5 | Weight multiplier for a boosted survivor, for that round only — distribution and jackpot (§3.6). |
| `onChainBuyScan` | true | Per-holder ATA scan over the round window for swap-buy detection (vault-delta test); shares the sell scan's signature cap. |

---

## 5. Implementation map (`tools/survivor/`)

| File | Role |
|---|---|
| `config.mjs` | Defaults + `config.json` overrides; the `live:false` hard gate lives here and in `round.mjs`. |
| `math.mjs` | Pure math: `splitPot`, `allocate`, `applyDust`, `batchPlan`, `jackpotPick`, `computeStreaks`, plus the Buy Boost primitives `isSwapBuy` / `boostInfo`. Unit-tested (`test/math.test.mjs` + `test/boost.round.test.mjs`, 17 tests). |
| `lib.mjs` | Read-only chain/price helpers: solbot RPC router (fallback: feelock RPC), Jupiter prices + quotes, blockhash. |
| `snapshot.mjs` | Holder snapshot across both token programs, infra exclusions. |
| `trades.mjs` | Sell derivation (collector logs, tracked-wallet logs, on-chain ATA scan) and Buy Boost detection (log swap-buys + on-chain vault-delta test, signature-deduplicated). |
| `state.mjs` | Per-token `state.json` persistence: streaks, carried dust, jackpot pool, totals, winners. The boost is deliberately NOT stored — it is per-round only. |
| `round.mjs` | One round end-to-end (simulation): snapshot → sells/buys → survivors & streaks → split → distribution → buyback quote → jackpot → JSON + Markdown reports incl. the Buy Boost audit section. Refuses to run when `live: true`. |
| `page.mjs` | Static public page rendered from a data dir (jackpot pool, totals, streak leaderboard, round history). |
---

## 6. Engine-wallet security model

The engine's entire fund exposure is designed to be small, bounded and
boring:

- **Created by the user, at launch — not before.** The engine wallet does
  not exist during development or simulation. The user creates it as part
  of the launch procedure. The engine contains **no signing paths at all**
  in simulation mode, and live mode is hard-gated (`live: false` in
  `config.mjs`; `round.mjs` refuses to run when `live: true`). A future
  live executor is a separate module, and its key is never part of this
  codebase.
- **It only ever holds fee income.** The wallet receives the creator-fee
  stream (via fee sharing) plus a **0.5 SOL operating float**
  (`engineFloatLamports`) for transaction fees. No user funds, no
  deposits, no treasury.
- **Sweeps cap the standing balance.** Each round, any balance above
  **2 SOL** (`sweepCapLamports`) is swept to a cold wallet. The jackpot
  trigger (`jackpotTriggerLamports`, 1 SOL) doubles as an exposure cap:
  the pool is paid out before it can grow large.
- **The creator wallet is never hot.** It stays separate from the engine
  wallet, is excluded from survivor rewards (`excludeCreator`), and the
  engine never transacts from it.
- **Blast radius.** If the server were compromised, the maximum loss is
  what sits in the engine wallet at that moment: un-swept fees + the
  0.5 SOL float + the accrued jackpot pool — by construction, a few SOL
  at most. Everything already swept, burned or paid out is unreachable.
- **One-way configuration.** pump.fun's fee-sharing setup is finalized
  at token creation and cannot be re-pointed afterwards. The sharing
  config must therefore be set **once, correctly, at creation** — the
  engine wallet as fee recipient — and verified before the token is
  announced. (For the other one-way trap at creation time, see §8.)

---

## 8. Why not pump.fun's native Holder Rewards?

pump.fun ships a native alternative. Verified 2026-11-05 against the
official public docs (`pump-public-docs/docs/HOLDER_REWARDS_README.md`):

- A coin can be created as a **holder-rewards coin** via the `create_v2`
  argument `is_holder_reward` (announced 2026-09-12; it replaced
  Cashback for new launches).
- On such a coin the creator fee never reaches the creator: it accrues
  to a **pump.fun-controlled vault** (the program records a pump.fun
  address as creator) and is auto-distributed **pro-rata, several times
  per hour, in the quote asset**, to holders of ≥ ~$20. The creator has
  nothing to claim and nothing to configure.
- It is **one-way**: a holder-rewards coin can never revert to a regular
  coin, and a regular coin converts only through a gated CTO
  application.
- It **cannot be combined** with fee sharing or a creator reward
  address — the native distribution takes the entire fee stream.

The choice is therefore binary. Native Holder Rewards is zero-operations
but is a flat, linear pro-rata drip: no √ weighting, no streaks, no
burn, no jackpot, no Buy Boost. The Survivor Engine needs the raw fee
stream, so **STREAK must launch as a regular creator-fee coin with fee
sharing pointing at the engine wallet** (§6), and `is_holder_reward`
must stay off at creation — turning it on permanently removes the
engine's only fuel. Native Holder Rewards and the Survivor Engine are
mutually exclusive on one fee stream.

---

## 9. Data coverage & limitations

Eligibility is only as good as the engine's view of who sold and who
bought. The sources, honestly graded:

- **Collector swap logs are a sample.** solbot's collector records
  smart-money flow, not every trade (LSCAN V1/V2 never appeared in it at
  all — 0 rows). Absence from the logs proves nothing.
- **Per-wallet logs cover tracked wallets only.** Useful — they are how
  the V2 creator's full exit was confirmed — but not a census.
- **The authoritative source is the on-chain per-holder ATA scan**: each
  holder's token-account signatures, newest first, **capped at 300
  signatures per account per round** (`sellScanMaxSignatures`). When the
  cap is hit, that wallet's record is flagged as truncated in the round
  report — a truncated record is **never** silently read as "no sells"
  (or "no buys"). For tokens with many holders this scan is the main
  RPC cost driver.
- **Fees are per-creator, not per-token.** Claimable fees sit in one
  shared creator vault across all of a creator's tokens, plus a separate
  PumpSwap vault after graduation. The engine therefore assumes **one
  mechanism token per creator wallet** (§2, step 1); running two would
  mix their fee streams.
- **Buy detection has one blind spot.** The on-chain test for the Buy
  Boost is a vault-delta check against the canonical pump bonding-curve
  and PumpSwap pool vaults, so post-graduation buys routed through other
  DEXs can be missed by that source (the log sources may still catch
  them). On-chain-detected buys are valued at the round-close price, so
  their USD size is approximate.
- **Prices can fail.** Prices come from Jupiter lite with a DexScreener
  fallback. If both fail, the round **fails closed** — nobody qualifies
  and the report says so (§3.7) — rather than guessing USD values.
