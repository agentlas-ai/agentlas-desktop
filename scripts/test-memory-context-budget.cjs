#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const memory = require("../dist/electron/system-agents/memory/index.js");
const { parseMemoryEvents } = require("../dist/electron/memory/events.js");
// Use the same conservative estimator as Experience/Web/Terminal. Character
// count underestimates Korean and other multi-byte prompts and previously let
// a nominal 150-token core exceed the shared runtime contract.
const approxTokens = Math.ceil(Buffer.byteLength(memory.MEMORY_CORE, "utf8") / 3);
assert.ok(approxTokens <= memory.MEMORY_CORE_MAX_APPROX_TOKENS, `memory core is ~${approxTokens} tokens`);
assert.equal(memory.memoryEmitterPromptFor("write a normal report"), memory.MEMORY_CORE);
assert.notEqual(memory.memoryEmitterPromptFor("remember this decision"), memory.MEMORY_CORE);
// A stated preference or identity fact must load the full schema block, because
// the always-on core has no room to explain the user_identity scope — and the
// curator files user_identity only when the model labels it so with high
// confidence, which is exactly what that block instructs. Without this, "always
// use 존댓말" is emitted at medium confidence and demoted to a session note
// (why user_identity was 0 rows). The block must actually carry the guidance.
for (const preferenceTurn of ["always use 존댓말", "앞으로 나를 형님이라고 불러", "my name is Mason", "call me boss"]) {
  const prompt = memory.memoryEmitterPromptFor(preferenceTurn);
  assert.notEqual(prompt, memory.MEMORY_CORE, `preference turn must load the full block: ${preferenceTurn}`);
  assert.match(prompt, /user_identity/);
  assert.match(prompt, /confidence["':\s]+.*high|high[.\s]*confidence/i);
}
assert.equal(memory.memoryEmitterPromptFor("fix the python build"), memory.MEMORY_CORE, "an ordinary task stays on the core prompt");
assert.match(memory.MEMORY_CORE, /fenced JSON envelope/);
assert.match(memory.MEMORY_CORE, /user_identity, team_memory, agent_repo, agent_team, project, session, discard/);
const compactReply = [
  "Done.",
  "",
  "## Memory Events",
  "```json",
  JSON.stringify([
    {
      memory_kind: "decision",
      content: "Use host-local receipts for MCP build attachments.",
      suggested_scope: "agent_repo",
    },
  ]),
  "```",
].join("\n");
const roundTrip = parseMemoryEvents(compactReply);
assert.equal(roundTrip.events.length, 1);
assert.equal(roundTrip.events[0].suggested_scope, "agent_repo");
assert.equal(roundTrip.cleanedText, "Done.");
const headinglessEnvelope = parseMemoryEvents([
  "Hello Mason.",
  "",
  "```json",
  JSON.stringify({
    schema_version: "agentlas.memory-ticket.v1",
    turn_summary: "Responded to a greeting.",
    candidates: [],
  }),
  "```",
].join("\n"));
assert.equal(headinglessEnvelope.emitterStatus, "empty");
assert.equal(headinglessEnvelope.cleanedText, "Hello Mason.");
const ordinaryJson = parseMemoryEvents("Visible data:\n```json\n{\"ok\":true}\n```");
assert.equal(ordinaryJson.emitterStatus, "missing");
assert.match(ordinaryJson.cleanedText, /\"ok\":true/);
const client = fs.readFileSync(path.join(__dirname, "../electron/mcp/client.ts"), "utf8");
const firm = fs.readFileSync(path.join(__dirname, "../electron/mcp/firm-orchestrator.ts"), "utf8");
assert.match(client, /memoryEmitterPromptFor\(effectiveUserPrompt\)/);
assert.match(firm, /memoryEmitterPromptFor\(turn\.userPrompt\)/);
assert.doesNotMatch(client, /MEMORY_EMITTER_BLOCK/);
assert.doesNotMatch(firm, /MEMORY_EMITTER_BLOCK/);
console.log(JSON.stringify({
  ok: true,
  chars: memory.MEMORY_CORE.length,
  utf8Bytes: Buffer.byteLength(memory.MEMORY_CORE, "utf8"),
  approxTokens,
}, null, 2));
