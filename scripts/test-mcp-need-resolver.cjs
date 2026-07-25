#!/usr/bin/env node
// Dedicated contract for electron/mcp-tools/need-resolver.ts:
//   - an undecided run (no model) selects NOTHING and reports decided:false;
//   - hub entries win the same-capability dedupe and are offered first;
//   - an injected judge verdict WINS, in any language, and only over offered ids.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

app.disableHardwareAcceleration();
process.env.AGENTLAS_DISABLE_RUNTIME_PROBES = "1";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-need-resolver-"));
app.setPath("userData", tempDir);

(async () => {
  let exitCode = 0;
  try {
    await app.whenReady();
    const {
      resolveMcpNeeds,
      resolveMcpBuildRecommendations,
      preferHub,
    } = require("../dist/electron/mcp-tools/need-resolver.js");

    const candidates = [
      { id: "local-search", name: "Web Search", description: "Search the web", origin: "local", needsCredential: true },
      { id: "hub-search", name: "Web Search", description: "Search the web via Hub", origin: "hub" },
      { id: "github", name: "GitHub", description: "Issues and commits", origin: "local" },
    ];

    // ── preferHub: hub wins the same-capability dedupe and is offered first ──
    const ordered = preferHub(candidates);
    assert.deepEqual(ordered.map((c) => c.id), ["hub-search", "github"],
      "hub must win the same-name capability and be offered before local entries");

    // ── resolveMcpNeeds: undecided → empty + decided:false, nothing attached ──
    const undecided = await resolveMcpNeeds({
      task: "레딧에 올릴 글을 조사해서 정리하고 게시해줘",
      candidates,
      judgeSubsetFn: async () => ({ selected: [], confidence: 0, reason: "no connected model answered", source: "fallback" }),
    });
    assert.deepEqual(undecided, {
      needed: [],
      decided: false,
      reason: "no connected model answered",
      omitted: [],
    }, "an unanswered judge is NOT a decision; nothing may be attached or asked for");

    // Hermetic un-injected path (runtime probes disabled): identical undecided contract.
    const hermetic = await resolveMcpNeeds({ task: "summarize the docs", candidates });
    assert.equal(hermetic.decided, false);
    assert.deepEqual(hermetic.needed, []);

    // ── judge double WINS (wordlist-free Arabic task) and only over offered ids ──
    let offered = [];
    const decided = await resolveMcpNeeds({
      task: "ابحث في الويب عن آخر الأخبار ولخصها",
      candidates,
      judgeSubsetFn: async (spec) => {
        offered = [...spec.labels];
        return { selected: ["hub-search", "not-a-candidate"], confidence: 0.9, reason: "needs live web data", source: "llm" };
      },
    });
    assert.deepEqual(offered, ["hub-search", "github"], "the judge sees the deduped hub-first inventory");
    assert.equal(decided.decided, true);
    assert.deepEqual(decided.needed, ["hub-search", "not-a-candidate"],
      "the resolver returns the judge's selection verbatim for the caller to bind");

    // Empty task / no candidates never call the judge.
    const empty = await resolveMcpNeeds({ task: "  ", candidates, judgeSubsetFn: async () => { throw new Error("must not judge"); } });
    assert.equal(empty.decided, false);

    // ── resolveMcpBuildRecommendations: same contract for the Build sheet ──
    const buildCandidates = [
      { id: "imagegen", name: "Image Generation", description: "Generate images", origin: "catalog", needsCredential: true },
      { id: "custom:notes", name: "Notes Server", description: "User-installed notes MCP", origin: "custom" },
    ];
    const buildUndecided = await resolveMcpBuildRecommendations({
      request: "썸네일 이미지를 만드는 에이전트",
      candidates: buildCandidates,
      judgeSubsetFn: async () => ({ selected: [], confidence: 0, reason: "no connected model answered", source: "fallback" }),
    });
    assert.deepEqual(buildUndecided.recommended, []);
    assert.equal(buildUndecided.decided, false, "an undecided build run recommends nothing instead of keyword-scoring");

    const buildDecided = await resolveMcpBuildRecommendations({
      request: "أنشئ وكيلاً يولّد صوراً مصغرة لمقاطع الفيديو",
      candidates: buildCandidates,
      judgeSubsetFn: async (spec) => {
        assert.ok(spec.labels.includes("custom:notes"), "custom servers must be offered as inventory");
        return { selected: ["imagegen"], confidence: 0.85, reason: "image generation is the job", source: "llm" };
      },
    });
    assert.deepEqual(buildDecided.recommended, ["imagegen"], "a judged recommendation must fire regardless of language");
    assert.equal(buildDecided.decided, true);

    // Candidate cap: omitted ids are reported, never silently treated as offered.
    const many = Array.from({ length: 85 }, (_, i) => ({
      id: `tool-${i}`, name: `Tool ${i}`, description: "d", origin: "local",
    }));
    const capped = await resolveMcpNeeds({
      task: "do the work",
      candidates: many,
      judgeSubsetFn: async (spec) => {
        assert.equal(spec.labels.length, 80, "the judged inventory is capped");
        return { selected: [], confidence: 0.5, reason: "none needed", source: "llm" };
      },
    });
    assert.equal(capped.omitted.length, 5, "cut candidates must be reported as omitted");
    assert.equal(capped.decided, true);

    console.log(JSON.stringify({ ok: true }));
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    app.quit();
    process.exit(exitCode);
  }
})();
