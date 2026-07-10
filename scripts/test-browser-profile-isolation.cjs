#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "../electron/mcp-tools/browser-cdp-launcher.ts"),
  "utf8",
);
const catalog = fs.readFileSync(
  path.join(__dirname, "../electron/mcp-tools/catalog.ts"),
  "utf8",
);
const launcher = source.slice(source.indexOf("const LAUNCHER_SOURCE"));

assert.doesNotMatch(
  launcher,
  /seedProfile|profileSeeded|copyFileSync|Login Data|Default\/Cookies|AGENTLAS_CDP_SEED/,
  "materialized browser launcher must never copy a live personal Chrome profile",
);
assert.match(
  launcher,
  /fs\.mkdirSync\(CDP_PROFILE, \{ recursive: true, mode: 0o700 \}\)/,
  "launcher must initialize an isolated owner-only profile",
);
assert.match(
  launcher,
  /no personal-profile import/,
  "launcher logs must make the profile boundary observable",
);
assert.match(
  source,
  /평소 쓰는 Chrome 프로필을 복사하지 않으며/,
  "source contract must describe the same no-import boundary",
);
assert.doesNotMatch(
  catalog,
  /using your real logged-in Chrome profile|실제 로그인 Chrome 프로필로/,
  "catalog copy must not claim that Agentlas imports the personal Chrome profile",
);

console.log("browser dedicated-profile isolation contracts ok");
