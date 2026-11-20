// Sigma / DAMP sweep for main.ts (dev-only).
// Reuses the three synthetic worlds from synth_test.mjs (copied generator),
// saves per-world outputs, then:
//  1. rescales each trophy's implied sigma around its median and re-scores
//     (finds the spread scale that minimises mean pinball across worlds);
//  2. (driven externally) DAMP is swept by editing main.ts's DAMP constant.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const T0 = Date.parse('2026-11-19T00:00:00Z');
const H = 3600000;
const D = '/home/hatch/workspace/makefun/bounties/gta6-trophy-rarity-forecast-01';
const KIT = D + '/kit/gta6-trophy-rarity-forecast-01-kit';
const clamp = (x) => Math.min(99.99, Math.max(0.01, x));
const logit = (x) => { const p = clamp(x) / 100; return Math.log(p / (1 - p)); };
const sig = (l) => 100 / (1 + Math.exp(-Math.max(-9.21, Math.min(9.21, l))));
const round4 = (x) => Math.round(x * 10000) / 10000;
function makeRng(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }

function buildWorld(nExp, rateFn) {
  const rnd = makeRng(987654);
  const trophies = [];
  for (let i = 1; i <= 55; i++) {
    let s, k;
    if (i === 1) { s = 0.02; k = 0.004; }
    else if (i <= 7) { s = 0.25 + rnd() * 0.3; k = 0.03 + rnd() * 0.05; }
    else if (i <= 14) { s = 0.15 + rnd() * 0.25; k = 0.02 + rnd() * 0.03; }
    else if (i % 5 === 0) { s = 0.02 + rnd() * 0.05; k = 0.003 + rnd() * 0.005; }
    else { s = 0.05 + rnd() * 0.2; k = 0.01 + rnd() * 0.02; }
    trophies.push({ id: i, name: `Trophy ${i}`, description: '', tier: i === 1 ? 'platinum' : 'bronze', points: 15, secret: false, s, k });
  }
  const N = (h) => 800 * Math.pow(1 + h, nExp);
  const history = [];
  let frozen = null;
  for (let ms = Date.parse('2026-11-18T23:50:00Z'); ms < Date.parse('2026-11-21T11:30:00Z'); ms += 30 * 60000) {
    const h = Math.max(0.01, (ms - T0) / H);
    if (frozen === null || ms - frozen.ms >= 6 * H) {
      frozen = { ms, players: Math.round(N(h)), rates: trophies.map((tr) => Math.round(rateFn(tr, h) * 100) / 100) };
    }
    history.push({ slot: new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'), at: new Date(ms + 30000).toISOString(), players_tracked: frozen.players, trophies_earned: 0, rates: [...frozen.rates] });
  }
  const targetMs = Date.parse('2026-11-26T00:00:00Z');
  const truth = trophies.map((tr) => Math.round(rateFn(tr, (targetMs - T0) / H) * 100) / 100);
  return {
    schema: 'makefun/gta6-trophies-case/v1', id: 'synth', at: '2026-11-21T11:30:00Z',
    horizon_minutes: (targetMs - Date.parse('2026-11-21T11:30:00Z')) / 60000,
    target: '2026-11-26T00:00:00Z', levels: [0.05, 0.25, 0.5, 0.75, 0.95],
    game: { name: 'Grand Theft Auto VI', platform: 'PS5', release_date: '2026-11-19', source: 'https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/' },
    trophies: trophies.map(({ id, name, description, tier, points, secret }) => ({ id, name, description, tier, points, secret })),
    history, notes: 'synthetic',
    _truth: truth,
  };
}

const worlds = [
  ['A', 1.35, (tr, h) => tr.s * (1 - Math.exp(-tr.k * h)) * 100],
  ['B', 1.35, (tr, h) => Math.min(95, tr.s * 100 * Math.log(1 + h) / 5.13)],
  ['C', 1.9, (tr, h) => tr.s * (1 - Math.exp(-tr.k * h)) * 100 * Math.pow((1 + h) / 61, -0.3)],
];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
function pinball(rows, truth, sigmaScale) {
  let loss = 0, n = 0, cover = 0;
  for (const row of rows) {
    const y = truth[row.id - 1];
    const med = logit(row.q[2]);
    const sig0 = (logit(row.q[4]) - logit(row.q[0])) / (2 * 1.645) || 0.5;
    const qs = Z.map((z) => clamp(sig(med + z * sig0 * sigmaScale)));
    if (y >= qs[0] && y <= qs[4]) cover++;
    for (let j = 0; j < 5; j++) {
      const tau = [0.05, 0.25, 0.5, 0.75, 0.95][j];
      const d = logit(y) - logit(qs[j]);
      loss += 2 * Math.max(tau * d, (tau - 1) * d);
      n++;
    }
  }
  return { pinball: loss / n, cover: cover / 55 };
}
const damp = fs.readFileSync(D + '/main.ts', 'utf8').match(/const DAMP = ([0-9.]+)/)[1];
const scales = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1];
const meanByScale = {};
for (const [name, nExp, rateFn] of worlds) {
  const c = buildWorld(nExp, rateFn);
  const truth = c._truth; delete c._truth;
  fs.mkdirSync('/tmp/synth/in', { recursive: true });
  fs.mkdirSync('/tmp/synth/out_mine', { recursive: true });
  fs.mkdirSync('/tmp/synth/out_base', { recursive: true });
  fs.writeFileSync('/tmp/synth/in/synth.in', JSON.stringify(c));
  execFileSync('node', ['main.ts'], { cwd: D, env: { ...process.env, MAKEFUN_INPUT_DIR: '/tmp/synth/in', MAKEFUN_OUTPUT_DIR: '/tmp/synth/out_mine' }, stdio: 'pipe' });
  execFileSync('node', ['starter/main.ts'], { cwd: KIT, env: { ...process.env, MAKEFUN_INPUT_DIR: '/tmp/synth/in', MAKEFUN_OUTPUT_DIR: '/tmp/synth/out_base' }, stdio: 'pipe' });
  const mine = JSON.parse(fs.readFileSync('/tmp/synth/out_mine/synth.out', 'utf8')).trophies;
  const base = JSON.parse(fs.readFileSync('/tmp/synth/out_base/synth.out', 'utf8')).trophies;
  const b = pinball(base, truth, 1.0);
  let line = `DAMP=${damp} world ${name}: starter=${b.pinball.toFixed(4)} | mine:`;
  for (const s of scales) {
    const r = pinball(mine, truth, s);
    line += ` s${s}=${r.pinball.toFixed(4)}(cov${r.cover.toFixed(2)})`;
    meanByScale[s] = (meanByScale[s] ?? 0) + r.pinball / 3;
  }
  console.log(line);
}
console.log(`DAMP=${damp} MEAN mine by sigma scale:`, scales.map((s) => `s${s}=${meanByScale[s].toFixed(4)}`).join(' '));
