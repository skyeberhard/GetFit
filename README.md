# GetFit (TRAIN)

A private, local-first home-training tracker that turns the AI assistant you already use into your coach. One HTML file, no account, no server, no subscription. It runs offline, and your plan and history never leave your device.

## What it is for

TRAIN is built for people who train at home with a few pieces of equipment (a pull-up bar, a few pairs of dumbbells, a bike, a jump rope) and want three things the big workout apps don't combine:

1. **Progression that matches the equipment you own.** Suggestions build reps through a range, then move to the next dumbbell you actually have, and back off after misses or a deload week. Readiness (sleep, resting heart rate, soreness) can hold a day back.
2. **An AI coach with no second subscription.** TRAIN exports a plain-text digest of your training (streak, volume, personal bests, plateaus, readiness trend, current plan). You paste it into whichever assistant you already use. The assistant answers with a structured plan change, which you paste back. TRAIN shows exactly what would change, and nothing applies until you tap Apply. There is no key stored in the app and no AI running cost.
3. **Privacy that is true by construction.** No account, no analytics, no network calls. Data lives in the browser (IndexedDB plus a localStorage mirror), with manual and automatic backup.

It started as one person's setup (home equipment, a WFH/office split week, goals around toning, muscle and general health) and is being shaped so other home trainers can use it.

## Where it is going

The direction comes from an evaluation of the app at commit `542011b`. The full spec is the "TRAIN evaluation and fix spec" doc; [`docs/execution-plan.md`](docs/execution-plan.md) turns it into ordered, CI-gated pull requests.

| Phase | Goal | Status |
| --- | --- | --- |
| 0 | Fix confirmed bugs: script injection through shared plans, progression history that shifts mid-workout, bodyweight moves treated as weighted | Shipped |
| 1 | Cut mid-workout friction: suggestions in the input fields, a rest timer, cardio on any day | Planned |
| 2 | Planning: a Plan tab, multi-week cycles, short/full day variants, missed-day handling, one-tap handoff to an AI assistant | Planned |
| 3 | Outcome tracking: body metrics, lighter readiness entry, session detail | Planned |
| 4 | Share-readiness: accessibility, units, health disclaimer, version and feedback link | Planned |
| 5 | Exercise model: stable ids, muscles and equipment, library import, a radar built on muscle coverage | In progress (stable ids up for review) |

The positioning is a hypothesis, not a launch plan. Before any payment or sync work, the next step is to get the app to a handful of home trainers who use an AI assistant and see who is still logging after four weeks. See the spec for the market comparison and what selling it would require (data that cannot vanish, a way to pay, terms).

## What works today

- **Logging and progression.** Per-set logging, rep-range progression snapping to your owned dumbbells, deload weeks and miss-streak back-off, estimated-1RM personal bests and plateau detection.
- **Readiness.** A daily check-in (sleep score, resting HR, soreness) gives PUSH / STEADY / HOLD / RECOVERY and suppresses increases on bad days. Baselines can auto-calculate from your own history.
- **Cardio.** Run, bike, swim, jump rope or other, with optional heart rate, on cardio days and rest days.
- **Planning.** A weekly plan with this-week-only day swaps, in-app editing of workouts, an Exercise Bank with how-to cues, a first-run intro that recommends one of six tailored starter plans, and share links for a plan (never history).
- **Feedback loop.** An AI check-in digest, and Import Plan Changes with a plain-language preview before anything applies.
- **Progress.** A streak and a six-spoke attribute radar with a 30-days-ago outline, per-exercise trend charts.
- **Data safety.** JSON export and import with validation, a backup reminder, optional automatic backup to a linked file (Chromium), and a request for persistent storage.
- **Look.** The Span theme kit with Dark, Light, Olive and Navy themes and a contrast boost, using embedded fonts so it stays fully offline.
- **PWA.** Installable when served over https, with an in-app update banner.

`docs/roadmap.md` has the detailed feature log and what has been deliberately deferred.

## Known limits

- Not yet tested on a real iPhone, or on Android over `file://`. Nothing is verified on iOS Safari.
- Automatic backup to a file needs a Chromium browser. Elsewhere, backup is manual export.
- Presets are general fitness programming and need review by a qualified trainer or physio before being shared widely. The app is not medical advice.
- No license file yet. Treat it as all rights reserved.

## Structure

```
app/         the actual PWA: index.html (the whole app), manifest.json,
             service-worker.js, icons/ -- no build step
docs/        overview (feature and architecture history), roadmap,
             execution plan
scripts/     test harness and CI helper scripts
exports/     local data exports (gitignored, never committed)
```

## Design principles

- `app/index.html` is a single self-contained file: no backend, no build pipeline, no dependencies, and it works fully offline on its own.
- **Two layers.** Pure logic lives in the `train-logic` script block (exported as `TrainLogic`) so the harness can test it; the DOM layer is the last script block. New rules go in the logic layer.
- IndexedDB is primary storage with a localStorage mirror. The schema is versioned; every change that alters saved state adds a tested, additive migration that never drops history.
- **History is frozen.** A session keeps a snapshot of the workout it was logged against, so editing a plan never changes whether a past day counted.
- Minimize taps, especially mid-workout. Friction there is a first-class bug, and typing into a set must never trigger a full re-render.
- Anything imported or shared is untrusted: strings are escaped before they reach the page and stripped of markup on the way in.
- The app makes no network calls. If an optional bring-your-own-key AI connection is ever added, it will be off by default, make calls only after a tap, and keep the key out of state, backups and share links.

## Running it

**Just the file, no install:** open `app/index.html` directly in a browser (desktop) or via `file://` on Android. It works fully offline and needs nothing set up. The manifest, service worker and icons are not needed for this.

**Installable as an app:** browsers only allow "Add to Home Screen" with real offline caching when a service worker is registered, and service workers require https (or `localhost`), never `file://`. So installability needs `app/` served from a real origin, such as GitHub Pages pointed at this repo. Opened that way it installs like any PWA.

**Tests:** `node scripts/test-harness.js` syntax-checks every inline script and exercises the logic layer, render paths and the full schema-migration chain. Run it before considering any change to `app/index.html` done. Date logic is timezone-sensitive, so CI runs it under several timezones.

## Releases

Everyone who installs the app runs whatever is deployed from **`Main`**, the default branch (GitHub Pages only deploys from it). Each person's plans and history live only on their own device, so a release can change the app but never anyone's data or plan.

- Work happens on other branches and reaches `Main` through a pull request. Roadmap items ship as small, ordered PRs per [`docs/execution-plan.md`](docs/execution-plan.md).
- `.github/workflows/test.yml` runs the harness under UTC, America/Chicago and Pacific/Auckland on every push and pull request. A pull request that changes `app/` also fails unless `CACHE_NAME` in `app/service-worker.js` was bumped (`scripts/check-cache-bump.js`), because installed copies would otherwise keep serving the old cached shell.
- Merging to `Main` is the release: `.github/workflows/deploy-pages.yml` runs the harness again and deploys only if it passes. The migration tests matter most; a release that upgraded saved data wrong would damage every user's history.
- Plans reach people without touching their data: a built-in starter plan (appears in Import Plan Changes) or a share link (Settings → Data → Share My Plan). Either way, nothing applies until they preview it and tap Apply.

## License

Personal project. No license file yet; treat as all rights reserved until Skylar says otherwise.
