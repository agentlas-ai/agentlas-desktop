import type { HostToolDeclaration, HostToolServer } from "../mcp-tools/host-tool-servers";
import { bridgeTools, SERVER_APPS_CONFIG_KEY, SERVER_APPS_STATUS_TOOL, type BridgeTool, type ServerApps, type ToolOutcome } from "./server-apps";
import { SERVER_APPS_CAPABILITY_TOOLS, SERVER_APPS_CONTROL_ENV, SERVER_APPS_STATUS_DESCRIPTION, SERVER_APPS_STATUS_INPUT_SCHEMA, serverAppsMcpLaunchArgs } from "../turn-tools/server-apps-mcp";
import { consumeHostCall, declareHostCostHosts, declareHostReadTools, declareHostToolMarks, hostCallMarks, releaseHostReadTools, releaseHostToolMarks, HOST_CALL_SERVER_KEY } from "../harness/host-call-ticket";
import { gateServerAppsCall } from "../harness/tool-isolation";
import { approvalWithinCallWindow, approveHostServerCall } from "../harness/app-call-approval";
import { redactToolJson } from "../harness/tool-result-store";
import { registerDeclaredPromptModule } from "../runtime/prompt-order";
import { noteServerAppFailed, serverFirstConnectorIds } from "../connectors/route-gate";

/*
 * Main's side of the bridge (contracts/desktop-server-tools.md sections 4 and 6). Two jobs, both thin:
 *   mintServerAppsHostToolServer  makes the ONE host tool server of a turn (mcp-tools/host-tool-servers.ts) - or nothing. Nothing = no config row, no
 *                                 process, no tool definition: a person with no server apps, a switch that is off, a computer that is not the home, a
 *                                 daemon (no device key), and every turn that is not the personal agent's own conversation get exactly the bytes they got before.
 *   handleServerAppsOperation     answers the bridge child's three loopback operations. EVERY call reads who is calling again (harness/tool-caller.ts, via
 *                                 harness/tool-isolation.ts gateServerAppsCall): a bundle that was minted for the personal agent is never trusted later.
 * The tool definitions of a turn are a frozen copy of the stored list taken at mint time, so the list a runtime shows and the list a call is checked against
 * are the same bytes for the whole turn even if a signal stores a newer list meanwhile (the next turn gets the new one).
 * No Electron import (the background service loads this).
 */

/*
 * Registered prompt modules (docs/PROMPT-COMPOSITION-POLICY.md; ledger recipes desktop.server-apps.tools and desktop.server-apps.judgment-line). The text of a tool definition
 * is the SERVER's own (name, description at most 240 characters, schema at most 4 KiB), so it is `versioned-content`: it changes when the person attaches, changes or removes an
 * app on the phone (`plugin-inventory`), never inside a conversation, never because of a message. The judgment's one line per app is a candidate of the call that already
 * exists (it is `configuration`: it changes with the same inventory); both reach only the personal agent's own conversation. Nothing here is ever in the system prompt or in
 * the conversation's messages: 0 bytes there.
 */
export const SERVER_APPS_DEFINITIONS_MODULE = Object.freeze({ id: "tool.agentlas-server-apps.definitions", revision: 1, stability: "versioned-content" as const, changeTriggers: ["plugin-inventory"] as const, order: 0 });
export const SERVER_APPS_JUDGMENT_LINE_MODULE = Object.freeze({ id: "purpose.mcp-need.server-app-line", revision: 1, stability: "configuration" as const, changeTriggers: ["plugin-inventory"] as const, order: 0 });
registerDeclaredPromptModule(SERVER_APPS_DEFINITIONS_MODULE);
registerDeclaredPromptModule(SERVER_APPS_JUDGMENT_LINE_MODULE);

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: true; structuredContent?: unknown };
interface Snapshot { tools: readonly BridgeTool[]; byName: ReadonlyMap<string, BridgeTool>; list: readonly object[] }
const snapshots = new Map<string, Snapshot>();

/**
 * F8: why the background service sees 0 server apps, stated as it is. Two separate facts, each enough alone:
 *   1. there is no key: the device key is wrapped by Electron `safeStorage`, which the service does not have, so `standing()` answers `no_device_key` and `snapshot()` is null (one/home.ts `standing`, `keyed`);
 *   2. there is no instance: `realDeps()` hands `serverAppsExtras` to the home only in the Main process (`process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE`, one/home.ts, the same condition as `mirrorStore`
 *      and `move`), and the service runs as Electron-as-Node.
 * Fact 1 can change one day (the service may be given a key); fact 2 is a line in another file. This one is the explicit condition HERE: the default provider answers null in every process that is not Main, whatever
 * the home or the key store may later offer, so a service that gains a key does not switch the bridge on by itself - it needs this line changed on purpose. (A gate hands in its own instance through the seam below.)
 */
const isMainProcess = (): boolean => Boolean(process.versions.electron) && !process.env.ELECTRON_RUN_AS_NODE;
const defaultProvider = (): ServerApps | null => {
  if (!isMainProcess()) return null;
  try { return (require("./home") as typeof import("./home")).oneHome().serverApps(); } catch { return null; }
};
let provider: () => ServerApps | null = defaultProvider;
/** Test seam: the gate hands in its own server-apps instance. Never set in production. */
export function setServerAppsProvider(next: (() => ServerApps | null) | null): void {
  provider = next ?? defaultProvider;
}
export function currentServerApps(): ServerApps | null { try { return provider(); } catch { return null; } }

/** What a refusal tells the model, in a fixed sentence per closed word (never a sentence of the server or of the app). */
const NEXT: Readonly<Record<string, string>> = Object.freeze({
  tools_unavailable: "this connected app is not usable right now; say so in your reply and go on without it",
  server_unreachable: "this connected app is not usable right now; say so in your reply and go on without it",
  upstream_unavailable: "the app did not answer; say so in your reply and go on without it",
  upstream_timeout: "the app did not answer in time; say so in your reply and go on without it",
  busy: "too many calls at once; wait for your running calls and try once more",
  rate_limited: "the limit for this account was reached for now; go on without it",
  outcome_unknown: "the change may or may not have happened; ask the owner to check the app; do not send it again",
  not_connected: "the app is no longer connected; the owner connects it again on the phone",
  reconnect_needed: "the app needs to be connected again; the owner does that on the phone",
  tool_not_found: "the app no longer offers that tool",
  write_not_allowed: "a change needs the owner's approval in this conversation",
  approval_required: "a change needs the owner's approval in this conversation; this call was not approved",
  owner_turn_required: "a change needs a turn the owner wrote; ask the owner in your reply",
  not_allowed_for_actor: "connected apps are the personal agent's own conversation only",
  arguments_too_large: "the arguments are too large; send fewer",
  result_too_large: "the result was too large; ask for less",
});
const nextFor = (word: string): string => NEXT[word] ?? "this call did not run";

const textResult = (value: unknown, isError = false): McpResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true as const } : {}) });
const refusal = (word: string, extra?: Record<string, unknown>): McpResult => textResult({ error: word, next: nextFor(word), ...(extra ?? {}) }, true);

function outcomeToResult(out: ToolOutcome): McpResult {
  if (out.pending) return textResult({ state: "pending", callId: out.pending.callId, next: "the app is still working; ask server_apps_status with this callId later, or tell the owner it is running" });
  if (!out.ok || out.word) return refusal(out.word ?? "tools_unavailable", out.retryAfterSeconds ? { retryAfterSeconds: out.retryAfterSeconds } : undefined);
  // The server already scrubbed secrets; the computer's own mask runs once more over everything that goes to the model (contract section 8).
  const content = Array.isArray(out.content) ? out.content : [];
  const scrubbed = redactToolJson({ content, ...(out.structuredContent !== undefined ? { structuredContent: out.structuredContent } : {}) }) as { content?: unknown[]; structuredContent?: unknown };
  const parts = (Array.isArray(scrubbed.content) ? scrubbed.content : []).filter((p): p is { type: string; text?: string } => !!p && typeof p === "object").map((p) => (p.type === "text" && typeof p.text === "string" ? { type: "text" as const, text: p.text } : { type: "text" as const, text: JSON.stringify(p).slice(0, 4000) }));
  return { content: parts.length ? parts : [{ type: "text", text: "" }], ...(out.isError ? { isError: true as const } : {}), ...(scrubbed.structuredContent !== undefined ? { structuredContent: scrubbed.structuredContent } : {}) };
}

// A tool the server DECLARES as costing money also carries `costsMoneyHint` (runtime/approval-rule.ts): the approval rule then asks the money card every time, in full access too. An app that declares
// nothing gets the same bytes as before (the key is absent, not false). (A tool with a declared cost is never a read: server-apps.ts parseApp.)
const annotationsOf = (tool: BridgeTool): Record<string, boolean> => ({
  ...(tool.readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: tool.destructive, openWorldHint: true }),
  ...(tool.costsMoney ? { costsMoneyHint: true } : {}),
});

export interface ServerAppsMintInput {
  chatId: string; runId: string; runtimeKind: string;
  permission: "read" | "write" | "full"; unattended: boolean;
  /** The judge's pick among the apps offered as one line each (null: no answer, nothing is listed first - the common search and the menu still reach every tool). */
  firstListConnectorIds: ReadonlySet<string> | null;
  admissionCurrent?: () => boolean;
}
export interface ServerAppsHostToolServer extends HostToolServer {
  readonly connectorIds: readonly string[];
  release(): void;
}

export async function mintServerAppsHostToolServer(input: ServerAppsMintInput): Promise<ServerAppsHostToolServer | null> {
  const apps = currentServerApps();
  if (!apps) return null;
  // The stored list answers only while the home stands and nothing refused this computer (server-apps.ts snapshot): memory only, no request.
  const state = apps.snapshot();
  if (!state) return null;
  // The caller is read from the host's rows for this very run. Anything but the personal agent's own conversation gets nothing, not even a process.
  const { resolveToolCaller } = await import("../harness/tool-caller");
  const who = await resolveToolCaller({ chatId: input.chatId, runId: input.runId });
  if (who.kind !== "personal") return null;
  const computer = await apps.computerHas();
  const tools = bridgeTools(state, computer, serverFirstConnectorIds(computer, input.chatId));
  if (!tools.length) return null;
  const control = await import("../turn-tools/control-server");
  const capability = await control.createServerAppsCapability({
    chatId: input.chatId, runId: input.runId, runtimeKind: input.runtimeKind, tools: [...SERVER_APPS_CAPABILITY_TOOLS],
    permission: input.permission, ...(input.unattended ? { unattended: true as const } : {}), ...(input.admissionCurrent ? { admissionCurrent: input.admissionCurrent } : {}),
  }, `server-apps-${input.runId}`);
  const capabilityId = capability.binding.capabilityId;
  const statusTool: BridgeTool = { name: SERVER_APPS_STATUS_TOOL, connectorId: "server-apps", tool: SERVER_APPS_STATUS_TOOL, appName: "Connected apps", description: SERVER_APPS_STATUS_DESCRIPTION,
    inputSchema: SERVER_APPS_STATUS_INPUT_SCHEMA as unknown as Record<string, unknown>, readOnly: true, destructive: false };
  const all = [...tools, statusTool];
  const byName = new Map(all.map((tool) => [tool.name, tool] as const));
  snapshots.set(capabilityId, { tools: all, byName, list: Object.freeze(all.map((tool) => Object.freeze({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: annotationsOf(tool) }))) });
  // TR-desktop 4 (M2a): a read is the host's OWN word. A server app's `readOnly` is a declaration of someone else's server (the web list passes an outside MCP server's `readOnlyHint` on), and a local app's declaration never makes a read
  // either (local-tool-loop.ts `admittedMcpRead`: only the host's closed table does). So only the host's own status tool is declared read here; every other tool of a server app goes through the approval rule like an app installed on this computer.
  declareHostReadTools(capabilityId, [SERVER_APPS_STATUS_TOOL]);
  declareHostToolMarks(capabilityId, all.filter((tool) => !tool.readOnly).map((tool) => [tool.name, annotationsOf(tool)] as const));
  declareHostCostHosts(capabilityId, all.filter((tool) => tool.costsMoneyHosts?.length).map((tool) => [tool.name, tool.costsMoneyHosts as string[]] as const));
  const declarations: HostToolDeclaration[] = all.map((tool) => ({ name: tool.name, description: tool.description, group: { id: tool.connectorId, label: tool.appName }, fields: [], artifactKinds: [], effect: tool.readOnly ? "read" as const : "effect" as const }));
  const first = input.firstListConnectorIds;
  const firstList = first && first.size ? tools.filter((tool) => first.has(tool.connectorId)).map((tool) => tool.name) : [];
  let released = false;
  const release = (): void => { if (released) return; released = true; snapshots.delete(capabilityId); releaseHostReadTools(capabilityId); releaseHostToolMarks(capabilityId); try { control.removeTurnToolsCapability(`server-apps-${input.runId}`, capabilityId); } catch { /* the capability ends with the host */ } };
  return Object.freeze({
    configKey: SERVER_APPS_CONFIG_KEY, name: "Agentlas connected apps (server)", command: process.execPath, args: Object.freeze(serverAppsMcpLaunchArgs()),
    publicEnv: Object.freeze({ [SERVER_APPS_CONTROL_ENV]: capability.path }), secretEnv: Object.freeze({}),
    declarations: Object.freeze(declarations), firstList: Object.freeze(firstList),
    isCurrent: () => !released && control.turnToolsCapabilityLive(capabilityId) && (input.admissionCurrent ? input.admissionCurrent() : true),
    // A change to an app takes up to the server's 60 s wait plus its 5 s (contract section 7); Codex's own default tool wait is 60 s.
    toolTimeoutSec: 70,
    connectorIds: Object.freeze([...new Set(tools.map((tool) => tool.connectorId))]),
    release,
  }) as ServerAppsHostToolServer;
}

/**
 * The start of a turn, before the tool-need judgment (mcp/client.ts). For the personal agent's own conversation only:
 *   - a turn that came from the phone is a signal (the person may have just attached an app there): one list request, never waited for;
 *   - the apps of the stored list, ONE LINE each, are handed to the same judgment call as every other candidate (no new model call, no new prompt module: the line is the
 *     candidate's own `name`/`description` fields). A person with no stored app, a switch that is off or a computer that is not the home gets an empty list.
 * Any other turn (a work agent, a project room, a room member, a Hub agent, a borrowed node, a run with no conversation) gets nothing and signals nothing.
 */
export async function prepareServerAppsTurn(input: { chatId: string; runId: string; phoneOrigin: boolean }): Promise<{ candidates: Array<{ id: string; name: string; description: string; origin: "local" }> }> {
  const none = { candidates: [] };
  const apps = currentServerApps();
  if (!apps) return none;
  if (!input.phoneOrigin && !apps.snapshot()) return none;
  const { resolveToolCaller } = await import("../harness/tool-caller");
  const who = await resolveToolCaller({ chatId: input.chatId, runId: input.runId });
  if (who.kind !== "personal") return none;
  if (input.phoneOrigin) apps.signal("phone");
  const state = apps.snapshot();
  if (!state) return none;
  const computer = await apps.computerHas();
  const tools = bridgeTools(state, computer, serverFirstConnectorIds(computer, input.chatId));
  const by = new Map<string, { id: string; name: string; n: number }>();
  for (const tool of tools) {
    const row = by.get(tool.connectorId) ?? { id: tool.connectorId, name: tool.appName, n: 0 };
    row.n += 1; by.set(tool.connectorId, row);
  }
  return { candidates: [...by.values()].map((row) => ({ id: `server-app:${row.id}`, name: row.name, description: `connected app on the server (${row.n} tools)`, origin: "local" as const })) };
}

/** The three loopback operations of the bridge child (turn-tools/control-server.ts hands them here after its own token and capability checks). */
export async function handleServerAppsOperation(binding: { capabilityId: string; chatId: string; runId: string; permission?: string; unattended?: boolean; admissionCurrent?: () => boolean },
  operation: string, args: Record<string, unknown>, callerGone?: AbortSignal): Promise<unknown> {
  const snap = snapshots.get(binding.capabilityId);
  if (!snap) return refusal("tools_unavailable");
  if (operation === "server_apps_tools") return { tools: snap.list };
  const current = (): boolean => { try { return !binding.admissionCurrent || binding.admissionCurrent(); } catch { return false; } };
  if (!current()) return refusal("tools_unavailable");
  const apps = currentServerApps();
  if (!apps) return refusal("tools_unavailable");
  const reading = operation === "server_apps_status";
  const name = reading ? SERVER_APPS_STATUS_TOOL : typeof args.name === "string" ? args.name : "";
  const tool = snap.byName.get(name);
  if (!tool) return refusal("tool_unknown");
  // The server's declaration decides only the OWNER-TURN rule below (a woken turn reads: the design of the connected apps); it never decides whether the approval window is raised (TR-desktop 4, M2a: only the status tool is a host read).
  const effect = tool.readOnly ? "read" : "effect";
  // Every call: who is calling now, and may they do this (read for the personal agent; a change also needs the turn the owner wrote).
  const denied = await gateServerAppsCall({ chatId: binding.chatId, runId: binding.runId }, effect);
  if (denied) return refusal(denied.reason ?? "not_allowed_for_actor");
  if (reading) {
    const callId = typeof args.callId === "string" && args.callId ? args.callId : undefined;
    const rows = await apps.status(callId);
    return textResult({ jobs: rows.map((row) => ({ callId: row.callId, state: row.state, ...(row.word ? { error: row.word } : {}), ...(row.result !== undefined ? { result: redactToolJson({ result: row.result }).result } : {}) })) });
  }
  const callArgs = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : {};
  // A change goes out with `allowWrite` only when this exact call passed the approval window (harness/host-call-ticket.ts). The window is raised by the proxy,
  // the in-process loop or the tool.call port BEFORE the call reaches the child, so a call with no ticket is a call nobody approved.
  // `callerGone` is the loopback request's own lifetime (the bridge child gave up or ended: its socket closed). It closes the card the owner is still looking at and, after an
  // answer that came too late, keeps the call from leaving: a change nobody is waiting for is never sent (F2; the model was already told "timed out" and would send it again).
  // TR-desktop 4 (M2a): EVERY tool of a server app passes the window (the server's "read" is only its declaration); what it sends is unchanged: a tool the server lists as a read goes out as before, without `allowWrite`.
  let approved = false;
  {
    if (callerGone?.aborted) return refusal("approval_required");
    approved = consumeHostCall(tool.name, callArgs);
    if (!approved) {
      const permission = binding.permission === "write" || binding.permission === "full" ? binding.permission : "read";
      // The owner's card waits as long as the owner takes, the caller's gateway does not: answer inside the call window, the same call asked again joins the card.
      const asked = await approvalWithinCallWindow({ chatId: binding.chatId, tool: tool.name, args: callArgs, permission },
        () => approveHostServerCall({ tool: tool.name, chatId: binding.chatId, permission, unattended: binding.unattended === true, annotations: hostCallMarks(HOST_CALL_SERVER_KEY, tool.name, callArgs) ?? annotationsOf(tool), ...(callerGone ? { signal: callerGone } : {}) }));
      if (!asked.ok && asked.reason === "approval_pending") return textResult({ state: "pending", next: "the owner's approval card is still open; repeat this same call to get the answer, and do not tell the owner it was done" });
      if (!asked.ok) return refusal("approval_required", { approval: asked.text.slice(0, 400) });
      approved = true;
    }
  }
  const allowWrite = approved && !tool.readOnly;
  if (!current()) return refusal("tools_unavailable");
  if (callerGone?.aborted) return refusal("approval_required");
  const out = await apps.call({ connectorId: tool.connectorId, tool: tool.tool, args: callArgs, allowWrite, chatId: binding.chatId });
  // The server road failed: the computer's own road to the same service is then not refused toward it (connectors/route-gate.ts; nothing installed = nothing happens).
  if (!out.ok) noteServerAppFailed(binding.chatId, tool.connectorId);
  return outcomeToResult(out);
}

/** For a gate and for the end of a turn whose config never built: how many bundles are alive. */
export function serverAppsBundleCount(): number { return snapshots.size; }
