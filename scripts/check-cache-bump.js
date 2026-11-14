#!/usr/bin/env node
/*
 * Fails when a change under app/ ships without bumping CACHE_NAME in
 * app/service-worker.js. Without a bump, installed copies of the app keep
 * serving the old cached shell, so a release looks deployed but isn't.
 *
 * Usage: node scripts/check-cache-bump.js <base-ref>   (e.g. origin/Main)
 */
"use strict";
const { execFileSync } = require("child_process");

const base = process.argv[2];
if (!base) {
  console.error("usage: check-cache-bump.js <base-ref>");
  process.exit(2);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

const changed = git(["diff", "--name-only", base + "...HEAD"])
  .split("\n")
  .filter(Boolean);
const appChanged = changed.filter((f) => f.startsWith("app/"));

if (appChanged.length === 0) {
  console.log("No app/ changes; CACHE_NAME bump not required.");
  process.exit(0);
}

function cacheName(ref) {
  let src;
  try {
    src = git(["show", ref + ":app/service-worker.js"]);
  } catch (e) {
    return null;
  }
  const m = src.match(/var\s+CACHE_NAME\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

const before = cacheName(base);
const after = cacheName("HEAD");

if (!after) {
  console.error("Could not read CACHE_NAME from app/service-worker.js on this branch.");
  process.exit(1);
}
if (before === after) {
  console.error(
    "app/ changed (" + appChanged.join(", ") + ") but CACHE_NAME is still \"" +
      after + "\". Bump it in app/service-worker.js."
  );
  process.exit(1);
}
console.log("CACHE_NAME bumped: " + before + " -> " + after);
