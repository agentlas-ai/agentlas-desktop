import type { WorkforceHostObservation, WorkforceRuntimeToolGrant } from "./runner";
import { workforceHostObservationDigest } from "./runner";

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 256;

/** Consume only documented Claude SDK stream fields: SDKSystemMessage,
 * SDKStatusMessage, SDKPermissionDeniedMessage and SDKResultMessage.
 * https://code.claude.com/docs/en/agent-sdk/typescript
 * Init acknowledges permissionMode, not effective sandbox/settings/hook bytes.
 * A requested config digest is consequently never an acknowledgement.
 */
export function createClaudeWorkforceObservation(options: {
  grant: WorkforceRuntimeToolGrant;
  expectedPermissionMode: string | null;
  expectedSessionId: string | null;
  deniedTools: readonly string[];
}) {
  let init: { sessionId: string; version: string; mode: string; tools: string[]; servers: string[] } | null = null;
  let resultId: string | null = null;
  let failed = false;
  let error: string | null = null;
  const denials = new Map<string, { requestId: string; decision: string }>();
  const invalidate = (reason: string) => { error ??= `workforce_claude_host_observation_${reason}`; };
  const denial = (value: unknown) => {
    const row = record(value);
    if (!row || !identifier(row.tool_use_id) || !identifier(row.tool_name)) {
      invalidate("approval_unverified");
      return;
    }
    denials.set(row.tool_use_id, { requestId: row.tool_use_id, decision: "deny" });
    if (denials.size > 256) invalidate("approval_limit");
  };
  return {
    get error(): string | null { return error; },
    observe(value: unknown): void {
      if (error) return;
      const ev = record(value);
      if (!ev) { invalidate("event_invalid"); return; }
      if (ev.type === "system" && ev.subtype === "init") {
        if (init) { invalidate("duplicate_init"); return; }
        if (!identifier(ev.session_id) || !identifier(ev.claude_code_version) ||
            !identifier(ev.permissionMode) ||
            (options.expectedSessionId !== null && options.expectedSessionId !== ev.session_id) ||
            (options.expectedPermissionMode !== null && options.expectedPermissionMode !== ev.permissionMode) ||
            !Array.isArray(ev.tools) || ev.tools.length > 4096 ||
            !ev.tools.every(identifier) || new Set(ev.tools).size !== ev.tools.length ||
            !Array.isArray(ev.mcp_servers) || ev.mcp_servers.length > 256) {
          invalidate("init_unverified"); return;
        }
        const servers: string[] = [];
        const allServers = new Set<string>();
        for (const candidate of ev.mcp_servers) {
          const server = record(candidate);
          if (!server || !identifier(server.name) || !identifier(server.status) || allServers.has(server.name)) {
            invalidate("servers_unverified"); return;
          }
          allServers.add(server.name);
          if (server.status === "connected") servers.push(server.name);
        }
        const tools = ev.tools as string[];
        if (options.grant.grantedToolIds.some((id) => !tools.includes(id)) ||
            options.grant.expectedServerConfigKeys.some((name) => !servers.includes(name)) ||
            options.deniedTools.some((name) => tools.includes(name))) {
          invalidate("inventory_mismatch"); return;
        }
        init = { sessionId: ev.session_id, version: ev.claude_code_version, mode: ev.permissionMode,
          tools: [...tools].sort(), servers: servers.sort() };
        return;
      }
      // Hook lifecycle notices can precede init. Model/tool/result output cannot.
      if (!init) {
        if (["assistant", "user", "stream_event", "result"].includes(String(ev.type)) ||
            (ev.type === "system" && ev.subtype === "permission_denied")) invalidate("init_missing");
        return;
      }
      if (ev.session_id !== undefined && ev.session_id !== init.sessionId) {
        invalidate("session_mismatch"); return;
      }
      if (ev.type === "system" && ev.subtype === "status" &&
          ev.permissionMode !== undefined && ev.permissionMode !== init.mode) {
        invalidate("policy_changed"); return;
      }
      if (ev.type === "system" && ev.subtype === "permission_denied") denial(ev);
      if (ev.type === "result") {
        if (resultId) { invalidate("duplicate_result"); return; }
        if (ev.subtype !== "success" || ev.is_error !== false) { failed = true; return; }
        if (!identifier(ev.uuid) || ev.session_id !== init.sessionId || !Array.isArray(ev.permission_denials)) {
          invalidate("completion_unverified"); return;
        }
        resultId = ev.uuid;
        for (const item of ev.permission_denials) denial(item);
      }
    },
    finish(): WorkforceHostObservation {
      if (error || failed || !init || !resultId) {
        throw new Error(error ?? `workforce_claude_host_observation_${failed ? "completion_failed" : "completion_missing"}`);
      }
      const payload: Omit<WorkforceHostObservation, "observationDigest"> = {
        schemaVersion: "agentlas.workforce-host-observation.v1",
        permissionPolicyDigest: options.grant.permissionPolicyDigest,
        toolInventoryDigest: options.grant.toolInventoryDigest,
        runtimeKind: "claude-code", runtimeVersion: init.version,
        sessionId: init.sessionId, turnId: resultId,
        nativePolicy: { permissionMode: init.mode }, toolIds: init.tools,
        connectedServers: init.servers, approvalEvents: [...denials.values()], completed: true,
        inventoryScope: "native-init-tools", nativeToolsEnumerated: true,
        requestedConfigDigest: options.grant.canonicalConfigSha256,
      };
      return { ...payload, observationDigest: workforceHostObservationDigest(payload) };
    },
  };
}
