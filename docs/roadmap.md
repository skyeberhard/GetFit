# Roadmap

## Done

- [x] Rebuild core app: plan structure, per-set logging, storage layer (IndexedDB + localStorage mirror, versioned schema + migration)
- [x] Readiness check-in engine (sleep score + resting HR + soreness → PUSH/STEADY/HOLD/RECOVERY, adjustable baselines, re-check button)
- [x] Cardio logger (Bike / Jump Rope / Other — deliberately excludes runs/walks, which Garmin already owns) with optional HR / recovery HR / temperature, available on cardio days and as an expandable add-on on rest days
- [x] Day-swapping — resolved as **this-week-only, tap-to-trade**: tapping "Swap this day" lets you pick a different day's workout for today only; the permanent weekly plan resumes next week. Implemented via a `weekOverrides[weekStartDate][weekday]` map so nothing permanent changes by accident.
- [x] Export/import (manual JSON backup/restore from Settings) — pulled forward from "Later" since it's cheap and directly addresses the "never lose the file again" goal
- [x] **Minimal/clean visual pass**, replacing the earlier Tron/EngineerOS theme — light theme by default with a proper `prefers-color-scheme: dark` variant, single muted accent color, no external fonts/assets (stays fully offline)
- [x] **Gamification rework** — flat per-set XP replaced with a system that actually reflects training, not just data entry:
  - **Streak** — the highest-leverage habit lever, previously missing entirely. A day counts as "compliant" if it's a rest day (always) or if the scheduled workout/cardio was completed. Streak counts backward from yesterday so an unfinished today never falsely breaks it.
  - **RPG attributes** (Progress tab) — Strength (PRs in the last 30 days), Endurance (cardio minutes in the last 30 days), Consistency (% of scheduled days hit in the last 30 days). Derived entirely from data already being logged — zero extra taps.
  - **PR bonus XP** and **streak milestone bonuses** (day 7/30/100) layered onto the existing per-set/cardio/workout-completion XP.
- [x] **In-app workout plan editing** (Settings → Weekly Plan / Workout Templates) — permanent weekday→template assignment, plus add/remove/reorder/edit exercises (name, sets, target, unit, loaded) within each template. This was the biggest functional gap in the previous build: the plan could only be swapped for a single week, never actually edited.
- [x] **AI check-in digest** (Settings → "Generate AI Check-In Digest") — assembles streak, attributes, last-14-day volume/session counts, recent PRs, readiness-verdict trend, and the current plan into copyable/downloadable markdown, meant to be pasted into a chat with an AI for a second opinion. Deliberately *not* a live API call from the app — that would need a stored key in a static file with no backend, which breaks the no-account/no-server design principle.
- [x] **Consistency fix** — rest days no longer count in the denominator. Previously a fresh account with nothing ever logged showed ~30% consistency purely from having 2 rest days/week; now only scheduled (non-rest) days count, so 0 logged workouts correctly shows 0%. Streak was left as-is — crediting a rest day there is correct (resting on a scheduled rest day is following the plan), it was specifically the percentage-of-effort framing where free credit was misleading.
- [x] **Per-exercise progress trend** (Progress tab → Exercises) — tap any logged exercise to see its best-weight-or-reps-per-session trend as a line chart, plus a full data table underneath. Hand-rolled inline SVG (no charting library — keeps the app a single offline file); metric (weight vs. reps) is inferred from the data itself so it works for both template and custom exercises. Tap-to-read instead of hover, since this is a phone-first app.

## Explicitly deferred (flagged as scope creep for this app)

- Reading / Scripture memorization tracking — a different habit domain from fitness; revisit as a separate tool or a genuinely thin, isolated tab if still wanted later.

## Next

- [ ] PWA manifest + service worker for installability and offline caching
- [ ] Deload weeks / plateau detection (e.g. auto-suggest a deload after N stalled sessions on an exercise)

## Later / under consideration

- [ ] Lightweight nutrition tracking: weekly bodyweight entry + a protein checkbox (diet is otherwise out of scope — the user's is fine as-is)
- [ ] Support for adding brand-new workout templates from the UI (currently: the 4 existing templates are editable, but not replaceable/addable)

## Validation

- `node --check` runs against every inline `<script>` block via `scripts/test-harness.js`
- The pure logic/view-model layer (`TrainLogic`, embedded in `app/index.html`) is dual-exported (CommonJS in Node, `window` in browser) so the harness can unit-test readiness scoring, progression suggestions, XP/leveling, streaks, PR detection, attributes, rest-day validation, template editing, and schema migration without a browser
- Schema migration is tested as a chain: reconstructed v0 (legacy) → v1 → current (v2), per the "test migrations against real saved data" principle
- Run `node scripts/test-harness.js` before considering any change to `app/index.html` done
