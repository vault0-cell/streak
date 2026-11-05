// Survivor Engine — chain/price helpers. READ-ONLY: every function here is a
// query. Nothing in this toolkit signs or sends anything.
import { PublicKey } from "@solana/web3.js";
import { measureFees, bondingCurvePda, ataAddress, LAMPORTS, rpc as plainRpc } from "../feelock/lib.mjs";

export { measureFees, bondingCurvePda, ataAddress, LAMPORTS, PublicKey };
export const WSOL = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const INCINERATOR = "1nc1nerator11111111111111111111111111111111";

// Prefer the shared solbot RPC router (Helius-backed, usage-budgeted); fall
// back to the feelock plain RPC helper if the router is unavailable.
let solbotRpc = null;
try {
  ({ rpc: solbotRpc } = await import("../rpc.mjs"));
} catch { /* router unavailable — fallback below */ }

export async function rpc(method, params) {
  if (solbotRpc) {
    try { return await solbotRpc(method, params, { prio: "critical", timeoutMs: 30_000 }); }
    catch { /* fall through to plain RPC */ }
  }
  return plainRpc(method, params, 30_000);
}

export async function getMintProgram(mint) {
  const info = await rpc("getAccountInfo", [mint, { encoding: "base64" }]);
  return info?.value?.owner || TOKEN_PROGRAM;
}

export async function getMintDecimals(mint) {
  try {
    const sup = await rpc("getTokenSupply", [mint]);
    if (Number.isInteger(sup?.value?.decimals)) return sup.value.decimals;
  } catch { /* default below */ }
  return 6; // pump.fun tokens are 6 decimals (verified via getTokenSupply on LSCAN V2)
}

export async function getPrices(mint) {
  // Jupiter lite price API (same source solbot uses via tools/jupprice.mjs).
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint},${WSOL}`, { signal: AbortSignal.timeout(8_000) });
    if (r.ok) {
      const j = await r.json();
      const t = Number(j?.[mint]?.usdPrice), s = Number(j?.[WSOL]?.usdPrice);
      if (t > 0 && s > 0) return { tokenUsd: t, solUsd: s, source: "jupiter-lite-v3" };
    }
  } catch { /* try fallback */ }
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(8_000) });
    if (r.ok) {
      const j = await r.json();
      const p = j?.pairs?.[0];
      const t = Number(p?.priceUsd), s = t && p?.priceNative ? t / Number(p.priceNative) : null;
      if (t > 0) return { tokenUsd: t, solUsd: s, source: "dexscreener" };
    }
  } catch { /* no price */ }
  return { tokenUsd: null, solUsd: null, source: null };
}

// Jupiter swap quote (QUOTE ONLY — used to estimate the buyback size).
// Bonding-curve tokens usually have no Jupiter route before graduation;
// callers must treat null as "no route" (see DESIGN.md).
export async function jupiterQuoteSolToToken(mint, amountLamports) {
  try {
    const u = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${WSOL}&outputMint=${mint}&amount=${amountLamports}&slippageBps=300`;
    const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.outAmount) return null;
    return { outAmountRaw: j.outAmount, inAmount: j.inAmount, priceImpactPct: j.priceImpactPct ?? null };
  } catch { return null; }
}

export async function getLatestBlockhash() {
  const [bh, slot] = await Promise.all([
    rpc("getLatestBlockhash", [{ commitment: "finalized" }]),
    rpc("getSlot", [{ commitment: "finalized" }]),
  ]);
  return { blockhash: bh.value.blockhash, slot };
}

export const fmtSol = (lamports) => (Number(lamports) / LAMPORTS).toFixed(9).replace(/0+$/, "").replace(/\.$/, ".0");
export const short = (a) => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
