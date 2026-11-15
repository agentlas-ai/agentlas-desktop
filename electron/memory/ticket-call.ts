// The host half of the memory_ticket tool. One call = 1-5 tickets. Each is received ALONE by the pure receiver (ticket-receiver.ts) from host facts
// and the lines the model was shown, and an accepted ticket is WRITTEN NOW through the functions that already exist - nothing here is a new way to store, hide or forget a line:
//   add       curateEvents (the one write path: secret check, duplicate, store ceiling, forget stamp, Personal write gate, two origin columns)
//   rewrite   curateEvents with the named line (`explicit_replace`): the old line is superseded (recoverable) and the reason is kept as an evidence mark
//   condense  the same, plus supersedeExplicitMemory for the other named lines
//   remove    forgetOwnedLine -> forgetOwnedMemory (the one forget every door ends in: stamp, line, older versions, turn records, index, views, mirror), for the asking subject's own lines only (K7')
// The answer of a ticket says what really happened (the host reads the write's own report), so "saved" is a fact the model may repeat and nothing else is. Nothing here reads a word of the
// owner's request, names a model or asks the model again; a ticket the host cannot place is answered `not_here`, one whose line is gone `target_unknown`, and the turn goes on.
import type { MemoryKind, MemoryScope } from "../architecture/manifest";
import { resolveToolCaller, type ToolCaller } from "../harness/tool-caller";
import { addTurnToolWrites, noteTurnMemoryCall, noteTurnTickets, shownMemoryIds, turnMemoryFacts, type TurnMemoryFacts } from "../turn-tools/memory-facts";
import { curateEvents, type CurationContext, type CurationReport } from "./curator";
import type { RawMemoryEvent } from "./events";
import { memoryBlockKey, supersedeExplicitMemory } from "./graph";
import { ORIGIN_INSTRUCTION, ORIGIN_OWNER_SPOKE } from "./run-evidence";
import { forgetOwnedLine, ownedMemoryRecord, type ForgetSubject } from "./owner-mutations";
import { memoryActorKind } from "../../shared/memory-ownership";
import { receiveTickets, type TicketAnswer, type TicketConversation, type TicketHostFacts, type TicketItem, type TicketReceipt, type TicketVisibleLine } from "./ticket-receiver";

export interface MemoryTicketCallInput {
  chatId: string;
  runId: string;
  /** The tool's arguments exactly as the model sent them. */
  args: unknown;
  dryRun?: boolean;
  /** Test seam: the caller of the call (the gate has no conversation store). Never set in production. */
  caller?: ToolCaller;
}

export interface MemoryTicketCallResult { tickets: TicketAnswer[]; unreadable?: string }

/** The conversation kind, from the caller the host resolved (harness/tool-caller.ts; the model names none of it). */
export function ticketConversationOf(caller: ToolCaller): TicketConversation {
  switch (caller.kind) {
    case "personal": return "personal_agent";
    case "agent":
    case "member": {
      const actor = memoryActorKind(caller.agentId);
      // An agent with a folder of its own (and the built-in Finance and Science agents) keeps its own memory; a resident actor (a Work session) is the machine's work knowledge.
      return actor === "folderAgent" || actor === "special" ? "folder_agent" : actor === "resident" ? "work_session" : "guest";
    }
    default: return "guest";
  }
}

export interface ShownLine extends TicketVisibleLine { memoryId: string }

/** One live line of the owner as a model sees it (K3': the resting-time gathering shows lines the same way): the id in front of a line is the block key of its English text. Null for a line that is gone, hidden or not the owner's. */
export function shownLineOf(memoryId: string): ShownLine | null {
  try {
    const row = ownedMemoryRecord(memoryId) as ReturnType<typeof ownedMemoryRecord> & { origin_class?: string | null; certainty?: string | null };
    if (row.superseded_at || !row.content) return null;
    let ticketKind: string | null = null;
    try { const context = JSON.parse(row.context_json || "{}") as { ticket_kind?: unknown }; ticketKind = typeof context.ticket_kind === "string" ? context.ticket_kind : null; } catch { /* no context */ }
    return { id: memoryBlockKey(row.content), memoryId, scope: row.scope, kind: row.kind, ticket_kind: ticketKind, text: row.content, origin_class: row.origin_class ?? null, certainty: row.certainty ?? null };
  } catch { return null; /* a line that is not the owner's or is gone is not offered as a target */ }
}

/** The lines the run's recall put into the prompt, as the model sees them: the id in front of a line is the block key of its English text. */
function shownLines(key: string): ShownLine[] {
  const out = new Map<string, ShownLine>();
  for (const memoryId of shownMemoryIds(key)) {
    const line = shownLineOf(memoryId);
    if (line && !out.has(line.id)) out.set(line.id, line);
  }
  return [...out.values()];
}

/** The engine's order of sensitivity, least strict first (memory_runtime.py `_apply_curation_in`: `sensitivity_order`). */
const SENSITIVITY_ORDER = ["public", "internal", "private", "confidential"] as const;

/**
 * Ruleset-free contract of the engine, same on every surface: a line that REPLACES others (rewrite, condense) takes the strictest sensitivity of the lines it replaces - a private line rewritten must not come out less private
 * (the engine: `max(originals sensitivity)` over the named targets, `_apply_curation_in`). An add has no targets and is written as `internal`, as before. A target that cannot be read is skipped (the write answers `target_unknown`
 * for it); a sensitivity word outside the four counts as the strictest (the safe side). Null = nothing to inherit.
 */
function inheritedSensitivity(item: TicketItem, byBlockKey: ReadonlyMap<string, ShownLine>): RawMemoryEvent["sensitivity"] | null {
  if (item.result !== "rewritten" && item.result !== "condensed") return null;
  let strictest = -1;
  for (const id of item.line?.replaces ?? []) {
    const target = byBlockKey.get(id);
    if (!target) continue;
    try {
      const rank = SENSITIVITY_ORDER.indexOf(ownedMemoryRecord(target.memoryId).sensitivity as (typeof SENSITIVITY_ORDER)[number]);
      strictest = Math.max(strictest, rank < 0 ? SENSITIVITY_ORDER.length - 1 : rank);
    } catch { /* gone or not the owner's: the write answers it */ }
  }
  return strictest < 0 ? null : SENSITIVITY_ORDER[strictest];
}

/**
 * K7': the same contract as the sensitivity above, for `confidence` (engine `_apply_curation_in`: `low` when any replaced line is `low`). A line that replaces others (rewrite, condense) is not more trusted than the
 * least trusted line it replaces: with any `low` target the successor is `low`, otherwise the word the line's own origin gives stands (an add has no targets). A target that cannot be read is skipped. Null = nothing to inherit.
 */
function inheritedConfidence(item: TicketItem, byBlockKey: ReadonlyMap<string, ShownLine>): RawMemoryEvent["confidence"] | null {
  if (item.result !== "rewritten" && item.result !== "condensed") return null;
  for (const id of item.line?.replaces ?? []) {
    const target = byBlockKey.get(id);
    if (!target) continue;
    try { if (ownedMemoryRecord(target.memoryId).confidence === "low") return "low"; } catch { /* gone or not the owner's: the write answers it */ }
  }
  return null;
}

function eventOf(item: TicketItem, extraEvidence: readonly string[] = [], sensitivity: RawMemoryEvent["sensitivity"] | null = null, confidence: RawMemoryEvent["confidence"] | null = null): RawMemoryEvent {
  const line = item.line!;
  const instruction = line.marks.includes("owner_instruction");
  return {
    memory_kind: line.store_kind as MemoryKind,
    content: line.text,
    suggested_scope: line.scope as MemoryScope,
    // Not a gate any more: how far the host trusts the line is the two columns below; the word only mirrors them for the code that still reads it.
    confidence: confidence ?? (line.origin_class === "user" ? "high" : line.origin_class === "inferred" ? "low" : "medium"),
    sensitivity: sensitivity ?? "internal",
    evidence_refs: [...(instruction ? [ORIGIN_INSTRUCTION, ORIGIN_OWNER_SPOKE] : []), ...(item.result === "rewritten" && line.why ? [`rewrite-why:${line.why}`] : []), ...extraEvidence],
    ...(line.native ? { content_native: line.native } : {}),
    ...(line.replaces.length ? { supersedes: line.replaces[0], explicit_replace: true } : {}),
    ...(line.context?.ticket_kind === "identity" || line.context?.ticket_kind === "boundary" ? { ticket_kind: line.context.ticket_kind } : {}),
    origin_class: line.origin_class,
    ticket_origin: { originClass: line.origin_class, certainty: line.certainty },
  };
}

const ZERO = (): CurationReport => ({ written: 0, deduped: 0, redacted: 0, sessionOnly: 0, discarded: 0 });
function add(into: CurationReport, from: CurationReport): void {
  into.written += from.written; into.deduped += from.deduped; into.redacted += from.redacted; into.sessionOnly += from.sessionOnly; into.discarded += from.discarded;
}

function refusalOfReasons(reasons: readonly string[]): TicketAnswer {
  if (reasons.includes("policy-ticket-target-gone")) return { status: "invalid", why: "target_unknown" };
  if (reasons.includes("policy-secret")) return { status: "refused", why: "secret_like" };
  return { status: "refused", why: "not_here" };
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The old `memory_note` arguments (ONE note: content, memory_kind, suggested_scope, ...) read as one ticket, for a session or an executor that still calls the old name: the same receiver then answers
 * it. Nothing is guessed: a note that named a line to replace (`supersedes`, the h: key) is a rewrite of that line, the old `origin_class` (when the caller gave one) is the ticket's source, and a note
 * with no origin says none (the receiver then reads it as the lowest tier). New-shaped arguments (`tickets`) pass through untouched.
 */
/** An id the engine writes as `m:<id>` names the same line: the prefix is dropped in front of an `h:` key (one idiom on every surface). */
function dropEnginePrefix(args: unknown): unknown {
  if (!isObject(args) || !Array.isArray(args.tickets)) return args;
  const fix = (v: unknown): unknown => {
    const t = typeof v === "string" ? v.trim() : "";
    // `m:h:<key>` (the engine's idiom) and a bare 16-hex key (a model that dropped the `h:`, seen on codex) name the same shown line.
    if (/^m:h:[0-9a-f]{16}$/.test(t)) return t.slice(2);
    return /^[0-9a-f]{16}$/.test(t) ? `h:${t}` : v;
  };
  return { ...args, tickets: args.tickets.map(t => isObject(t) && Array.isArray(t.targets) ? { ...t, targets: t.targets.map(fix) } : t) };
}

export function ticketArgsFromOldNote(args: unknown): unknown {
  if (!isObject(args) || "tickets" in args && args.tickets !== undefined) return dropEnginePrefix(args);
  if (!isObject(args) || "tickets" in args || typeof args.content !== "string" || !("memory_kind" in args)) return args;
  const native = typeof args.content_native === "string" && args.content_native.trim() ? args.content_native : null;
  const source = ({ user: "said", observed: "seen", result: "did", inferred: "inferred" } as Record<string, string>)[String(args.origin_class)];
  const scope = args.suggested_scope === "agent_team" || args.suggested_scope === "team_memory" ? "agent_repo" : args.suggested_scope;
  const target = typeof args.supersedes === "string" ? args.supersedes : null;
  return { tickets: [{ action: target ? "rewrite" : "add", ...(target ? { targets: [target] } : {}), scope, kind: args.memory_kind, text: native ?? args.content, ...(native ? { en: args.content } : {}), ...(source ? { source } : {}) }] };
}

/** What one accepted receipt did (shared by the memory_ticket tool, at the call, and by the resting-time gathering, K3'): one write path for both. */
export interface TicketApplyInput {
  receipt: TicketReceipt;
  /** The context every write of this call uses; null = nothing may be written (a read-only turn). */
  context: CurationContext | null;
  /** K7': who asks. A `remove` forgets a line only when it is this subject's own (Personal -> the personal agent's conversation; an agent's line -> that agent; a project's line -> the bound project). No subject = no remove. */
  subject?: ForgetSubject;
  /** The owner's messages of the turn(s), for the quote check of the write path. */
  ownerText?: string | null;
  /** The personal agent read a group room: what is not the owner's own words is not its memory. */
  roomContent?: boolean;
  visible: readonly ShownLine[];
  dryRun?: boolean;
  /** Host-made evidence strings added to every line this receipt writes (the resting-time gathering names the runs its turn records came from: `run:<id>`, so a lesson's recurrence over distinct runs is still counted). Never model text. */
  evidenceRefs?: readonly string[];
}
export interface TicketApplyResult { answers: TicketAnswer[]; total: CurationReport; writtenIds: string[] }

export function applyTicketReceipt(input: TicketApplyInput): TicketApplyResult {
  const { receipt, context, visible } = input;
  const roomContent = input.roomContent === true;
  const ownerText = input.ownerText ?? undefined;
  const answers: TicketAnswer[] = [];
  const total = ZERO();
  const writtenIds: string[] = [];
  const byBlockKey = new Map(visible.map(line => [line.id, line]));
  for (const item of receipt.items) {
    // Ruleset 1.14.0: when the English wording was over the line limit and the person's own words were kept, the answer says so (`english: "dropped"`, the word the server's answer uses), so the model is not left thinking its English line was stored.
    const answer: TicketAnswer = item.status === "ok" && item.fixes.includes("en_dropped_too_long") ? { ...receipt.answers[item.index], english: "dropped" } : receipt.answers[item.index];
    if (item.status !== "ok" || input.dryRun === true || !context) { if (item.status !== "ok") total.discarded += 1; answers.push(answer); continue; }
    // The personal agent read a group room this turn: what is not the owner's own words is not its memory (; the old drain kept only the candidates that rested on them).
    if (roomContent && item.line && item.line.origin_class !== "user") { answers.push({ status: "refused", why: "not_said" }); total.discarded += 1; continue; }
    try {
      if (item.result === "removed") {
        // K7': the same forget as the memory screen's (`forgetOwnedLine` -> `forgetOwnedMemory`), for the subject's own lines only. A line of another agent, of another project or Personal's (outside the personal agent's
        // conversation) is `not_here` and untouched, whatever the model named; a line that is gone already or changed a moment ago is `target_unknown`.
        let gone = 0, outside = 0;
        for (const id of item.targets) {
          const line = byBlockKey.get(id);
          if (!line) continue;
          try { forgetOwnedLine(line.memoryId, input.subject ?? { personal: false, agentId: null }); gone += 1; }
          catch (error) { const code = error instanceof Error ? error.message : ""; if (code === "memory_owner_subject_mismatch" || code === "one_sealed" || code === "one_away") outside += 1; /* else: gone already, changed a moment ago or not the owner's: counted below */ }
        }
        if (gone === 0) { answers.push(outside > 0 ? { status: "refused", why: "not_here" } : { status: "invalid", why: "target_unknown" }); total.discarded += 1; }
        else answers.push(answer);
        continue;
      }
      if (item.result === "merged") { answers.push(answer); total.deduped += 1; continue; }
      const reasons: string[] = [];
      const report = curateEvents([eventOf(item, input.evidenceRefs, inheritedSensitivity(item, byBlockKey), inheritedConfidence(item, byBlockKey))], context, { ownerText, reasonSink: reasons });
      add(total, report);
      const line = item.line!;
      const id = memoryBlockKey(line.text);
      if (report.written > 0) {
        const newId = report.writtenIds?.[0];
        if (newId) writtenIds.push(newId);
        // condense: the first named line was replaced by the write; the others are hidden the same way (recoverable, never deleted).
        if (item.result === "condensed" && newId) for (const other of line.replaces.slice(1)) { try { supersedeExplicitMemory({ id: newId }, other); } catch { /* the new line stands; the older one stays visible */ } }
        answers.push({ ...answer, id });
      } else if (report.deduped > 0) answers.push({ ...answer, result: "merged", id });
      else answers.push(refusalOfReasons(reasons));
    } catch {
      answers.push(item.result === "saved" ? { status: "refused", why: "not_here" } : { status: "invalid", why: "target_unknown" });
      total.discarded += 1;
    }
  }
  return { answers, total, writtenIds };
}

/** One call of the memory_ticket tool. Never throws for a ticket: each answers on its own. */
export async function receiveMemoryTicketCall(input: MemoryTicketCallInput): Promise<MemoryTicketCallResult> {
  const key = `${input.chatId}|${input.runId}`;
  const facts: TurnMemoryFacts | null = turnMemoryFacts(key);
  const caller = input.caller ?? await resolveToolCaller({ chatId: input.chatId, runId: input.runId });
  const base: CurationContext | null = facts && !facts.readOnly() ? facts.curation() : null;
  const conversation: TicketConversation = base ? ticketConversationOf(caller) : "guest";
  // The owner wrote this turn: the marker the owner's entry point minted for THIS turn (invocation/owner-spoke.ts: the desktop composer, the paired phone, the paired Telegram chat, the personal agent's screen).
  // In the personal agent's own conversation the supervisor's sealed provenance counts too (its reply turn); a turn that came in another way, with neither, is not the owner's and Personal says `not_here`.
  const owner = base ? (base.ownerSpoke === true || (caller.kind === "personal" && caller.ownerTurn === true)) : false;
  const otherToolsRan = facts ? facts.otherToolsRan() : false;
  const inputsRead = facts ? facts.inputsRead() : false;
  const roomContent = facts?.roomContent ? facts.roomContent() : false;
  const visible = shownLines(key);
  const host: TicketHostFacts = {
    conversation, turn_source: owner ? "owner" : "unknown", project_bound: Boolean(base?.projectPath), owner_text: facts ? facts.ownerText() : null,
    outside_text: inputsRead || otherToolsRan, tools_ran: otherToolsRan, receipt: false, visible,
  };
  const receipt = receiveTickets(ticketArgsFromOldNote(input.args), host);
  if (!receipt) return { tickets: [], unreadable: "tickets_unavailable" };
  if (receipt.counts.received > 0) noteTurnTickets(key, receipt.counts.received);
  // The context every write of this call uses: the turn's own, with the two facts the receiver decided so the write path and the answer cannot disagree.
  const context: CurationContext | null = base ? { ...base, ownerSpoke: owner, ...(caller.kind === "personal" ? { personalConversation: true } : {}), turnFacts: { toolsRan: otherToolsRan, inputsRead } } : null;
  const subject: ForgetSubject | undefined = base ? { personal: caller.kind === "personal", agentId: base.agentId, projectId: base.projectId, projectPath: base.projectPath } : undefined;
  const { answers, total, writtenIds } = applyTicketReceipt({ receipt, context, subject, ownerText: facts?.ownerText() ?? undefined, roomContent, visible, dryRun: input.dryRun });
  if (!input.dryRun) addTurnToolWrites(key, total, writtenIds);
  noteTurnMemoryCall(key);
  return { tickets: answers, ...(receipt.unreadable ? { unreadable: receipt.unreadable } : {}) };
}
