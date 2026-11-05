// Survivor Engine — Buy Boost integration tests. Run: node --test test/boost.round.test.mjs
// Drives round.mjs (fixture mode, simulation) through three rounds with
// five wallets designed to pin down the boost semantics:
//   ALICE buys $25 in round 2            -> boosted in round 2 ONLY
//   BOB   never buys                     -> unboosted control
//   CAROL buys $4.99 in round 2          -> below the $5 floor, NOT boosted
//   DAVE  buys $50 then SELLS in round 2 -> disqualified, no boost, streak 0
//   ERIN  receives a $100 TRANSFER-IN    -> not a buy, NOT boosted
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUND = path.join(HERE, "..", "round.mjs");
const T0 = 1_793_900_000_000;
const ROUND_MS = 600_000;

const ALICE = "AliceBoost1111111111111111111111111111111111";
const BOB = "BobControl1111111111111111111111111111111111";
const CAROL = "CarolSmall1111111111111111111111111111111111";
const DAVE = "DaveBuySell111111111111111111111111111111111";
const ERIN = "ErinTransfer11111111111111111111111111111111";

const holder = (owner) => ({ owner, balanceRaw: "50000000000", balanceUi: 50_000 }); // $100 at $0.002

const fixture = {
  mint: "BoostFixtureMint111111111111111111111111111",
  creator: "BoostFixtureCreator111111111111111111111111",
  potSol: 0.5,
  tokenUsd: 0.002,
  solUsd: 95,
  decimals: 6,
  blockhash: "BoostFixtureBlockhash11111111111111111111111",
  slot: 465_600_000,
  t0: T0,
  holders: [holder(ALICE), holder(BOB), holder(CAROL), holder(DAVE), holder(ERIN)],
  sells: [{ wallet: DAVE, atMs: T0 + 400_000 }],
  buys: [
    { wallet: ALICE, atMs: T0 + 300_000, usd: 25 },
    { wallet: CAROL, atMs: T0 + 300_000, usd: 4.99 },
    { wallet: DAVE, atMs: T0 + 200_000, usd: 50 },
  ],
  transfersIn: [{ wallet: ERIN, atMs: T0 + 300_000, usd: 100 }],
};

let dir, dataDir;
function runRound(now) {
  execFileSync("node", [ROUND, "--fixture", path.join(dir, "fixture.json"), "--data-dir", dataDir, "--now", String(now), "--simulate"],
    { stdio: "pipe" });
}
function report(n) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "rounds", `round-${String(n).padStart(4, "0")}.json`), "utf8"));
}
function state() {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
}
const surv = (r, w) => r.survivors.find((s) => s.wallet === w);
const nonSurv = (r, w) => r.nonSurvivors.find((s) => s.wallet === w);

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "survivor-boost-"));
  dataDir = path.join(dir, "data");
  fs.writeFileSync(path.join(dir, "fixture.json"), JSON.stringify(fixture, null, 2));
  runRound(T0);
  runRound(T0 + ROUND_MS);
  runRound(T0 + 2 * ROUND_MS);
});

test("round 1: no buys in window -> nobody boosted, equal shares", () => {
  const r = report(1);
  assert.equal(r.survivors.length, 5);
  assert.deepEqual(r.buyBoost.boostedWallets, []);
  for (const s of r.survivors) {
    assert.equal(s.boosted, false);
    assert.equal(s.boughtUsd, 0);
    assert.equal(s.shareLamports, 30_000_000); // 0.15 SOL pool / 5 equal weights
  }
});

test("round 2: ALICE boosted x1.5 (share exactly 1.5x the unboosted survivors)", () => {
  const r = report(2);
  const alice = surv(r, ALICE);
  assert.equal(alice.boosted, true);
  assert.equal(alice.boostMultiplier, 1.5);
  assert.equal(alice.boughtUsd, 25);
  assert.equal(alice.shareLamports, 50_000_000); // weight ratio 1.5:1:1:1 of 0.15 SOL
  const others = [BOB, CAROL, ERIN].map((w) => surv(r, w));
  for (const o of others) assert.equal(o.boosted, false);
  const otherTotal = others.reduce((a, o) => a + o.shareLamports, 0);
  assert.equal(otherTotal, 100_000_000);
  for (const o of others) assert.ok(Math.abs(alice.shareLamports - o.shareLamports * 1.5) <= 1, "within 1 lamport of exact 1.5x");
  assert.deepEqual(r.buyBoost.boostedWallets, [{ wallet: ALICE, boughtUsd: 25, boostMultiplier: 1.5 }]);
});

test("round 2: CAROL's $4.99 buy is under the floor — recorded, not boosted", () => {
  const carol = surv(report(2), CAROL);
  assert.equal(carol.boughtUsd, 4.99);
  assert.equal(carol.boosted, false);
  assert.equal(carol.boostMultiplier, 1);
});

test("round 2: ERIN's $100 transfer-in is NOT a buy — no boost, boughtUsd stays 0", () => {
  const r = report(2);
  const erin = surv(r, ERIN);
  assert.equal(erin.boughtUsd, 0);
  assert.equal(erin.boosted, false);
  // ... but the transfer is visible in the audit trail
  assert.deepEqual(r.buyBoost.transfersInObserved, [{ wallet: ERIN, atMs: T0 + 300_000, usd: 100 }]);
});

test("round 2: DAVE bought $50 then sold — disqualified, no boost, streak reset", () => {
  const r = report(2);
  assert.equal(surv(r, DAVE), undefined);
  const dave = nonSurv(r, DAVE);
  assert.equal(dave.reason, "sold_in_window");
  assert.equal(dave.boughtUsd, 50); // the buy is on record...
  assert.equal(dave.boosted, false); // ...but earns nothing
  assert.equal(state().wallets[DAVE].streak, 0); // was 1 after round 1
});

test("round 3: boost does NOT persist — ALICE is a plain survivor again", () => {
  const r = report(3);
  const alice = surv(r, ALICE);
  assert.equal(alice.boosted, false);
  assert.equal(alice.boughtUsd, 0);
  assert.deepEqual(r.buyBoost.boostedWallets, []);
  // the four survivors split equally again
  assert.equal(r.survivors.length, 4);
  for (const s of r.survivors) assert.equal(s.shareLamports, 37_500_000);
});
