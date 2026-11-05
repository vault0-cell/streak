// Survivor Engine — pure math. No I/O, no chain access. All money is integer
// lamports; allocations use the largest-remainder method so parts ALWAYS sum
// exactly to the whole (no lamports created or lost to rounding).
import { createHash } from "node:crypto";

export const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

// Split an integer pot by basis points. Largest remainder; ties broken by the
// fixed key order [burn, survivor, jackpot] so results are deterministic.
export function splitPot(potLamports, { burnBps, survivorBps, jackpotBps }) {
  const parts = [
    ["burn", burnBps],
    ["survivor", survivorBps],
    ["jackpot", jackpotBps],
  ].map(([key, bps]) => {
    const exact = (potLamports * bps) / 10_000;
    return { key, floor: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let rest = potLamports - parts.reduce((a, p) => a + p.floor, 0);
  parts.sort((a, b) => b.frac - a.frac);
  const out = {};
  for (const p of parts) out[p.key] = p.floor;
  for (const p of parts) {
    if (rest <= 0) break;
    out[p.key] += 1;
    rest -= 1;
  }
  return out;
}

// Allocate an integer pool across weighted entries [{key, weight}].
// Returns a Map key -> lamports. Sum of values === poolLamports (when at
// least one weight is positive). Zero-weight entries receive 0.
export function allocate(poolLamports, entries) {
  const out = new Map(entries.map((e) => [e.key, 0]));
  if (poolLamports <= 0 || entries.length === 0) return out;
  const totalW = entries.reduce((a, e) => a + Math.max(0, e.weight), 0);
  if (totalW <= 0) return out;
  const rows = entries.map((e) => {
    const w = Math.max(0, e.weight);
    const exact = (poolLamports * w) / totalW;
    return { key: e.key, floor: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let rest = poolLamports - rows.reduce((a, r) => a + r.floor, 0);
  const order = [...rows].sort((a, b) => b.frac - a.frac || (a.key < b.key ? -1 : 1));
  const vals = new Map(rows.map((r) => [r.key, r.floor]));
  for (const r of order) {
    if (rest <= 0) break;
    vals.set(r.key, vals.get(r.key) + 1);
    rest -= 1;
  }
  for (const [k, v] of vals) out.set(k, v);
  return out;
}

// CALL-style dust handling: a wallet is paid only once share + carried dust
// reaches the threshold; otherwise the amount keeps accumulating as dust.
// shares: Map wallet->lamports (this round), carried: Map wallet->lamports.
// Returns { payable: Map, carried: Map } covering the union of wallets.
export function applyDust(shares, carried, thresholdLamports) {
  const payable = new Map();
  const newCarried = new Map();
  const wallets = new Set([...shares.keys(), ...carried.keys()]);
  for (const w of wallets) {
    const total = (shares.get(w) || 0) + (carried.get(w) || 0);
    if (total >= thresholdLamports && total > 0) {
      payable.set(w, total);
      newCarried.set(w, 0);
    } else {
      if (total > 0) newCarried.set(w, total);
      else newCarried.set(w, 0);
    }
  }
  return { payable, carried: newCarried };
}

// Chunk a payable Map into payout batches of at most maxPerTx recipients.
export function batchPlan(payable, maxPerTx = 18) {
  const entries = [...payable.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([wallet, lamports]) => ({ wallet, lamports }));
  const batches = [];
  for (let i = 0; i < entries.length; i += maxPerTx) batches.push(entries.slice(i, i + maxPerTx));
  return batches;
}

// Deterministic weighted pick using a blockhash as the public randomness
// source. Anyone can recompute the winner from (blockhash, round, weights).
// Weights are scaled to integers (x1e6) before the modulo walk.
export function jackpotPick(entries, blockhash, roundNo) {
  const live = entries.filter((e) => e.weight > 0);
  if (live.length === 0) return null;
  const scaled = live.map((e) => ({ key: e.key, w: Math.max(1, Math.round(e.weight * 1e6)) }));
  const total = scaled.reduce((a, e) => a + e.w, 0);
  const seed = sha256hex(`${blockhash}:${roundNo}`);
  let r = Number(BigInt("0x" + seed) % BigInt(total));
  for (const e of scaled) {
    if (r < e.w) return e.key;
    r -= e.w;
  }
  return scaled[scaled.length - 1].key;
}

// --- Buy Boost (DESIGN.md §3.6) -------------------------------------------
// A "buy" for boost purposes is an actual SWAP buy: in the same transaction
// the wallet's token balance increased AND tokens left the bonding-curve /
// PumpSwap pool vault (the sell side of the swap). A plain transfer-in also
// increases the wallet's balance, but no vault account moves — so it is NOT
// a buy and can never farm the boost by shuffling tokens between wallets.
// Deltas are raw token amounts (BigInt-compatible: bigint, number or string).
export function isSwapBuy(ownerDeltaRaw, vaultDeltaRaw) {
  return BigInt(ownerDeltaRaw) > 0n && BigInt(vaultDeltaRaw) < 0n;
}

// Boost decision for one wallet in one round. boughtUsd is the summed USD
// value of the wallet's detected swap buys inside the round window.
// Returns { boosted, multiplier } — multiplier is what the caller applies
// to BOTH the distribution weight and the jackpot weight for this round.
// Purely a function of THIS round's buys: nothing here reads or writes
// state, so a boost can never leak into the next round.
export function boostInfo(boughtUsd, { boostMinBuyUsd, boostMultiplier }) {
  const boosted = Number(boughtUsd) >= boostMinBuyUsd && Number(boughtUsd) > 0;
  return { boosted, multiplier: boosted ? boostMultiplier : 1 };
}

// Pure streak transition. prev: Map wallet -> streak. survivors: Set of
// wallets that ARE survivors this round. Any tracked wallet that is not a
// survivor this round drops to 0 (sold, fell below the minimum, or emptied).
export function computeStreaks(prev, survivors) {
  const next = new Map();
  for (const w of survivors) next.set(w, (prev.get(w) || 0) + 1);
  for (const w of prev.keys()) if (!next.has(w)) next.set(w, 0);
  return next;
}
