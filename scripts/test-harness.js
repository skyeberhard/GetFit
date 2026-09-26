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

async function main() {
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

  /* ---- rolling readiness baselines ---- */
  const now2609 = new Date("2026-09-25T00:00:00.000Z");
  const sparseReadiness = { "2026-09-24": { restingHR: 55, sleepScore: 75 }, "2026-09-23": { restingHR: 57 } };
  const sparseRolling = L.computeRollingBaselines(sparseReadiness, now2609, 30);
  check("computeRollingBaselines returns null under the minimum sample count", sparseRolling.restingHR === null && sparseRolling.sleepGood === null);

  const richReadiness = {};
  for (let i = 1; i <= 10; i++) {
    const d = new Date(now2609); d.setDate(d.getDate() - i);
    richReadiness[L.toDateKey(d)] = { restingHR: 50, sleepScore: 80 };
  }
  const richRolling = L.computeRollingBaselines(richReadiness, now2609, 30);
  check("computeRollingBaselines averages resting HR once the sample floor is met", richRolling.restingHR === 50);
  check("computeRollingBaselines averages sleep score once the sample floor is met", richRolling.sleepGood === 80);
  check("computeRollingBaselines derives sleepLow as sleepGood - 20", richRolling.sleepLow === 60);
  check("computeRollingBaselines ignores entries outside the window", L.computeRollingBaselines(richReadiness, now2609, 5).sampleCount.restingHR === 5);

  const oldEntry = { "2026-08-01": { restingHR: 50, sleepScore: 80 } };
  check("computeRollingBaselines excludes readiness entries older than the window", L.computeRollingBaselines(oldEntry, now2609, 30).sampleCount.restingHR === 0);

  const autoState = { baselinesAuto: true, baselines: L.DEFAULT_BASELINES, readiness: richReadiness };
  check("resolveBaselines uses the rolling average once enough history exists", L.resolveBaselines(autoState, now2609).restingHR === 50);

  const manualState = { baselinesAuto: false, baselines: { restingHR: 52, sleepGood: 80, sleepLow: 55 }, readiness: richReadiness };
  check("resolveBaselines respects manual mode even with plenty of history", L.resolveBaselines(manualState, now2609).restingHR === 52);

  const autoButSparseState = { baselinesAuto: true, baselines: L.DEFAULT_BASELINES, readiness: sparseReadiness };
  check("resolveBaselines falls back to the manual/default value per-field when history is too thin", L.resolveBaselines(autoButSparseState, now2609).restingHR === L.DEFAULT_BASELINES.restingHR);

  /* ---- progression suggestion: rep-range before weight ---- */
  const loadedDef = { name: "Goblet Squat", metric: "reps", loaded: true, targetSets: 4, targetReps: 12 };
  // Default rep-range ceiling with no explicit targetRepsMax is target+4 (16 here).
  check("repRangeCeiling defaults to target+4 with no explicit max", L.repRangeCeiling(loadedDef) === 16);
  const explicitCeilingDef = Object.assign({}, loadedDef, { targetRepsMax: 15 });
  check("repRangeCeiling honors an explicit targetRepsMax", L.repRangeCeiling(explicitCeilingDef) === 15);

  // Hit the floor but still below the rep-range ceiling -> build reps at the same weight.
  const midRange = L.suggestProgression(loadedDef, { weight: 30, reps: 12, targetReps: 12 });
  check("hitting floor below rep-range ceiling suggests +1 rep, not more weight", midRange.note === "progress +rep" && midRange.reps === 13 && midRange.weight === 30);

  // Topped out the rep-range ceiling, no owned-weights configured -> falls back to the old % bump.
  const toppedOutNoDumbbells = L.suggestProgression(loadedDef, { weight: 30, reps: 16, targetReps: 12 });
  check("topping the rep range with no owned weights bumps weight (% fallback)", toppedOutNoDumbbells.note === "progress +weight" && toppedOutNoDumbbells.weight > 30);
  check("weight bump resets reps back to the range floor", toppedOutNoDumbbells.reps === 12);

  // Topped out the rep-range ceiling, owned weights configured -> snaps to the next one owned.
  const ownedWeights = [20, 25, 30, 35, 40];
  const toppedOutWithDumbbells = L.suggestProgression(loadedDef, { weight: 30, reps: 16, targetReps: 12 }, null, ownedWeights);
  check("topping the rep range with owned weights snaps to the next one owned", toppedOutWithDumbbells.weight === 35 && toppedOutWithDumbbells.reps === 12);

  // Already at the heaviest owned weight -> keeps progressing on reps instead of stalling.
  const maxedWeight = L.suggestProgression(loadedDef, { weight: 40, reps: 16, targetReps: 12 }, null, ownedWeights);
  check("maxed out heaviest owned weight keeps progressing on reps", maxedWeight.note === "progress +rep (maxed weight)" && maxedWeight.weight === 40 && maxedWeight.reps === 17);

  const missedTarget = L.suggestProgression(loadedDef, { weight: 30, reps: 9, targetReps: 12 });
  check("missing target on loaded exercise repeats weight", missedTarget.weight === 30 && missedTarget.reps === 12);

  const bodyweightDef = { name: "Push-Up", metric: "reps", loaded: false, targetSets: 4, targetReps: 15 };
  const bwHit = L.suggestProgression(bodyweightDef, { weight: 0, reps: 15, targetReps: 15 });
  check("hitting target on bodyweight exercise suggests +1 rep", bwHit.reps === 16);

  const noHistory = L.suggestProgression(loadedDef, null);
  check("no history falls back to target reps", noHistory.reps === loadedDef.targetReps);

  /* ---- progression suggestion: readiness override ---- */
  const holdSuppressed = L.suggestProgression(loadedDef, { weight: 30, reps: 12, targetReps: 12 }, "HOLD");
  check("HOLD readiness suppresses an increase even after hitting the floor", holdSuppressed.weight === 30 && holdSuppressed.reps === 12 && holdSuppressed.note === "holding (readiness)");
  const recoverySuppressed = L.suggestProgression(loadedDef, { weight: 30, reps: 16, targetReps: 12 }, "RECOVERY");
  check("RECOVERY readiness suppresses a weight bump too", recoverySuppressed.weight === 30 && recoverySuppressed.note === "holding (readiness)");
  const steadyUnaffected = L.suggestProgression(loadedDef, { weight: 30, reps: 12, targetReps: 12 }, "STEADY");
  check("STEADY readiness does not suppress normal progression", steadyUnaffected.note === "progress +rep");
  const bodyweightHoldSuppressed = L.suggestProgression(bodyweightDef, { weight: 0, reps: 15, targetReps: 15 }, "RECOVERY");
  check("RECOVERY also suppresses bodyweight rep progression", bodyweightHoldSuppressed.reps === 15 && bodyweightHoldSuppressed.note === "holding (readiness)");

  /* ---- progression suggestion: failure handling (consecutive misses) ---- */
  const oneMiss = L.suggestProgression(loadedDef, { weight: 30, reps: 9, targetReps: 12 }, null, null, 1);
  check("a single miss just repeats the same weight -- no deload yet", oneMiss.note === "repeat weight" && oneMiss.weight === 30);

  const twoMissesNoDumbbells = L.suggestProgression(loadedDef, { weight: 30, reps: 9, targetReps: 12 }, null, null, 2);
  check("two misses in a row triggers a deload, not a third repeat", twoMissesNoDumbbells.note === "deload -10%");
  // 10% of 30 is 27, floored (never rounded up, to guarantee a real cut) to the nearest 2.5 -> 25.
  check("deload with no owned weights cuts by at least ~10%, floored to a 2.5 increment", twoMissesNoDumbbells.weight === 25 && twoMissesNoDumbbells.weight < 30);
  check("deload resets reps back to the rep-range floor", twoMissesNoDumbbells.reps === 12);

  const threeMisses = L.suggestProgression(loadedDef, { weight: 25, reps: 9, targetReps: 12 }, null, null, 3);
  check("a deload that also gets missed deloads again from the new (lower) weight", threeMisses.note === "deload -10%" && threeMisses.weight < 25);

  const twoMissesWithDumbbells = L.suggestProgression(loadedDef, { weight: 30, reps: 9, targetReps: 12 }, null, ownedWeights, 2);
  check("deload with owned weights snaps down to the nearest one owned", twoMissesWithDumbbells.note === "deload -10%" && twoMissesWithDumbbells.weight === 25);

  // 10% of the lightest owned weight is still that same weight (or heavier) --
  // prevOwnedWeight must not return a "snap" that fails to actually be lower.
  const twoMissesAtLightestOwned = L.suggestProgression(loadedDef, { weight: 20, reps: 9, targetReps: 12 }, null, ownedWeights, 2);
  check("deloading from the lightest owned weight still forces a real step down", twoMissesAtLightestOwned.weight < 20);

  const bodyweightTwoMisses = L.suggestProgression(bodyweightDef, { weight: 0, reps: 10, targetReps: 15 }, null, null, 2);
  check("bodyweight deload backs off on reps (nothing to cut in weight)", bodyweightTwoMisses.note === "deload -20% reps" && bodyweightTwoMisses.reps === 12 && bodyweightTwoMisses.reps < 15);

  const noWeightLoggedYetTwoMisses = L.suggestProgression(loadedDef, { weight: 0, reps: 9, targetReps: 12 }, null, ownedWeights, 2);
  check("a loaded exercise with no weight ever logged deloads via reps, not a cut off of 0", noWeightLoggedYetTwoMisses.note === "deload -20% reps");

  /* ---- progression suggestion: deload week (program-wide override) ---- */
  const deloadWeekOnHit = L.suggestProgression(loadedDef, { weight: 30, reps: 12, targetReps: 12 }, null, null, 0, true);
  check("a deload week backs off even on a session that hit target", deloadWeekOnHit.note === "deload week" && deloadWeekOnHit.weight < 30 && deloadWeekOnHit.reps === 12);

  const deloadWeekOverridesReadiness = L.suggestProgression(loadedDef, { weight: 30, reps: 12, targetReps: 12 }, "PUSH", null, 0, true);
  check("a deload week wins even over a PUSH readiness verdict", deloadWeekOverridesReadiness.note === "deload week");

  const deloadWeekBodyweight = L.suggestProgression(bodyweightDef, { weight: 0, reps: 15, targetReps: 15 }, null, null, 0, true);
  check("a deload week backs off bodyweight reps too", deloadWeekBodyweight.note === "deload week" && deloadWeekBodyweight.reps < 15);

  const deloadWeekWithDumbbells = L.suggestProgression(loadedDef, { weight: 30, reps: 12, targetReps: 12 }, null, ownedWeights, 0, true);
  check("a deload week also snaps to an owned weight when one's configured", deloadWeekWithDumbbells.weight === 25);

  /* ---- helpers: prevOwnedWeight / isDeloadWeekActive ---- */
  check("prevOwnedWeight finds the nearest owned weight at or below target", L.prevOwnedWeight(28, ownedWeights) === 25);
  check("prevOwnedWeight returns null with no owned weights configured", L.prevOwnedWeight(28, []) === null);
  check("prevOwnedWeight returns null when target is below every owned weight", L.prevOwnedWeight(10, ownedWeights) === null);

  const deloadState = L.freshState();
  deloadState.deloadWeeks = { "2026-09-20": true };
  check("isDeloadWeekActive is true for a flagged week", L.isDeloadWeekActive(deloadState, "2026-09-20") === true);
  check("isDeloadWeekActive is false for an unflagged week", L.isDeloadWeekActive(deloadState, "2026-09-27") === false);
  check("isDeloadWeekActive tolerates a missing deloadWeeks map", L.isDeloadWeekActive({}, "2026-09-20") === false);

  /* ---- custom-exercise progression ("beat your last time") ---- */
  const noCustomHistory = L.suggestCustomProgression(null);
  check("suggestCustomProgression with no catalog entry reports no history", noCustomHistory.note === "no history");

  // Custom exercises use last performance as their own target (targetReps = lastReps),
  // so the same rep-range-before-weight rule applies: 10 reps against a floor of 10
  // (ceiling 14) is still mid-range, so it suggests +1 rep at the same weight.
  const weightedCustomEntry = { name: "Farmer Carry", lastReps: 10, lastWeight: 40, loaded: true, metric: "reps" };
  const weightedCustomSuggestion = L.suggestCustomProgression(weightedCustomEntry);
  check("weighted custom exercise mid-range suggests +1 rep at the same weight", weightedCustomSuggestion.note === "progress +rep" && weightedCustomSuggestion.reps === 11 && weightedCustomSuggestion.weight === 40);

  const bodyweightCustomEntry = { name: "Wall Sit", lastReps: 45, lastWeight: 0, loaded: false, metric: "seconds" };
  const bodyweightCustomSuggestion = L.suggestCustomProgression(bodyweightCustomEntry);
  check("bodyweight custom exercise suggests +1 over last time", bodyweightCustomSuggestion.reps === 46);

  // A custom exercise's own missStreak (tracked in its catalog entry, same
  // as a template exercise) still triggers a deload, and a deload week
  // still overrides a custom exercise too.
  const strugglingCustomEntry = { name: "Sled Push", lastReps: 8, lastWeight: 50, loaded: true, metric: "reps", missStreak: 2 };
  const strugglingCustomSuggestion = L.suggestCustomProgression(strugglingCustomEntry);
  check("a custom exercise's own missStreak triggers a deload", strugglingCustomSuggestion.note === "deload -10%" && strugglingCustomSuggestion.weight < 50);
  const customDeloadWeekSuggestion = L.suggestCustomProgression(weightedCustomEntry, null, null, true);
  check("a deload week overrides a custom exercise's suggestion too", customDeloadWeekSuggestion.note === "deload week" && customDeloadWeekSuggestion.weight < 40);

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

  // A v1 blob (has schemaVersion:1, no templates/longestStreak) chains all the
  // way through v2/v3/v4 too, since migrate() keeps applying the next step
  // once a version matches -- it doesn't stop at "the next one up".
  const v1Blob = { schemaVersion: 1, xp: 50, restDays: [0], weekPlan: Object.assign({}, L.DEFAULT_WEEK_PLAN), weekOverrides: {}, baselines: L.DEFAULT_BASELINES, exercises: {}, sessions: [], readiness: {} };
  const fromV1 = L.migrate(v1Blob);
  check("v1->v2 migration adds templates", !!fromV1.templates);
  check("v1->v2 migration adds longestStreak", fromV1.longestStreak === 0);
  check("v1->v2 migration preserves existing xp", fromV1.xp === 50);
  check("v1 blob chains all the way to the current schema version", fromV1.schemaVersion === L.SCHEMA_VERSION);

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
  check("v2 blob also chains through v3->v4, adding ownedWeights", Array.isArray(fromV2.ownedWeights));
  check("v2 blob's catalog gets a bestE1RM even with no session history (0)", fromV2.exercises["Farmer Carry"].bestE1RM === 0);

  // A v3 blob (real weighted session history, but catalog entries predate
  // bestE1RM) should backfill bestE1RM by rescanning that history -- not by
  // deriving it from the existing bestWeight/bestReps fields, which can
  // come from different sets and can't reconstruct which set actually
  // produced the best estimated 1RM.
  const v3Blob = {
    schemaVersion: 3, xp: 200, restDays: [0, 4], weekPlan: Object.assign({}, L.DEFAULT_WEEK_PLAN),
    weekOverrides: {}, baselines: L.DEFAULT_BASELINES, readiness: {},
    templates: L.cloneTemplates(L.WORKOUT_TEMPLATES), longestStreak: 5,
    exercises: {
      "Goblet Squat": { name: "Goblet Squat", lastReps: 10, lastWeight: 30, bestWeight: 30, bestReps: 12, metric: "reps", loaded: true, lastSetCount: 3, updatedAt: "2026-08-15T00:00:00.000Z" }
    },
    sessions: [
      { id: 1, date: "2026-08-01", dayLabel: "Lower", type: "workout", templateId: "lower", exercises: [{ name: "Goblet Squat", isCustom: false, sets: [{ reps: 8, weight: 25, cadenceMs: null }] }], cardio: null, xpEarned: 0, completedAt: "2026-08-01T00:00:00.000Z" },
      { id: 2, date: "2026-08-08", dayLabel: "Lower", type: "workout", templateId: "lower", exercises: [{ name: "Goblet Squat", isCustom: false, sets: [{ reps: 12, weight: 30, cadenceMs: null }] }], cardio: null, xpEarned: 0, completedAt: "2026-08-08T00:00:00.000Z" }
    ]
  };
  const fromV3 = L.migrate(v3Blob);
  check("v3->v4 migration stamps current schema version", fromV3.schemaVersion === L.SCHEMA_VERSION);
  const expectedE1RM = Math.round(30 * (1 + 12 / 30)); // best session was 30lb x12
  check("v3->v4 migration backfills bestE1RM from session history", fromV3.exercises["Goblet Squat"].bestE1RM === expectedE1RM);
  check("v3->v4 migration preserves existing catalog fields", fromV3.exercises["Goblet Squat"].lastWeight === 30);
  check("v3->v4 migration defaults ownedWeights to an empty array", Array.isArray(fromV3.ownedWeights) && fromV3.ownedWeights.length === 0);
  // The chain doesn't stop at v4 either -- it continues straight through
  // to v5, backfilling missStreak and deloadWeeks on the same blob.
  check("a v3 blob also chains through v4->v5, backfilling missStreak", fromV3.exercises["Goblet Squat"].missStreak === 0);
  check("a v3 blob also chains through v4->v5, defaulting deloadWeeks", fromV3.deloadWeeks && typeof fromV3.deloadWeeks === "object");

  // A v4 blob (schemaVersion:4, catalog entries with bestE1RM but no
  // missStreak yet, no deloadWeeks) should backfill missStreak at 0 --
  // reconstructing a real streak from history isn't reliable (it depends
  // on whatever target was live in the template at the time), so this
  // intentionally starts fresh rather than guessing.
  const v4Blob = {
    schemaVersion: 4, xp: 300, restDays: [0, 4], weekPlan: Object.assign({}, L.DEFAULT_WEEK_PLAN),
    weekOverrides: {}, baselines: L.DEFAULT_BASELINES, readiness: {}, sessions: [],
    templates: L.cloneTemplates(L.WORKOUT_TEMPLATES), longestStreak: 8, ownedWeights: [20, 25, 30],
    exercises: {
      "Goblet Squat": { name: "Goblet Squat", lastReps: 10, lastWeight: 30, bestWeight: 30, bestReps: 12, bestE1RM: 42, metric: "reps", loaded: true, lastSetCount: 3, updatedAt: "2026-08-15T00:00:00.000Z" }
    }
  };
  const fromV4 = L.migrate(v4Blob);
  check("v4->v5 migration stamps current schema version", fromV4.schemaVersion === L.SCHEMA_VERSION);
  check("v4->v5 migration backfills missStreak at 0", fromV4.exercises["Goblet Squat"].missStreak === 0);
  check("v4->v5 migration preserves existing catalog fields", fromV4.exercises["Goblet Squat"].bestE1RM === 42);
  check("v4->v5 migration defaults deloadWeeks to an empty object", fromV4.deloadWeeks && Object.keys(fromV4.deloadWeeks).length === 0);
  check("v4->v5 migration preserves other top-level fields", fromV4.ownedWeights.length === 3 && fromV4.longestStreak === 8);

  // A v5 blob (schemaVersion:5, no baselinesAuto yet) should default to
  // auto EXCEPT when baselines were already customized away from the
  // defaults before this feature existed -- that's a deliberate manual
  // choice already made and shouldn't be silently overridden on upgrade.
  const v5BlobDefaultBaselines = Object.assign({}, v4Blob, { schemaVersion: 5, deloadWeeks: {}, exercises: { "Goblet Squat": Object.assign({}, v4Blob.exercises["Goblet Squat"], { missStreak: 1 }) } });
  const fromV5Default = L.migrate(v5BlobDefaultBaselines);
  check("v5->v6 migration defaults to auto baselines when unchanged from defaults", fromV5Default.baselinesAuto === true);

  const v5BlobCustomBaselines = Object.assign({}, v5BlobDefaultBaselines, { baselines: { restingHR: 52, sleepGood: 80, sleepLow: 55 } });
  const fromV5Custom = L.migrate(v5BlobCustomBaselines);
  check("v5->v6 migration respects already-customized baselines as manual", fromV5Custom.baselinesAuto === false);
  check("v5->v6 migration stamps current schema version", fromV5Custom.schemaVersion === L.SCHEMA_VERSION);

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
  check("exercise view-model pulls suggestion from catalog history", squatVm.suggestion.reps === 13 && squatVm.suggestion.weight === 30);
  check("exercise view-model pads sets to target count", squatVm.sets.length === squatDef.targetSets);

  fixtureState.exercises["Goblet Squat Maxed"] = { name: "Goblet Squat Maxed", lastReps: 16, lastWeight: 30, updatedAt: new Date().toISOString() };
  const squatMaxedDef = Object.assign({}, squatDef, { name: "Goblet Squat Maxed" });
  const squatMaxedVm = L.buildExerciseViewModel(squatMaxedDef, null, fixtureState.exercises, null, [20, 25, 30, 35]);
  check("exercise view-model passes readiness/ownedWeights through to progression", squatMaxedVm.suggestion.weight === 35);

  fixtureState.exercises["Goblet Squat Deloading"] = { name: "Goblet Squat Deloading", lastReps: 10, lastWeight: 30, missStreak: 2, updatedAt: new Date().toISOString() };
  const squatDeloadingDef = Object.assign({}, squatDef, { name: "Goblet Squat Deloading" });
  const squatDeloadingVm = L.buildExerciseViewModel(squatDeloadingDef, null, fixtureState.exercises);
  check("exercise view-model reads missStreak from the catalog and deloads", squatDeloadingVm.suggestion.note === "deload -10%");

  const squatDeloadWeekVm = L.buildExerciseViewModel(squatDef, null, fixtureState.exercises, null, null, true);
  check("exercise view-model passes isDeloadWeek through to progression", squatDeloadWeekVm.suggestion.note === "deload week");

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

  // Regression: "Swap this day" is offered on the rest-day screen itself, so
  // swapping a rest day to a training template must actually take effect --
  // not silently stay a rest day while offering a workout nobody can reach.
  const swapRestDayState = L.freshState();
  swapRestDayState.restDays = [0, 4];
  const thuDate = new Date("2026-09-24T09:00:00"); // Thu, a rest day by default
  const thuWeekKey = L.weekStartKey(thuDate);
  swapRestDayState.weekOverrides[thuWeekKey] = { 4: "upperA" };

  const thuVm = L.buildTodayViewModel(swapRestDayState, thuDate);
  check("swapping a rest day to a training template un-rests it in the view-model", thuVm.isRest === false);
  check("swapped rest day resolves to the swapped template", thuVm.templateId === "upperA");
  check("a swapped rest day with nothing logged is not auto-compliant", !L.isDayCompliant(swapRestDayState, thuDate));

  swapRestDayState.sessions.push(buildCompleteWorkoutSession("2026-09-24", swapRestDayState.templates.upperA));
  check("a swapped rest day IS compliant once the swapped workout is actually completed", L.isDayCompliant(swapRestDayState, thuDate));
  check("an un-swapped rest day in the same fixture is still automatically compliant", L.isDayCompliant(swapRestDayState, new Date("2026-09-20T09:00:00"))); // Sun, no override

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

  /* ---- computeLongestStreakEver: a persisted historical peak that
     survives a later break, unlike state.longestStreak (which was never
     actually written back anywhere -- see Store/app-shell) ---- */
  check("computeLongestStreakEver scans the known activity window", L.computeLongestStreakEver(streakState, fridayMorning) === 5);

  const historicalPeakState = L.freshState();
  historicalPeakState.restDays = [0, 4];
  const hpTemplates = historicalPeakState.templates;
  historicalPeakState.sessions.push(buildCompleteWorkoutSession("2026-09-21", hpTemplates.upperA)); // Mon
  historicalPeakState.sessions.push(buildCardioSession("2026-09-22", 30));                          // Tue
  historicalPeakState.sessions.push(buildCompleteWorkoutSession("2026-09-23", hpTemplates.lower));  // Wed
  // Thu 24th is a rest day -> auto-compliant, no session needed.
  historicalPeakState.sessions.push(buildCompleteWorkoutSession("2026-09-25", hpTemplates.upperB)); // Fri
  // Sat 26th (a training/cardio day) intentionally left unlogged -- breaks the run.
  const muchLater = new Date("2026-10-02T09:00:00"); // the following Friday, well past the break
  check("computeLongestStreakEver remembers a peak even after the streak later breaks", L.computeLongestStreakEver(historicalPeakState, muchLater) === 5);
  check("meanwhile the live current streak has actually dropped well below the peak", L.computeStreakInfo(historicalPeakState, muchLater).current < 5);

  /* ---- import validation: reject anything that isn't plausibly a TRAIN
     backup, and any backup from a newer schema version than this app
     supports, before migrate() is ever allowed to touch it ---- */
  check("isTrainBackupShape accepts a real export shape", L.isTrainBackupShape(L.freshState()));
  check("isTrainBackupShape rejects an unrelated JSON file", !L.isTrainBackupShape({ planChanges: { templates: {} } }));
  check("isTrainBackupShape rejects null/non-object input", !L.isTrainBackupShape(null) && !L.isTrainBackupShape("hello") && !L.isTrainBackupShape([1, 2, 3]));

  const validImport = L.validateImportPayload(L.freshState());
  check("validateImportPayload accepts a real backup", validImport.valid === true);

  const unrelatedImport = L.validateImportPayload({ planChanges: { templates: {} } });
  check("validateImportPayload rejects an unrelated JSON file", unrelatedImport.valid === false && /doesn't look like/.test(unrelatedImport.error));

  const futureImport = L.validateImportPayload(Object.assign({}, L.freshState(), { schemaVersion: L.SCHEMA_VERSION + 1 }));
  check("validateImportPayload rejects a backup from a newer schema version", futureImport.valid === false && /newer version/.test(futureImport.error));

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

  /* ---- Strength attribute: trend-based (avg % change in performance),
     not a straight PR count -- see computeStrengthTrend for why ---- */
  const freshTrend = L.computeStrengthTrend(L.freshState(), fridayMorning, 30);
  check("computeStrengthTrend reports no trend with under 2 sessions per exercise", freshTrend.avgPct === null && freshTrend.exerciseCount === 0);

  const strengthTrendState = L.freshState();
  strengthTrendState.sessions = [
    { date: "2026-09-01", exercises: [{ name: "Goblet Squat", sets: [{ reps: 10, weight: 20 }] }] },
    { date: "2026-09-15", exercises: [{ name: "Goblet Squat", sets: [{ reps: 10, weight: 24 }] }] },
    { date: "2026-09-20", exercises: [{ name: "Push-Up", sets: [{ reps: 20, weight: 0 }] }] } // only 1 session -- excluded
  ];
  // listLoggedExercises (the name list computeStrengthTrend scans) reads
  // from the catalog, not the sessions array -- populate it too, same as
  // updateExerciseCatalog would from real logging.
  strengthTrendState.exercises = {
    "Goblet Squat": { name: "Goblet Squat", lastReps: 10, lastWeight: 24, updatedAt: "2026-09-15T00:00:00.000Z" },
    "Push-Up": { name: "Push-Up", lastReps: 20, lastWeight: 0, updatedAt: "2026-09-20T00:00:00.000Z" }
  };
  const trend = L.computeStrengthTrend(strengthTrendState, fridayMorning, 30);
  check("computeStrengthTrend only counts exercises with 2+ sessions in the window", trend.exerciseCount === 1);
  // buildExerciseHistory rounds est1RM to the nearest lb (it's a display/
  // comparison value, not raw math) -- the expected % change uses those
  // same rounded endpoints (27 -> 32), not the unrounded 1RM formula.
  const expectedFirstE1RM = Math.round(20 * (1 + 10 / 30)), expectedLastE1RM = Math.round(24 * (1 + 10 / 30));
  const expectedPct = (expectedLastE1RM - expectedFirstE1RM) / expectedFirstE1RM;
  check("computeStrengthTrend computes % change from earliest to latest in-window value", Math.abs(trend.avgPct - expectedPct) < 0.0001);

  const attrsWithTrend = L.computeAttributes(strengthTrendState, fridayMorning);
  check("Strength score centers at 50 for a flat trend, rises above it for a positive one", attrsWithTrend.strength.score > 50 && attrsWithTrend.strength.score <= 99);
  check("Strength detail reports the average trend percentage", attrsWithTrend.strength.detail.indexOf("%") !== -1);

  const decliningState = L.freshState();
  decliningState.sessions = [
    { date: "2026-09-01", exercises: [{ name: "Dumbbell Row", sets: [{ reps: 10, weight: 30 }] }] },
    { date: "2026-09-15", exercises: [{ name: "Dumbbell Row", sets: [{ reps: 10, weight: 25 }] }] }
  ];
  decliningState.exercises = { "Dumbbell Row": { name: "Dumbbell Row", lastReps: 10, lastWeight: 25, updatedAt: "2026-09-15T00:00:00.000Z" } };
  const decliningAttrs = L.computeAttributes(decliningState, fridayMorning);
  check("Strength score drops below 50 on a declining trend", decliningAttrs.strength.score < 50);

  // Regression: the old PR-count formula spiked the moment you added a
  // brand-new exercise (a first-ever log trivially "beats" a baseline of
  // zero). A single log with no repeat now contributes no trend at all.
  const freshExerciseOnly = L.freshState();
  freshExerciseOnly.sessions = [{ date: "2026-09-20", exercises: [{ name: "Brand New Lift", sets: [{ reps: 10, weight: 50 }] }] }];
  freshExerciseOnly.exercises = { "Brand New Lift": { name: "Brand New Lift", lastReps: 10, lastWeight: 50, updatedAt: "2026-09-20T00:00:00.000Z" } };
  const freshExerciseAttrs = L.computeAttributes(freshExerciseOnly, fridayMorning);
  check("a single new exercise doesn't inflate Strength (no trend yet)", freshExerciseAttrs.strength.score === 0);

  /* ---- Endurance attribute: effort-adjusted by logged avg HR ---- */
  check("cardioEffortMultiplier is neutral (1x) with no HR logged", L.cardioEffortMultiplier({ durationMin: 30 }, L.DEFAULT_BASELINES) === 1);
  const hardMultiplier = L.cardioEffortMultiplier({ durationMin: 30, hr: 150 }, L.DEFAULT_BASELINES);
  const easyMultiplier = L.cardioEffortMultiplier({ durationMin: 30, hr: 90 }, L.DEFAULT_BASELINES);
  check("a higher avg HR yields a higher effort multiplier than a lower one", hardMultiplier > easyMultiplier);
  check("cardioEffortMultiplier is clamped to a sane range", L.cardioEffortMultiplier({ hr: 300 }, L.DEFAULT_BASELINES) <= 1.6 && L.cardioEffortMultiplier({ hr: 1 }, L.DEFAULT_BASELINES) >= 0.7);

  const hrCardioState = L.freshState();
  hrCardioState.sessions = [{ date: "2026-09-20", cardio: { cardioType: "Run", durationMin: 30, hr: 150 }, exercises: [] }];
  const noHrCardioState = L.freshState();
  noHrCardioState.sessions = [{ date: "2026-09-20", cardio: { cardioType: "Bike", durationMin: 30 }, exercises: [] }];
  const hrAttrs = L.computeAttributes(hrCardioState, fridayMorning);
  const noHrAttrs = L.computeAttributes(noHrCardioState, fridayMorning);
  check("a high-HR cardio session scores higher Endurance than the same duration with no HR logged", hrAttrs.endurance.score > noHrAttrs.endurance.score);
  check("Endurance detail notes when it's effort-adjusted", hrAttrs.endurance.detail.indexOf("effort-adjusted") !== -1);
  check("Endurance detail does NOT claim effort-adjustment with no HR logged", noHrAttrs.endurance.detail.indexOf("effort-adjusted") === -1);
  check("Endurance detail always shows the real raw minutes you actually logged", hrAttrs.endurance.detail.indexOf("30 cardio min") !== -1);

  /* ---- digest ---- */
  const digest = L.buildDigest(streakState, fridayMorning);
  check("digest is a non-empty string", typeof digest === "string" && digest.length > 100);
  check("digest includes the streak snapshot", digest.indexOf("Current streak") !== -1);
  check("digest includes a PR section", digest.indexOf("PRs in the last 30 days") !== -1);
  check("digest includes a plateaued-exercises section", digest.indexOf("Plateaued exercises") !== -1);
  check("digest includes the plan-change JSON schema instructions", digest.indexOf("Import Plan Changes") !== -1 && digest.indexOf("```json") !== -1);

  // Regression: a reps-axis PR on a timed/bodyweight exercise (e.g. Plank,
  // metric "seconds") must be labeled with its real unit, not a hardcoded
  // "reps" -- the digest is meant to be read literally by a human or an AI.
  const timedPrState = L.freshState();
  timedPrState.sessions = [{ date: "2026-09-20", exercises: [{ name: "Plank", sets: [{ reps: 45, weight: 0 }] }] }];
  timedPrState.exercises = { "Plank": { name: "Plank", lastReps: 45, lastWeight: 0, metric: "seconds", loaded: false, updatedAt: "2026-09-20T00:00:00.000Z" } };
  const timedPrDigest = L.buildDigest(timedPrState, fridayMorning);
  check("digest labels a timed exercise's PR in seconds, not reps", timedPrDigest.indexOf("Plank — 45 sec") !== -1 && timedPrDigest.indexOf("45 reps") === -1);

  /* ---- digest: deload status ---- */
  check("digest includes a deload-status section", digest.indexOf("Deload status") !== -1);
  check("digest reports the current week as NOT a deload week by default", digest.indexOf("This week is NOT currently marked a deload week.") !== -1);

  const deloadDigestState = L.freshState();
  deloadDigestState.deloadWeeks[L.weekStartKey(fridayMorning)] = true;
  const deloadDigest = L.buildDigest(deloadDigestState, fridayMorning);
  check("digest reflects an active deload week", deloadDigest.indexOf("This week is currently marked a deload week.") !== -1);

  const strugglingDigestState = L.freshState();
  strugglingDigestState.exercises = {
    "Goblet Squat": { name: "Goblet Squat", lastReps: 10, lastWeight: 30, missStreak: 2, updatedAt: "2026-09-20T00:00:00.000Z" },
    "Dumbbell Row": { name: "Dumbbell Row", lastReps: 8, lastWeight: 25, missStreak: 3, updatedAt: "2026-09-20T00:00:00.000Z" }
  };
  const strugglingDigest = L.buildDigest(strugglingDigestState, fridayMorning);
  check("digest names exercises on a 2+ session miss streak", strugglingDigest.indexOf("Goblet Squat") !== -1 && strugglingDigest.indexOf("Dumbbell Row") !== -1 && strugglingDigest.indexOf("miss streak") !== -1);
  check("digest suggests a deload week when multiple exercises are struggling", strugglingDigest.indexOf("Worth considering a deload week") !== -1);

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

  /* ---- plateau detection ---- */
  const plateauState = L.freshState();
  const plateauSessions = [
    { date: "2026-08-01", exercises: [{ name: "Goblet Squat", sets: [{ reps: 10, weight: 20 }] }, { name: "Push-Up", sets: [{ reps: 15, weight: 0 }] }] },
    { date: "2026-08-08", exercises: [{ name: "Goblet Squat", sets: [{ reps: 10, weight: 20 }] }, { name: "Push-Up", sets: [{ reps: 18, weight: 0 }] }] },
    { date: "2026-08-15", exercises: [{ name: "Goblet Squat", sets: [{ reps: 10, weight: 20 }] }, { name: "Push-Up", sets: [{ reps: 20, weight: 0 }] }] }
  ];
  plateauState.sessions = plateauSessions;
  plateauState.exercises = {
    "Goblet Squat": { name: "Goblet Squat", lastReps: 10, lastWeight: 20, bestWeight: 20, bestReps: 10, metric: "reps", loaded: true, updatedAt: "2026-08-15T00:00:00.000Z" },
    "Push-Up": { name: "Push-Up", lastReps: 20, lastWeight: 0, bestWeight: 0, bestReps: 20, metric: "reps", loaded: false, updatedAt: "2026-08-15T00:00:00.000Z" }
  };
  const plateaus = L.detectPlateaus(plateauState, 3);
  check("detectPlateaus flags an exercise with no net progress across the window", plateaus.some((p) => p.exercise === "Goblet Squat"));
  check("detectPlateaus does not flag an exercise that's still improving", !plateaus.some((p) => p.exercise === "Push-Up"));
  const tooFewSessions = L.detectPlateaus(Object.assign({}, plateauState, { sessions: [plateauSessions[0]] }), 3);
  check("detectPlateaus says nothing when there's too little history", tooFewSessions.length === 0);

  // Regression (workout fix #4): reps increasing at a constant weight is
  // real progress and must not register as a plateau just because the raw
  // weight number never moved -- the old comparison used raw best weight,
  // which called 30lb x8 -> 30lb x12 "no progress."
  const repProgressState = L.freshState();
  const repProgressSessions = [
    { date: "2026-08-01", exercises: [{ name: "Bench Press", sets: [{ reps: 8, weight: 30 }] }] },
    { date: "2026-08-08", exercises: [{ name: "Bench Press", sets: [{ reps: 10, weight: 30 }] }] },
    { date: "2026-08-15", exercises: [{ name: "Bench Press", sets: [{ reps: 12, weight: 30 }] }] }
  ];
  repProgressState.sessions = repProgressSessions;
  repProgressState.exercises = {
    "Bench Press": { name: "Bench Press", lastReps: 12, lastWeight: 30, bestWeight: 30, bestReps: 12, metric: "reps", loaded: true, updatedAt: "2026-08-15T00:00:00.000Z" }
  };
  const repProgressPlateaus = L.detectPlateaus(repProgressState, 3);
  check("detectPlateaus does not flag rising reps at a constant weight as a plateau (est. 1RM)", !repProgressPlateaus.some((p) => p.exercise === "Bench Press"));

  const repProgressPrs = L.countRecentPRs(repProgressSessions, "2026-08-02");
  check("countRecentPRs credits a rep increase at the same weight as a PR (est. 1RM)", repProgressPrs.length === 2 && repProgressPrs.every((pr) => pr.weight === 30));

  /* ---- estimated 1RM helpers ---- */
  check("estimate1RM uses the Epley formula", L.estimate1RM(100, 10) === 100 * (1 + 10 / 30));
  check("estimate1RM of a 1-rep set is just the weight", L.estimate1RM(135, 1) === 135 * (1 + 1 / 30));

  const mixedSets = [{ reps: 8, weight: 30 }, { reps: 12, weight: 25 }, { reps: 5, weight: null }];
  const bestSet = L.bestE1RMInSets(mixedSets);
  // 30x8 -> e1rm 38; 25x12 -> e1rm 35; the unloaded set is ignored entirely.
  check("bestE1RMInSets picks the set with the highest estimated 1RM, not the heaviest weight", bestSet.weight === 30 && bestSet.reps === 8);
  check("bestE1RMInSets returns null when no set in the group was weighted", L.bestE1RMInSets([{ reps: 10, weight: 0 }, { reps: 12, weight: null }]) === null);

  /* ---- plan-change import: parse ---- */
  const validPayloadText = "Here's my advice...\n```json\n" + JSON.stringify({
    planChanges: {
      templates: { upperA: { exercises: [
        { name: "Pull-Up", metric: "reps", loaded: true, targetSets: 4, targetReps: 10 },
        { name: "Face Pull", metric: "reps", loaded: true, targetSets: 3, targetReps: 15 }
      ] } },
      weekPlan: { "5": "cardio" }
    }
  }) + "\n```\nHope that helps!";
  const parsedValid = L.parsePlanChangePayload(validPayloadText);
  check("parsePlanChangePayload extracts a fenced JSON block from surrounding prose", parsedValid.valid === true);
  check("parsePlanChangePayload keeps a valid template's exercises", parsedValid.payload.templates.upperA.length === 2);
  check("parsePlanChangePayload keeps a valid weekPlan entry", parsedValid.payload.weekPlan[5] === "cardio");

  const unknownTemplateText = "```json\n" + JSON.stringify({ planChanges: { templates: { madeUpTemplate: { exercises: [{ name: "X", targetSets: 3, targetReps: 10 }] } } } }) + "\n```";
  const parsedUnknown = L.parsePlanChangePayload(unknownTemplateText);
  check("parsePlanChangePayload rejects an unknown template id with an error, not a crash", parsedUnknown.valid === false && parsedUnknown.errors.length > 0);

  const garbageText = "not json at all, just some advice about training harder";
  const parsedGarbage = L.parsePlanChangePayload(garbageText);
  check("parsePlanChangePayload fails cleanly on text with no JSON", parsedGarbage.valid === false);

  const floorText = "```json\n" + JSON.stringify({ planChanges: { templates: { upperA: { exercises: [{ name: "Bad Sets", targetSets: 0, targetReps: -5 }] } } } }) + "\n```";
  const parsedFloor = L.parsePlanChangePayload(floorText);
  check("parsePlanChangePayload floors invalid targetSets/targetReps at 1", parsedFloor.payload.templates.upperA[0].targetSets === 1 && parsedFloor.payload.templates.upperA[0].targetReps === 1);

  /* ---- growable workout templates ---- */
  check("getTemplateIds lists the built-in templates for a fresh account", L.getTemplateIds(L.freshState()).length === 4);

  const addResult1 = L.addTemplate(L.WORKOUT_TEMPLATES, "Arms Day");
  check("addTemplate slugifies the label into a readable id", addResult1.id === "arms-day");
  check("addTemplate adds a new empty template under that id", addResult1.templates["arms-day"].label === "Arms Day" && addResult1.templates["arms-day"].exercises.length === 0);
  check("addTemplate does not mutate the source templates map", !L.WORKOUT_TEMPLATES["arms-day"]);

  const addResult2 = L.addTemplate(addResult1.templates, "Arms Day");
  check("addTemplate disambiguates a duplicate label with a numeric suffix", addResult2.id === "arms-day-2");

  const removed = L.removeTemplateFromMap(addResult1.templates, "arms-day");
  check("removeTemplateFromMap removes only the targeted template", !removed["arms-day"] && removed.upperA);
  check("removeTemplateFromMap does not mutate the source templates map", !!addResult1.templates["arms-day"]);

  const inUseState = L.freshState();
  inUseState.weekPlan = Object.assign({}, inUseState.weekPlan, { 1: "upperA", 3: "upperA" });
  check("templateWeekdaysInUse finds every weekday assigned to a template", L.templateWeekdaysInUse(inUseState, "upperA").join(",") === "1,3");
  check("templateWeekdaysInUse is empty for a template no weekday is assigned to", L.templateWeekdaysInUse(inUseState, "lower").length === 0);

  // Passing state lets a custom-added template be proposed via plan-change
  // import too, not just the 4 built-in ones -- the whole point of making
  // templates growable is that nothing downstream should still treat them
  // as a fixed list.
  const customTemplateState = L.freshState();
  const addedCustom = L.addTemplate(customTemplateState.templates, "Arms Day");
  customTemplateState.templates = addedCustom.templates;
  const customTemplateText = "```json\n" + JSON.stringify({ planChanges: { templates: { "arms-day": { exercises: [{ name: "Curl", targetSets: 3, targetReps: 12 }] } } } }) + "\n```";
  const parsedWithoutState = L.parsePlanChangePayload(customTemplateText);
  check("parsePlanChangePayload rejects a custom template id when called without state (back-compat default)", parsedWithoutState.valid === false);
  const parsedWithState = L.parsePlanChangePayload(customTemplateText, customTemplateState);
  check("parsePlanChangePayload accepts a custom template id when given the real state", parsedWithState.valid === true && parsedWithState.payload.templates["arms-day"].length === 1);

  /* ---- plan-change import: create / rename templates, rest days ---- */
  const fullPlanText = "```json\n" + JSON.stringify({ planChanges: {
    templates: {
      lower: { label: "Legs & Core", exercises: [{ name: "Goblet Squat", metric: "reps", loaded: true, targetSets: 4, targetReps: 12, targetRepsMax: 20 }] },
      explosive: { label: "Explosive Power", exercises: [{ name: "Burpee", metric: "reps", loaded: false, targetSets: 3, targetReps: 10, targetRepsMax: 15 }] }
    },
    weekPlan: { "2": "lower", "4": "explosive" },
    restDays: [3, 0]
  } }) + "\n```";
  const planState = L.freshState();
  const parsedFull = L.parsePlanChangePayload(fullPlanText, planState);
  check("parsePlanChangePayload creates a new template when given a label", parsedFull.valid && parsedFull.payload.templates.explosive.length === 1 && parsedFull.payload.labels.explosive === "Explosive Power");
  check("parsePlanChangePayload lets a weekday point at a template created in the same payload", parsedFull.payload.weekPlan[4] === "explosive");
  check("parsePlanChangePayload normalizes restDays (sorted)", parsedFull.payload.restDays.join(",") === "0,3");
  check("parsePlanChangePayload keeps targetRepsMax on a weighted exercise", parsedFull.payload.templates.lower[0].targetRepsMax === 20);
  check("parsePlanChangePayload drops targetRepsMax on a bodyweight exercise", parsedFull.payload.templates.explosive[0].targetRepsMax === undefined);

  const fullDiff = L.diffPlanChanges(planState, parsedFull.payload);
  check("diffPlanChanges shows a rename line for a relabeled template", fullDiff.some((d) => d.templateId === "lower" && d.lines.some((l) => l.indexOf("Renamed:") === 0)));
  check("diffPlanChanges titles a brand-new template as new", fullDiff.some((d) => d.templateId === "explosive" && d.isNew && d.label.indexOf("New template") === 0));
  check("diffPlanChanges shows a rest-day change", fullDiff.some((d) => d.type === "restDays" && d.to === "Sun, Wed"));
  check("diffPlanChanges labels a weekday pointing at a new template by its new label", fullDiff.some((d) => d.type === "weekday" && d.day === 4 && d.to === "Explosive Power"));

  const appliedFull = L.applyPlanChanges(planState, parsedFull.payload);
  check("applyPlanChanges creates the new template with its id and label", appliedFull.templates.explosive.id === "explosive" && appliedFull.templates.explosive.label === "Explosive Power");
  check("applyPlanChanges renames an existing template", appliedFull.templates.lower.label === "Legs & Core");
  check("applyPlanChanges applies rest days", appliedFull.restDays.join(",") === "0,3");
  check("applyPlanChanges does not mutate the source state", planState.restDays.join(",") === L.DEFAULT_REST_DAYS.join(",") && !planState.templates.explosive);

  const badIdText = "```json\n" + JSON.stringify({ planChanges: { templates: { "Bad Id!": { label: "X", exercises: [{ name: "X", targetSets: 3, targetReps: 10 }] } } } }) + "\n```";
  check("parsePlanChangePayload rejects a new template id that isn't lowercase-dashed", L.parsePlanChangePayload(badIdText, planState).valid === false);

  const cardioEditText = "```json\n" + JSON.stringify({ planChanges: { templates: { cardio: { exercises: [{ name: "X", targetSets: 3, targetReps: 10 }] } } } }) + "\n```";
  check("parsePlanChangePayload refuses to give the cardio template an exercise list", L.parsePlanChangePayload(cardioEditText, planState).valid === false);

  const noRestText = "```json\n" + JSON.stringify({ planChanges: { restDays: [] } }) + "\n```";
  const parsedNoRest = L.parsePlanChangePayload(noRestText, planState);
  check("parsePlanChangePayload rejects an empty restDays list", parsedNoRest.valid === false && parsedNoRest.errors.some((e) => e.indexOf("restDays") === 0));

  /* ---- plan-change import: diff + apply ---- */
  const diffState = L.freshState();
  const diffPayload = {
    templates: {
      upperA: diffState.templates.upperA.exercises.map(function (e, i) {
        return i === 0 ? Object.assign({}, e, { targetSets: e.targetSets + 1 }) : e;
      }).concat([{ name: "Face Pull", metric: "reps", loaded: true, targetSets: 3, targetReps: 15 }])
    },
    weekPlan: { 5: "cardio" }
  };
  const diffResult = L.diffPlanChanges(diffState, diffPayload);
  const templateDiff = diffResult.filter((d) => d.type === "template" && d.templateId === "upperA")[0];
  check("diffPlanChanges reports an added exercise", templateDiff.lines.some((l) => l.indexOf("+ Added: Face Pull") === 0));
  check("diffPlanChanges reports a changed target", templateDiff.lines.some((l) => l.indexOf("→") !== -1));
  const weekdayDiff = diffResult.filter((d) => d.type === "weekday" && d.day === 5)[0];
  check("diffPlanChanges reports a weekday reassignment", !!weekdayDiff && weekdayDiff.to === "Cardio");

  const appliedState = L.applyPlanChanges(diffState, diffPayload);
  check("applyPlanChanges updates the named template's exercises", appliedState.templates.upperA.exercises.length === diffState.templates.upperA.exercises.length + 1);
  check("applyPlanChanges updates weekPlan for the named day", appliedState.weekPlan[5] === "cardio");
  check("applyPlanChanges does not mutate the original state", diffState.templates.upperA.exercises.length === 5);
  check("applyPlanChanges leaves other templates untouched", appliedState.templates.lower === diffState.templates.lower);

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
  // Aug 15 has two sets (10x22, 12x30) -- est1RM must be the best SET's
  // 1RM (30x12 -> 42), not built by independently mixing the session's max
  // weight (30) with its max reps (10, from the other set).
  check("buildExerciseHistory's est1RM is the best single set's estimated 1RM per session", squatHistory.points.map((p) => p.est1RM).join(",") === "28,35,42");

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

  /* ---- exercise bank ---- */
  const freshBank = L.freshState().exerciseBank;
  check("a fresh account's bank includes the built-in exercises", !!freshBank["Burpee"] && freshBank["Burpee"].category === "Conditioning");
  check("a fresh account's bank includes every default-template exercise", L.getTemplateIds(L.freshState()).every((id) => (L.WORKOUT_TEMPLATES[id].exercises || []).every((e) => !!freshBank[e.name])));
  check("every built-in bank entry has one of the five categories", L.DEFAULT_EXERCISE_BANK.every((e) => L.EXERCISE_CATEGORIES.indexOf(e.category) !== -1));

  const seededState = L.freshState();
  seededState.exerciseBank = undefined;
  seededState.exercises = { "Sled Push": { name: "Sled Push", metric: "reps", loaded: true, lastSetCount: 4, lastReps: 8 } };
  const seeded = L.seedExerciseBank(seededState);
  check("seedExerciseBank pulls in logged-only exercises, uncategorized", seeded["Sled Push"] && seeded["Sled Push"].category === null && seeded["Sled Push"].targetSets === 4);

  const kept = L.addMissingToBank({ "Push-Up": { name: "Push-Up", category: "Push", metric: "reps", loaded: true, targetSets: 5, targetReps: 25 } }, [{ name: "Push-Up", targetSets: 1, targetReps: 1 }]);
  check("addMissingToBank never overwrites an existing entry", kept["Push-Up"].targetSets === 5);
  const withBuiltinCat = L.addMissingToBank({}, [{ name: "Goblet Squat", metric: "reps", loaded: true, targetSets: 2, targetReps: 8 }]);
  check("addMissingToBank takes the category from the built-in list, defaults from the def", withBuiltinCat["Goblet Squat"].category === "Legs" && withBuiltinCat["Goblet Squat"].targetSets === 2);

  const legsCore = L.filterExerciseBank(freshBank, "", ["Legs", "Core"]);
  check("filterExerciseBank narrows by category", legsCore.length > 0 && legsCore.every((e) => e.category === "Legs" || e.category === "Core"));
  check("filterExerciseBank sorts by category order then name", legsCore[0].category === "Legs");
  check("filterExerciseBank matches a search query case-insensitively", L.filterExerciseBank(freshBank, "PLANK", []).map((e) => e.name).indexOf("Side Plank") !== -1);

  const templateDef = L.bankEntryToTemplateDef(freshBank["Goblet Squat"]);
  check("bankEntryToTemplateDef copies defaults (not category) into a workout exercise", templateDef.targetRepsMax === 20 && templateDef.category === undefined);

  check("upsertBankEntry rejects an entry with no name", L.upsertBankEntry(freshBank, { name: "  " }) === null);
  const upserted = L.upsertBankEntry(freshBank, { name: "Farmer Carry", category: "Conditioning", metric: "seconds", loaded: true, targetSets: 3, targetReps: 40 });
  check("upsertBankEntry adds a new entry without mutating the source bank", upserted.bank["Farmer Carry"].category === "Conditioning" && !freshBank["Farmer Carry"]);
  check("upsertBankEntry drops an unknown category to uncategorized", L.upsertBankEntry(freshBank, { name: "X", category: "Arms", targetSets: 3, targetReps: 10 }).entry.category === null);
  check("removeBankEntry removes without mutating", !L.removeBankEntry(freshBank, "Burpee")["Burpee"] && !!freshBank["Burpee"]);
  check("setTemplateFocus keeps only valid, unique categories", L.setTemplateFocus({ exercises: [] }, ["Legs", "Arms", "Legs", "Core"]).focus.join(",") === "Legs,Core");

  const v6Blob = Object.assign({}, L.freshState(), { schemaVersion: 6, exerciseBank: undefined });
  v6Blob.templates = L.cloneTemplates(L.WORKOUT_TEMPLATES);
  v6Blob.templates.upperA.exercises.push({ name: "Band Pull-Apart", metric: "reps", loaded: false, targetSets: 3, targetReps: 20 });
  const fromV6 = L.migrate(v6Blob);
  check("v6->v7 migration seeds the bank, including custom template exercises", fromV6.schemaVersion === L.SCHEMA_VERSION && !!fromV6.exerciseBank["Band Pull-Apart"] && !!fromV6.exerciseBank["Burpee"]);

  /* ---- starter plan through the real import path ---- */
  const starter = L.STARTER_PLANS[0];
  const starterState = L.freshState();
  starterState.exerciseBank = L.removeBankEntry(starterState.exerciseBank, "Jump Rope");
  const parsedStarter = L.parsePlanChangePayload(JSON.stringify({ planChanges: starter.planChanges }), starterState);
  check("the built-in starter plan parses cleanly with no errors", parsedStarter.valid && parsedStarter.errors.length === 0);
  check("plan import carries a template's focus", parsedStarter.payload.focus.lower.join(",") === "Legs,Core");
  check("diffPlanChanges shows a focus change", L.diffPlanChanges(starterState, parsedStarter.payload).some((d) => d.templateId === "lower" && d.lines.some((l) => l.indexOf("Focus:") === 0)));
  const appliedStarter = L.applyPlanChanges(starterState, parsedStarter.payload);
  check("applying the starter plan creates Explosive Power with its focus", appliedStarter.templates.explosive.label === "Explosive Power" && appliedStarter.templates.explosive.focus.join(",") === "Conditioning,Core");
  check("applying a plan adds its exercises back into the bank", !!appliedStarter.exerciseBank["Jump Rope"] && appliedStarter.exerciseBank["Jump Rope"].category === "Conditioning");
  check("applying the starter plan sets Wed/Sun rest days", appliedStarter.restDays.join(",") === "0,3");

  /* ---- share links ---- */
  const sharer = L.applyPlanChanges(L.freshState(), L.parsePlanChangePayload(JSON.stringify({ planChanges: L.STARTER_PLANS[0].planChanges }), L.freshState()).payload);
  const sharerBank = L.upsertBankEntry(sharer.exerciseBank, { name: "Wall Sit", category: "Legs", metric: "seconds", loaded: false, targetSets: 3, targetReps: 45 });
  sharer.exerciseBank = sharerBank.bank;
  sharer.templates.lower = L.addExerciseToTemplate(sharer.templates.lower, L.bankEntryToTemplateDef(sharerBank.entry));
  sharer.templates.empty = { id: "empty", label: "Empty One", exercises: [] };
  sharer.weekPlan[6] = "empty";
  const sharePayload = L.buildSharePlanPayload(sharer);
  check("share payload never includes history or other personal data", !("sessions" in sharePayload.planChanges) && !("readiness" in sharePayload.planChanges) && !("exercises" in sharePayload.planChanges));
  check("share payload skips cardio and empty workouts", !sharePayload.planChanges.templates.cardio && !sharePayload.planChanges.templates.empty);
  check("share payload drops a weekday pointing at a skipped workout", !("6" in sharePayload.planChanges.weekPlan) && sharePayload.planChanges.weekPlan["0"] === "cardio");
  check("share payload carries bank categories for custom exercises", sharePayload.planChanges.categories["Wall Sit"] === "Legs");

  const token = await L.encodeSharePlan(sharePayload);
  check("share token is compressed and URL-safe", /^1\.[A-Za-z0-9_-]+$/.test(token));
  check("share token stays small enough for a text message", token.length < 3000);
  const url = L.buildShareUrl("https://example.github.io/GetFit/index.html#old", token);
  check("buildShareUrl replaces any existing fragment", url === "https://example.github.io/GetFit/index.html#plan=" + token);
  check("extractShareToken finds the token inside a whole pasted message", L.extractShareToken("hey try this " + url + " !!") === token);
  const decoded = await L.decodeSharePlan(token);
  check("share link round-trips losslessly", JSON.stringify(decoded) === JSON.stringify(sharePayload));

  const receiver = L.freshState();
  const receivedParse = L.parsePlanChangePayload(JSON.stringify(decoded), receiver);
  check("a received plan parses with no warnings", receivedParse.valid && receivedParse.errors.length === 0);
  const received = L.applyPlanChanges(receiver, receivedParse.payload);
  check("a received custom exercise lands in the bank with its category", received.exerciseBank["Wall Sit"] && received.exerciseBank["Wall Sit"].category === "Legs");
  check("a received plan recreates the sender's workouts and week", received.templates.explosive.label === "Explosive Power" && received.weekPlan[4] === "explosive" && received.restDays.join(",") === "0,3");

  let damagedError = null;
  try { await L.decodeSharePlan(token.slice(0, 40)); } catch (e) { damagedError = e.message; }
  check("a truncated link fails with a friendly message", damagedError === "That plan link is damaged or incomplete.");
  let oversizeError = null;
  try { await L.decodeSharePlan("1." + "A".repeat(30000)); } catch (e) { oversizeError = e.message; }
  check("an oversized link is refused before decompressing", oversizeError === "That plan link is damaged or incomplete.");
  const plainToken = "0." + Buffer.from(JSON.stringify({ planChanges: { restDays: [0] } })).toString("base64url");
  check("an uncompressed (0.) token also decodes", (await L.decodeSharePlan(plainToken)).planChanges.restDays[0] === 0);

  /* ---- untrusted plan input is clamped ---- */
  const hostile = L.parsePlanChangePayload(JSON.stringify({ planChanges: { templates: { upperA: { label: "x".repeat(500), exercises: [
    { name: "__proto__", targetSets: 3, targetReps: 10 },
    { name: "Push-Up", targetSets: 9999, targetReps: 100000, targetRepsMax: 5000000 }
  ] } } } }), L.freshState());
  check("a reserved object-key name is refused as an exercise name", hostile.payload.templates.upperA.length === 1 && hostile.payload.templates.upperA[0].name === "Push-Up");
  check("absurd sets/reps are clamped", hostile.payload.templates.upperA[0].targetSets === 20 && hostile.payload.templates.upperA[0].targetReps === 999);
  check("an absurdly long label is truncated", hostile.payload.labels.upperA.length === 60);

  /* ---- daysBetween (backup reminder) ---- */
  check("daysBetween is null for no timestamp", L.daysBetween(null, new Date("2026-09-25T00:00:00.000Z")) === null);
  check("daysBetween is null for an unparseable timestamp", L.daysBetween("not a date", new Date("2026-09-25T00:00:00.000Z")) === null);
  check("daysBetween counts whole days elapsed", L.daysBetween("2026-09-10T00:00:00.000Z", new Date("2026-09-25T00:00:00.000Z")) === 15);
  check("daysBetween is 0 for the same day", L.daysBetween("2026-09-25T00:00:00.000Z", new Date("2026-09-25T05:00:00.000Z")) === 0);

  /* ---- summary ---- */
  console.log("\n" + passes + " passed, " + failures + " failed.");
  if (failures > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
