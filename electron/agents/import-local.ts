// 로컬 에이전트/팀 폴더 임포트.
// 드래그&드롭 또는 폴더 선택으로 받은 기존 에이전트 폴더를 분석한다:
//   - 어떤 CLI 런타임 전용인지 라벨 (CLAUDE.md→claude-code, AGENTS.md→codex, GEMINI.md→gemini, .cursor→cursor)
//   - 단일 에이전트인지 팀인지 (TEAM.md / ceo / hr-departments)
//   - 이름·태그라인·시스템 프롬프트
// 원본 에이전트 파일은 그대로 두고, 위치를 routes.json에 라우팅 저장한다.
// 단, Agentlas 운영 sidecar인 .agentlas/는 materialize할 수 있다.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { setRoute, listRoutes, type RuntimeLabel } from "./routes";
import { upsertLocalTeamFirm } from "../store/firms";
import { analyzeFolder } from "./org-resolver";
import { saveResolvedOrg } from "../store/org-spec";
import { detectEnvRequirementsFromFolder } from "./env-detect";
import { appendMemoryTicket, ensureProjectMemory } from "../memory/project-files";
import { MEMORY_LOG_FILE, MEMORY_MAP_FILE } from "../architecture/manifest";
import type { FirmOrgNode, InstalledAgent, InstalledFirm, ResolvedOrg } from "../../shared/types";

const TONES: InstalledAgent["tone"][] = ["blue", "green", "purple", "amber", "peach"];

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 폴더 안의 파일 단서로 런타임 라벨들을 감지. 우선순위 순으로 정렬해 반환. */
export function detectRuntimeLabels(dir: string): RuntimeLabel[] {
  const labels: RuntimeLabel[] = [];
  if (exists(path.join(dir, "CLAUDE.md")) || isDir(path.join(dir, ".claude"))) labels.push("claude-code");
  if (exists(path.join(dir, "AGENTS.md"))) labels.push("codex");
  if (exists(path.join(dir, "GEMINI.md"))) labels.push("gemini");
  if (isDir(path.join(dir, ".cursor")) || exists(path.join(dir, ".cursorrules"))) labels.push("cursor");
  if (labels.length === 0) labels.push("generic");
  return labels;
}

// 에이전트 1명을 정의하는 흔한 파일들 (하위 폴더가 에이전트인지 판별용).
const AGENT_DEF_FILES = [
  "AGENT.md",
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  "system-prompt.md",
  "system.md",
  "soul.md",
  "prompt.md",
  "persona.md",
  "manifest.md",
];
// 팀의 멤버/부서를 담는 흔한 컨테이너 디렉토리명 (프레임워크마다 다양).
const TEAM_CONTAINER_DIRS = [
  "agents",
  "team",
  "teams",
  "crew",
  "members",
  "roles",
  "subagents",
  "sub-agents",
  "squad",
  "staff",
  "hr-departments",
  "departments",
];
// 팀 전체를 선언하는 흔한 스펙/매니페스트 파일.
const TEAM_SPEC_FILES = [
  "orgspec.yaml",
  "orgspec.yml",
  "orgspec.json",
  "team.yaml",
  "team.yml",
  "team.json",
  "crew.yaml",
  "crew.yml",
  "agents.yaml",
  "agents.yml",
  "TEAM.md",
];

function hasAgentDef(d: string): boolean {
  return AGENT_DEF_FILES.some((f) => exists(path.join(d, f)));
}

/** 에이전트 정의를 가진 하위 폴더 수 (≥2면 멀티에이전트 팀으로 본다). */
function countAgentLikeSubdirs(root: string): number {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .filter((e) => hasAgentDef(path.join(root, e.name))).length;
  } catch {
    return 0;
  }
}

// 임의 구조의 팀을 일반적으로 인식 — AppBridge 전용이 아니라 흔한 멀티에이전트 레이아웃 전반.
// (구체적 3-tier 구조는 임포트 후 "Resolve team" LLM 리졸버가 폴더를 읽어 정제한다.)
function detectKind(dir: string): "agent" | "team" {
  for (const base of [dir, path.join(dir, ".claude")]) {
    // 1) 팀 스펙/매니페스트 파일
    if (TEAM_SPEC_FILES.some((f) => exists(path.join(base, f)))) return "team";
    // 2) CEO/오케스트레이터 + 멤버 컨테이너 디렉토리
    if (isDir(path.join(base, "ceo")) || isDir(path.join(base, "projects"))) return "team";
    if (TEAM_CONTAINER_DIRS.some((d) => isDir(path.join(base, d)))) return "team";
    // 3) 일반 휴리스틱: 에이전트 정의를 가진 하위 폴더가 2개 이상
    if (countAgentLikeSubdirs(base) >= 2) return "team";
  }
  return "agent";
}

/**
 * 팀이면 CEO 두뇌(.claude/ceo/AGENT.md 등)를 시스템 프롬프트로 삼고, 임의의 작업 폴더(cwd)에서
 * 실행돼도 동작하도록 팀 루트 절대경로 오리엔테이션 헤더를 붙인다.
 * (CEO 브레인은 ./playbook.md, ../orgspec.yaml 같은 상대경로를 쓰므로 그냥 쓰면 다른 cwd에서 깨진다.)
 */
function buildTeamSystemPrompt(dir: string, name: string): string {
  const ceoBrain = readFirst(
    dir,
    [
      path.join(".claude", "ceo", "AGENT.md"),
      path.join("ceo", "AGENT.md"),
      path.join("ceo", "CLAUDE.md"),
      path.join("ceo", "system-prompt.md"),
      "ceo.md",
      "orchestrator.md",
      "lead.md",
      "TEAM.md",
    ],
    12000,
  );
  const brain =
    ceoBrain ||
    readFirst(
      dir,
      ["AGENTS.md", "CLAUDE.md", path.join(".claude", "CLAUDE.md"), "manifest.md", "README.md"],
      12000,
    ) ||
    `Act as the orchestrating CEO of ${name}.`;
  const claudeRoot = path.join(dir, ".claude");
  const header =
    `You are the CEO / orchestrator of the "${name}" agent team, now launched through Agentlas.\n\n` +
    `TEAM ROOT: ${dir}\n` +
    `Team definition (org spec, playbooks, department & role agents) lives under: ${claudeRoot}\n` +
    `When the instructions below reference team files with relative paths (e.g. ./playbook.md, ../orgspec.yaml, .claude/...), resolve them as ABSOLUTE paths under that team root and read them as needed.\n\n` +
    `TARGET PROJECT: your current working directory is the user's target project. Do ALL building, file creation, and delivery in the current working directory — never inside the team root. Route work to the right department/specialist, sequence multi-step work, keep a brief CEO-style status in Korean, and apply read-only-first safety gates for high-risk actions (billing/auth/security/deploy).\n\n` +
    `--- TEAM BRAIN ---\n`;
  return (header + brain).slice(0, 16000);
}

function readFirst(dir: string, candidates: string[], maxChars = 8000): string {
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (exists(p) && !isDir(p)) {
      try {
        const raw = fs.readFileSync(p, "utf8");
        return raw.slice(0, maxChars);
      } catch {
        // continue
      }
    }
  }
  return "";
}

/** manifest.md / 첫 마크다운 제목 / 폴더명에서 표시 이름 추출. */
function readName(dir: string): string {
  const manifest = readFirst(dir, ["manifest.md", "AGENT.md", "CLAUDE.md", "README.md"], 2000);
  const m = manifest.match(/^#\s+(.+)$/m);
  if (m) {
    return m[1].replace(/\(.*?\)/g, "").trim().slice(0, 60) || path.basename(dir);
  }
  return path.basename(dir);
}

function readTagline(dir: string): string {
  const text = readFirst(dir, ["README.md", "soul.md", "AGENT.md"], 2000);
  // 첫 번째 헤더가 아닌 비어있지 않은 줄
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#") && !t.startsWith(">")) return t.slice(0, 140);
  }
  return "";
}

function uniqueSlug(base: string): string {
  const db = getDb();
  let slug = base;
  let n = 1;
  while (db.prepare("SELECT 1 FROM installed_agents WHERE slug = ?").get(slug)) {
    slug = `${base}-${++n}`;
  }
  return slug;
}

export interface LocalImportResult {
  agent: InstalledAgent;
  runtime: RuntimeLabel;
  labels: RuntimeLabel[];
  kind: "agent" | "team";
  path: string;
}

/** 팀 폴더의 부서/멤버 목록 — 흔한 컨테이너 디렉토리, 없으면 에이전트 정의를 가진 하위 폴더.
 *  (정확한 3-tier는 "Resolve team" LLM 리졸버가 정제. 여기선 firm 생성용 대략 목록.) */
function readTeamDepartments(dir: string): string[] {
  // 1) 알려진 컨테이너 디렉토리(루트/.claude)의 하위 폴더명
  for (const base of [dir, path.join(dir, ".claude")]) {
    for (const c of TEAM_CONTAINER_DIRS) {
      const root = path.join(base, c);
      try {
        if (isDir(root)) {
          const names = fs
            .readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .map((e) => e.name)
            .sort();
          if (names.length > 0) return names;
        }
      } catch {
        // continue
      }
    }
  }
  // 2) 폴백: 루트(또는 .claude)에서 에이전트 정의를 가진 하위 폴더들
  for (const base of [dir, path.join(dir, ".claude")]) {
    try {
      const names = fs
        .readdirSync(base, { withFileTypes: true })
        .filter(
          (e) =>
            e.isDirectory() &&
            !e.name.startsWith(".") &&
            e.name !== "ceo" &&
            e.name !== "projects" &&
            e.name !== "node_modules" &&
            hasAgentDef(path.join(base, e.name)),
        )
        .map((e) => e.name)
        .sort();
      if (names.length > 0) return names;
    } catch {
      // continue
    }
  }
  return [];
}

/** "writer-desk" → "Writer Desk", "persona-qa" → "Persona Qa" 같은 표시용 라벨. */
function deptLabel(name: string): string {
  return name
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** 팀이면 회사(firm)로도 등록 — CEO = 팀 에이전트, 부서는 조직도 정보 노드. slug 기준 멱등.
 *  LLM 분석 divisions가 있으면 그것으로 3-tier 조직도(본부+전문가)를 구성, 없으면 휴리스틱 부서 스캔. */
function registerTeamAsFirm(
  dir: string,
  agentId: string,
  slug: string,
  name: string,
  tagline: string,
  divisions?: ResolvedOrg["divisions"],
): InstalledFirm | null {
  let orgChart: Array<FirmOrgNode & { agentId: string }>;
  if (divisions && divisions.length > 0) {
    orgChart = [{ agentSlug: slug, agentId, role: "CEO", reportsTo: null }];
    for (const d of divisions) {
      const dSlug = `${slug}-${d.id}`;
      orgChart.push({ agentSlug: dSlug, agentId: "", role: d.role || d.name, reportsTo: slug });
      for (const s of d.specialists ?? []) {
        orgChart.push({ agentSlug: `${dSlug}-${s.id}`, agentId: "", role: s.role || s.name, reportsTo: dSlug });
      }
    }
  } else {
    const depts = readTeamDepartments(dir);
    orgChart = [
      { agentSlug: slug, agentId, role: "CEO", reportsTo: null },
      ...depts.map((d) => ({ agentSlug: `${slug}-${d}`, agentId: "", role: deptLabel(d), reportsTo: slug })),
    ];
  }
  try {
    return upsertLocalTeamFirm({ slug: `firm-${slug}`, name, tagline, ceoAgentId: agentId, orgChart });
  } catch (err) {
    console.error("[import] registerTeamAsFirm failed:", err);
    return null;
  }
}

function appendImportMemoryTicket(input: {
  dir: string;
  id: string;
  slug: string;
  name: string;
  kind: "agent" | "team";
  runtime: RuntimeLabel;
  labels: RuntimeLabel[];
  importedAt: string;
}): void {
  ensureProjectMemory(input.dir, input.name);
  appendMemoryTicket(input.dir, {
    ticket_id: `memtkt_${randomUUID().replace(/-/g, "")}`,
    created_at: input.importedAt,
    source_agent: "agentlas-importer",
    task_id: `import_${input.slug}`,
    project_id: input.slug,
    project_root: input.dir,
    source_map_ref: `.agentlas/${MEMORY_MAP_FILE}`,
    target_agent: "memory-curator",
    return_channel: {
      kind: "file_inbox",
      ref: `.agentlas/${MEMORY_LOG_FILE}`,
    },
    status: "acked",
    idempotency_key: `agentlas-import:${input.id}:${input.dir}`,
    priority: "normal",
    queue_policy: {
      ack_required: true,
      max_batch_size: 20,
      overflow_action: "split_ticket",
      retry_after_seconds: 300,
    },
    candidates: [
      {
        event_id: `memevt_import_${input.id.replace(/[^A-Za-z0-9_-]/g, "")}`,
        timestamp: input.importedAt,
        source_agent: "agentlas-importer",
        task_id: `import_${input.slug}`,
        project_id: input.slug,
        memory_kind: "fact",
        content: `Imported local ${input.kind} "${input.name}" is registered in Agentlas with runtime ${input.runtime}.`,
        suggested_scope: "agent_repo",
        sensitivity: "internal",
        confidence: "high",
        retrieval_policy: "balanced",
        evidence_refs: [".agentlas/memory-map.json", "agent-routes.json"],
        ttl: "durable",
        request_context: {
          user_intent: "Import a local Agentlas agent or team and make it routable.",
          trigger_terms: ["import", "local agent", input.kind, input.runtime],
          cwd_at_request: input.dir,
          target_project: input.slug,
          target_path: input.dir,
          cross_context: false,
          outcome: "Agent route registered and Memory Curator ticket path materialized.",
        },
      },
    ],
    diagnostics: {
      legacy_shape_detected: false,
      normalization_notes: [
        "import route materialized .agentlas memory-map/vault references",
        `labels=${input.labels.join(",")}`,
      ],
      failure_mode: null,
    },
  });
}

  /** 로컬 폴더를 분석·등록하고 라우팅 저장. .agentlas sidecar may be written for routing metadata. */
export async function importLocalFolder(absPath: string): Promise<LocalImportResult> {
  const dir = path.resolve(absPath);
  if (!isDir(dir)) throw new Error(`Not a folder: ${absPath}`);

  const labels = detectRuntimeLabels(dir);
  const runtime = labels[0];
  const name = readName(dir);
  // 활성 LLM(CLI/BYOK)으로 폴더를 인식 — 단일 에이전트 vs 팀 + 3-tier 구조. 하드코딩 폴더명 매칭 아님.
  // 런타임이 없거나 실패하면 null → 휴리스틱(detectKind)으로 폴백.
  const analysis = await analyzeFolder(dir, name).catch(() => null);
  const kind = analysis ? analysis.kind : detectKind(dir);
  const tagline = readTagline(dir) || (kind === "team" ? "Imported local team" : "Imported local agent");
  const systemPrompt =
    kind === "team"
      ? buildTeamSystemPrompt(dir, name)
      : readFirst(dir, ["system-prompt.md", "soul.md", "AGENT.md", "CLAUDE.md", "AGENTS.md", "GEMINI.md"]) ||
        `You are ${name}, a locally imported agent.`;
  const envRequirements = detectEnvRequirementsFromFolder(dir, systemPrompt);
  const envReqsJson = JSON.stringify(envRequirements);

  const now = new Date().toISOString();

  // 멱등성: 같은 폴더가 이미 임포트돼 있으면 새로 만들지 않고 그 에이전트를 갱신한다.
  // (앱에서 같은 폴더를 다시 드래그해도 local-...-2 중복이 생기지 않도록.)
  const existing = listRoutes().find((r) => {
    try {
      return path.resolve(r.path) === dir;
    } catch {
      return false;
    }
  });
  let row = existing
    ? (getDb().prepare("SELECT id, slug, tone FROM installed_agents WHERE id = ?").get(existing.agentId) as
        | { id: string; slug: string; tone: InstalledAgent["tone"] }
        | undefined)
    : undefined;

  let id: string;
  let slug: string;
  let tone: InstalledAgent["tone"];
  if (existing && row) {
    id = row.id;
    slug = row.slug;
    tone = row.tone;
    getDb()
      .prepare(
        "UPDATE installed_agents SET name = ?, name_en = ?, tagline = ?, tagline_en = ?, system_prompt = ?, env_requirements_json = ?, visibility = 'visible' WHERE id = ?",
      )
      .run(name, name, tagline, tagline, systemPrompt, envReqsJson, id);
  } else {
    const baseSlug =
      "local-" +
      path
        .basename(dir)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "local-agent";
    slug = uniqueSlug(baseSlug);
    id = randomUUID();
    tone = TONES[Math.abs(hash(slug)) % TONES.length];
    getDb()
      .prepare(
        `INSERT INTO installed_agents
         (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
          env_requirements_json, preferred_backend, trust_grade, installed_at, tone, visibility)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'visible')`,
      )
      .run(id, slug, name, name, tagline, tagline, systemPrompt, "[]", envReqsJson, null, "C", now, tone);
  }

  setRoute({ agentId: id, path: dir, runtime, labels, kind, importedAt: now });
  appendImportMemoryTicket({ dir, id, slug, name, kind, runtime, labels, importedAt: now });

  // 팀이면 FIRMS에도 등록 → 사이드바 FIRMS 목록에 뜨고 "Command CEO" 가능.
  if (kind === "team") {
    const firm = registerTeamAsFirm(dir, id, slug, name, tagline, analysis?.divisions);
    // LLM이 구조를 인식했으면 ResolvedOrg로 저장 → 오케스트레이터/조직도가 즉시 진짜 3-tier로 동작.
    // 원본 폴더는 절대 수정하지 않는다 (앱 설정 + .agentlas sidecar에만 기록).
    if (firm && analysis && analysis.divisions.length > 0) {
      const org: ResolvedOrg = {
        source: "resolver",
        ceo: { id, name, role: "CEO", agentId: id, prompt: systemPrompt },
        divisions: analysis.divisions,
        sourcePath: dir,
        resolvedAt: now,
      };
      saveResolvedOrg(firm.id, org);
    }
  }

  const agent: InstalledAgent = {
    id,
    slug,
    name,
    nameEn: name,
    tagline,
    taglineEn: tagline,
    systemPrompt,
    mcpServers: [],
    envRequirements,
    preferredBackend: null,
    trustGrade: "C",
    installedAt: now,
    tone,
    runtimeLabel: runtime,
    localPath: dir,
    kind,
  };
  return { agent, runtime, labels, kind, path: dir };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}
