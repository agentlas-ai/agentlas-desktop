#!/usr/bin/env node
const assert = require("node:assert/strict");

const { assertInvocationChatAvailable, resolveInvocationRunId } = require("../dist/electron/runtime/run-id.js");
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

assert.equal(resolveInvocationRunId(first, () => false), first);
assert.throws(() => resolveInvocationRunId(first, (id) => id === first), /already active/);
for (const invalid of ["", "../channel", "run-1", "11111111-1111-1111-1111-111111111111", 42]) {
  assert.throws(() => resolveInvocationRunId(invalid, () => false), /Invalid invocation runId/);
}
let calls = 0;
assert.equal(
  resolveInvocationRunId(undefined, (id) => id === first, () => (++calls === 1 ? first : second)),
  second,
);
assert.equal(calls, 2);
assert.doesNotThrow(() => assertInvocationChatAvailable("chat-b", [{ chatId: "chat-a" }]));
assert.throws(
  () => assertInvocationChatAvailable("chat-a", [{ chatId: "chat-a" }]),
  /already has an active invocation/,
);
assert.throws(() => assertInvocationChatAvailable("", []), /Invalid invocation chatId/);

console.log(JSON.stringify({ ok: true, checks: 12 }, null, 2));
