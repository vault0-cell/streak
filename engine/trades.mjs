// Survivor Engine — sell-history derivation ("did this wallet sell?").
//
// Sources, in order of preference:
//   A) solbot collector swap logs  (data/swaps/YYYY-MM-DD.jsonl[.gz],
//      fields: maker, side, token, ts) — a SMART-MONEY SAMPLE, not a full
//      trade feed. LSCAN V1/V2 do not appear in it at all (checked 2026-11-05).
//   B) solbot per-wallet logs      (data/wallets/<wallet>.jsonl, fields:
//      tok, side, t) — only for wallets solbot tracks. This source DOES
//      contain the LSCAN creator's trades, including the V2 exit.
//   C) On-chain fallback: for each holder, scan their token-account
//      signatures (newest first, capped) and compare pre/post token
//      balances for the owner. Any DECREASE counts as an outbound event
//      (sell OR transfer-out — both reset the streak; see DESIGN.md).
//      Truncation (cap hit while still inside the window) is flagged per
//      wallet instead of silently treated as "no sells".
//
// A "sell" here means any outbound token movement. That is deliberately
// conservative and anti-gaming: you cannot keep a streak alive by moving
// the bag to a fresh wallet.
//
// BUY detection (for the Buy Boost, DESIGN.md §3.6) lives in the second
// half of this file. A qualifying buy is an actual SWAP buy: sources A/B
// log rows carry side:"buy" from swap feeds, and the on-chain fallback
// only counts a balance increase when the same transaction also drained
// the bonding-curve / PumpSwap pool vault (isSwapBuy in math.mjs). A
// plain transfer-in never qualifies — tokens arriving from another
// wallet leave no vault trace. Buys from all sources are deduplicated
// by transaction signature so a swap seen in two sources counts once.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { rpc, ataAddress, getMintProgram, getMintDecimals, bondingCurvePda } from "./lib.mjs";
import { isSwapBuy } from "./math.mjs";
import { pumpSwapPoolPda } from "./snapshot.mjs";
import { PublicKey } from "@solana/web3.js";

const SOLBOT_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..", "..");

async function readLines(file) {
  try {
    const buf = await fs.promises.readFile(file);
    const text = file.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    return text.split("\n").filter(Boolean);
  } catch { return []; }
}

function dayFiles(dir, sinceMs, daysBack = 4) {
  const out = [];
  for (let i = 0; i < daysBack; i++) {
    const d = new Date(sinceMs - i * 86_400_000);
    const name = d.toISOString().slice(0, 10) + ".jsonl";
    for (const cand of [path.join(dir, name), path.join(dir, name + ".gz")]) {
      if (fs.existsSync(cand)) out.push(cand);
    }
  }
  return out;
}

// Source A: collector swap logs. Returns Map wallet -> lastSellMs.
export async function sellsFromCollector(mint, sinceMs) {
  const last = new Map();
  let rows = 0;
  for (const file of dayFiles(path.join(SOLBOT_ROOT, "data", "swaps"), sinceMs)) {
    for (const line of await readLines(file)) {
      if (!line.includes(mint)) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.token !== mint || j.side !== "sell" || !j.maker) continue;
      const t = (j.ts ? j.ts * 1000 : j.t) || 0;
      if (t >= sinceMs && t > (last.get(j.maker) || 0)) { last.set(j.maker, t); rows++; }
    }
  }
  return { last, rows };
}

// Source B: per-wallet tracked logs for the given wallets.
export async function sellsFromWalletLogs(mint, wallets, sinceMs) {
  const last = new Map();
  let files = 0;
  for (const w of wallets) {
    const file = path.join(SOLBOT_ROOT, "data", "wallets", `${w}.jsonl`);
    if (!fs.existsSync(file)) continue;
    files++;
    for (const line of await readLines(file)) {
      if (!line.includes(mint)) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.tok !== mint || j.side !== "sell") continue;
      const t = j.t || 0;
      if (t >= sinceMs && t > (last.get(w) || 0)) last.set(w, t);
    }
  }
  return { last, files };
}

// Source C: on-chain ATA scan for one holder. Returns { lastSellMs, truncated, scannedTxs }.
export async function sellsOnChainForHolder(mint, owner, sinceMs, maxSignatures) {
  const program = await getMintProgram(mint);
  const ata = ataAddress(new PublicKey(owner), new PublicKey(mint), new PublicKey(program));
  const sigs = await rpc("getSignaturesForAddress", [ata.toBase58(), { limit: maxSignatures }]);
  let lastSellMs = null;
  let scannedTxs = 0;
  let truncated = false;
  const inWindow = (sigs || []).filter((s) => s.blockTime && s.blockTime * 1000 >= sinceMs && !s.err);
  if ((sigs || []).length >= maxSignatures && inWindow.length === (sigs || []).filter((s) => !s.err).length && inWindow.length > 0) {
    // Cap reached and every returned signature is still inside the window:
    // older sells may exist beyond the cap.
    truncated = true;
  }
  for (const s of inWindow) {
    const tx = await rpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
    if (!tx?.meta) continue;
    scannedTxs++;
    const sum = (arr) => (arr || [])
      .filter((b) => b.owner === owner && b.mint === mint)
      .reduce((a, b) => a + BigInt(b.uiTokenAmount?.amount || "0"), 0n);
    const pre = sum(tx.meta.preTokenBalances);
    const post = sum(tx.meta.postTokenBalances);
    if (post < pre) {
      const t = (tx.blockTime || s.blockTime) * 1000;
      if (!lastSellMs || t > lastSellMs) lastSellMs = t;
    }
  }
  return { lastSellMs, truncated, scannedTxs };
}

// ===========================================================================
// BUY derivation (Buy Boost). Window = the current round window
// (sinceMs, untilMs] — unlike sells, which look back 48h, a boost only
// counts buys executed since the previous round closed.
// ===========================================================================

// Source A (buys): collector swap logs, side === "buy". Rows carry a USD
// value and a tx signature. Returns [{ wallet, usd, atMs, tx }].
export async function buysFromCollector(mint, sinceMs, untilMs) {
  const out = [];
  for (const file of dayFiles(path.join(SOLBOT_ROOT, "data", "swaps"), sinceMs)) {
    for (const line of await readLines(file)) {
      if (!line.includes(mint)) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.token !== mint || j.side !== "buy" || !j.maker) continue;
      const t = j.t || (j.ts ? j.ts * 1000 : 0);
      if (t > sinceMs && t <= untilMs) out.push({ wallet: j.maker, usd: Number(j.usd) || 0, atMs: t, tx: j.tx || null });
    }
  }
  return out;
}

// Source B (buys): per-wallet tracked logs, side === "buy".
export async function buysFromWalletLogs(mint, wallets, sinceMs, untilMs) {
  const out = [];
  let files = 0;
  for (const w of wallets) {
    const file = path.join(SOLBOT_ROOT, "data", "wallets", `${w}.jsonl`);
    if (!fs.existsSync(file)) continue;
    files++;
    for (const line of await readLines(file)) {
      if (!line.includes(mint)) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.tok !== mint || j.side !== "buy") continue;
      const t = j.t || 0;
      if (t > sinceMs && t <= untilMs) out.push({ wallet: w, usd: Number(j.usd) || 0, atMs: t, tx: j.tx || null });
    }
  }
  return { buys: out, files };
}

// Source C (buys): on-chain ATA scan over the round window for one holder.
// A tx counts as a swap buy iff the owner's mint balance increased AND the
// bonding-curve / PumpSwap pool vault's mint balance decreased in the same
// tx (isSwapBuy). Buys routed through aggregators still settle against the
// pool vault, so they are caught; a plain transfer-in (sender = another
// wallet) shows no vault decrease and is ignored. USD value is the tokens
// received valued at the round-close price (tokenUsd). Returns
// { buys: [{ usd, atMs, tx }], truncated, scannedTxs }.
export async function buysOnChainForHolder({ mint, owner, creator, sinceMs, untilMs, cfg, tokenUsd, decimals }) {
  const program = await getMintProgram(mint);
  const ata = ataAddress(new PublicKey(owner), new PublicKey(mint), new PublicKey(program));
  const sigs = await rpc("getSignaturesForAddress", [ata.toBase58(), { limit: cfg.sellScanMaxSignatures }]);
  const vaultOwners = new Set([bondingCurvePda(new PublicKey(mint)).toBase58()]);
  const pool = creator ? pumpSwapPoolPda(creator, mint) : null;
  if (pool) vaultOwners.add(pool);
  const ok = (sigs || []).filter((s) => !s.err && s.blockTime);
  const inWindow = ok.filter((s) => s.blockTime * 1000 > sinceMs && s.blockTime * 1000 <= untilMs);
  // Cap hit while the oldest returned signature is still inside the window:
  // older in-window buys may exist beyond the cap.
  const truncated = (sigs || []).length >= cfg.sellScanMaxSignatures && ok.length > 0 &&
    ok[ok.length - 1].blockTime * 1000 > sinceMs && inWindow.length === ok.filter((s) => s.blockTime * 1000 <= untilMs).length;
  const buys = [];
  let scannedTxs = 0;
  for (const s of inWindow) {
    const tx = await rpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
    if (!tx?.meta) continue;
    scannedTxs++;
    const sumFor = (arr, owners) => (arr || [])
      .filter((b) => b.mint === mint && owners.has(b.owner))
      .reduce((acc, b) => acc + BigInt(b.uiTokenAmount?.amount || "0"), 0n);
    const deltaFor = (owners) => sumFor(tx.meta.postTokenBalances, owners) - sumFor(tx.meta.preTokenBalances, owners);
    const ownerDelta = deltaFor(new Set([owner]));
    if (ownerDelta <= 0n) continue;
    const vaultDelta = deltaFor(vaultOwners);
    if (!isSwapBuy(ownerDelta, vaultDelta)) continue; // transfer-in or other inflow — not a buy
    const tokensUi = Number(ownerDelta) / 10 ** decimals;
    buys.push({ usd: tokenUsd ? tokensUi * tokenUsd : 0, atMs: (tx.blockTime || s.blockTime) * 1000, tx: s.signature });
  }
  return { buys, truncated, scannedTxs };
}

// Combined buy derivation for a round. All sources are merged and
// DEDUPLICATED BY TX SIGNATURE (a swap seen by both a log and the
// on-chain scan counts once). Returns:
// { boughtUsd: Map wallet->usd, buys: [...], coverage: {...}, truncatedWallets: [] }
export async function collectBuys({ mint, creator, holders, sinceMs, untilMs, cfg, tokenUsd }) {
  const bySig = new Map(); // dedupe key -> { wallet, usd, atMs, tx, source }
  const add = (b, source) => {
    const key = b.tx || `nosig:${b.wallet}:${b.atMs}:${(b.usd || 0).toFixed(4)}`;
    if (!bySig.has(key)) bySig.set(key, { ...b, source });
  };

  const a = await buysFromCollector(mint, sinceMs, untilMs);
  for (const b of a) add(b, "collector");
  const bRes = await buysFromWalletLogs(mint, holders.map((h) => h.owner), sinceMs, untilMs);
  for (const b of bRes.buys) add(b, "wallet-log");

  const truncatedWallets = [];
  let onChainScanned = 0;
  if (cfg.onChainBuyScan) {
    const decimals = await getMintDecimals(mint);
    for (const h of holders) {
      try {
        const r = await buysOnChainForHolder({ mint, owner: h.owner, creator, sinceMs, untilMs, cfg, tokenUsd, decimals });
        onChainScanned++;
        if (r.truncated) truncatedWallets.push(h.owner);
        for (const b of r.buys) add({ wallet: h.owner, ...b }, "on-chain");
      } catch { /* RPC hiccup for one holder — flagged via coverage count */ }
    }
  }

  const buys = [...bySig.values()].sort((x, y) => x.atMs - y.atMs);
  const boughtUsd = new Map();
  for (const b of buys) boughtUsd.set(b.wallet, (boughtUsd.get(b.wallet) || 0) + b.usd);
  return {
    boughtUsd,
    buys,
    coverage: {
      collectorRowsMatched: a.length,
      walletLogFilesRead: bRes.files,
      onChainHoldersScanned: onChainScanned,
      holdersTotal: holders.length,
      buysAfterDedupe: buys.length,
      valuation: "log rows carry their own USD value; on-chain buys are valued as tokens received x round-close token price",
      note: "collector swaps log is a smart-money sample and per-wallet logs cover tracked wallets only; the on-chain ATA scan is the authoritative source for swap buys (vault-delta test) but only sees the canonical pump/PumpSwap vaults — post-graduation buys routed through other DEXs leave no vault trace and are missed by the on-chain source",
    },
    truncatedWallets,
  };
}

// Combined derivation for a round. Returns:
// { lastSellAt: Map wallet->ms, coverage: {...}, truncatedWallets: [] }
export async function collectSells({ mint, holders, sinceMs, cfg }) {
  const merged = new Map();
  const merge = (m) => { for (const [w, t] of m) if (t > (merged.get(w) || 0)) merged.set(w, t); };

  const a = await sellsFromCollector(mint, sinceMs);
  merge(a.last);
  const b = await sellsFromWalletLogs(mint, holders.map((h) => h.owner), sinceMs);
  merge(b.last);

  const truncatedWallets = [];
  let onChainScanned = 0;
  if (cfg.onChainSellScan) {
    for (const h of holders) {
      try {
        const r = await sellsOnChainForHolder(mint, h.owner, sinceMs, cfg.sellScanMaxSignatures);
        onChainScanned++;
        if (r.truncated) truncatedWallets.push(h.owner);
        if (r.lastSellMs && r.lastSellMs > (merged.get(h.owner) || 0)) merged.set(h.owner, r.lastSellMs);
      } catch { /* RPC hiccup for one holder — flagged via coverage count */ }
    }
  }
  return {
    lastSellAt: merged,
    coverage: {
      collectorRowsMatched: a.rows,
      walletLogFilesRead: b.files,
      onChainHoldersScanned: onChainScanned,
      holdersTotal: holders.length,
      note: "collector swaps log is a smart-money sample (LSCAN V1/V2 absent); per-wallet logs cover tracked wallets only; on-chain ATA scan is the authoritative fallback and is capped per wallet",
    },
    truncatedWallets,
  };
}
