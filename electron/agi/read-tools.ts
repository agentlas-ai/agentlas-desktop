/**
 * AGI goal manager, P2 — bounded read tools for the unblocker (plan §3.4, R4 "purpose-built interface").
 *
 * The unblock attempt reads evidence before it acts (R8: no deliberation without fresh external evidence). Every
 * tool here is scoped to ONE goal, returns short structured rows with reason codes, is size-capped, and passes all
 * text through redactOperationalSecrets. There is no raw file read: the only file is the app's own main.log, and only
 * lines whose tag is in an allowlisted code family. Paths under signing/, credentials/, any .env*, keychains and
 * cookie stores are refused by name, before any I/O.
 *
 * Output is JSON text ≤ the tool's cap. When rows do not fit, the oldest are dropped and `truncated` says so.
 */
import type Database from "better-sqlite3";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename, normalize, sep } from "node:path";
import { redactOperationalSecrets } from "../invocation/event-secret-redaction";

export const AGI_READ_TOOL_NAMES = [
  "goal_state", "goal_ledger_events", "run_events", "tool_ledger", "attempt_receipts", "chat_tail",
  "main_log_slice", "incident", "playbook_lookup", "team_roster",
] as const;
export type AgiReadToolName = (typeof AGI_READ_TOOL_NAMES)[number];

/** Byte caps per tool (plan §3.4). Row caps are applied first, then bytes. */
export const AGI_READ_CAPS: Readonly<Record<AgiReadToolName, { bytes: number; rows: number }>> = {
  goal_state: { bytes: 4_096, rows: 40 },
  goal_ledger_events: { bytes: 8_192, rows: 50 },
  run_events: { bytes: 10_240, rows: 60 },
  tool_ledger: { bytes: 6_144, rows: 40 },
  attempt_receipts: { bytes: 4_096, rows: 20 },
  chat_tail: { bytes: 6_144, rows: 12 },
  main_log_slice: { bytes: 8_192, rows: 80 },
  incident: { bytes: 4_096, rows: 20 },
  playbook_lookup: { bytes: 3_072, rows: 3 },
  team_roster: { bytes: 3_072, rows: 30 },
};

/** main.log tag families the unblocker may read (plan §3.4: CDP, updater, runtime failure, wait registration, blender/metal). */
export const AGI_LOG_FAMILIES: Readonly<Record<string, RegExp>> = {
  cdp: /\[(?:[a-z-]*cdp[a-z-]*|agentlas-browser[a-z-]*|browser-[a-z-]+|mcp-proxy)\]/i,
  updater: /\[(?:updater|auto-update|update-[a-z-]+|native-update[a-z-]*)\]/i,
  runtime: /\[(?:warn|error)\] \[(?:runtime-[a-z-]+|judgment-runtime[a-z-]*|invocation[a-z-]*|mcp-client)\]/i,
  wait: /\[(?:wait-subscriptions?|goal-wait[a-z-]*|blocked-goal-sweep|effect-observation[a-z-]*|long-run[a-z-]*)\]/i,
  blender: /blender|metal/i,
  login: /\[(?:login-recovery|login-wall|cookie-import[a-z-]*|credential-import)\]/i,
};

const DENIED_SEGMENTS = new Set(["signing", "credentials", "keychains", "Cookies", "cookies"]);

/** Refuse secret-bearing locations by name, before any I/O (plan §3.4, CLAUDE.md "signing/, credentials/, .env*"). */
export function agiReadPathAllowed(path: string): boolean {
  if (typeof path !== "string" || !path.trim() || path.includes("\0")) return false;
  const clean = normalize(path);
  const parts = clean.split(sep).filter(Boolean);
  if (parts.some((part) => DENIED_SEGMENTS.has(part) || part === "..")) return false;
  const name = basename(clean);
  if (/^\.env(\..*)?$/i.test(name) || /\.env$/i.test(name)) return false;
  if (/\.(?:pem|p12|p8|key|keychain(-db)?|mobileprovision|cer)$/i.test(name)) return false;
  if (/^(?:Cookies|Login Data|Local State)(-journal)?$/i.test(name)) return false;
  return true;
}

export interface AgiReadContext { goalId: string }
export interface AgiReadDeps {
  db: Database.Database;
  /** The app's main.log (fixed; never taken from tool input). */
  mainLogPath: string | null;
  /** oneTeamList for the goal chat, or null when the chat has no team surface. */
  teamRoster?(chatId: string): unknown;
}
export type AgiReadResult =
  | { ok: true; tool: AgiReadToolName; truncated: boolean; bytes: number; text: string }
  | { ok: false; tool: string; code: string };

function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactOperationalSecrets(value);
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    // Keys that only ever carry secret material are dropped whole, whatever their shape.
    if (/^(?:cookie|cookies|set-cookie|authorization|password|passwd|secret|token|access_token|refresh_token|api_key|apikey)$/i.test(key)) {
      out[key] = "[redacted-secret]";
      continue;
    }
    out[key] = redactDeep(entry, depth + 1);
  }
  return out;
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Serialize ≤ cap: rows are dropped from the front (oldest first) until the JSON fits. */
function capped(tool: AgiReadToolName, head: Record<string, unknown>, rows: unknown[]): AgiReadResult {
  const cap = AGI_READ_CAPS[tool];
  let list = rows.slice(-cap.rows).map((row) => redactDeep(row));
  let truncated = rows.length > list.length;
  const safeHead = redactDeep(head) as Record<string, unknown>;
  let text = JSON.stringify({ ...safeHead, rows: list, truncated });
  while (Buffer.byteLength(text, "utf8") > cap.bytes && list.length) {
    list = list.slice(1);
    truncated = true;
    text = JSON.stringify({ ...safeHead, rows: list, truncated });
  }
  if (Buffer.byteLength(text, "utf8") > cap.bytes) {
    text = JSON.stringify({ truncated: true, rows: [], note: "head exceeded cap" });
    truncated = true;
  }
  return { ok: true, tool, truncated, bytes: Buffer.byteLength(text, "utf8"), text };
}

function parse(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try { const value = JSON.parse(json); return value && typeof value === "object" ? value as Record<string, unknown> : {}; } catch { return {}; }
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

interface GoalScope { runId: string; chatId: string | null }
function scopeOf(db: Database.Database, goalId: string): GoalScope | null {
  const row = db.prepare("SELECT id, root_chat_id FROM long_runs WHERE goal_id = ?").get(goalId) as { id: string; root_chat_id: string | null } | undefined;
  return row ? { runId: row.id, chatId: row.root_chat_id } : null;
}

/** An invocation run belongs to the goal when its run_events carry the goal's chat id. */
function runInScope(db: Database.Database, scope: GoalScope, runId: string): boolean {
  if (runId === scope.runId) return true;
  if (!scope.chatId || !tableExists(db, "run_events")) return false;
  return Boolean(db.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND chat_id = ? LIMIT 1").get(runId, scope.chatId));
}

const ID = /^[A-Za-z0-9._:@-]{1,200}$/;
const KIND = /^[a-z][a-z0-9._-]{0,79}$/;

export function callAgiReadTool(deps: AgiReadDeps, ctx: AgiReadContext, tool: string, args: Record<string, unknown> = {}): AgiReadResult {
  if (!(AGI_READ_TOOL_NAMES as readonly string[]).includes(tool)) return { ok: false, tool, code: "agi.read.unknown-tool" };
  // No tool takes a path. A path-shaped argument anywhere is refused outright (and secret locations by name).
  for (const value of Object.values(args)) {
    if (typeof value !== "string" || !value) continue;
    if (/[\\/]/.test(value) || !agiReadPathAllowed(value)) return { ok: false, tool, code: "agi.read.path-denied" };
  }
  const name = tool as AgiReadToolName;
  const { db } = deps;
  const scope = scopeOf(db, ctx.goalId);
  if (!scope) return { ok: false, tool, code: "agi.read.goal-unknown" };
  const kinds = Array.isArray(args.kinds) ? args.kinds.filter((k): k is string => typeof k === "string" && KIND.test(k)).slice(0, 12) : [];
  switch (name) {
    case "goal_state": {
      const run = db.prepare(`SELECT goal_id, status, pause_reason, blocked_reason, version, cycle_count, stall_streak, stall_window,
        substr(objective, 1, 600) AS objective FROM long_runs WHERE id = ?`).get(scope.runId) as Record<string, unknown>;
      const nodes = tableExists(db, "goal_plan_nodes") ? (db.prepare(`SELECT node_id, kind, parent_id, status, payload_json FROM goal_plan_nodes
        WHERE goal_id = ? AND (revision, plan_seq) = (SELECT revision, plan_seq FROM goal_plan_nodes WHERE goal_id = ?
          ORDER BY revision DESC, plan_seq DESC LIMIT 1) ORDER BY ord`).all(ctx.goalId, ctx.goalId) as Array<Record<string, unknown>>)
        .map((row) => { const payload = parse(row.payload_json as string);
          return { nodeId: row.node_id, kind: row.kind, parentId: row.parent_id, status: row.status,
            title: clip(payload.title, 120), intent: clip(payload.intent ?? payload.purpose, 160), dependsOn: payload.depends_on ?? null }; }) : [];
      return capped(name, { goal: run }, nodes);
    }
    case "goal_ledger_events": {
      const since = Number.isSafeInteger(args.sinceSeq) ? args.sinceSeq as number : 0;
      const rows = (db.prepare(`SELECT seq, kind, actor_kind, occurred_at, payload_json FROM long_run_events WHERE run_id = ? AND seq > ?
        ${kinds.length ? `AND kind IN (${kinds.map(() => "?").join(",")})` : ""} ORDER BY seq DESC LIMIT ?`)
        .all(scope.runId, since, ...kinds, AGI_READ_CAPS[name].rows) as Array<Record<string, unknown>>).reverse()
        .map((row) => { const p = parse(row.payload_json as string);
          return { seq: row.seq, kind: row.kind, actor: row.actor_kind, at: row.occurred_at,
            action: p.action ?? null, from: p.from ?? null, to: p.to ?? null, reason: p.reason ?? p.code ?? p.detail ?? null,
            attemptIds: Array.isArray(p.attemptIds) ? (p.attemptIds as unknown[]).slice(0, 5) : undefined }; });
      return capped(name, { runId: scope.runId }, rows);
    }
    case "run_events":
    case "tool_ledger": {
      const runId = typeof args.runId === "string" && ID.test(args.runId) ? args.runId : null;
      if (!runId) return { ok: false, tool, code: "agi.read.run-id-required" };
      if (!runInScope(db, scope, runId)) return { ok: false, tool, code: "agi.read.run-out-of-scope" };
      if (!tableExists(db, "run_events")) return capped(name, { runId }, []);
      if (name === "tool_ledger") {
        const rows = (db.prepare(`SELECT seq, ts, payload_json FROM run_events WHERE run_id = ? AND kind = 'mcp_tool-use' ORDER BY seq DESC LIMIT ?`)
          .all(runId, AGI_READ_CAPS[name].rows) as Array<Record<string, unknown>>).reverse().map((row) => {
          const p = parse(row.payload_json as string);
          const args = typeof p.toolArgs === "string" ? p.toolArgs : "";
          return { seq: row.seq, at: row.ts, tool: clip(p.toolName, 120), isError: p.toolIsError === true,
            argsDigest: args ? `len:${args.length}` : null, result: clip(p.toolResultPreview, 160), errorCode: p.errorCode ?? null };
        });
        return capped(name, { runId }, rows);
      }
      const tail = Number.isSafeInteger(args.tail) ? Math.min(AGI_READ_CAPS[name].rows, Math.max(1, args.tail as number)) : AGI_READ_CAPS[name].rows;
      const wanted = kinds.length ? kinds : ["mcp_tool-use", "mcp_final", "invoke_result", "invoke_completed", "invoke_failed", "mcp_notice", "runtime_effect_boundary"];
      const rows = (db.prepare(`SELECT seq, ts, kind, payload_json FROM run_events WHERE run_id = ? AND kind IN (${wanted.map(() => "?").join(",")})
        ORDER BY seq DESC LIMIT ?`).all(runId, ...wanted, tail) as Array<Record<string, unknown>>).reverse().map((row) => {
        const p = parse(row.payload_json as string);
        return { seq: row.seq, at: row.ts, kind: row.kind, tool: clip(p.toolName, 120) ?? undefined,
          isError: p.toolIsError === true || undefined, code: p.errorCode ?? p.code ?? p.failureCode ?? undefined,
          text: clip(p.text ?? p.toolResultPreview ?? p.message ?? p.details, 240) ?? undefined };
      });
      return capped(name, { runId }, rows);
    }
    case "attempt_receipts": {
      if (!tableExists(db, "long_run_worker_attempts")) return capped(name, { runId: scope.runId }, []);
      const rows = db.prepare(`SELECT id, invocation_run_id, state, side_effect_state, started_at, completed_at FROM long_run_worker_attempts
        WHERE run_id = ? ORDER BY started_at DESC LIMIT ?`).all(scope.runId, AGI_READ_CAPS[name].rows) as Array<Record<string, unknown>>;
      return capped(name, { runId: scope.runId }, rows.reverse());
    }
    case "chat_tail": {
      if (!scope.chatId || !tableExists(db, "chat_messages")) return capped(name, { chatId: null }, []);
      const n = Number.isSafeInteger(args.n) ? Math.min(12, Math.max(1, args.n as number)) : 8;
      const rows = (db.prepare(`SELECT role, substr(text, 1, 400) AS content, created_at FROM chat_messages WHERE chat_id = ?
        ORDER BY created_at DESC LIMIT ?`).all(scope.chatId, n) as Array<Record<string, unknown>>).reverse()
        .map((row) => ({ role: row.role, at: row.created_at, text: clip(row.content, 400) }));
      return capped(name, { chatId: scope.chatId }, rows);
    }
    case "main_log_slice": {
      const family = typeof args.family === "string" && AGI_LOG_FAMILIES[args.family] ? args.family : null;
      if (!family) return { ok: false, tool, code: "agi.read.log-family-not-allowed" };
      const path = deps.mainLogPath;
      if (!path || !agiReadPathAllowed(path) || basename(path) !== "main.log") return { ok: false, tool, code: "agi.read.log-unavailable" };
      const since = typeof args.since === "string" && Number.isFinite(Date.parse(args.since)) ? Date.parse(args.since) : 0;
      const lines = readTail(path, 2 * 1024 * 1024).split(/\r?\n/);
      const pattern = AGI_LOG_FAMILIES[family]!;
      const rows: Array<{ line: string }> = [];
      for (const line of lines) {
        const at = Date.parse(line.slice(0, 24));
        if (since && (!Number.isFinite(at) || at < since)) continue;
        if (!pattern.test(line)) continue;
        rows.push({ line: clip(line, 300) ?? "" });
      }
      return capped(name, { family, since: since ? new Date(since).toISOString() : null }, rows);
    }
    case "incident": {
      const id = typeof args.incidentId === "string" && ID.test(args.incidentId) ? args.incidentId : null;
      if (!id || !tableExists(db, "agi_incidents")) return { ok: false, tool, code: "agi.read.incident-unknown" };
      const row = db.prepare(`SELECT id, goal_id, status, owner_class, cause_kind, boundary, reason_code, attempts, reflections_json,
        opened_at_ms FROM agi_incidents WHERE id = ? AND goal_id = ?`).get(id, ctx.goalId) as Record<string, unknown> | undefined;
      if (!row) return { ok: false, tool, code: "agi.read.incident-out-of-scope" };
      const reflections = (() => { try { return JSON.parse(String(row.reflections_json)) as unknown[]; } catch { return []; } })();
      const { reflections_json: _r, ...head } = row;
      return capped(name, { incident: head }, reflections);
    }
    case "playbook_lookup": {
      const signature = typeof args.signature === "string" && /^[a-z0-9_:.-]{1,160}$/.test(args.signature) ? args.signature : null;
      if (!signature) return { ok: false, tool, code: "agi.read.signature-invalid" };
      if (!tableExists(db, "agi_playbook")) return capped(name, { signature }, []);
      const rows = db.prepare(`SELECT signature, diagnosis, action, verification, uses FROM agi_playbook WHERE signature = ? OR signature LIKE ?
        ORDER BY uses DESC LIMIT 3`).all(signature, `${signature.split(":")[0]}:%`) as Array<Record<string, unknown>>;
      return capped(name, { signature }, rows);
    }
    case "team_roster": {
      if (!scope.chatId || !deps.teamRoster) return capped(name, { chatId: scope.chatId }, []);
      let roster: unknown = null;
      try { roster = deps.teamRoster(scope.chatId); } catch { return { ok: false, tool, code: "agi.read.team-unavailable" }; }
      const teammates = Array.isArray((roster as { teammates?: unknown[] } | null)?.teammates) ? (roster as { teammates: unknown[] }).teammates : [];
      return capped(name, { chatId: scope.chatId }, teammates);
    }
  }
  return { ok: false, tool, code: "agi.read.unknown-tool" };
}

/** The last `bytes` of a file, starting at a line boundary. */
function readTail(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}
