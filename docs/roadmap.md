# Roadmap

## Done

- [x] Rebuild core app: plan structure, per-set logging, storage layer (IndexedDB + localStorage mirror, versioned schema + migration)
- [x] Readiness check-in engine (sleep score + resting HR + soreness → PUSH/STEADY/HOLD/RECOVERY, adjustable baselines, re-check button)
- [x] Cardio logger (Bike / Jump Rope / Other — deliberately excludes runs/walks, which Garmin already owns) with optional HR / recovery HR / temperature, available on cardio days and as an expandable add-on on rest days
- [x] XP / RPG leveling system (per-set XP with target-hit bonus, per-cardio-log XP, workout-completion bonus, level curve)
- [x] Day-swapping — resolved as **this-week-only, tap-to-trade**: tapping "Swap this day" lets you pick a different day's workout for today only; the permanent weekly plan resumes next week. Implemented via a `weekOverrides[weekStartDate][weekday]` map so nothing permanent changes by accident.
- [x] Tron/EngineerOS visual pass (electric cyan / amber / deep blue-black, no external fonts or assets — stays fully offline)
- [x] Export/import (manual JSON backup/restore from Settings) — pulled forward from "Later" since it's cheap and directly addresses the "never lose the file again" goal

## Next

- [ ] PWA manifest + service worker for installability and offline caching
- [ ] Deload weeks
- [ ] Permanent plan-day reassignment (vs. the current this-week-only swap)

## Later / under consideration

- [ ] Lightweight nutrition tracking: weekly bodyweight entry + a protein checkbox (full meal tracking ruled out — too high-friction)

## Validation

- `node --check` runs against every inline `<script>` block via `scripts/test-harness.js`
- The pure logic/view-model layer (`TrainLogic`, embedded in `app/index.html`) is dual-exported (CommonJS in Node, `window` in browser) so the harness can unit-test readiness scoring, progression suggestions, XP/leveling, rest-day validation, and schema migration without a browser
- Schema migration is tested against a reconstructed v0 (legacy) data shape, per the "test migrations against real saved data" principle
- Run `node scripts/test-harness.js` before considering any change to `app/index.html` done
