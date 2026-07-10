#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "..", "renderer", "lib", "agent-memory.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
}).outputText;
const memoryModule = new Module(sourcePath, module);
memoryModule.filename = sourcePath;
memoryModule.paths = module.paths;
memoryModule._compile(compiled, sourcePath);

const { AgentMemorySaveQueue, parseMemoryMarkdown, serializeMemoryMarkdown } = memoryModule.exports;
const librarySurface = fs.readFileSync(path.join(__dirname, "..", "renderer", "app", "(shell)", "library", "agents", "page.tsx"), "utf8");
const firmSurface = fs.readFileSync(path.join(__dirname, "..", "renderer", "app", "(shell)", "firm", "detail", "page.tsx"), "utf8");
for (const [name, surface] of [["library", librarySurface], ["firm", firmSurface]]) {
  assert.match(surface, /new AgentMemorySaveQueue\(\)/, `${name} surface must use the shared per-agent queue`);
  assert.match(surface, /memorySaveQueueRef\.current\.hydrate\(selectedNode\.agentId/, `${name} surface must hydrate raw markdown per agent`);
  assert.match(surface, /memorySaveQueueRef\.current\.enqueue\(/, `${name} surface must serialize rapid mutations through the queue`);
  assert.doesNotMatch(surface, /async function saveMemory\(updated:/, `${name} surface must not retain the stale direct-write contract`);
}

const crlfOriginal = [
  "---",
  "owner: operator",
  "---",
  "# Memory",
  "",
  "## Decisions",
  "",
  "- **Old**: replace me",
  "",
  "## Examples",
  "",
  "```md",
  "## Gotchas",
  "- **Fake**: this is sample code",
  "```",
  "",
  "## Private provenance",
  "Keep these operator bytes stable.",
  "",
  "## Gotchas",
  "- **Real**: real warning",
  "",
  "## Open",
  "- **Question**: still open",
  "",
].join("\r\n");

const parsed = parseMemoryMarkdown(crlfOriginal);
assert.deepEqual(parsed.gotchas.map((item) => item.title), ["Real"], "fenced headings and bullets must not become memory");
assert.equal(parsed.decisions[0].title, "Old");

const serialized = serializeMemoryMarkdown(
  [{ title: "New", content: "approved", enabled: true }],
  parsed.gotchas,
  parsed.openQuestions,
  { originalContent: crlfOriginal },
);
assert.doesNotMatch(serialized, /(^|[^\r])\n/, "CRLF documents must not be normalized to LF");
assert.ok(
  serialized.includes("## Examples\r\n\r\n```md\r\n## Gotchas\r\n- **Fake**: this is sample code\r\n```"),
  "fenced custom examples must remain byte-stable",
);
assert.ok(
  serialized.includes("## Private provenance\r\nKeep these operator bytes stable.\r\n"),
  "unknown operator sections must remain byte-stable",
);

const duplicateOriginal = [
  "# Memory",
  "",
  "## Decisions",
  "- **Stale A**: old",
  "",
  "## Decisions",
  "- **Stale B**: old",
  "",
  "## Custom",
  "custom body",
  "",
].join("\n");
const deduplicated = serializeMemoryMarkdown(
  [{ title: "Canonical", content: "only copy" }],
  [],
  [],
  { originalContent: duplicateOriginal },
);
assert.equal((deduplicated.match(/^## Decisions$/gm) ?? []).length, 1, "duplicate managed headings must collapse");
assert.doesNotMatch(deduplicated, /Stale A|Stale B/, "duplicate stale bodies must be removed");
assert.deepEqual(
  parseMemoryMarkdown(deduplicated).decisions.map((item) => item.title),
  ["Canonical"],
  "stale duplicate bullets must not re-enter the parser",
);
assert.match(deduplicated, /## Custom\ncustom body\n/, "custom section survives duplicate cleanup");

async function testSaveQueue() {
  const queue = new AgentMemorySaveQueue();
  const agentA = "agent-a";
  const initial = parseMemoryMarkdown(crlfOriginal);
  queue.hydrate(agentA, initial, crlfOriginal);
  const writes = [];
  const write = async (content) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    writes.push(content);
  };
  const first = queue.enqueue({
    agentId: agentA,
    updater: (previous) => ({ ...previous, decisions: [...previous.decisions, { id: "one", title: "One", content: "first" }] }),
    write,
  });
  const second = queue.enqueue({
    agentId: agentA,
    updater: (previous) => ({ ...previous, gotchas: [...previous.gotchas, { id: "two", title: "Two", content: "second" }] }),
    write,
  });
  await Promise.all([first.completion, second.completion]);
  assert.equal(writes.length, 2, "rapid updates are serialized");
  const finalParsed = parseMemoryMarkdown(writes[1]);
  assert.ok(finalParsed.decisions.some((item) => item.title === "One"), "second update retains first update");
  assert.ok(finalParsed.gotchas.some((item) => item.title === "Two"), "second update is durable");
  assert.ok(writes[1].includes("## Private provenance\r\nKeep these operator bytes stable."), "queue preserves custom raw sections");

  const agentB = "agent-b";
  const empty = { decisions: [], gotchas: [], openQuestions: [] };
  queue.hydrate(agentB, empty, "# B\n\n## Decisions\n\n## Gotchas\n\n## Open\n");
  let rollback;
  const failed = queue.enqueue({
    agentId: agentB,
    updater: (previous) => ({ ...previous, decisions: [{ id: "x", title: "X", content: "not durable" }] }),
    write: async () => { throw new Error("disk full"); },
    onRollback: (durable) => { rollback = durable; },
  });
  await assert.rejects(failed.completion, /disk full/);
  assert.deepEqual(rollback, empty, "terminal failure rolls back only to that agent's durable state");
  assert.ok(queue.current(agentA, empty).gotchas.some((item) => item.title === "Two"), "another agent's revision is untouched");
}

testSaveQueue()
  .then(() => console.log(JSON.stringify({ ok: true, checks: 22 }, null, 2)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
