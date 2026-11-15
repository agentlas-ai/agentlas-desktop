import type Database from "better-sqlite3";
import path from "node:path";
import { loadCuratorRuleset } from "../memory/curator-rules";
import { layoutOf, type StoreRef } from "../memory/stores";
import { readSet, setStores } from "../memory/store-set";
import { migrationLooksSecret } from "../migration/first-run-labels";
import { normalizeLineEnds, stripBlockComments } from "./file";
import { ORIGIN_INSTRUCTION, ORIGIN_OWNER_SPOKE } from "../memory/run-evidence";
import { charCount, type ClassificationRules, type WorkspaceRulesLimits } from "../../shared/memory-classification";
import type { WorkspaceRulesCandidates, WorkspaceRulesHeardCandidate, WorkspaceRulesPersonalCandidate } from "../../shared/workspace-rules";

/*
 * The pick list of "My rules" (Agentlas 2.0 P4;-a and 6). It READS stored lines and writes nothing: no row is modified, deleted, marked or counted, and no model is asked.
 *
 *   1. personal   Personal (`user_identity`) lines whose stored kind is exactly `preference`: the personal agent's remembered instructions. Newest first, at most `candidateMaxLines` (30).
 *   2. heard      Agent and Project store lines that carry BOTH origin marks (`origin:instruction` and `origin:owner-spoke`, written by the curator with the workspace-rules switch on): what an agent or a project
 *                 heard the owner say. Newest first, at most 30, with where it was heard.
 *
 * What is never a candidate: a line whose stored kind is not `preference` in Personal (facts about the owner, decisions, risks), the profile's "what the agent must keep" text and the approved operating principles
 * (they already load, so offering them would load them twice: neither lives in the memory store), a forgotten, replaced or disabled line, an overlay line of the old One, a line longer than `candidateLineMaxChars`
 * (200 characters; never cut, so no line is ever shown half), a line that looks like a credential or holds a host path (the migration's own gate `migrationLooksSecret` plus the ruleset's `hostAbsolutePath`),
 * and a line whose text is already in the owner's file (compared line by line, ignoring case, spacing and a list marker). Lines are one line each (line breaks inside become spaces).
 *
 * Reads only the rows it needs: keyset pages of 200 newest rows, at most 4,000 scanned per store. A store that did not change since the last look is not opened again (the same stat-and-forget-clock cache as the
 * Memory map). The owner's own file is the only other input. No Electron import.
 */

const PAGE = 200;
const MAX_SCAN = 4_000;
const PER_STORE_ACCEPT = 150;

export interface CandidateContext {
  rootDb: Database.Database;
  memoryRoot: string;
  owner: string;
  limits: WorkspaceRulesLimits;
  rules: ClassificationRules | null;
  /** The owner's file as the editor sees it (raw, line ends `\n`): lines already in it are not offered. */
  fileText: string;
  /** An agent's name from its id (the caller knows the registry). */
  nameOf?: (agentId: string | null) => string;
}

const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
/** The comparison form of a line: no list marker, collapsed spacing, lower case. */
export const ruleLineKey = (text: string): string => oneLine(text).normalize("NFC").replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/\s+/g, " ").toLowerCase();

/** The lines of the owner's file as comparison keys (closed block comments removed: a commented-out line is not "in the file"). */
export function fileLineKeys(fileText: string): Set<string> {
  const keys = new Set<string>();
  for (const line of stripBlockComments(normalizeLineEnds(fileText)).split("\n")) { const key = ruleLineKey(line); if (key) keys.add(key); }
  return keys;
}

function hostPathPattern(): RegExp | null {
  try {
    const spec = (loadCuratorRuleset().ruleset.patterns as Record<string, { regex?: unknown; flags?: unknown } | undefined> | undefined)?.hostAbsolutePath;
    if (typeof spec?.regex !== "string") return null;
    return new RegExp(spec.regex, typeof spec.flags === "string" ? spec.flags.replace(/[^imsu]/g, "") : "");
  } catch { return null; }
}

/** A line that may be offered: short enough, no credential shape, no host path. */
export function candidateLineOk(text: string, limits: WorkspaceRulesLimits, path_?: RegExp | null): boolean {
  if (!text || charCount(text) > limits.candidateLineMaxChars) return false;
  if (migrationLooksSecret(text)) return false;
  const host = path_ === undefined ? hostPathPattern() : path_;
  return !(host && host.test(text));
}

interface RawRow { id: string; content: string; kind: string; scope: string; created_at: string; evidence_json: string | null; agent_id: string | null; actor: string | null; project_id: string | null; project_path: string | null }

const hasBindings = (db: Database.Database): boolean => {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_identity_bindings'").get()); } catch { return false; }
};

/** Newest-first keyset pages of the rows `where` selects (one store), turned into candidates by `accept` until `want` are taken or MAX_SCAN rows were seen. Throws nothing the caller does not catch per store. */
function scan<T>(db: Database.Database, ownerNamespace: string, where: string, accept: (row: RawRow) => T | null, want: number): T[] {
  const bindings = hasBindings(db);
  const owner = bindings ? "(b.owner_namespace=? OR (b.owner_namespace IS NULL AND ?=1)) AND " : "";
  const enabled = bindings
    ? `AND COALESCE(CASE WHEN json_valid(b.applicability_json) THEN json_extract(b.applicability_json,'$.enabled') END,1)<>0
       AND COALESCE(CASE WHEN json_valid(b.applicability_json) THEN json_extract(b.applicability_json,'$.recallChannel') END,'')<>'legacy_one_overlay'` : "";
  const from = bindings ? "memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id" : "memory_entries m";
  const actor = bindings ? "NULLIF(b.actor_id,'')" : "NULL";
  const base = `SELECT m.id AS id, m.content AS content, m.kind AS kind, m.scope AS scope, m.created_at AS created_at, m.evidence_json AS evidence_json, m.agent_id AS agent_id, ${actor} AS actor,
    m.project_id AS project_id, m.project_path AS project_path FROM ${from} WHERE ${owner}m.content<>'' AND m.superseded_at IS NULL ${enabled} AND (${where})`;
  const ownerBinds: unknown[] = bindings ? [ownerNamespace, ownerNamespace.startsWith("device-local:") ? 1 : 0] : [];
  const first = db.prepare(`${base} ORDER BY m.created_at DESC, m.id DESC LIMIT ${PAGE}`);
  const next = db.prepare(`${base} AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?)) ORDER BY m.created_at DESC, m.id DESC LIMIT ${PAGE}`);
  const out: T[] = [];
  let seen = 0;
  let rows = first.all(...ownerBinds) as RawRow[];
  while (rows.length) {
    for (const row of rows) { const hit = accept(row); if (hit !== null) { out.push(hit); if (out.length >= want) return out; } }
    seen += rows.length;
    if (rows.length < PAGE || seen >= MAX_SCAN) break;
    const last = rows[rows.length - 1];
    rows = next.all(...ownerBinds, last.created_at, last.created_at, last.id) as RawRow[];
  }
  return out;
}

const marksOf = (evidence: string | null): boolean => {
  if (!evidence || !evidence.includes(ORIGIN_INSTRUCTION) || !evidence.includes(ORIGIN_OWNER_SPOKE)) return false;
  try { const parsed: unknown = JSON.parse(evidence); return Array.isArray(parsed) && parsed.includes(ORIGIN_INSTRUCTION) && parsed.includes(ORIGIN_OWNER_SPOKE); } catch { return false; }
};

const newestFirst = <T extends { createdAt: string; id: string }>(a: T, b: T): number => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function collectCandidates(ctx: CandidateContext): WorkspaceRulesCandidates {
  const { limits } = ctx;
  const host = hostPathPattern();
  const inFile = fileLineKeys(ctx.fileText);
  const lineOf = (row: RawRow): string | null => { const text = oneLine(row.content); return candidateLineOk(text, limits, host) ? text : null; };

  // 1. Personal: the root store only (Personal never lives anywhere else).
  let personal: WorkspaceRulesPersonalCandidate[] = [];
  try {
    personal = scan(ctx.rootDb, ctx.owner, "m.scope='user_identity' AND m.kind='preference'", (row) => {
      const text = lineOf(row);
      return text === null ? null : { id: row.id, text, createdAt: row.created_at };
    }, PER_STORE_ACCEPT);
  } catch { personal = []; }

  // 2. Heard: the root store (a central layout keeps everything there) and every other store of this owner.
  const heardOf = (row: RawRow): (WorkspaceRulesHeardCandidate) | null => {
    if (!marksOf(row.evidence_json)) return null;
    const text = lineOf(row);
    if (text === null) return null;
    const agent = row.scope === "agent_repo";
    const folder = row.project_path ? path.basename(row.project_path.replace(/[\\/]+$/, "")) : "";
    const name = agent ? (ctx.nameOf ? ctx.nameOf(row.actor ?? row.agent_id) : (row.actor ?? row.agent_id ?? "")) : (folder || row.project_id || "");
    return { id: row.id, text, createdAt: row.created_at, from: { kind: agent ? "agent" : "project", name: String(name).slice(0, 120) } };
  };
  const heardWhere = "m.scope IN ('agent_repo','project') AND m.evidence_json LIKE '%origin:instruction%' AND m.evidence_json LIKE '%origin:owner-spoke%'";
  let heard: WorkspaceRulesHeardCandidate[] = [];
  try { heard = scan(ctx.rootDb, ctx.owner, heardWhere, heardOf, PER_STORE_ACCEPT); } catch { heard = []; }
  try {
    if (layoutOf(ctx.rootDb) !== "central") {
      const context = { memoryRoot: ctx.memoryRoot, owner: ctx.owner, rootDb: ctx.rootDb };
      const read = readSet(context, setStores(context, {}), `rules-heard:v1:${limits.candidateLineMaxChars}`,
        (db: Database.Database, _ref: StoreRef) => { try { return scan(db, ctx.owner, heardWhere, heardOf, PER_STORE_ACCEPT); } catch { return []; } }, (value) => value.length);
      for (const item of read.results) heard.push(...item.value);
    }
  } catch { /* a store that cannot be read is left out; the list is what could be read */ }

  const taken = new Set(inFile);
  const pick = <T extends { text: string; createdAt: string; id: string }>(rows: T[]): T[] => {
    const out: T[] = [];
    for (const row of [...rows].sort(newestFirst)) {
      const key = ruleLineKey(row.text);
      if (!key || taken.has(key)) continue;
      taken.add(key);
      out.push(row);
      if (out.length >= limits.candidateMaxLines) break;
    }
    return out;
  };
  const personalPicked = pick(personal);
  const heardPicked = pick(heard);
  return { personal: personalPicked, heard: heardPicked };
}
