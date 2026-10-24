import Database from "better-sqlite3";
import { lstatSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// agy's NDJSON maps EPHEMERAL_MESSAGE (protobuf enum 90) to "unknown".
// Its persisted step keeps the typed oneof: field 103, containing text field 1.
// Never treat an arbitrary empty/unknown stream frame as a harmless message.
function ephemeralPayload(bytes: unknown): boolean {
  if (!Buffer.isBuffer(bytes) || bytes.length > 2 * 1024 * 1024) return false;
  const fields = (buffer: Buffer): Map<number, number | Buffer> => {
    let offset = 0;
    const result = new Map<number, number | Buffer>();
    const integer = (): number => {
      let value = 0, scale = 1;
      for (let i = 0; i < 8 && offset < buffer.length; i++, scale *= 128) {
        const byte = buffer[offset++]; value += (byte & 127) * scale;
        if (!Number.isSafeInteger(value)) throw new Error("invalid");
        if (!(byte & 128)) return value;
      }
      throw new Error("invalid");
    };
    while (offset < buffer.length) {
      const tag = integer(), field = Math.floor(tag / 8), wire = tag % 8;
      if (!field || result.has(field)) throw new Error("invalid");
      if (wire === 0) result.set(field, integer());
      else if (wire === 2) {
        const length = integer();
        if (length > buffer.length - offset) throw new Error("invalid");
        result.set(field, buffer.subarray(offset, offset + length)); offset += length;
      } else throw new Error("invalid");
    }
    return result;
  };
  try {
    const outer = fields(bytes), body = outer.get(103);
    if (outer.get(1) !== 90 || outer.get(4) !== 3 || !Buffer.isBuffer(outer.get(5)) || !Buffer.isBuffer(body)
      || [...outer.keys()].some(key => ![1, 4, 5, 103].includes(key))) return false;
    const message = fields(body);
    return message.size === 1 && Buffer.isBuffer(message.get(1));
  } catch { return false; }
}

const AGY_CONVERSATION_ID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** The HOME agy reads for this run's environment (Go's os.UserHomeDir: USERPROFILE on Windows, HOME elsewhere). */
export function antigravityConversationHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir();
}

/**
 * Whether agy no longer holds a conversation, from the filesystem only (never from its output text).
 *
 * agy keeps every conversation in <HOME>/.gemini/antigravity-cli/conversations/<id>.db (the store
 * attestAntigravityMetadataSteps reads). Measured 2026-10-16 on agy 1.4.0 with a scratch product HOME:
 * `--conversation <id>` for an id it has no file for writes a stderr warning, exits 0 and runs the turn in a NEW
 * conversation (another conversation_id from the first `init` event on) that holds none of the earlier turns.
 * The owner's storage policy deletes CLI originals unused for 30 days and agy prunes its own store, so this is routine.
 *
 * Gone means: the store folder exists and holds neither `<id>.db` nor an `<id>` entry. An id of another shape, a
 * missing or unreadable store (a layout this build does not know, a HOME agy never ran in) answers false: the turn
 * then still checks the conversation id agy reports for the run.
 */
export function antigravityConversationGone(home: string, conversationId: string): boolean {
  if (!AGY_CONVERSATION_ID_RE.test(conversationId)) return false;
  const directory = path.join(home, ".gemini", "antigravity-cli", "conversations");
  try {
    if (!statSync(directory).isDirectory()) return false;
  } catch { return false; }
  for (const name of [`${conversationId}.db`, conversationId]) {
    try { lstatSync(path.join(directory, name)); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
  }
  return true;
}

/** Read only this CLI conversation's bounded typed metadata after process exit.
 * Missing/new formats remain uncertain; no transcript, instructions or output
 * text is interpreted, returned, or written into the invocation ledger. */
export function attestAntigravityMetadataSteps(conversationId: string, indices: readonly number[], home = os.homedir()): boolean {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(conversationId)
    || indices.length > 4096 || indices.some(index => !Number.isSafeInteger(index) || index < 0)) return false;
  let db: Database.Database | undefined;
  try {
    const directory = path.join(home, ".gemini", "antigravity-cli", "conversations");
    const filename = path.join(directory, `${conversationId}.db`);
    for (const part of [path.join(home, ".gemini"), path.join(home, ".gemini", "antigravity-cli"), directory]) {
      if (!lstatSync(part).isDirectory()) return false;
    }
    if (!lstatSync(filename).isFile() || path.dirname(realpathSync(filename)) !== realpathSync(directory)) return false;
    db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 100 });
    const statement = db.prepare("SELECT step_type, status, has_subtrajectory, step_format, error_details, permissions, task_details, step_payload FROM steps WHERE idx = ?");
    return db.transaction(() => indices.every(index => {
      const row = statement.get(index) as Record<string, unknown> | undefined;
      return row?.step_type === 90 && row.status === 3 && row.has_subtrajectory === 0 && row.step_format === 0
        && row.error_details == null && row.permissions == null && row.task_details == null && ephemeralPayload(row.step_payload);
    }))();
  } catch { return false; }
  finally { db?.close(); }
}

/**
 * agy's StopReason (exa.codeium_common_pb.StopReason): the typed reason it persists on every answer attempt of a turn, in the
 * planner-response step (step_type 15, payload field 20, whose field 12 is the stop reason). The enum is read from the
 * descriptor embedded in the agy binary; the values below are measured on agy 1.4.3 (2026-10-21) against the real CLI behind
 * its documented GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL switch with a local fake model API: every safety-class finish of the
 * model API (SAFETY, PROHIBITED_CONTENT, BLOCKLIST, SPII, RECITATION, IMAGE_SAFETY) is stored as 11 (CONTENT_FILTER), a
 * malformed function call as 14 (IMPROPER_FORMAT), a normal reply as 2 (STOP_PATTERN). Nothing else tells a safety block
 * from any other executor failure: result.error is one sentence, the error_message steps carry no field, and AGY_ERROR on
 * stderr is UNKNOWN / gRPC 2 for both. The stream frame of the same step carries only its index (step_update.step_index).
 */
export const AGY_STOP_REASON_CONTENT_FILTER = 11;

/** The machine code this host names for a persisted agy stop reason. Every other value stays unnamed (no code). */
export function antigravityStopReasonCode(stopReason: number | undefined): string | undefined {
  return stopReason === AGY_STOP_REASON_CONTENT_FILTER ? "STOP_REASON_CONTENT_FILTER" : undefined;
}

/** HOMEs whose store can hold a run's conversation: the person's real HOME behind a product mirror (the mirror links its
 *  conversations to it), the HOME the CLI ran with, and this process's HOME. */
export function antigravityStoreHomes(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  return [...new Set([env.AGENTLAS_AGY_REAL_HOME, antigravityConversationHome(env, platform), os.homedir()]
    .filter((home): home is string => typeof home === "string" && home.length > 0))];
}

const AGY_PLANNER_RESPONSE_STEP_TYPE = 15;
const AGY_STEP_STATUS_DONE = 3;
const AGY_PLANNER_RESPONSE_FIELD = 20;
const AGY_STOP_REASON_FIELD = 12;
const AGY_STEP_PAYLOAD_MAX_BYTES = 8 * 1024 * 1024;
const AGY_STOP_REASON_MAX = 1023;

/** The wanted top-level fields (varints and length-delimited bytes) of one protobuf message; undefined unless the bytes are one clean message. */
function wireFields(buffer: Buffer, wanted: ReadonlySet<number>): Map<number, Array<number | Buffer>> | undefined {
  const found = new Map<number, Array<number | Buffer>>();
  let offset = 0;
  const varint = (): number | undefined => {
    let value = 0, scale = 1;
    for (let i = 0; i < 10 && offset < buffer.length; i++, scale *= 128) {
      const byte = buffer[offset++]!;
      value += (byte & 127) * scale;
      if (!(byte & 128)) return Number.isSafeInteger(value) ? value : undefined;
    }
    return undefined;
  };
  for (let count = 0; offset < buffer.length; count++) {
    if (count >= 100_000) return undefined;
    const tag = varint();
    if (tag === undefined) return undefined;
    const field = Math.floor(tag / 8), wire = tag % 8;
    if (field === 0) return undefined;
    let value: number | Buffer | undefined;
    if (wire === 0) {
      value = varint();
      if (value === undefined) return undefined;
    } else if (wire === 2) {
      const length = varint();
      if (length === undefined || length > buffer.length - offset) return undefined;
      value = buffer.subarray(offset, offset + length);
      offset += length;
    } else if (wire === 1 || wire === 5) {
      const width = wire === 1 ? 8 : 4;
      if (offset + width > buffer.length) return undefined;
      offset += width;
    } else return undefined;
    if (value !== undefined && wanted.has(field)) {
      const list = found.get(field) ?? [];
      list.push(value);
      found.set(field, list);
    }
  }
  return found;
}

function readStopReasonFrom(home: string, conversationId: string, stepIndex: number): number | undefined {
  let db: Database.Database | undefined;
  try {
    const directory = path.join(home, ".gemini", "antigravity-cli", "conversations");
    const filename = path.join(directory, `${conversationId}.db`);
    for (const part of [path.join(home, ".gemini"), path.join(home, ".gemini", "antigravity-cli"), directory]) {
      if (!lstatSync(part).isDirectory()) return undefined;
    }
    if (!lstatSync(filename).isFile() || path.dirname(realpathSync(filename)) !== realpathSync(directory)) return undefined;
    db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 100 });
    const row = db.prepare(
      "SELECT step_type, status, step_format, step_payload FROM steps WHERE idx = ? AND length(step_payload) <= ?",
    ).get(stepIndex, AGY_STEP_PAYLOAD_MAX_BYTES) as Record<string, unknown> | undefined;
    if (!row || row.step_type !== AGY_PLANNER_RESPONSE_STEP_TYPE || row.status !== AGY_STEP_STATUS_DONE
      || row.step_format !== 0 || !Buffer.isBuffer(row.step_payload)) return undefined;
    // The attempt is where the conversation ended: at most the error step that follows it. A later step means the turn went
    // on after this attempt (another call failed differently), so this attempt's stop reason is not why the turn ended.
    const tail = db.prepare("SELECT MAX(idx) AS last FROM steps").get() as { last?: unknown } | undefined;
    if (typeof tail?.last !== "number" || tail.last > stepIndex + 1) return undefined;
    const outer = wireFields(row.step_payload, new Set([1, AGY_PLANNER_RESPONSE_FIELD]));
    const type = outer?.get(1), planner = outer?.get(AGY_PLANNER_RESPONSE_FIELD);
    if (!type || type.length !== 1 || type[0] !== AGY_PLANNER_RESPONSE_STEP_TYPE
      || !planner || planner.length !== 1 || !Buffer.isBuffer(planner[0])) return undefined;
    const reasons = wireFields(planner[0], new Set([AGY_STOP_REASON_FIELD]))?.get(AGY_STOP_REASON_FIELD);
    const reason = reasons?.length === 1 ? reasons[0] : undefined;
    return typeof reason === "number" && reason >= 0 && reason <= AGY_STOP_REASON_MAX ? reason : undefined;
  } catch { return undefined; }
  finally { db?.close(); }
}

/**
 * The stop reason agy persisted on one answer step of a conversation, read after the turn's result (the store is current
 * 20 ms after the result frame even while a resident process is alive; measured). `stepIndex` is the step_index of the
 * turn's own last agent_response frame, so a step of an earlier turn is never read for this one, and the attempt must be where
 * the conversation ended (at most its own error step follows), so an attempt the turn went on from is never taken for its
 * cause. Read-only and bounded like attestAntigravityMetadataSteps; a missing store, another layout, another step type or an
 * ambiguous payload answers undefined, which leaves the failure exactly as it was.
 */
export function readAntigravityAnswerStopReason(conversationId: string, stepIndex: number, homes: readonly string[]): number | undefined {
  if (!AGY_CONVERSATION_ID_RE.test(conversationId) || !Number.isSafeInteger(stepIndex) || stepIndex < 0) return undefined;
  for (const home of homes) {
    const reason = readStopReasonFrom(home, conversationId, stepIndex);
    if (reason !== undefined) return reason;
  }
  return undefined;
}
