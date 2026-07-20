#!/usr/bin/env node
// Guards for chat/session continuity regressions.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const clientTs = fs.readFileSync(path.join(root, "electron/mcp/client.ts"), "utf8");
const chatInputTsx = fs.readFileSync(path.join(root, "renderer/components/ChatInput.tsx"), "utf8");

assert.match(
  clientTs,
  /function hasPriorConversationContext\(chatId: string\)/,
  "main invocation must have a structural prior-conversation guard",
);
assert.match(
  clientTs,
  /const hadPriorConversationContext = req\.agentAppMode\s*\? false\s*:\s*hasPriorConversationContext\(chat\.id\);[\s\S]*const hasPriorContext = hadPriorConversationContext;/,
  "main invocation must freeze prior chat context before persisting the new turn while keeping stateless Agent App requests isolated",
);
assert.match(
  clientTs,
  /: hasPriorContext\s*\?\s*null\s*: !plainConversation && isGlobalOrchestrator\(agent\)/,
  "existing-chat follow-up turns must not trigger fresh hidden auto-routing",
);
assert.match(
  clientTs,
  /shouldAutoEngageNetworkWorkforce\(\{[\s\S]*?hasPriorContext,/,
  "dynamic workforce routing must receive the frozen prior-context guard",
);
assert.match(
  clientTs,
  /req\.appsGenerateMode\s*\?\s*selectAppBuilderForAppsGenerate/,
  "explicit Apps Generate mode must still route to App Builder",
);
assert.match(
  clientTs,
  /isTargetAppEdit \? "app-edit" : req\.appsGenerateMode \? "apps-generate" : "default"/,
  "App Builder preamble must know when Apps Generate mode was explicit",
);

const routeOnlyCalls = [...clientTs.matchAll(/routeOnly\(([^,]+),/g)].map((match) => match[1].trim());
assert.ok(routeOnlyCalls.length >= 1, "expected the explicit network routeOnly call to be present");
for (const arg of routeOnlyCalls) {
  assert.equal(arg, "explicitNetworkGoal", `explicit network routing must use the redacted explicit goal, got ${arg}`);
}

assert.match(
  chatInputTsx,
  /setGateSheet\(null\);[\s\S]*setHepToggles\(new Set\(\)\);/,
  "a chat switch must discard the previous recommendation gate and execution intent",
);
assert.match(
  chatInputTsx,
  /const activeChatIdRef = useRef<string \| null>\(activeChatId\);/,
  "recommendation async resolution must compare against the current chat id",
);
assert.match(
  chatInputTsx,
  /const chatIdAtStart = activeChatIdRef\.current;/,
  "recommendation preview must capture the owning chat before awaiting",
);
assert.match(
  chatInputTsx,
  /if \(activeChatIdRef\.current !== chatIdAtStart\) return;/,
  "recommendation preview and billing responses must be ignored after a chat switch",
);

console.log("test-session-continuity-guards: PASS");
