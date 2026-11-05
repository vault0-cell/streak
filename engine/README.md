# Survivor Engine (v0.1 — simulation only)

Automated creator-fee mechanism for a future pump.fun token: every round,
newly accrued creator fees split **50% buyback & burn · 30% to survivors
(√balance-weighted) · 20% to a progressive jackpot** drawn among survivors
by √balance × streak. A survivor who swap-buys **≥ $5 within a round**
attacks at **×1.5 weight for that round only** (Buy Boost — DESIGN.md
§3.6; transfer-ins never count). Full rules, parameters, security model
and the go-live checklist: see **DESIGN.md**.

> **This build cannot move money.** There is no signing, key-loading or
> broadcasting code in this directory. If `config.json` sets `live: true`,
> `round.mjs` refuses to run. Live execution is a separate future module
> that will require `SURVIVOR_ENGINE_KEYFILE` (created by the user at
> launch).

## Run a simulated round

```sh
cd engine

# Real token, explicit pot (SOL). Snapshot/sells/prices are read live.
node round.mjs --mint <MINT> --creator <WALLET> --pot 0.013576694 --simulate

# Real token, pot = current unclaimed creator fees (feelock, read-only).
node round.mjs --mint <MINT> --creator <WALLET> --simulate

# Synthetic 30-wallet fixture (no chain access for holders/sells):
node test/make-fixture.mjs   # (re)generates test/fixture.json
T0=$(python3 -c "import json;print(json.load(open('test/fixture.json'))['t0'])")
node round.mjs --fixture test/fixture.json --data-dir data/fixture --now $T0 --simulate
node round.mjs --fixture test/fixture.json --data-dir data/fixture --now $((T0+600000)) --simulate
node round.mjs --fixture test/fixture.json --data-dir data/fixture --now $((T0+1200000)) --simulate --force-draw

# Public page for a data dir:
node page.mjs --data-dir data/<MINT>        # writes data/<MINT>/page.html
```

Outputs per token: `data/<MINT>/state.json` (streaks, dust, jackpot pool,
totals, winners) and `data/<MINT>/rounds/round-NNNN.{json,md}` (full
report incl. payout lists and the snapshot hash).

## Tests

```sh
node --test test/math.test.mjs test/boost.round.test.mjs
# 17 tests: exact splits, sqrt allocation, dust carry, batching, draw,
# streaks, plus Buy Boost (swap-vs-transfer classification, $5 threshold,
# exact 1.5x shares, boost non-persistence, buy-then-sell disqualifies)
```

## Parameters (defaults)

`roundMinutes 10` · splits `burn 5000 / survivor 3000 / jackpot 2000` bps ·
`minHoldUsd 20` · `sellWindowHours 48` · dust threshold `0.0001 SOL` ·
batch `≤18` · jackpot every `144` rounds or at `1 SOL` · Buy Boost
`boostMultiplier 1.5` at `boostMinBuyUsd 5` · creator excluded
from rewards. Override via `config.json` next to `config.mjs` (see
DESIGN.md §4 for the full table and rationale).

## What remains for go-live (user steps only)

1. Create the token as a **regular creator-fee coin** (NOT a Holder
   Rewards coin — mutually exclusive, DESIGN.md §8).
2. Set pump.fun fee sharing once: engine wallet = 100% (finalization is
   irreversible).
3. Create the **engine wallet** (fee-income-only hot wallet; user creates
   and backs it up at launch — not before), fund a 0.5 SOL float.
4. Set `config.json` (mint, creator, sweep destination) — a future live
   executor build then flips `live` in supervised steps.

Nothing else is missing on the design side: claim measurement
(`tools/feelock/`), snapshot, sell derivation, math, reporting and the
public page are built and simulation-tested against LSCAN V2 and a
30-wallet fixture.
