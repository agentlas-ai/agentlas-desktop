import type Database from "better-sqlite3";
import type { PhoneToolBinding } from "../mobile-bridge/personal-one-phone-tools";

/** Main-authenticated origin of one owner's command. This value is never accepted from the phone body. */
export type PhoneCommandOrigin = Omit<PhoneToolBinding, "runId">;
const names = ["userId", "workspaceId", "accountSubject", "deviceId", "hostId", "oneId", "generation"] as const;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:@-]{1,128}$/.test(value);
const commandIdentifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(value);
export function validPhoneCommandOrigin(origin: unknown): origin is PhoneCommandOrigin {
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return false;
  const value = origin as Record<string, unknown>;
  return Object.keys(value).length === names.length && names.every((name) => identifier(value[name]));
}

/** Create before command admission. No private phone data or tool result is stored here. */
export function ensurePhoneOriginStore(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS one_phone_command_origins (
    command_id TEXT PRIMARY KEY, one_id TEXT NOT NULL, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    account_subject TEXT NOT NULL, device_id TEXT NOT NULL, host_id TEXT NOT NULL, generation TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS one_phone_command_origin_delete AFTER DELETE ON one_supervisor_requests BEGIN
    DELETE FROM one_phone_command_origins WHERE command_id=OLD.command_id;
  END;`);
}

/** Must run in the same transaction as the new supervisor command. Never overwrite a replay. */
export function insertPhoneCommandOrigin(db: Database.Database, commandId: string, oneId: string, origin: PhoneCommandOrigin): void {
  if (!commandIdentifier(commandId) || !identifier(oneId) || !validPhoneCommandOrigin(origin) || origin.oneId !== oneId) throw new Error("phone_origin_invalid");
  db.prepare(`INSERT INTO one_phone_command_origins(command_id,one_id,user_id,workspace_id,account_subject,device_id,host_id,generation)
    VALUES(?,?,?,?,?,?,?,?)`).run(commandId, oneId, origin.userId, origin.workspaceId, origin.accountSubject, origin.deviceId, origin.hostId, origin.generation);
}

/** Resolves the saved host source only for the exact still-live supervisor run. */
export function phoneOriginForRun(db: Database.Database, oneId: string, runId: string): PhoneToolBinding | null {
  if (!identifier(oneId) || !identifier(runId)) return null;
  const row = db.prepare(`SELECT o.user_id AS userId,o.workspace_id AS workspaceId,o.account_subject AS accountSubject,
    o.device_id AS deviceId,o.host_id AS hostId,o.one_id AS oneId,o.generation AS generation,r.run_id AS runId
    FROM one_phone_command_origins o JOIN one_supervisor_requests r ON r.command_id=o.command_id AND r.one_id=o.one_id
    WHERE o.one_id=? AND r.run_id=? AND r.kind='reply' AND r.state IN ('dispatching','accepted') LIMIT 2`).all(oneId, runId) as PhoneToolBinding[];
  return row.length === 1 && validPhoneCommandOrigin(Object.fromEntries(names.map((name) => [name, row[0][name]]))) ? row[0] : null;
}
