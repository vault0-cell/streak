// Survivor Engine — persistent state (one JSON file per token, in
// <dataDir>/state.json). Holds streaks, carried dust, the jackpot pool,
// cumulative totals, last-round balances (for the public page) and winners.
// Round-by-round detail lives in <dataDir>/rounds/round-NNNN.{json,md}.
import fs from "node:fs";
import path from "node:path";

export function defaultState(mint, creator) {
  return {
    version: 1,
    mint,
    creator,
    round: 0,
    lastRoundAt: null,
    lastDrawRound: 0,
    jackpotPoolLamports: 0,
    totals: {
      claimedLamports: 0,       // simulated pot total across all rounds
      burnSolLamports: 0,       // SOL allocated to buyback & burn
      burnTokensRaw: "0",       // tokens that would have been burned (quoted)
      survivorPaidLamports: 0,  // actually payable (>= dust threshold)
      survivorCarriedLamports: 0,
      jackpotPaidLamports: 0,
    },
    wallets: {}, // addr -> { firstSeenAt, lastSellAt, streak, dustLamports, balanceRaw, balanceUsd }
    winners: [], // { round, at, wallet, lamports, blockhash, slot, weight }
  };
}

export function statePath(dataDir) { return path.join(dataDir, "state.json"); }

export function loadState(dataDir, mint, creator) {
  const p = statePath(dataDir);
  if (fs.existsSync(p)) {
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    if (s.mint !== mint) throw new Error(`state mint mismatch: ${s.mint} != ${mint}`);
    return s;
  }
  return defaultState(mint, creator);
}

export function saveState(dataDir, state) {
  fs.mkdirSync(dataDir, { recursive: true });
  const p = statePath(dataDir);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}
