#!/usr/bin/env node
/*
 * Validates app/index.html without a browser:
 *  1. Extracts each inline <script> block and runs `node --check` on it
 *     (catches syntax errors before they'd ever hit a device).
 *  2. Loads TrainLogic (the pure logic/view-model module) and exercises
 *     it directly: readiness verdicts, progression suggestions, XP/level
 *     math, rest-day validation, and schema migration against a
 *     reconstructed legacy (v0) data blob.
 *  3. Simulates a couple of real render paths (Today view-model for a
 *     workout day, a rest day, and a swapped day) against fixture state,
 *     asserting the shape the DOM layer depends on.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const APP_PATH = path.join(__dirname, "..", "app", "index.html");
let failures = 0;
let passes = 0;

function check(label, cond) {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.error("FAIL: " + label);
  }
}

function extractScripts(html) {
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  const scripts = [];
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const src = m[2];
    if (/\ssrc=/.test(attrs)) continue; // external, not used here
    scripts.push(src);
  }
  return scripts;
}

function nodeCheckAll(scripts) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "train-harness-"));
  scripts.forEach((src, i) => {
    const file = path.join(tmpDir, "inline-" + i + ".js");
    fs.writeFileSync(file, src);
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
      passes++;
    } catch (err) {
      failures++;
      console.error("FAIL: node --check on inline script #" + i);
      console.error(err.stderr ? err.stderr.toString() : err.message);
    }
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function loadTrainLogic(html) {
  const scripts = extractScripts(html);
  const logicSrc = scripts.find((s) => s.includes("TrainLogic"));
  if (!logicSrc) throw new Error("Could not locate TrainLogic script block");
  const moduleObj = { exports: {} };
  const fn = new Function("module", "exports", "window", "globalThis", logicSrc);
  fn(moduleObj, moduleObj.exports, undefined, global);
  return moduleObj.exports;
}

function main() {
  const html = fs.readFileSync(APP_PATH, "utf8");
  const scripts = extractScripts(html);
  check("found inline script blocks", scripts.length >= 3);

  nodeCheckAll(scripts);

  const L = loadTrainLogic(html);

  /* ---- readiness engine ---- */
  const baselines = L.DEFAULT_BASELINES;
  const great = L.computeReadinessVerdict({ sleepScore: 90, restingHR: 52, soreness: 1 }, baselines);
  check("great sleep/low RHR/no soreness -> PUSH", great.verdict === "PUSH");

  const bad = L.computeReadinessVerdict({ sleepScore: 35, restingHR: 78, soreness: 5 }, baselines);
  check("bad sleep/high RHR/very sore -> RECOVERY", bad.verdict === "RECOVERY");

  const mid = L.computeReadinessVerdict({ sleepScore: 72, restingHR: 60, soreness: 2 }, baselines);
  check("solid-but-not-great -> STEADY", mid.verdict === "STEADY");

  const caffeineSkew = L.computeReadinessVerdict({ sleepScore: 80, restingHR: 71, soreness: 2 }, baselines);
  check("elevated RHR (post-coffee-like) pulls down from PUSH", caffeineSkew.verdict !== "PUSH");

  /* ---- progression suggestion ---- */
  const loadedDef = { name: "Goblet Squat", metric: "reps", loaded: true, targetSets: 4, targetReps: 12 };
  const hitTarget = L.suggestProgression(loadedDef, { weight: 30, reps: 12, targetReps: 12 });
  check("hitting target on loaded exercise suggests more weight", hitTarget.weight > 30);

  const missedTarget = L.suggestProgression(loadedDef, { weight: 30, reps: 9, targetReps: 12 });
  check("missing target on loaded exercise repeats weight", missedTarget.weight === 30);

  const bodyweightDef = { name: "Push-Up", metric: "reps", loaded: false, targetSets: 4, targetReps: 15 };
  const bwHit = L.suggestProgression(bodyweightDef, { weight: 0, reps: 15, targetReps: 15 });
  check("hitting target on bodyweight exercise suggests +1 rep", bwHit.reps === 16);

  const noHistory = L.suggestProgression(loadedDef, null);
  check("no history falls back to target reps", noHistory.reps === loadedDef.targetReps);

  /* ---- XP / leveling ---- */
  const lvl1 = L.levelForXp(0);
  check("0 xp is level 1", lvl1.level === 1);
  const lvl2 = L.levelForXp(L.xpToNext(1));
  check("crossing xpToNext(1) reaches level 2", lvl2.level === 2);
  check("level never decreases for increasing xp", L.levelForXp(5000).level > L.levelForXp(50).level);

  /* ---- rest day validation ---- */
  const noneSelected = L.validateRestDays([]);
  check("zero rest days is invalid (min-1 guard)", noneSelected.valid === false);

  const oneSelected = L.validateRestDays([0]);
  check("one rest day is valid", oneSelected.valid === true);

  const fourConsecutive = L.validateRestDays([0, 1, 2, 3]);
  check("4 consecutive rest days trips the >3 warning", !!fourConsecutive.warning);

  const threeConsecutive = L.validateRestDays([0, 1, 2]);
  check("exactly 3 consecutive rest days does not warn", !threeConsecutive.warning);

  const wraparound = L.validateRestDays([6, 0, 1, 2]); // Sat, Sun, Mon, Tue -> 4 in a row across week boundary
  check("consecutive run wraps across the week boundary", wraparound.longestRun === 4);

  /* ---- set completion ---- */
  const setsAllFilled = [{ reps: 12 }, { reps: 10 }, { reps: 8 }];
  check("allSetsComplete true when every target set has a positive value", L.allSetsComplete(setsAllFilled, 3, "reps") === true);
  const setsPartial = [{ reps: 12 }, { reps: null }, { reps: 8 }];
  check("allSetsComplete false when a target set is empty", L.allSetsComplete(setsPartial, 3, "reps") === false);

  /* ---- schema migration against a reconstructed legacy (v0) blob ---- */
  const legacyBlob = {
    xp: 340,
    sessions: [
      {
        date: "2025-01-06",
        dayLabel: "Upper Body",
        entries: [
          { exercise: "Pull-Up", setLogs: [{ reps: 8, weight: 0 }, { reps: 7, weight: 0 }] },
          { exercise: "Dumbbell Row", setLogs: [{ reps: 10, weight: 25 }] }
        ]
      }
    ]
  };
  const migrated = L.migrate(legacyBlob);
  check("migration stamps current schema version", migrated.schemaVersion === L.SCHEMA_VERSION);
  check("migration preserves xp", migrated.xp === 340);
  check("migration converts sessions array", migrated.sessions.length === 1);
  check("migration converts nested exercises/sets", migrated.sessions[0].exercises[0].sets.length === 2);
  check("migration maps entries.exercise -> exercises[].name", migrated.sessions[0].exercises[0].name === "Pull-Up");
  check("migration maps setLogs -> sets with numeric reps/weight", migrated.sessions[0].exercises[1].sets[0].weight === 25);
  check("v0->v1->v2 chain seeds templates from defaults", migrated.templates && migrated.templates.upperA.exercises.length > 0);
  check("v0->v1->v2 chain seeds longestStreak", migrated.longestStreak === 0);

  // A v1 blob (has schemaVersion:1, no templates/longestStreak) should chain through v1->v2 only.
  const v1Blob = { schemaVersion: 1, xp: 50, restDays: [0], weekPlan: Object.assign({}, L.DEFAULT_WEEK_PLAN), weekOverrides: {}, baselines: L.DEFAULT_BASELINES, exercises: {}, sessions: [], readiness: {} };
  const fromV1 = L.migrate(v1Blob);
  check("v1->v2 migration adds templates", !!fromV1.templates);
  check("v1->v2 migration adds longestStreak", fromV1.longestStreak === 0);
  check("v1->v2 migration preserves existing xp", fromV1.xp === 50);

  const alreadyCurrent = L.migrate(L.freshState());
  check("migrating already-current state is a no-op passthrough", alreadyCurrent.schemaVersion === L.SCHEMA_VERSION);

  const garbageInput = L.migrate(null);
  check("migrating garbage/missing data yields a fresh valid state", Array.isArray(garbageInput.sessions) && garbageInput.sessions.length === 0);

  /* ---- render-path simulation: Today view-model ---- */
  const fixtureState = L.freshState();
  fixtureState.restDays = [0, 4]; // Sun, Thu
  fixtureState.weekPlan = Object.assign({}, L.DEFAULT_WEEK_PLAN);

  // A Monday (weekday=1) -> upperA, a training day.
  const monday = new Date("2026-09-21T09:00:00"); // a Monday
  check("fixture date is actually a Monday", monday.getDay() === 1);
  const mondayVm = L.buildTodayViewModel(fixtureState, monday);
  check("training day view-model resolves the right template", mondayVm.templateId === "upperA");
  check("training day view-model is not flagged as rest", mondayVm.isRest === false);
  check("day strip has all 7 days", mondayVm.dayStrip.length === 7);

  // A Thursday (weekday=4) -> rest by default.
  const thursday = new Date("2026-09-24T09:00:00");
  check("fixture date is actually a Thursday", thursday.getDay() === 4);
  const thursdayVm = L.buildTodayViewModel(fixtureState, thursday);
  check("configured rest day view-model is flagged as rest", thursdayVm.isRest === true);

  // This-week-only swap: override Monday's template for that week only.
  const weekKey = L.weekStartKey(monday);
  fixtureState.weekOverrides[weekKey] = { 1: "lower" };
  const swappedVm = L.buildTodayViewModel(fixtureState, monday);
  check("swap overrides the resolved template for that week", swappedVm.templateId === "lower");
  check("swap is flagged in the view-model", swappedVm.swapped === true);

  const nextMonday = new Date(monday.getTime());
  nextMonday.setDate(monday.getDate() + 7);
  const nextWeekVm = L.buildTodayViewModel(fixtureState, nextMonday);
  check("swap does not leak into the following week", nextWeekVm.templateId === "upperA");

  /* ---- render-path simulation: exercise view-model with progression ---- */
  fixtureState.exercises["Goblet Squat"] = { name: "Goblet Squat", lastReps: 12, lastWeight: 30, updatedAt: new Date().toISOString() };
  const squatDef = L.WORKOUT_TEMPLATES.lower.exercises.find((e) => e.name === "Goblet Squat");
  const squatVm = L.buildExerciseViewModel(squatDef, null, fixtureState.exercises);
  check("exercise view-model pulls suggestion from catalog history", squatVm.suggestion.weight > 30);
  check("exercise view-model pads sets to target count", squatVm.sets.length === squatDef.targetSets);

  /* ---- day compliance / streak ---- */
  function buildCompleteWorkoutSession(date, template) {
    return {
      id: date, date: date, dayLabel: template.label, type: "workout",
      exercises: template.exercises.map(function (def) {
        var sets = [];
        for (var i = 0; i < def.targetSets; i++) sets.push({ reps: def.targetReps, weight: def.loaded ? 20 : 0, cadenceMs: null });
        return { name: def.name, isCustom: false, metric: def.metric, sets: sets };
      }),
      cardio: null, xpEarned: 0, completedAt: date
    };
  }
  function buildCardioSession(date, minutes) {
    return {
      id: date, date: date, dayLabel: "Cardio", type: "cardio", exercises: [],
      cardio: { cardioType: "Bike", durationMin: minutes, distanceMi: null, hr: null, recoveryHr: null, temperatureF: null },
      xpEarned: 0, completedAt: date
    };
  }

  const streakState = L.freshState();
  streakState.restDays = [0, 4]; // Sun, Thu
  const templates = streakState.templates;

  check("isDayCompliant: rest day is always compliant with no session", L.isDayCompliant(streakState, new Date("2026-09-24T09:00:00"))); // Thu, rest
  check("isDayCompliant: training day with no session is not compliant", !L.isDayCompliant(streakState, new Date("2026-09-21T09:00:00"))); // Mon, upperA, no session yet

  streakState.sessions.push(buildCompleteWorkoutSession("2026-09-21", templates.upperA)); // Mon
  streakState.sessions.push(buildCardioSession("2026-09-22", 30));                        // Tue
  streakState.sessions.push(buildCompleteWorkoutSession("2026-09-23", templates.lower));  // Wed
  // Thu 24th is a rest day -> auto-compliant, no session needed.

  const fridayMorning = new Date("2026-09-25T09:00:00"); // Fri, before logging today
  const streakBeforeToday = L.computeStreakInfo(streakState, fridayMorning);
  // Walking back from Thu: Thu(rest)/Wed/Tue/Mon are compliant, and the Sunday
  // before Monday is also a rest day, so the run extends to 5 before hitting
  // the prior Saturday (a cardio day with no logged session).
  check("streak counts back through the preceding Sunday rest day", streakBeforeToday.current === 5);
  check("streak: today not yet compliant is reflected", streakBeforeToday.todayCompliant === false);

  streakState.sessions.push(buildCompleteWorkoutSession("2026-09-25", templates.upperB)); // Fri, completed
  const streakAfterToday = L.computeStreakInfo(streakState, fridayMorning);
  check("streak includes today once it's compliant", streakAfterToday.current === 6);
  check("streak.longest tracks at least the current streak", streakAfterToday.longest >= 6);

  const brokenStreakState = L.freshState();
  brokenStreakState.restDays = [0, 4];
  brokenStreakState.sessions.push(buildCompleteWorkoutSession("2026-09-21", brokenStreakState.templates.upperA)); // Mon, logged
  // Tue and Wed intentionally skipped (training days, no session)
  const brokenStreak = L.computeStreakInfo(brokenStreakState, new Date("2026-09-25T09:00:00"));
  check("a gap on a training day breaks the streak", brokenStreak.throughYesterday < 4);

  /* ---- consistency / PRs / attributes ---- */
  const consistency = L.computeConsistency(streakState, fridayMorning, 30);
  check("consistency is a percentage between 0 and 100", consistency >= 0 && consistency <= 100);

  const prSessions = [
    { date: "2026-08-01", exercises: [{ name: "Goblet Squat", sets: [{ weight: 20, reps: 12 }] }] },
    { date: "2026-08-10", exercises: [{ name: "Goblet Squat", sets: [{ weight: 25, reps: 12 }] }] }, // PR
    { date: "2026-08-15", exercises: [{ name: "Goblet Squat", sets: [{ weight: 22, reps: 12 }] }] }, // not a PR
    { date: "2026-08-20", exercises: [{ name: "Goblet Squat", sets: [{ weight: 30, reps: 12 }] }] }  // PR
  ];
  // since = the day after the first entry, so that entry only establishes the
  // baseline "best" (any first-ever weight trivially beats a best of 0) and
  // isn't itself counted as a PR within the window.
  const prs = L.countRecentPRs(prSessions, "2026-08-02");
  check("countRecentPRs finds only the weight-increasing sessions within the window", prs.length === 2);
  check("countRecentPRs records the correct PR weights", prs[0].weight === 25 && prs[1].weight === 30);
  const prsWindowed = L.countRecentPRs(prSessions, "2026-08-11");
  check("countRecentPRs respects the since-date window", prsWindowed.length === 1 && prsWindowed[0].weight === 30);

  const attrs = L.computeAttributes(streakState, fridayMorning);
  check("attributes include strength/endurance/consistency", attrs.strength && attrs.endurance && attrs.consistency);
  check("strength score is capped at 99", attrs.strength.score <= 99);
  check("endurance score reflects logged cardio minutes", attrs.endurance.score > 0);

  /* ---- digest ---- */
  const digest = L.buildDigest(streakState, fridayMorning);
  check("digest is a non-empty string", typeof digest === "string" && digest.length > 100);
  check("digest includes the streak snapshot", digest.indexOf("Current streak") !== -1);
  check("digest includes a PR section", digest.indexOf("PRs in the last 30 days") !== -1);

  /* ---- template editing (pure, immutable) ---- */
  const originalTemplate = L.WORKOUT_TEMPLATES.upperA;
  const withAdded = L.addExerciseToTemplate(originalTemplate, { name: "Face Pull", metric: "reps", loaded: true, targetSets: 3, targetReps: 15 });
  check("addExerciseToTemplate appends without mutating the original", withAdded.exercises.length === originalTemplate.exercises.length + 1);
  check("addExerciseToTemplate does not mutate the source template", originalTemplate.exercises.length === 5);

  const withRemoved = L.removeExerciseFromTemplate(originalTemplate, 0);
  check("removeExerciseFromTemplate removes the targeted index", withRemoved.exercises.length === originalTemplate.exercises.length - 1);
  check("removeExerciseFromTemplate does not mutate the source template", originalTemplate.exercises.length === 5);

  const movedDown = L.moveExerciseInTemplate(originalTemplate, 0, 1);
  check("moveExerciseInTemplate swaps adjacent exercises", movedDown.exercises[1].name === originalTemplate.exercises[0].name);
  const movedOutOfBounds = L.moveExerciseInTemplate(originalTemplate, 0, -1);
  check("moveExerciseInTemplate is a no-op past the start", movedOutOfBounds.exercises[0].name === originalTemplate.exercises[0].name);

  const patched = L.updateExerciseInTemplate(originalTemplate, 0, { targetSets: 6 });
  check("updateExerciseInTemplate patches only the targeted field", patched.exercises[0].targetSets === 6 && patched.exercises[0].name === originalTemplate.exercises[0].name);
  check("updateExerciseInTemplate does not mutate the source template", originalTemplate.exercises[0].targetSets === 4);

  /* ---- summary ---- */
  console.log("\n" + passes + " passed, " + failures + " failed.");
  if (failures > 0) process.exit(1);
}

main();
