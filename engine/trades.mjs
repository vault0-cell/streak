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
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { rpc, ataAddress, getMintProgram } from "./lib.mjs";
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
