// Survivor Engine — configuration.
// ============================================================================
// SAFETY MODEL OF THIS BUILD (v0.1, simulation-first):
//   * There is NO signing code, NO key loading, NO transaction building and
//     NO broadcasting anywhere in this directory. Rounds only READ chain
//     state and WRITE reports/state JSON.
//   * `live` defaults to false. Even if a config file sets live:true,
//     round.mjs REFUSES to run: the live executor is a separate future
//     module that does not exist yet, and it will additionally require an
//     engine-wallet env var (SURVIVOR_ENGINE_KEYFILE) that is only created
//     by the user at launch time. Simulation is the only runnable mode.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SURVIVOR_DIR = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  live: false,

  // Round cadence (informational in sim; the future live runner sleeps this long)
  roundMinutes: 10,

  // Pot split, basis points of newly claimed creator fees. Must sum to 10000.
  burnBps: 5000,      // 50% buyback & burn
  survivorBps: 3000,  // 30% to survivors, sqrt(balance)-weighted
  jackpotBps: 2000,   // 20% to the progressive jackpot pool

  // Survivor eligibility
  minHoldUsd: 20,          // hold at least this USD value of the token
  sellWindowHours: 48,     // ... and have sold nothing in the trailing window
  excludeCreator: true,    // creator/dev wallet never earns survivor rewards
  extraExcludeOwners: [],  // extra wallets to exclude (treasury, team, CEX, ...)

  // Payout mechanics (CALL pattern)
  dustThresholdLamports: 100_000, // shares below 0.0001 SOL are carried, not sent
  batchMaxWallets: 18,            // max recipients per payout transaction

  // Jackpot
  jackpotEveryRounds: 144,                 // ~24h at 10-minute rounds
  jackpotTriggerLamports: 1_000_000_000,   // ... or draw early once pool >= 1 SOL

  // Live-mode parameters (documented here, enforced only by the future executor)
  minClaimLamports: 20_000_000,     // skip a live claim below 0.02 SOL (tx fees)
  engineFloatLamports: 500_000_000, // 0.5 SOL operating float for the engine wallet
  sweepCapLamports: 2_000_000_000,  // sweep engine balance above 2 SOL to cold wallet

  // Sell-history derivation
  onChainSellScan: true,       // per-holder ATA signature scan (fallback source)
  sellScanMaxSignatures: 300,  // per token account per round; truncation is flagged
};

export function loadConfig(explicitPath = null) {
  const file = explicitPath || path.join(SURVIVOR_DIR, "config.json");
  let overrides = {};
  if (fs.existsSync(file)) {
    overrides = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const cfg = { ...DEFAULTS, ...overrides };
  const bps = cfg.burnBps + cfg.survivorBps + cfg.jackpotBps;
  if (bps !== 10_000) throw new Error(`split bps must sum to 10000, got ${bps}`);
  return cfg;
}
