import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const firm = readFileSync(resolve(root, "electron/mcp/firm-orchestrator.ts"), "utf8");
const types = readFileSync(resolve(root, "shared/types.ts"), "utf8");
const ledger = readFileSync(resolve(root, "electron/store/run-events.ts"), "utf8");

assert.match(firm, /MAX_HANDOFF_DEPTH\s*=\s*3/);
assert.match(firm, /MAX_PAIR_ROUNDTRIPS\s*=\s*4/);
assert.match(firm, /handoffGuardFor/);
assert.match(firm, /handoffBlockedText/);
assert.match(firm, /handoffBlocked: blockedReason/);
assert.match(firm, /if \(!emitDelegationMessages\(p, org\.ceo, 1, matched\)\)/);
assert.match(firm, /if \(p\.handoffGuard\?\.blocked\) return handoffFailure\(p\)/);
assert.match(types, /handoffDepth\?: number/);
assert.match(types, /handoffRoundtrip\?: number/);
assert.match(types, /handoffBlocked\?: "depth" \| "roundtrip" \| "permission"/);
assert.match(ledger, /handoffDepth: ev\.agentMessage\?\.handoffDepth/);
assert.match(ledger, /handoffBlocked: ev\.agentMessage\?\.handoffBlocked/);

console.log("One Team typed handoff guard: PASS (depth 3, pair roundtrip 4, ledger receipt)");
