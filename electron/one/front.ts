import {
  ONE_FRONT_NOTICE_RESOLUTIONS,
  ONE_FRONT_SELECTION,
  PERSONAL_AGENT_FRONTS,
  defaultOneFrontState,
  isOneFrontState,
  oneFrontEffective,
  type AcknowledgeOneFrontNoticeInput,
  type OneFrontFallbackCause,
  type OneFrontState,
  type OneFrontView,
  type SetOneFrontInput,
} from "../../shared/one-front";
import type { RuntimeSelection } from "../../shared/types";
import { emitDesktopStoreChange } from "../store/change-bus";
import { getDb } from "../store/db";
import { listModelRoleMembers } from "../store/model-roles";
import { getOneProfile, oneScopedMetaKey } from "../store/one-profile";

/**
 * Where Hope's conversation turns run (shared/one-front.ts). One row per account, beside the One profile, so an account
 * that opted in never carries that choice to another account on the same machine (oneScopedMetaKey).
 *
 * Fail closed: a missing, damaged or unreadable row is the default (own lane, notice unseen). A reply turn never throws
 * because of it, and a damaged row is not overwritten by a read.
 */
export const ONE_FRONT_META_KEY = "agentlas.one.front.v1";

type Row = { value: string } | undefined;

function read(): { raw: string | null; state: OneFrontState; damaged: boolean } {
  const row = getDb().prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(oneScopedMetaKey(ONE_FRONT_META_KEY)) as Row;
  if (!row) return { raw: null, state: defaultOneFrontState(), damaged: false };
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (isOneFrontState(parsed)) return { raw: row.value, state: parsed, damaged: false };
  } catch { /* falls through to the default; the stored row is left as it is */ }
  return { raw: row.value, state: defaultOneFrontState(), damaged: true };
}

/** A stored row that does not parse is never replaced by a guess. */
function assertWritable(read_: { damaged: boolean }): void {
  if (read_.damaged) throw new Error("Stored personal agent front state is corrupt; it was not overwritten");
}

function commit(raw: string | null, next: OneFrontState, entity: boolean): OneFrontState {
  if (!isOneFrontState(next)) throw new Error("Refused to persist invalid personal agent front state");
  const key = oneScopedMetaKey(ONE_FRONT_META_KEY);
  const db = getDb();
  const json = JSON.stringify(next);
  const changes = raw === null
    ? db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(key, json).changes
    : db.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?").run(json, key, raw).changes;
  if (changes !== 1) throw new Error("Personal agent front state changed concurrently; refresh and retry");
  if (entity) emitDesktopStoreChange({ entity: "one-profile" });
  return next;
}

function nextStamp(previous: number): { version: number; iso: string } {
  const version = Math.max(Date.now(), previous + 1);
  return { version, iso: new Date(version).toISOString() };
}

function assertInput(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Invalid ${label}`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) throw new TypeError(`${label} contains unsupported fields`);
  if (!Number.isSafeInteger(record.expectedVersion) || (record.expectedVersion as number) <= 0) throw new TypeError("expectedVersion must be a positive safe integer");
  if (record.confirmedByUser !== true) throw new Error(`${label} requires an explicit user confirmation`);
  return record;
}

/**
 * Another runtime for the owner to continue on: a member of the orchestrator pool that is not the serving endpoint, or the
 * runtime the owner pinned on the personal conversation's chip (the own lane a front turn falls back to first).
 */
function ownLaneAvailable(): boolean {
  try {
    if (listModelRoleMembers("orchestrator").some(member => member.selection.kind !== "agentlas")) return true;
  } catch { /* fall through to the chip pin */ }
  try {
    const row = getDb().prepare(`SELECT c.runtime_selection_json AS pin FROM one_supervisor_conversations o
      JOIN chats c ON c.id = o.chat_id WHERE o.one_id = ? LIMIT 1`).get(getOneProfile().oneId) as { pin: string | null } | undefined;
    const kind = row?.pin ? (JSON.parse(row.pin) as { kind?: unknown }).kind : null;
    return typeof kind === "string" && kind !== "agentlas";
  } catch { return false; }
}

export function getOneFrontView(): OneFrontView {
  const { state } = read();
  return { ...state, effective: oneFrontEffective(state), ownLaneAvailable: ownLaneAvailable() };
}

export function getOneFrontState(): OneFrontState {
  return read().state;
}

/**
 * The owner chose the front in Settings. Turning it on does not send anything yet: the one-time notice still has to be
 * confirmed (unseen). After the notice has been answered once, a later switch is informed by the Settings row's own text,
 * so it takes effect at once (a declined owner who turns it on again has read the same words there).
 */
export function setOneFront(input: SetOneFrontInput): OneFrontView {
  const value = assertInput(input, ["expectedVersion", "front", "confirmedByUser"], "personal agent front change");
  if (!PERSONAL_AGENT_FRONTS.includes(value.front as never)) throw new TypeError("Invalid personal agent front");
  const current = read();
  assertWritable(current);
  const { raw, state } = current;
  if (state.version !== value.expectedVersion) throw new Error(`Personal agent front state changed (expected ${String(value.expectedVersion)}, current ${state.version})`);
  const front = value.front as OneFrontState["front"];
  const notice = front === "agentlas" && state.notice === "declined" ? "confirmed" : state.notice;
  if (front === state.front && notice === state.notice && state.fallback === null) return { ...state, effective: oneFrontEffective(state), ownLaneAvailable: ownLaneAvailable() };
  const stamp = nextStamp(state.version);
  const next = commit(raw, { ...state, version: stamp.version, front, notice, fallback: null, updatedAt: stamp.iso }, true);
  return { ...next, effective: oneFrontEffective(next), ownLaneAvailable: ownLaneAvailable() };
}

/**
 * The owner answered the one-time notice. "confirm" lets the front run; "keep-own-lane" turns it off again and records
 * that the notice was answered, so it is not shown a second time.
 */
export function acknowledgeOneFrontNotice(input: AcknowledgeOneFrontNoticeInput): OneFrontView {
  const value = assertInput(input, ["expectedVersion", "resolution", "confirmedByUser"], "personal agent front notice answer");
  if (!ONE_FRONT_NOTICE_RESOLUTIONS.includes(value.resolution as never)) throw new TypeError("Invalid personal agent front notice resolution");
  const current = read();
  assertWritable(current);
  const { raw, state } = current;
  const confirm = value.resolution === "confirm";
  const target = confirm ? { front: "agentlas" as const, notice: "confirmed" as const } : { front: "own-lane" as const, notice: "declined" as const };
  // The same answer twice is the same answer: a delayed second click must not fail the owner.
  if (state.front === target.front && state.notice === target.notice) return { ...state, effective: oneFrontEffective(state), ownLaneAvailable: ownLaneAvailable() };
  if (state.version !== value.expectedVersion) throw new Error(`Personal agent front state changed (expected ${String(value.expectedVersion)}, current ${state.version})`);
  // Confirming a notice for a front the owner has not asked for would opt them in without a choice.
  if (confirm && state.front !== "agentlas") throw new Error("The personal agent front is not turned on");
  const stamp = nextStamp(state.version);
  const next = commit(raw, { ...state, version: stamp.version, ...target, fallback: null, updatedAt: stamp.iso }, true);
  return { ...next, effective: oneFrontEffective(next), ownLaneAvailable: ownLaneAvailable() };
}

/** The selection Hope's next conversation turn carries, or null for the owner's own lane. Never throws. */
export function oneFrontRuntimeSelection(): RuntimeSelection | null {
  try {
    return oneFrontEffective(read().state) ? { ...ONE_FRONT_SELECTION } : null;
  } catch { return null; }
}

/** A turn left the light model for the owner's own lane. Best effort: the turn does not wait on, or fail from, this. */
export function noteOneFrontFallback(cause: OneFrontFallbackCause): void {
  try {
    const { raw, state, damaged } = read();
    if (damaged || !oneFrontEffective(state) || raw === null) return;
    if (state.fallback?.cause === cause) return;
    const stamp = nextStamp(state.version);
    commit(raw, { ...state, version: stamp.version, fallback: { cause, at: stamp.iso }, updatedAt: stamp.iso }, true);
  } catch { /* the notice is a convenience; the next turn records it again */ }
}

/** The light model answered a turn, so an earlier fallback no longer describes it. Best effort. */
export function clearOneFrontFallback(): void {
  try {
    const { raw, state, damaged } = read();
    if (damaged || raw === null || state.fallback === null) return;
    const stamp = nextStamp(state.version);
    commit(raw, { ...state, version: stamp.version, fallback: null, updatedAt: stamp.iso }, true);
  } catch { /* the next success clears it */ }
}
