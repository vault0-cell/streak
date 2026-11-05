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
| `demo` | boolean | `true` keeps the LP's DEMO labels visible and enables the demo countdown/jackpot animation. Set to `false` only for live STREAK data. |
| `source` | string | Human-readable provenance for the snapshot. Name the publisher/run and whether the values are simulated or live. |
| `generatedAt` | string | ISO 8601 UTC timestamp for when the snapshot was generated. |
| `hud` | object | Current public totals used by the four HUD cells. |
| `leaderboard` | array | Survivor leaderboard, already sorted by `rank`. The LP renders the first five entries. |

### `hud`

| Field | Type | Meaning |
|---|---|---|
| `jackpotSol` | number | Current jackpot pool, denominated in SOL. |
| `round` | number | Current/latest completed round number displayed by the LP. |
| `nextRoundAt` | string or `null` | ISO 8601 UTC time of the next round. In live mode this drives the countdown. It may be `null` in demo mode. |
| `survivors` | number | Number of wallets that qualified as survivors in the latest snapshot. |
| `totalBurnedTokens` | number | Cumulative $STREAK actually burned, in whole-token units (not raw on-chain units). |
| `totalBurnedSol` | number | Cumulative SOL allocated to or spent on buyback-and-burn. This is retained for auditability even though the HUD displays tokens burned. |

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
