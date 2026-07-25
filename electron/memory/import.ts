// Import existing memory — product feature (Phase 1b).
//
// Promotes the one-time appbridge migration (scripts/migrate-appbridge-memory.cjs)
// into a real, generic feature: given a folder of markdown, map each substantive
// section to a durable memory entry owned by the right layer of a team (member
// cell / orchestrator / shared team_memory) or a single agent, then admit it
// through the app's OWN insertMemoryEntry + autoIntakeCuratedMemory so curation
// and Experience treat the rows as genuine. Idempotent via a stable per-section
// source-hash sentinel embedded in evidence. Privacy: secrets are redacted
// (dropped) before any write. DRY-RUN preview + APPLY, sharing one mapper so the
// preview is exactly what apply writes.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { insertMemoryEntry } from "./store";
import { autoIntakeCuratedMemory } from "../experience/store";
import { getAgentById } from "../mcp/registry";
import { listFirms } from "../store/firms";
import { looksSecret } from "../../shared/secret-patterns";
import type { MemoryKind, MemoryScope } from "../architecture/manifest";
import type { InstalledFirm } from "../../shared/types";

const SOURCE_TOKEN_PREFIX = "mem-import:v1";
const MAX_FILES = 400;
const MAX_CONTENT = 4000;

export interface MemoryImportRequest {
  /** Absolute folder or single-markdown path to import from. */
  sourcePath: string;
  /** The installed agent (single) or team CEO/firm the import targets. */
  agentId: string;
}

export interface MemoryImportRow {
  file: string;
  section: string;
  ownerLabel: string;
  ownerAgentId: string | null;
  scope: MemoryScope;
  kind: MemoryKind;
  status: "new" | "duplicate" | "redacted";
}

export interface MemoryImportPreview {
  sourcePath: string;
  targetAgentId: string;
  targetKind: "agent" | "team";
  rows: MemoryImportRow[];
  summary: {
    total: number;
    newCount: number;
    duplicateCount: number;
    redactedCount: number;
    byOwner: Record<string, number>;
    byKind: Record<string, number>;
  };
}

export interface MemoryImportResult {
  sourcePath: string;
  targetAgentId: string;
  imported: number;
  skippedDuplicate: number;
  redacted: number;
  embedded: number;
  intakeAttempted: number;
  byOwner: Record<string, number>;
}

// ── Section extraction (ported from the appbridge migration) ─────────────────
const TEMPLATE_LINE =
  /^\s*[-*]?\s*(Add\b|Fill in\b|Example:|Record\b|Link\b|Prefer\b|Note\b|Which\b|Date:\s*$|Topic:\s*$|Decision:\s*$|Why:\s*$|Risk accepted:\s*$)/i;
const META_HEADING =
  /^(How To Use|사용 규칙|사용법|구조|형식|사전 참조|누가 업데이트|Entries|Read First|Memory Rules|Recent Activity|Recently Touched|CROSS-REFERENCES|LEARNINGS LOG|ANTIPATTERNS|GOTCHAS|Repeated Failures|성공 패턴|발견 사항|안티패턴|에이전트 구성)/i;

function substantiveBody(body: string): string {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const real = lines.filter((l) => !TEMPLATE_LINE.test(l) && l.replace(/^#+\s*/, "").length >= 12);
  return real.join("\n");
}

function kindForHeading(heading: string, fallback: MemoryKind): MemoryKind {
  const m = /\[([A-Z_]+)\]/.exec(heading);
  const tag = m ? m[1] : "";
  if (["SUCCESS", "DISCOVERY"].includes(tag)) return "procedure";
  if (
    ["ANTIPATTERN", "GOTCHA", "SECURITY", "CONFIRMED", "REGRESSION", "FALSE_POSITIVE", "BLOCKED_BY_GUARD", "FAILURE"].includes(tag)
  ) {
    return "risk";
  }
  return fallback;
}

function keepSection(heading: string, body: string, alwaysKeep: boolean): boolean {
  if (META_HEADING.test(heading.replace(/\[[A-Z_]+\]\s*/, "").trim())) return false;
  const hasDate = /\(20\d\d-\d\d-\d\d\)|Date:\s*20\d\d-\d\d-\d\d/.test(heading + "\n" + body);
  const hasTag = /\[[A-Z_]+\]/.test(heading);
  const real = substantiveBody(body);
  if (alwaysKeep) return real.length >= 60;
  if (hasDate || hasTag) return real.length >= 40;
  return real.length >= 160;
}

function splitSections(md: string): Array<{ heading: string; body: string }> {
  const lines = md.split("\n");
  const sections: Array<{ heading: string; body: string }> = [];
  let cur: { heading: string; body: string } | null = null;
  for (const line of lines) {
    if (/^#{2,3}\s+\S/.test(line)) {
      if (cur) sections.push(cur);
      cur = { heading: line.replace(/^#{2,3}\s+/, "").trim(), body: "" };
    } else if (cur) {
      cur.body += line + "\n";
    }
  }
  if (cur) sections.push(cur);
  return sections;
}

function splitDatedBullets(md: string): Array<{ heading: string; body: string }> {
  const idx = md.indexOf("- Date:");
  if (idx === -1) return [];
  return md
    .slice(idx)
    .split(/\n(?=- Date:)/)
    .map((p) => p.trim())
    .filter((p) => /Date:\s*20\d\d-\d\d-\d\d/.test(p))
    .map((p) => {
      const topic = /Topic:\s*(.+)/.exec(p);
      const date = /Date:\s*(20\d\d-\d\d-\d\d)/.exec(p);
      return { heading: `Decision ${date ? date[1] : ""}: ${topic ? topic[1].trim() : ""}`.trim(), body: p };
    });
}

// ── Owner routing ────────────────────────────────────────────────────────────
// Filenames/dirs that carry team-wide norms rather than one member's skill.
const SHARED_HINT =
  /(team[-_ ]?memory|team_memory|glossary|handoff|scope[-_ ]?ownership|common[-_ ]?safety|safety|tone|language|dossier|operating[-_ ]?architecture|memory[-_ ]?architecture|용어|공통|안전|인계|톤)/i;
const RISK_HINT = /(security|attack|vuln|bug|gotcha|incident|보안|취약|버그|사고)/i;
const ALWAYS_KEEP_HINT = /(team[-_ ]?memory|glossary|dossier|handoff|safety|scope[-_ ]?ownership|tone)/i;

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

interface TargetShape {
  agentId: string;
  kind: "agent" | "team";
  firm: InstalledFirm | null;
  members: Array<{ agentId: string; role: string; slug: string }>;
}

function resolveTarget(agentId: string): TargetShape {
  const firms = listFirms();
  const firm =
    firms.find((f) => f.id === agentId) ??
    firms.find((f) => f.ceoAgentId === agentId) ??
    null;
  if (!firm) return { agentId, kind: "agent", firm: null, members: [] };
  const members = firm.orgChart
    .filter((node) => node.agentId && node.agentId !== firm.ceoAgentId)
    .map((node) => ({ agentId: node.agentId, role: node.role || node.agentSlug, slug: node.agentSlug }));
  // A team import targets the orchestrator; the CEO agentId is the orchestrator owner.
  return { agentId: firm.ceoAgentId, kind: "team", firm, members };
}

export interface MemoryImportMemberTarget {
  members: Array<{ agentId: string; role: string; slug: string }>;
}

/** Match a source file to a team member by role/slug token overlap — fallback only. */
function matchMember(fileTokens: string, target: MemoryImportMemberTarget): { agentId: string; role: string } | null {
  if (target.members.length === 0) return null;
  let best: { agentId: string; role: string; score: number } | null = null;
  for (const member of target.members) {
    const roleTokens = normalizeToken(member.role).split(" ").filter((t) => t.length >= 3);
    const slugTokens = normalizeToken(member.slug).split(" ").filter((t) => t.length >= 3);
    const tokens = [...new Set([...roleTokens, ...slugTokens])];
    let score = 0;
    for (const token of tokens) if (fileTokens.includes(token)) score += token.length;
    if (score > 0 && (!best || score > best.score)) best = { agentId: member.agentId, role: member.role, score };
  }
  return best ? { agentId: best.agentId, role: best.role } : null;
}

export type MemoryImportOwnerJudge = (spec: {
  kind: string;
  question: string;
  labels: readonly string[];
  input: string;
  hints?: Array<{ label: string; words: string[] }>;
  guidance?: string;
  fallback: string;
  timeoutMs?: number;
}) => Promise<{ verdict: string; source: "llm" | "fallback"; confidence: number; reason: string }>;

const MAX_MEMBER_LABELS = 40;

/**
 * Route an imported memory file to the team member who should own it. The
 * connected model decides over the member-slug inventory (role/slug tokens are
 * hints only). With NO connected model we do NOT route to a token-overlap member
 * pick — the file falls to the orchestrator (owner null) as team-coordination
 * knowledge, the safe non-acting default. "orchestrator" = team-coordination
 * knowledge / no clear member owner.
 */
export async function resolveMemoryImportOwner(
  relFile: string,
  content: string,
  target: MemoryImportMemberTarget,
  opts: { judgeFn?: MemoryImportOwnerJudge; timeoutMs?: number } = {},
): Promise<{ owner: { agentId: string; role: string } | null; source: "llm" | "fallback" }> {
  const lexical = matchMember(normalizeToken(relFile), target);
  if (target.members.length === 0) return { owner: null, source: "fallback" };
  const members = target.members.slice(0, MAX_MEMBER_LABELS);
  const bySlug = new Map(members.map((member) => [member.slug, member]));
  const labels = [...bySlug.keys(), "orchestrator"];
  const lexicalLabel = lexical
    ? members.find((member) => member.agentId === lexical.agentId)?.slug ?? "orchestrator"
    : "orchestrator";
  let judgeFn = opts.judgeFn;
  if (!judgeFn) {
    const { judge } = await import("../system-agents/judgment");
    judgeFn = judge as unknown as MemoryImportOwnerJudge;
  }
  let verdict: Awaited<ReturnType<MemoryImportOwnerJudge>>;
  try {
    verdict = await judgeFn({
      kind: "memory-import-member-owner",
      question:
        "Which team member should own the knowledge in this imported memory file? Answer 'orchestrator' when it is team-wide coordination knowledge or no listed member clearly owns it.",
      labels,
      input: [
        `FILE: ${relFile}`,
        "",
        "CONTENT:",
        content.slice(0, 2_000),
        "",
        "TEAM MEMBERS:",
        ...members.map((member) => `- ${member.slug}: ${member.role}`),
      ].join("\n"),
      hints: members.map((member) => ({
        label: member.slug,
        words: [...new Set([
          ...normalizeToken(member.role).split(" ").filter((t) => t.length >= 3),
          ...normalizeToken(member.slug).split(" ").filter((t) => t.length >= 3),
        ])],
      })),
      guidance:
        `A deterministic token-overlap pre-pass suggested "${lexicalLabel}". Treat that as a prior, not a fact. ` +
        "Judge who the knowledge is FOR by meaning, in any language — a filename token overlap is not ownership.",
      fallback: lexicalLabel,
      timeoutMs: opts.timeoutMs,
    });
  } catch {
    // No connected model → orchestrator (owner null), never a token-overlap pick.
    return { owner: null, source: "fallback" };
  }
  if (verdict.source !== "llm") return { owner: null, source: "fallback" };
  if (verdict.verdict === "orchestrator") return { owner: null, source: "llm" };
  const member = bySlug.get(verdict.verdict);
  // A hallucinated member slug never routes: fall to the orchestrator.
  return member
    ? { owner: { agentId: member.agentId, role: member.role }, source: "llm" }
    : { owner: null, source: "fallback" };
}

interface OwnerDecision {
  scope: MemoryScope;
  ownerAgentId: string | null;
  ownerLabel: string;
  fallbackKind: MemoryKind;
  alwaysKeep: boolean;
}

async function decideOwner(
  relFile: string,
  content: string,
  target: TargetShape,
  opts: { judgeFn?: MemoryImportOwnerJudge } = {},
): Promise<OwnerDecision> {
  const lower = relFile.toLowerCase();
  const alwaysKeep = ALWAYS_KEEP_HINT.test(lower);
  if (SHARED_HINT.test(lower)) {
    return {
      scope: "team_memory",
      ownerAgentId: null,
      ownerLabel: "team_memory",
      fallbackKind: /glossary|dossier|용어/i.test(lower) ? "fact" : "procedure",
      alwaysKeep,
    };
  }
  if (target.kind === "team") {
    const routed = await resolveMemoryImportOwner(relFile, content, target, opts);
    if (routed.owner) {
      return {
        scope: "agent_repo",
        ownerAgentId: routed.owner.agentId,
        ownerLabel: routed.owner.role,
        fallbackKind: RISK_HINT.test(lower) ? "risk" : "procedure",
        alwaysKeep,
      };
    }
    // No member owner on a team → the orchestrator (team coordination context).
    return {
      scope: "agent_repo",
      ownerAgentId: target.agentId,
      ownerLabel: "orchestrator",
      fallbackKind: RISK_HINT.test(lower) ? "risk" : "decision",
      alwaysKeep,
    };
  }
  return {
    scope: "agent_repo",
    ownerAgentId: target.agentId,
    ownerLabel: "agent",
    fallbackKind: RISK_HINT.test(lower) ? "risk" : "procedure",
    alwaysKeep,
  };
}

// ── File walk ────────────────────────────────────────────────────────────────
function collectMarkdown(root: string): Array<{ abs: string; rel: string }> {
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    return /\.(md|markdown|mdx|txt)$/i.test(root) ? [{ abs: root, rel: path.basename(root) }] : [];
  }
  const out: Array<{ abs: string; rel: string }> = [];
  const walk = (dir: string): void => {
    if (out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && /\.(md|markdown|mdx|txt)$/i.test(entry.name)) {
        out.push({ abs, rel: path.relative(root, abs) });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function stableToken(relFile: string, heading: string): string {
  const hash = createHash("sha256").update(`${SOURCE_TOKEN_PREFIX}|${relFile}|${heading}`).digest("hex").slice(0, 16);
  return `${SOURCE_TOKEN_PREFIX}:${hash}`;
}

interface BuiltEntry {
  token: string;
  relFile: string;
  heading: string;
  content: string;
  scope: MemoryScope;
  kind: MemoryKind;
  ownerAgentId: string | null;
  ownerLabel: string;
  redacted: boolean;
}

async function buildEntries(
  req: MemoryImportRequest,
  target: TargetShape,
  opts: { judgeFn?: MemoryImportOwnerJudge } = {},
): Promise<BuiltEntry[]> {
  const files = collectMarkdown(req.sourcePath);
  const built: BuiltEntry[] = [];
  for (const { abs, rel } of files) {
    let md: string;
    try {
      md = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const owner = await decideOwner(rel, md, target, opts);
    const sections = /decisions\.md$/i.test(rel) ? splitDatedBullets(md) : splitSections(md);
    for (const sec of sections) {
      if (!keepSection(sec.heading, sec.body, owner.alwaysKeep)) continue;
      const bodyText = sec.body.replace(/\n{3,}/g, "\n\n").trim();
      const content = `${sec.heading}\n${bodyText}`.trim().slice(0, MAX_CONTENT);
      if (content.length < 40) continue;
      built.push({
        token: stableToken(rel, sec.heading),
        relFile: rel,
        heading: sec.heading,
        content,
        scope: owner.scope,
        kind: kindForHeading(sec.heading, owner.fallbackKind),
        ownerAgentId: owner.ownerAgentId,
        ownerLabel: owner.ownerLabel,
        redacted: looksSecret(content),
      });
    }
  }
  return built;
}

function validateRequest(req: MemoryImportRequest): TargetShape {
  const sourcePath = String(req.sourcePath ?? "").trim();
  if (!sourcePath || !path.isAbsolute(sourcePath)) throw new Error("Import source must be an absolute path.");
  if (!fs.existsSync(sourcePath)) throw new Error(`Import source not found: ${sourcePath}`);
  const agentId = String(req.agentId ?? "").trim();
  if (!agentId) throw new Error("Import target agentId is required.");
  return resolveTarget(agentId);
}

function existsByToken(token: string): boolean {
  return Boolean(
    getDb()
      .prepare("SELECT 1 FROM memory_entries WHERE evidence_json LIKE ? LIMIT 1")
      .get(`%${token}%`),
  );
}

export async function importMemoryPreview(
  req: MemoryImportRequest,
  opts: { judgeFn?: MemoryImportOwnerJudge } = {},
): Promise<MemoryImportPreview> {
  const target = validateRequest(req);
  const entries = await buildEntries(req, target, opts);
  const rows: MemoryImportRow[] = [];
  const byOwner: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  let newCount = 0;
  let duplicateCount = 0;
  let redactedCount = 0;
  for (const e of entries) {
    const status: MemoryImportRow["status"] = e.redacted
      ? "redacted"
      : existsByToken(e.token)
        ? "duplicate"
        : "new";
    if (status === "new") {
      newCount += 1;
      byOwner[e.ownerLabel] = (byOwner[e.ownerLabel] || 0) + 1;
      byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    } else if (status === "duplicate") duplicateCount += 1;
    else redactedCount += 1;
    rows.push({
      file: e.relFile,
      section: e.heading.slice(0, 120),
      ownerLabel: e.ownerLabel,
      ownerAgentId: e.ownerAgentId,
      scope: e.scope,
      kind: e.kind,
      status,
    });
  }
  return {
    sourcePath: req.sourcePath,
    targetAgentId: target.agentId,
    targetKind: target.kind,
    rows,
    summary: { total: entries.length, newCount, duplicateCount, redactedCount, byOwner, byKind },
  };
}

export async function importMemoryApply(
  req: MemoryImportRequest,
  opts: { judgeFn?: MemoryImportOwnerJudge } = {},
): Promise<MemoryImportResult> {
  const target = validateRequest(req);
  const entries = await buildEntries(req, target, opts);
  const result: MemoryImportResult = {
    sourcePath: req.sourcePath,
    targetAgentId: target.agentId,
    imported: 0,
    skippedDuplicate: 0,
    redacted: 0,
    embedded: 0,
    intakeAttempted: 0,
    byOwner: {},
  };
  for (const e of entries) {
    if (e.redacted) {
      result.redacted += 1;
      continue;
    }
    if (existsByToken(e.token)) {
      result.skippedDuplicate += 1;
      continue;
    }
    const entry = insertMemoryEntry({
      scope: e.scope,
      kind: e.kind,
      content: e.content,
      agentId: e.ownerAgentId,
      confidence: /\(20\d\d-\d\d-\d\d\)|Date:\s*20\d\d/.test(e.content) ? "high" : "medium",
      sensitivity: "internal",
      evidence: [e.token, `source:memory-import/${e.relFile}`],
      requestContext: {
        userIntent: `Imported memory: ${e.heading}`.slice(0, 200),
        outcome: "imported-from-existing-memory",
      },
    });
    result.imported += 1;
    result.embedded += 1; // insertMemoryEntry always computes a local embedding.
    result.byOwner[e.ownerLabel] = (result.byOwner[e.ownerLabel] || 0) + 1;

    // Experience intake only for an installed-agent owner (member cell /
    // orchestrator). team_memory (ownerAgentId null) has no installed owner; the
    // FK-skip guard in autoIntakeCuratedMemory also protects any edge case.
    if (e.scope === "agent_repo" && e.ownerAgentId) {
      const owner = getAgentById(e.ownerAgentId);
      try {
        autoIntakeCuratedMemory({
          memory: {
            id: entry.id,
            kind: e.kind,
            content: e.content,
            confidence: entry.confidence,
            sensitivity: entry.sensitivity,
            requestContext: { userIntent: e.heading.slice(0, 200) },
          },
          agentId: e.ownerAgentId,
          projectId: null,
          projectPath: null,
          environment: { platform: process.platform, arch: process.arch, runtimeKind: "agentlas-desktop" },
          basePackageHash: owner?.packageHash ?? null,
          taskHint: e.ownerLabel,
        });
        result.intakeAttempted += 1;
      } catch (error) {
        console.warn(
          `[memory-import] experience intake deferred: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
  }
  return result;
}
