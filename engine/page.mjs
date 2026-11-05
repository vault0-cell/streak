#!/usr/bin/env node
// Survivor Engine — public page generator.
//   node page.mjs --data-dir <dir> [--out <file.html>]
// Renders state.json + recent round reports into ONE static HTML file:
// dark theme, inline CSS, zero external assets. Everything shown is the
// engine's own public record: jackpot size, totals burned, streak
// leaderboard, recent rounds, winners and the latest payout list.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "../feelock/lib.mjs";
import { fmtSol, short } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const dataDir = args["data-dir"];
if (!dataDir) { console.error("missing --data-dir"); process.exit(1); }
const state = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
const roundsDir = path.join(dataDir, "rounds");
const roundFiles = fs.existsSync(roundsDir)
  ? fs.readdirSync(roundsDir).filter((f) => f.endsWith(".json")).sort().slice(-10).reverse()
  : [];
const rounds = roundFiles.map((f) => JSON.parse(fs.readFileSync(path.join(roundsDir, f), "utf8")));
const latest = rounds[0];

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sol = (l) => `${fmtSol(l)} SOL`;

const leaderboard = Object.entries(state.wallets)
  .map(([wallet, w]) => ({ wallet, ...w }))
  .filter((w) => (w.streak || 0) > 0)
  .sort((a, b) => b.streak - a.streak || (b.balanceUsd || 0) - (a.balanceUsd || 0))
  .slice(0, 20);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Survivor Engine — ${esc(short(state.mint))}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0e14; color:#e6e9ef; font:15px/1.55 ui-sans-serif,system-ui,sans-serif; }
  main { max-width:920px; margin:0 auto; padding:28px 18px 64px; }
  h1 { font-size:26px; margin:0 0 4px; } h2 { font-size:18px; margin:30px 0 10px; color:#f5c542; }
  .sub { color:#8b93a3; font-size:13px; word-break:break-all; }
  .banner { background:#3a2b12; border:1px solid #f5c542; color:#ffd968; border-radius:10px; padding:10px 14px; margin:16px 0; font-weight:600; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-top:14px; }
  .card { background:#131826; border:1px solid #232a3d; border-radius:12px; padding:14px; }
  .card .k { color:#8b93a3; font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  .card .v { font-size:22px; font-weight:700; margin-top:4px; }
  table { width:100%; border-collapse:collapse; background:#131826; border:1px solid #232a3d; border-radius:12px; overflow:hidden; }
  th, td { padding:8px 10px; text-align:left; font-size:13px; border-bottom:1px solid #1d2436; }
  th { color:#8b93a3; font-weight:600; } tr:last-child td { border-bottom:none; }
  .mono { font-family:ui-monospace,Menlo,monospace; font-size:12px; }
  .gold { color:#f5c542; } .muted { color:#8b93a3; }
</style>
</head>
<body>
<main>
  <h1>🔥 Survivor Engine</h1>
  <div class="sub">Token <span class="mono">${esc(state.mint)}</span> · Creator <span class="mono">${esc(state.creator)}</span></div>
  <div class="banner">SIMULATION — this page renders engine simulation data. No fees have been claimed, burned or paid out on-chain.</div>

  <div class="cards">
    <div class="card"><div class="k">Jackpot pool</div><div class="v gold">${esc(sol(state.jackpotPoolLamports))}</div></div>
    <div class="card"><div class="k">Burned (buyback, sim)</div><div class="v">${esc(sol(state.totals.burnSolLamports))}</div></div>
    <div class="card"><div class="k">Paid to survivors (sim)</div><div class="v">${esc(sol(state.totals.survivorPaidLamports))}</div></div>
    <div class="card"><div class="k">Jackpot paid (sim)</div><div class="v">${esc(sol(state.totals.jackpotPaidLamports))}</div></div>
    <div class="card"><div class="k">Rounds run</div><div class="v">${state.round}</div></div>
  </div>

  <h2>🏆 Streak leaderboard</h2>
  ${leaderboard.length ? `<table><tr><th>#</th><th>Wallet</th><th>Streak (rounds)</th><th>Balance</th><th>Last sell</th></tr>
  ${leaderboard.map((w, i) => `<tr><td>${i + 1}</td><td class="mono">${esc(short(w.wallet))}</td><td>${w.streak}</td><td>$${w.balanceUsd ? w.balanceUsd.toFixed(2) : "—"}</td><td>${w.lastSellAt ? esc(new Date(w.lastSellAt).toISOString()) : "never"}</td></tr>`).join("\n")}</table>`
  : `<p class="muted">No active streaks yet.</p>`}

  <h2>🎰 Jackpot winners</h2>
  ${state.winners.length ? `<table><tr><th>Round</th><th>Winner</th><th>Amount</th><th>Blockhash</th></tr>
  ${[...state.winners].reverse().map((w) => `<tr><td>${w.round}</td><td class="mono">${esc(short(w.wallet))}</td><td class="gold">${esc(sol(w.lamports))}</td><td class="mono">${esc(short(w.blockhash))}</td></tr>`).join("\n")}</table>`
  : `<p class="muted">No draw yet — the pool is building.</p>`}

  <h2>📜 Recent rounds</h2>
  <table><tr><th>Round</th><th>Time (UTC)</th><th>Pot</th><th>Holders</th><th>Survivors</th><th>Paid</th><th>Jackpot after</th></tr>
  ${rounds.map((r) => `<tr><td>${r.round}</td><td>${esc(r.atIso)}</td><td>${esc(sol(r.pot.lamports))}</td><td>${r.snapshot.holders}</td><td>${r.survivors.length}</td><td>${esc(sol(r.survivors.reduce((a, s) => a + (s.payableLamports || 0), 0)))}</td><td>${esc(sol(r.jackpot.poolLamportsAfter))}</td></tr>`).join("\n")}
  </table>

  ${latest ? `<h2>💸 Latest payout list (round #${latest.round})</h2>
  ${latest.payoutBatches.length ? latest.payoutBatches.map((b) => `<p class="muted">Batch ${b.tx} — ${b.recipients} recipients, ${esc(sol(b.totalLamports))}</p><table><tr><th>Wallet</th><th>Amount</th></tr>${b.payments.map((p) => `<tr><td class="mono">${esc(p.wallet)}</td><td>${esc(sol(p.lamports))}</td></tr>`).join("\n")}</table>`).join("\n") : `<p class="muted">No payouts at or above the 0.0001 SOL dust threshold in the latest round.</p>`}` : ""}

  <p class="sub" style="margin-top:34px">Rules: every round, newly claimed creator fees split 50% buyback &amp; burn · 30% to survivors (held ≥ $20, no sells for 48h) weighted by √balance · 20% to the jackpot, drawn among survivors weighted by √balance × streak. Full rules in DESIGN.md.</p>
</main>
</body>
</html>`;

const out = args.out || path.join(dataDir, "page.html");
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} bytes)`);
