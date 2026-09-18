import Database from "better-sqlite3";
import { lstatSync, realpathSync } from "node:fs";
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
