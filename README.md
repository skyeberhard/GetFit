# GetFit (TRAIN)

A personal, no-gym fitness tracker — single-file HTML/PWA, runs locally via `file://` on Android, no server or account required. Installable as a real app when served over https.

## Why this exists

Built to fit a specific setup: home equipment (pull-up bar, dumbbells, bike, jump rope), a WFH/office split schedule, and goals around toning, muscle building, and general health without a gym membership. It's P90X-inspired with light RPG gamification to keep it engaging.

## Status

Core app is up in `app/index.html`: per-set logging with progression suggestions (rep-range based, snapping to dumbbells you actually own, with deload-week and miss-streak failure handling), readiness check-in that actually affects suggestions (baselines auto-calculate from your own check-in history, or set them manually), cardio logger, a streak + RPG-attribute gamification layer (Strength/Endurance/Consistency, all derived from logged data), in-app editing of the weekly plan and workout templates (add/remove templates freely, built from a categorized Exercise Bank with default sets/reps, plus a one-tap built-in starter plan), a first-run intro that asks a few questions and recommends one of six tailored preset plans, an AI check-in digest export, and JSON backup/restore with a "Last backup: N days ago" reminder plus optional automatic backup to a linked on-disk file (Chromium browsers). Styled with the Span theme kit — dark-first, amber-accented, Inter + Barlow (embedded, so still fully offline) — with Dark / Light / Olive / Navy themes and contrast boost in Settings → Appearance. Installable as a PWA (`app/manifest.json` + `app/service-worker.js` + `app/icons/`) when served over https — see **Running it** below. See `docs/roadmap.md` for what's next and what's been explicitly deferred as scope creep (reading/Scripture tracking).

## Structure

```
app/         the actual PWA — index.html (the whole app), manifest.json,
             service-worker.js, icons/ — no build step
docs/        architecture notes, feature log, open design questions
exports/     local data exports (gitignored — never committed)
```

## Design principles (carried over from the last build)

- `app/index.html` is a single self-contained file — no backend, no build pipeline, works fully offline on its own even without the PWA files alongside it
- IndexedDB as primary storage, localStorage as a mirror; schema is versioned and migrations are tested against real saved data before each release
- Minimize taps, especially mid-workout — friction there is a first-class bug
- Every change validated with `node --check` plus a small Node harness that simulates real render paths and data migration before it's considered done

See `docs/overview.md` for the fuller feature/architecture history and `docs/roadmap.md` for what's next.

## Running it

**Just the file, no install:** open `app/index.html` directly in a browser (desktop) or via `file://` on Android. Works fully offline, nothing to set up. This is all `app/manifest.json`/`service-worker.js`/`icons/` need not exist for.

**Installable as an app:** browsers only allow "Add to Home Screen"/"Install" with real offline caching when a service worker is registered, and service workers require https (or `localhost`) — never `file://`. So installability needs `app/` served from a real origin, e.g. GitHub Pages pointed at this repo's `app/` folder. Opened that way, it installs like any other PWA (home-screen icon, standalone window, offline caching via `service-worker.js`).

## Releases (once others are using it)

Everyone who installs the app runs whatever is deployed from **`Main`** (the default branch — GitHub Pages only accepts deploys from it). Each person's plans and history live only on their own device — a release can change the app, never anyone's data or plan.

- Work happens on other branches; `.github/workflows/test.yml` runs the test harness on every push and pull request.
- Merging (or pushing) to `Main` is the release: `.github/workflows/deploy-pages.yml` runs the harness again and deploys only if it passes. The schema-migration tests matter most here — a release that upgraded saved data wrong would damage every user's history.
- Bump `CACHE_NAME` in `app/service-worker.js` with each release so installed apps pick it up (and show the in-app "Update available" banner).
- Plans reach people without touching their data: a built-in starter plan (ships to everyone, appears in Import Plan Changes) or a share link (Settings → Data → Share My Plan) sent to specific people. Either way, nothing applies until they preview it and tap Apply.

## License

Personal project — no license file yet; treat as all-rights-reserved until Skylar says otherwise.
