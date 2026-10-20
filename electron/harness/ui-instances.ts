import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { UiCommandStore, uiCommandBinding, unknownCommand } from "./ui-command-store";

/*
 * UI instance and action bridge (docs/2026-10-13-native-harness/16 §5-§8; contracts/inline-result.schema.json).
 *
 *   instanceId -> viewId/revision -> exact chatId/turnId/callId/resultRef -> sequence -> actions
 *
 * Durable: append-only JSONL under userData/harness/ui-instances.jsonl, folded in memory, never auto-deleted. The fold
 * order is the line order, so a sequence cursor is a line index and two processes (Main, daemon) appending to the same
 * file agree on it without coordination. ui.close ends the VIEW lifetime only; results and old revisions stay readable.
 *
 * Actions are host-issued opaque handles (`ua_<random>`) mapped server side to {intent, operationId, allowed input
 * schema, fixed args}. The view supplies an actionRef plus input — never an operation name — so it cannot mint authority.
 * host-action dispatches through the SAME dispatcher the model uses (callHarnessPort, imported lazily).
 *
 * No electron import at top level (the daemon loads this).
 */

import type { UiIntent, UiInstanceState, UiViewKind, UiDisplay, UiReason, UiActionView, UiPresentation, UiInstanceRevision, UiInstanceView, UiEventType, UiInstanceEvent } from "../../shared/ui-instances";
import { validateInlineUiPresentationContent, type InlineUiPresentationContent } from "../../shared/inline-ui-presentation";
export type { UiIntent, UiInstanceState, UiViewKind, UiDisplay, UiReason, UiActionView, UiPresentation, UiInstanceRevision, UiInstanceView, UiEventType, UiInstanceEvent } from "../../shared/ui-instances";

/** Same shape as capability-ports' PortOutcome (kept structural so the parent can wire handlers directly). */
export type UiPortOutcome =
  | { status: "ok"; data: unknown }
  | { status: "refused" | "unavailable"; reason: string; next?: string; data?: unknown };

/** Mirror of HarnessCallContext (capability-ports.ts). */
export interface UiCallContext { chatId: string; runId: string; dryRun?: boolean }

export interface UiInputSchema {
  properties?: Record<string, { type: "string" | "number" | "integer" | "boolean" | "object" | "array" }>;
  required?: string[];
}

/** What a producer declares for ui.present / ui.update. The host turns each entry into an actionRef. */
export interface UiActionDeclaration {
  actionId: string;
  /** Short button text (<= 60 chars); display only, never an authority. */
  label?: string;
  intent: UiIntent;
  /** Required for host-action / open-artifact / model-followup. Never supplied by the view. */
  operationId?: string;
  inputSchemaRef?: string;
  /** Allowed view input. Absent means the view may send no input. */
  inputSchema?: UiInputSchema;
  /** Args bound by the host; view input can never override them. */
  fixedArgs?: Record<string, unknown>;
}

// ── durable fold ──────────────────────────────────────────────────────────────────────────────────────────────────

interface ActionDef {
  actionRef: string;
  actionId: string;
  label?: string;
  revision: number;
  intent: UiIntent;
  operationId?: string;
  inputSchemaRef: string;
  inputSchema?: UiInputSchema;
  fixedArgs?: Record<string, unknown>;
}

interface InstanceRecord {
  instanceId: string;
  chatId: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  revisions: UiInstanceRevision[];
  /** actionRef -> definition, across every revision (old refs resolve so stale ones can be told apart from unknown). */
  actionDefs: Map<string, ActionDef>;
}

type Row =
  | { t: "revision"; at: string; instance: UiInstanceRevision; defs: ActionDef[] }
  | { t: "close"; at: string; instanceId: string }
  | { t: "command"; at: string; key: string; data: unknown }
  | { t: "event"; at: string; type: UiEventType; instanceId: string; chatId: string; revision: number; data?: unknown };

interface Folded {
  file: string;
  offset: number;
  tail: string;
  lineNo: number;
  instances: Map<string, InstanceRecord>;
  commands: Map<string, unknown>;
  events: UiInstanceEvent[];
  chatSequence: Map<string, number>;
}

let folded: Folded | null = null;
const listeners = new Set<(event: UiInstanceEvent) => void>();
const inflight = new Map<string, { binding: string; promise: Promise<UiPortOutcome> }>();
const activeCommand = new AsyncLocalStorage<string>();

let replaying = false;
let primedFile: string | null = null;

async function storePath(): Promise<string> {
  const { userDataPath } = await import("../runtime-paths");
  return userDataPath(path.join("harness", "ui-instances.jsonl"));
}

function ingest(state: Folded, row: Row): void {
  state.lineNo += 1;
  if (row.t === "revision") {
    const rev = row.instance;
    let record = state.instances.get(rev.instanceId);
    if (!record) {
      record = { instanceId: rev.instanceId, chatId: rev.chatId, createdAt: row.at, updatedAt: row.at, revisions: [], actionDefs: new Map() };
      state.instances.set(rev.instanceId, record);
    }
    record.revisions.push(rev);
    record.updatedAt = row.at;
    for (const def of row.defs) record.actionDefs.set(def.actionRef, def);
    state.chatSequence.set(rev.chatId, Math.max(state.chatSequence.get(rev.chatId) ?? 0, rev.sequence));
  } else if (row.t === "close") {
    const record = state.instances.get(row.instanceId);
    if (record) { record.closedAt = row.at; record.updatedAt = row.at; }
  } else if (row.t === "command") {
    state.commands.set(row.key, row.data);
  } else if (row.t === "event") {
    const event: UiInstanceEvent = { cursor: state.lineNo, at: row.at, type: row.type, instanceId: row.instanceId, chatId: row.chatId, revision: row.revision, ...(row.data !== undefined ? { data: row.data } : {}) };
    state.events.push(event);
    if (!replaying) for (const listener of listeners) { try { listener(event); } catch { /* a listener must not break the store */ } }
  }
}

function parseLine(line: string): Row | null {
  try {
    const row = JSON.parse(line) as Row;
    return row && typeof row === "object" && typeof (row as { t?: unknown }).t === "string" ? row : null;
  } catch { return null; }
}

/** Bring the in-memory fold up to the file's current end (another process may have appended). */
async function sync(): Promise<Folded> {
  return syncFile(await storePath());
}

function syncFile(file: string): Folded {
  if (!folded || folded.file !== file) {
    folded = { file, offset: 0, tail: "", lineNo: 0, instances: new Map(), commands: new Map(), events: [], chatSequence: new Map() };
  }
  let size = 0;
  try { size = fs.statSync(file).size; } catch { primedFile = file; return folded; }
  if (size < folded.offset) { // truncated or replaced: refold from scratch (never expected; evidence only)
    folded = { file, offset: 0, tail: "", lineNo: 0, instances: new Map(), commands: new Map(), events: [], chatSequence: new Map() };
  }
  if (size === folded.offset) { primedFile = file; return folded; }
  // The first fold of a process replays history: no listener notifications for rows written before it started.
  replaying = primedFile !== file;
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - folded.offset);
    fs.readSync(fd, buffer, 0, buffer.length, folded.offset);
    folded.offset = size;
    const text = folded.tail + buffer.toString("utf8");
    const lines = text.split("\n");
    folded.tail = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const row = parseLine(line);
      if (row) ingest(folded, row);
      else folded.lineNo += 1; // keep line-index cursors stable across a corrupt line
    }
  } finally { fs.closeSync(fd); replaying = false; primedFile = file; }
  return folded;
}

async function append(rows: Row[]): Promise<void> {
  const state = await sync();
  fs.mkdirSync(path.dirname(state.file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(state.file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
  await sync();
}

/** Test hook: forget the in-memory fold (the file stays). */
export function resetUiInstanceStoreCache(): void { folded = null; primedFile = null; }

/**
 * Follow appends made by another process (the daemon runs turns too): poll the file's size and fold new rows, which
 * fires the same listeners. Returns the stop function.
 */
export async function watchUiInstanceStore(intervalMs = 1500): Promise<() => void> {
  const file = await storePath();
  const onChange = () => { void sync().catch(() => undefined); };
  fs.watchFile(file, { interval: intervalMs, persistent: false }, onChange);
  return () => fs.unwatchFile(file, onChange);
}

/** Renderer/main subscribe to every appended event (in this process). */
export function onUiInstanceEvent(listener: (event: UiInstanceEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const refused = (reason: string, next?: string): UiPortOutcome => ({ status: "refused", reason, ...(next ? { next } : {}) });
const ok = (data: unknown): UiPortOutcome => ({ status: "ok", data });
const ACTION_LIMIT = 32;
const INPUT_LIMIT_BYTES = 64 * 1024;
const COMMAND_DATA_LIMIT_BYTES = 64 * 1024;
const OPERATION_INTENTS: readonly UiIntent[] = ["host-action", "open-artifact", "model-followup"];
const INTENTS: readonly UiIntent[] = ["local-state", "prepare-input", "host-action", "open-artifact", "model-followup"];

/** The chat an operation acts on: the run's own chat, or (renderer calls use chat "ui") the chat the args name. */
function effectiveChat(args: Record<string, unknown>, ctx: UiCallContext): string {
  return ctx.chatId === "ui" ? str(args.chatId) : ctx.chatId;
}

function presentationBindingError(args: Record<string, unknown>, ctx: UiCallContext, updating = false): string | null {
  if (ctx.chatId !== "ui" && args.chatId !== undefined && args.chatId !== ctx.chatId) return "owner_chat_mismatch";
  if (args.content !== undefined) {
    if (!str(ctx.runId)) return "owner_run_required";
    if (args.turnId !== undefined && args.turnId !== ctx.runId) return "owner_run_mismatch";
    if (!updating && args.instanceId !== undefined) return "ui_content_instance_host_owned";
    if (args.actions !== undefined) return "ui_content_actions_unsupported";
    if (str(args.viewId).startsWith("mcp-app:")) return "ui_content_view_mismatch";
    for (const [key, maximum] of [["title", 160], ["fallbackText", 4000], ["commandId", 500]] as const) {
      if (args[key] !== undefined && (typeof args[key] !== "string" || (args[key] as string).length > maximum)) return "ui_presentation_invalid";
    }
    for (const [key, values] of [["display", ["inline", "fullscreen", "pip"]], ["reason", ["result", "decision", "required-input", "meaningful-progress"]], ["state", ["running", "ready", "awaiting-input", "failed", "cancelled"]]] as const) {
      if (args[key] !== undefined && !(values as readonly unknown[]).includes(args[key])) return "ui_presentation_invalid";
    }
  }
  return null;
}

function contentDigest(content: InlineUiPresentationContent): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function replayPresentation(state: Folded, command: unknown): unknown {
  if (isObject(command) && typeof command.instanceId === "string" && typeof command.revision === "number") {
    const record = state.instances.get(command.instanceId);
    const instance = record?.revisions.find(item => item.revision === command.revision);
    if (instance) return { instance };
  }
  return command;
}

function viewKindOf(viewId: string): UiViewKind { return viewId.startsWith("mcp-app:") ? "mcp-app" : "native"; }

function newActionRef(): string { return `ua_${randomBytes(18).toString("base64url")}`; }

function issueActions(declared: unknown, revision: number): { views: UiActionView[]; defs: ActionDef[] } | string {
  if (declared === undefined) return { views: [], defs: [] };
  if (!Array.isArray(declared)) return "actions_invalid";
  if (declared.length > ACTION_LIMIT) return "actions_too_many";
  const views: UiActionView[] = [];
  const defs: ActionDef[] = [];
  const seen = new Set<string>();
  for (const raw of declared) {
    if (!isObject(raw)) return "action_invalid";
    const actionId = str(raw.actionId);
    const intent = raw.intent as UiIntent;
    if (!actionId || seen.has(actionId)) return "action_id_invalid";
    if (!INTENTS.includes(intent)) return "action_intent_invalid";
    const operationId = str(raw.operationId);
    if (OPERATION_INTENTS.includes(intent) && !operationId) return "action_operation_required";
    if (operationId.startsWith("ui.")) return "action_operation_forbidden";
    if (raw.inputSchema !== undefined && !isObject(raw.inputSchema)) return "action_schema_invalid";
    if (raw.fixedArgs !== undefined && !isObject(raw.fixedArgs)) return "action_fixed_args_invalid";
    seen.add(actionId);
    const label = str(raw.label).slice(0, 60);
    const actionRef = newActionRef();
    const inputSchemaRef = str(raw.inputSchemaRef) || `inline:${actionId}`;
    defs.push({
      actionRef, actionId, ...(label ? { label } : {}), revision, intent, ...(operationId ? { operationId } : {}), inputSchemaRef,
      ...(raw.inputSchema ? { inputSchema: raw.inputSchema as UiInputSchema } : {}),
      ...(raw.fixedArgs ? { fixedArgs: raw.fixedArgs } : {}),
    });
    views.push({ actionId, ...(label ? { label } : {}), ...(operationId ? { operationId } : {}), inputSchemaRef, expectedRevision: revision, actionRef, intent });
  }
  return { views, defs };
}

function declarationOf(def: ActionDef): UiActionDeclaration {
  return {
    actionId: def.actionId, ...(def.label ? { label: def.label } : {}), intent: def.intent, ...(def.operationId ? { operationId: def.operationId } : {}),
    inputSchemaRef: def.inputSchemaRef, ...(def.inputSchema ? { inputSchema: def.inputSchema } : {}), ...(def.fixedArgs ? { fixedArgs: def.fixedArgs } : {}),
  };
}

/** Validate view input against the declared schema: only declared properties, right types, required present. */
export function validateUiActionInput(input: unknown, schema: UiInputSchema | undefined): string | null {
  const value = input === undefined || input === null ? {} : input;
  if (!isObject(value)) return "input_invalid";
  if (Buffer.byteLength(JSON.stringify(value)) > INPUT_LIMIT_BYTES) return "input_too_large";
  const properties = schema?.properties ?? {};
  for (const key of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(properties, key)) return `input_property_not_allowed:${key}`;
  for (const [key, spec] of Object.entries(properties)) {
    if (value[key] === undefined) continue;
    const v = value[key];
    const type = spec?.type;
    const good = type === "string" ? typeof v === "string"
      : type === "number" ? typeof v === "number" && Number.isFinite(v)
      : type === "integer" ? typeof v === "number" && Number.isInteger(v)
      : type === "boolean" ? typeof v === "boolean"
      : type === "array" ? Array.isArray(v)
      : type === "object" ? isObject(v) : false;
    if (!good) return `input_type_invalid:${key}`;
  }
  for (const key of schema?.required ?? []) if (value[key] === undefined) return `input_required:${key}`;
  return null;
}

function toView(record: InstanceRecord, revision?: number): UiInstanceView | null {
  const rev = revision === undefined ? record.revisions[record.revisions.length - 1] : record.revisions.find((item) => item.revision === revision);
  if (!rev) return null;
  const closed = Boolean(record.closedAt);
  return {
    ...rev,
    state: closed && revision === undefined ? "closed" : rev.state,
    revisionCount: record.revisions.length,
    ...(record.closedAt ? { closedAt: record.closedAt } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function currentOf(record: InstanceRecord): UiInstanceRevision { return record.revisions[record.revisions.length - 1]; }

function staleOutcome(record: InstanceRecord): UiPortOutcome {
  const current = currentOf(record);
  return refused("stale_revision", `current resultRef=${current.resultRef} revision=${current.revision}`);
}

function storeCommand(state: Folded, key: string): unknown | undefined { return state.commands.has(key) ? state.commands.get(key) : undefined; }

function commandRow(key: string, data: unknown): Row {
  const text = JSON.stringify(data) ?? "null";
  const kept = Buffer.byteLength(text) <= COMMAND_DATA_LIMIT_BYTES ? data : { truncated: true };
  return { t: "command", at: new Date().toISOString(), key, data: kept };
}

/** Atomic durable command state: every original attempt remains claimed/sent/settled/unknown, never unlinked. */
interface UiCommandAttempt { sent(validate?: () => UiPortOutcome | null): UiPortOutcome | null; receipt(value: unknown): void }
async function withCommand(key: string, run: (attempt: UiCommandAttempt) => Promise<UiPortOutcome>, binding = key): Promise<UiPortOutcome> {
  const noop: UiCommandAttempt = { sent: validate => validate?.() ?? null, receipt: () => undefined };
  if (!key) return run(noop);
  const file = await storePath(), scopedKey = `${file}:${key}`;
  if (activeCommand.getStore() === scopedKey) return refused("command_in_progress");
  const existing = inflight.get(scopedKey);
  if (existing) return existing.binding === binding ? existing.promise : refused("command_binding_mismatch");
  const promise = claimedCommand(file, key, binding, attempt => activeCommand.run(scopedKey, () => run(attempt)))
    .finally(() => { inflight.delete(scopedKey); });
  inflight.set(scopedKey, { binding, promise });
  return promise;
}

const COMMAND_CLAIM_WAIT_MS = 30_000;
async function claimedCommand(file: string, key: string, binding: string, run: (attempt: UiCommandAttempt) => Promise<UiPortOutcome>): Promise<UiPortOutcome> {
  const dir = path.join(path.dirname(file), "ui-commands");
  const name = createHash("sha256").update(key).digest("hex").slice(0, 40);
  let store: UiCommandStore | undefined, owner: string | undefined;
  try {
    store = new UiCommandStore(dir);
    const deadline = Date.now() + COMMAND_CLAIM_WAIT_MS;
    for (;;) {
      const claim = store.claim(key, binding, () => {
        const state = syncFile(file), original = storeCommand(state, key);
        const claimFile = path.join(dir, `${name}.claim`), unknown = path.join(dir, `${name}.unknown`);
        return original !== undefined ? { legacyOutcome: original } : fs.existsSync(claimFile) || fs.existsSync(unknown) ? { legacyClaim: true } : undefined;
      });
      if ("outcome" in claim) return claim.outcome;
      if ("owner" in claim) { owner = claim.owner; break; }
      if (Date.now() >= deadline) return refused("command_in_progress", "call again with the same commandId for its original outcome");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const attempt: UiCommandAttempt = {
      sent: validate => store!.sent(key, owner!, validate ?? (() => null)),
      receipt: value => store!.rememberReceipt(key, owner!, value),
    };
    const result = await run(attempt);
    store.settle(key, owner, result);
    return result;
  } catch {
    if (!owner) return refused("command_store_unavailable", "restore the command store before retrying the same commandId");
    try { store?.unknown(key, owner); return store?.unknownOutcome(key, owner) ?? unknownCommand(); }
    catch { return unknownCommand(); /* original claimed/sent row still forbids re-dispatch */ }
  } finally { if (owner) store?.release(owner); store?.close(); }
}

// ── handlers ──────────────────────────────────────────────────────────────────────────────────────────────────────

export async function uiPresent(args: Record<string, unknown>, ctx: UiCallContext): Promise<UiPortOutcome> {
  if (ctx.dryRun) return refused("dry_run");
  const bindingError = presentationBindingError(args, ctx);
  if (bindingError) return refused(bindingError);
  const chatId = effectiveChat(args, ctx);
  if (!chatId) return refused("chat_required", "pass chatId");
  let content: InlineUiPresentationContent | undefined;
  if (args.content !== undefined) {
    const checked = validateInlineUiPresentationContent(args.content);
    if (!checked.ok) return refused(checked.reason);
    content = checked.content;
  }
  const digest = content ? contentDigest(content) : "";
  const commandId = str(args.commandId);
  const commandKey = content ? `present:${chatId}:${ctx.runId}:${commandId || digest}` : commandId ? `present:${chatId}:${commandId}` : "";
  return withCommand(commandKey, async () => {
    const state = await sync();
    if (commandKey) { const original = storeCommand(state, commandKey); if (original !== undefined) return ok(replayPresentation(state, original)); }
    const callId = content ? `ui:${ctx.runId}:${digest.slice(0, 16)}` : str(args.callId);
    const resultRef = content ? `ui-content:${digest}` : str(args.resultRef);
    const viewId = content ? `native:${content.kind}` : str(args.viewId);
    if (!callId || !resultRef || !viewId) return refused("arguments_missing", "required: callId, resultRef, viewId");
    const instanceId = content ? `ui_${createHash("sha256").update(commandKey).digest("hex").slice(0, 32)}` : str(args.instanceId) || `ui_${randomUUID()}`;
    if (state.instances.has(instanceId)) {
      const existing = state.instances.get(instanceId)!;
      if (content && existing.chatId === chatId && currentOf(existing).turnId === ctx.runId) return ok({ instance: currentOf(existing) });
      return refused("instance_exists", "use ui.update to add a revision");
    }
    const issued = issueActions(args.actions, 1);
    if (typeof issued === "string") return refused(issued);
    const kind = viewKindOf(viewId);
    const title = str(args.title) || (content?.kind === "native" ? content.document.title : "") || (content ? "" : viewId);
    const instance: UiInstanceRevision = {
      schemaVersion: "agentlas.inline-result.v1",
      instanceId, chatId, turnId: content ? ctx.runId : str(args.turnId) || ctx.runId, callId, resultRef,
      sequence: (state.chatSequence.get(chatId) ?? 0) + 1, revision: 1,
      state: (["running", "ready", "awaiting-input", "failed", "cancelled"] as const).find((s) => s === args.state) ?? "ready",
      presentation: {
        viewId, kind,
        resourceRef: str(args.resourceRef) || (kind === "mcp-app" ? viewId.split(":").slice(2).join(":") : `agentlas-view:${viewId}`),
        display: (["inline", "fullscreen", "pip"] as const).find((d) => d === args.display) ?? "inline",
        title,
        reason: (["result", "decision", "required-input", "meaningful-progress"] as const).find((r) => r === args.reason) ?? "result",
        fallbackText: str(args.fallbackText).slice(0, 4000) || title,
      },
      actions: issued.views,
      ...(content ? { content } : {}),
      ...(str(args.structuredResultRef) ? { structuredResultRef: str(args.structuredResultRef) } : {}),
      ...(Array.isArray(args.artifactRefs) ? { artifactRefs: [...new Set(args.artifactRefs.filter((item): item is string => typeof item === "string" && item.length > 0))] } : {}),
    };
    const at = new Date().toISOString();
    const data = { instance };
    const rows: Row[] = [
      { t: "revision", at, instance, defs: issued.defs },
      { t: "event", at, type: "presented", instanceId, chatId, revision: 1 },
    ];
    if (commandKey) rows.push(commandRow(commandKey, content ? { instanceId, revision: 1 } : data));
    await append(rows);
    return ok(data);
  });
}

export async function uiUpdate(args: Record<string, unknown>, ctx: UiCallContext): Promise<UiPortOutcome> {
  if (ctx.dryRun) return refused("dry_run");
  const bindingError = presentationBindingError(args, ctx, true);
  if (bindingError) return refused(bindingError);
  let content: InlineUiPresentationContent | undefined;
  if (args.content !== undefined) {
    const checked = validateInlineUiPresentationContent(args.content);
    if (!checked.ok) return refused(checked.reason);
    content = checked.content;
  }
  const chatId = effectiveChat(args, ctx);
  const instanceId = str(args.instanceId);
  const commandId = str(args.commandId);
  const commandKey = commandId ? `update:${instanceId}:${commandId}` : "";
  // Promise/claim replay can return without entering the callback; authorize before joining it.
  const ownerRecord = (await sync()).instances.get(instanceId);
  if (!ownerRecord) return refused("instance_unknown");
  if (ownerRecord.chatId !== chatId) return refused("owner_chat_mismatch");
  return withCommand(commandKey, async () => {
    const state = await sync();
    const record = state.instances.get(instanceId);
    if (!record) return refused("instance_unknown");
    if (record.chatId !== chatId) return refused("owner_chat_mismatch");
    if (commandKey) { const original = storeCommand(state, commandKey); if (original !== undefined) return ok(replayPresentation(state, original)); }
    if (record.closedAt) return refused("instance_closed", "present a new instance; closed views are not reopened");
    const previous = currentOf(record);
    if (content && previous.presentation.kind === "mcp-app") return refused("ui_content_view_mismatch");
    if (args.expectedRevision !== undefined && args.expectedRevision !== previous.revision) return staleOutcome(record);
    const revision = previous.revision + 1;
    const declared = args.actions !== undefined
      ? args.actions
      : [...record.actionDefs.values()].filter((def) => def.revision === previous.revision).map(declarationOf);
    const issued = issueActions(declared, revision);
    if (typeof issued === "string") return refused(issued);
    const prevPresentation = previous.presentation;
    const next: UiInstanceRevision = {
      ...previous,
      // A native view that shows the latest of several calls (a report built over many steps) moves to the call that produced it.
      ...(str(args.callId) && previous.presentation.kind !== "mcp-app" ? { callId: str(args.callId) } : {}),
      resultRef: content ? `ui-content:${contentDigest(content)}` : str(args.resultRef) || previous.resultRef,
      revision,
      state: (["running", "ready", "awaiting-input", "failed", "cancelled"] as const).find((s) => s === args.state) ?? previous.state,
      presentation: {
        ...prevPresentation,
        ...(content ? { viewId: `native:${content.kind}`, kind: "native" as const, resourceRef: `agentlas-view:native:${content.kind}` } : {}),
        title: str(args.title) || prevPresentation.title,
        fallbackText: str(args.fallbackText).slice(0, 4000) || prevPresentation.fallbackText,
        reason: (["result", "decision", "required-input", "meaningful-progress"] as const).find((r) => r === args.reason) ?? prevPresentation.reason,
        display: (["inline", "fullscreen", "pip"] as const).find((d) => d === args.display) ?? prevPresentation.display,
      },
      actions: issued.views,
      ...(content ? { content } : {}),
      ...(str(args.structuredResultRef) ? { structuredResultRef: str(args.structuredResultRef) } : {}),
      ...(Array.isArray(args.artifactRefs) ? { artifactRefs: [...new Set(args.artifactRefs.filter((item): item is string => typeof item === "string" && item.length > 0))] } : {}),
    };
    const at = new Date().toISOString();
    const data = { instance: next };
    const rows: Row[] = [
      { t: "revision", at, instance: next, defs: issued.defs },
      { t: "event", at, type: "updated", instanceId, chatId: record.chatId, revision },
    ];
    if (commandKey) rows.push(commandRow(commandKey, next.content ? { instanceId, revision } : data));
    await append(rows);
    return ok(data);
  });
}

export async function uiClose(args: Record<string, unknown>, ctx: UiCallContext): Promise<UiPortOutcome> {
  if (ctx.dryRun) return refused("dry_run");
  const chatId = effectiveChat(args, ctx);
  const instanceId = str(args.instanceId);
  const state = await sync();
  const record = state.instances.get(instanceId);
  if (!record) return refused("instance_unknown");
  if (record.chatId !== chatId) return refused("owner_chat_mismatch");
  const current = currentOf(record);
  if (record.closedAt) return ok({ instanceId, closed: true, alreadyClosed: true, resultRef: current.resultRef, revision: current.revision, resultsKept: true });
  const at = new Date().toISOString();
  await append([
    { t: "close", at, instanceId },
    { t: "event", at, type: "closed", instanceId, chatId: record.chatId, revision: current.revision },
  ]);
  // Lifetime of the view only: results, artifacts and every revision stay readable.
  return ok({ instanceId, closed: true, resultRef: current.resultRef, revision: current.revision, resultsKept: true });
}

export async function uiSubscribe(args: Record<string, unknown>, ctx: UiCallContext): Promise<UiPortOutcome> {
  const chatId = effectiveChat(args, ctx);
  const instanceId = str(args.instanceId);
  const state = await sync();
  const record = state.instances.get(instanceId);
  if (!record) return refused("instance_unknown");
  if (record.chatId !== chatId) return refused("owner_chat_mismatch");
  const cursor = typeof args.cursor === "number" && Number.isFinite(args.cursor) ? Math.max(0, Math.floor(args.cursor)) : 0;
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(500, Math.floor(args.limit)) : 200;
  const matching = state.events.filter((event) => event.instanceId === instanceId && event.cursor > cursor);
  const events = matching.slice(0, limit);
  const last = events.length ? events[events.length - 1].cursor : cursor;
  const revisionArg = typeof args.revision === "number" ? Math.floor(args.revision) : undefined;
  const snapshot = toView(record, revisionArg);
  if (revisionArg !== undefined && !snapshot) return refused("revision_unknown");
  return ok({ instanceId, events, cursor: last, hasMore: matching.length > events.length, instance: snapshot });
}

function resolveAction(record: InstanceRecord, args: Record<string, unknown>): ActionDef | string {
  const actionRef = str(args.actionRef);
  const actionId = str(args.actionId);
  if (actionRef) {
    const def = record.actionDefs.get(actionRef);
    if (!def) return "action_ref_unknown";
    if (actionId && def.actionId !== actionId) return "action_ref_mismatch";
    return def;
  }
  // actionId alone resolves only against the current revision's host-issued set.
  const current = currentOf(record).revision;
  const found = [...record.actionDefs.values()].find((def) => def.actionId === actionId && def.revision === current);
  return found ?? "action_ref_required";
}

function actionBindingError(record: InstanceRecord, args: Record<string, unknown>, chatId: string): UiPortOutcome | null {
  if (record.chatId !== chatId) return refused("owner_chat_mismatch");
  // The view can never name an operation: it holds an actionRef and input only.
  for (const forbidden of ["operationId", "operation", "operationName", "op", "toolName", "tool"]) {
    if (args[forbidden] !== undefined) return refused("view_named_operation", "send actionRef and input; the host owns the operation");
  }
  if (record.closedAt) return refused("instance_closed");
  const def = resolveAction(record, args);
  if (typeof def === "string") return refused(def);
  const current = currentOf(record);
  if (def.revision !== current.revision) return staleOutcome(record);
  if (args.expectedRevision !== undefined && args.expectedRevision !== current.revision) return staleOutcome(record);
  if (args.resultRef !== undefined && str(args.resultRef) !== current.resultRef) return staleOutcome(record);
  const invalid = validateUiActionInput(args.input, def.inputSchema);
  if (invalid) return refused(invalid);
  return null;
}

function actionRequestBinding(record: InstanceRecord, args: Record<string, unknown>, ctx: UiCallContext, chatId: string): string {
  const current = currentOf(record), def = resolveAction(record, args) as ActionDef;
  return createHash("sha256").update(uiCommandBinding({ chatId, runId: ctx.runId, instanceId: record.instanceId, turnId: current.turnId, callId: current.callId,
    revision: current.revision, resultRef: current.resultRef, actionRef: def.actionRef, intent: def.intent,
    operationId: def.operationId, input: args.input ?? {}, fixedArgs: def.fixedArgs ?? {} })).digest("hex");
}

export async function uiAction(args: Record<string, unknown>, ctx: UiCallContext): Promise<UiPortOutcome> {
  if (ctx.dryRun) return refused("dry_run");
  try { args = JSON.parse(uiCommandBinding(args)) as Record<string, unknown>; } catch { return refused("input_invalid"); }
  const chatId = effectiveChat(args, ctx);
  const instanceId = str(args.instanceId);
  const commandId = str(args.commandId);
  const commandKey = commandId ? `action:${instanceId}:${commandId}` : "";
  // A cached or in-flight owner's outcome must never be replayed to another conversation.
  const ownerRecord = (await sync()).instances.get(instanceId);
  if (!ownerRecord) return refused("instance_unknown");
  const invalidBinding = actionBindingError(ownerRecord, args, chatId);
  if (invalidBinding) return invalidBinding;
  const ownerDef = resolveAction(ownerRecord, args) as ActionDef;
  const terminalControl = ownerDef.intent === "host-action"
    && (await import("./capability-ports")).isFixedTerminalHarnessAction(ownerDef.operationId!, ownerDef.fixedArgs ?? {});
  if (ownerDef.intent === "host-action" && !commandId && !terminalControl) return refused("command_id_required");
  const binding = actionRequestBinding(ownerRecord, args, ctx, chatId);
  const file = await storePath();
  return withCommand(terminalControl ? "" : commandKey, async (attempt) => {
    const state = await sync();
    const record = state.instances.get(instanceId);
    if (!record) return refused("instance_unknown");
    if (record.chatId !== chatId) return refused("owner_chat_mismatch");
    const invalidBinding = actionBindingError(record, args, chatId);
    if (invalidBinding) return invalidBinding;
    if (actionRequestBinding(record, args, ctx, chatId) !== binding) return staleOutcome(record);
    const def = resolveAction(record, args) as ActionDef;
    const current = currentOf(record);
    const input = (isObject(args.input) ? args.input : {}) as Record<string, unknown>;
    const at = new Date().toISOString();
    const base = { instanceId, actionId: def.actionId, intent: def.intent, revision: current.revision, resultRef: current.resultRef };
    const record_ = async (type: UiEventType, data: unknown): Promise<void> => {
      const rows: Row[] = [{ t: "event", at, type, instanceId, chatId: record.chatId, revision: current.revision, data: { actionId: def.actionId } }];
      if (commandKey) rows.push(commandRow(commandKey, data));
      await append(rows);
    };

    if (def.intent === "local-state") {
      // View-local computation; no model, no host call, nothing to record beyond the acknowledgement.
      return ok({ ...base, dispatched: false, localState: true });
    }
    if (def.intent === "prepare-input") {
      const data = { ...base, dispatched: false, draft: { text: str(input.text).slice(0, 8000), input } };
      await record_("draft", data);
      return ok(data);
    }
    if (def.intent === "open-artifact") {
      // Return the request; this module never opens files or windows.
      const data = { ...base, dispatched: false, openRequest: { operationId: def.operationId, args: { ...input, ...(def.fixedArgs ?? {}) }, artifactRefs: current.artifactRefs ?? [] } };
      await record_("open-request", data);
      return ok(data);
    }
    if (def.intent === "model-followup") {
      // Bound to the exact result; the owner's runtime decides whether to start a run. No model run starts here.
      const data = { ...base, dispatched: false, followup: { followupId: `fu_${randomUUID()}`, text: str(input.text).slice(0, 8000), input, callId: current.callId, turnId: current.turnId, operationId: def.operationId } };
      await record_("followup", data);
      return ok(data);
    }
    // host-action: re-checked above (instance/owner chat/revision/allowed schema); dispatch the bound operation.
    const { callHarnessPort } = await import("./capability-ports");
    const operationId = def.operationId!;
    const admission = attempt.sent(() => {
      const latest = syncFile(file).instances.get(instanceId);
      if (!latest) return refused("instance_unknown");
      const invalid = actionBindingError(latest, args, chatId);
      return invalid ?? (actionRequestBinding(latest, args, ctx, chatId) !== binding ? staleOutcome(latest) : null);
    });
    if (admission) return admission;
    // The command id travels to the operation as its idempotency key (the effect owner may dedupe on it).
    const result = await callHarnessPort(operationId, { ...input, ...(def.fixedArgs ?? {}) }, { chatId: record.chatId, runId: ctx.runId,
      ...(commandKey ? { commandId: commandKey } : {}), ...(ctx.dryRun ? { dryRun: true } : {}) });
    attempt.receipt(result);
    if (result.status !== "ok") return { status: result.status, reason: result.reason ?? "operation_failed", ...(result.next ? { next: result.next } : {}) };
    const data = { ...base, dispatched: true, operationId, receiptId: result.receiptId, data: result.data };
    await record_("action", data);
    return ok(data);
  }, binding);
}

/**
 * Views the host draws from a result it retained itself. Their state belongs to the owner's own surface (a save settles the card, the close button
 * closes it) and to the host (a newer proposal cancels an older one): a run that presents, updates or closes one through a port is refused, so a card
 * never says "saved" for something nobody saved and a cancelled proposal is never opened again. The host's own bookkeeping calls the handlers below
 * directly, not through a port.
 */
const HOST_OWNED_VIEWS: ReadonlySet<string> = new Set(["finance.result.v1"]);

async function hostOwnedViewRefusal(operation: "present" | "update" | "close", args: Record<string, unknown>, ctx: UiCallContext): Promise<UiPortOutcome | null> {
  if (ctx.chatId === "ui") return null;
  const record = operation === "present" ? undefined : (await sync()).instances.get(str(args.instanceId));
  const viewId = operation === "present" ? str(args.viewId) : record ? currentOf(record).presentation.viewId : "";
  return HOST_OWNED_VIEWS.has(viewId) ? refused("owner_only", "this view belongs to the host: its state is moved by the owner's own save, a newer proposal or the close button") : null;
}

const ownerOnlyForHostViews = (operation: "present" | "update" | "close", handler: (args: Record<string, unknown>, ctx: UiCallContext) => Promise<UiPortOutcome>) =>
  async (args: Record<string, unknown>, ctx: UiCallContext): Promise<UiPortOutcome> => (await hostOwnedViewRefusal(operation, args, ctx)) ?? handler(args, ctx);

/** Port handlers for the parent to wire into capability-ports (ui.present ... ui.subscribe). */
export const UI_PORT_HANDLERS: Record<string, (args: Record<string, unknown>, ctx: UiCallContext) => Promise<UiPortOutcome>> = {
  "ui.present": ownerOnlyForHostViews("present", uiPresent),
  "ui.update": ownerOnlyForHostViews("update", uiUpdate),
  "ui.close": ownerOnlyForHostViews("close", uiClose),
  "ui.action": uiAction,
  "ui.subscribe": uiSubscribe,
};

// ── renderer read model ───────────────────────────────────────────────────────────────────────────────────────────

/** Latest revision of every instance in a chat, oldest first (closed ones included, flagged). */
export async function listUiInstances(chatId: string): Promise<UiInstanceView[]> {
  const state = await sync();
  const out: UiInstanceView[] = [];
  for (const record of state.instances.values()) {
    if (record.chatId !== chatId) continue;
    const view = toView(record);
    if (view) out.push(view);
  }
  return out.sort((a, b) => a.sequence - b.sequence);
}
