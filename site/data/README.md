# STREAK landing-page data

`latest.json` is the small, static summary consumed by `site/index.html`.
The post-launch engine publisher should replace this file after each fully
completed round. The page fetches it with `cache: no-store`; if the file is
missing or invalid, the LP falls back to its baked-in demo values.

## Schema

```json
{
  "schemaVersion": 1,
  "demo": true,
  "source": "How this snapshot was produced.",
  "generatedAt": "2026-11-05T17:53:20.000Z",
  "roundEndsAt": 1793901800000,
  "hud": {
    "jackpotSol": 0.006788347,
    "round": 1,
    "nextRoundAt": null,
    "survivors": 22,
    "totalBurnedTokens": 0,
    "totalBurnedSol": 0.75
  },
  "leaderboard": [
    {
      "rank": 1,
      "wallet": "czcdqHNpRyqHMFLs8F1Qh8UhHYU2o8z7rGd3gGBFjnt2",
      "walletDisplay": "czcd…Jnt2",
      "streak": 3,
      "bagUsd": 411,
      "earnedSol": 0.315163899
    }
  ]
}
```

### Top-level fields

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | number | Schema version. Currently `1`. |
| `demo` | boolean | `true` keeps the LP's DEMO labels visible. In demo mode the LP makes no external requests: the countdown anchors to `roundEndsAt` (rolled forward in whole rounds) and the accruing estimate interpolates from the demo rounds. Set to `false` only for live STREAK data. |
| `source` | string | Human-readable provenance for the snapshot. Name the publisher/run and whether the values are simulated or live. |
| `generatedAt` | string | ISO 8601 UTC timestamp for when the snapshot was generated. |
| `roundEndsAt` | number | Optional. Epoch **milliseconds** when the current round window ends — the last round's settlement time + 600,000 ms. Drives the HUD countdown and the accruing estimate ("+X SOL accruing · EST" = the last round's actual slice × elapsed fraction of the window). In live mode, once it passes the HUD shows SETTLING until the next snapshot lands. Takes precedence over `hud.nextRoundAt`. |
| `mint` | string | Optional. The token's mint address. Only meaningful when `demo` is `false`: the LP then polls DexScreener every 30 s for the price / market-cap HUD tiles. Omit entirely from demo snapshots. |
| `hud` | object | Current public totals used by the four HUD cells. |
| `leaderboard` | array | Survivor leaderboard, already sorted by `rank`. The LP renders the first five entries. |
| `rounds` | array | Optional. Recent rounds, newest first (see `rounds[]` below). |
| `hallOfFame` | array | Optional. Jackpot winners (see `hallOfFame[]` below). |

### `hud`

| Field | Type | Meaning |
|---|---|---|
| `jackpotSol` | number | Current jackpot pool, denominated in SOL. |
| `round` | number | Current/latest completed round number displayed by the LP. |
| `nextRoundAt` | string or `null` | ISO 8601 UTC time of the next round. Legacy countdown source — the LP prefers the top-level `roundEndsAt` epoch field and only falls back to this when `roundEndsAt` is absent. It may be `null` in demo mode. |
| `survivors` | number | Number of wallets that qualified as survivors in the latest snapshot. |
| `totalBurnedTokens` | number | Cumulative $STREAK actually burned, in whole-token units (not raw on-chain units). |
| `totalBurnedSol` | number | Cumulative SOL allocated to or spent on buyback-and-burn. This is retained for auditability even though the HUD displays tokens burned. |

### `rounds[]` (optional, newest first)

Recent completed rounds, newest first. The LP renders the first five in
the "Recent rounds" table. Omit or leave empty pre-launch; the LP then
keeps its baked-in demo rows.

| Field | Type | Meaning |
|---|---|---|
| `round` | number | Round number. |
| `potSol` | number | Total creator fees claimed for the round, in SOL. |
| `burnedSol` | number | SOL allocated to buyback-and-burn that round. |
| `survivorsPaidSol` | number | SOL paid to survivors that round (after any rollover rules). |
| `jackpotSol` | number | SOL added to the jackpot pool that round. |
| `survivorsCount` | number | Wallets that qualified as survivors that round. |
| `draw` | object or `null` | `null` when no jackpot draw ran. Otherwise `{ winner, winnerDisplay, winnerStreak, amountSol }` with the same wallet conventions as `leaderboard[]`. |

### `hallOfFame[]` (optional)

Jackpot winners, in draw order. The LP renders every entry in the "Hall
of Fame" section. Omit or leave empty until the first draw.

| Field | Type | Meaning |
|---|---|---|
| `round` | number | Round in which the draw ran. |
| `wallet` / `walletDisplay` | string | Winner wallet, same conventions as `leaderboard[]`. |
| `amountSol` | number | Jackpot amount paid, in SOL. |
| `streak` | number | Winner's streak at draw time. |
| `bagUsd` | number | Winner's bag value in USD at draw time. |

### `leaderboard[]`

| Field | Type | Meaning |
|---|---|---|
| `rank` | number | One-based rank. Sort by streak first, then cumulative earned, unless the engine's public ranking rule changes. |
| `wallet` | string | Full wallet address. It is the canonical value; do not put a truncated address here. |
| `walletDisplay` | string | Optional display label. If omitted, the LP derives `first4…last4` from `wallet`. |
| `streak` | number | Current consecutive surviving-round count. |
| `bagUsd` | number | Wallet's $STREAK value in USD at the latest snapshot. |
| `earnedSol` | number | Cumulative SOL paid to the wallet from survivor distributions plus any jackpot winnings. |

## Publishing rules

1. Publish only after the round's snapshot, split, payouts, burn accounting,
   and any jackpot draw are final.
2. Write the complete JSON in one replacement operation so visitors never see
   a partial round.
3. Keep amounts as JSON numbers in the units named above; do not encode
   lamports or raw token units in these public summary fields.
4. Set `demo` to `false` only when every value comes from the live STREAK
   mint and live engine state.
5. Keep `source` specific enough that a reader can trace the snapshot back to
   the corresponding published round report.
6. When publishing live data, set `roundEndsAt` to the round's settlement
   time + 600,000 ms (epoch milliseconds) and `mint` to the token mint, so
   the LP's countdown, accruing estimate and price tiles light up. The LP
   re-reads this file every 60 seconds; no page redeploy is needed.
