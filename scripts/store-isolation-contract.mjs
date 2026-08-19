#!/usr/bin/env node
// A test run must never open the person's real database.
//
// Why this gate exists: on 2026-08-11 the gates in this folder opened the live
// `agentlas.sqlite` directly — 51 of them never isolated userData. Running them
// while the app was open corrupted `run_events` and its four indexes, and the
// app stopped starting entirely. Nothing was lost (`.recover` returned every
// row of all 81 tables), but the next occurrence might land on a table that
// matters.
//
// Asserts the outcome, not the wording: a script-context Electron run resolves
// its store somewhere other than userData unless someone said otherwise on
// purpose.
//
// Run: node scripts/store-isolation-contract.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "electron/store/db.ts"), "utf8");

// 1. The store path goes through one resolver — not an inline expression that
//    the next edit can quietly widen back to userData.
assert.match(
  src,
  /const dbPath = resolveStorePath\(\);/,
  "initStore must resolve its path through resolveStorePath()",
);

const at = src.indexOf("function resolveStorePath");
assert.ok(at > 0, "resolveStorePath must exist");
const fn = src.slice(at, src.indexOf("\n}", at));

// 2. An explicit path always wins — opening a specific database on purpose
//    must stay possible.
assert.match(fn, /AGENTLAS_STORE_PATH/, "an explicit store path must still win");

// 3. An unpackaged run without an explicit path is sent somewhere else.
//    ★계약만 못박는다. 예전에는 `scripts` 라는 낱말과 `getPath("userData")` 라는
//      **구현 문장**을 단언했는데, 9ecb50b0 이 리졸버를 "엔트리 이름을 보지 않고 모든
//      비패키지 실행을 격리" 로 넓히고 userData 접근을 userDataPath() 헬퍼로 옮기자
//      이 게이트는 **더 안전해진 코드를 실패로 판정**하며 그대로 깨져 있었다.
//      낱말이 아니라 "격리되는가 / 마지막에 오는가" 를 본다.
assert.match(fn, /app\.isPackaged/, "packaged apps must not be treated as script runs");
assert.match(fn, /tmpdir\(\)/, "an unpackaged run without an explicit path must go to a temp store");

// 4. And it says so, because a silent redirect is its own kind of trap.
assert.match(fn, /console\.warn/, "the redirect must be announced, not silent");

// 5. The userData fallback must come last — after both guards above.
const userDataAt = Math.max(fn.indexOf('getPath("userData")'), fn.indexOf("userDataPath("));
assert.ok(userDataAt > 0, "the normal app path must still resolve to the user data directory");
assert.ok(
  userDataAt > fn.indexOf("AGENTLAS_STORE_PATH") && userDataAt > fn.indexOf("isPackaged"),
  "the user data store must be the last resort, never reached before the unpackaged-run guard",
);

console.log("store isolation contract ok");
console.log("  ✓ a script run resolves to an isolated store and announces it");
console.log("  ✓ an explicit AGENTLAS_STORE_PATH still wins");
console.log("  ✓ the real userData store stays the normal app path, checked last");
