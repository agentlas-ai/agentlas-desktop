import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const taskForce = readFileSync(resolve(root, "electron/mcp/borrowed-task-force.ts"), "utf8");
const firm = readFileSync(resolve(root, "electron/mcp/firm-orchestrator.ts"), "utf8");
const types = readFileSync(resolve(root, "shared/types.ts"), "utf8");
const ledger = readFileSync(resolve(root, "electron/store/run-events.ts"), "utf8");
const oneShell = readFileSync(resolve(root, "renderer/components/one/OneShell.tsx"), "utf8");
const client = readFileSync(resolve(root, "electron/mcp/client.ts"), "utf8");

// The grant is explicit and bounded: a full parent can only mint a write
// implementation worker, while planner/synthesis/repair remain read-only.
assert.match(taskForce, /export function taskForceChildPermission/);
assert.match(taskForce, /role === "worker" && inputType === "implementation"/);
assert.match(taskForce, /const managerRunnerBase = taskForceRunnerBase\(p, "read"\)/);
assert.match(taskForce, /permission: role === "worker" \? workerPermission : "read"/);
assert.match(taskForce, /permissions: workerPermission/);
assert.match(firm, /export function firmNodePermission/);
assert.match(firm, /turn\.phase === "delegate" \? "write" : "read"/);
assert.match(firm, /permission: .*nodePermission/);
assert.match(types, /handoffPermission\?: "read" \| "write" \| "full"/);
assert.match(types, /permissionInherited\?: false/);
assert.match(firm, /permissionInherited: false/);
assert.match(ledger, /handoffPermission: ev\.agentMessage\?\.handoffPermission/);
assert.match(ledger, /permissionInherited: ev\.agentMessage\?\.permissionInherited/);
// Renderer continuations must inherit Main's durable effective authority. A
// Task materialization or automatic recovery cannot reinterpret Auto as write.
assert.match(oneShell, /sourceReceipt\?\.executionPermission \?\? "read"/);
assert.match(oneShell, /options\?\.promptOrigin === "system"/);
assert.match(oneShell, /runPermissionMode = sourceReceipt\?\.executionPermission \?\? "read"/);
assert.match(oneShell, /\{ permissionMode: continuationPermission \}/);
// One alone may enter Build/Cloud/Network, while every standing teammate keeps
// local Tool/MCP access and the local Storm command (including its old alias).
assert.match(client, /oneControllerOnlyHephaestusCommand/);
assert.match(client, /one-controller-command-required/);
assert.match(client, /hep-network\\s\+--stormbreaker/);
assert.match(client, /agent\.id !== ONE_AGENT_ID/);
assert.match(client, /oneTeamExecutionPolicy === "solo_locked"/);
// One-authored agent builds stay in the One Team modal. No One control may
// navigate to the standalone Build route, and the draft seed must reach both
// semantic result cards and the create dialog without replacing avatar state.
assert.doesNotMatch(oneShell, /router\.push\(["'`]\/build/);
assert.match(oneShell, /onOpenAgentDraft=\{openCreateAgentDialog\}/);
assert.match(oneShell, /seed=\{createAgentSeed\}/);

console.log("One Team permission boundary: PASS (bounded grants; One-only Build/Cloud/Network; teammate Storm/local tools; agent building stays inside One)");
