# TRAIN — Overview

Carried over from the previous build's design notes (the source file itself was lost; this repo starts fresh from `app/index.html`).

## Purpose & context

- Personalized standalone HTML fitness tracker — single-file PWA, opened locally via `file://` on Android
- P90X-inspired with RPG gamification, tailored to home equipment and a WFH/office work schedule
- Home equipment: pull-up bar, small dumbbells, bike, jump rope
- Goals: toning, muscle building, and endurance — practical vanity plus real-world physical capability
- No gym

## Architecture & runtime (previous build)

- Storage: IndexedDB as primary with a localStorage mirror, versioned schema
- Runtime: single-file HTML PWA, `file://` on Android
- Visual design target: Tron/EngineerOS aesthetic — electric cyan, amber, deep blue-black

## Feature set (previous build — reference for the rebuild)

- Per-set exercise logging with auto-suggest progression
- XP/gamification with level-up modals and a multi-level RPG system
- Cardio logger with optional HR / recovery HR / temperature fields
- Custom off-plan exercise logging with quick-pick dropdown (name + last-used target auto-filled)
- Per-set cadence timing with stored splits displayed inline
- Auto-complete when all set boxes are filled, with a debounce guard against mid-number misfires
- Configurable rest days with a min-1 guard and a warning above 3 consecutive
- Morning readiness check-in: sleep score + resting HR + soreness → PUSH/STEADY/HOLD/RECOVERY verdict, with a re-check button
- Expandable rest-day cards with cardio loggers

## Known bug patterns to avoid

- `event.stopPropagation()` on a modal wrapper breaks document-level delegated click handlers — caused a modal button bug previously

## Readiness engine notes

- A resting-HR reading taken post-coffee/commute can read ~15-20 bpm higher than true resting HR and skews the verdict — check RHR before coffee and driving
- If the wearable in use lacks HRV status, use sleep recovery score as the primary signal and resting HR as secondary
- Baselines should be adjustable, not hardcoded

## Feature philosophy

- Prioritize reducing taps over adding them
- Mid-workout friction is a first-class concern
- Favor honest tradeoff assessments over feature maximalism
- Scrutinize friction explicitly, especially for anything touched mid-set

## Engineering / validation approach (previous build)

- Every edit validated with `node --check` plus a Node.js harness simulating real browser render paths and existing saved-data migration
- Schema migrations tested against existing saved data at each version bump
- Ship each capability incrementally, validate before starting the next
