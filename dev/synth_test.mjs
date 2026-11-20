// Multi-world synthetic backtest for main.ts (dev-only, not part of entry).
// Three worlds, same protocol: 2 days of 30-min reads, Exophase-style
// refresh steps every ~6h, target Nov 26 (horizon 6510 min from Nov 21 11:30).
//   A saturating:  rate_i = s_i * (1 - exp(-k_i h));  N = 800 (1+h)^1.35
//   B log-linear:  rate_i = a_i * log(1+h), capped at 95; N = 800 (1+h)^1.35
//   C dilution:    rate_i = s_i * (1 - exp(-k_i h)) with slow k, N = 800 (1+h)^1.9
//                  (N grows ~12x to target while shares barely move -> rates fall)
// Scores main.ts vs the starter baseline with the contest's pinball loss on
// the logit scale. A model that only wins one world is overfit; the goal is
// to beat (or match) the starter on average across worlds.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const T0 = Date.parse('2026-11-19T00:00:00Z');
const H = 3600000;
const D = '/home/hatch/workspace/makefun/bounties/gta6-trophy-rarity-forecast-01';
const KIT = D + '/kit/gta6-trophy-rarity-forecast-01-kit';
const clamp = (x) => Math.min(99.99, Math.max(0.01, x));
const logit = (x) => { const p = clamp(x) / 100; return Math.log(p / (1 - p)); };

function makeRng(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }

function buildWorld(name, nExp, rateFn) {
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
  const c = {
    schema: 'makefun/gta6-trophies-case/v1', id: 'synth', at: '2026-11-21T11:30:00Z',
    horizon_minutes: (targetMs - Date.parse('2026-11-21T11:30:00Z')) / 60000,
    target: '2026-11-26T00:00:00Z', levels: [0.05, 0.25, 0.5, 0.75, 0.95],
    game: { name: 'Grand Theft Auto VI', platform: 'PS5', release_date: '2026-11-19', source: 'https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/' },
    trophies: trophies.map(({ id, name, description, tier, points, secret }) => ({ id, name, description, tier, points, secret })),
    history, notes: 'synthetic ' + name,
  };
  return { c, truth, nLast: history[history.length - 1].players_tracked, nTarget: Math.round(N(168)) };
}

function score(outFile, truth) {
  const f = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  let loss = 0, n = 0, cover = 0, miss = 0, medErr = 0;
  for (const row of f.trophies) {
    const y = truth[row.id - 1];
    const qs = row.q;
    if (y >= qs[0] && y <= qs[4]) cover++;
    miss += Math.abs(y - qs[2]);
    medErr += Math.abs(logit(y) - logit(qs[2]));
    for (let j = 0; j < 5; j++) {
      const tau = [0.05, 0.25, 0.5, 0.75, 0.95][j];
      const d = logit(y) - logit(qs[j]);
      loss += 2 * Math.max(tau * d, (tau - 1) * d);
      n++;
    }
  }
  return { pinball: loss / n, cover: cover / 55, miss: miss / 55, medErr: medErr / 55 };
}

const worlds = [
  ['A saturating', 1.35, (tr, h) => tr.s * (1 - Math.exp(-tr.k * h)) * 100],
  ['B log-linear', 1.35, (tr, h) => Math.min(95, tr.s * 100 * Math.log(1 + h) / 5.13)],
  ['C dilution  ', 1.9, (tr, h) => tr.s * (1 - Math.exp(-tr.k * h)) * 100 * Math.pow((1 + h) / 61, -0.3)],
];
const results = {};
for (const [name, nExp, rateFn] of worlds) {
  const { c, truth, nLast, nTarget } = buildWorld(name, nExp, rateFn);
  fs.mkdirSync('/tmp/synth/in', { recursive: true });
  fs.mkdirSync('/tmp/synth/out_mine', { recursive: true });
  fs.mkdirSync('/tmp/synth/out_base', { recursive: true });
  fs.writeFileSync('/tmp/synth/in/synth.in', JSON.stringify(c));
  execFileSync('node', ['main.ts'], { cwd: D, env: { ...process.env, MAKEFUN_INPUT_DIR: '/tmp/synth/in', MAKEFUN_OUTPUT_DIR: '/tmp/synth/out_mine' }, stdio: 'pipe' });
  execFileSync('node', ['starter/main.ts'], { cwd: KIT, env: { ...process.env, MAKEFUN_INPUT_DIR: '/tmp/synth/in', MAKEFUN_OUTPUT_DIR: '/tmp/synth/out_base' }, stdio: 'pipe' });
  const m = score('/tmp/synth/out_mine/synth.out', truth);
  const b = score('/tmp/synth/out_base/synth.out', truth);
  results[name] = { mine: m.pinball, base: b.pinball };
  console.log(`${name}: N ${nLast} -> ${nTarget} | mine pinball=${m.pinball.toFixed(4)} cover=${m.cover.toFixed(2)} miss=${m.miss.toFixed(2)}pp medErr=${m.medErr.toFixed(3)} | starter pinball=${b.pinball.toFixed(4)} cover=${b.cover.toFixed(2)} miss=${b.miss.toFixed(2)}pp medErr=${b.medErr.toFixed(3)}`);
}
const avg = (k) => Object.values(results).reduce((s, r) => s + r[k], 0) / 3;
console.log(`MEAN pinball: mine=${avg('mine').toFixed(4)} starter=${avg('base').toFixed(4)}`);
