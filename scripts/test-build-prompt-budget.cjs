#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-build-prompt-"));
  app.setPath("userData", temp);
  await app.whenReady();
  const { hephaestusRoot } = require("../dist/electron/hephaestus/root.js");
  const builder = require("../dist/electron/hephaestus/builder.js");
  const runner = require("../dist/electron/runtime/runner.js");
    const root = builder.resolveBuilderPromptRoot(hephaestusRoot());
    assert.ok(root, "Hephaestus runtime root is required for the Build prompt regression");
    try {
    const canonical = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    const canonicalProjection = builder.projectBuilderCanonicalCore(canonical);
    assert.ok(canonicalProjection.length < canonical.length * 0.6, "Desktop must not inject the full global router/source inventory into every Build");
    assert.match(canonicalProjection, /## Generated Instruction Language/);
    assert.match(canonicalProjection, /## Mode Rules/);
    assert.match(canonicalProjection, /## Memory Preflight/);
    assert.match(canonicalProjection, /## Safety Rules/);
    assert.doesNotMatch(canonicalProjection, /## Hephaestus Network Commands|## Source Of Truth|## Operating Loop/);
    assert.equal(builder.projectBuilderCanonicalCore("# drifted source\n"), "# drifted source\n", "heading drift must fall back to the full canonical source");
    assert.equal(builder.projectActiveBuilderForDesktop("# Builder without the known section"), "# Builder without the known section", "unknown builder layouts must not be truncated");
    assert.equal(builder.classifyHephaestusBuildMode("Build one research analyst"), "single");
    assert.equal(builder.classifyHephaestusBuildMode("Build a multi-agent marketing team"), "team");
    assert.equal(
      builder.classifyHephaestusBuildMode("조사, 카피 작성, 사실 검수, 발행 승인 역할이 나뉜 SNS 운영 팀을 만들어줘."),
      "team",
      "Korean postpositional team requests must select the team builder",
    );
    assert.equal(
      builder.classifyHephaestusBuildMode("Build one editor for the newsletter named Team Weekly; one expert owns the work end to end."),
      "single",
      "a product name containing Team must not inflate a single worker into a team",
    );
    assert.equal(
      builder.classifyHephaestusBuildMode("Build one assistant for the support team members."),
      "single",
      "a team's audience must not be mistaken for a multi-agent architecture",
    );
    assert.equal(builder.classifyHephaestusBuildMode("Repair and package this existing agent"), "package");
    assert.equal(builder.classifyHephaestusBuildMode("Build one analyst", { hasAttachments: true }), "single", "a team word inside attachment contents/names must not classify the request");
    assert.equal(builder.classifyHephaestusBuildMode("Repair the attached agent", { hasAttachments: true }), "package");

    // ── The judged verdict decides the auto mode; regexes are hints + labeled fallback ──
    const arabicTeamRequest = "أنشئ فريقاً من ثلاثة أدوار: باحث، وكاتب، ومدقق حقائق يتعاونون على النشرة الأسبوعية";
    assert.equal(builder.classifyHephaestusBuildMode(arabicTeamRequest), "single", "documented wordlist miss: the regexes cannot read Arabic role structure");
    const judgedTeam = await builder.resolveHephaestusBuildMode(arabicTeamRequest, {
      judgeFn: async (spec) => {
        assert.equal(spec.kind, "hephaestus-build-mode");
        assert.equal(spec.fallback, "single", "the deterministic verdict must be offered as the fallback prior");
        return { verdict: "team", source: "llm", confidence: 0.9, reason: "three cooperating roles" };
      },
    });
    assert.deepEqual(judgedTeam, { mode: "team", source: "llm" }, "a judged team verdict must win over the wordlist miss");
    const judgedVeto = await builder.resolveHephaestusBuildMode("Build a multi-agent marketing team name generator (single naming assistant)", {
      judgeFn: async () => ({ verdict: "single", source: "llm", confidence: 0.8, reason: "one assistant" }),
    });
    assert.equal(judgedVeto.mode, "single", "a judged single verdict must override an incidental team wordlist hit");
    const judgedFallback = await builder.resolveHephaestusBuildMode("Build a multi-agent marketing team", {
      judgeFn: async (spec) => ({ verdict: spec.fallback, source: "fallback", confidence: 0, reason: "no model" }),
    });
    assert.deepEqual(judgedFallback, { mode: "team", source: "fallback" }, "no model = today's deterministic verdict, labeled");
    const runtimeStatuses = [
      { kind: "claude-code", backend: "anthropic", source: "claude", version: "1", active: true },
      { kind: "codex", backend: "openai", source: "codex", version: "1", active: false },
    ];
    const selectedRuntime = builder.selectBuildRuntimeStatus(runtimeStatuses, { kind: "codex", backend: "openai", source: "codex", model: "gpt-selected" });
    assert.equal(selectedRuntime.kind, "codex");
    assert.equal(selectedRuntime.model, "gpt-selected");
    const profiles = [];
    for (const mode of ["single", "team", "package", undefined]) {
      const request = mode === undefined ? "Build a multi-agent research team with verification" : "Build with official-source research and verification";
      const composed = builder.composeBuilderPrompt(root, { request, mode, workspace: temp }, "en");
      assert.equal((composed.match(/# Active Builder \(/g) || []).length, 1);
      assert.doesNotMatch(composed, /# Mode Map|# Builder: agents\//);
      assert.match(composed, /research gate|official source|research/i);
      assert.match(composed, /verif/i);
      const wrapped = runner.wrapBuildSystemPrompt(composed, "en");
      const measure = runner.measureBuildSystemPrompt(wrapped);
      profiles.push({ mode: mode || "auto-team", chars: measure.chars, approxTokens: measure.approxTokens });
      assert.ok(measure.chars <= runner.MAX_BUILD_SYSTEM_PROMPT_CHARS, `${mode || "auto"} prompt exceeds hard budget`);
      assert.ok(measure.approxTokens <= 6_000, `${mode || "auto"} prompt should stay below ~6k system tokens`);
      assert.doesNotMatch(wrapped, /<<agentlas-surface>>/);
      assert.doesNotMatch(wrapped, /copy Internal Integration Secret/);
      assert.doesNotMatch(wrapped, /continue follow-ups|Ask an 8-12 question first batch/i, "Desktop must not carry a conflicting multi-batch interview rule");
      assert.equal((wrapped.match(/ONE BATCH ONLY/g) || []).length, 1, "Desktop Build must have one interview authority");
      assert.match(wrapped, /official\/primary sources/);
      assert.match(wrapped, /Operational Experience and Taste\/Style are separate sibling assets/);
      assert.match(wrapped, /randomized human[\s\S]*pairwise A\/B evidence/);
      assert.match(wrapped, /mode=single MUST include root `agent\.md`/);
      assert.match(wrapped, /mode=team MUST include `agents\/<worker>\/agent\.md`/);
      assert.match(wrapped, /Do not substitute editor-specific hidden folders/);
      assert.match(wrapped, /build the smallest complete package/);
      assert.match(wrapped, /repair only failed checks and rerun only those/);
      assert.match(wrapped, /Stop immediately after every required gate passes/);
      assert.match(wrapped, /Never serialize the current working directory or any absolute host path/);
      assert.match(wrapped, /derive `ROOT` from their own file location/);
      assert.doesNotMatch(
        wrapped,
        /Use Korean for every[\s\S]{0,220}generated package document|CONTENTS of every generated file[\s\S]{0,500}in Korean/i,
        "Korean UI copy must not contradict the canonical English runtime-file authority",
      );
      const selectedMode = mode || "team";
      const qualityMarkers = {
        single: [/one installable Agentlas worker package/i, /Self-Evolution Rule/, /system-global(?:-first| first)/],
        team: [/orchestrator\/HQ/i, /Policy Gate/, /verify-team-package\.sh/],
        package: [/existing repository/i, /public\/private boundary cleanup/i, /Shape Gate/],
      }[selectedMode];
      for (const marker of qualityMarkers) assert.match(wrapped, marker, `${selectedMode} quality contract disappeared from the compact projection`);
      assert.equal(runner.wrapSystemPrompt(wrapped, "en", "full", undefined, true), wrapped);
    }
    const explicitPackage = builder.composeBuilderPrompt(root, { request: "Build a team", mode: "package", workspace: temp }, "en");
    assert.match(explicitPackage, /# Active Builder \(package\)/, "explicit package handoff must outrank team words");
    console.log(JSON.stringify({ ok: true, checks: 72, profiles }, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
