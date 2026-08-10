#!/usr/bin/env node
// Effort is a property of the model, not of the runtime.
//
// Codex advertises `supported_reasoning_levels` per model and the list differs
// between them (gpt-5.6-sol reaches `ultra`, gpt-5.5 stops at `xhigh`). The
// dashboard used to read only the runtime-level `efforts`, which Codex never
// sets — so every Codex row showed an empty effort cell while the model
// underneath supported six levels.
//
// Asserts the outcome: the picker resolves effort the same way the kernel does.
//
// Run: node scripts/effort-per-model-contract.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

// ── 1. The picker asks per model, not per runtime ────────────────────────
const control = read("renderer/components/dashboard/RuntimeControl.tsx");
assert.match(
  control,
  /const efforts = effortsFor\(runtime, selection\.model\)/,
  "each row must resolve effort for its own selected model",
);
assert.doesNotMatch(
  control,
  /const efforts = runtime\?\.efforts \?\? \[\]/,
  "the runtime-only lookup is what left every Codex row blank",
);

const at = control.indexOf("function effortsFor");
assert.ok(at > 0, "effortsFor must exist");
const fn = control.slice(at, control.indexOf("\n}", at));
assert.match(fn, /allocationModelProfiles/, "the per-model profile must be consulted first");
assert.match(fn, /runtime\?\.efforts/, "the runtime list must remain the fallback");
assert.ok(
  fn.indexOf("allocationModelProfiles") < fn.indexOf("runtime?.efforts"),
  "the model profile must win over the runtime list, matching the kernel order",
);

// ── 2. Same precedence as the kernel, so screen and execution agree ──────
const routing = read("electron/runtime/workload-routing.ts");
const kernelAt = routing.indexOf("function supportedEfforts");
assert.ok(kernelAt > 0, "the kernel resolver must still exist");
const kernelFn = routing.slice(kernelAt, routing.indexOf("\n}\n", kernelAt));
assert.ok(
  kernelFn.indexOf("modelEfforts") < kernelFn.indexOf("runtime.efforts"),
  "kernel precedence must stay model-first — the picker mirrors it",
);

// ── 3. Codex still carries its per-model levels through detection ────────
const detect = read("electron/runtime/detect.ts");
assert.match(
  detect,
  /efforts: \[\.\.\.model\.efforts\]/,
  "codex model profiles must keep carrying per-model efforts into RuntimeStatus",
);

// ── 4. Order is capability rank — never re-sorted for display ────────────
const models = read("electron/runtime/codex-models.ts");
assert.match(
  models,
  /supported_reasoning_levels/,
  "codex efforts must come from what the host advertises",
);
assert.doesNotMatch(
  fn,
  /\.sort\(/,
  "the picker must not re-sort efforts — the advertised order is the capability rank",
);

console.log("effort per model contract ok");
console.log("  ✓ each row resolves effort for its own model, runtime list as fallback");
console.log("  ✓ picker precedence matches the kernel's supportedEfforts");
console.log("  ✓ advertised order is preserved (it is the capability rank)");
