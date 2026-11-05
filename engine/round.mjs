#!/usr/bin/env node
// Survivor Engine — one round, end to end, IN SIMULATION.
//
//   node round.mjs --mint <MINT> --creator <WALLET> [--pot <SOL>] [--simulate]
//                  [--fixture <file.json>] [--data-dir <dir>] [--force-draw]
//                  [--now <epoch-ms>] [--config <file>]
//
// What a round does (see DESIGN.md for the full rules):
//   1. pot      = newly claimed creator fees. Simulation NEVER claims: the
//                 pot is either --pot, a fixture value, or the CURRENT
//                 unclaimed balance read via the feelock toolkit (treated
//                 as this round's claim — a read-only measurement).
//   2. snapshot = current holders (both token programs, infra excluded).
//   3. sells    = outbound movements since the last round (collector logs,
//                 tracked-wallet logs, on-chain ATA scan) update streaks.
//   4. splits   = 50% buyback & burn (Jupiter quote only — the would-be
//                 burn), 30% to survivors by sqrt(balance), 20% jackpot.
//   5. jackpot  = draws when due (every N rounds or pool >= trigger),
//                 weighted sqrt(balance) x streak, blockhash randomness.
//
// ============================================================================
// LIVE MODE IS NOT IMPLEMENTED IN THIS BUILD — BY DESIGN.
// There is no signing, key-loading or broadcasting code in this directory.
// If config.live is set to true, this script REFUSES to run. The future
// live executor will live in a separate module and will additionally
// require the SURVIVOR_ENGINE_KEYFILE env var (created by the user at
// launch). Simulation is the only runnable mode.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { loadConfig, SURVIVOR_DIR } from "./config.mjs";
import { splitPot, allocate, applyDust, batchPlan, jackpotPick, computeStreaks, sha256hex } from "./math.mjs";
import { loadState, saveState } from "./state.mjs";
import { snapshotHolders } from "./snapshot.mjs";
import { collectSells } from "./trades.mjs";
import { measureFees, getPrices, getLatestBlockhash, jupiterQuoteSolToToken, fmtSol, LAMPORTS } from "./lib.mjs";
import { parseArgs, requirePubkey } from "../feelock/lib.mjs";

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig(args.config || null);

if (cfg.live) {
  console.error("REFUSED: config.live is true, but this build contains no live executor (no signing/broadcast code exists). Set live:false to run the simulation.");
  process.exit(2);
}

const fixture = args.fixture ? JSON.parse(fs.readFileSync(args.fixture, "utf8")) : null;
const mint = fixture?.mint || requirePubkey(args.mint, "mint").toBase58();
const creator = fixture?.creator || requirePubkey(args.creator, "creator").toBase58();
const now = args.now ? Number(args.now) : Date.now();
const dataDir = args["data-dir"] || path.join(SURVIVOR_DIR, "data", mint);
const state = loadState(dataDir, mint, creator);
const roundNo = state.round + 1;
const bootstrap = state.round === 0;
const windowMs = cfg.sellWindowHours * 3_600_000;
const scanSince = bootstrap ? now - windowMs : Math.max(state.lastRoundAt || 0, now - windowMs);

// ---------- snapshot + prices + sells ----------
let holders, infraExcluded = [], prices, sellsResult, snapshotMeta = {};
if (fixture) {
  holders = fixture.holders.map((h) => ({ owner: h.owner, balanceRaw: String(h.balanceRaw), balanceUi: h.balanceUi, accounts: 1 }));
  infraExcluded = fixture.infraExcluded || [];
  prices = { tokenUsd: fixture.tokenUsd, solUsd: fixture.solUsd, source: "fixture" };
  const last = new Map();
  for (const s of fixture.sells || []) {
    if (s.atMs <= now && s.atMs > (last.get(s.wallet) || 0)) last.set(s.wallet, s.atMs);
  }
  sellsResult = { lastSellAt: last, coverage: { source: "fixture" }, truncatedWallets: [] };
  snapshotMeta = { mintProgram: "fixture", decimals: fixture.decimals ?? 6 };
} else {
  const snap = await snapshotHolders(mint, creator, cfg);
  holders = snap.holders;
  infraExcluded = snap.infraExcluded;
  snapshotMeta = { mintProgram: snap.mintProgram, tokenProgramsSeen: snap.tokenProgramsSeen, decimals: snap.decimals };
  prices = await getPrices(mint);
  sellsResult = await collectSells({ mint, holders, sinceMs: scanSince, cfg });
}

// ---------- merge sell history into state ----------
for (const h of holders) {
  const w = state.wallets[h.owner] ||= { firstSeenAt: now, lastSellAt: null, streak: 0, dustLamports: 0, balanceRaw: "0", balanceUsd: 0 };
  w.balanceRaw = h.balanceRaw;
  w.balanceUsd = prices.tokenUsd ? h.balanceUi * prices.tokenUsd : null;
}
for (const [wallet, t] of sellsResult.lastSellAt) {
  const w = state.wallets[wallet] ||= { firstSeenAt: now, lastSellAt: null, streak: 0, dustLamports: 0, balanceRaw: "0", balanceUsd: 0 };
  if (!w.lastSellAt || t > w.lastSellAt) w.lastSellAt = t;
}

// ---------- survivor determination ----------
// Survivor = holds >= minHoldUsd AND no outbound movement in the trailing
// sell window. Infra/creator/engine wallets never reach this set (snapshot).
const cutoff = now - windowMs;
const survivorSet = new Set();
const holderRows = holders.map((h) => {
  const usd = prices.tokenUsd ? h.balanceUi * prices.tokenUsd : null;
  const lastSellAt = state.wallets[h.owner]?.lastSellAt ?? null;
  const soldInWindow = lastSellAt !== null && lastSellAt > cutoff;
  const survivor = usd !== null && usd >= cfg.minHoldUsd && !soldInWindow && BigInt(h.balanceRaw) > 0n;
  if (survivor) survivorSet.add(h.owner);
  return { ...h, balanceUsd: usd, lastSellAt, soldInWindow, survivor };
});

// ---------- streaks ----------
const prevStreaks = new Map(Object.entries(state.wallets).map(([w, v]) => [w, v.streak || 0]));
const nextStreaks = computeStreaks(prevStreaks, survivorSet);
for (const [w, s] of nextStreaks) if (state.wallets[w]) state.wallets[w].streak = s;

// ---------- pot ----------
let potLamports, potSource;
if (args.pot) { potLamports = Math.round(Number(args.pot) * LAMPORTS); potSource = "--pot flag"; }
else if (fixture) { potLamports = Math.round(Number(fixture.potSol) * LAMPORTS); potSource = "fixture"; }
else {
  const fees = await measureFees(requirePubkey(creator, "creator"), requirePubkey(mint, "mint"));
  potLamports = fees.totalClaimableLamports;
  potSource = "feelock measureFees (current unclaimed creator fees, read-only)";
}
const splits = splitPot(potLamports, cfg);

// ---------- survivor distribution (sqrt-weighted, dust, batches) ----------
const survivorEntries = holderRows
  .filter((h) => h.survivor)
  .map((h) => ({ key: h.owner, weight: Math.sqrt(h.balanceUi), balanceUi: h.balanceUi, streak: state.wallets[h.owner].streak }));
let survivorPool = splits.survivor;
let rolloverToJackpot = 0;
let shares = new Map();
if (survivorEntries.length === 0 && splits.survivor > 0) {
  rolloverToJackpot = splits.survivor; // nobody to pay: the slice feeds the jackpot
  survivorPool = 0;
} else {
  shares = allocate(splits.survivor, survivorEntries);
}
const carriedBefore = new Map(Object.entries(state.wallets).map(([w, v]) => [w, v.dustLamports || 0]));
const { payable, carried } = applyDust(shares, carriedBefore, cfg.dustThresholdLamports);
for (const [w, d] of carried) if (state.wallets[w]) state.wallets[w].dustLamports = d;
const batches = batchPlan(payable, cfg.batchMaxWallets);
const survivorPaidTotal = [...payable.values()].reduce((a, b) => a + b, 0);

// ---------- buyback quote (quote only — nothing is bought or burned) ----------
let buyback = { solLamports: splits.burn, quote: null, wouldBurnTokensRaw: null, note: null };
if (!fixture && splits.burn > 0) {
  buyback.quote = await jupiterQuoteSolToToken(mint, splits.burn);
  if (buyback.quote) buyback.wouldBurnTokensRaw = buyback.quote.outAmountRaw;
  else buyback.note = "no Jupiter route for this mint (expected pre-graduation: in live mode the buyback executes against the bonding curve / PumpSwap pool directly, not via Jupiter)";
} else if (fixture) {
  buyback.note = "fixture round — no quote fetched";
}

// ---------- jackpot ----------
state.jackpotPoolLamports += splits.jackpot + rolloverToJackpot;
const drawDue = Boolean(args["force-draw"]) ||
  (roundNo - state.lastDrawRound) >= cfg.jackpotEveryRounds ||
  state.jackpotPoolLamports >= cfg.jackpotTriggerLamports;
let draw = null;
if (drawDue && survivorEntries.length > 0 && state.jackpotPoolLamports > 0) {
  let bh;
  if (fixture) bh = { blockhash: fixture.blockhash || "fixture-blockhash", slot: fixture.slot ?? null };
  else bh = await getLatestBlockhash();
  const entries = survivorEntries.map((e) => ({ key: e.key, weight: Math.sqrt(e.balanceUi) * Math.max(1, e.streak) }));
  const winner = jackpotPick(entries, bh.blockhash, roundNo);
  const amount = state.jackpotPoolLamports;
  draw = { winner, lamports: amount, blockhash: bh.blockhash, slot: bh.slot, entries: entries.map((e) => ({ wallet: e.key, weight: e.weight })) };
  state.winners.push({ round: roundNo, at: now, wallet: winner, lamports: amount, blockhash: bh.blockhash, slot: bh.slot });
  state.totals.jackpotPaidLamports += amount;
  state.jackpotPoolLamports = 0;
  state.lastDrawRound = roundNo;
} else if (drawDue) {
  draw = { skipped: true, reason: survivorEntries.length === 0 ? "no survivors to draw among — pool carries" : "pool is empty" };
}

// ---------- totals + snapshot hash ----------
state.totals.claimedLamports += potLamports;
state.totals.burnSolLamports += splits.burn;
if (buyback.wouldBurnTokensRaw) state.totals.burnTokensRaw = (BigInt(state.totals.burnTokensRaw) + BigInt(buyback.wouldBurnTokensRaw)).toString();
state.totals.survivorPaidLamports += survivorPaidTotal;
state.totals.survivorCarriedLamports = [...carried.values()].reduce((a, b) => a + b, 0);
state.round = roundNo;
state.lastRoundAt = now;
const snapshotHash = sha256hex(holderRows.map((h) => `${h.owner}:${h.balanceRaw}`).sort().join("\n"));

// ---------- reports ----------
const report = {
  engine: "survivor-engine",
  mode: "SIMULATION — no claim, swap, burn or payout was executed",
  round: roundNo,
  at: now,
  atIso: new Date(now).toISOString(),
  mint, creator,
  pot: { lamports: potLamports, sol: fmtSol(potLamports), source: potSource },
  splits: {
    burnLamports: splits.burn, survivorLamports: splits.survivor, jackpotLamports: splits.jackpot,
    survivorRolloverToJackpot: rolloverToJackpot,
    bps: { burn: cfg.burnBps, survivor: cfg.survivorBps, jackpot: cfg.jackpotBps },
  },
  prices,
  snapshot: { ...snapshotMeta, holders: holderRows.length, infraExcluded, snapshotHash },
  sellsCoverage: sellsResult.coverage,
  truncatedSellScans: sellsResult.truncatedWallets,
  survivors: survivorEntries.map((e) => ({
    wallet: e.key, balanceUi: e.balanceUi, balanceUsd: prices.tokenUsd ? e.balanceUi * prices.tokenUsd : null,
    streak: e.streak, shareLamports: shares.get(e.key) || 0,
    payableLamports: payable.get(e.key) || 0, dustCarriedLamports: carried.get(e.key) || 0,
  })),
  nonSurvivors: holderRows.filter((h) => !h.survivor).map((h) => ({
    wallet: h.owner, balanceUi: h.balanceUi, balanceUsd: h.balanceUsd,
    reason: h.balanceUsd !== null && h.balanceUsd < cfg.minHoldUsd ? "below_min_hold" : h.soldInWindow ? "sold_in_window" : "no_price_or_zero",
    lastSellAt: h.lastSellAt,
  })),
  payoutBatches: batches.map((b, i) => ({ tx: i + 1, recipients: b.length, totalLamports: b.reduce((a, x) => a + x.lamports, 0), payments: b })),
  buyback,
  jackpot: { poolLamportsAfter: state.jackpotPoolLamports, drawDue, draw },
  totals: state.totals,
};
const roundsDir = path.join(dataDir, "rounds");
fs.mkdirSync(roundsDir, { recursive: true });
const stem = `round-${String(roundNo).padStart(4, "0")}`;
fs.writeFileSync(path.join(roundsDir, stem + ".json"), JSON.stringify(report, null, 2));

const md = [
  `# Survivor Engine — Round #${roundNo} (SIMULATION)`,
  ``,
  `- Time: ${report.atIso}`,
  `- Mint: ${mint}`,
  `- Pot: **${fmtSol(potLamports)} SOL** (${potSource})`,
  `- Split: burn ${fmtSol(splits.burn)} SOL · survivors ${fmtSol(splits.survivor)} SOL · jackpot ${fmtSol(splits.jackpot)} SOL` + (rolloverToJackpot ? ` · survivor slice rolled to jackpot (no survivors): ${fmtSol(rolloverToJackpot)} SOL` : ``),
  `- Holders (non-infra): ${holderRows.length} · Survivors: ${survivorEntries.length}`,
  `- Buyback: ${buyback.wouldBurnTokensRaw ? `would burn ${buyback.wouldBurnTokensRaw} raw tokens (Jupiter quote)` : `no quote — ${buyback.note || "n/a"}`}`,
  `- Survivor payouts: ${payable.size} wallet(s), ${fmtSol(survivorPaidTotal)} SOL in ${batches.length} batch(es) of <= ${cfg.batchMaxWallets}`,
  `- Jackpot pool after round: **${fmtSol(state.jackpotPoolLamports)} SOL**${draw && !draw.skipped ? ` — DRAWN: winner ${draw.winner} won ${fmtSol(draw.lamports)} SOL (blockhash ${draw.blockhash})` : drawDue ? ` — draw due but skipped: ${draw?.reason}` : ``}`,
  `- Snapshot hash: ${snapshotHash}`,
  ``,
  `## Survivors`,
  ...(report.survivors.length ? report.survivors.map((s) => `- ${s.wallet} — ${s.balanceUi} tokens ($${s.balanceUsd?.toFixed(2)}), streak ${s.streak}, share ${fmtSol(s.shareLamports)} SOL, payable ${fmtSol(s.payableLamports)} SOL, dust ${fmtSol(s.dustCarriedLamports)} SOL`) : [`- (none)`]),
  ``,
  `## Non-survivors`,
  ...(report.nonSurvivors.length ? report.nonSurvivors.map((s) => `- ${s.wallet} — ${s.balanceUi} tokens — ${s.reason}${s.lastSellAt ? ` (last sell ${new Date(s.lastSellAt).toISOString()})` : ``}`) : [`- (none)`]),
  ``,
  `> Simulation only: no fees were claimed, no swap/burn/payout was executed.`,
].join("\n");
fs.writeFileSync(path.join(roundsDir, stem + ".md"), md);
saveState(dataDir, state);

console.log(JSON.stringify({
  round: roundNo, mode: "SIMULATION", mint,
  potSol: fmtSol(potLamports), potSource,
  holders: holderRows.length, survivors: survivorEntries.length,
  splitsSol: { burn: fmtSol(splits.burn), survivor: fmtSol(splits.survivor), jackpot: fmtSol(splits.jackpot) },
  survivorPaidSol: fmtSol(survivorPaidTotal), payoutBatches: batches.length,
  jackpotPoolSol: fmtSol(state.jackpotPoolLamports),
  draw: draw ? (draw.skipped ? `skipped: ${draw.reason}` : `winner ${draw.winner} +${fmtSol(draw.lamports)} SOL`) : "not due",
  report: path.join(roundsDir, stem + ".json"),
}, null, 2));
