import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as C from "../src/coverage.mjs";
import * as S from "../src/scenario.mjs";

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test("frequency of frequencies and summary", () => {
  const counts = { a: 1, b: 1, c: 2, d: 5 };
  assert.deepEqual(C.freqOfFreqs(counts), [0, 2, 1, 0, 0, 1]);
  const s = C.summarise(100, counts);
  assert.deepEqual({ fails: s.fails, sObs: s.sObs, f1: s.f1, f2: s.f2 }, { fails: 9, sObs: 4, f1: 2, f2: 1 });
});

test("Good-Turing is singletons over sample size; Esty interval brackets it", () => {
  close(C.goodTuring(200, 10), 0.05);
  const e = C.estyInterval(200, 10, 4);
  close(e.est, 0.05);
  close(e.se, Math.sqrt(10 * (1 - 10 / 200) + 8) / 200);
  assert.ok(e.lo < e.est && e.est < e.hi && e.lo >= 0 && e.hi <= 1);
  assert.equal(C.estyInterval(50, 0, 0).hi, 0); // nothing seen once: degenerate at zero
});

test("Chao1 bias-corrected forms (f2 > 0 and f2 = 0)", () => {
  close(C.chao1Unseen(100, 6, 3), (99 / 100) * 36 / 6);
  close(C.chao1Unseen(100, 4, 0), (99 / 100) * (4 * 3) / 2);
  assert.equal(C.chao1Unseen(100, 0, 5), 0);
});

test("Chao-Jost expected new modes is increasing, concave and capped by Chao1", () => {
  const n = 120, f1 = 7, f2 = 2;
  const f0 = C.chao1Unseen(n, f1, f2);
  let prev = 0, prevGain = Infinity;
  for (let m = 5; m <= 2000; m += 5) {
    const v = C.expectedNew(n, f1, f2, m);
    const gain = v - prev;
    assert.ok(gain >= -1e-12 && gain <= prevGain + 1e-12, `concave at m=${m}`);
    assert.ok(v <= f0 + 1e-9);
    prev = v; prevGain = gain;
  }
  // first-eval yield equals the Good-Turing chance (the extrapolation is anchored to it)
  close(C.expectedNew(n, f1, f2, 1), f0 * (f1 / (n * f0 + f1)));
});

test("Good-Turing is unbiased-ish for the missing mass (randomised, known distribution)", () => {
  // Zipf universe; E[GT] - E[missing mass] = E[sum p^2 (1-p)^(n-1)] >= 0 and small.
  const rng = C.mulberry32(42);
  const M = 40, p = Array.from({ length: M }, (_, j) => Math.pow(j + 1, -1.1));
  const Z = p.reduce((a, b) => a + b, 0) / 0.3; // 30% of evals fail
  const probs = p.map((v) => v / Z);
  const n = 400, R = 400;
  let gt = 0, mm = 0;
  for (let r = 0; r < R; r++) {
    const counts = {};
    for (let i = 0; i < n; i++) {
      let u = rng();
      for (let j = 0; j < M; j++) { if ((u -= probs[j]) < 0) { counts[j] = (counts[j] || 0) + 1; break; } }
    }
    const s = C.summarise(n, counts);
    gt += C.goodTuring(n, s.f1);
    mm += probs.reduce((acc, q, j) => acc + (counts[j] ? 0 : q), 0);
  }
  gt /= R; mm /= R;
  assert.ok(gt >= mm - 0.002, `GT ${gt} vs missing ${mm}`);
  assert.ok(Math.abs(gt - mm) < 0.006, `GT ${gt} vs missing ${mm}`);
});

test("greedy allocation is optimal for the concave objective (randomised vs brute force)", () => {
  const rng = C.mulberry32(7);
  for (let trial = 0; trial < 25; trial++) {
    const cells = Array.from({ length: 3 }, () => {
      const n = 20 + Math.floor(rng() * 200);
      return { n, f1: 1 + Math.floor(rng() * 8), f2: Math.floor(rng() * 4) };
    });
    const B = 10 * (2 + Math.floor(rng() * 6));
    const g = C.greedyAllocate(cells, B, { step: 10 });
    let best = -1;
    for (let a = 0; a <= B; a += 10) for (let b = 0; a + b <= B; b += 10) {
      const v = C.expectedNewTotal(cells, [a, b, B - a - b]);
      if (v > best) best = v;
    }
    assert.ok(g.expected >= best - 1e-9, `trial ${trial}: greedy ${g.expected} < brute ${best}`);
  }
});

test("allocations respect the budget, floors and caps", () => {
  const cells = [{ n: 50, f1: 5, f2: 1 }, { n: 80, f1: 1, f2: 3 }, { n: 30, f1: 0, f2: 0 }];
  const g = C.greedyAllocate(cells, 103, { step: 5, floors: [10, 10, 10], caps: [60, 60, 60] });
  assert.equal(g.m.reduce((a, b) => a + b, 0), 103);
  g.m.forEach((m) => assert.ok(m >= 10 && m <= 60));
  assert.deepEqual(C.proportionalAllocate([0.5, 0.3, 0.2], 7).reduce((a, b) => a + b, 0), 7);
});

test("planBatch spends exactly one batch and favours thinly tested cells with singletons", () => {
  const cells = [
    { id: "a", risk: "R1", attack: "A1", n: 400, f1: 2 },
    { id: "b", risk: "R1", attack: "A2", n: 30, f1: 3 },
    { id: "c", risk: "R2", attack: "A1", n: 400, f1: 0 },
    { id: "d", risk: "R2", attack: "A2", n: 30, f1: 1 },
  ];
  const { alloc, priors } = C.planBatch(cells, { batch: 100 });
  assert.equal(alloc.reduce((x, y) => x + y, 0), 100);
  assert.ok(alloc[1] > alloc[0] && alloc[1] > alloc[2]);
  priors.forEach((p) => assert.ok(p >= 0 && p <= 1));
});

test("rarefaction is exact at the ends and monotone", () => {
  const counts = [5, 3, 1, 1];
  assert.equal(C.rarefaction(100, counts, 100), 4);
  close(C.rarefaction(100, counts, 0), 0);
  let prev = 0;
  for (let k = 0; k <= 100; k += 5) { const v = C.rarefaction(100, counts, k); assert.ok(v >= prev - 1e-12); prev = v; }
  // single mode seen once: present in a k-subsample with probability k/n
  close(C.rarefaction(50, [1], 10), 10 / 50, 1e-9);
});

test("scenario follows AIUC-1's illustrative scope and is deterministic", () => {
  const cells = S.cells();
  assert.equal(cells.length, 35);
  assert.equal(cells.reduce((s, c) => s + c.n, 0), 2400);
  const byRisk = Object.fromEntries(S.RISKS.map((r) => [r.id, cells.filter((c) => c.risk.id === r.id).reduce((s, c) => s + c.n, 0)]));
  // 40/20/20/10/10, up to one eval of rounding per risk from per-cell largest-remainder rounding
  for (const r of S.RISKS) assert.ok(Math.abs(byRisk[r.id] - r.share * 2400) <= 1, `${r.id}: ${byRisk[r.id]}`);
  const U1 = S.universe(), U2 = S.universe();
  assert.deepEqual(S.evalStream(U1[20], "r1", 50), S.evalStream(U2[20], "r1", 50));
  U1.forEach((c) => close(c.modes.reduce((s, m) => s + m.p, 0), c.rate, 1e-12));
});

test("every number on the page traces to results.json (headline + round 1)", () => {
  const res = JSON.parse(fs.readFileSync(new URL("../results/results.json", import.meta.url)));
  const U = S.universe();
  const r1 = U.flatMap((c) => S.evalStream(c, "r1", c.n));
  const obs = S.observe(U, r1).map((o, k) => ({ ...o, ...C.summarise(o.n, o.counts), risk: U[k].risk.id, attack: U[k].attack.id }));
  const sc = C.scopeMissingMass(obs);
  assert.equal(res.round1.evals, 2400);
  assert.equal(res.round1.modesSeen, obs.reduce((s, o) => s + o.sObs, 0));
  assert.equal(res.round1.singletons, obs.reduce((s, o) => s + o.f1, 0));
  close(res.round1.scopeNewModeProbability.est, Math.round(sc.est * 1e4) / 1e4);
  const h = res.headline;
  assert.equal(h.gainPct, Math.round((h.newModesPlanned / h.newModesProportional - 1) * 100));
  assert.equal(h.gainPctFreshUniverses, Math.round((res.followUp.robustness.newModes.ebGoodUcb / res.followUp.robustness.newModes.proportional - 1) * 100));
  assert.ok(h.gainPctFreshUniverses > 0 && res.followUp.robustness.ebBeatsProportionalIn >= 20);
  // the planner never beats the oracle
  assert.ok(res.followUp.robustness.newModes.oracle >= res.followUp.robustness.newModes.ebGoodUcb);
});

test("calibration in the committed results is reported, not assumed", () => {
  const res = JSON.parse(fs.readFileSync(new URL("../results/results.json", import.meta.url)));
  const c = res.calibration;
  assert.ok(c.scopeIntervalCoverage > 0.85 && c.scopeIntervalCoverage <= 1);
  assert.ok(c.cellIntervalCoverage > 0.85 && c.cellIntervalCoverage <= 1);
  assert.ok(res.round1.chao1UnseenModes <= res.round1.trueUnseenModes, "Chao1 is a lower bound here");
});

test("discovery curve joins the observed rarefaction to the extrapolation", () => {
  const counts = [4, 2, 1, 1, 1];
  const pts = C.discoveryCurve(80, counts, 200, 20);
  assert.equal(pts[0].y, 0);
  const atN = pts.find((p) => p.k === 80);
  assert.equal(atN.y, 5);
  const last = pts[pts.length - 1];
  assert.ok(last.y > 5 && last.y <= 5 + C.chao1Unseen(80, 3, 1) + 1e-9);
});
