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
  /const hasPriorContext = hasPriorConversationContext\(chat\.id\);/,
  "main invocation must evaluate prior chat context before routing",
);
assert.match(
  clientTs,
  /: hasPriorContext\s*\?\s*null\s*: !plainConversation && isGlobalOrchestrator\(agent\)/,
  "existing-chat follow-up turns must not trigger fresh hidden auto-routing",
);
assert.match(
  clientTs,
  /!hasPriorContext &&\s*isEscalationWorthyPrompt\(req\.userPrompt\)/,
  "existing-chat follow-up turns must not trigger fresh dynamic router escalation",
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
assert.ok(routeOnlyCalls.length >= 2, "expected main invocation routeOnly calls to be present");
for (const arg of routeOnlyCalls) {
  assert.equal(arg, "routingQuery", `main routeOnly call must use contextual routingQuery, got ${arg}`);
}

assert.match(
  chatInputTsx,
  /chatId: string \| null;/,
  "recommendation sheet state must carry the owning chat id",
);
assert.match(
  chatInputTsx,
  /const activeChatIdRef = useRef<string \| null>\(activeChatId\);/,
  "recommendation async resolution must compare against the current chat id",
);
assert.match(
  chatInputTsx,
  /cur\.text === text && cur\.chatId === sheetChatId && activeChatIdRef\.current === sheetChatId/,
  "recommendation preview responses must not hydrate a different chat",
);
assert.match(
  chatInputTsx,
  /if \(activeChatIdRef\.current !== cur\.chatId\)/,
  "recommendation picks must be ignored after a chat switch",
);

console.log("test-session-continuity-guards: PASS");
