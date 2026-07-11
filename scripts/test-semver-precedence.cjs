#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { compareSemVer, parseSemVer } = require("../dist/shared/semver.js");

const precedence = [
  "1.0.0-alpha",
  "1.0.0-alpha.1",
  "1.0.0-alpha.beta",
  "1.0.0-beta",
  "1.0.0-beta.2",
  "1.0.0-beta.11",
  "1.0.0-rc.1",
  "1.0.0",
];

for (let index = 0; index < precedence.length - 1; index += 1) {
  assert.equal(compareSemVer(precedence[index], precedence[index + 1]), -1);
  assert.equal(compareSemVer(precedence[index + 1], precedence[index]), 1);
}

assert.equal(compareSemVer("v2.3.4", "2.3.4"), 0);
assert.equal(compareSemVer("1.0.0+build.1", "1.0.0+build.99"), 0);
assert.equal(compareSemVer("1.0.0-1", "1.0.0-alpha"), -1);
assert.equal(compareSemVer("999999999999999999999.0.0", "2.0.0"), 1);
assert.equal(compareSemVer("1.0.0", "1.0.0-rc.99"), 1);
assert.equal(parseSemVer("1.0.0-01"), null);
assert.equal(parseSemVer("01.0.0"), null);
assert.equal(compareSemVer("not-a-version", "1.0.0"), null);

const updaterAdapter = fs.readFileSync(path.join(__dirname, "../electron/updater.ts"), "utf8");
const updaterController = fs.readFileSync(path.join(__dirname, "../electron/updater/controller.ts"), "utf8");
assert.match(
  updaterAdapter,
  /currentVersion:\s*\(\)\s*=>\s*app\.getVersion\(\)/,
  "the Electron adapter must supply the installed app version to the updater controller",
);
assert.match(
  updaterController,
  /compareSemVer\(version,\s*this\.deps\.currentVersion\(\)\)/,
  "the updater controller must use SemVer precedence when deciding whether a release is newer",
);
assert.match(updaterController, /parseSemVer\(minimumSourceAppVersion\)/);
assert.doesNotMatch(updaterController, /function versionTuple/);

console.log("semver-precedence: PASS");
