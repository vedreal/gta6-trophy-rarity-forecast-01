# GTA VI Trophy Rarity Forecaster

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/vedreal/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/vedreal/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Entry for [make.fun bounty `gta6-trophy-rarity-forecast-01`](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
— *Forecast how many GTA VI players earn each trophy in week one* ($250, 20 paid places).

Repository: https://github.com/vedreal/gta6-trophy-rarity-forecast-01

## Run it

```sh
node main.ts
```

---

Entered on [make.fun](https://make.fun/?ref=f2pdfak6&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards

## What it does

`main.ts` (Node 22, standard library only, no network, deterministic) reads one
case file `/input/<id>.in` — every Exophase read of GTA VI's PS5 trophy page
before the case checkpoint — and writes `/output/<id>.out`:

```json
{"trophies": [{"id": 1, "q": [q05, q25, q50, q75, q95]}, ...]}
```

five quantiles of each trophy's earn rate (percent of tracked players holding
it) at the case's target. The final case targets **2026-11-26T00:00:00Z**,
6,510 minutes after the 2026-11-21T11:30:00Z deadline. Scoring is mean pinball
loss on the logit scale; a prize needs a loss strictly below the best house
entry (persistence baseline, trend baseline, house AI model).

## Model — earners / players decomposition

A trophy's earn rate is a ratio, and its two parts move for different reasons,
so they are forecast separately and recombined:

```
rate_i(t) = E_i(t) / N(t)
```

- **Tracked players N(t)** — fit `log N` against `log(1 + hours since launch)`
  (power-law adoption) on the case's *distinct* snapshots only. Consecutive
  reads with identical counts are one snapshot: Exophase only changes its page
  when it refreshes, so flat stretches carry no information. Clamped to
  `[N_last, 20 × N_last]`. A linear-in-hours fit of `log N` is deliberately
  **not** used: extrapolated past the data it explodes (on a synthetic
  power-law case it predicted billions of tracked players).
- **Earners E_i(t)** — `log(E_i + 0.5)` against `log(1 + hours)` per trophy,
  slope shrunk toward the cross-trophy median slope (weight `k/(k+3)`) and
  clamped to `[0, 2]` (earners do not fall).
- **Direct check** — `logit(rate_i)` against `log(1 + hours)` per trophy (the
  house curve baseline's shape), slope shrunk toward the median, clamped to
  `[-1, 1.5]`.
- **Damped trend** — both fits are evaluated only 35% of the log-time distance
  from the last read to the target, and the trend is blended with persistence
  at the last read with weight `nDistinct / (nDistinct + 2)`. Early launch
  growth is the fastest a trophy ever grows; a straight line extrapolated to
  the target overshoots saturating story trophies.
- **Flat history** (a single distinct snapshot, as in the practice cases) —
  no trend can be estimated. The kit's `RULES.txt` documents Exophase's first
  refresh of this game: tracked players 638 → 3,868 (×6.06), every rate but
  the one at 100% lower. A flat page means a refresh is pending, so the trend
  used there is the decomposition with earners held fixed and N × 6.06.
  This is a prior from the documented refresh, not a fitted number.
- **Spread** — per-trophy logit sigma from a base term, a term growing with
  `sqrt(horizon)`, the direct fit's residual, expected dilution
  `|log(N_pred / N_last)|`, an extra term for flat history, and a small-count
  term (σ ≈ 0.85 for the final horizon; ≈ 0.9 for a flat practice case).

Everything is estimated from the case file alone. No outside data, no model
calls, no network. See the header comment in `main.ts` for the full spec.

## Assumptions and sources (read before trusting the numbers)

- Data source: Exophase's public PS5 trophy page for GTA VI
  (https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/), as
  recorded by the house and supplied in the case file. No console maker
  publishes player counts; Exophase's tracked players are a self-selected
  sample (early trackers skew hardcore), so rates are not population rates.
- The 638 → 3,868 first-refresh figures and the "every rate but the 100% one
  lower" fact come from the kit's `RULES.txt`, not from measurement by us.
- The trophy at 100% in the practice data ("Just Like Paradise") is taken as
  given; the model keeps its median near 100% with a downward spread, on the
  evidence that it survived the first 6× dilution unchanged.
- No claim is made that the synthetic backtest below predicts the real final:
  the real answer (Nov 26 rates) does not exist yet. The backtest only shows
  the program beats the house persistence baseline on smooth synthetic worlds
  and stays sane on a dilution-dominated one.

## Validation (all local, reproducible)

```sh
# Practice cases (kit input/)
mkdir -p out && MAKEFUN_INPUT_DIR=kit/gta6-trophy-rarity-forecast-01-kit/input \
  MAKEFUN_OUTPUT_DIR=out node main.ts
# -> out/p00.out, out/p01.out: 55 rows each, monotone quantiles in [0,100],
#    2,767 bytes each, byte-identical across two runs, ~0.15 s per run.

# Synthetic backtest (3 worlds: saturating / log-linear / dilution-dominated)
node dev/synth_test.mjs
# Mean pinball loss (logit scale, lower is better):
#   this entry 0.2521 | house persistence baseline 0.2883
#   A saturating 0.254 vs 0.327 | B log-linear 0.228 vs 0.273
#   C dilution 0.274 vs 0.265 (regime-flip world: rates turn down after
#   rising in history; no trend model can foresee the turn from the data)

# Edge cases (single-read history, null rates, all-null trophy, no player
# counts, all-zero rates, zero horizon) — all produce valid output; see
# dev/synth_test.mjs and the /tmp/edge_test.mjs run recorded in STATUS.md.

# Spread / damping sweep that set DAMP=0.35 and the 0.8x sigma scale:
node dev/sweep.mjs
```

`grade-local`: the kit's `RULES.txt` states there is **no local grade** for this
competition ("its scorer and reference data stay on the server"). Running the
kit CLI's `grade-local` was attempted; see `STATUS.md` for the outcome.

## Files

| File | What it is |
|---|---|
| `main.ts` | The entrypoint (Node 22, stdlib only). |
| `LICENSE` | MIT. |
| `.makefun/owner.json` | Claim file: `{"wallet": "Gyqn69Ypdr4oNpEEcDXde87f8Ubqj3P4x6iYSdLwFiXU"}` — the agent wallet on the @f-alamsyah account, which signs entries. Required because the account has no GitHub login linked (see STATUS.md). |
| `README.md` | This file. |
| `STATUS.md` | Build status, blockers, and what kang still needs to do. |
| `dev/synth_test.mjs` | 3-world synthetic backtest (dev-only). |
| `dev/sweep.mjs` | Damping / spread sweep (dev-only). |

The kit itself (`kit/`, `kit.tar.gz`, `competition.json`) is git-ignored and not
part of the entry; it was downloaded from https://make.fun/c/gta6-trophy-rarity-forecast-01/kit
(the plain `/api/competitions/<slug>/kit` endpoint returns only a manifest JSON).
