// Generates test/fixture.json — ~30 synthetic wallets exercising every rule:
//   - 12 medium/large survivors (no sells, $50-$5000)
//   - 6 small survivors ($20-$49)
//   - 2 survivors who sold 100h ago (outside the 48h window)
//   - 4 recent sellers (sold 6h before T0 -> NOT survivors)
//   - 4 below the $20 minimum (NOT survivors)
//   - 2 dust-sized survivors whose shares stay under the payout threshold
//   - 1 of the survivors swap-buys $40 during round 2 (Buy Boost demo)
// Token price $0.002, SOL $95. Pot 0.5 SOL per round.
import fs from "node:fs";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let seed = 1234567;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const addr = () => Array.from({ length: 44 }, () => B58[Math.floor(rnd() * 58)]).join("");
const T0 = 1_793_900_000_000;
const TOKEN_USD = 0.002;
const mk = (usd) => {
  const tokens = usd / TOKEN_USD;
  return { owner: addr(), balanceRaw: String(Math.round(tokens * 1e6)), balanceUi: tokens };
};

const holders = [];
const sells = [];
const groups = { survivor: 0, smallSurvivor: 0, oldSeller: 0, recentSeller: 0, belowMin: 0, dust: 0 };

for (let i = 0; i < 12; i++) { holders.push(mk(50 + Math.floor(rnd() * 4950))); groups.survivor++; }
for (let i = 0; i < 6; i++) { holders.push(mk(20 + Math.floor(rnd() * 29))); groups.smallSurvivor++; }
for (let i = 0; i < 2; i++) { const w = mk(120 + Math.floor(rnd() * 300)); holders.push(w); sells.push({ wallet: w.owner, atMs: T0 - 100 * 3_600_000 }); groups.oldSeller++; }
for (let i = 0; i < 4; i++) { const w = mk(80 + Math.floor(rnd() * 400)); holders.push(w); sells.push({ wallet: w.owner, atMs: T0 - 6 * 3_600_000 }); groups.recentSeller++; }
for (let i = 0; i < 4; i++) { holders.push(mk(3 + Math.floor(rnd() * 16))); groups.belowMin++; }
// Dust survivors: exactly at the $20 floor with tiny sqrt weight vs whales.
for (let i = 0; i < 2; i++) { holders.push(mk(20)); groups.dust++; }

// Buy Boost demo: the first (largest-group) survivor swap-buys $40 five
// minutes into round 2 (rounds run at T0, T0+600s, T0+1200s), so round 2
// shows it boosted x1.5 while rounds 1 and 3 show it unboosted.
const buys = [{ wallet: holders[0].owner, atMs: T0 + 300_000, usd: 40 }];

const fixture = {
  mint: "FixtureMint1111111111111111111111111111111",
  creator: "FixtureCreator11111111111111111111111111111",
  potSol: 0.5,
  tokenUsd: TOKEN_USD,
  solUsd: 95,
  decimals: 6,
  blockhash: "FixtureBlockhashForDeterministicDraw1111111111",
  slot: 465_500_000,
  t0: T0,
  groups,
  holders,
  sells,
  buys,
};
fs.writeFileSync(new URL("./fixture.json", import.meta.url), JSON.stringify(fixture, null, 2));
console.log(`fixture: ${holders.length} holders, ${sells.length} sells, ${buys.length} buys (boost demo: ${buys[0].wallet} buys $${buys[0].usd} in round 2), groups=${JSON.stringify(groups)}`);
console.log(`expected survivors at T0: ${groups.survivor + groups.smallSurvivor + groups.oldSeller + groups.dust}`);
