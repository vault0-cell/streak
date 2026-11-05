# Survivor Engine — Design

An automated creator-fee mechanism for a future pump.fun token. The token
itself is a plain SPL / Token-2022 mint — it cannot carry logic — so every
rule below is executed by an off-chain engine whose only fuel is the token's
creator-fee stream. All rules are public, all outputs are published, and
every number on the public page can be recomputed from chain data.

**Status: v0.1, simulation-first.** The code in `tools/survivor/` reads chain
state and produces round reports, payout plans and a public page. It
contains **no signing, key-handling or broadcasting code at all** — live
execution is a separate future module (see the go-live checklist).

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
   §3.2) update each wallet's `last_sell_at`.
4. **Determine survivors & streaks** (§3.1, §3.3).
5. **Split the pot** 50/30/20 with integer lamport math (largest-remainder;
   the three parts always sum exactly to the pot).
6. **Survivor distribution.** √balance weights → lamport shares (largest
   remainder, exact sum) → dust rule (§3.4) → payout plan batched at
   ≤ 18 recipients per transaction (CALL pattern).
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
- Survivor shares are proportional to **√(balance in tokens)**.
- **Dust rule (CALL pattern):** a wallet is paid only when
  `share + carried_dust ≥ 0.0001 SOL` (`dustThresholdLamports = 100_000`);
  otherwise the share accumulates as carried dust in state. Dust is never
  forfeited.
- Payouts are planned in batches of **≤ 18 recipients per transaction**,
  largest first.

### 3.5 Jackpot
- The pool accrues 20% of every pot, plus rollovers (§3.6).
- A draw happens when **either** `jackpotEveryRounds` (default **144** =
  ~24 h at 10-minute rounds) rounds have passed since the last draw,
  **or** the pool reaches `jackpotTriggerLamports` (default **1 SOL**).
- Eligible: that round's survivors. Weight = **√(balance) × streak**
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

### 3.6 Rollovers and edge cases
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

### 3.7 What the engine never does
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

---

## 5. Implementation map (`tools/survivor/`)

| File | Role |
|---|---|
| `config.mjs` | Defaults + `config.json` overrides; the `live:false` hard gate lives here and in `round.mjs`. |
| `math.mjs` | Pure math: `splitPot`, `allocate`, `applyDust`, `batchPlan`, `jackpotPick`, `computeStreaks`. Unit-tested (`test/math.test.mjs`, 8 tests). |
| `lib.mjs` | Read-only chain/price helpers: solbot RPC router (fallback: feelock RPC), Jupiter prices + quotes, blockhash. |
| `snapshot.mjs` | Holder snapshot across both token programs, infra exclusions. |
| `trades
...[truncated 9195 chars]