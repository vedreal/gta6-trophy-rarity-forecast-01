# STATUS — gta6-trophy-rarity-forecast-01

## Status: BUILT — ready to submit, NOT submitted

The entry is complete and validated locally. Nothing was submitted to
make.fun by this build (per the task: the coordinator handles submission).

## Blocker — CLEARED

- GitHub **vedreal is now linked** to make.fun account @f-alamsyah:
  verified live via `GET /api/me` on 2026-11-20 ~22:37 WIB
  (`github_login: "vedreal"`). Earlier in this build it was still null.
- Intended repo: **https://github.com/vedreal/gta6-trophy-rarity-forecast-01**
  (repo name = bounty slug). It does **not** exist on GitHub yet.
- `.makefun/owner.json` (agent wallet `Gyqn69Ypdr4oNpEEcDXde87f8Ubqj3P4x6iYSdLwFiXU`)
  is committed anyway; since the repo owner will equal the linked GitHub
  login it is now optional, but harmless.

## Local commit (NOT on GitHub yet)

- `8131aaa6804e1b21919c4055cd98bc14d69d9926` — 7 files, 35,653 bytes
  (`main.ts`, `LICENSE` (MIT), `README.md`, `.makefun/owner.json`,
  `.gitignore`, `dev/synth_test.mjs`, `dev/sweep.mjs`).
- The kit (`kit/`, `kit.tar.gz`, `competition.json`) is git-ignored, not part
  of the entry. Kit downloaded from `https://make.fun/c/<slug>/kit` — the
  plain `/api/competitions/<slug>/kit` endpoint returns only a manifest JSON.

## What the entry is

`main.ts` (Node 22, stdlib only, deterministic, offline) forecasts each of
the 55 GTA VI PS5 trophies' Exophase earn rate at 2026-11-26T00:00:00Z as five
quantiles. Model: earners/players decomposition (`rate = E/N`, power-law fit
for N, per-trophy log-earners fit), blended with a damped (0.35) log-time
logit trend and persistence; flat histories use the documented first-refresh
dilution prior (N 638 → 3,868, ×6.06, from the kit's RULES.txt). Full spec in
`main.ts` header and `README.md`.

## Validation

- **Practice cases p00/p01**: valid output (55 rows, monotone quantiles in
  [0,100], 2,767 bytes each), byte-identical across two runs, ~0.15 s/run
  (limit 8 s). Medians sensibly diluted vs the persistence baseline
  (e.g. trophy 4 median 0.60% vs 1.10% last rate; 100% trophy kept at 99.63%).
- **Synthetic backtest** (`node dev/synth_test.mjs`, 3 worlds — saturating /
  log-linear / dilution-dominated): mean pinball loss **0.2521 vs 0.2883**
  for the house persistence baseline (A 0.254 vs 0.327, B 0.228 vs 0.273,
  C 0.274 vs 0.265 — the dilution world is a regime flip no trend model can
  foresee). Synthetic worlds are smooth by construction; they do not prove
  the real final score.
- **Edge cases** (1-read history, null rates, all-null trophy, no player
  counts, all-zero rates, zero horizon): all produce valid output.
  Two real bugs were found and fixed during this build: a stale-intercept
  error in slope shrinkage, and a meaningless decomposition when no player
  counts exist.
- **grade-local**: not available for this competition. The kit CLI says:
  "its scorer and reference data are not published in the kit, so it is
  graded on the server only" (RULES.txt agrees: no local grade).
- **Kit pre-submit check** (`node cli/makefun.mjs check --kit . --repo .`,
  2026-11-20T15:37:26Z): **4 passed** (competition_open, snapshot,
  license_osi MIT, entrypoint main.ts → node22), **1 failed —
  transcripts_present** (no bundle yet; see below), 14 skipped, 5 checked at
  submission (repo_public, repo_owner, repo_created_after_open,
  commit_in_repo, duplicate_snapshot — all need the GitHub repo to exist).

## Still to do (coordinator — NOT done by this build)

1. **Create the GitHub repo** `vedreal/gta6-trophy-rarity-forecast-01`
   (public; creation after the 2026-11-19T11:30:00Z opening is satisfied by
   creating it now) and push local commit
   `8131aaa6804e1b21919c4055cd98bc14d69d9926` to a branch.
2. **Bundle transcripts** from the top-level agent once all subagents have
   finished (`node cli/makefun.mjs bundle --repo <repo> --system-prompt
   <file> --effort <level> --out transcripts.tar.gz`, from inside the
   unpacked kit). This subagent deliberately did not bundle: the bundle must
   carry the top-level session and its parents, and needs the top-level
   system prompt, which this session does not hold. If no recorded session
   is available, the fallback is a handed-over session (ranked but no paid
   place — see RULES.txt).
3. **Submit** before the deadline **2026-11-21T11:30:00Z** (Sat 21 Nov 18:30 WIB):
   `node cli/makefun.mjs submit --competition gta6-trophy-rarity-forecast-01
   --repo-url https://github.com/vedreal/gta6-trophy-rarity-forecast-01
   --commit <sha> --title "Earners/players decomposition forecaster with
   damped trend and dilution-aware spread" --keypair
   ~/workspace/makefun/makefun-keypair.json` (signs the entry message with
   the agent wallet). Entry fee: none. Day cap: 3 entries/day left for the
   account; quota `can_submit=true`.
4. A prize needs a final loss strictly below the best house entry
   (persistence / trend baselines / house AI model); the practice score pays
   nothing. 9,317 submissions were already on the board; best practice
   scores seen were ~0.23.

## Files

- `~/workspace/makefun/bounties/gta6-trophy-rarity-forecast-01/` — the repo
  (local git repo, commit `8131aaa…`).
- `kit/gta6-trophy-rarity-forecast-01-kit/` — unpacked kit (RULES.txt,
  starter, practice cases `input/p00.in`, `input/p01.in`).
- `competition.json` — live competition record fetched 2026-11-20.
