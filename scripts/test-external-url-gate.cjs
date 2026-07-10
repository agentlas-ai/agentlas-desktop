#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../electron/ipc.ts"), "utf8");
assert.match(source, /export function validateExternalHttpUrl/);
assert.match(source, /parsed\.protocol !== "https:" && parsed\.protocol !== "http:"/);
assert.match(source, /result\.opened\.map\(\(plan\) => validateExternalHttpUrl\(plan\.startUrl\)\)/);
assert.match(source, /shell\.openExternal\(validateExternalHttpUrl\(target\.target\)\)/);
assert.doesNotMatch(
  source,
  /appFactory:openProviderBrowser[\s\S]{0,260}shell\.openExternal\(plan\.startUrl\)/,
  "provider plans must not reach shell.openExternal before scheme validation",
);
console.log("external URL scheme gate contract ok");
