// gta6-trophy-rarity-forecast-01 — earners/players decomposition forecaster.
//
// Forecast, for every GTA VI (PS5) trophy, five quantiles of its Exophase earn
// rate at the case's target. Node 22, standard library only, deterministic,
// no network, no randomness.
//
// Model (everything is estimated from the case file alone):
//
//   rate_i(t) = E_i(t) / N(t)
//
// where N(t) is the players Exophase tracks for the game and E_i(t) the number
// of them holding trophy i. The two move for different reasons, so they are
// forecast separately and recombined:
//
//   * N(t): log N is fit against log(1 + hours since launch) on the case's
//     *distinct* snapshots (consecutive reads with identical counts are one
//     snapshot: Exophase only changes its page when it refreshes, so the
//     flat stretches between refreshes carry no information). A linear
//     fit of log N against hours is NOT used: extrapolated 3x past the
//     data it explodes (on a synthetic power-law case it predicted
//     billions of tracked players), so the power-law fit alone is kept,
//     clamped to [N_last, 20 * N_last].
//   * E_i(t): log(E_i + 0.5) is fit against log(1 + hours since launch) per
//     trophy, its slope shrunk toward the cross-trophy median slope and
//     clamped to [0, 2] (earners do not fall). A trophy nobody has earned yet
//     is forecast from the 0.5 smoothing alone.
//   * Direct check: logit(rate_i) against log(1 + hours) per trophy (the
//     house curve baseline's shape), slope shrunk toward the median and
//     clamped to [-1, 1.5].
//   * Both trend fits are *damped*: they are evaluated only halfway, in
//     log-time, from the last read to the target. Early launch growth is
//     the fastest a trophy ever grows — story trophies saturate as the
//     players who will finish them do so, and new players dilute the
//     pool — so a straight log-time line extrapolated to the target
//     overshoots. Half-distance damping is the standard damped-trend
//     hedge; the blend with persistence below is the other half of it.
//   * Median: the trend forecast (mean of the decomposition and the direct
//     fit, in logit space) is blended with persistence at the last read,
//     with weight nDistinct / (nDistinct + 2) on the trend, so a case with
//     no movement at all mostly persists, and a case with many refreshes
//     mostly follows the trend.
//   * Flat history (a single distinct snapshot): no trend can be estimated.
//     The kit's RULES.txt documents Exophase's first refresh of this game:
//     tracked players 638 -> 3,868 (x6.06) with every rate but the one at
//     100% lower. A flat page means a refresh is pending, so the trend used
//     there is the decomposition with N multiplied by 6.06 and earners held
//     fixed. This is a prior from the documented refresh, not a fitted number.
//   * Spread: a logit sigma per trophy from a base term, a random-walk term
//     growing with sqrt(horizon), the direct fit's residual, the expected
//     dilution |log(N_pred / N_last)|, an extra term when the history is
//     flat, and a small-count term. Quantiles are the normal quantiles of
//     the median logit at the case's levels.
//
// What the model does NOT do: it never invents a player count or a trophy
// rate from outside the case file, and it never calls a model or the network.
// Every number above that is not estimated from the case is labelled here as
// a prior and documented in README.md.
//
// Input:  every <id>.in in $MAKEFUN_INPUT_DIR (else /input).
// Output: <id>.out in $MAKEFUN_OUTPUT_DIR (else /output):
//         {"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}, ...]}
//
// Run locally:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** Launch instant: the game's release date, 2026-11-19T00:00:00Z. */
const LAUNCH_MS = Date.parse('2026-11-19T00:00:00Z');
/**
 * Documented first refresh of this game's Exophase page (RULES.txt):
 * players tracked 638 -> 3,868. Used only as the dilution prior when a
 * case's history is a single distinct snapshot.
 */
const FIRST_REFRESH_N_MULT = 3868 / 638;
/** Largest tracked-player growth the N forecast is allowed to predict. */
const MAX_N_MULT = 20;
/** Damped-trend factor: trend fits are evaluated this fraction of the
 *  log-time distance from the last read to the target (see header). */
const DAMP = 0.35;
/** Smallest / largest rate (percent) a logit is ever taken of. */
const RATE_MIN = 0.01;
const RATE_MAX = 99.99;

interface Trophy {
  id: number;
  tier: string;
}
interface Read {
  at?: string;
  slot?: string;
  players_tracked?: number;
  rates?: Array<number | null>;
}
interface Case {
  id: string;
  levels: number[];
  horizon_minutes: number;
  target: string;
  game?: { release_date?: string };
  trophies: Trophy[];
  history: Read[];
}

const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));
const clampRate = (x: number): number => clamp(x, RATE_MIN, RATE_MAX);
const logit = (pct: number): number => {
  const p = clampRate(pct) / 100;
  return Math.log(p / (1 - p));
};
const sigmoidPct = (l: number): number =>
  100 / (1 + Math.exp(-clamp(l, -9.21, 9.21)));
/** x rounded to 4 decimals, as the starter rounds it. */
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
/** Hours from launch to a millisecond timestamp (never below 0.01). */
const hoursSinceLaunch = (ms: number): number =>
  Math.max(0.01, (ms - LAUNCH_MS) / 3600000);
/** The log-time regressor: log(1 + hours since launch). */
const logTime = (ms: number): number => Math.log(1 + hoursSinceLaunch(ms));

interface Fit {
  a: number;
  b: number;
  residRms: number;
  n: number;
}

/** Ordinary least squares of y on x; returns intercept, slope, residual RMS. */
function ols(xs: number[], ys: number[]): Fit {
  const n = xs.length;
  if (n === 0) return { a: 0, b: 0, residRms: 0, n: 0 };
  if (n === 1) return { a: ys[0], b: 0, residRms: 0, n: 1 };
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (a + b * xs[i]);
    ss += r * r;
  }
  return { a, b, residRms: Math.sqrt(ss / n), n };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Fallback week-one rate (percent) by tier, used only when a trophy has no
 * usable rate anywhere in the case's history. These are priors, not
 * measurements: platinum is the rarest, bronze the commonest. The spread
 * for such a trophy is set wide (see forecastCase).
 */
function tierFallbackPct(tier: string): number {
  if (tier === 'platinum') return 0.5;
  if (tier === 'gold') return 3;
  if (tier === 'silver') return 8;
  return 15; // bronze
}

interface Snapshot {
  ms: number;
  players: number;
  rates: Array<number | null>;
}

/** Collapse the history to distinct snapshots (identical consecutive reads). */
function distinctSnapshots(c: Case): Snapshot[] {
  const out: Snapshot[] = [];
  for (const r of c.history) {
    const ms = Date.parse(r.at ?? r.slot ?? '');
    if (!Number.isFinite(ms)) continue;
    const players = typeof r.players_tracked === 'number' && r.players_tracked > 0
      ? r.players_tracked
      : NaN;
    const rates = (r.rates ?? []).slice(0, c.trophies.length);
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      prev.players === players &&
      prev.rates.length === rates.length &&
      prev.rates.every((v, i) => v === rates[i])
    ) {
      continue; // same page as the previous read: no new information
    }
    out.push({ ms, players, rates });
  }
  return out;
}

function forecastCase(c: Case): { trophies: Array<{ id: number; q: number[] }> } {
  if (
    c.levels.length !== LEVELS.length ||
    c.levels.some((t, j) => t !== LEVELS[j])
  ) {
    throw new Error(`${c.id} asks for levels ${JSON.stringify(c.levels)}`);
  }
  if (c.history.length === 0) {
    throw new Error(`${c.id} has no history`);
  }
  const snaps = distinctSnapshots(c);
  const nDistinct = snaps.length;
  const last = snaps[snaps.length - 1];
  const horizonDays = Math.max(0, c.horizon_minutes / 1440);
  const targetMs = Date.parse(c.target);
  const xTarget = Number.isFinite(targetMs)
    ? logTime(targetMs)
    : logTime(last.ms) + Math.log(1 + c.horizon_minutes / 60);

  // ---- Tracked players N(t): power-law (log-log) fit only --------------
  const nSnaps = snaps.filter((s) => Number.isFinite(s.players));
  let logNPred: number;
  let nFit: Fit | null = null;
  if (nSnaps.length >= 2) {
    const xs = nSnaps.map((s) => logTime(s.ms));
    const ys = nSnaps.map((s) => Math.log(s.players));
    nFit = ols(xs, ys);
    logNPred = clamp(
      nFit.a + nFit.b * xTarget,
      Math.log(last.players),
      Math.log(last.players) + Math.log(MAX_N_MULT),
    );
  } else if (Number.isFinite(last.players)) {
    // One distinct snapshot: no growth can be estimated. Use the documented
    // first-refresh multiplier as the dilution prior (see header).
    logNPred = Math.log(last.players) + Math.log(FIRST_REFRESH_N_MULT);
  } else {
    logNPred = 0; // no player counts at all: the decomposition is skipped
    // (the per-trophy branch requires finite player counts), so this
    // value is never used as a denominator.
  }
  const nPred = Math.exp(logNPred);
  const dilution = Number.isFinite(last.players) && last.players > 0
    ? Math.abs(logNPred - Math.log(last.players))
    : 0;

  // ---- Per-trophy fits --------------------------------------------------
  // Direct logit fit and earners fit, with slopes shrunk to the median.
  const directFits: Array<Fit | null> = [];
  const earnerFits: Array<Fit | null> = [];
  const lastRate: Array<number | null> = [];
  const lastX: number[] = [];
  const lastEarners: Array<number> = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const xs: number[] = [];
    const ysLogit: number[] = [];
    const ysLogE: number[] = [];
    let lr: number | null = null;
    let lx = logTime(last.ms);
    let lp = last.players;
    for (const s of snaps) {
      const r = s.rates[i];
      if (r === null || r === undefined || !Number.isFinite(r)) continue;
      lr = r;
      lx = logTime(s.ms);
      lp = s.players;
      xs.push(logTime(s.ms));
      ysLogit.push(logit(r));
      const earners = Number.isFinite(s.players)
        ? (r / 100) * s.players
        : NaN;
      ysLogE.push(Math.log((Number.isFinite(earners) ? earners : 0) + 0.5));
    }
    lastRate.push(lr);
    lastX.push(lx);
    lastEarners.push(
      lr !== null && Number.isFinite(lp) ? (lr / 100) * lp : 0,
    );
    directFits.push(xs.length >= 2 ? ols(xs, ysLogit) : null);
    earnerFits.push(xs.length >= 2 ? ols(xs, ysLogE) : null);
  }
  const medianDirectSlope = median(
    directFits.filter((f): f is Fit => f !== null).map((f) => f.b),
  );
  const medianEarnerSlope = median(
    earnerFits.filter((f): f is Fit => f !== null).map((f) => f.b),
  );
  // Shrinkage weight: with k points, the trophy's own slope gets k/(k+3).
  // Only the slope is returned: both forecasts below are anchored at the
  // last observed value, so no stale intercept can shift the line.
  const shrinkSlope = (fit: Fit, med: number, lo: number, hi: number): number => {
    const w = fit.n / (fit.n + 3);
    return clamp(w * fit.b + (1 - w) * med, lo, hi);
  };

  const wTrend = nDistinct / (nDistinct + 2);
  const rows: Array<{ id: number; q: number[] }> = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const t = c.trophies[i];
    const lr = lastRate[i];
    let medianLogit: number;
    let sigma: number;
    let resid = 0;
    if (lr === null) {
      // No usable rate anywhere: tier prior, wide spread.
      medianLogit = logit(tierFallbackPct(t.tier));
      sigma = 1.2;
    } else {
      const persist = logit(lr);
      const dFit = directFits[i];
      const eFit = earnerFits[i];
      // Trend from whichever components the case actually supports: the
      // direct logit fit (needs 2+ reads), and the decomposition (needs
      // player counts). A component that is missing is left out rather
      // than fed a made-up number — with no player counts at all, the
      // decomposition would divide by a meaningless N.
      let trendLogit: number | null = null;
      const xLast = lastX[i];
      const dx = DAMP * (xTarget - xLast);
      if (dFit !== null) {
        const bDirect = shrinkSlope(dFit, medianDirectSlope, -1, 1.5);
        resid = dFit.residRms;
        // Anchored at the last observed value; only DAMP of the way to
        // the target (damped trend, see header).
        trendLogit = persist + bDirect * dx;
      }
      if (eFit !== null && Number.isFinite(last.players) && last.players > 0 && nPred > 0) {
        const bEarner = shrinkSlope(eFit, medianEarnerSlope, 0, 2);
        const eLast = Math.max(lastEarners[i], 0);
        const logEPred = Math.log(eLast + 0.5) + bEarner * dx;
        // N at the same damped time as the earners (not the full target),
        // so the decomposition does not double-count dilution.
        const xDamped = xLast + dx;
        const logNDamped = nFit !== null
          ? clamp(nFit.a + nFit.b * xDamped, Math.log(last.players), logNPred)
          : logNPred;
        const decompPct = clampRate((Math.exp(logEPred) / Math.exp(logNDamped)) * 100);
        trendLogit = trendLogit === null
          ? logit(decompPct)
          : (trendLogit + logit(decompPct)) / 2;
      }
      if (trendLogit !== null) {
        medianLogit = wTrend * trendLogit + (1 - wTrend) * persist;
      } else if (nDistinct <= 1) {
        // Flat history: trend is the documented-refresh dilution
        // (earners held fixed, N x6.06), blended with persistence.
        const dilutedPct = clampRate(lr / FIRST_REFRESH_N_MULT);
        medianLogit = wTrend * logit(dilutedPct) + (1 - wTrend) * persist;
      } else {
        medianLogit = persist;
      }
      // Special case: a trophy every tracked player holds (100%). Its
      // logit is censored at 99.99; the blend above already pulls it down
      // only as far as the trend warrants. Nothing extra is needed.
      // Coefficients below are 0.8x the first draft's: the synthetic
      // sweep (dev/sweep.mjs) found the draft spread too wide in every
      // world (90% coverage 1.00), while a narrower band would not
      // survive a real Exophase refresh jump, so 0.8x is the compromise.
      sigma =
        0.2 +
        0.16 * Math.sqrt(horizonDays) +
        0.4 * Math.min(resid, 0.8) +
        0.16 * Math.min(dilution, 1.7) +
        (nDistinct <= 1 ? 0.36 : 0) +
        (lastEarners[i] < 10 ? 0.08 : 0);
      sigma = clamp(sigma, 0.2, 1.2);
    }
    const qs: number[] = [];
    let prev = -Infinity;
    for (const z of Z) {
      let q = round4(sigmoidPct(medianLogit + z * sigma));
      q = clamp(q, RATE_MIN, RATE_MAX);
      if (q < prev) q = prev; // keep the row non-decreasing after rounding
      qs.push(q);
      prev = q;
    }
    rows.push({ id: t.id, q: qs });
  }
  return { trophies: rows };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const out = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(out)}\n`);
}
