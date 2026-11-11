// Failure-Mode Coverage: core statistics (pure functions; shared by the app, the seeded data script
// and the tests).
//
// AIUC-1 evals run thousands of risk x attack simulations and the platform groups failing transcripts
// into failure modes (one mechanism, e.g. "follows a fake system note inside a tool response"). The
// questions this answers for each risk x attack cell, and for the whole scope:
//   1. How likely is the next eval to surface a failure mode we have not seen?  (Good-Turing, with
//      Esty's normal-approximation interval)
//   2. How many failure modes are still unseen?                                   (Chao1, bias-corrected)
//   3. How many new modes would m more evals in this cell find?                   (Chao-Jost / Shen
//      extrapolation, concave in m)
//   4. Where should the next B evals go?  Maximise expected new modes. The objective is a sum of concave
//      functions, so the greedy marginal allocation is exactly optimal (checked against brute force).
// Sequential alternative used in the simulations: Good-UCB (Bubeck, Ernst & Garivier 2013).

// ---------------------------------------------------------------- random numbers
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------- frequency counts
// modeCounts: Map or object mode -> times seen (failing evals only). Returns f[k] = #modes seen k times.
export function freqOfFreqs(modeCounts) {
  const f = [0];
  for (const c of Object.values(modeCounts)) {
    if (c <= 0) continue;
    while (f.length <= c) f.push(0);
    f[c]++;
  }
  return f;
}
export function summarise(n, modeCounts) {
  const f = freqOfFreqs(modeCounts);
  const f1 = f[1] || 0, f2 = f[2] || 0;
  const sObs = Object.values(modeCounts).filter((c) => c > 0).length;
  const fails = Object.values(modeCounts).reduce((s, c) => s + c, 0);
  return { n, fails, sObs, f1, f2 };
}

// ---------------------------------------------------------------- estimators
// Good-Turing: probability that the next eval reveals a failure mode never seen before.
export function goodTuring(n, f1) {
  return n > 0 ? f1 / n : 1;
}
// Esty (1983) normal limit for the Good-Turing estimator: Var ~ (f1 (1 - f1/n) + 2 f2) / n^2.
export function estyInterval(n, f1, f2, z = 1.96) {
  const g = goodTuring(n, f1);
  if (n <= 0) return { est: 1, lo: 0, hi: 1, se: Infinity };
  const se = Math.sqrt(Math.max(0, f1 * (1 - f1 / n) + 2 * f2)) / n;
  return { est: g, lo: Math.max(0, g - z * se), hi: Math.min(1, g + z * se), se };
}
// Chao1 (bias-corrected form, Chao 2005): estimated number of failure modes not yet seen.
export function chao1Unseen(n, f1, f2) {
  if (n <= 1 || f1 === 0) return 0;
  const k = (n - 1) / n;
  return f2 > 0 ? k * (f1 * f1) / (2 * f2) : k * (f1 * (f1 - 1)) / 2;
}
// Expected number of new failure modes found by m more evals (Shen, Chao & Lin 2003; Chao & Jost 2012):
//   U(m) = f0 [1 - (1 - f1 / (n f0 + f1))^m]
// Concave and increasing in m, bounded by the estimated unseen count f0.
export function expectedNew(n, f1, f2, m) {
  if (m <= 0 || f1 === 0) return 0;
  const f0 = chao1Unseen(n, f1, f2);
  if (f0 <= 0) return 0;
  const p = f1 / (n * f0 + f1);
  return f0 * (1 - Math.pow(1 - p, m));
}
// Scope-level probability that a random eval from the scoped mix reveals a new mode, and its interval
// (cells sampled independently, so variances add).
export function scopeMissingMass(cells, z = 1.96) {
  let est = 0, v = 0;
  for (const c of cells) {
    const e = estyInterval(c.n, c.f1, c.f2, z);
    est += c.share * e.est;
    v += (c.share * e.se) ** 2;
  }
  const se = Math.sqrt(v);
  return { est, lo: Math.max(0, est - z * se), hi: Math.min(1, est + z * se), se };
}
// Share of failing evals whose mode had already been seen elsewhere in the sample (Good-Turing sample
// coverage restricted to failures): 1 - f1 / fails.
export function failureCoverage(fails, f1) {
  return fails > 0 ? 1 - f1 / fails : 1;
}

// ---------------------------------------------------------------- planning
// Greedy marginal allocation of `budget` evals (in units of `step`) across cells to maximise
// sum_c U_c(m_c) subject to floors and caps. U_c is concave, so the greedy choice is optimal for the
// step grid (exchange argument; verified against brute force in the tests).
export function greedyAllocate(cells, budget, { step = 5, floors = null, caps = null } = {}) {
  const K = cells.length;
  const m = floors ? floors.slice() : new Array(K).fill(0);
  let left = budget - m.reduce((s, v) => s + v, 0);
  if (left < 0) throw new Error("floors exceed budget");
  const val = (k, mm) => expectedNew(cells[k].n, cells[k].f1, cells[k].f2, mm);
  while (left >= step) {
    let best = -1, bestGain = -Infinity;
    for (let k = 0; k < K; k++) {
      if (caps && m[k] + step > caps[k]) continue;
      const g = val(k, m[k] + step) - val(k, m[k]);
      if (g > bestGain + 1e-15) { bestGain = g; best = k; }
    }
    if (best < 0) break;
    m[best] += step;
    left -= step;
  }
  // remainder smaller than one step goes to the best single-unit gain
  while (left > 0) {
    let best = 0, bestGain = -Infinity;
    for (let k = 0; k < K; k++) {
      if (caps && m[k] + 1 > caps[k]) continue;
      const g = val(k, m[k] + 1) - val(k, m[k]);
      if (g > bestGain) { bestGain = g; best = k; }
    }
    m[best] += 1;
    left -= 1;
  }
  const expected = m.reduce((s, mm, k) => s + val(k, mm), 0);
  return { m, expected };
}
export function proportionalAllocate(shares, budget) {
  const raw = shares.map((s) => s * budget);
  const base = raw.map(Math.floor);
  let rem = budget - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let j = 0; rem > 0; j = (j + 1) % order.length, rem--) base[order[j][1]]++;
  return base;
}
export function expectedNewTotal(cells, m) {
  return m.reduce((s, mm, k) => s + expectedNew(cells[k].n, cells[k].f1, cells[k].f2, mm), 0);
}

// Good-UCB index (Bubeck, Ernst & Garivier 2013): pick the cell maximising f1/n + c sqrt(log t / n).
export function goodUcbIndex(n, f1, t, c = 0.5) {
  if (n === 0) return Infinity;
  return f1 / n + c * Math.sqrt(Math.log(Math.max(2, t)) / n);
}

// ---------------------------------------------------------------- rarefaction / extrapolation curve
// Expected number of distinct modes in a subsample of size k <= n (exact rarefaction, Hurlbert 1971):
//   S(k) = sum_j [1 - C(n - X_j, k) / C(n, k)]
// and for k > n the Chao-Jost extrapolation S(n) + U(k - n). Used for the discovery-curve chart.
function logChoose(a, b) {
  if (b < 0 || b > a) return -Infinity;
  return lgammaInt(a + 1) - lgammaInt(b + 1) - lgammaInt(a - b + 1);
}
const LG = [0];
function lgammaInt(x) {
  // log((x-1)!) for integer x >= 1
  while (LG.length < x) LG.push(LG[LG.length - 1] + Math.log(LG.length));
  return LG[x - 1];
}
export function rarefaction(n, counts, k) {
  if (k >= n) return counts.filter((c) => c > 0).length;
  let s = 0;
  const lnk = logChoose(n, k);
  for (const x of counts) {
    if (x <= 0) continue;
    s += 1 - Math.exp(logChoose(n - x, k) - lnk);
  }
  return s;
}
export function discoveryCurve(n, counts, kMax, points = 40) {
  const f = freqOfFreqs(counts);
  const f1 = f[1] || 0, f2 = f[2] || 0;
  const out = [];
  for (let i = 0; i <= points; i++) {
    const k = Math.round((kMax * i) / points);
    const y = k <= n ? rarefaction(n, counts, k) : counts.filter((c) => c > 0).length + expectedNew(n, f1, f2, k - n);
    out.push({ k, y, observed: k <= n });
  }
  return out;
}

// ---------------------------------------------------------------- empirical-Bayes Good-UCB batches
// Small cells have noisy Good-Turing estimates (a cell with 24 evals and no failures says "0% left to
// find", which is wrong more often than not). Shrink each cell toward a risk x attack prior built
// from the pooled data: prior_c = GT(risk) * GT(attack) / GT(all), then
//   index_c = (f1_c + kappa prior_c) / (n_c + kappa) + c sqrt(log t / n_c)
// and fill a batch one eval at a time, raising n_c "virtually" after each pick (optimism is spent).
export const PLAN_DEFAULTS = { c: 0.2, kappa: 100, batch: 100 };

export function ebPriors(cells) {
  const pool = (key) => {
    const r = new Map();
    for (const c of cells) {
      const k = key(c);
      const o = r.get(k) || { f1: 0, n: 0 };
      o.f1 += c.f1; o.n += c.n;
      r.set(k, o);
    }
    return r;
  };
  const byR = pool((c) => c.risk), byA = pool((c) => c.attack);
  const f1 = cells.reduce((s, c) => s + c.f1, 0), n = cells.reduce((s, c) => s + c.n, 0);
  const g = n ? f1 / n : 0;
  return cells.map((c) => {
    const R = byR.get(c.risk), A = byA.get(c.attack);
    if (!g || !R.n || !A.n) return 0;
    return ((R.f1 / R.n) * (A.f1 / A.n)) / g;
  });
}
export function shrunkGT(c, prior, kappa = PLAN_DEFAULTS.kappa) {
  return (c.f1 + kappa * prior) / (c.n + kappa);
}
// cells: [{ id, risk, attack, n, f1 }]; returns evals per cell for the next batch.
export function planBatch(cells, { batch = PLAN_DEFAULTS.batch, c = PLAN_DEFAULTS.c, kappa = PLAN_DEFAULTS.kappa, t0 = null } = {}) {
  const pri = ebPriors(cells);
  const n = cells.map((x) => x.n);
  const alloc = new Array(cells.length).fill(0);
  let t = t0 ?? n.reduce((a, b) => a + b, 0);
  for (let j = 0; j < batch; j++) {
    let best = 0, bv = -Infinity;
    for (let k = 0; k < cells.length; k++) {
      const ix = (cells[k].f1 + kappa * pri[k]) / (n[k] + kappa) + c * Math.sqrt(Math.log(Math.max(2, t)) / Math.max(1, n[k]));
      if (ix > bv) { bv = ix; best = k; }
    }
    alloc[best]++;
    n[best]++;
    t++;
  }
  return { alloc, priors: pri };
}
