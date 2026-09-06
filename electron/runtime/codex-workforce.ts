import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RunnerRequest, WorkforceHostObservation, WorkforceHostInventorySnapshot, WorkforceRuntimeToolGrant } from "./runner";
import { workforceHostObservationDigest } from "./runner";
import type { CodexModelAcknowledgement } from "./codex-session";

const HASH = /^sha256:[0-9a-f]{64}$/;
const TOOL = /^[A-Za-z0-9][A-Za-z0-9_.$:/@+~-]{0,127}$/;
const SERVER = /^[a-z0-9][a-z0-9_-]{0,79}$/;
function fail(reason: string): never { throw new Error(`workforce_codex_observation_${reason}`); }
function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonical(value: unknown): string {
  const sort = (item: any): any => Array.isArray(item) ? item.map(sort)
    : record(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}
function digest(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(canonical(value)).digest("hex")}`;
}
function version(value: unknown, initialize = false): string | null {
  if (typeof value !== "string" || value.length > 2048 || /[\r\n\x00]/.test(value)) return null;
  // Codex's app-server-client parses the version after the first slash in
  // initialize.userAgent (rust-v0.153.4, remote.rs). Its product label varies
  // with the host/client. Process provenance is the spawned Codex transport,
  // not this display label; require a bounded header and an exact version match.
  const header = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}\/(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?=\s|$|\()/.exec(value)?.[1];
  if (header || initialize) return header ?? null;
  // Discovery may retain the literal `codex --version` CLI output.
  return /^(?:codex[-_]cli(?:[-_]rs)?|codex) (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(value)?.[1] ?? null;
}

/** Input provenance only. Codex does not echo an MCP endpoint/config digest. */
export function inspectCodexWorkforceGrant(req: RunnerRequest, args: string[]): string | null {
  const grant = req.workforceRuntimeToolGrant;
  if (!grant) return null;
  if (grant.schemaVersion !== "agentlas.desktop-workforce-runtime-tool-grant.v1"
    || !HASH.test(grant.permissionPolicyDigest) || !HASH.test(grant.toolInventoryDigest)
    || !Array.isArray(grant.grantedToolIds) || grant.grantedToolIds.length > 128
    || grant.grantedToolIds.some((id) => !TOOL.test(id))
    || new Set(grant.grantedToolIds).size !== grant.grantedToolIds.length
    || !Array.isArray(grant.expectedServerConfigKeys) || grant.expectedServerConfigKeys.length > 64
    || grant.expectedServerConfigKeys.some((key) => !SERVER.test(key))
    || new Set(grant.expectedServerConfigKeys).size !== grant.expectedServerConfigKeys.length) fail("grant_invalid");
  if (grant.canonicalConfigSha256 === null) {
    if (grant.grantedToolIds.length || grant.expectedServerConfigKeys.length || req.mcpConfigPath) fail("config_missing");
  } else {
    if (!HASH.test(grant.canonicalConfigSha256) || !req.mcpConfigPath) fail("config_missing");
    const before = fs.lstatSync(req.mcpConfigPath!);
    if (!before.isFile() || before.isSymbolicLink()) fail("config_not_regular");
    const bytes = fs.readFileSync(req.mcpConfigPath!);
    const after = fs.lstatSync(req.mcpConfigPath!);
    if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some((key) => before[key as keyof fs.Stats] !== after[key as keyof fs.Stats])) fail("config_changed");
    if (`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}` !== grant.canonicalConfigSha256) fail("config_digest_mismatch");
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!record(parsed?.mcpServers)
      || canonical(Object.keys(parsed.mcpServers).sort()) !== canonical([...grant.expectedServerConfigKeys].sort())) fail("config_servers_mismatch");
    const configured = new Set<string>();
    for (let index = 0; index < args.length; index += 2) {
      if (args[index] !== "-c" || typeof args[index + 1] !== "string") fail("config_args_invalid");
      const match = /^mcp_servers\.([a-z0-9][a-z0-9_-]{0,79})\./.exec(args[index + 1]);
      if (match) configured.add(match[1]);
    }
    if (grant.expectedServerConfigKeys.some((key) => !configured.has(key))) fail("config_args_server_missing");
  }
  // This binds the exact requested Codex overrides, not a fictional runtime
  // acknowledgement of Claude-format JSON or of the selected MCP endpoints.
  return digest({ canonicalConfigSha256: grant.canonicalConfigSha256, codexConfigArgs: args });
}

interface McpSnapshot {
  toolIds: string[];
  connectedServers: string[];
  serverStates: WorkforceHostInventorySnapshot["serverStates"];
  observedBindings: WorkforceHostInventorySnapshot["selectedBindings"];
  digest: string;
}
type Request = (method: string, params: Record<string, unknown>, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<any>;
const CONNECTION_STATES = new Set(["notStarted", "starting", "connected", "authenticationRequired", "failed", "cancelled", "disabled"]);
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) fail("aborted"); }

/** Thread-scoped native inventory. Cached descriptors never prove connected authority. */
export async function readCodexWorkforceInventory(request: Request, threadId: string, signal?: AbortSignal, timeoutMs = 30_000): Promise<McpSnapshot> {
  const deadline = Date.now() + Math.min(30_000, Math.max(1, timeoutMs));
  const serverStates: McpSnapshot["serverStates"] = [];
  const observedBindings: McpSnapshot["observedBindings"] = [];
  const names = new Set<string>();
  const tools = new Set<string>();
  const servers = new Set<string>();
  const cursors = new Set<string>();
  let descriptorCount = 0;
  let cursor: string | undefined;
  do {
    checkAbort(signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail("inventory_timeout");
    const response = await request("mcpServerStatus/list", {
      threadId, detail: "toolsAndAuthOnly", limit: 100, ...(cursor ? { cursor } : {}),
    }, { timeoutMs: remaining, signal });
    checkAbort(signal);
    if (Date.now() > deadline) fail("inventory_timeout");
    if (!record(response) || !Array.isArray(response.data) || !(response.nextCursor === null || typeof response.nextCursor === "string")) fail("inventory_response_invalid");
    for (const row of response.data) {
      if (!record(row) || typeof row.name !== "string" || !TOOL.test(row.name) || names.has(row.name) || !record(row.tools)) fail("inventory_server_invalid");
      names.add(row.name);
      descriptorCount += Object.keys(row.tools).length;
      if (names.size > 256 || descriptorCount > 4096) fail("inventory_limit");
      if (!CONNECTION_STATES.has(row.runtimeStatus)) fail("inventory_unavailable");
      const toolsError = row.toolsError != null;
      serverStates.push({ name: row.name, runtimeStatus: row.runtimeStatus, toolsDigest: digest(row.tools), serverInfoDigest: digest(row.serverInfo ?? null), toolsError });
      if (row.runtimeStatus === "connected" && !toolsError) {
        servers.add(row.name);
        for (const tool of Object.values(row.tools)) {
          if (!record(tool) || typeof tool.name !== "string" || !tool.name || !record(tool.inputSchema)) fail("inventory_tool_invalid");
          const id = `mcp__${row.name}__${tool.name}`;
          if (!TOOL.test(id)) fail("inventory_tool_invalid");
          if (tools.has(id)) fail("inventory_tool_duplicate");
          tools.add(id);
          observedBindings.push({ toolId: id, serverName: row.name, descriptorDigest: digest(tool) });
        }
      }
      // All known nonconnected states and failed tool reads remain in the
      // evidence; their cached descriptors grant no usable capability.
    }
    cursor = response.nextCursor ?? undefined;
    if (cursor !== undefined && (!cursor || cursors.has(cursor) || cursors.size >= 32)) fail("inventory_cursor_invalid");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const projection = { toolIds: [...tools].sort(), connectedServers: [...servers].sort(), serverStates: serverStates.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) };
  return { ...projection, observedBindings: observedBindings.sort((a, b) => a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0), digest: digest(projection) };
}

function grantConnected(snapshot: McpSnapshot, grant: WorkforceRuntimeToolGrant): boolean {
  return grant.grantedToolIds.every((id) => snapshot.toolIds.includes(id))
    && grant.expectedServerConfigKeys.every((name) => snapshot.connectedServers.includes(name));
}

/** Readiness belongs before the model turn and never replays a completed invocation. */
export async function waitForCodexWorkforceInventory(request: Request, threadId: string, grant: WorkforceRuntimeToolGrant, signal?: AbortSignal, options: { timeoutMs?: number; pollIntervalMs?: number } = {}): Promise<McpSnapshot> {
  const deadline = Date.now() + Math.min(30_000, Math.max(1, options.timeoutMs ?? 30_000));
  const interval = Math.min(1_000, Math.max(1, options.pollIntervalMs ?? 250));
  for (;;) {
    checkAbort(signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail("grant_readiness_timeout");
    const snapshot = await readCodexWorkforceInventory(request, threadId, signal, remaining);
    if (grantConnected(snapshot, grant)) return snapshot;
    const required = new Set(grant.expectedServerConfigKeys);
    // Expected config keys are authoritative; do not infer server ownership
    // by splitting tool IDs whose server names can contain underscores.
    for (const state of snapshot.serverStates) {
      if (required.has(state.name) && (state.toolsError || ["authenticationRequired", "failed", "cancelled", "disabled"].includes(state.runtimeStatus))) fail("grant_not_connected");
    }
    const delay = Math.min(interval, deadline - Date.now());
    if (delay <= 0) fail("grant_readiness_timeout");
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("workforce_codex_observation_aborted")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delay);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}

function grantSnapshot(snapshot: McpSnapshot, grant: WorkforceRuntimeToolGrant): WorkforceHostInventorySnapshot {
  if (!grantConnected(snapshot, grant)) fail("grant_not_connected");
  const selectedBindings = snapshot.observedBindings.filter((binding) => grant.grantedToolIds.includes(binding.toolId));
  const selectedNames = new Set([...grant.expectedServerConfigKeys, ...selectedBindings.map((binding) => binding.serverName)]);
  const selectedServers = snapshot.serverStates.filter((state) => selectedNames.has(state.name)).map(({ name, serverInfoDigest }) => ({ name, serverInfoDigest }));
  return structuredClone({ toolIds: snapshot.toolIds, connectedServers: snapshot.connectedServers, serverStates: snapshot.serverStates,
    selectedBindings, selectedServers, inventoryDigest: snapshot.digest, selectedBindingDigest: digest({ selectedBindings, selectedServers }) });
}

/** One invocation, independent of whether its native process/thread was reused. */
export class CodexWorkforceObservation {
  private readonly runtimeVersion: string;
  private readonly grant: WorkforceRuntimeToolGrant;
  private policy: Record<string, unknown> | null = null;
  private threadId = "";
  private startedTurnId = "";
  private completedTurnId = "";
  private inventoryBefore: WorkforceHostInventorySnapshot | null = null;
  private inventoryAfter: WorkforceHostInventorySnapshot | null = null;
  private problem: string | null = null;
  private approvals: Array<{ requestId: string; decision: string }> = [];

  constructor(private readonly req: RunnerRequest, init: unknown, private readonly configDigest: string | null) {
    this.grant = structuredClone(req.workforceRuntimeToolGrant!);
    const actual = record(init) ? version(init.userAgent, true) : null;
    if (!actual) fail("initialize_version_missing");
    this.runtimeVersion = actual!;
    const expected = this.grant.runtimeVersion;
    if (expected && expected !== actual && version(expected) !== actual) fail("runtime_version_mismatch");
  }

  acknowledgeThread(response: any, modelAcknowledgement: CodexModelAcknowledgement, expected: { sandboxPolicy: Record<string, unknown>; approvalPolicy: string }, cwd: string, reviewer: string, threadId?: string): void {
    if (!record(response) || !record(response.sandbox) || typeof response.thread?.id !== "string" || !response.thread.id) fail("thread_policy_missing");
    if (threadId && response.thread.id !== threadId) fail("thread_id_mismatch");
    if (response.model !== modelAcknowledgement.model || response.modelProvider !== modelAcknowledgement.modelProvider
      || (this.req.model && modelAcknowledgement.requestedModel !== this.req.model)) fail("thread_model_mismatch");
    const actual = response.sandbox;
    const wanted = expected.sandboxPolicy;
    if (response.approvalPolicy !== expected.approvalPolicy || response.approvalsReviewer !== reviewer
      || response.cwd !== path.resolve(cwd) || actual.type !== wanted.type) fail("thread_policy_mismatch");
    // Protocol defaults have semantic meaning; do not mistake omitted false
    // booleans for authority. Unknown policy fields require adapter review.
    const known = actual.type === "workspaceWrite"
      ? ["type", "networkAccess", "writableRoots", "excludeTmpdirEnvVar", "excludeSlashTmp", "readOnlyAccess"]
      : actual.type === "readOnly" ? ["type", "networkAccess", "access"] : ["type"];
    if (Object.keys(actual).some((key) => !known.includes(key))) fail("thread_policy_unknown");
    // Newer app-server versions make the default host read access explicit.
    // Omitted and {type:fullAccess} are equivalent. Restricted read profiles
    // need a separately requested boundary and are never silently expanded.
    const accessKey = actual.type === "workspaceWrite" ? "readOnlyAccess" : "access";
    const access = actual[accessKey];
    if (access !== undefined && (!record(access) || access.type !== "fullAccess" || Object.keys(access).some((key) => key !== "type"))) fail("thread_read_access_mismatch");
    for (const key of known.filter((key) => !["type", "writableRoots", "readOnlyAccess", "access"].includes(key))) {
      if (actual[key] != null && typeof actual[key] !== "boolean") fail("thread_policy_invalid");
      if ((actual[key] ?? false) !== (wanted[key] ?? false)) fail("thread_policy_mismatch");
    }
    if (actual.type === "workspaceWrite") {
      if (!Array.isArray(actual.writableRoots) || actual.writableRoots.some((root: unknown) => typeof root !== "string" || !path.isAbsolute(root))) fail("thread_roots_missing");
      // Native writableRoots lists additional roots: SandboxPolicy's
      // get_writable_roots_with_cwd always includes the acknowledged cwd.
      // 0.153.4 normalizes an explicit duplicate cwd to []. Compare effective
      // sets while retaining the raw native response below as the evidence.
      const effectiveRoots = (roots: string[]) => [...new Set([path.resolve(cwd), ...roots.map((root) => path.resolve(root))])].sort();
      if (canonical(effectiveRoots(actual.writableRoots)) !== canonical(effectiveRoots(wanted.writableRoots as string[]))) fail("thread_roots_mismatch");
    }
    this.threadId = response.thread.id;
    this.policy = JSON.parse(JSON.stringify({
      sandbox: actual, approvalPolicy: response.approvalPolicy, approvalsReviewer: response.approvalsReviewer, cwd: response.cwd,
      model: modelAcknowledgement.model, modelProvider: modelAcknowledgement.modelProvider,
      modelAcknowledgement: modelAcknowledgement.mode,
    }));
  }

  observeInventory(snapshot: McpSnapshot): void {
    const observed = grantSnapshot(snapshot, this.grant);
    if (!this.inventoryBefore) {
      if (this.startedTurnId) fail("inventory_before_missing");
      this.inventoryBefore = observed;
      return;
    }
    if (!this.startedTurnId || this.startedTurnId !== this.completedTurnId || this.inventoryAfter) fail("inventory_phase_invalid");
    if (this.inventoryBefore.selectedBindingDigest !== observed.selectedBindingDigest) fail("selected_inventory_drift");
    this.inventoryAfter = observed;
  }

  startTurn(response: any): void {
    const id = response?.turn?.id;
    if (typeof id !== "string" || !id || !["inProgress", "completed"].includes(response.turn.status)) fail("turn_start_missing");
    this.startedTurnId = id;
  }

  completeTurn(params: any): void {
    if (params?.threadId !== this.threadId || typeof params?.turn?.id !== "string" || params.turn.status !== "completed" || params.turn.error != null) {
      this.problem = "completion_invalid";
      return;
    }
    if (this.completedTurnId) this.problem = "completion_duplicate";
    this.completedTurnId = params.turn.id;
  }

  assertRequestContext(params: any, activeTurnId: string): void {
    if (!activeTurnId || params?.threadId !== this.threadId || params?.turnId !== activeTurnId) {
      this.problem = "approval_turn_mismatch";
      fail(this.problem);
    }
  }

  approval(method: string, params: any, decision: string): void {
    const itemId = params?.approvalId ?? params?.itemId ?? params?.callId;
    if (params?.threadId !== this.threadId || typeof params?.turnId !== "string" || !params.turnId || typeof itemId !== "string" || !itemId) {
      this.problem = "approval_binding_missing";
      return;
    }
    const requestId = `${params.turnId}:${method}:${itemId}`;
    if (this.approvals.some((entry) => entry.requestId === requestId) || this.approvals.length >= 128) this.problem = "approval_duplicate";
    if (!["allow_once", "allow_session", "deny"].includes(decision)) this.problem = "approval_decision_invalid";
    this.approvals.push({ requestId, decision });
  }

  finish(): WorkforceHostObservation {
    if (this.problem) fail(this.problem);
    if (canonical(this.grant) !== canonical(this.req.workforceRuntimeToolGrant)) fail("grant_drift");
    if (!this.policy || !this.inventoryBefore || !this.inventoryAfter || !this.startedTurnId || this.startedTurnId !== this.completedTurnId) fail("completion_missing");
    if (this.approvals.some((entry) => !entry.requestId.startsWith(`${this.startedTurnId}:`))) fail("approval_turn_mismatch");
    const grant = this.grant;
    const observation: Omit<WorkforceHostObservation, "observationDigest"> = {
      schemaVersion: "agentlas.workforce-host-observation.v1",
      permissionPolicyDigest: grant.permissionPolicyDigest,
      toolInventoryDigest: grant.toolInventoryDigest,
      runtimeKind: "codex", runtimeVersion: this.runtimeVersion,
      sessionId: this.threadId, turnId: this.startedTurnId,
      nativePolicy: this.policy!, toolIds: this.inventoryAfter!.toolIds,
      connectedServers: this.inventoryAfter!.connectedServers,
      inventoryEvidence: { schemaVersion: "agentlas.workforce-host-inventory-observation.v1", stability: "selected-grant-bindings", before: this.inventoryBefore!, after: this.inventoryAfter! },
      inventoryScope: "connected-mcp-tools", nativeToolsEnumerated: false,
      requestedConfigDigest: this.configDigest,
      approvalEvents: this.approvals, completed: true,
    };
    return { ...observation, observationDigest: workforceHostObservationDigest(observation) };
  }
}
