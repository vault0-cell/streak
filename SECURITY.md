# Security model

## The one wallet that matters

The Survivor Engine operates a single dedicated **engine wallet**:

- It receives **creator fees only** (100% of the $STREAK creator fee is
  routed to it via pump.fun fee sharing, locked at launch). No user funds
  ever touch it. It is not a custody wallet and holds nobody's tokens but
  its own fee income.
- At launch it is created fresh for this purpose. Its private key exists
  **only** in the engine's runtime environment on the server — never in
  this repository, never in the engine configuration, never in any round
  report. The engine code in `engine/` reads the key from a keyfile path
  supplied via environment at run time; there is no key material anywhere
  in this codebase (the pre-launch build contains no signing or
  broadcasting code at all).

## Exposure limits

A hot wallet that pays out every 10 minutes cannot be a cold wallet, so
the design bounds what a compromise could reach instead:

- **Small float.** The engine wallet keeps only what it needs: accrued
  fees awaiting the next round plus a small operating float (≈0.5 SOL).
- **Sweep cap.** Anything above the cap (2 SOL) is swept to a separate
  cold wallet whose key is not on the server.
- **Jackpot as a cap.** The jackpot pool is the largest balance the wallet
  ever holds, and it is paid out at least every 144 rounds or at 1 SOL —
  the pool size *is* the maximum exposure.
- **Blast radius.** Worst case, a server compromise loses the un-swept
  fees, the float and the current jackpot pool. It cannot reach the
  creator wallet (kept separate, never hot), user wallets (never
  custodied), or change the rules (fee sharing is locked on-chain at
  launch).

## What the engine can and cannot do

- The engine can: claim the creator fees owed to the engine wallet, buy
  back and burn $STREAK, send SOL payouts and jackpot prizes to wallets
  that qualify under the published rules.
- The engine cannot: move anyone else's tokens, change the fee split,
  edit a published round report, or pay a wallet that did not qualify.
  Every action it takes is an on-chain transaction listed in the round
  reports — verify them (see "How to verify" in the README).

## Trust notes for holders

- **The contract address is announced only through the official links in
  the README** (this repository, the official site and the official X
  account). Never trust a CA posted in a reply, a DM, a quote post or a
  screenshot — impersonator tokens with the same name and image appear
  within minutes of any launch.
- Holding $STREAK requires trusting that the engine keeps running as
  published. That is exactly why the code, the rules and every round
  report are public: if the engine ever deviates from this repository,
  anyone can prove it from the reports alone.

## Reporting a problem

Found a discrepancy between a round report and on-chain data, or a bug in
the engine? Open an issue in this repository with the round number and the
transaction signature. Reports are append-only, so discrepancies are
resolved in public.
