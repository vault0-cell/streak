// Survivor Engine — holder snapshot from public chain state.
// pump.fun create_v2 tokens are Token-2022 mints (verified live on LSCAN V2:
// the mint is owned by TokenzQd...), so BOTH token programs are enumerated.
// Infrastructure balances (bonding curve, AMM pool, burn address, programs)
// are excluded from the holder set and reported separately.
import { PublicKey } from "@solana/web3.js";
import {
  rpc, getMintProgram, getMintDecimals, bondingCurvePda, TOKEN_PROGRAM, TOKEN2022_PROGRAM,
  PUMP_PROGRAM, PUMPSWAP_PROGRAM, INCINERATOR, WSOL,
} from "./lib.mjs";

// Canonical PumpSwap pool PDA: seeds ["pool", index u16 LE, creator, base, quote].
function pumpSwapPoolPda(creator, mint) {
  try {
    const idx = Buffer.alloc(2); idx.writeUInt16LE(0);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), idx, new PublicKey(creator).toBuffer(), new PublicKey(mint).toBuffer(), new PublicKey(WSOL).toBuffer()],
      new PublicKey(PUMPSWAP_PROGRAM),
    )[0].toBase58();
  } catch { return null; }
}

export async function snapshotHolders(mint, creator, cfg) {
  const [mintProgram, decimals] = await Promise.all([getMintProgram(mint), getMintDecimals(mint)]);
  const curvePda = bondingCurvePda(new PublicKey(mint)).toBase58();
  const poolPda = creator ? pumpSwapPoolPda(creator, mint) : null;

  const excludedOwners = new Map(); // owner -> reason
  excludedOwners.set(curvePda, "bonding_curve");
  if (poolPda) excludedOwners.set(poolPda, "amm_pool");
  excludedOwners.set(INCINERATOR, "burn_address");
  excludedOwners.set(PUMP_PROGRAM, "pump_program");
  excludedOwners.set(PUMPSWAP_PROGRAM, "pumpswap_program");
  excludedOwners.set(mint, "mint_account");
  if (cfg.excludeCreator && creator) excludedOwners.set(creator, "creator_excluded");
  for (const w of cfg.extraExcludeOwners || []) excludedOwners.set(w, "config_exclude");
  // The engine wallet itself never earns (set at go-live via env/config).
  if (process.env.SURVIVOR_ENGINE_WALLET) excludedOwners.set(process.env.SURVIVOR_ENGINE_WALLET, "engine_wallet");

  const byOwner = new Map(); // owner -> { balanceRaw: BigInt, accounts: n }
  const seenPrograms = new Set();
  for (const programId of [TOKEN_PROGRAM, TOKEN2022_PROGRAM]) {
    // memcmp at offset 0 = mint field. No dataSize filter: Token-2022
    // accounts with extensions are longer than 165 bytes.
    const accts = await rpc("getProgramAccounts", [programId, {
      encoding: "jsonParsed",
      filters: [{ memcmp: { offset: 0, bytes: mint } }],
    }]);
    for (const a of accts || []) {
      const info = a.account?.data?.parsed?.info;
      if (!info?.owner || !info?.tokenAmount) continue;
      seenPrograms.add(programId);
      const amt = BigInt(info.tokenAmount.amount);
      if (amt === 0n) continue;
      const cur = byOwner.get(info.owner) || { balanceRaw: 0n, accounts: 0 };
      cur.balanceRaw += amt;
      cur.accounts += 1;
      byOwner.set(info.owner, cur);
    }
  }

  const holders = [];
  const infra = [];
  for (const [owner, v] of byOwner) {
    const row = {
      owner,
      balanceRaw: v.balanceRaw.toString(),
      balanceUi: Number(v.balanceRaw) / 10 ** decimals,
      accounts: v.accounts,
    };
    if (excludedOwners.has(owner)) infra.push({ ...row, reason: excludedOwners.get(owner) });
    else holders.push(row);
  }
  holders.sort((a, b) => (Number(BigInt(b.balanceRaw) - BigInt(a.balanceRaw))) || (a.owner < b.owner ? -1 : 1));
  return { mint, mintProgram, decimals, tokenProgramsSeen: [...seenPrograms], holders, infraExcluded: infra };
}
