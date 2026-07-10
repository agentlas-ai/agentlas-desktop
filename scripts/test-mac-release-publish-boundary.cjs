const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageMac = fs.readFileSync(path.join(root, "scripts/package-mac.sh"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/release-signed-mac.yml"), "utf8");

assert.match(
  packageMac,
  /electron-builder[\s\S]*?--publish never[\s\S]*?--config\.directories\.output=/,
  "mac build must never auto-publish pre-notarization artifacts",
);
assert.match(
  workflow,
  /Build, sign, notarize, and verify DMGs[\s\S]*?Publish verified release \(public releases repo\)/,
  "workflow must keep verification before the only explicit publish step",
);

console.log("mac release publish boundary ok");
