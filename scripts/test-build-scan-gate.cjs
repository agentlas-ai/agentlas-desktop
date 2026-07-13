#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "renderer/lib/build-scan.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
new Function("exports", "module", compiled)(mod.exports, mod);
const { buildScanDisposition, buildScanSeverityBucket } = mod.exports;

assert.equal(buildScanDisposition(null), "unverified");
assert.equal(buildScanDisposition({ status: "unverified", reason: "timeout" }), "unverified");
assert.equal(buildScanDisposition({ ok: false, error: "engine unavailable" }), "unverified");
assert.equal(buildScanDisposition({ ok: false, verdict: "WARN", findings: [] }), "unverified");
assert.equal(buildScanDisposition({ status: "unverified", verdict: "WARN", findings: [] }), "unverified");
assert.equal(buildScanDisposition({}), "unverified");
assert.equal(buildScanDisposition({ findings: [] }), "passed");
assert.equal(buildScanDisposition([]), "passed");
assert.equal(buildScanDisposition({ findings: [{ severity: "medium", message: "review" }] }), "warning");
assert.equal(buildScanDisposition({ findings: [{ severity: "HIGH", message: "secret" }] }), "blocked");
assert.equal(buildScanSeverityBucket("BLOCK"), "blocked");
assert.equal(buildScanSeverityBucket("WARN"), "warning");
assert.equal(buildScanSeverityBucket("info"), "passed");
assert.equal(buildScanDisposition({ verdict: "PASS", findings: [] }), "passed");
assert.equal(buildScanDisposition({ verdict: "WARN", findings: [] }), "warning");
assert.equal(buildScanDisposition({ verdict: "BLOCK", findings: [] }), "blocked");
assert.equal(
  buildScanDisposition({ verdict: "BLOCK", findings: [{ verdict: "BLOCK", type: "credential-path", path: ".env" }] }),
  "blocked",
  "Agentlas OS scan verdicts must never be downgraded to info",
);
assert.equal(
  buildScanDisposition({ verdict: "WARN", findings: [{ verdict: "WARN", type: "prompt-injection", path: "AGENTS.md" }] }),
  "warning",
);

const session = fs.readFileSync(path.join(root, "renderer/lib/build-session.ts"), "utf8");
const page = fs.readFileSync(path.join(root, "renderer/app/(shell)/build/page.tsx"), "utf8");
const toast = fs.readFileSync(path.join(root, "renderer/components/BuildDoneToast.tsx"), "utf8");
assert.match(session, /buildScanDisposition\(scan\) === "passed"/);
assert.match(session, /buildScanDisposition\(result\?\.securityScan \?\? null\) === "passed"/);
assert.match(session, /Skipped auto-registration — security verification has not passed/);
assert.match(page, /disabled=\{resultDeliveryBlocked\}/);
assert.match(page, /updateBuildSecurityScan\(next\)/);
assert.match(page, /buildScanSeverityBucket\(i\.severity\)/);
assert.match(page, /설치·Cloud 저장·Hub 공개가 잠겨 있습니다/);
assert.match(toast, /busy \|\| deliveryBlocked/);

console.log("build security verification gate: PASS");
