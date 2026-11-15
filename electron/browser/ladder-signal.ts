/**
 * What the browser fallback ladder (browser/fallback-ladder.ts) last said in a chat, read back from its own typed run_events rows
 * (the harness rules in long-run/blocked-goal-sweep.ts read it). Typed fields only: a code, a final, a site - never a message.
 */
import type Database from "better-sqlite3";
import { isBrowserDomToolError } from "./fallback-ladder";

import { HARNESS_TOOL_BREAKAGE_LADDER_CODES } from "./ladder-codes";
export { HARNESS_TOOL_BREAKAGE_LADDER_CODES };

/** The shapes of what the ladder can have last said. */
export type BrowserLadderSignal =
  | { kind: "boundary"; boundary: "security_consent"; code: string }
  | { kind: "login_wall"; domain: string; sourceSession: "unknown" }
  | { kind: "browser_unavailable"; code: string };

/** Tables seen to exist on a store handle: a table is never dropped under a running app, so a yes is asked once (#9: twice per Goal per sweep). A no is asked again. */
const knownTables = new WeakMap<object, Set<string>>();
function tableExists(db: Database.Database, name: string): boolean {
  const known = knownTables.get(db);
  if (known?.has(name)) return true;
  const found = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (found) { if (known) known.add(name); else knownTables.set(db, new Set([name])); }
  return found;
}

/**
 * The browser fallback ladder's last word in this chat: a stop or an owner wait that no later successful agentlas-browser call has
 * superseded. Typed fields only (run_events payload).
 */
export function browserLadderSignal(db: Database.Database, chatId: string, nowMs: number): { signal: BrowserLadderSignal; ref: string; at: string } | null {
  if (!tableExists(db, "run_events")) return null;
  const since = new Date(nowMs - 24 * 60 * 60_000).toISOString();
  const row = db.prepare(`SELECT id, ts, json_extract(payload_json, '$.code') AS code, json_extract(payload_json, '$.final') AS final,
    json_extract(payload_json, '$.reasonCode') AS reasonCode, json_extract(payload_json, '$.site') AS site
    FROM run_events WHERE chat_id = ? AND kind = 'browser_fallback_ladder' AND ts >= ?
    AND json_extract(payload_json, '$.step') = 'final' ORDER BY ts DESC LIMIT 1`)
    .get(chatId, since) as { id: string; ts: string; code: string | null; final: string | null; reasonCode: string | null; site: string | null } | undefined;
  if (!row || !row.code || (row.final !== "stopped" && row.final !== "waiting-owner")) return null;
  // The latest ladder may exhaust optional recovery for a DOM error while the agent continues.
  // Keep that event as the latest word; filtering it out of SQL would revive an older outage.
  if (row.final === "stopped" && isBrowserDomToolError(row.code)) return null;
  const later = db.prepare(`SELECT 1 FROM run_events WHERE chat_id = ? AND kind = 'mcp_tool-use' AND ts > ?
    AND json_extract(payload_json, '$.toolName') LIKE 'agentlas-browser.%'
    AND json_extract(payload_json, '$.runtimeEvidence.phase') = 'executed' LIMIT 1`).get(chatId, row.ts);
  if (later) return null;
  const ref = `run_event:${row.id}`;
  const at = row.ts;
  if (row.code === "human-check-required") {
    // A site's human check is the owner's (never solved or bypassed); its card is already open.
    return { signal: { kind: "boundary", boundary: "security_consent", code: "human_check_required" }, ref, at };
  }
  if (row.code === "login-wall") {
    const domain = typeof row.site === "string" && /^[a-z0-9.-]+$/i.test(row.site) ? row.site : "unknown";
    return { signal: { kind: "login_wall", domain, sourceSession: "unknown" }, ref, at };
  }
  if (row.final !== "stopped") return null;
  return { signal: { kind: "browser_unavailable", code: `browser_ladder:${row.code}` }, ref, at };
}

/**
 * How many times the ladder stopped on a tool-breakage code in this chat since `sinceMs` (each "final: stopped" event once). A later
 * successful browser call does not erase an earlier stop here: two stops in a day mean the tool keeps breaking, whatever happened between.
 */
export function browserToolBreakageStops(db: Database.Database, chatId: string, sinceMs: number): number {
  if (!tableExists(db, "run_events")) return 0;
  const rows = db.prepare(`SELECT json_extract(payload_json, '$.code') AS code FROM run_events
    WHERE chat_id = ? AND kind = 'browser_fallback_ladder' AND ts >= ? AND json_extract(payload_json, '$.step') = 'final'
    AND json_extract(payload_json, '$.final') = 'stopped'`).all(chatId, new Date(sinceMs).toISOString()) as Array<{ code: string | null }>;
  return rows.filter((row) => typeof row.code === "string" && HARNESS_TOOL_BREAKAGE_LADDER_CODES.has(row.code)).length;
}
