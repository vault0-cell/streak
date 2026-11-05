// Survivor Engine — math unit tests. Run: node --test test/math.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPot, allocate, applyDust, batchPlan, jackpotPick, computeStreaks } from "../math.mjs";

const CFG = { burnBps: 5000, survivorBps: 3000, jackpotBps: 2000 };
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test("splitPot: exact 50/30/20 and sums to the pot for many sizes", () => {
  for (const pot of [0, 1, 2, 3, 7, 100, 101, 999_983, 13_576_694, 1_000_000_000]) {
    const s = splitPot(pot, CFG);
    assert.equal(s.burn + s.survivor + s.jackpot, pot, `pot ${pot}`);
  }
  const s = splitPot(1_000_000_000, CFG);
  assert.deepEqual([s.burn, s.survivor, s.jackpot], [500_000_000, 300_000_000, 200_000_000]);
  // The real LSCAN V2 accrued figure (2026-11-05):
  const v2 = splitPot(13_576_694, CFG);
  assert.deepEqual([v2.burn, v2.survivor, v2.jackpot], [6_788_347, 4_073_008, 2_715_339]);
});

test("allocate: sqrt shares sum exactly to the pool", () => {
  // balances 100, 400, 900 -> sqrt weights 10, 20, 30 -> shares 1/6, 2/6, 3/6
  const entries = [
    { key: "a", weight: Math.sqrt(100) },
    { key: "b", weight: Math.sqrt(400) },
    { key: "c", weight: Math.sqrt(900) },
  ];
  const out = allocate(600_000, entries);
  assert.equal(sum([...out.values()]), 600_000);
  assert.deepEqual([out.get("a"), out.get("b"), out.get("c")], [100_000, 200_000, 300_000]);
});

test("allocate: odd lamports still sum exactly; zero weight gets zero", () => {
  const entries = [{ key: "a", weight: 1 }, { key: "b", weight: 1 }, { key: "c", weight: 0 }, { key: "d", weight: 3 }];
  for (const pool of [1, 5, 101, 999_999_937]) {
    const out = allocate(pool, entries);
    assert.equal(sum([...out.values()]), pool, `pool ${pool}`);
    assert.equal(out.get("c"), 0);
  }
  assert.equal(sum([...allocate(0, entries).values()]), 0);
  assert.equal(sum([...allocate(1000, []).values()]), 0);
});

test("applyDust: sub-threshold shares carry until they reach 0.0001 SOL", () => {
  const TH = 100_000;
  // round 1: share 60_000 -> carried
  let r = applyDust(new Map([["w", 60_000]]), new Map(), TH);
  assert.equal(r.payable.get("w") || 0, 0);
  assert.equal(r.carried.get("w"), 60_000);
  // round 2: another 50_000 -> 110_000 payable in full, dust cleared
  r = applyDust(new Map([["w", 50_000]]), r.carried, TH);
  assert.equal(r.payable.get("w"), 110_000);
  assert.equal(r.carried.get("w"), 0);
  // a wallet with no new share keeps its dust untouched
  r = applyDust(new Map(), new Map([["x", 42_000]]), TH);
  assert.equal(r.carried.get("x"), 42_000);
  assert.equal(r.payable.get("x") || 0, 0);
});

test("batchPlan: chunks of at most 18, sorted by amount desc", () => {
  const payable = new Map(Array.from({ length: 40 }, (_, i) => [`w${String(i).padStart(2, "0")}`, 1000 + i]));
  const batches = batchPlan(payable, 18);
  assert.deepEqual(batches.map((b) => b.length), [18, 18, 4]);
  assert.equal(batches[0][0].lamports, 1039); // largest first
  assert.equal(sum(batches.flat().map((p) => p.lamports)), sum([...payable.values()]));
});

test("jackpotPick: single eligible entry always wins; zero weight never wins", () => {
  assert.equal(jackpotPick([{ key: "only", weight: 5 }], "somehash", 1), "only");
  for (let r = 1; r <= 50; r++) {
    const w = jackpotPick([{ key: "zero", weight: 0 }, { key: "real", weight: 2 }], `hash-${r}`, r);
    assert.equal(w, "real");
  }
  // deterministic for the same inputs
  const entries = [{ key: "a", weight: 3 }, { key: "b", weight: 7 }, { key: "c", weight: 11 }];
  assert.equal(jackpotPick(entries, "BH", 42), jackpotPick(entries, "BH", 42));
  // heavier weight wins strictly more often over many blockhashes
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 200; i++) counts[jackpotPick([{ key: "a", weight: 1 }, { key: "b", weight: 3 }], `seed-${i}`, i)]++;
  assert.ok(counts.b > counts.a, JSON.stringify(counts));
});

test("computeStreaks: +1 for survivors, reset to 0 on any miss (incl. a sell)", () => {
  let prev = new Map();
  prev = computeStreaks(prev, new Set(["a", "b"]));
  assert.deepEqual([prev.get("a"), prev.get("b")], [1, 1]);
  prev = computeStreaks(prev, new Set(["a", "b"]));
  assert.deepEqual([prev.get("a"), prev.get("b")], [2, 2]);
  // b sold -> not a survivor this round -> streak resets; a keeps building
  prev = computeStreaks(prev, new Set(["a"]));
  assert.deepEqual([prev.get("a"), prev.get("b")], [3, 0]);
  // b qualifies again -> restarts at 1
  prev = computeStreaks(prev, new Set(["a", "b"]));
  assert.deepEqual([prev.get("a"), prev.get("b")], [4, 1]);
});

test("jackpot weighting shape: sqrt(balance) x streak", () => {
  // wallet X: balance 400 (sqrt 20) x streak 3 = 60; wallet Y: balance 100 (sqrt 10) x streak 1 = 10
  const entries = [
    { key: "x", weight: Math.sqrt(400) * 3 },
    { key: "y", weight: Math.sqrt(100) * 1 },
  ];
  const out = allocate(700_000, entries); // same weighting math the draw uses
  assert.deepEqual([out.get("x"), out.get("y")], [600_000, 100_000]);
});
