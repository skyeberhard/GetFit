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

  /* ---- summary ---- */
  console.log("\n" + passes + " passed, " + failures + " failed.");
  if (failures > 0) process.exit(1);
}

main();
