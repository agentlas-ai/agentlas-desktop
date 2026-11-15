import type Database from "better-sqlite3";
import { appControlPolicy, isAppControlTerminalOperation } from "../app-control/policy";

export type ScienceReplySurface = "desktop" | "mobile" | "unknown";

/** Host-owned ingress record; it carries no credentials or content. */
export function ensureScienceReplyOrigins(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS one_science_reply_origins (
    command_id TEXT PRIMARY KEY, one_id TEXT NOT NULL, surface TEXT NOT NULL CHECK(surface IN ('desktop','mobile','unknown'))
  );
  CREATE TRIGGER IF NOT EXISTS one_science_reply_origin_delete AFTER DELETE ON one_supervisor_requests BEGIN
    DELETE FROM one_science_reply_origins WHERE command_id=OLD.command_id;
  END;`);
}

export function recordScienceReplyOrigin(db: Database.Database, commandId: string, oneId: string, surface: ScienceReplySurface): void {
  db.prepare("INSERT INTO one_science_reply_origins(command_id,one_id,surface) VALUES(?,?,?)").run(commandId, oneId, surface);
}

/**
 * Science is blocked only for a reply PROVEN to come from the phone (the phone never starts Science, and
 * Desktop Science stays as it was). An automation, Telegram, Alive or One check-in turn has no "desktop" record, so the
 * earlier "desktop proof required" rule refused Science on the Desktop itself; missing records, old databases and read
 * errors are therefore not phone proof.
 */
export function scienceReplyIsMobile(db: Database.Database, oneId: string, runId: string, requireLive = true): boolean {
  try {
    const rows = db.prepare(`SELECT o.surface FROM one_science_reply_origins o JOIN one_supervisor_requests r
      ON r.command_id=o.command_id AND r.one_id=o.one_id
      WHERE r.one_id=? AND r.run_id=? AND r.kind='reply' AND (?=0 OR r.state IN ('dispatching','accepted')) LIMIT 2`).all(oneId, runId, requireLive ? 1 : 0) as Array<{surface: string}>;
    return rows.some((row) => row.surface === "mobile");
  } catch { return false; }
}

/** Kept for callers: a reply may use Science unless it is proven to come from the phone. */
export function scienceReplyIsDesktop(db: Database.Database, oneId: string, runId: string, requireLive = true): boolean {
  return !scienceReplyIsMobile(db, oneId, runId, requireLive);
}

/** Read and stop existing work remain available even when execution is not. */
export function scienceAppCallAllowed(operation: string, desktop: boolean, args?: unknown): boolean {
  if (!operation.startsWith("science.") || desktop) return true;
  const policy = appControlPolicy({path: operation});
  return (policy.allowed && policy.effect === "read") || isAppControlTerminalOperation(operation,args);
}

/** Bound Work started by Companion or by a phone One reply retains that source. Only proven phone origin blocks. */
export function scienceWorkRunBlocked(db: Database.Database, chatId: string, runId: string): boolean {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_supervisor_requests'").get()) return false;
    const rows = db.prepare(`SELECT command_id,one_id,source_reply_run_id,json_extract(payload_json,'$.workerChatId') AS chat_id
      FROM one_supervisor_requests WHERE kind='work' AND run_id=? LIMIT 2`).all(runId) as Array<{command_id:string;one_id:string;source_reply_run_id:string|null;chat_id:string|null}>;
    for (const row of rows) {
      if (row.chat_id !== chatId) continue;
      const inbox = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_companion_handoffs'").get();
      if (inbox && db.prepare("SELECT 1 FROM one_companion_handoffs WHERE command_id=?").get(row.command_id)) return true;
      if (row.source_reply_run_id && scienceReplyIsMobile(db, row.one_id, row.source_reply_run_id, false)) return true;
      const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_science_work_origins'").get();
      if (!table) continue;
      const origin=db.prepare("SELECT surface FROM one_science_work_origins WHERE command_id=? AND one_id=?").get(row.command_id,row.one_id) as {surface:ScienceReplySurface}|undefined;
      if (origin?.surface === "mobile") return true;
    }
    return false;
  } catch { return false; }
}

/** Only a host-bound Work delegation with a proven Desktop parent is Desktop evidence. */
export function scienceWorkRunHasDesktopProof(db: Database.Database, chatId: string, runId: string): boolean {
  try {
    const rows=db.prepare(`SELECT command_id,one_id,source_reply_run_id,json_extract(payload_json,'$.workerChatId') AS chat_id
      FROM one_supervisor_requests WHERE kind='work' AND run_id=? LIMIT 2`).all(runId) as Array<{one_id:string;source_reply_run_id:string|null;chat_id:string|null}>;
    return rows.length===1 && rows[0].chat_id===chatId && !scienceWorkRunBlocked(db,chatId,runId);
  } catch { return false; }
}

/** Trusted ingress records direct Work source in the same transaction as its journal entry. */
export function ensureScienceWorkOrigins(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS one_science_work_origins (
    command_id TEXT PRIMARY KEY, one_id TEXT NOT NULL, surface TEXT NOT NULL CHECK(surface IN ('desktop','mobile'))
  );
  CREATE TRIGGER IF NOT EXISTS one_science_work_origin_delete AFTER DELETE ON one_supervisor_requests BEGIN
    DELETE FROM one_science_work_origins WHERE command_id=OLD.command_id;
  END;`);
}
export function recordScienceWorkOrigin(db: Database.Database, commandId: string, oneId: string, surface: "desktop"|"mobile"): void {
  db.prepare("INSERT INTO one_science_work_origins(command_id,one_id,surface) VALUES(?,?,?)").run(commandId,oneId,surface);
}

/** A host-recorded run source survives a process restart and contains no prompt or device data. */
export function recordScienceHostRun(db: Database.Database, chatId: string, runId: string, source: ScienceReplySurface): void {
  if (!chatId || !runId || !["desktop", "mobile", "unknown"].includes(source)) throw new Error("science_run_origin_invalid");
  db.exec(`CREATE TABLE IF NOT EXISTS one_science_run_origins (
    run_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, surface TEXT NOT NULL CHECK(surface IN ('desktop','mobile','unknown'))
  );
  CREATE TRIGGER IF NOT EXISTS one_science_run_origin_delete AFTER DELETE ON chats BEGIN
    DELETE FROM one_science_run_origins WHERE chat_id=OLD.id;
  END;`);
  const row = db.prepare("SELECT chat_id,surface FROM one_science_run_origins WHERE run_id=?").get(runId) as {chat_id:string;surface:ScienceReplySurface}|undefined;
  if (row && (row.chat_id !== chatId || row.surface !== source)) throw new Error("science_run_origin_conflict");
  if (!row) db.prepare("INSERT INTO one_science_run_origins(run_id,chat_id,surface) VALUES(?,?,?)").run(runId,chatId,source);
}

/** Follow the host's child ledger, never a run ID supplied by the model. */
export function scienceHostRunBlocked(db: Database.Database, chatId: string, runId: string): boolean {
  try {
    const seen = new Set<string>();
    for (let depth=0; depth<32; depth++) {
      const key=JSON.stringify([chatId,runId]);
      if (seen.has(key)) return false;
      seen.add(key);
      if (scienceWorkRunBlocked(db,chatId,runId)) return true;
      // A One Team child can itself create more Work or teammates. Follow the
      // exact host-owned run, not whichever dispatch happens to share a room.
      const team=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_team_dispatches'").get();
      if (team) {
        const parents=db.prepare("SELECT parent_chat_id,parent_run_id FROM one_team_dispatches WHERE child_chat_id=? AND child_run_id=? LIMIT 2").all(chatId,runId) as Array<{parent_chat_id:string;parent_run_id:string|null}>;
        if (parents.length>1) return false;
        if (parents.length===1) {
          if (!parents[0].parent_chat_id || !parents[0].parent_run_id) return false;
          chatId=parents[0].parent_chat_id;runId=parents[0].parent_run_id;continue;
        }
      }
      const children=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_session_dispatches'").get();
      if (children) {
        const rows=db.prepare(`SELECT parent_chat_id,parent_run_id,child_run_id,steering_json FROM work_session_dispatches WHERE child_chat_id=? LIMIT 101`).all(chatId) as Array<{parent_chat_id:string;parent_run_id:string;child_run_id:string;steering_json:string}>;
        if (rows.length>100) return false;
        const matches=rows.filter(row=>{
          const directions=JSON.parse(row.steering_json);
          if (!Array.isArray(directions)) throw new Error("science_run_origin_invalid");
          return row.child_run_id===runId || directions.some(value=>value && typeof value==='object' && value.runId===runId);
        });
        if (matches.length>1) return false;
        if (matches.length===1) {
          chatId=matches[0].parent_chat_id;runId=matches[0].parent_run_id;continue;
        }
      }
      // Supervisor replies run as system turns, so generic run provenance is
      // unknown. Their separate ingress receipt is the authoritative source.
      const requests=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_supervisor_requests'").get();
      if (requests) {
        const roots=db.prepare("SELECT one_id FROM one_supervisor_requests WHERE origin_chat_id=? AND run_id=? AND kind='reply' LIMIT 2").all(chatId,runId) as Array<{one_id:string}>;
        if (roots.length) return roots.some((root)=>scienceReplyIsMobile(db,root.one_id,runId,false));
      }
      const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_science_run_origins'").get();
      if (!table) return false;
      const row=db.prepare("SELECT surface FROM one_science_run_origins WHERE chat_id=? AND run_id=?").get(chatId,runId) as {surface:ScienceReplySurface}|undefined;
      return row?.surface === "mobile";
    }
    return false;
  } catch { return false; }
}
