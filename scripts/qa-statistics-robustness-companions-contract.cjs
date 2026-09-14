#!/usr/bin/env node
// 하네스 조사 2026-09-14 S 항목 두 개를 값으로 못박는다:
//   #1 분석 결정 원장 — 요청의 decisionLog 가 해시에 들어가고 결과에 그대로 돌아온다; 없으면 null.
//   #4 주 분석 동반 3종 — 선형·로지스틱 회귀 결과에 HC3 SE·부트스트랩 CI·순열 p 가 자동으로 붙고,
//      robustness-table 산출물이 생기며, 같은 요청은 같은 숫자를 낸다(데이터 시드).
// 그리고 판 번호 한 벌: plugin.json · 엔진 · coverage manifest(digest) · Science 공유 상수.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pluginRoot = path.join(root, "plugins", "agentlas-science-statistics");
const engine = require(path.join(pluginRoot, "runtime", "engine.cjs"));
const { REQUEST_INPUT_SCHEMA, DECISION_LOG_SCHEMA } = require(path.join(pluginRoot, "runtime", "contracts.cjs"));
const coverage = require(path.join(pluginRoot, "runtime", "coverage.cjs"));

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ✓ ${name}\n`); };

const rng = (() => { let s = 7; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
const n = 80; const a = []; const b = []; const y = []; const yb = [];
for (let i = 0; i < n; i += 1) {
  const u = rng() * 10; const v = rng() * 5; const mu = 1 + 0.8 * u - 0.5 * v + (rng() - 0.5) * 2;
  a.push(u); b.push(v); y.push(mu); yb.push(1 / (1 + Math.exp(-(mu - 4))) > rng() ? 1 : 0);
}
const base = { schema: "agentlas.science.statistics.request/v1", method: "linear_regression", data: { y, predictors: [{ name: "a", type: "numeric", values: a }, { name: "b", type: "numeric", values: b }], outcomeLabel: "y" }, options: {} };
const decisionLog = { transformations: ["none"], exclusions: ["rows with missing y"], covariates: ["a", "b"], modelFamily: "ols", rationale: "preregistered main model" };

check("linear regression carries HC3, bootstrap and permutation companions plus a robustness-table artifact", () => {
  const result = engine.analyze({ ...base, decisionLog });
  assert.equal(result.robustness.schema, "agentlas.science.statistics.robustness-companions/v1");
  assert.equal(result.robustness.hc3.length, 3);
  assert.equal(result.robustness.bootstrap.completed, 1000);
  assert.equal(result.robustness.permutation.completed, 1000);
  const slopeA = result.robustness.hc3.find((row) => row.term === "a");
  assert.ok(slopeA.standardError > 0 && slopeA.pValue < 0.001, "a strong true slope stays significant under HC3");
  const interval = result.robustness.bootstrap.intervals.find((row) => row.term === "a");
  assert.ok(interval.lower < 0.8 && interval.upper > 0.8, `the bootstrap interval covers the true slope (${interval.lower}, ${interval.upper})`);
  const perm = result.robustness.permutation.pValues.find((row) => row.term === "a");
  assert.ok(perm.pValue <= 0.002, `permutation p for a real effect is at the floor (${perm.pValue})`);
  assert.ok(result.artifacts.some((artifact) => artifact.kind === "table" && artifact.role === "robustness-table"));
  assert.equal(result.artifacts[0].role, "publication-table", "the main coefficient table stays first");
  assert.ok(result.diagnostics.some((d) => d.name === "robustness companions" && d.status === "attached"));
});
check("the decision log is echoed on the result, hashed into the request, and null when absent", () => {
  const withLog = engine.analyze({ ...base, decisionLog });
  const without = engine.analyze(base);
  assert.deepEqual(withLog.decisionLog, decisionLog);
  assert.equal(without.decisionLog, null);
  assert.notEqual(withLog.requestHash, without.requestHash, "the ledger is part of the request identity");
  assert.throws(() => engine.analyze({ ...base, decisionLog: {} }), /at least one decision/);
  assert.throws(() => engine.analyze({ ...base, decisionLog: { modelFamily: "" } }), /modelFamily/);
});
check("the same request produces the same companions (data-derived seed)", () => {
  const first = engine.analyze({ ...base, decisionLog });
  const second = engine.analyze({ ...base, decisionLog });
  assert.equal(first.resultHash, second.resultHash);
  assert.equal(first.robustness.seed, second.robustness.seed);
});
check("logistic regression carries the same companions with Wald-z permutation", () => {
  const result = engine.analyze({ ...base, method: "logistic_regression", data: { ...base.data, y: yb } });
  assert.equal(result.robustness.permutation.method, "outcome-permutation-wald-z");
  assert.ok(result.robustness.bootstrap.completed >= 250, `bootstrap refits converge (${result.robustness.bootstrap.completed})`);
  assert.ok(result.artifacts.some((artifact) => artifact.role === "robustness-table"));
});
check("the request schema admits decisionLog on every method variant", () => {
  assert.ok(DECISION_LOG_SCHEMA.additionalProperties === false && DECISION_LOG_SCHEMA.minProperties === 1);
  for (const variant of REQUEST_INPUT_SCHEMA.oneOf) assert.equal(variant.properties.decisionLog, DECISION_LOG_SCHEMA, `${variant.properties.method.const} admits decisionLog`);
});
check("plugin.json, engine, coverage manifest and the Science shared constant agree on 1.11.0", () => {
  const descriptor = JSON.parse(fs.readFileSync(path.join(pluginRoot, "plugin.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "coverage-manifest.json"), "utf8"));
  assert.equal(descriptor.version, engine.ENGINE.version);
  assert.equal(manifest.engine.version, engine.ENGINE.version);
  assert.equal(manifest.engine.algorithmRevision, engine.ENGINE.algorithmRevision);
  assert.equal(coverage.digestManifest(manifest), manifest.manifestSha256, "coverage manifest digest is current");
  const shared = require(path.join(root, "node_modules", "agentlas-science", "dist", "contracts", "science-statistics.js"));
  assert.equal(shared.SCIENCE_STATISTICS_TOOL_VERSION, engine.ENGINE.version, "the vendored Science dist pins the same engine version");
});
process.stdout.write(`statistics robustness companions contract: ${checks} checks passed\n`);
