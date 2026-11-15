import { classifyAppControlPolicy } from "../app-control/policy";
import { resolveToolCaller, type ToolCaller } from "./tool-caller";

/*
 * The isolation door of every agent tool call. ONE table, ONE decision function.
 *
 * What an agent's tool call may read or write is decided by two facts, never by a name test scattered over handlers:
 *   - the CALLER (harness/tool-caller.ts): the personal agent / an agent / a room member / a guest, read by the host from the capability's chat and run;
 *   - what the OPERATION DECLARES it touches (the tables below): a domain and which of its arguments name the conversation, agent, project or run it
 *     reaches. A new operation follows by declaring itself here; an operation with no declaration is the personal agent's, on a turn the owner wrote.
 *
 * Domains and who passes (/ / / 1 and 2):
 *   shared          the product's own machinery, nothing of any principal's private substance: personal, agent, member
 *   owner-wide      what spans the owner's things (all conversations, all projects, the owner's profile, mail, personal sources): the personal agent only
 *   personal-memory the personal agent's Personal memory (oneMemory.*): the personal agent's own conversation only
 *   own-chat        a conversation the call names: the caller's own conversations (itself and its parents up to a personal agent's); the personal agent any
 *   own-project     the caller's own project; the personal agent any
 *   own-run         the caller's own run
 *   agent-memory-read / agent-home-read   one agent's memory body or home: that agent itself; the personal agent only on an owner-written turn (PERSONAL_OTHER_AGENT_READ)
 *   agent-memory-write                    that agent itself only, nobody else, not even the personal agent: its memory is written in its own turns
 *   agent-home-write                      that agent itself; the personal agent on an owner-written turn (PERSONAL_OTHER_AGENT_HOME_WRITE); a memory file is agent-memory-write
 *   agent-admin     installing, removing, seating, publishing agents: reads pass like shared, changes are the personal agent's
 *   owner-config    settings, runtimes, tool servers, devices: reads pass like shared, changes are the personal agent's
 * A guest passes nothing here: a guest has no app control (1, the guest row). The owner's own screen (chat "ui") is not gated: it is the owner's click.
 * A destructive or consent operation of the personal agent needs the turn the owner wrote (the description of one_app_call says so): `owner_turn_required`.
 *
 * Refusals are closed words, never an empty result: `not_allowed_for_actor` (this caller may not reach this), `owner_turn_required` (the personal agent
 * may, on a turn the owner wrote). The turn is never stopped by a refusal.
 */

/** The rows an owner may still change here ("shown on one line, so the owner can flip it"): the personal agent managing another agent. */
export const PERSONAL_OTHER_AGENT_READ: "owner-turn" | "never" = "owner-turn";
export const PERSONAL_OTHER_AGENT_HOME_WRITE: "owner-turn" | "never" = "owner-turn";

export type AccessDomain =
  | "shared" | "owner-wide" | "personal-memory" | "own-chat" | "own-project" | "own-run"
  | "agent-memory-read" | "agent-memory-write" | "agent-home-read" | "agent-home-write" | "agent-admin" | "owner-config";

export interface AccessDeclaration {
  domain: AccessDomain;
  /** Argument paths ("agentId", "input.agentId") naming the conversation / agent / project / run the call reaches. A list value is every one of them. */
  chat?: readonly string[];
  agent?: readonly string[];
  project?: readonly string[];
  run?: readonly string[];
  /** The argument that is a path inside an agent's home: a memory file there is agent memory, whatever domain the operation is declared in. */
  path?: string;
  /** For a harness port, which kind of act it is (an app operation takes it from the app-control policy). Absent: read for own-chat and shared, write otherwise. */
  effect?: "read" | "write" | "destructive" | "consent";
}

export type AccessRefusalReason = "not_allowed_for_actor" | "owner_turn_required";
export interface AccessVerdict { ok: boolean; reason?: AccessRefusalReason; why?: string }

const D = (domain: AccessDomain, more: Omit<AccessDeclaration, "domain"> = {}): AccessDeclaration => ({ domain, ...more });
const CHAT_ID = ["id", "chatId", "threadId", "input.chatId", "input.id"] as const;
const AGENT_ID = ["agentId", "input.agentId"] as const;
const PROJECT_ID = ["id", "projectId", "input.projectId", "input.id"] as const;

/** First match wins. Exact paths before families. Every operation of the app-control catalog is covered by a row here or is "undeclared". */
const APP_OPERATION_RULES: ReadonlyArray<readonly [RegExp, AccessDeclaration]> = [
  // ── the personal agent's own memory and what spans the owner's things ──
  [/^oneMemory\./, D("personal-memory")],
  [/^(oneProfile|memoryDreaming|oneSearch)\./, D("owner-wide")],
  // The harness re-entry (app.call -> harness.call) runs a port under the app-control scope, which is no conversation: only the personal agent may use it.
  [/^harness\.(call|describe|search)$/, D("owner-wide")],
  [/^(oneBriefing|oneSuggestions|oneExperienceReuse|oneWeeklyReflection|oneAutoRecovery|oneImprovementProof|oneValueClosure|oneActivation|oneFeatureIntro|oneRequestIntent|oneHubDerivative|oneCapabilities|oneArtifacts|oneAttachments|oneFront|oneHome|oneVault|oneProvider|onePersonalData|oneSupervisor|oneHarness|oneWindow|oneContext|oneTeamPreflight)\./, D("owner-wide")],
  [/^oneDiscussion\.(setEnabled|stop|post)$/, D("owner-wide")],
  [/^(agentMail|telegram|mobileBridge|usage|billing)\./, D("owner-wide")],
  // ── one agent's memory and home ──
  [/^agentMemory\.skippedStores$/, D("owner-wide")],
  [/^agentMemory\.importApply$/, D("agent-memory-write", { agent: AGENT_ID, path: "sourcePath" })],
  [/^agentMemory\./, D("agent-memory-read", { agent: AGENT_ID })],
  [/^agentLearning\./, D("agent-memory-read", { agent: AGENT_ID })],
  [/^agentWorkspace\.memoryCounts$/, D("agent-memory-read", { agent: ["agentIds"] })],
  [/^agentFiles\.write$/, D("agent-home-write", { agent: AGENT_ID, path: "absPath" })],
  [/^agentFiles\./, D("agent-home-read", { agent: AGENT_ID, path: "absPath" })],
  // A diff is named by its proposal, not by an agent: only the personal agent (owner turn) reads it.
  [/^agentWorkspace\.getDiff$/, D("agent-home-read")],
  [/^agentWorkspace\.(getAppearance|readAppearance|getWorkspace|listFiles|compare|getRecoveryDiff)$/, D("agent-home-read", { agent: AGENT_ID })],
  [/^agentWorkspace\.readFile$/, D("agent-home-read", { agent: AGENT_ID, path: "relativePath" })],
  [/^agentWorkspace\./, D("agent-home-write", { agent: AGENT_ID })],
  [/^agentEvolution\.list$/, D("agent-home-read", { agent: AGENT_ID })],
  [/^agentEvolution\./, D("agent-admin")],
  // ── conversations ──
  [/^chats\.(listRecent|listRecentOne|listArchived|listByFirm|create|openOneMember|appendOneUserMessage)$/, D("owner-wide")],
  [/^chats\.listByProject$/, D("own-project", { project: PROJECT_ID })],
  [/^chats\./, D("own-chat", { chat: CHAT_ID })],
  [/^runLedger\.(events|outputsAfter|settleRowsAfter)$/, D("own-run", { run: ["runId"] })],
  [/^runLedger\.chatTimeline$/, D("own-chat", { chat: ["chatId", "input.chatId"] })],
  [/^runLedger\./, D("owner-wide")],
  [/^goalPanel\.edit$/, D("own-chat", { chat: ["request.chatId"] })],
  [/^(tasks\.(forChat|findForChat)|seats\.(forChat|historyForChat)|goalPanel\.(view|shape)|officeTaskContext\.(get|clear|submit)|oneDiscussion\.state|harness\.uiList)$/, D("own-chat", { chat: ["chatId", "input.chatId"] })],
  [/^workspace\.(get|set|setFromProject)$/, D("own-chat", { chat: ["chatId"] })],
  [/^tasks\./, D("owner-wide")],
  // ── projects ──
  [/^projects\.(list|create|createFromWorkspace|connectGithub)$/, D("owner-wide")],
  [/^projects\./, D("own-project", { project: PROJECT_ID })],
  [/^ontology\./, D("own-project", { project: ["projectId"] })],
  // ── agent administration and owner configuration ──
  // The rooms an agent sits in name the conversations and projects of that agent: its own, or the personal agent's on the owner's turn.
  [/^agents\.rooms$/, D("agent-home-read", { agent: AGENT_ID })],
  [/^agents\.roomStats$/, D("owner-wide")],
  [/^(agents|team|firms|oneOrg|oneTaskforces|cloudAgents|archive|agentLeases|metaAgent|orgSeat|seats|externalCliSessions|agentRuntime)\./, D("agent-admin")],
  [/^(config|runtime|mcpTools|localModelHub|localModelMigration|migration|openCrab|app|menu|updater|launchd|getDaemonAutostart|setDaemonAutostart|interview|runAlerts|sdk|system|support|hephaestus|workspace|attention|confirm|runtimeFiles|agi|usage)\b/, D("owner-config")],
  // ── the product's own machinery ──
  [/^(science|site|appFactory|browser|browserUi|browserAnnotation|toolFactory|pluginBuilder|surfaceAssets|surfaces|multimodal|media|marketplace|promptHub|toolchains|document|liveDocument|fs|schedule|productExtensions|workLiveView|computerUse|computerHistory|reach|automations|judgment|experience|skills|invoke|env|secrets|auth|credentialRecovery|browserAutofill|browserProfileImport|getToolApprovalResolution|listToolApprovals|listSettledToolApprovals|listAlwaysApprovedChats|listCapabilityGrants|resolveToolApproval|grantChatAlwaysApproval|revokeChatAlwaysApproval|revokeCapabilityGrant)\b/, D("shared")],
];

/** Harness ports (callHarnessPort) that reach another principal's things or the owner's configuration. A port not named here is the product's own machinery. */
const PORT_RULES: ReadonlyArray<readonly [RegExp, AccessDeclaration]> = [
  [/^thread\.list$/, D("owner-wide")],
  [/^(thread\.read|turn\.status|turn\.interrupt|turn\.start|turn\.capability\.request|effects\.uncertain|telemetry\.summary|outputs\.list)$/, D("own-chat", { chat: ["threadId", "chatId"] })],
  [/^agent\.uninstall$/, D("agent-admin", { effect: "destructive" })],
  [/^(app\.operations)$/, D("shared")],
];

/** The ports a guest never reaches: app control, another conversation's things, agent administration. (Keys, installs and sign-in stay with their own owner-only handlers and cards.) */
const GUEST_DENIED_PORT_FAMILIES: readonly string[] = ["app.call", "thread.", "turn.", "effects.", "telemetry.", "outputs.", "agent.uninstall"];

export function appOperationDeclaration(operation: string): AccessDeclaration | null {
  for (const [pattern, declaration] of APP_OPERATION_RULES) if (pattern.test(operation)) return declaration;
  return null;
}
export function portDeclaration(operationId: string): AccessDeclaration | null {
  for (const [pattern, declaration] of PORT_RULES) if (pattern.test(operationId)) return declaration;
  return null;
}

/* ── the decision ─────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

type Effect = "read" | "write" | "destructive" | "consent";

function valuesAt(args: Record<string, unknown>, paths: readonly string[] | undefined): string[] | null {
  if (!paths) return null;
  const found: string[] = [];
  for (const dotted of paths) {
    let node: unknown = args;
    for (const key of dotted.split(".")) node = node && typeof node === "object" && !Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined;
    if (typeof node === "string" && node.trim()) found.push(node.trim());
    else if (Array.isArray(node)) for (const item of node) if (typeof item === "string" && item.trim()) found.push(item.trim());
  }
  return found;
}

/** A path inside an agent's home that is its memory: a memory.md / MEMORY.md, or anything under a `memory` folder of the agent's local store. */
export function isAgentMemoryPath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)memory\.md$/.test(normalized)) return true;
  return /(^|\/)\.agentlas-local\/memory(\/|$)/.test(normalized) || /(^|\/)memory\/o-[0-9a-f]{16}(\/|$)/.test(normalized);
}

function allWithin(targets: string[] | null, allowed: readonly string[]): boolean {
  return targets !== null && targets.length > 0 && targets.every((target) => allowed.includes(target));
}

const refuse = (reason: AccessRefusalReason, why: string): AccessVerdict => ({ ok: false, reason, why });
const pass: AccessVerdict = { ok: true };

/**
 * May this caller do this operation with these arguments. `effect` is the app-control policy's class for an app operation (a port passes "write" for
 * a declared change and "read" for a read); the personal agent's destructive or consent operation needs the owner's turn.
 */
export function decideAccess(caller: ToolCaller, declaration: AccessDeclaration | null, args: Record<string, unknown>, effect: Effect): AccessVerdict {
  if (caller.kind === "owner-surface") return pass;
  if (caller.kind === "guest") return refuse("not_allowed_for_actor", `guest:${caller.basis}`);
  const personal = caller.kind === "personal";
  const ownerTurn = personal && caller.ownerTurn;
  // An operation nobody declared: the personal agent, on a turn the owner wrote.
  if (!declaration) return personal ? (ownerTurn ? pass : refuse("owner_turn_required", "undeclared")) : refuse("not_allowed_for_actor", "undeclared");
  const changes = effect !== "read";
  const needsOwner = personal && (effect === "destructive" || effect === "consent") && !ownerTurn;
  const owner = (why: string): AccessVerdict => needsOwner ? refuse("owner_turn_required", why) : pass;
  const self = caller.agentId ? [caller.agentId] : [];
  switch (declaration.domain) {
    case "shared": return owner("shared");
    case "owner-wide": return personal ? owner("owner-wide") : refuse("not_allowed_for_actor", "owner-wide");
    case "personal-memory": return personal ? owner("personal-memory") : refuse("not_allowed_for_actor", "personal-memory");
    case "agent-admin":
    case "owner-config":
      if (!changes) return pass;
      return personal ? owner(declaration.domain) : refuse("not_allowed_for_actor", declaration.domain);
    case "own-chat": {
      if (personal) return owner("own-chat");
      return allWithin(valuesAt(args, declaration.chat), caller.family) ? pass : refuse("not_allowed_for_actor", "other-conversation");
    }
    case "own-project": {
      if (personal) return owner("own-project");
      return caller.projectId && allWithin(valuesAt(args, declaration.project), [caller.projectId]) ? pass : refuse("not_allowed_for_actor", "other-project");
    }
    case "own-run": {
      if (personal) return owner("own-run");
      return allWithin(valuesAt(args, declaration.run), [caller.runId]) ? pass : refuse("not_allowed_for_actor", "other-run");
    }
    case "agent-memory-read":
    case "agent-memory-write":
    case "agent-home-read":
    case "agent-home-write": {
      const targets = valuesAt(args, declaration.agent);
      const mine = allWithin(targets, self);
      const memoryDomain = declaration.domain === "agent-memory-read" || declaration.domain === "agent-memory-write";
      const writes = declaration.domain === "agent-memory-write" || declaration.domain === "agent-home-write";
      // A memory file inside an agent's home is that agent's memory: it is written by nobody else, whatever operation reaches it.
      const memoryFile = declaration.path ? (valuesAt(args, [declaration.path]) ?? []).some(isAgentMemoryPath) : false;
      const asMemory = memoryDomain || memoryFile;
      if (mine) return pass;
      if (writes && asMemory) return refuse("not_allowed_for_actor", "other-agent-memory-write");
      if (!personal) return refuse("not_allowed_for_actor", writes ? "other-agent-home-write" : "other-agent");
      const rule = writes ? PERSONAL_OTHER_AGENT_HOME_WRITE : PERSONAL_OTHER_AGENT_READ;
      if (rule === "never") return refuse("not_allowed_for_actor", "other-agent");
      return ownerTurn ? pass : refuse("owner_turn_required", "other-agent");
    }
  }
}

/** The effect class of an app operation by the app-control policy; an operation the policy does not allow is the policy's to refuse (the gate then passes it on). */
function appEffect(operation: string): { allowed: boolean; effect: Effect } {
  try {
    const policy = classifyAppControlPolicy({ path: operation }).policy;
    return policy.allowed ? { allowed: true, effect: policy.effect } : { allowed: false, effect: "write" };
  } catch { return { allowed: true, effect: "write" }; }
}

export interface IsolationCaller { chatId: string; runId: string }

/** Gate for one app-control operation reached by an agent (harness app.call, one_app_call). Returns null when the call may go on. */
export async function gateAppOperation(caller: IsolationCaller, operation: string, args: Record<string, unknown>): Promise<AccessVerdict | null> {
  const who = await resolveToolCaller(caller);
  if (who.kind === "owner-surface") return null;
  const { allowed, effect } = appEffect(operation);
  // The policy refuses an operation it does not allow with its own reason; but a guest never gets that far.
  if (!allowed && who.kind !== "guest") return null;
  const verdict = decideAccess(who, appOperationDeclaration(operation), args, effect);
  return verdict.ok ? null : verdict;
}

/** Gate for one harness port. A port that reaches only the product's own machinery passes without resolving anyone (no cost on the common call). */
export async function gateHarnessPort(operationId: string, args: Record<string, unknown>, caller: IsolationCaller): Promise<AccessVerdict | null> {
  const declaration = portDeclaration(operationId);
  const guestDenied = GUEST_DENIED_PORT_FAMILIES.some((family) => operationId.startsWith(family));
  if (!declaration && !guestDenied) return null;
  const who = await resolveToolCaller(caller);
  if (who.kind === "owner-surface") return null;
  if (who.kind === "guest") return guestDenied || declaration ? refuse("not_allowed_for_actor", `guest:${who.basis}`) : null;
  if (!declaration) return null;
  const verdict = decideAccess(who, declaration, args, declaration.effect ?? (declaration.domain === "own-chat" || declaration.domain === "shared" ? "read" : "write"));
  return verdict.ok ? null : verdict;
}

/*
 * DD (Agentlas 2.0): the connected apps the person attached on the phone, whose keys live in the server's vault (contracts/desktop-server-tools.md section 6).
 * They are the personal agent's own, in its own conversation: the same rule as `owner-wide` for everything they reach, and a change to such an app also needs the turn the
 * owner wrote (a woken turn reads only - the server's own scheduled turns follow the same rule). No other caller gets them: a work agent, a project room, a room member, a
 * Hub agent, a borrowed node, a call with no conversation. Refusals are the closed words above; the turn is never stopped by one.
 */
export function decideServerAppsAccess(caller: ToolCaller, effect: "read" | "effect"): AccessVerdict {
  if (caller.kind !== "personal") return refuse("not_allowed_for_actor", `server-apps:${caller.kind}`);
  if (effect === "effect" && !caller.ownerTurn) return refuse("owner_turn_required", "server-apps");
  return pass;
}

/** The same decision for a capability's chat and run: the caller is read again for EVERY call (a bundle that was minted for the personal agent is never trusted later). */
export async function gateServerAppsCall(caller: IsolationCaller, effect: "read" | "effect"): Promise<AccessVerdict | null> {
  const who = await resolveToolCaller(caller);
  const verdict = decideServerAppsAccess(who, effect);
  return verdict.ok ? null : verdict;
}

export const ISOLATION_REFUSAL_NEXT: Readonly<Record<AccessRefusalReason, string>> = {
  not_allowed_for_actor: "this conversation may not do that; it can work with its own conversation, project and memory; the owner can ask the personal agent or use the app's own screen",
  owner_turn_required: "this needs a turn the owner wrote; ask the owner in your reply and do it on their next message",
};
