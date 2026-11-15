import { classifyHostOperation } from "../runtime/approval-rule";
import { defaultRuntimeToolPermission, getRuntimeToolPermissionArbiter, toolApprovalRefusalText, type RuntimeToolPermissionAsk } from "../runtime/tool-approval";

/*
 * The approval card of an app operation an agent runs (D2; decision and).
 *
 * harness_call app.call and one_app_call reach the app's operations through two host-own servers (agentlas-turn, one-team). The approval rule used to
 * file every tool of those servers under "coordination" by the SERVER's name, so `agent.uninstall` (the agent, its memory store and its folder),
 * `chats.remove`, `projects.remove`, `oneMemory.forgetEntry`, `team.uninstall` or a mail send ran with no card. The host now asks for the act itself,
 * before it runs the operation, through the same arbiter every other card uses (runtime/host-tool-permission-policy.ts):
 *   money   asked every time, no "always allow";
 *   delete  and  send   asked in read and write mode, "always allow" is remembered for the project (the conversation without one); full access asks money only;
 *   anything else is not asked.
 * An unattended run (an automation, a Goal pass nobody watches) has nobody to answer: a delete or send is refused with the cause, as for any other tool.
 * The class is read from the operation's own name (approval-rule.ts classifyHostOperation), never from the server it travels through.
 */
export type AppCallApproval = { ok: true } | { ok: false; reason: "approval_refused"; text: string };

export async function approveAppOperation(input: {
  operation: string; chatId: string; permission: "read" | "write" | "full"; unattended: boolean; signal?: AbortSignal;
}): Promise<AppCallApproval> {
  if (classifyHostOperation(input.operation) === "other") return { ok: true };
  // A read-permission run cannot run a change at all (app-control/service.ts execution-permission-read-only): no card for a call that is refused anyway.
  if (input.permission === "read") return { ok: true };
  // The owner's own screen is never here (its IPC is the owner's click); a call with no conversation has nowhere to show a card.
  const arbiter = getRuntimeToolPermissionArbiter();
  const ask: RuntimeToolPermissionAsk = {
    runtime: "agentlas-app", sessionKey: `app-call:${input.chatId}`, tool: `app_call.${input.operation}`, hostOperation: input.operation, kind: "other", mutating: true,
    detail: input.operation, permission: input.permission, chatId: input.chatId, ...(input.unattended ? { unattended: true as const } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  let decision: "allow_once" | "allow_session" | "deny" | string = "deny";
  try { decision = arbiter ? await arbiter(ask) : "deny"; } catch { decision = "deny"; }
  if (decision !== "deny") return { ok: true };
  return { ok: false, reason: "approval_refused", text: toolApprovalRefusalText(ask) || "approval_refused: the owner did not approve this call; do not repeat it" };
}

/**
 * The same window for one call of a connected app that lives on the server (Agentlas 2.0 DD, contracts/desktop-server-tools.md section 3). The proxy, the in-process loop and
 * Codex's own approval each raise it before the call reaches the bridge and leave a record (harness/host-call-ticket.ts); a call that arrives with no record (the `tool.call`
 * port, a runtime that asks nothing, Codex under full access) raises it here, once, so a change to an app never leaves this computer on nobody's say. The act is read by the
 * approval rule from the tool's own name and the marks the list carries (money asks every time; delete and send ask in read/write modes and are remembered for the project;
 * full access asks money only) - no new card, no new rule.
 */
export async function approveHostServerCall(input: {
  tool: string; chatId: string; permission: "read" | "write" | "full"; unattended: boolean; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }; signal?: AbortSignal;
}): Promise<AppCallApproval> {
  const arbiter = getRuntimeToolPermissionArbiter();
  const ask: RuntimeToolPermissionAsk = {
    runtime: "agentlas-app", sessionKey: `app-call:${input.chatId}`, tool: `mcp__agentlas-server-apps__${input.tool}`, kind: "other", mutating: true,
    catalogId: "agentlas-server-apps", annotations: input.annotations ?? null, permission: input.permission, chatId: input.chatId,
    ...(input.unattended ? { unattended: true as const } : {}), ...(input.signal ? { signal: input.signal } : {}),
  };
  let decision: "allow_once" | "allow_session" | "deny" | string = "deny";
  try { decision = arbiter ? await arbiter(ask) : "deny"; } catch { decision = "deny"; }
  if (decision !== "deny") return { ok: true };
  return { ok: false, reason: "approval_refused", text: toolApprovalRefusalText(ask) || "approval_refused: the owner did not approve this call; do not repeat it" };
}

/**
 * The same window for one call of a connected app installed on this computer, reached through the harness `tool.call` port.
 * Called straight through the app's own server the call passes the approval rule (runtime/host-tool-permission-policy.ts, one function for every runtime);
 * through the gateway tool `harness_call` the rule saw only the gateway's name (a host-own server: never asked), so a change to an app had no card in write
 * mode. This builds the ask exactly as the MCP proxy does (mcp-tools/proxy-session.ts: the tool as `mcp__<key>__<tool>`, the registry identity, the server's
 * marks, the closed read table) and asks the same arbiter, so the card, its "always allow" (the project; money never) and its refusal sentence are the direct
 * path's. A conversation-less call (the owner's own screen, chat "ui") is the owner's click and is not asked here. A connected app on the server has its own
 * window at its bridge (one/server-apps-host.ts) and is not asked twice.
 */
export async function approveConnectorToolCall(input: {
  serverKey: string; catalogId: string | null; tool: string; schemaDigest: string; consentTarget: string; arguments: unknown;
  chatId: string; permission: "read" | "write" | "full"; unattended: boolean;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } | null; signal?: AbortSignal;
}): Promise<AppCallApproval> {
  const { mcpToolIsMutating } = await import("../mcp-tools/proxy-server");
  const { bindMainToolConsentResource } = await import("../runtime/tool-consent");
  const ask: RuntimeToolPermissionAsk = {
    runtime: "agentlas-app", sessionKey: `app-call:${input.chatId}`, tool: `mcp__${input.serverKey}__${input.tool}`, kind: "other",
    mutating: mcpToolIsMutating({ catalogId: input.catalogId, toolName: input.tool, args: input.arguments }),
    permission: input.permission, chatId: input.chatId, arguments: input.arguments,
    catalogId: input.catalogId, annotations: input.annotations ?? null,
    ...(input.unattended ? { unattended: true as const } : {}), ...(input.signal ? { signal: input.signal } : {}),
  };
  // F4: a read-permission run used to skip a call the rule has no class for, on the premise that the gateway tool's own card had already asked. Measured with the real config and the real
  // MCP child: on every runtime that launches `agentlas-turn` directly (claude-code, antigravity, the ACP lanes unless the agent asks natively) the gateway raises NO card, so a plain change of an
  // app ran unasked in read mode. The port now asks in every mode, as the direct road does (a known read is not a change and is not asked); the runtimes that DO raise a gateway card (the
  // in-process loop, Codex) mark it `portAsksItsOwnRule`, so the owner still sees one card.
  bindMainToolConsentResource(ask, { tool: ask.tool, target: input.consentTarget, schema: input.schemaDigest, arguments: input.arguments });
  const arbiter = getRuntimeToolPermissionArbiter();
  let decision: "allow_once" | "allow_session" | "deny" | string = "deny";
  // No arbiter in this process: the MCP proxy's own fallback (a change in a read run is refused, the rest runs), never "run unasked".
  try { decision = arbiter ? await arbiter(ask) : defaultRuntimeToolPermission(ask) === "deny" ? "deny" : "allow_once"; } catch { decision = "deny"; }
  if (decision !== "deny") return { ok: true };
  return { ok: false, reason: "approval_refused", text: toolApprovalRefusalText(ask) || "approval_refused: the owner did not approve this call; do not repeat it" };
}
