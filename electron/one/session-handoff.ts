// Shared-result continuation only. This does not read a teammate's private
// checkpoint, memory, prior conversation, tool arguments or execution grant.
import { getDb } from "../store/db";
import { looksSecret } from "../../shared/secret-patterns";

export interface TeamHandoffSource {
  dispatchId: string; roomChatId: string; childRunId: string;
  parentRunId?: string | null; childChatId?: string; memberAgentId?: string;
  memberName: string; brief: string; status: string; result: string | null;
}
interface TurnDigest { text: string; eventId: string }
type OwnerBinding = { ownerScope: string; serviceIdentity: string };
export interface TeamSessionHandoff {
  schemaVersion: "agentlas.team-session-handoff.v1";
  relayAllowed: boolean;
  withheldReason?: "source_unavailable" | "source_mismatch" | "owner_unavailable" | "owner_mismatch" | "owner_changed" | "receiver_unbound";
  member: string; brief: string; briefIsExcerpt: boolean; state: string;
  result: string | null;
  representation: "emitter_turn_digest" | "host_result_excerpt" | "none";
  resultIsExcerpt: boolean; retainedResultChars: number;
  resultRef: { dispatchId: string; roomChatId: string; childChatId?: string; childRunId: string } | null;
  digestEventRef?: string;
}
const MAX_ID_BYTES = 512;
export const TEAM_HANDOFF_MAX_BYTES = 4 * 1024;
const jsonBytes = (value: string) => Buffer.byteLength(JSON.stringify(value)) - 2;
const validRef = (value: unknown): value is string => typeof value === "string" && !!value.trim()
  && Buffer.byteLength(value) <= MAX_ID_BYTES && !/[\u0000-\u001f]/.test(value);
function takeBytes(text: string, budget: number, tail = false): string {
  const chars = [...text]; if (tail) chars.reverse();
  const kept: string[] = []; let bytes = 0;
  for (const char of chars) { const size = jsonBytes(char); if (bytes + size > budget) break; kept.push(char); bytes += size; }
  return (tail ? kept.reverse() : kept).join("");
}
function excerpt(text: string, budget: number): { text: string; shortened: boolean } {
  if (jsonBytes(text) <= budget) return { text, shortened: false };
  const omitted = "\n[excerpt; middle omitted, original retained at resultRef]\n";
  const remaining = budget - jsonBytes(omitted), head = Math.floor(remaining * 0.65);
  return { text: takeBytes(text, head) + omitted + takeBytes(text, remaining - head, true), shortened: true };
}
/** Original host identity, never an actor label or a model-supplied owner. */
export function teamDispatchOwnerScope(): string {
  return ownerBinding().ownerScope;
}
function ownerBinding(): OwnerBinding {
  const { agentContextOwnerBinding } = require("../runtime/agent-context-admission") as typeof import("../runtime/agent-context-admission");
  return agentContextOwnerBinding();
}
function sameOwner(owner: OwnerBinding): boolean {
  const latest = ownerBinding();
  return latest.ownerScope === owner.ownerScope && latest.serviceIdentity === owner.serviceIdentity;
}
/** Legacy rows require an existing native personal-conversation or exact
 * current One chat-send receipt. Mere existence of a room is not custody. */
function legacyReceiverBound(roomChatId: string, parentRunId?: string | null): boolean {
  try {
    const db = getDb();
    const { getOneProfile } = require("../store/one-profile") as typeof import("../store/one-profile");
    const oneId = getOneProfile().oneId;
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_supervisor_conversations'").get()
      && db.prepare("SELECT 1 FROM one_supervisor_conversations WHERE one_id=? AND chat_id=?").get(oneId,roomChatId)) return true;
    return !!parentRunId && !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_supervisor_requests'").get()
      && !!db.prepare(`SELECT 1 FROM one_supervisor_requests WHERE one_id=? AND kind='chat-send' AND run_id=?
        AND json_valid(payload_json) AND json_extract(payload_json,'$.chatId')=?`).get(oneId,parentRunId,roomChatId);
  } catch { return false; }
}
export function teamDispatchReceiverCurrent(source: { roomChatId: string; parentRunId?: string | null; ownerScope?: string | null }): boolean {
  try {
    const owner = ownerBinding();
    const authorized = source.ownerScope ? source.ownerScope === owner.ownerScope : legacyReceiverBound(source.roomChatId,source.parentRunId);
    return authorized && sameOwner(owner);
  } catch { return false; }
}
/**
 * The journals a dispatch child's turns went to: its own two old domains, and the domain its member's seat scope assigned (a roster
 * member's dispatch child writes to the member's session, which may carry another conversation's domain string; runtime/session-scope.ts).
 * Reading only. The scope module is read when needed, like this file's other collaborators; without it (or when it cannot read) the
 * answer is the two old domains, which is what this lookup always used.
 */
function childJournalDomains(db: ReturnType<typeof getDb>, ownerScope: string, roomChatId: string, childChatId: string, memberAgentId: string): string[] {
  const own = [`one-team:${roomChatId}:session:${childChatId}`, `chat:${childChatId}`];
  try {
    const { journalDomainsOfConversation } = require("../runtime/session-scope") as typeof import("../runtime/session-scope");
    return [...new Set([...own, ...journalDomainsOfConversation(db, { ownerScope, agentId: memberAgentId, chatId: childChatId, kind: "division", parentChatId: roomChatId })])];
  } catch { return own; }
}
type ReadResult = { allowed: true; digest: TurnDigest | null; brief: string }
  | { allowed: false; reason: NonNullable<TeamSessionHandoff["withheldReason"]> };
function readRecordedTurnDigest(source: TeamHandoffSource): ReadResult {
  if (![source.dispatchId,source.roomChatId,source.childRunId].every(validRef)) return {allowed:false,reason:"source_mismatch"};
  let owner: OwnerBinding;
  try { owner = ownerBinding(); } catch { return {allowed:false,reason:"owner_unavailable"}; }
  try {
    const db = getDb();
    type Recorded = { child_chat_id: string; member_agent_id: string; result_text: string | null;
      brief?: string; parent_run_id?: string | null; owner_scope?: string | null };
    const recorded = (db.prepare(`SELECT * FROM one_team_dispatches
      WHERE id=? AND parent_chat_id=? AND child_run_id=? AND status=?`)
      .get(source.dispatchId,source.roomChatId,source.childRunId,source.status)
      ?? db.prepare(`SELECT * FROM one_team_dispatch_results
        WHERE id=? AND parent_chat_id=? AND child_run_id=? AND status=?`)
        .get(source.dispatchId,source.roomChatId,source.childRunId,source.status)) as Recorded | undefined;
    if (!recorded || recorded.result_text !== source.result
      || (recorded.brief !== undefined && recorded.brief !== null && recorded.brief !== source.brief)
      || (source.parentRunId !== undefined && recorded.parent_run_id !== undefined && recorded.parent_run_id !== source.parentRunId)
      || (source.childChatId !== undefined && source.childChatId !== recorded.child_chat_id)
      || (source.memberAgentId !== undefined && source.memberAgentId !== recorded.member_agent_id)) return {allowed:false,reason:"source_mismatch"};
    if (recorded.owner_scope && recorded.owner_scope !== owner.ownerScope) return {allowed:false,reason:"owner_mismatch"};
    const prefix = "agent-context-turn:";
    const runWhere = `substr(d.turn_id,1,?)=? AND json_valid(substr(d.turn_id,?))
      AND CASE WHEN json_valid(substr(d.turn_id,?)) THEN json_array_length(substr(d.turn_id,?))=3
        AND json_extract(substr(d.turn_id,?),'$[0]')=? AND json_extract(substr(d.turn_id,?),'$[1]')=?
        AND json_type(substr(d.turn_id,?),'$[2]')='integer'
        AND json_extract(substr(d.turn_id,?),'$[2]') BETWEEN 1 AND 9007199254740991 ELSE 0 END`;
    const runArgs = [prefix.length,prefix,prefix.length+1,prefix.length+1,prefix.length+1,
      prefix.length+1,recorded.child_chat_id,prefix.length+1,source.childRunId,prefix.length+1,prefix.length+1];
    // Query custody metadata before selecting any summary. A known foreign
    // source can never fall back to the retained body under a different owner.
    const hasJournal = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_context_heads'").get();
    const domains = childJournalDomains(db, owner.ownerScope, source.roomChatId, recorded.child_chat_id, recorded.member_agent_id);
    const marks = domains.map(() => "?").join(",");
    const owners = hasJournal ? db.prepare(`SELECT DISTINCT json_extract(h.identity_json,'$.ownerScope') AS owner
      FROM agent_context_heads h JOIN agent_context_deliveries d ON d.context_key=h.context_key
      WHERE json_extract(h.identity_json,'$.agentId')=? AND json_extract(h.identity_json,'$.visibilityDomain') IN (${marks})
        AND ${runWhere}`).all(recorded.member_agent_id,...domains,...runArgs) as Array<{owner:unknown}> : [];
    if (owners.some(row => row.owner !== owner.ownerScope)) return {allowed:false,reason:"owner_mismatch"};
    const receiverBound = recorded.owner_scope === owner.ownerScope || legacyReceiverBound(source.roomChatId,recorded.parent_run_id);
    if (!receiverBound) return {allowed:false,reason:"receiver_unbound"};
    let digest: TurnDigest | null = null;
    if (hasJournal && source.status === "completed" && source.result !== null) {
      // Join order is fixed with CROSS JOIN (heads -> deliveries -> entries by its UNIQUE(context_key,event_id) index). Left to the
      // planner, this statement drove from agent_context_entries ("SCAN e": every row of the journal, ~0.5 GB on the owner store)
      // once per completed dispatch, and oneTeamList asks for up to 20 of them on Main: 2.3 s cold / 0.08 s warm each, i.e. the 5-16 s
      // hourly stalls that lined up with the AGI team_roster read (observed in use). Same rows, same order; e.rowid ASC
      // reproduces the tie order the entries scan produced (SQLite's sorter keeps input order for equal keys).
      const rows = db.prepare(`SELECT e.event_id,json_extract(e.payload_json,'$.turnSummary') AS summary,d.turn_id
        FROM agent_context_heads h CROSS JOIN agent_context_deliveries d CROSS JOIN agent_context_entries e
        WHERE d.context_key=h.context_key AND e.context_key=d.context_key AND e.producer_binding=d.binding_key
          AND e.event_id='turn:'||d.turn_id||':output'
          AND e.kind='message' AND json_extract(h.identity_json,'$.ownerScope')=?
          AND json_extract(h.identity_json,'$.agentId')=? AND json_extract(h.identity_json,'$.visibilityDomain') IN (${marks})
          AND json_extract(e.payload_json,'$.turnSummarySource')='emitter'
          AND json_extract(e.payload_json,'$.role')='assistant' AND json_extract(e.payload_json,'$.turnId')=d.turn_id
          AND d.status='acknowledged' AND d.receipt_id='completed:'||d.turn_id AND ${runWhere}
        ORDER BY h.updated_at DESC,e.seq DESC,e.rowid ASC LIMIT 8`).all(owner.ownerScope,recorded.member_agent_id,...domains,...runArgs) as
          Array<{event_id:string;summary:unknown;turn_id:string}>;
      for (const row of rows) {
        if (typeof row.summary === "string" && row.summary.trim() && jsonBytes(row.summary) <= 1024
          && !looksSecret(row.summary) && validRef(row.event_id)) {digest={text:row.summary.trim(),eventId:row.event_id};break;}
      }
    }
    if (!sameOwner(owner)) return {allowed:false,reason:"owner_changed"};
    return {allowed:true,digest,brief:recorded.brief ?? ""};
  } catch { return {allowed:false,reason:"source_unavailable"}; }
}
/** Bounded data projection; original retained results/status and control APIs
 * are unchanged. It never starts a model, executes a task or grants a read. */
export function buildTeamSessionHandoff(source: TeamHandoffSource): TeamSessionHandoff {
  const read = readRecordedTurnDigest(source);
  if (!read.allowed) return {schemaVersion:"agentlas.team-session-handoff.v1",relayAllowed:false,withheldReason:read.reason,
    member:"",brief:"",briefIsExcerpt:false,state:"",result:null,representation:"none",resultIsExcerpt:false,retainedResultChars:0,resultRef:null};
  const brief = excerpt(read.brief,700), body = source.result === null ? null : excerpt(source.result,1536);
  const digest = read.digest;
  const refs = [source.dispatchId,source.roomChatId,source.childRunId].every(validRef)
    ? { dispatchId: source.dispatchId,roomChatId: source.roomChatId,childRunId: source.childRunId,
      ...(validRef(source.childChatId) ? { childChatId: source.childChatId } : {}) } : null;
  const handoff: TeamSessionHandoff = { schemaVersion:"agentlas.team-session-handoff.v1",relayAllowed:true,member:takeBytes(source.memberName,160),
    brief:brief.text,briefIsExcerpt:brief.shortened,state:takeBytes(source.status,80),
    result:digest?.text ?? body?.text ?? null,representation:digest ? "emitter_turn_digest" : body ? "host_result_excerpt" : "none",
    resultIsExcerpt:digest ? true : body?.shortened ?? false,retainedResultChars:source.result?.length ?? 0,resultRef:refs,
    ...(digest ? { digestEventRef:digest.eventId } : {}) };
  // References remain exact or unavailable; never truncate an identifier.
  if (Buffer.byteLength(JSON.stringify(handoff)) > TEAM_HANDOFF_MAX_BYTES) {handoff.resultRef=null;delete handoff.digestEventRef;}
  return handoff;
}
