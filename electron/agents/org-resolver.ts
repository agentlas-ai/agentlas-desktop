// LLM 팀 구조 리졸버 — 임의의 에이전트-팀 폴더를 사용자의 활성 런타임(BYOK/CLI)으로
// "읽기 전용" 스캔해 CEO → 본부 → 전문가 3-tier ResolvedOrg를 생성한다.
// 하드코딩 파서가 아니라 LLM이 임의 구조를 이해한다(폴더 레이아웃이 천차만별이므로).
// 결과는 app config(saveResolvedOrg) + 원본 폴더의 .agentlas/orgspec.json sidecar에 저장하며,
// 사용자의 원본 파일은 절대 수정하지 않는다.
import fs from "node:fs";
import path from "node:path";
import type { AgentTeamResolution, ResolvedDivision, ResolvedNode, ResolvedOrg } from "../../shared/types";
import { getFirm } from "../store/firms";
import { getAgentById, setAgentEntityKind } from "../mcp/registry";
import { saveResolvedOrg, getResolvedOrg } from "../store/org-spec";
import { pickActiveRunner } from "../mcp/client";
import { PROJECT_MEMORY_DIR } from "../architecture/manifest";
import { getRoute } from "./routes";
import { agentFolderPath } from "./files";
import { getMeta, setMeta } from "../store/meta";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "out",
  "build",
  ".cache",
  "__pycache__",
  PROJECT_MEMORY_DIR,
]);
const TEXT_EXT = new Set([".md", ".markdown", ".yaml", ".yml", ".json", ".txt", ".mdx"]);
const MAX_FILES = 140;
const MAX_EXCERPT = 700;
const MAX_MAP_CHARS = 24000;
const MAX_PROMPT_FILE = 8000;

type Raw = Record<string, unknown>;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

function walk(root: string): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const top = stack.pop();
    if (!top) break;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(top.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // 숨김은 건너뛰되 .claude(팀 정의 흔히 거기 있음)는 허용
      if (e.name.startsWith(".") && e.name !== ".claude") continue;
      const full = path.join(top.dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (top.depth < 5) stack.push({ dir: full, depth: top.depth + 1 });
      } else if (e.isFile()) {
        out.push(full);
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

function buildFolderMap(root: string): string {
  const files = walk(root);
  const lines: string[] = ["FILES:"];
  for (const f of files) lines.push(`  ${path.relative(root, f)}`);
  lines.push("\nEXCERPTS (agent-definition-like files):");
  let total = 0;
  for (const f of files) {
    if (total > MAX_MAP_CHARS) break;
    const ext = path.extname(f).toLowerCase();
    const base = path.basename(f).toLowerCase();
    const likely =
      TEXT_EXT.has(ext) &&
      (base.includes("agent") ||
        base.includes("soul") ||
        base.includes("orgspec") ||
        base.includes("role") ||
        base.includes("ceo") ||
        base.includes("director") ||
        base.includes("system") ||
        base.includes("readme") ||
        ext === ".yaml" ||
        ext === ".yml");
    if (!likely) continue;
    let content = "";
    try {
      content = fs.readFileSync(f, "utf8").slice(0, MAX_EXCERPT);
    } catch {
      continue;
    }
    const block = `\n--- ${path.relative(root, f)} ---\n${content}`;
    total += block.length;
    lines.push(block);
  }
  return lines.join("\n").slice(0, MAX_MAP_CHARS);
}

function slugify(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "node"
  );
}

function extractJson(text: string): Raw | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (parsed && typeof parsed === "object") return parsed as Raw;
    } catch {
      // try next
    }
  }
  return null;
}

function readPromptFile(root: string, ref: unknown): string | undefined {
  const rel = str(ref).trim();
  if (!rel) return undefined;
  const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = path.join(root, safe);
  if (!full.startsWith(root)) return undefined; // traversal 방지
  try {
    return fs.readFileSync(full, "utf8").slice(0, MAX_PROMPT_FILE);
  } catch {
    return undefined;
  }
}

const RESOLVER_SYSTEM = `You are Agentlas's team-structure resolver. You are given a map (file list + excerpts) of an arbitrary AI-agent-team folder. Infer the org as exactly 3 tiers: a single CEO, its divisions (department heads), and each division's specialists.

Rules:
- Output ONLY one JSON object, no prose, no markdown fence.
- Shape: {"divisions":[{"role":"...","name":"...","promptFileRef":"relative/path or null","specialists":[{"role":"...","name":"...","promptFileRef":"relative/path or null"}]}]}
- The CEO is already known — do NOT include it; only resolve divisions + specialists beneath it.
- role = the function (e.g. "Marketing Division", "Designer"); name = a display name (may equal role).
- promptFileRef = the relative file path (from the listed FILES) whose content defines that agent's behavior, or null.
- If the team is flat (no clear sub-structure), return the leaf roles as divisions with empty specialists.
- Be faithful to the folder; do not invent agents that aren't represented.`;

/** firm의 팀 폴더를 LLM으로 분석해 3-tier ResolvedOrg를 만들어 저장한다. */
export async function resolveTeamOrg(
  firmId: string,
): Promise<{ ok: boolean; org?: ResolvedOrg; error?: string }> {
  const firm = getFirm(firmId);
  if (!firm) return { ok: false, error: "firm not found" };
  const ceoAgent = getAgentById(firm.ceoAgentId);
  const sourcePath = ceoAgent?.localPath;
  if (!ceoAgent || !sourcePath || !fs.existsSync(sourcePath)) {
    // 로컬 소스 폴더가 없는 회사(웹/시드 마켓 설치) — LLM 재스캔 대상이 아니다.
    // 저장된/조직도-파생 3-tier를 그대로 반환해 "Resolve team"이 무반응·에러로 끝나지 않게 한다.
    return { ok: true, org: getResolvedOrg(firm) };
  }
  const picked = await pickActiveRunner();
  if (!picked) return { ok: false, error: "no active LLM runtime" };

  const map = buildFolderMap(sourcePath);
  const userPrompt = `CEO (already known): ${ceoAgent.name}\n\nTeam folder map:\n${map}`;

  let text = "";
  try {
    const result = await picked.runner(
      {
        systemPrompt: RESOLVER_SYSTEM,
        history: [],
        userPrompt,
        backendLabel: picked.label,
        model: picked.active.model ?? undefined,
        locale: "en",
      },
      { onPartial: () => {}, onStatus: () => {} },
    );
    text = result.text;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const data = extractJson(text);
  const rawDivisions = data && Array.isArray(data.divisions) ? (data.divisions as unknown[]) : null;
  if (!rawDivisions) return { ok: false, error: "resolver did not return valid org JSON" };

  const usedIds = new Set<string>();
  const mkId = (role: string, name: string): string => {
    const base = slugify(name || role);
    let id = base;
    let i = 2;
    while (usedIds.has(id)) id = `${base}-${i++}`;
    usedIds.add(id);
    return id;
  };
  const toNode = (raw: unknown): ResolvedNode => {
    const o = (raw && typeof raw === "object" ? raw : {}) as Raw;
    const role = str(o.role, str(o.name, "Agent"));
    const name = str(o.name, role);
    return {
      id: mkId(role, name),
      name,
      role,
      prompt: readPromptFile(sourcePath, o.promptFileRef),
      promptFileRef: str(o.promptFileRef) || undefined,
    };
  };

  const ceo: ResolvedNode = {
    id: firm.ceoAgentId,
    name: ceoAgent.name,
    role: "CEO",
    agentId: firm.ceoAgentId,
    prompt: ceoAgent.systemPrompt,
  };
  const divisions: ResolvedDivision[] = rawDivisions.slice(0, 24).map((d) => {
    const o = (d && typeof d === "object" ? d : {}) as Raw;
    const specialists = Array.isArray(o.specialists)
      ? (o.specialists as unknown[]).slice(0, 24).map(toNode)
      : [];
    return { ...toNode(d), specialists };
  });

  const org: ResolvedOrg = {
    source: "resolver",
    ceo,
    divisions,
    sourcePath,
    resolvedAt: new Date().toISOString(),
  };
  saveResolvedOrg(firmId, org);
  writeSidecar(sourcePath, org);
  return { ok: true, org };
}

/** .agentlas/orgspec.json sidecar (원본 폴더 안의 전용 디렉터리 — 기존 파일은 안 건드림). */
function writeSidecar(root: string, org: ResolvedOrg): void {
  try {
    const dir = path.join(root, PROJECT_MEMORY_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "orgspec.json"), JSON.stringify(org, null, 2), "utf8");
  } catch {
    // best-effort — app config에는 이미 저장됨
  }
}

const ANALYZE_SYSTEM = `You are Agentlas's folder analyzer. Given a map (file list + excerpts) of a folder the user just imported, decide whether it is a SINGLE agent or a MULTI-AGENT TEAM, and if a team, infer its structure. Folder layouts vary wildly across frameworks — judge by meaning, not by fixed folder names.

Rules:
- Output ONLY one JSON object, no prose, no markdown fence.
- Shape: {"kind":"agent"|"team","divisions":[{"role":"...","name":"...","promptFileRef":"relative/path or null","specialists":[{"role":"...","name":"...","promptFileRef":"relative/path or null"}]}]}
- "team" when multiple distinct agents/roles are defined (subfolders each with an agent/persona/prompt file, a roster/orgspec/manifest listing members, several personas). "agent" when it is a single assistant.
- The CEO/orchestrator is implicit — do NOT include it; list its direct reports as "divisions" and their reports as "specialists".
- promptFileRef = the relative file path whose content defines that agent, or null.
- If kind is "agent", divisions = [].
- Be faithful to the folder; do not invent agents that aren't represented.`;

/** 임포트된 폴더를 활성 LLM(CLI/BYOK)으로 분석 — 단일 에이전트인지 팀인지 + (팀이면) 3-tier 구조.
 *  하드코딩 폴더명 매칭이 아니라 LLM이 임의 구조를 의미로 판단한다.
 *  LLM이 없거나 실패하면 null → 호출부가 휴리스틱으로 폴백. */
export async function analyzeFolder(
  dir: string,
  name: string,
): Promise<{ kind: "agent" | "team"; divisions: ResolvedDivision[] } | null> {
  const picked = await pickActiveRunner();
  if (!picked) return null;
  let text = "";
  try {
    const result = await picked.runner(
      {
        systemPrompt: ANALYZE_SYSTEM,
        history: [],
        userPrompt: `Imported folder: ${name}\n\nFolder map:\n${buildFolderMap(dir)}`,
        backendLabel: picked.label,
        model: picked.active.model ?? undefined,
        locale: "en",
      },
      { onPartial: () => {}, onStatus: () => {} },
    );
    text = result.text;
  } catch {
    return null;
  }
  const data = extractJson(text);
  if (!data) return null;
  const rawDivisions = Array.isArray(data.divisions) ? (data.divisions as unknown[]) : [];
  const kind: "agent" | "team" = data.kind === "team" || rawDivisions.length > 0 ? "team" : "agent";

  const used = new Set<string>();
  const mkId = (role: string, nm: string) => {
    const b = slugify(nm || role);
    let id = b;
    let i = 2;
    while (used.has(id)) id = `${b}-${i++}`;
    used.add(id);
    return id;
  };
  const toNode = (raw: unknown): ResolvedNode => {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const role = typeof o.role === "string" ? o.role : typeof o.name === "string" ? o.name : "Agent";
    const nm = typeof o.name === "string" ? o.name : role;
    return {
      id: mkId(role, nm),
      name: nm,
      role,
      prompt: readPromptFile(dir, o.promptFileRef),
      promptFileRef: typeof o.promptFileRef === "string" ? o.promptFileRef : undefined,
    };
  };
  const divisions: ResolvedDivision[] = rawDivisions.slice(0, 24).map((d) => {
    const o = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
    const specialists = Array.isArray(o.specialists)
      ? (o.specialists as unknown[]).slice(0, 24).map(toNode)
      : [];
    return { ...toNode(d), specialists };
  });
  return { kind, divisions };
}

// ── 팀 에이전트 하위 리졸버 ────────────────────────────────
// 조직(firm)이 아닌 standalone 팀 에이전트의 서브에이전트를 해석한다.
// 즉시엔 결정적(agents/ 스캔), 백그라운드로 LLM(analyzeFolder)이 정밀 재판정해
// 캐시 + entity_kind 자가교정. 러너가 없으면 결정적 결과만 쓴다(엣지케이스 폴백).

const SYSTEM_SUBAGENT_RE =
  /(orchestrator|pm[\s-]?soul|memory[\s-]?curator|policy[\s-]?gate|eval[\s-]?qa|task[\s-]?bias|\bhq\b|governance)/i;

function isUserFacingSubAgent(name?: string, role?: string): boolean {
  return !SYSTEM_SUBAGENT_RE.test(`${name ?? ""} ${role ?? ""}`);
}

function agentSourceDir(agentId: string): string | null {
  const agent = getAgentById(agentId);
  if (!agent) return null;
  const route = getRoute(agentId);
  if (route?.path && fs.existsSync(route.path)) return route.path;
  const materialized = agentFolderPath(agent.slug);
  return fs.existsSync(materialized) ? materialized : null;
}

/** agents/ 하위 폴더를 결정적으로 스캔 — 즉시 표시 + 러너 없을 때 폴백. */
function deterministicSubAgents(dir: string): Array<{ name: string; role: string }> {
  const out: Array<{ name: string; role: string }> = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(path.join(dir, "agents"), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // "50-research-worker" → "Research Worker"
    const label = entry.name.replace(/^\d+[-_]?/, "").replace(/[-_]+/g, " ").trim();
    if (!label) continue;
    const titled = label.replace(/\b\w/g, (c) => c.toUpperCase());
    if (!isUserFacingSubAgent(titled, entry.name)) continue;
    out.push({ name: titled, role: titled });
  }
  return out;
}

const teamResolveInflight = new Set<string>();

function refineTeamWithLlm(agentId: string, dir: string, name: string, cacheKey: string): void {
  if (teamResolveInflight.has(agentId)) return;
  teamResolveInflight.add(agentId);
  void analyzeFolder(dir, name)
    .then((llm) => {
      if (!llm) return;
      const subAgents: Array<{ name: string; role: string }> = [];
      for (const division of llm.divisions) {
        if (isUserFacingSubAgent(division.name, division.role)) {
          subAgents.push({ name: division.name, role: division.role });
        }
        for (const specialist of division.specialists) {
          if (isUserFacingSubAgent(specialist.name, specialist.role)) {
            subAgents.push({ name: specialist.name, role: specialist.role });
          }
        }
      }
      const refined: AgentTeamResolution = { kind: llm.kind, subAgents };
      setMeta(cacheKey, JSON.stringify(refined));
      setAgentEntityKind(agentId, llm.kind); // 자가교정: LLM이 single이라 판정하면 다음 새로고침에 이동
    })
    .catch(() => {
      /* LLM 실패는 결정적 결과 유지 */
    })
    .finally(() => {
      teamResolveInflight.delete(agentId);
    });
}

/**
 * 팀 에이전트의 서브에이전트를 해석한다. 캐시(LLM 정밀판정) 있으면 즉시 반환,
 * 없으면 결정적 결과를 즉시 주고 백그라운드로 LLM을 돌려 다음 번을 위해 캐시/자가교정한다.
 */
export async function resolveAgentTeam(agentId: string): Promise<AgentTeamResolution | null> {
  const agent = getAgentById(agentId);
  if (!agent) return null;
  const dir = agentSourceDir(agentId);
  if (!dir) return null;

  const cacheKey = `agent_team:${agentId}`;
  const cached = getMeta(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as AgentTeamResolution;
      if (parsed && (parsed.kind === "agent" || parsed.kind === "team")) return parsed;
    } catch {
      /* 손상 캐시 무시 */
    }
  }

  const subAgents = deterministicSubAgents(dir);
  if (subAgents.length > 0) {
    // 표준 agents/ 레이아웃 — 구조가 명확하니 즉시 확정(LLM 불필요, 캐시+자가교정).
    const result: AgentTeamResolution = { kind: "team", subAgents };
    setMeta(cacheKey, JSON.stringify(result));
    setAgentEntityKind(agentId, "team");
    return result;
  }
  // 서브가 안 잡히는 비표준/애매 구조 → LLM이 임의 구조를 판정(엣지케이스 처리).
  refineTeamWithLlm(agentId, dir, agent.name, cacheKey);
  return { kind: "agent", subAgents: [] };
}
