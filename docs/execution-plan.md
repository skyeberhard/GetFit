# Execution plan: evaluation spec → shipped

Source: the "TRAIN evaluation and fix spec" doc (commit 542011b). Item numbers (0.1, 2.2, 5.1 …) match that doc, which holds the evidence, root cause and test list for each. This file only says **who builds it, in what order, and what must be green before it merges.**

## How to read the model column

| Model | Use it when | Items below |
| --- | --- | --- |
| **Haiku** | The change is mechanical, the doc already names the exact edit, and a wrong answer is caught immediately by a test or by eye. No schema change. | Copy changes, label swaps, `div` → `button`, read-only modals, CSV export, rename |
| **Sonnet** | A well-specified feature or fix that touches several functions in one layer. Needs judgment about the DOM/logic split but not about data invariants. | Most of Phases 0, 1, 3, 4 and the additive parts of 2 and 5 |
| **Opus** | The change redefines what the saved data *means*, rewrites a migration over real history, or has a security/correctness blast radius across the whole file. A subtle mistake silently corrupts users' logs. | 0.2 + 0.3, 2.2, 5.1, 5.4, 2.7 Part B |

Rule of thumb used: **schema/derivation changes → Opus; additive features → Sonnet; text and wiring → Haiku.** If a Sonnet or Haiku run fails the same check twice, escalate that item one tier instead of retrying.

## CI gates (every PR, no exceptions)

CI today is `test.yml` (runs `node scripts/test-harness.js` on every non-Main branch and every PR) and `deploy-pages.yml` (re-runs the harness on Main, then deploys). A PR is mergeable only when **all** of these hold:

1. `node scripts/test-harness.js` is green locally **and** under `TZ=UTC` **and** under one non-UTC zone (see PR-0). The doc's "344 of 344" was measured in UTC; on this machine (America/Chicago) it is 343 of 344 because of a timezone-fragile test, not an app bug.
2. The `Test` workflow is green on the PR (the same harness on ubuntu / Node 22).
3. `CACHE_NAME` in `app/service-worker.js` is bumped if anything under `app/` changed. PR-0 adds a CI check so this stops depending on memory.
4. Any logic change has new `check(label, condition)` cases. A schema change also bumps `SCHEMA_VERSION`, adds a `migrateVNToVN+1` step, updates `freshState()`, and extends the migration-chain test.
5. `docs/roadmap.md` gains an entry for the finished item.
6. After merge to Main, the `Deploy TRAIN to GitHub Pages` run goes green. Watch it; a red deploy means users keep the old build, so treat it as a failed merge.

## Order of work

One file (`app/index.html`) means parallel branches will conflict. **Merge serially, rebase before opening each PR.** Haiku items are cheap to batch into one sitting between larger ones.

| PR | Items | Model | Size | Notes |
| --- | --- | --- | --- | --- |
| **PR-0** | CI + test hardening | Sonnet | S | Fix the TZ-fragile test; run the harness in a `TZ` matrix; add a `CACHE_NAME`-bumped check; correct the roadmap's "v7" Validation line |
| **PR-1** | **Phase 0**: 0.1, 0.4 | Sonnet | S | 0.1 is a security fix and blocks any sharing. 0.4 migration flips only never-weighted bodyweight moves |
| **PR-2** | 0.2 + 0.3 together | **Opus** | M | Shared root cause: sessions become the source of truth (`lastPerfBefore`, `deriveCatalogEntry`). Everything after reads progression through this |
| **PR-3** | 5.1 stable exercise ids | **Opus** | L | Largest migration yet. Test against a full real backup. Do before 2.x because it changes exercise shape |
| **PR-4** | 5.2 muscles + equipment on bank entries | Sonnet | M | Additive; `EXERCISE_TRAITS` becomes seed data. Fixed muscle list is validated on import |
| **PR-5** | 1.4 remove XP text | Haiku | XS | |
| **PR-6** | 1.1 suggestion in the fields | Sonnet | M | Must keep the `refreshTodayLite` path; no full re-render while typing |
| **PR-7** | 1.2 rest timer | Sonnet | M | `Date.now()`-based; direct text-node updates only. D2 default: drop the per-set stopwatch |
| **PR-8** | 1.3 cardio on any day | Sonnet | S | Add the "extra cardio can't fake compliance" test |
| **PR-9** | 1.5 collapsible Settings, shorter labels, session-log cap | Haiku | M | Pure DOM layer. Plan controls stay put until 2.1 moves them |
| **PR-10** | 2.2 multi-week cycle | **Opus** | L | `resolvePlanDay(state, dateObj)` signature change touches every caller. A 1-week cycle must behave exactly like today |
| **PR-11** | 2.1 Plan tab | Sonnet | L | Depends on PR-10. Moves plan controls out of Settings |
| **PR-12** | 2.3 day variants | Sonnet | M | Snapshot the chosen variant so compliance judges what was chosen |
| **PR-13** | 2.4 missed-day handling | Sonnet | M | Pure `pushWeek(state, fromDate)` function first, UI second |
| **PR-14** | 2.5 duplicate/rename, notes, per-side, supersets | Sonnet | M | Every new field goes through `sanitizeExerciseDef`, share payload, plan JSON |
| **PR-15** | 2.6 AI loop in step with cycles/variants | **Opus** | M | Round-trip property: digest JSON pasted back = empty diff |
| **PR-16** | 2.7 Part A one-tap assistant handoff | Sonnet | S | No key, no state change |
| **PR-17** | 3.3 session detail modal (+ 5.7 delete session, with confirm) | Haiku → Sonnet | S | Modal is Haiku; delete touches derived data (uses PR-2's `deriveCatalogEntry`), so that half is Sonnet |
| **PR-18** | 3.1 body metrics | Sonnet | M | Schema bump (adds `body: []`) |
| **PR-19** | 3.2 part 1: readiness prefill + steppers | Haiku | S | Part 2 (paste import) only if D6 says yes → Sonnet |
| **PR-20** | 4.4 health line, 4.6 version + feedback link | Haiku | XS | |
| **PR-21** | 4.5 accessibility (`div` → `button`, aria, focus ring) | Haiku | M | Behavior must not change; verify the set-row checkbox flow by hand |
| **PR-22** | 4.2 kg option (only if D5 says yes) | Sonnet | M | Schema bump. Default per doc: wait |
| **PR-23** | 5.3 exercise library import | Sonnet | M | Reuses the preview-then-apply pattern. 200-entry cap, angle brackets stripped |
| **PR-24** | 5.5 set types (warm-up) | Sonnet | M | Warm-ups excluded from progression/PR/volume/completion. Schema bump; touches PR-2's derivations |
| **PR-25** | 5.6 per-exercise progression settings | Sonnet | M | Timed step defaults to 5 s |
| **PR-26** | 5.4 attribute radar rework | **Opus** | L | Needs PR-4. Redefines what the Progress tab means; the spec's math (plan-share coverage, median-of-three trend, dash for no data) is easy to get subtly wrong |
| **PR-27** | 5.7 rest: undo toasts, hours-slept alternative, CSV export | Haiku | M | CSV export is pure Haiku; the sleep alternative changes readiness scoring input, so review that part |
| **PR-28** | 2.7 Part B bring-your-own-key (optional) | **Opus** | M | Only after 0.1 and its CSP step. Spike each provider from the deployed Pages origin first. Harness check: `exportData` never contains the key |
| **PR-29** | 5.8 rename to Replogic | Haiku | S | Display strings only. Do **not** rename storage keys. Trademark check first (see doc) |
| **PR-30** | 4.3 license (D4) | Haiku | XS | Default: leave all rights reserved |

## Milestones

- **Shareable** = PR-0 → PR-1 → PR-2 → PR-5…PR-9 → PR-20, PR-21. The doc says share after Phases 0, 1 and 4; PR-3/PR-4 are not required for that, so they can slip behind it if you want to share sooner. Still run the one iPhone pass before sending a link.
- **Planning complete** = PR-10 → PR-16.
- **Outcome tracking** = PR-17 → PR-19.
- **Exercise model + polish** = PR-3, PR-4, PR-22 → PR-30.

## Decisions to make (defaults apply if you say nothing)

D1 flip bodyweight moves to unweighted · D2 drop the per-set stopwatch · D3 8-week cycle cap, global off days · D4 all rights reserved · D5 wait on kg · D6 readiness part 1 only. Also: which AI providers for 2.7 Part B (default Anthropic + OpenRouter).

## Not verified (carried over from the spec)

Nothing has run on a real phone, on Android over `file://`, or on iOS Safari. The six-week dataset was synthetic. Only one unescaped `innerHTML` sink was confirmed; PR-1 must audit the rest. Run one real-device pass before sharing.
