#!/usr/bin/env node
// Contract for judged memory-import member routing (electron/memory/import.ts):
// the resident judge picks the owning team member over the member-slug inventory;
// the role/slug token overlap is a hint and remains only the labeled fallback.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

app.disableHardwareAcceleration();
process.env.AGENTLAS_DISABLE_RUNTIME_PROBES = "1";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-memory-import-judged-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
app.setPath("userData", path.join(tempDir, "user-data"));

(async () => {
  let exitCode = 0;
  try {
    await app.whenReady();
    require("../dist/electron/store/db.js").initStore();
    const { resolveMemoryImportOwner } = require("../dist/electron/memory/import.js");

    const target = {
      members: [
        { agentId: "agent-writer", role: "Copywriter", slug: "copywriter" },
        { agentId: "agent-research", role: "Market Researcher", slug: "market-researcher" },
        { agentId: "agent-qa", role: "Fact Checker", slug: "fact-checker" },
      ],
    };

    // (a) The judge double WINS, including on a file the token overlap cannot route
    //     (Arabic content, hash-named file → lexical pick is null/orchestrator).
    const judged = await resolveMemoryImportOwner(
      "notes/7f3a.md",
      "ملاحظات حول التحقق من الحقائق: يجب دائماً مقارنة مصدرين مستقلين قبل النشر",
      target,
      {
        judgeFn: async (spec) => {
          assert.equal(spec.kind, "memory-import-member-owner");
          assert.ok(spec.labels.includes("orchestrator"), "orchestrator must stay a valid verdict");
          assert.equal(spec.fallback, "orchestrator", "the overlap miss must be offered as the fallback prior");
          return { verdict: "fact-checker", source: "llm", confidence: 0.9, reason: "verification norms" };
        },
      },
    );
    assert.deepEqual(judged, {
      owner: { agentId: "agent-qa", role: "Fact Checker" },
      source: "llm",
    }, "a judged member verdict must fire where token overlap sees nothing");

    // A judged "orchestrator" vetoes a filename-token false positive.
    const vetoed = await resolveMemoryImportOwner(
      "copywriter-onboarding-schedule.md",
      "Team-wide standup and handoff schedule for every member.",
      target,
      { judgeFn: async () => ({ verdict: "orchestrator", source: "llm", confidence: 0.8, reason: "team-wide" }) },
    );
    assert.deepEqual(vetoed, { owner: null, source: "llm" },
      "a judged orchestrator verdict must override the filename token overlap");

    // (b) No model = today's token-overlap pick, labeled fallback.
    const fallback = await resolveMemoryImportOwner(
      "copywriter-notes.md",
      "Voice and tone rules.",
      target,
      { judgeFn: async (spec) => ({ verdict: spec.fallback, source: "fallback", confidence: 0, reason: "no model" }) },
    );
    assert.deepEqual(fallback, {
      owner: { agentId: "agent-writer", role: "Copywriter" },
      source: "fallback",
    }, "no model = the previous overlap behavior, labeled");

    // Un-injected + no runtime probes: deterministic fallback, never a throw.
    const hermetic = await resolveMemoryImportOwner("market-researcher-findings.md", "content", target, { timeoutMs: 2000 });
    assert.equal(hermetic.source, "fallback");
    assert.deepEqual(hermetic.owner, { agentId: "agent-research", role: "Market Researcher" });

    // An unknown judged label falls back to the overlap pick instead of inventing an owner.
    const unknownLabel = await resolveMemoryImportOwner("copywriter-notes.md", "tone", target, {
      judgeFn: async () => ({ verdict: "someone-else", source: "llm", confidence: 0.9, reason: "hallucinated" }),
    });
    assert.deepEqual(unknownLabel, {
      owner: { agentId: "agent-writer", role: "Copywriter" },
      source: "fallback",
    }, "a hallucinated member slug must never route an import");

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
