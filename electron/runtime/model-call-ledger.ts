/*
 * Model-call ledger (context-reduction plan C01, "measure before reducing").
 *
 * One durable run event (`model_call_ledger`) per real provider attempt a user turn causes, whatever the role
 * (main, planner, worker, synthesis, judgment, curator, repair ...). It links userTurn / run / call / attempt and
 * carries (a) the runtime identity, (b) a payload block ledger estimated from the request the adapter actually
 * assembled, and (c) the provider-observed usage.
 *
 * Observability only: nothing here changes a prompt, an admission digest or a dispatch. The wrapper passes the
 * same request through and observes events; every failure to record is swallowed.
 *
 * Rules the stored payload obeys:
 *  - sizes, ids, enums and digests only. Prompt text is estimated locally and dropped from the payload; the
 *    host-authored blocks' originals go to the content-addressed retention store keyed by the same digest
 *    (context-originals.ts) so a past request can be read back exactly (notyet NH18).
 *  - unknown stays unknown. A block the adapter cannot see (a resumed CLI thread keeps its system prompt, tools and
 *    history inside the provider session) is listed in `unknownBlocks` and its key is absent; usage the provider did
 *    not report is absent with `usageStatus: "unknown"`. Neither is ever written as 0.
 *  - `observedInput` is the LOGICAL input of the call: for OpenAI/Codex the cached part is a subset of it, for
 *    Anthropic the adapters already add raw input + cache read + cache creation. `observedCachedInput` is the
 *    subset served from cache; it is never added to input again.
 */
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { estimateTextTokens, TOKEN_ESTIMATE_REVISION } from "./token-estimate";
import { normalizeProviderUsage, type UsageDialect } from "../../shared/observed-usage";
import { cacheLedgerFields, type CachePlan } from "./cache-planner";
import { tryRecordRunEvent } from "../store/run-events";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { withMemorySourceScope } from "../memory/source-custody";
import { RETAINED_CONTEXT_BLOCKS, retainContextOriginal } from "./context-originals";
import { looksSecret } from "../../shared/secret-patterns";
import { currentAccountedRun } from "../long-run/accounting-context";

export const MODEL_CALL_LEDGER_SCHEMA = "agentlas.model-call-ledger.v1";
export const MODEL_CALL_LEDGER_EVENT_KIND = "model_call_ledger";

/** Same per-image upper estimate the serving admission uses (agentlas-serving.ts IMAGE_TOKEN_ESTIMATE). */
export const LEDGER_IMAGE_TOKEN_ESTIMATE = 2_000;

/**
 * Runtimes whose one ledger row is a whole CLI turn: the usage they report adds up every internal model request of the
 * turn's tool loop (codex `turn.completed`, claude-code `result.usage`; measured 2026-10-16: main rows of 1.7M-132M input
 * against a 475k window). That sum is the turn's cost, not the window the next request starts from, so the row carries
 * `usageScope: "turn_aggregate"` and the window comes from `observedContextInput` (the LAST single request), never from
 * `observedInput`. API and local-loop runtimes record one row per HTTP dispatch, so their `observedInput` is one request.
 */
export const TURN_AGGREGATE_USAGE_RUNTIMES: ReadonlySet<string> = new Set(["codex", "claude-code"]);

export type ModelCallRole =
  | "main" | "planner" | "worker" | "synthesis" | "judgment" | "observation"
  | "curator" | "repair" | "compaction" | "router" | "build" | "unscoped";
export type ModelCallMode = "fresh" | "resume" | "reopen" | "stateless" | "unknown";
export type PayloadSource = "adapter-final" | "request" | "unknown";
export type LedgerHostTurn = "output_limit_continuation" | "context_overflow_continuation";
export type BlockName = "instructions" | "tools" | "history" | "hostContext" | "attachments" | "ownerText" | "toolExchanges" | "framing";
const BLOCK_NAMES: readonly BlockName[] = ["instructions", "tools", "history", "hostContext", "attachments", "ownerText", "toolExchanges", "framing"];

export interface PayloadLedger {
  mode: ModelCallMode;
  source: PayloadSource;
  /** Where the framed per-turn host context travelled, when the adapter knows. */
  placement?: string;
  /** A host-authored turn of this call, not the owner's request (an output-limit or context-overflow continuation). */
  hostTurn?: LedgerHostTurn;
  /** Typed reason this attempt ran on a fallback transport (codex exec after the app-server path refused or failed). */
  transportFallback?: string;
  /** Estimated tokens of what was transmitted for each block. null = the adapter cannot see it. */
  blocks: Record<BlockName, number | null>;
  toolsCount: number | null;
  attachmentsCount: number | null;
  /** Independent estimate of the whole serialized request, for a block-sum sanity check. */
  wholeEstimate: number | null;
  /** G15: per-block content digest + UTF-8 bytes of what was transmitted. Digest and size only, never text.
   * ownerText has no digest (short, guessable); an unseen block is simply absent. */
  blockDigests?: Partial<Record<BlockName, { digest?: string; bytes: number }>>;
}

/** Truncated sha256 of a block's text plus its UTF-8 size. The text itself is dropped by the caller. */
export function digestBlock(text: string | null | undefined, withDigest = true): { digest?: string; bytes: number } | undefined {
  if (text == null) return undefined;
  return { ...(withDigest && text ? { digest: createHash("sha256").update(text).digest("hex").slice(0, 16) } : {}),
    bytes: Buffer.byteLength(text, "utf8") };
}
function digestsOf(entries: Partial<Record<BlockName, string | null | undefined>>): PayloadLedger["blockDigests"] {
  const out: NonNullable<PayloadLedger["blockDigests"]> = {};
  for (const [name, text] of Object.entries(entries) as Array<[BlockName, string | null | undefined]>) {
    const value = digestBlock(text, name !== "ownerText");
    if (value) out[name] = value;
    if (value?.digest && RETAINED_CONTEXT_BLOCKS.includes(name)) retainContextOriginal(value.digest, text);
  }
  return out;
}

export interface ModelCallScope {
  runId?: string;
  chatId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  /** The owner turn this call serves. Defaults to the run id. */
  userTurnId?: string;
  callRef?: string;
  role?: ModelCallRole;
  phase?: string;
}

const scopes = new AsyncLocalStorage<ModelCallScope>();

/** Bind identity and role for every model call made inside `fn`. Inner scopes override outer ones field by field. */
export function withModelCallScope<T>(scope: ModelCallScope, fn: () => T): T {
  const parent = scopes.getStore();
  const merged: ModelCallScope = { ...parent };
  for (const [key, value] of Object.entries(scope)) if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  return withMemorySourceScope(scope, () => scopes.run(merged, fn));
}
export function currentModelCallScope(): ModelCallScope | undefined { return scopes.getStore(); }

/**
 * The run a ledger row (or a native-compaction row) belongs to: the model-call scope's run, else the run the inference
 * is accounted to, else the unscoped bucket. Background judgments, AGI and scheduler classifications ran inside an
 * accounting scope that names their run and were still written as `model-call-unscoped:none` (flow audit ID-5,
 * production 10-12..10-18: 5,556 rows).
 */
export function modelCallRunIdentity(scope: ModelCallScope | undefined, requestChatId?: string | null): {
  runId: string; chatId: string | null; nodeId: string | null; automationId: string | null; scoped: boolean } {
  if (scope?.runId) return { runId: scope.runId, chatId: scope.chatId ?? requestChatId ?? null, nodeId: scope.nodeId ?? null,
    automationId: null, scoped: true };
  let accounted: ReturnType<typeof currentAccountedRun> = null;
  try { accounted = currentAccountedRun(); } catch { accounted = null; }
  if (accounted) return { runId: accounted.runId, chatId: scope?.chatId ?? accounted.chatId ?? requestChatId ?? null,
    nodeId: scope?.nodeId ?? accounted.nodeId ?? null, automationId: accounted.automationId ?? null, scoped: true };
  const chatId = scope?.chatId ?? requestChatId ?? null;
  return { runId: `model-call-unscoped:${chatId ?? "none"}`, chatId, nodeId: scope?.nodeId ?? null, automationId: null, scoped: false };
}

/** Task-force phase names (observeTaskForceModelCall) to ledger roles. */
export function roleForTaskForcePhase(phase: string): ModelCallRole {
  if (/plan/.test(phase) && !/synthes/.test(phase)) return "planner";
  if (/synthes/.test(phase)) return "synthesis";
  if (/worker|escalation/.test(phase)) return "worker";
  if (/verif|review|judg/.test(phase)) return "judgment";
  return "worker";
}

const tokens = (text: string | null | undefined): number => (text ? estimateTextTokens(text) : 0);

/** Strip base64 media before measuring text: images are counted per image, never by their encoding length. */
function mediaFreeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (key, item) => {
      if (typeof item === "string" && (item.startsWith("data:") || (key === "data" && item.length > 2_000))) return "";
      return item;
    }) ?? "";
  } catch { return ""; }
}

function emptyBlocks(): Record<BlockName, number | null> {
  return { instructions: null, tools: null, history: null, hostContext: null, attachments: null, ownerText: null, toolExchanges: null, framing: null };
}

export function blockSum(blocks: Record<BlockName, number | null>): number {
  return BLOCK_NAMES.reduce((sum, name) => sum + (blocks[name] ?? 0), 0);
}

/**
 * Payload an adapter reports from text it is about to transmit. Texts are measured and dropped.
 * Omit a field (or pass undefined) when the adapter cannot see that block: it is recorded as unknown.
 * Pass "" / 0 only when the block is genuinely absent from the payload.
 */
export interface ReportedPayload {
  mode: ModelCallMode;
  placement?: string;
  instructions?: string | null;
  tools?: { count: number; text: string } | null;
  history?: string | null;
  hostContext?: string | null;
  ownerText?: string | null;
  toolExchanges?: string | null;
  attachments?: { count: number; tokens?: number } | null;
  /** Everything the adapter transmitted as one text, for the framing residual and the whole-request cross-check. */
  wholeText?: string | null;
  /** The part of wholeText that rides in the same message as host context/owner text (the user side). */
  userSideText?: string | null;
}

export function ledgerFromReport(report: ReportedPayload): PayloadLedger {
  const blocks = emptyBlocks();
  if (report.instructions != null) blocks.instructions = tokens(report.instructions);
  if (report.tools != null) blocks.tools = tokens(report.tools.text);
  if (report.history != null) blocks.history = tokens(report.history);
  if (report.hostContext != null) blocks.hostContext = tokens(report.hostContext);
  if (report.ownerText != null) blocks.ownerText = tokens(report.ownerText);
  if (report.toolExchanges != null) blocks.toolExchanges = tokens(report.toolExchanges);
  if (report.attachments != null) {
    blocks.attachments = report.attachments.tokens ?? report.attachments.count * LEDGER_IMAGE_TOKEN_ESTIMATE;
  }
  const whole = report.wholeText != null ? tokens(report.wholeText) : null;
  // Residual framing (wrappers, headings, JSON punctuation) only when the adapter gave us the whole text to compare to.
  if (whole !== null) {
    const known = blockSum({ ...blocks, framing: null }) - (blocks.attachments ?? 0);
    blocks.framing = Math.max(0, whole - known);
  }
  return {
    mode: report.mode, source: "adapter-final", ...(report.placement ? { placement: report.placement } : {}),
    blocks, toolsCount: report.tools ? report.tools.count : null,
    attachmentsCount: report.attachments ? report.attachments.count : null,
    wholeEstimate: whole === null ? null : whole + (blocks.attachments ?? 0),
    blockDigests: digestsOf({ instructions: report.instructions, tools: report.tools?.text, history: report.history,
      hostContext: report.hostContext, ownerText: report.ownerText, toolExchanges: report.toolExchanges }),
  };
}

/** Analyse the JSON body a stateless host loop (serving, BYOK, local) is about to POST. */
export function ledgerFromApiBody(body: unknown, hints: {
  /** RunnerRequest.ledgerHints: sizes of the host context / owner text before placement folded them in. */
  ledgerHints?: RunnerRequest["ledgerHints"]; imageCount?: number; mode?: ModelCallMode;
}): PayloadLedger {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const messages = Array.isArray(record.messages) ? record.messages as unknown[] : Array.isArray(record.contents) ? record.contents as unknown[] : [];
  const roleOf = (message: unknown): string => String((message as { role?: unknown })?.role ?? "");
  const isToolMessage = (message: unknown): boolean => {
    const entry = message as { role?: unknown; content?: unknown; parts?: unknown; tool_calls?: unknown } | null;
    if (!entry) return false;
    if (entry.role === "tool" || entry.tool_calls) return true;
    const parts = Array.isArray(entry.content) ? entry.content : Array.isArray(entry.parts) ? entry.parts : null;
    return parts !== null && parts.some((part) => {
      if (part && typeof part === "object" && ("functionCall" in part || "functionResponse" in part)) return true;
      const type = (part as { type?: unknown })?.type;
      return type === "tool_use" || type === "tool_result" || type === "functionCall" || type === "functionResponse";
    });
  };
  const systemParts: string[] = [];
  if (record.system !== undefined) systemParts.push(mediaFreeJson(record.system));
  if (record.systemInstruction !== undefined) systemParts.push(mediaFreeJson(record.systemInstruction));
  const conversation: unknown[] = [];
  for (const message of messages) {
    if (roleOf(message) === "system" || roleOf(message) === "developer") systemParts.push(mediaFreeJson(message));
    else conversation.push(message);
  }
  // The current user message is the last plain (non-tool) user message.
  let currentIndex = -1;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (roleOf(conversation[index]) === "user" && !isToolMessage(conversation[index])) { currentIndex = index; break; }
  }
  const history = currentIndex < 0 ? [] : conversation.slice(0, currentIndex).filter((m) => !isToolMessage(m));
  const toolMessages = conversation.filter(isToolMessage);
  const tail = currentIndex < 0 ? [] : conversation.slice(currentIndex + 1).filter((m) => !isToolMessage(m));
  const current = currentIndex < 0 ? null : conversation[currentIndex];
  const tools = Array.isArray(record.tools) ? record.tools : null;
  const toolCount = tools === null ? 0 : tools.reduce<number>((sum, entry) => {
    const declarations = (entry as { functionDeclarations?: unknown } | null)?.functionDeclarations;
    return sum + (Array.isArray(declarations) ? declarations.length : 1);
  }, 0);
  const toolExchangeText = [record.toolExchanges !== undefined ? mediaFreeJson(record.toolExchanges) : "",
    ...toolMessages.map(mediaFreeJson), ...tail.map(mediaFreeJson)].filter(Boolean).join("");

  const blocks = emptyBlocks();
  const imageCount = hints.imageCount ?? 0;
  const instructionTokens = tokens(systemParts.join(""));
  const currentTokens = tokens(current ? mediaFreeJson(current) : "");
  blocks.tools = tools ? tokens(mediaFreeJson(tools)) : 0;
  blocks.history = tokens(history.map(mediaFreeJson).join(""));
  blocks.toolExchanges = tokens(toolExchangeText);
  blocks.attachments = imageCount * LEDGER_IMAGE_TOKEN_ESTIMATE;
  const given = hints.ledgerHints;
  let instructionOriginal: string | null = systemParts.join("");
  let hostOriginal: string | undefined;
  let placement: string | undefined;
  if (given) {
    placement = given.hostContextPlacement;
    // Host context rides in the user message or the system tail; take it from where the host put it so the block
    // sum keeps matching the request. The owner text is always in the current user message.
    const host = given.hostContextTokens;
    const inUser = given.hostContextPlacement === "user-message";
    const hostInUser = inUser ? Math.min(host, currentTokens) : 0;
    const hostInSystem = inUser ? 0 : Math.min(host, instructionTokens);
    blocks.hostContext = hostInUser + hostInSystem;
    blocks.instructions = Math.max(0, instructionTokens - hostInSystem);
    blocks.ownerText = Math.min(given.ownerTextTokens, Math.max(0, currentTokens - hostInUser));
    blocks.framing = Math.max(0, currentTokens - hostInUser - blocks.ownerText);
    // Token counts alone cannot identify a source span. Accept custody only when the exact transient host text
    // occurs once in its final JSON string content. Never retain a larger system block under a smaller item count.
    if (!inUser && hostInSystem > 0) instructionOriginal = null;
    const text = given.hostContextText;
    if (typeof text === "string" && text.length > 0) {
      const encoded = JSON.stringify(text).slice(1, -1);
      const parent = inUser ? (current ? mediaFreeJson(current) : "") : systemParts.join("");
      const at = parent.indexOf(encoded);
      if (at >= 0 && parent.indexOf(encoded, at + encoded.length) < 0) {
        hostOriginal = text;
        blocks.hostContext = tokens(text);
        if (!inUser) {
          instructionOriginal = parent.slice(0, at) + parent.slice(at + encoded.length);
          blocks.instructions = tokens(instructionOriginal);
        }
        blocks.framing = Math.max(0, currentTokens - (inUser ? blocks.hostContext : 0) - blocks.ownerText);
      }
    }
  } else {
    // No host split available (non-main calls): the whole current message is the owner-side text.
    blocks.instructions = instructionTokens;
    blocks.ownerText = currentTokens;
    blocks.hostContext = null;
    blocks.framing = 0;
  }
  return {
    mode: hints.mode ?? "stateless", source: "adapter-final", ...(placement ? { placement } : {}),
    blocks, toolsCount: toolCount, attachmentsCount: imageCount,
    wholeEstimate: tokens(mediaFreeJson(body)) + blocks.attachments,
    blockDigests: digestsOf({ instructions: instructionOriginal, hostContext: hostOriginal, tools: tools ? mediaFreeJson(tools) : "",
      history: history.map(mediaFreeJson).join(""), toolExchanges: toolExchangeText,
      ownerText: current ? mediaFreeJson(current) : "" }),
  };
}

/**
 * CLI adapters (Codex exec/app-server, Claude Code) hand the CLI one text plus, sometimes, a separate system file or
 * developer-instructions field. Their tool definitions live inside the CLI/MCP servers and a resumed thread keeps
 * its earlier system prompt, history and tools inside the provider session: those blocks stay unknown (null).
 *
 * `instructionsInSentText` is true when the system prompt is embedded in `sentText` (Codex exec seed); its size is
 * then the residual of the sent text after history, host context and owner text, so it includes the adapter's own
 * wrapper and section headings.
 */
export function ledgerFromCliSent(input: {
  mode: ModelCallMode; sentText: string; req: RunnerRequest;
  systemText?: string | null; instructionsInSentText?: boolean; historyInSentText?: boolean;
  hostContextText?: string; placement?: string;
  /** The host context was appended to systemText (Claude fresh seed) rather than sent in sentText. */
  hostContextInSystem?: boolean;
  hostTurn?: LedgerHostTurn; transportFallback?: string;
}): PayloadLedger {
  const { req } = input;
  const sent = tokens(input.sentText);
  const owner = Math.min(tokens(req.userPrompt), sent);
  const blocks = emptyBlocks();
  blocks.ownerText = owner;
  blocks.framing = 0;
  blocks.attachments = (req.images?.length ?? 0) * LEDGER_IMAGE_TOKEN_ESTIMATE;
  // Tool definitions and the CLI's own tool exchanges live inside the CLI/provider session: toolExchanges and tools stay null.
  if (input.historyInSentText) {
    const history = tokens(req.history.map((row) => row.text).join("\n"));
    const host = tokens(input.hostContextText ?? req.turnContext);
    blocks.history = history;
    blocks.hostContext = host;
    if (input.instructionsInSentText) blocks.instructions = Math.max(0, sent - owner - history - host);
    else if (input.hostContextInSystem && input.systemText != null) {
      blocks.instructions = Math.max(0, tokens(input.systemText) - host);
      blocks.framing = Math.max(0, sent - owner - history);
    } else { blocks.instructions = input.systemText != null ? tokens(input.systemText) : null; blocks.framing = Math.max(0, sent - owner - history - host); }
  } else {
    // Delta turn: whatever is sent beyond the owner text is host context, gap replay and framing.
    blocks.hostContext = Math.max(0, sent - owner);
    blocks.instructions = input.systemText != null ? tokens(input.systemText) : null;
  }
  return { mode: input.mode, source: "adapter-final", ...(input.placement ? { placement: input.placement } : {}),
    ...(input.hostTurn ? { hostTurn: input.hostTurn } : {}),
    ...(input.transportFallback ? { transportFallback: input.transportFallback } : {}),
    blocks, toolsCount: null, attachmentsCount: req.images?.length ?? 0,
    wholeEstimate: sent + tokens(input.systemText) + (blocks.attachments ?? 0),
    blockDigests: digestsOf({ instructions: input.systemText, ownerText: req.userPrompt,
      ...(input.historyInSentText ? { history: req.history.map((row) => row.text).join("\n"),
        hostContext: input.hostContextText ?? req.turnContext } : {}) }) };
}

/** Pre-adapter view of a request. A fallback only: wrappers added by the adapter are not in it. */
export function ledgerFromRequest(req: RunnerRequest): PayloadLedger {
  const blocks = emptyBlocks();
  blocks.instructions = tokens(req.systemPrompt);
  blocks.history = tokens(req.history.map((row) => row.text).join("\n"));
  blocks.hostContext = tokens(req.turnContext);
  blocks.ownerText = tokens(req.userPrompt);
  blocks.attachments = (req.images?.length ?? 0) * LEDGER_IMAGE_TOKEN_ESTIMATE;
  blocks.toolExchanges = null;
  return { mode: "unknown", source: "request", blocks, toolsCount: null,
    attachmentsCount: req.images?.length ?? 0, wholeEstimate: null };
}

interface AttemptRecord {
  id: string | null;
  startedAt: number;
  /** When this native turn ended: its terminal usage arrived or the next attempt started. Absent: the call's end. */
  endedAt?: number;
  payload: PayloadLedger | null;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null;
  detail: { cacheCreationInputTokens?: number; rawInputTokens?: number } | null;
  /** The cache plan the adapter applied to this attempt (cache-planner.ts); absent = the adapter reported none. */
  cachePlan?: CachePlan | null;
}
/** G15: where the call went and what the provider says it ran. Host only; never a path, query or key. */
export interface CallMeta { endpointHost?: string; reportedModel?: string }
interface Collector {
  meta?: CallMeta;
  attempts: AttemptRecord[];
  pending: PayloadLedger | null;
  pendingCachePlan?: CachePlan | null;
  /** What the adapter actually put on the wire for effort (reportModelEffort); absent = the adapter said nothing. */
  effort?: ModelEffortApplication;
}
const collectors = new AsyncLocalStorage<Collector>();

/**
 * The effort a host-loop adapter actually sent (A4 C6.3). `applied` is the provider-native value on the wire, `requested`
 * the chip value it came from; `unsupported` means a value was requested but none was sent, with the machine reason.
 * The ledger records the applied value only, never the requested value as if it had been applied.
 */
export type ModelEffortApplication =
  | { status: "applied"; applied: string; requested: string | null; wire: string }
  | { status: "unsupported"; requested: string; reason: string }
  | { status: "not_requested" };

/**
 * Adapter hook: report the effort this call puts on the wire (or why none). The last report of a call wins, so an adapter
 * that drops the field after a structured provider refusal reports again. No-op outside a wrapped runner.
 */
export function reportModelEffort(application: ModelEffortApplication): void {
  try {
    const collector = collectors.getStore();
    if (collector) collector.effort = { ...application };
  } catch { /* observability must not break a run */ }
}

/** The RunnerResult.appliedEffort the adapter's report implies: the applied value, or null when nothing was sent. */
function appliedEffortOf(application: ModelEffortApplication): string | null {
  return application.status === "applied" ? application.applied : null;
}

/**
 * Adapter hook: report the payload you are about to transmit (lazily: the builder only runs under a wrapped runner and
 * its failure is swallowed). It binds to the next provider attempt the adapter
 * announces (`onRuntimeAttemptStarted`), or to the latest attempt when it was announced first. No-op outside a
 * wrapped runner, so adapters may call it unconditionally.
 */
export function reportModelPayload(build: () => PayloadLedger): void {
  try {
    const collector = collectors.getStore();
    if (!collector) return;           // not under a wrapped runner: nothing to measure, nothing computed
    const ledger = build();
    const last = collector.attempts.at(-1);
    if (last && last.payload === null && last.usage === null) last.payload = ledger;
    else collector.pending = ledger;
  } catch { /* observability must not break a run */ }
}

/**
 * Adapter hook: report the provider cache plan applied to the request about to be sent (same binding rules as
 * reportModelPayload; no-op outside a wrapped runner; failures swallowed).
 */
export function reportCachePlan(plan: CachePlan | (() => CachePlan)): void {
  try {
    const collector = collectors.getStore();
    if (!collector) return;
    const value = typeof plan === "function" ? plan() : plan;
    const last = collector.attempts.at(-1);
    if (last && !last.cachePlan && last.usage === null) last.cachePlan = value;
    else collector.pendingCachePlan = value;
  } catch { /* observability must not break a run */ }
}

/** Host (and port) of a URL, nothing else: no scheme, userinfo, path, query or fragment. */
export function endpointHostOf(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try { const host = new URL(url).host; return host || undefined; } catch { return undefined; }
}

/**
 * Adapter hook: report the endpoint the request goes to and/or the model the provider says it ran. Applies to every
 * attempt of the wrapped call. No-op outside a wrapped runner; failures swallowed.
 */
export function reportModelEndpoint(meta: { url?: string | null; reportedModel?: string | null }): void {
  try {
    const collector = collectors.getStore();
    if (!collector) return;
    const host = endpointHostOf(meta.url);
    const model = typeof meta.reportedModel === "string" && meta.reportedModel.trim() ? meta.reportedModel.trim().slice(0, 120) : undefined;
    collector.meta = { ...collector.meta, ...(host ? { endpointHost: host } : {}), ...(model ? { reportedModel: model } : {}) };
  } catch { /* observability must not break a run */ }
}

export interface ModelCallIdentity {
  kind: string;
  backend?: string | null;
  model?: string | null;
  effort?: string | null;
}

function inferRole(req: RunnerRequest, scoped: ModelCallRole | undefined): { role: ModelCallRole; source: "scope" | "inferred" } {
  // "main" is only the default of the owner-turn scope: a judgment or observation call inside it is not the main call.
  if (scoped && !(scoped === "main" && (req.judgmentOnly || req.minimalObservation))) return { role: scoped, source: "scope" };
  if (req.judgmentOnly) return { role: "judgment", source: "inferred" };
  if (req.minimalObservation) return { role: "observation", source: "inferred" };
  return { role: "unscoped", source: "inferred" };
}

const sanitizeCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Provider wire dialect of a runtime identity (label only; the ledger stores already-logical counts). */
export function usageDialectOf(identity: ModelCallIdentity): UsageDialect {
  const kind = identity.kind; const backend = String(identity.backend ?? "").toLowerCase();
  if (kind === "claude-code" || backend === "anthropic") return "anthropic";
  if (backend === "google" || backend === "gemini" || kind === "antigravity") return "gemini";
  if (kind === "ollama") return "ollama";
  if (kind === "codex") return "openai-responses";
  if (kind === "byok" || kind === "lmstudio" || kind === "mlx" || kind === "agentlas-local" || kind === "agentlas") return "openai-chat";
  return "unknown";
}

/** G16: run the one normalizer over the attempt's usage. Anthropic parts (raw input + read + creation) are re-summed
 * and cross-checked against the logical total the adapter reported; other shapes are validated as logical counts. */
export function usageNormalizationFields(identity: ModelCallIdentity, usage: AttemptRecord["usage"], detail: AttemptRecord["detail"]): Record<string, unknown> {
  if (!usage) return {};
  const dialect = usageDialectOf(identity);
  const rawParts = detail && sanitizeCount(detail.rawInputTokens) !== undefined && sanitizeCount(detail.cacheCreationInputTokens) !== undefined
    && sanitizeCount(usage.cachedInputTokens) !== undefined;
  const normalized = rawParts
    ? normalizeProviderUsage("anthropic", { input_tokens: detail!.rawInputTokens, cache_read_input_tokens: usage.cachedInputTokens,
      cache_creation_input_tokens: detail!.cacheCreationInputTokens, output_tokens: usage.outputTokens })
    : normalizeProviderUsage("unknown", { inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens,
      cacheCreationInputTokens: detail?.cacheCreationInputTokens, outputTokens: usage.outputTokens });
  const out: Record<string, unknown> = { usageDialect: dialect };
  if (normalized.rejected) { out.usageRejected = normalized.rejected; return out; }
  if (normalized.totalInput !== undefined) out.usageTotalInput = normalized.totalInput;
  if (normalized.cachedRead !== undefined) out.usageCachedRead = normalized.cachedRead;
  if (normalized.cacheWrite !== undefined) out.usageCacheWrite = normalized.cacheWrite;
  if (normalized.uncached !== undefined) out.usageUncached = normalized.uncached;
  if (normalized.output !== undefined) out.usageOutput = normalized.output;
  if (rawParts && normalized.totalInput !== usage.inputTokens) out.usageRejected = "total_mismatch";
  return out;
}

/** Flatten one attempt into run-event payload fields (flat numbers/strings only; absent key = unknown). */
export function ledgerEventPayload(input: {
  callRef: string; scopeCallRef?: string; attemptIndex: number; attemptCount: number; attemptId: string | null;
  role: ModelCallRole; roleSource: "scope" | "inferred"; phase?: string; userTurnId: string; scoped: boolean;
  identity: ModelCallIdentity; requestModel?: string | null; effort?: string | null;
  /** applied | unsupported | not_requested | requested_unconfirmed (a runner that reports no effort fact). */
  effortStatus?: string; effortRequested?: string; effortReason?: string;
  payload: PayloadLedger | null; usage: AttemptRecord["usage"]; detail: AttemptRecord["detail"];
  cachePlan?: CachePlan | null; meta?: CallMeta;
  status: string; failureKind?: string; failureCode?: string; durationMs: number;
  /** The context window the runtime itself reported for this session (RunnerResult.contextWindowTokens). */
  contextWindowObserved?: number;
  /** Input of the call's LAST single model request (RunnerResult.contextInputTokens / contextCachedInputTokens). */
  contextInput?: { tokens: number; cached?: number };
}): Record<string, unknown> {
  const { payload } = input;
  const out: Record<string, unknown> = {
    schemaVersion: MODEL_CALL_LEDGER_SCHEMA, callRef: input.callRef, userTurnId: input.userTurnId,
    ...(input.scopeCallRef ? { scopeCallRef: input.scopeCallRef } : {}),
    attemptIndex: input.attemptIndex, attemptCount: input.attemptCount,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    role: input.role, roleSource: input.roleSource, ...(input.phase ? { phase: input.phase } : {}), scoped: input.scoped,
    runtimeKind: input.identity.kind, ...(input.identity.backend ? { runtimeBackend: input.identity.backend } : {}),
    ...(input.requestModel ? { model: input.requestModel } : {}), ...(input.effort ? { effort: input.effort } : {}),
    ...(input.effortStatus ? { effortStatus: input.effortStatus } : {}),
    ...(input.effortRequested ? { effortRequested: input.effortRequested } : {}),
    ...(input.effortReason ? { effortReason: input.effortReason } : {}),
    status: input.status, ...(input.failureKind ? { failureKind: input.failureKind } : {}),
    ...(input.failureCode ? { failureCode: input.failureCode } : {}), durationMs: input.durationMs,
    payloadSource: payload?.source ?? "unknown", mode: payload?.mode ?? "unknown",
    tokenizerRevision: TOKEN_ESTIMATE_REVISION,
    ...(input.meta?.endpointHost ? { endpointHost: input.meta.endpointHost } : {}),
    ...(input.meta?.reportedModel ? { reportedModel: input.meta.reportedModel } : {}),
    ...(input.contextWindowObserved ? { contextWindowObserved: input.contextWindowObserved } : {}),
  };
  if (payload) {
    if (payload.placement) out.placement = payload.placement;
    if (payload.hostTurn) out.hostTurn = payload.hostTurn;
    const fallback = ledgerFailureCode(payload.transportFallback);
    if (fallback) out.transportFallback = fallback;
    const names: Record<BlockName, string> = {
      instructions: "instructionsTokens", tools: "toolsTokens", history: "historyTokens", hostContext: "hostContextTokens",
      attachments: "attachmentsTokens", ownerText: "ownerTextTokens", toolExchanges: "toolExchangeTokens", framing: "framingTokens",
    };
    const unknown: string[] = [];
    for (const name of BLOCK_NAMES) {
      const value = payload.blocks[name];
      if (value === null) unknown.push(name); else out[names[name]] = value;
    }
    out.sentTokensEst = blockSum(payload.blocks);
    if (unknown.length) out.unknownBlocks = unknown.join(",");
    if (payload.toolsCount !== null) out.toolsCount = payload.toolsCount;
    if (payload.attachmentsCount !== null) out.attachmentsCount = payload.attachmentsCount;
    if (payload.wholeEstimate !== null) out.wholeRequestEstimate = payload.wholeEstimate;
    for (const [name, value] of Object.entries(payload.blockDigests ?? {}) as Array<[BlockName, { digest?: string; bytes: number }]>) {
      out[`${names[name].replace(/Tokens$/, "")}Bytes`] = value.bytes;
      if (value.digest) out[`${names[name].replace(/Tokens$/, "")}Digest`] = value.digest;
    }
  } else {
    out.unknownBlocks = BLOCK_NAMES.join(",");
  }
  const usage = input.usage;
  if (usage && sanitizeCount(usage.inputTokens) !== undefined && sanitizeCount(usage.outputTokens) !== undefined) {
    out.usageStatus = "observed";
    out.observedInput = usage.inputTokens;
    out.observedOutput = usage.outputTokens;
    if (sanitizeCount(usage.cachedInputTokens) !== undefined) out.observedCachedInput = usage.cachedInputTokens;
    if (TURN_AGGREGATE_USAGE_RUNTIMES.has(input.identity.kind)) out.usageScope = "turn_aggregate";
  } else out.usageStatus = "unknown";
  // The last single request is independent of the receipt: ACP reports only this (no tokens receipt at all).
  const contextInput = sanitizeCount(input.contextInput?.tokens);
  if (contextInput !== undefined && contextInput > 0) {
    out.observedContextInput = contextInput;
    const cached = sanitizeCount(input.contextInput?.cached);
    if (cached !== undefined && cached <= contextInput) out.observedContextCachedInput = cached;
  }
  Object.assign(out, usageNormalizationFields(input.identity, input.usage, input.detail));
  // Cache planner fields are flat and additive; observedCachedInput above is untouched (context-inspect reads it).
  Object.assign(out, cacheLedgerFields(input.cachePlan, out.observedCachedInput));
  if (input.detail) {
    const write = sanitizeCount(input.detail.cacheCreationInputTokens);
    const raw = sanitizeCount(input.detail.rawInputTokens);
    if (write !== undefined) out.observedCacheCreationInput = write;
    if (raw !== undefined) out.observedRawInput = raw;
  }
  return out;
}

/**
 * Wrap the innermost runner (after agent-context and every host wrapper, directly around the adapter) so the
 * request it sees is the final one. Behaviour-neutral: same request object, same events, same result or error.
 */
export function withModelCallLedger(runner: Runner, identity: ModelCallIdentity): Runner {
  return async (req, events) => {
    let collector: Collector;
    let callRef: string;
    let scope: ModelCallScope | undefined;
    let startedAt: number;
    let wrappedEvents: RunnerEvents = events;
    try {
      scope = scopes.getStore();
      collector = { attempts: [], pending: null };
      callRef = `model-call:${randomUUID()}`;
      startedAt = Date.now();
      wrappedEvents = {
        ...events,
        onRuntimeAttemptStarted: (id) => {
          try {
            const now = Date.now();
            // A new native turn starts only after the previous one ended (its own usage, a retry or the next round).
            const previous = collector.attempts.at(-1);
            if (previous && previous.endedAt === undefined) previous.endedAt = now;
            collector.attempts.push({ id, startedAt: now, payload: collector.pending, usage: null, detail: null,
              cachePlan: collector.pendingCachePlan ?? null });
            collector.pending = null;
            collector.pendingCachePlan = null;
          } catch { /* observability only */ }
          events.onRuntimeAttemptStarted?.(id);
        },
        onModelUsageDetail: (id, detail) => {
          try {
            const attempt = id ? collector.attempts.find((entry) => entry.id === id) : collector.attempts.at(-1);
            if (attempt) attempt.detail = { ...attempt.detail, ...detail };
          } catch { /* observability only */ }
          events.onModelUsageDetail?.(id, detail);
        },
        onTerminalObservedUsage: (usage, id) => {
          try {
            const attempt = (id ? collector.attempts.find((entry) => entry.id === id) : collector.attempts.at(-1));
            if (attempt) { attempt.usage = { ...usage }; attempt.endedAt = Date.now(); }
          } catch { /* observability only */ }
          events.onTerminalObservedUsage?.(usage, id);
        },
      };
    } catch {
      return collectors.run({ attempts: [], pending: null }, () => runner(req, events));
    }
    let result: RunnerResult | undefined;
    let thrown: unknown;
    let threw = false;
    try {
      result = await collectors.run(collector, () => runner(req, wrappedEvents));
      // A host-loop adapter that reported its wire effort and returned no appliedEffort: the result carries the applied
      // value (null = none sent), so Workforce receipts (workload-routing appliedEffortResolution) say what really ran.
      if (collector.effort && result && !Object.prototype.hasOwnProperty.call(result, "appliedEffort")) {
        result = { ...result, appliedEffort: appliedEffortOf(collector.effort) };
      }
      return result;
    } catch (error) {
      threw = true;
      thrown = error;
      throw error;
    } finally {
      try {
        emit(collector, { req, identity, scope, callRef, startedAt, result, threw, thrown });
      } catch { /* observability only */ }
    }
  };
}

/**
 * The runner's own machine code for a failed call (a returned RunnerFailure.providerCode, or a thrown error's code).
 * Production 1.3.47/1.3.48 (2026-10-16): every dreaming pass failed with only failureKind "unsupported" on this row
 * while the cause, codex_no_tools_model_required, existed nowhere persisted. Identifier-shaped values only, no prose.
 */
function ledgerFailureCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value) && !looksSecret(value) ? value : undefined;
}

function emit(collector: Collector, input: {
  req: RunnerRequest; identity: ModelCallIdentity; scope: ModelCallScope | undefined; callRef: string;
  startedAt: number; result: RunnerResult | undefined; threw: boolean; thrown: unknown;
}): void {
  const { req, identity, scope, callRef, result } = input;
  const { role, source } = inferRole(req, scope?.role);
  const identityOfRun = modelCallRunIdentity(scope, req.chatId);
  const { runId, chatId, nodeId, automationId } = identityOfRun;
  const userTurnId = scope?.userTurnId ?? scope?.runId ?? runId;
  const aborted = req.signal?.aborted === true;
  const status = input.threw ? (aborted ? "cancelled" : "failed") : result?.failure ? "failed" : "completed";
  const failureKind = result?.failure?.kind;
  const failureCode = ledgerFailureCode(input.threw ? (input.thrown as { code?: unknown } | null)?.code : result?.failure?.providerCode);
  // The applied effort, never the requested one presented as applied (A4 C6.3): the adapter's wire report first, then a
  // runner-returned appliedEffort; only a runner that reports neither keeps the legacy requested value, marked unconfirmed.
  const reportedEffort = collector.effort;
  const returnedEffort = result && Object.prototype.hasOwnProperty.call(result, "appliedEffort");
  const effort = reportedEffort ? appliedEffortOf(reportedEffort)
    : returnedEffort ? result!.appliedEffort ?? null : req.effort ?? null;
  const effortStatus = reportedEffort ? reportedEffort.status
    : returnedEffort ? (result!.appliedEffort ? "applied" : req.effort ? "unsupported" : "not_requested")
      : req.effort ? "requested_unconfirmed" : undefined;
  const effortRequested = ledgerFailureCode(req.effort ?? undefined);
  const effortReason = reportedEffort?.status === "unsupported" ? ledgerFailureCode(reportedEffort.reason) : undefined;
  // Attempts the adapter announced; a runner that announced none still made (at most) one call we must account for.
  const attempts: AttemptRecord[] = collector.attempts.length
    ? collector.attempts
    : [{ id: null, startedAt: input.startedAt, payload: collector.pending, usage: null, detail: null, cachePlan: collector.pendingCachePlan ?? null }];
  // One announced attempt and a returned total: the returned total is that attempt's receipt.
  if (attempts.length === 1 && attempts[0].usage === null && result?.observedUsage) attempts[0].usage = { ...result.observedUsage };
  const fallbackPayload = ledgerFromRequest(req);
  // The window the runtime reported (ACP usage_update size, a local server's loaded n_ctx when the adapter reports it).
  const window = (result as { contextWindowTokens?: unknown } | undefined)?.contextWindowTokens;
  const reportedWindow = typeof window === "number" && Number.isSafeInteger(window) && window > 0 ? window : undefined;
  const lastRequest = result as { contextInputTokens?: unknown; contextCachedInputTokens?: unknown } | undefined;
  const lastRequestInput = sanitizeCount(lastRequest?.contextInputTokens);
  const lastRequestCached = sanitizeCount(lastRequest?.contextCachedInputTokens);
  const endedAt = Date.now();
  attempts.forEach((attempt, index) => {
    // Only the first attempt may fall back to the pre-adapter request view; later rounds (tool loops, retries)
    // carry state the request does not show, so an unreported payload stays unknown instead of being guessed.
    const payload = attempt.payload ?? (index === 0 ? fallbackPayload : null);
    // AD-9: the call's outcome is the last attempt's. An earlier attempt that reported its provider usage finished its
    // own request (a tool-loop round), so it is completed and its duration ends there; one that reported nothing keeps
    // the call's outcome (no separate "unknown" status yet: owner decision O3).
    const last = index === attempts.length - 1;
    const roundFinished = !last && attempt.usage !== null;
    const attemptStatus = roundFinished ? "completed" : status;
    tryRecordRunEvent({
      runId, ...(chatId ? { chatId } : {}), ...(nodeId ? { nodeId } : {}), ...(automationId ? { automationId } : {}),
      ...(scope?.agentId ? { agentId: scope.agentId } : {}),
      kind: MODEL_CALL_LEDGER_EVENT_KIND,
      sourceEventId: `${MODEL_CALL_LEDGER_EVENT_KIND}:${callRef}:${index + 1}`,
      payload: ledgerEventPayload({
        callRef, ...(scope?.callRef ? { scopeCallRef: scope.callRef } : {}), attemptIndex: index + 1, attemptCount: attempts.length,
        attemptId: attempt.id, role, roleSource: source, ...(scope?.phase ? { phase: scope.phase } : {}),
        userTurnId, scoped: identityOfRun.scoped, identity, requestModel: req.model ?? identity.model ?? null, effort,
        ...(effortStatus ? { effortStatus } : {}), ...(effortRequested ? { effortRequested } : {}), ...(effortReason ? { effortReason } : {}),
        payload, usage: attempt.usage, detail: attempt.detail, cachePlan: attempt.cachePlan ?? null, status: attemptStatus,
        ...(failureKind && !roundFinished ? { failureKind } : {}), ...(failureCode && !roundFinished ? { failureCode } : {}),
        ...(collector.meta ? { meta: collector.meta } : {}),
        ...(reportedWindow && index === attempts.length - 1 ? { contextWindowObserved: reportedWindow } : {}),
        ...(lastRequestInput !== undefined && index === attempts.length - 1
          ? { contextInput: { tokens: lastRequestInput, ...(lastRequestCached !== undefined ? { cached: lastRequestCached } : {}) } } : {}),
        durationMs: Math.max(0, (attempt.endedAt ?? endedAt) - attempt.startedAt),
      }),
    });
  });
}
