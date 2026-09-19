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

  /* ---- readiness: a blank field must be neutral, not an accidental extreme ---- */
  const blankRhrScore = L.computeReadinessScore({ sleepScore: 72, restingHR: null, soreness: 3 }, baselines);
  const sameWithGoodRhr = L.computeReadinessScore({ sleepScore: 72, restingHR: baselines.restingHR, soreness: 3 }, baselines);
  check("blank resting HR does not score as an excellent reading", blankRhrScore < sameWithGoodRhr);
  check("blank resting HR contributes exactly 0 (matches sleep/soreness-only score)", blankRhrScore === L.computeReadinessScore({ sleepScore: 72, soreness: 3 }, baselines));

  const blankSleepScore = L.computeReadinessScore({ sleepScore: null, restingHR: baselines.restingHR, soreness: 3 }, baselines);
  check("blank sleep score does not score as the worst possible reading", blankSleepScore > L.computeReadinessScore({ sleepScore: 0, restingHR: baselines.restingHR, soreness: 3 }, baselines));
  check("blank sleep score contributes exactly 0", blankSleepScore === L.computeReadinessScore({ restingHR: baselines.restingHR, soreness: 3 }, baselines));

  const allBlankExceptSoreness = L.computeReadinessScore({ sleepScore: null, restingHR: null, soreness: 3 }, baselines);
  check("all fields blank except soreness scores purely from soreness", allBlankExceptSoreness === -1); // soreness 3 -> -1, per the table

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

  /* ---- custom-exercise progression ("beat your last time") ---- */
  const noCustomHistory = L.suggestCustomProgression(null);
  check("suggestCustomProgression with no catalog entry reports no history", noCustomHistory.note === "no history");

  const weightedCustomEntry = { name: "Farmer Carry", lastReps: 10, lastWeight: 40, loaded: true, metric: "reps" };
  const weightedCustomSuggestion = L.suggestCustomProgression(weightedCustomEntry);
  check("weighted custom exercise always suggests progress (target = last time)", weightedCustomSuggestion.note === "progress +weight");
  check("weighted custom exercise suggestion bumps the weight up from last time", weightedCustomSuggestion.weight > 40);

  const bodyweightCustomEntry = { name: "Wall Sit", lastReps: 45, lastWeight: 0, loaded: false, metric: "seconds" };
  const bodyweightCustomSuggestion = L.suggestCustomProgression(bodyweightCustomEntry);
  check("bodyweight custom exercise suggests +1 over last time", bodyweightCustomSuggestion.reps === 46);

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

  // A v2 blob (has schemaVersion:2, catalog entries predating metric/loaded/
  // lastSetCount) should backfill those fields without losing existing data.
  const v2Blob = {
    schemaVersion: 2, xp: 120, restDays: [0, 4], weekPlan: Object.assign({}, L.DEFAULT_WEEK_PLAN),
    weekOverrides: {}, baselines: L.DEFAULT_BASELINES, sessions: [], readiness: {},
    templates: L.cloneTemplates(L.WORKOUT_TEMPLATES), longestStreak: 3,
    exercises: {
      "Farmer Carry": { name: "Farmer Carry", lastReps: 10, lastWeight: 40, bestWeight: 40, updatedAt: "2026-08-01T00:00:00.000Z" },
      "Wall Sit": { name: "Wall Sit", lastReps: 45, lastWeight: 0, bestWeight: 0, updatedAt: "2026-08-02T00:00:00.000Z" }
    }
  };
  const fromV2 = L.migrate(v2Blob);
  check("v2->v3 migration stamps current schema version", fromV2.schemaVersion === L.SCHEMA_VERSION);
  check("v2->v3 migration preserves existing catalog data", fromV2.exercises["Farmer Carry"].lastWeight === 40);
  check("v2->v3 migration infers loaded=true when bestWeight was ever > 0", fromV2.exercises["Farmer Carry"].loaded === true);
  check("v2->v3 migration infers loaded=false when bestWeight was never > 0", fromV2.exercises["Wall Sit"].loaded === false);
  check("v2->v3 migration defaults metric to reps", fromV2.exercises["Farmer Carry"].metric === "reps");
  check("v2->v3 migration adds lastSetCount as null (unknown)", fromV2.exercises["Farmer Carry"].lastSetCount === null);

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

  /* ---- template snapshot: a later template/plan edit must not rewrite
     whether a past day counted, since the session already recorded what
     was actually assigned to it ---- */
  function buildSnapshottedSession(date, templateId, template, complete) {
    var exercises = template.exercises.map(function (def) {
      var sets = [];
      for (var i = 0; i < def.targetSets; i++) sets.push({ reps: complete ? def.targetReps : null, weight: def.loaded ? 20 : 0, cadenceMs: null });
      return { name: def.name, isCustom: false, metric: def.metric, sets: sets };
    });
    return {
      id: date, date: date, dayLabel: template.label, type: "workout", templateId: templateId,
      templateSnapshot: L.snapshotTemplate(template), exercises: exercises, cardio: null, xpEarned: 0, completedAt: date
    };
  }

  const snapshotState = L.freshState();
  snapshotState.restDays = [0, 4];
  const loggedDate = "2026-09-21"; // a Monday, upperA by default
  snapshotState.sessions.push(buildSnapshottedSession(loggedDate, "upperA", snapshotState.templates.upperA, true));

  check("isDayCompliant is true right after logging against the original template", L.isDayCompliant(snapshotState, new Date(loggedDate + "T09:00:00")));

  // Edit the LIVE template to require a 6th exercise the session never logged.
  snapshotState.templates.upperA = L.addExerciseToTemplate(snapshotState.templates.upperA, { name: "Face Pull", metric: "reps", loaded: true, targetSets: 3, targetReps: 15 });
  check("editing the live template afterward does not retroactively break a past day's compliance", L.isDayCompliant(snapshotState, new Date(loggedDate + "T09:00:00")));

  // Permanently reassigning the weekday to a different template shouldn't
  // reinterpret this day's history either.
  snapshotState.weekPlan[1] = "lower";
  check("reassigning the weekday's template later does not reinterpret a past day's history", L.isDayCompliant(snapshotState, new Date(loggedDate + "T09:00:00")));

  // A legacy session (recorded before this fix existed, so no templateId or
  // templateSnapshot) has nothing to fall back on but the live plan --
  // documented as unrecoverable, not a bug in the fix itself.
  const legacyExercises = snapshotState.templates.lower.exercises.map(function (def) {
    var sets = [];
    for (var i = 0; i < def.targetSets; i++) sets.push({ reps: def.targetReps, weight: def.loaded ? 20 : 0, cadenceMs: null });
    return { name: def.name, isCustom: false, metric: def.metric, sets: sets };
  });
  snapshotState.sessions.push({ id: "legacy", date: "2026-09-23", dayLabel: "Lower", type: "workout", exercises: legacyExercises, cardio: null, xpEarned: 0, completedAt: "2026-09-23" });
  check("a legacy session with no snapshot falls back to resolving the live plan", L.isDayCompliant(snapshotState, new Date("2026-09-23T09:00:00")));

  /* ---- consistency / PRs / attributes ---- */
  const consistency = L.computeConsistency(streakState, fridayMorning, 30);
  check("consistency is a percentage between 0 and 100", consistency >= 0 && consistency <= 100);

  // Regression: a fresh account with nothing ever logged must show 0%
  // consistency -- rest days should not hand out free credit just for
  // being scheduled as rest. (This was the actual bug: rest days used to
  // count in the denominator, so an idle account showed ~29% "for free".)
  const freshConsistencyState = L.freshState();
  freshConsistencyState.restDays = [0, 4];
  const freshConsistency = L.computeConsistency(freshConsistencyState, fridayMorning, 30);
  check("consistency is 0% for a fresh account with nothing logged", freshConsistency === 0);

  // Window ending Fri 25th, looking back 5 days: Thu(rest, skipped),
  // Wed/Tue/Mon (all logged, scheduled), Sun(rest, skipped) -> 3 scheduled
  // days, all compliant -> 100%, with the two rest days excluded entirely
  // rather than diluting or inflating the score.
  const perfectWindowConsistency = L.computeConsistency(streakState, fridayMorning, 5);
  check("consistency only counts scheduled (non-rest) days in the denominator", perfectWindowConsistency === 100);

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
  check("countRecentPRs tags loaded PRs with type 'weight'", prs.every((pr) => pr.type === "weight"));

  // Regression: bodyweight-only exercises (never logged with weight) must
  // still be able to register a PR, via reps, or they'd never contribute
  // to Strength no matter how much they improved.
  const bodyweightPrSessions = [
    { date: "2026-08-01", exercises: [{ name: "Push-Up", sets: [{ weight: 0, reps: 15 }] }] },
    { date: "2026-08-08", exercises: [{ name: "Push-Up", sets: [{ weight: null, reps: 20 }] }] }, // rep PR
    { date: "2026-08-15", exercises: [{ name: "Push-Up", sets: [{ weight: 0, reps: 18 }] }] },    // not a PR
    { date: "2026-08-22", exercises: [{ name: "Push-Up", sets: [{ weight: 0, reps: 25 }] }] }     // rep PR
  ];
  const bwPrs = L.countRecentPRs(bodyweightPrSessions, "2026-08-02");
  check("bodyweight exercises register rep PRs", bwPrs.length === 2);
  check("bodyweight PRs are tagged type 'reps' with a reps field", bwPrs.every((pr) => pr.type === "reps" && typeof pr.reps === "number"));
  check("bodyweight PR reps values are correct", bwPrs.map((pr) => pr.reps).join(",") === "20,25");

  // A session with any weight logged is judged as loaded (weight axis);
  // one with none is judged as bodyweight (reps axis) -- independent
  // per-session, not a fixed property of the exercise name.
  const mixedSessions = [
    { date: "2026-08-01", exercises: [{ name: "Ring Row", sets: [{ weight: 0, reps: 10 }] }] },   // reps PR (bodyweight)
    { date: "2026-08-08", exercises: [{ name: "Ring Row", sets: [{ weight: 10, reps: 10 }] }] }    // weight PR (now loaded)
  ];
  const mixedPrs = L.countRecentPRs(mixedSessions, "2026-08-01");
  check("PR axis is judged per-session, not fixed per exercise", mixedPrs.length === 2 && mixedPrs[0].type === "reps" && mixedPrs[1].type === "weight");

  const attrs = L.computeAttributes(streakState, fridayMorning);
  check("attributes include strength/endurance/consistency", attrs.strength && attrs.endurance && attrs.consistency);
  check("strength score is capped at 99", attrs.strength.score <= 99);
  check("endurance score reflects logged cardio minutes", attrs.endurance.score > 0);

  /* ---- digest ---- */
  const digest = L.buildDigest(streakState, fridayMorning);
  check("digest is a non-empty string", typeof digest === "string" && digest.length > 100);
  check("digest includes the streak snapshot", digest.indexOf("Current streak") !== -1);
  check("digest includes a PR section", digest.indexOf("PRs in the last 30 days") !== -1);

  // Regression: the digest's "Current plan" must reflect an active
  // this-week swap, not just the permanent weekPlan -- otherwise an AI
  // reviewing it would be told about a day that isn't actually happening.
  const swapDigestState = L.freshState();
  swapDigestState.restDays = [0, 4];
  const digestWeekKey = L.weekStartKey(fridayMorning);
  swapDigestState.weekOverrides[digestWeekKey] = { 5: "cardio" }; // Friday's upperB swapped to cardio this week
  const swapDigest = L.buildDigest(swapDigestState, fridayMorning);
  check("digest reflects an active this-week swap rather than the permanent plan", swapDigest.indexOf("Fri: Cardio (swapped this week)") !== -1);
  check("digest does not show the pre-swap permanent assignment for a swapped day", swapDigest.indexOf("Fri: Upper Body — Accessory") === -1);

  /* ---- exercise history (progress trend view) ---- */
  const exHistSessions = [
    { date: "2026-08-01", exercises: [{ name: "Goblet Squat", sets: [{ reps: 12, weight: 20 }, { reps: 12, weight: 20 }] }] },
    { date: "2026-08-15", exercises: [{ name: "Goblet Squat", sets: [{ reps: 10, weight: 22 }, { reps: 12, weight: 30 }] }] },
    { date: "2026-08-08", exercises: [{ name: "Goblet Squat", sets: [{ reps: 12, weight: 25 }] }] },
    { date: "2026-08-02", exercises: [{ name: "Push-Up", sets: [{ reps: 12, weight: 0 }] }] },
    { date: "2026-08-09", exercises: [{ name: "Push-Up", sets: [{ reps: 18, weight: null }] }] }
  ];

  const squatHistory = L.buildExerciseHistory(exHistSessions, "Goblet Squat");
  check("buildExerciseHistory infers weight metric when any set has weight > 0", squatHistory.metric === "weight");
  check("buildExerciseHistory sorts points chronologically regardless of session order", squatHistory.points.map((p) => p.date).join(",") === "2026-08-01,2026-08-08,2026-08-15");
  check("buildExerciseHistory takes the best (max) weight set per session", squatHistory.points.map((p) => p.bestWeight).join(",") === "20,25,30");

  const pushupHistory = L.buildExerciseHistory(exHistSessions, "Push-Up");
  check("buildExerciseHistory infers reps metric when weight is never set", pushupHistory.metric === "reps");
  check("buildExerciseHistory takes the best (max) reps set per session", pushupHistory.points.map((p) => p.bestReps).join(",") === "12,18");

  const unknownHistory = L.buildExerciseHistory(exHistSessions, "Nonexistent Exercise");
  check("buildExerciseHistory returns no points for an exercise never logged", unknownHistory.points.length === 0);

  const catalogFixture = {
    "Old One": { name: "Old One", lastReps: 10, lastWeight: 0, updatedAt: "2026-08-01T00:00:00.000Z" },
    "Newest": { name: "Newest", lastReps: 10, lastWeight: 0, updatedAt: "2026-08-20T00:00:00.000Z" },
    "Middle": { name: "Middle", lastReps: 10, lastWeight: 0, updatedAt: "2026-08-10T00:00:00.000Z" }
  };
  const loggedOrder = L.listLoggedExercises({ exercises: catalogFixture });
  check("listLoggedExercises sorts most-recently-updated first", loggedOrder.join(",") === "Newest,Middle,Old One");

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
