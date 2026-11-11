// Seeded report: builds data/round1.json (the demo's Round 1 evals) and results/results.json
// (every number the README, the email and the app's validation panel quote).
// Run: node scripts/report.mjs        (deterministic; CI checks results.json is unchanged)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "../src/coverage.mjs";
import * as S from "../src/scenario.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const R2 = S.SCENARIO.round2Budget, BATCH = C.PLAN_DEFAULTS.batch;

function observeCells(U, evals) {
  return S.observe(U, evals).map((o, i) => ({
    ...o, risk: U[i].risk.id, attack: U[i].attack.id, ...C.summarise(o.n, o.counts),
  }));
}
function trueMissing(U, obs) {
  return U.map((c, i) => c.modes.filter((m) => !obs[i].counts[m.id]).reduce((s, m) => s + m.p, 0));
}

// ---- policies for the follow-up budget (Round 2 or a quarterly round): all read the same streams
function runPolicy(U, obs, policy, seed) {
  const st = obs.map((o) => ({ n: o.n, counts: { ...o.counts }, used: 0 }));
  const streams = U.map((c) => S.evalStream(c, "r2", R2, seed));
  let found = 0, severe = 0;
  const take = (i, m) => {
    for (let r = 0; r < m; r++) {
      const e = streams[i][st[i].used++];
      st[i].n++;
      if (!e.mode) continue;
      if (!st[i].counts[e.mode]) {
        found++;
        const mode = U[i].modes.find((x) => x.id === e.mode);
        if (mode.severity === "P1" || mode.severity === "P0") severe++;
      }
      st[i].counts[e.mode] = (st[i].counts[e.mode] || 0) + 1;
    }
  };
  const cellsNow = () => st.map((x, i) => ({
    id: obs[i].id, risk: obs[i].risk, attack: obs[i].attack, n: x.n,
    ...C.summarise(x.n, x.counts),
  }));
  if (policy === "proportional") {
    C.proportionalAllocate(obs.map((o) => o.share), R2).forEach((m, i) => take(i, m));
  } else if (policy === "chaoGreedy") {
    C.greedyAllocate(cellsNow(), R2, { step: 5 }).m.forEach((m, i) => take(i, m));
  } else if (policy === "goodUcb" || policy === "ebGoodUcb") {
    for (let b = 0; b < R2 / BATCH; b++) {
      const opts = policy === "goodUcb" ? { kappa: 0, c: 0.35 } : {};
      C.planBatch(cellsNow(), opts).alloc.forEach((m, i) => take(i, m));
    }
  } else if (policy === "oracle") {
    const unseen = U.map((c, i) => c.modes.filter((m) => !obs[i].counts[m.id]).map((m) => m.p));
    const val = (i, m) => unseen[i].reduce((s, p) => s + 1 - Math.pow(1 - p, m), 0);
    const alloc = new Array(U.length).fill(0);
    for (let j = 0; j < R2; j++) {
      let best = 0, bv = -1;
      alloc.forEach((m, i) => { const g = val(i, m + 1) - val(i, m); if (g > bv) { bv = g; best = i; } });
      alloc[best]++;
    }
    alloc.forEach((m, i) => take(i, m));
  }
  return { found, severe };
}
const POLICIES = ["proportional", "chaoGreedy", "goodUcb", "ebGoodUcb", "oracle"];
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 1e4) / 1e4;

// ---- 1. The demo universe and its Round 1
const U = S.universe();
const round1 = U.flatMap((c) => S.evalStream(c, "r1", c.n));
const obs = observeCells(U, round1);
const scope = C.scopeMissingMass(obs);
const tm = trueMissing(U, obs);
const trueScope = U.reduce((s, c, i) => s + c.share * tm[i], 0);
const fails = obs.reduce((s, o) => s + o.fails, 0);
const f1 = obs.reduce((s, o) => s + o.f1, 0);
const seen = obs.reduce((s, o) => s + o.sObs, 0);
const chaoUnseen = obs.reduce((s, o) => s + C.chao1Unseen(o.n, o.f1, o.f2), 0);
const firstBatch = C.planBatch(obs.map((o) => ({ ...o })));

// ---- 2. Policies on the demo universe (300 follow-up streams)
const STREAMS = 300;
const demoPolicies = {};
for (const p of POLICIES) {
  const runs = Array.from({ length: STREAMS }, (_, s) => runPolicy(U, obs, p, s + 1));
  demoPolicies[p] = { newModes: r2(mean(runs.map((r) => r.found))), newSevereModes: r2(mean(runs.map((r) => r.severe))) };
}

// ---- 3. Robustness: fresh universes the planner was not tuned on
const UNIVERSES = 30, PER = 15;
const robust = Object.fromEntries(POLICIES.map((p) => [p, []]));
let wins = 0;
for (let u = 0; u < UNIVERSES; u++) {
  const Uu = S.universe(910000 + u);
  const r1u = Uu.flatMap((c) => S.evalStream(c, "r1", c.n, 910000 + u));
  const ou = observeCells(Uu, r1u);
  const per = {};
  for (const p of POLICIES) {
    const v = mean(Array.from({ length: PER }, (_, s) => runPolicy(Uu, ou, p, 5000 + s).found));
    robust[p].push(v);
    per[p] = v;
  }
  if (per.ebGoodUcb > per.proportional) wins++;
}
const robustMeans = Object.fromEntries(POLICIES.map((p) => [p, r2(mean(robust[p]))]));

// ---- 4. Calibration of the Good-Turing / Esty interval (scope level and per cell)
const CAL = 200;
let scopeCovered = 0, cellCovered = 0, cellTotal = 0;
let absErr = 0;
for (let s = 0; s < CAL; s++) {
  const r1s = U.flatMap((c) => S.evalStream(c, "r1", c.n, 700000 + s));
  const os = observeCells(U, r1s);
  const sc = C.scopeMissingMass(os);
  const tms = trueMissing(U, os);
  const tsc = U.reduce((acc, c, i) => acc + c.share * tms[i], 0);
  if (tsc >= sc.lo && tsc <= sc.hi) scopeCovered++;
  absErr += Math.abs(sc.est - tsc);
  os.forEach((o, i) => {
    if (o.fails < 5) return; // per-cell intervals only reported once a cell has 5+ failures
    const e = C.estyInterval(o.n, o.f1, o.f2);
    cellTotal++;
    if (tms[i] >= e.lo && tms[i] <= e.hi) cellCovered++;
  });
}

const gainDemo = demoPolicies.ebGoodUcb.newModes / demoPolicies.proportional.newModes - 1;
const gainRobust = robustMeans.ebGoodUcb / robustMeans.proportional - 1;
const results = {
  generated: "seeded; node scripts/report.mjs",
  scenario: { ...S.SCENARIO, cells: U.length, modesInUniverse: U.reduce((s, c) => s + c.M, 0) },
  round1: {
    evals: round1.length, failingEvals: fails, modesSeen: seen, singletons: f1,
    chao1UnseenModes: r2(chaoUnseen), trueUnseenModes: U.reduce((s, c, i) => s + c.M - obs[i].sObs, 0),
    failureCoverage: r4(C.failureCoverage(fails, f1)),
    scopeNewModeProbability: { est: r4(scope.est), lo: r4(scope.lo), hi: r4(scope.hi), truth: r4(trueScope) },
    firstBatchPlan: Object.fromEntries(firstBatch.alloc.map((m, i) => [obs[i].id, m]).filter(([, m]) => m > 0)),
  },
  followUp: {
    budget: R2, batch: BATCH, streams: STREAMS, demoUniverse: demoPolicies,
    robustness: { universes: UNIVERSES, streamsPerUniverse: PER, newModes: robustMeans, ebBeatsProportionalIn: wins },
  },
  calibration: {
    replicates: CAL, scopeIntervalCoverage: r4(scopeCovered / CAL), scopeMeanAbsError: r4(absErr / CAL),
    cellIntervalCoverage: r4(cellCovered / cellTotal), cellIntervalsChecked: cellTotal,
  },
  headline: {
    newModesPlanned: demoPolicies.ebGoodUcb.newModes,
    newModesProportional: demoPolicies.proportional.newModes,
    gainPct: Math.round(gainDemo * 100),
    gainPctFreshUniverses: Math.round(gainRobust * 100),
    sentence: `Same ${R2} follow-up evals: ${demoPolicies.ebGoodUcb.newModes} new failure modes with the coverage plan vs ${demoPolicies.proportional.newModes} with a proportional split (+${Math.round(gainDemo * 100)}%).`,
  },
};

fs.mkdirSync(path.join(root, "results"), { recursive: true });
fs.mkdirSync(path.join(root, "data"), { recursive: true });
fs.writeFileSync(path.join(root, "results/results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results.headline, null, 2));
console.log(JSON.stringify({ round1: results.round1, cal: results.calibration, demo: demoPolicies, robust: results.followUp.robustness }, null, 2));
