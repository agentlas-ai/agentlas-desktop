#!/usr/bin/env node
// Guards the recall layers that were silently injecting nothing.
//
// Two of them had been dead for months without a single symptom: the soul was
// cut at 1800 chars from the head, so a 31k-char soul contributed 5.8% of
// itself and dropped the release rule that would have prevented a failed tag;
// and the code map outgrew its read cap, which made the map unreadable AND —
// because generation was skipped whenever the file merely existed — permanently
// unrepairable. Both failures returned null inside a catch, so a run that
// injected nothing looked exactly like a run that injected everything. These
// tests assert the content that must survive, not just that a call returns.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

process.env.AGENTLAS_E2E = "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-memory-recall-"));
app.setPath("userData", path.join(tmp, "user-data"));
app.setPath("home", path.join(tmp, "home"));
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");

function cleanup() {
  try {
    require("../dist/electron/store/db.js").getDb().close();
  } catch {
    /* the store may not have opened if an assertion failed first */
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 2, retryDelay: 125 });
}

// A soul shaped like the real ones: chapter-sized sections written as bullet
// lists whose items wrap onto continuation lines. The rule under test sits far
// past the old 1800-char cut, exactly as it did in the real file.
function buildSoul() {
  const filler = (topic, n) =>
    Array.from({ length: n }, (_, i) =>
      `- ${topic} note ${i + 1} covering routine day-to-day detail that is not\n  relevant to any particular question being asked.`,
    ).join("\n");
  return [
    "# Project Soul Memory: Fixture",
    "",
    "## Project Purpose",
    "- Exercise the recall layers.",
    "",
    "## Current State",
    filler("state", 60),
    "",
    "## Risks",
    filler("risk", 40),
    "- Release rule: bumping the version requires updating README and CHANGELOG",
    "  together, or the release contract gate fails.",
    filler("risk-tail", 40),
    "",
    "## Decisions",
    filler("decision", 30),
    "",
  ].join("\n");
}

async function main() {
  await app.whenReady();
  require("../dist/electron/store/db.js").initStore();
  const bootstrap = require("../dist/electron/architecture/project-bootstrap.js");
  const original = bootstrap.ensureDesktopProjectBootstrap;
  bootstrap.ensureDesktopProjectBootstrap = async () => ({ mode: "core" });
  const { activateFolder } = require("../dist/electron/architecture/activation.js");
  const { buildMemoryContext } = require("../dist/electron/memory/context.js");

  const project = path.join(tmp, "project");
  fs.mkdirSync(path.join(project, ".agentlas"), { recursive: true });
  const soul = buildSoul();
  fs.writeFileSync(path.join(project, ".agentlas", "project-soul-memory.md"), soul);
  await activateFolder(project, "Memory Recall Fixture", { permission: "write" });
  bootstrap.ensureDesktopProjectBootstrap = original;

  const releaseRule = "requires updating README and CHANGELOG";
  const ruleAt = soul.indexOf(releaseRule);
  assert.ok(ruleAt > 1800, "fixture must place the rule past the old positional cut");

  // The whole point: a prompt about releasing must reach a rule that positional
  // truncation would have thrown away.
  const releaseContext = buildMemoryContext(project, null, {
    materializeCodeMap: false,
    taskPrompt: "release the desktop app and update the README and CHANGELOG",
  });
  assert.ok(
    releaseContext.includes(releaseRule),
    "a release prompt must recall the release rule buried deep in the soul",
  );
  assert.ok(
    !releaseContext.includes(soul),
    "the soul must still be budgeted, not injected whole",
  );

  // Relevance has to cut both ways, or "selection" is just a bigger cap.
  const unrelatedContext = buildMemoryContext(project, null, {
    materializeCodeMap: false,
    taskPrompt: "what colour should the onboarding button be",
  });
  assert.ok(
    unrelatedContext.length < releaseContext.length + 1,
    "an unrelated prompt must not pull in more soul than a matching one",
  );

  // The head anchors every selection: it names the project the rest is read against.
  for (const context of [releaseContext, unrelatedContext]) {
    assert.ok(
      context.includes("# Project Soul Memory: Fixture"),
      "the soul head must always anchor the selection",
    );
  }

  // Code map: an unreadable map must not be treated as a present one, or it can
  // never repair itself. Oversize stands in for the real 45MB file.
  const codeMapDir = path.join(project, ".agentlas", "code-map");
  fs.mkdirSync(codeMapDir, { recursive: true });
  const { PROJECT_CODE_MAP_SEED_MAX_BYTES } = require("../dist/electron/memory/safe-project-read.js");
  fs.writeFileSync(
    path.join(codeMapDir, "project-seed.json"),
    JSON.stringify({ bloat: "x".repeat(PROJECT_CODE_MAP_SEED_MAX_BYTES + 1024) }),
  );
  const withDeadMap = buildMemoryContext(project, null, {
    materializeCodeMap: false,
    taskPrompt: "where is the updater code",
  });
  assert.ok(!withDeadMap.includes("### Code map"), "an unreadable seed must inject no map section");

  // A readable seed injects, and carries what the turn actually needs.
  fs.writeFileSync(
    path.join(codeMapDir, "project-seed.json"),
    JSON.stringify({
      project: "fixture",
      stats: { codeFiles: 12, symbols: 34 },
      modules: [{ id: "electron/updater", role: "release" }],
      entryPoints: [{ path: "electron/main.ts" }],
      topSymbols: [{ name: "checkForUpdates", defAt: "electron/updater/controller.ts:10" }],
    }),
  );
  const withSeed = buildMemoryContext(project, null, {
    materializeCodeMap: false,
    taskPrompt: "where is the updater code",
  });
  assert.ok(withSeed.includes("### Code map"), "a readable seed must inject the map section");
  assert.ok(withSeed.includes("electron/updater"), "the map section must name modules");

  // The seed is what gets read: a huge full map must never be parsed for this.
  fs.writeFileSync(
    path.join(codeMapDir, "project-map.json"),
    JSON.stringify({ project: "fixture", refIndex: { x: Array.from({ length: 200 }, (_, i) => `f${i}`) } }),
  );
  const seedStillWins = buildMemoryContext(project, null, {
    materializeCodeMap: false,
    taskPrompt: "where is the updater code",
  });
  assert.ok(seedStillWins.includes("electron/updater"), "the seed must win over the full map");

  console.log("memory recall injection: PASS (soul relevance selection, code map seed, dead-map repair)");
}

main()
  .then(() => {
    cleanup();
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    cleanup();
    app.exit(1);
  });
