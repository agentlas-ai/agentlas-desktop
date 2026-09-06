import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { RunnerRequest, WorkforcePermissionEnforcementReceipt } from "./runner";

export interface WorkforceBrokerInventoryEntry {
  toolId: string;
  kind: "builtin" | "mcp";
  descriptorDigest: string;
  serverConfigKey: string | null;
  serverConfigDigest: string | null;
}
type Decision = "not_requested" | "allow_once" | "allow_session" | "deny";
type Outcome = "succeeded" | "failed" | "denied" | "not_dispatched";
export interface WorkforceBrokerProviderCallLocation {
  responseIndex: number;
  partIndex: number;
}
interface BrokerAction {
  actionId: string;
  providerCallId: string | null;
  providerCallLocation: WorkforceBrokerProviderCallLocation | null;
  toolId: string;
  decision: Decision;
  outcome: Outcome;
}
export interface WorkforceBrokerObservation {
  schemaVersion: "agentlas.workforce-broker-observation.v1";
  brokerKind: "agentlas-main-tool-loop";
  brokerInvocationId: string;
  runtimeKind: string;
  permissionPolicyDigest: string;
  toolInventoryDigest: string;
  permission: "read" | "write" | "full";
  cwd: string | null;
  requestedConfigDigest: string | null;
  inventory: WorkforceBrokerInventoryEntry[];
  inventoryDigest: string;
  actions: BrokerAction[];
  completed: true;
  observationDigest: string;
}

export function workforceBrokerDigest(value: unknown): string {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])])) : item;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}
const HASH = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.$:/@+~-]{0,127}$/;
function fail(code: string): never { throw new Error(`workforce_broker_${code}`); }

/** Main owns this dispatch table and action ledger. These are not provider
 * native sessions, endpoint attestations, or an isolated package sandbox.
 */
export class MainWorkforceBroker {
  private readonly invocationId = randomUUID();
  private readonly grant: NonNullable<RunnerRequest["workforceRuntimeToolGrant"]>;
  private readonly inventory: WorkforceBrokerInventoryEntry[];
  private readonly actions = new Map<string, Omit<BrokerAction, "outcome"> & { outcome?: Outcome }>();
  private readonly permission: "read" | "write" | "full";
  private readonly cwd: string | null;
  private finished = false;

  constructor(private readonly req: RunnerRequest, private readonly runtimeKind: string, inventory: WorkforceBrokerInventoryEntry[]) {
    const grant = req.workforceRuntimeToolGrant;
    if (!grant || req.untrustedNoTools || !/^[A-Za-z0-9][A-Za-z0-9_.$:/@+~-]{0,255}$/.test(runtimeKind) ||
      grant.schemaVersion !== "agentlas.desktop-workforce-runtime-tool-grant.v1" ||
      !HASH.test(grant.permissionPolicyDigest) || !HASH.test(grant.toolInventoryDigest) ||
      !Array.isArray(grant.grantedToolIds) || grant.grantedToolIds.length > 128 ||
      new Set(grant.grantedToolIds).size !== grant.grantedToolIds.length || grant.grantedToolIds.some((id) => !ID.test(id)) ||
      !Array.isArray(grant.expectedServerConfigKeys) || grant.expectedServerConfigKeys.length > 64 ||
      new Set(grant.expectedServerConfigKeys).size !== grant.expectedServerConfigKeys.length || grant.expectedServerConfigKeys.some((id) => !ID.test(id))) fail("grant_invalid");
    this.grant = structuredClone(grant);
    this.permission = req.permission ?? "read";
    this.cwd = req.cwd ? path.resolve(req.cwd) : null;
    if (!["read", "write", "full"].includes(this.permission) || (this.cwd && this.cwd.length > 4096)) fail("policy_invalid");
    this.inventory = structuredClone(inventory).sort((a, b) => a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0);
    if (this.inventory.length > 4096 || new Set(this.inventory.map((row) => row.toolId)).size !== this.inventory.length) fail("inventory_invalid");
    const serverDigests = new Map<string, string>();
    for (const row of this.inventory) {
      if (Object.keys(row).sort().join(",") !== "descriptorDigest,kind,serverConfigDigest,serverConfigKey,toolId" || !ID.test(row.toolId) || !HASH.test(row.descriptorDigest)) fail("inventory_invalid");
      if (row.kind === "builtin") {
        if (row.serverConfigKey !== null || row.serverConfigDigest !== null) fail("inventory_invalid");
      } else if (row.kind !== "mcp" || typeof row.serverConfigKey !== "string" || !ID.test(row.serverConfigKey) ||
        typeof row.serverConfigDigest !== "string" || !HASH.test(row.serverConfigDigest) ||
        !row.toolId.startsWith(`mcp__${row.serverConfigKey}__`) || row.toolId.length <= row.serverConfigKey.length + 7) fail("inventory_invalid");
      if (row.kind === "mcp" && row.serverConfigKey && row.serverConfigDigest) {
        const previous = serverDigests.get(row.serverConfigKey);
        if (previous && previous !== row.serverConfigDigest) fail("inventory_invalid");
        serverDigests.set(row.serverConfigKey, row.serverConfigDigest);
      }
    }
    if (grant.grantedToolIds.some((id) => !this.inventory.some((row) => row.toolId === id)) ||
      grant.expectedServerConfigKeys.some((key) => !this.inventory.some((row) => row.kind === "mcp" && row.serverConfigKey === key))) fail("grant_not_available");
    this.verifyConfig();
  }

  private verifyConfig(): void {
    if (this.req.signal?.aborted) fail("aborted");
    const expected = this.grant.canonicalConfigSha256;
    if (expected === null) {
      if (this.grant.expectedServerConfigKeys.length || this.req.mcpConfigPath) fail("config_missing");
      return;
    }
    if (!HASH.test(expected) || !this.req.mcpConfigPath) fail("config_missing");
    const before = fs.lstatSync(this.req.mcpConfigPath);
    if (!before.isFile() || before.isSymbolicLink()) fail("config_not_regular");
    const bytes = fs.readFileSync(this.req.mcpConfigPath);
    const after = fs.lstatSync(this.req.mcpConfigPath);
    if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some((key) => before[key as keyof fs.Stats] !== after[key as keyof fs.Stats]) ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== expected) fail("config_changed");
  }

  beginAction(providerCallId: string | null, toolId: string, providerCallLocation: WorkforceBrokerProviderCallLocation | null = null): string {
    if (this.finished || this.actions.size >= 256 || !ID.test(toolId) ||
      (providerCallId !== null && (typeof providerCallId !== "string" || !providerCallId || providerCallId.length > 256)) ||
      (providerCallId === null && providerCallLocation === null)) fail("action_invalid");
    if (providerCallLocation !== null && (
      typeof providerCallLocation !== "object" || Array.isArray(providerCallLocation) ||
      Object.keys(providerCallLocation).sort().join(",") !== "partIndex,responseIndex" ||
      ![providerCallLocation.responseIndex, providerCallLocation.partIndex].every((value) => Number.isInteger(value) && value >= 0 && value <= 4095)
    )) fail("action_invalid");
    this.verifyConfig();
    const actionId = randomUUID();
    this.actions.set(actionId, { actionId, providerCallId, providerCallLocation: structuredClone(providerCallLocation), toolId, decision: "not_requested" });
    return actionId;
  }

  recordDecision(actionId: string, decision: Exclude<Decision, "not_requested">): void {
    const action = this.actions.get(actionId);
    if (!action || action.outcome || action.decision !== "not_requested" || !["allow_once", "allow_session", "deny"].includes(decision)) fail("decision_invalid");
    action.decision = decision;
  }

  finishAction(actionId: string, outcome: Outcome): void {
    const action = this.actions.get(actionId);
    if (!action || action.outcome || !["succeeded", "failed", "denied", "not_dispatched"].includes(outcome)) fail("action_invalid");
    const allowed = action.decision === "allow_once" || action.decision === "allow_session";
    if ((["succeeded", "failed"].includes(outcome) && (!allowed || !this.inventory.some((row) => row.toolId === action.toolId))) ||
      (outcome === "denied" && (action.decision !== "deny" || !this.inventory.some((row) => row.toolId === action.toolId))) || (outcome === "not_dispatched" && action.decision !== "not_requested")) fail("action_decision_mismatch");
    action.outcome = outcome;
  }

  finish(completed: boolean): WorkforcePermissionEnforcementReceipt | undefined {
    if (this.finished) fail("already_finished");
    this.finished = true;
    if (!completed || this.req.signal?.aborted) return undefined;
    this.verifyConfig();
    if (workforceBrokerDigest(this.req.workforceRuntimeToolGrant) !== workforceBrokerDigest(this.grant) ||
      (this.req.permission ?? "read") !== this.permission || (this.req.cwd ? path.resolve(this.req.cwd) : null) !== this.cwd ||
      [...this.actions.values()].some((action) => !action.outcome)) fail("completion_invalid");
    const payload: Omit<WorkforceBrokerObservation, "observationDigest"> = {
      schemaVersion: "agentlas.workforce-broker-observation.v1", brokerKind: "agentlas-main-tool-loop",
      brokerInvocationId: this.invocationId, runtimeKind: this.runtimeKind,
      permissionPolicyDigest: this.grant.permissionPolicyDigest, toolInventoryDigest: this.grant.toolInventoryDigest,
      permission: this.permission, cwd: this.cwd, requestedConfigDigest: this.grant.canonicalConfigSha256,
      inventory: structuredClone(this.inventory), inventoryDigest: workforceBrokerDigest(this.inventory),
      actions: [...this.actions.values()].map((action) => ({ ...action })) as BrokerAction[], completed: true,
    };
    return {
      permissionPolicyDigest: this.grant.permissionPolicyDigest, enforcementMode: "host-broker", status: "enforced", approvalReceiptIds: [],
      enforcementEvidence: {
        runtimeKind: this.runtimeKind, runtimeVersion: null, sandboxMode: "host-broker", toolInventory: "broker-observed",
        disabledCapabilities: [], ephemeral: false, ignoredUserConfig: false, ignoredRules: false,
        toolInventoryDigest: this.grant.toolInventoryDigest, grantedToolIds: [...this.grant.grantedToolIds],
        brokerObservation: { ...payload, observationDigest: workforceBrokerDigest(payload) },
      },
    };
  }
}
