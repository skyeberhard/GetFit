# GetFit (TRAIN)

A personal, no-gym fitness tracker — single-file HTML/PWA, runs locally via `file://` on Android, no server or account required.

## Why this exists

Built to fit a specific setup: home equipment (pull-up bar, dumbbells, bike, jump rope), a WFH/office split schedule, and goals around toning, muscle building, and general health without a gym membership. It's P90X-inspired with light RPG gamification to keep it engaging.

## Status

Scaffold stage — rebuilding after losing the previous working copy. This repo exists so the file, its history, and the design notes never get lost like that again.

## Structure

```
app/     the actual PWA — single index.html, no build step
docs/     architecture notes, feature log, open design questions
exports/ local data exports (gitignored — never committed)
```

## Design principles (carried over from the last build)

- Single self-contained HTML file — no backend, no build pipeline, works offline
- IndexedDB as primary storage, localStorage as a mirror; schema is versioned and migrations are tested against real saved data before each release
- Minimize taps, especially mid-workout — friction there is a first-class bug
- Every change validated with `node --check` plus a small Node harness that simulates real render paths and data migration before it's considered done

See `docs/overview.md` for the fuller feature/architecture history and `docs/roadmap.md` for what's next.

## Running it

Open `app/index.html` directly in a browser (desktop) or via `file://` on Android. No install step. To make it installable as a PWA, a manifest + service worker will be added once the core app is back up.

## License

Personal project — no license file yet; treat as all-rights-reserved until Skylar says otherwise.
