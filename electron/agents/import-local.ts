// 로컬 에이전트/팀 폴더 임포트.
// 드래그&드롭 또는 폴더 선택으로 받은 기존 에이전트 폴더를 분석한다:
//   - 어떤 CLI 런타임 전용인지 라벨 (CLAUDE.md→claude-code, AGENTS.md→codex, GEMINI.md→gemini, .cursor→cursor)
//   - 단일 에이전트인지 팀인지 (TEAM.md / ceo / hr-departments)
//   - 이름·태그라인·시스템 프롬프트
// 원본은 그대로 두고, 위치를 routes.json에 라우팅 저장한다 (앱이 그 폴더를 그대로 사용).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { removeRoute, replaceRoute, listRoutes, type RuntimeLabel } from "./routes";
import { getFirmBySlug, upsertLocalTeamFirm } from "../store/firms";
import { scanAgentFolder, type FolderScan, type ScanMember } from "./folder-scan";
import { clearResolvedOrg, saveResolvedOrg } from "../store/org-spec";
import { detectEnvRequirementsFromFolder } from "./env-detect";
import type { FirmOrgNode, InstalledAgent, InstalledFirm, ResolvedOrg } from "../../shared/types";
import { currentUiLocale } from "../ui-locale";
import { readCanonicalPromptFromDirectory } from "./prompt-authority";
import { detectRuntimeLabels } from "./runtime-labels";

export { detectRuntimeLabels } from "./runtime-labels";

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

// 스캔에 들어가지 않는 폴더(빌드/의존성/캐시). 여기 안에서는 에이전트를 찾지 않는다.
const SKIP_SCAN_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "release", "vendor",
  ".cache", "coverage", ".turbo", ".venv", "venv", "__pycache__", ".idea", ".vscode",
]);

/** 이 폴더 자체가 에이전트/팀 루트로 보이나 — .agentlas·런타임 마커·에이전트 정의·팀 마커 기준. */
function isAgentyDir(dir: string): boolean {
  if (isDir(path.join(dir, ".agentlas"))) return true; // Agentlas가 이미 붙인 폴더 = 확실한 에이전트/프로젝트
  if (detectRuntimeLabels(dir).some((l) => l !== "generic")) return true;
  if (hasAgentDef(dir) || hasAgentDef(path.join(dir, ".claude"))) return true;
  if (detectKind(dir) === "team") return true;
  return false;
}

/** 단일 에이전트로서의 실체(정의 파일/런타임 마커/.agentlas) — 팀 구성원 못 찾았을 때 격하 판단용. */
function hasAgentSubstance(dir: string): boolean {
  return (
    isDir(path.join(dir, ".agentlas")) ||
    detectRuntimeLabels(dir).some((l) => l !== "generic") ||
    hasAgentDef(dir) ||
    hasAgentDef(path.join(dir, ".claude"))
  );
}

/**
 * 사용자는 대개 '정확한' 에이전트 폴더가 아니라 근처/상위 폴더를 고른다. 그래서 선택 폴더가
 * 그 자체로 에이전트/팀이 아니면 근방을 재귀로(너무 깊지 않게) 훑어 실제 루트(들)를 찾는다.
 * 루트를 찾으면 그 안으로는 더 내려가지 않는다(가장 얕은 루트만 수집).
 */
function locateAgentRoots(selectedDir: string, maxDepth = 4): string[] {
  if (isAgentyDir(selectedDir)) return [selectedDir];
  const found: string[] = [];
  let frontier: Array<{ dir: string; depth: number }> = [{ dir: selectedDir, depth: 0 }];
  while (frontier.length > 0 && found.length < 32) {
    const next: Array<{ dir: string; depth: number }> = [];
    for (const { dir, depth } of frontier) {
      if (depth >= maxDepth) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue; // 숨김폴더 미진입(.claude는 isAgentyDir가 부모에서 확인)
        if (SKIP_SCAN_DIRS.has(e.name.toLowerCase())) continue;
        const child = path.join(dir, e.name);
        if (isAgentyDir(child)) found.push(child);
        else next.push({ dir: child, depth: depth + 1 });
      }
    }
    frontier = next;
  }
  return found;
}

/** 팀 루트 아래 중첩된 에이전트 정의 폴더명들 — 멤버가 깊이 들어가 있는 팀의 조직도 구성용. */
function findNestedAgentDirNames(root: string, maxDepth = 4): string[] {
  const names = new Set<string>();
  let frontier: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (frontier.length > 0 && names.size < 48) {
    const next: Array<{ dir: string; depth: number }> = [];
    for (const { dir, depth } of frontier) {
      if (depth >= maxDepth) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        if (SKIP_SCAN_DIRS.has(e.name.toLowerCase()) || e.name === "ceo" || e.name === "projects") continue;
        const child = path.join(dir, e.name);
        // 멤버는 정의 파일뿐 아니라 .claude/런타임 마커/.agentlas 로도 인정(로케이터와 정합).
        if (
          hasAgentDef(child) ||
          detectRuntimeLabels(child).some((l) => l !== "generic") ||
          isDir(path.join(child, ".agentlas"))
        ) {
          names.add(e.name);
        } else {
          next.push({ dir: child, depth: depth + 1 });
        }
      }
    }
    frontier = next;
  }
  return [...names].sort();
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

// 공유/임시 폴더명 — 이런 폴더 자체를 회사(firm)로 등록하면 안 된다. 빌드 워크스페이스나
// 다운로드/휴지통 같은 부모 폴더가 단지 여러 에이전트를 "담고 있다"는 이유로 회사로 잡히는 걸 막는다.
const JUNK_DIRS = /^(trash|tmp|temp|downloads|desktop|documents|untitled|new folder|cache)$/i;

/** 명시적 팀 마커(의도적으로 만든 팀 구조). 이게 있으면 정크명이어도 진짜 팀으로 인정한다. */
function hasTeamMarkers(dir: string): boolean {
  for (const base of [dir, path.join(dir, ".claude")]) {
    if (TEAM_SPEC_FILES.some((f) => exists(path.join(base, f)))) return true;
    if (isDir(path.join(base, "ceo"))) return true;
  }
  return false;
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

// 런타임 어댑터/도구 문서의 제목은 에이전트 정체성이 아니다 — 예: "▶CLAUDE.md — Claude Code 어댑터".
// 이런 헤딩을 팀/에이전트 이름으로 쓰면 안 되므로 거른다.
const ADAPTER_HEADING = /어댑터|adapter|\.md\b|claude\s*code|\bcodex\b|\bgemini\b|\bcursor\b|read\s*me|table of contents|목차/i;

/** 마크다운 헤딩 후보를 정제. 앞의 장식 기호(▶ ▷ ► ▸ • – — # 등)와 괄호 보조설명을 제거. */
function cleanHeading(raw: string): string {
  return raw
    .replace(/^[\s#>►▶▷▸▹•·\-–—*]+/, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** "k-startup-team" → "K Startup Team" 같은 폴더명 기반 표시 이름(폴백). */
function prettyFromDir(dir: string): string {
  const pretty = deptLabel(path.basename(dir));
  return pretty || path.basename(dir);
}

/** manifest/정체성 파일의 첫 제목 → 폴더명 순으로 표시 이름 추출.
 *  어댑터/도구 문서(CLAUDE.md 등)의 제목은 정체성이 아니므로 건너뛴다. */
function readName(dir: string): string {
  // 정체성 파일을 우선(manifest/TEAM/AGENT). 어댑터 문서(CLAUDE/AGENTS/GEMINI/README)는 뒤로.
  const candidates = ["manifest.md", "TEAM.md", "AGENT.md", "soul.md", "persona.md", "CLAUDE.md", "AGENTS.md", "GEMINI.md", "README.md"];
  for (const file of candidates) {
    const p = path.join(dir, file);
    if (!exists(p) || isDir(p)) continue;
    let text = "";
    try {
      text = fs.readFileSync(p, "utf8").slice(0, 2000);
    } catch {
      continue;
    }
    const m = text.match(/^#\s+(.+)$/m);
    if (!m) continue;
    const name = cleanHeading(m[1]).slice(0, 60);
    // 비었거나 어댑터/도구 문서 제목이면 이 파일은 스킵하고 다음 후보로.
    if (!name || ADAPTER_HEADING.test(name)) continue;
    return name;
  }
  // 정크/공유 폴더명(trash 등)을 그대로 회사/에이전트 이름으로 노출하지 않는다.
  if (JUNK_DIRS.test(path.basename(dir).toLowerCase())) {
    return `Unnamed (${path.basename(dir)})`;
  }
  return prettyFromDir(dir);
}

function readTagline(dir: string): string {
  const text = readFirst(dir, ["README.md", "TEAM.md", "soul.md", "AGENT.md"], 2000);
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
  /** Team imports are not complete until the matching firm/org projection exists. */
  firmId?: string;
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
  // 3) 재귀 폴백: 멤버가 더 깊이 중첩된 팀(얕은 스캔이 비었을 때만). 이게 "구성원 없음"의 주 원인.
  return findNestedAgentDirNames(dir, 4);
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
  scanMembers?: ScanMember[],
): InstalledFirm | null {
  // 최후 방어선: 정크/공유 폴더(trash 등)는 명시적 팀 마커가 없으면 회사로 등록하지 않는다.
  if (JUNK_DIRS.test(path.basename(dir).toLowerCase()) && !hasTeamMarkers(dir)) {
    return null;
  }
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
  } else if (scanMembers && scanMembers.length > 0) {
    // 결정적 스캐너가 찾은 구성원 — LLM 없이도 조직도에 구성원이 반드시 들어간다.
    orgChart = [
      { agentSlug: slug, agentId, role: "CEO", reportsTo: null },
      ...scanMembers.map((m) => ({ agentSlug: `${slug}-${m.id}`, agentId: "", role: m.role || m.name, reportsTo: slug })),
    ];
  } else {
    const depts = readTeamDepartments(dir);
    orgChart = [
      { agentSlug: slug, agentId, role: "CEO", reportsTo: null },
      ...depts.map((d) => ({ agentSlug: `${slug}-${d}`, agentId: "", role: deptLabel(d), reportsTo: slug })),
    ];
  }
  return upsertLocalTeamFirm({ slug: `firm-${slug}`, name, tagline, ceoAgentId: agentId, orgChart });
}

const localImportInFlight = new Map<string, Promise<LocalImportResult>>();

/**
 * 같은 폴더에 Build 자동 등록과 사용자의 수동 "조직도에서 열기"가 겹쳐도
 * 하나의 durable commit만 수행한다.
 */
export function importLocalFolder(
  absPath: string,
  locale: "ko" | "en" = currentUiLocale(),
): Promise<LocalImportResult> {
  const key = path.resolve(absPath);
  const existing = localImportInFlight.get(key);
  if (existing) return existing;
  const task = importLocalFolderOnce(key, locale).finally(() => {
    if (localImportInFlight.get(key) === task) localImportInFlight.delete(key);
  });
  localImportInFlight.set(key, task);
  return task;
}

/** 로컬 폴더를 분석·등록하고 라우팅 저장. 원본 파일은 건드리지 않는다. */
async function importLocalFolderOnce(
  absPath: string,
  locale: "ko" | "en",
): Promise<LocalImportResult> {
  const ko = locale === "ko";
  const selected = path.resolve(absPath);
  if (!isDir(selected)) throw new Error(`Not a folder: ${absPath}`);

  // 근방 탐색: 사용자는 정확한 에이전트 폴더가 아니라 상위/근처를 고르기 마련이므로, 선택 폴더가
  // 그 자체로 에이전트/팀이 아니면 재귀로 실제 루트(들)를 찾는다.
  const roots = locateAgentRoots(selected);
  if (roots.length === 0) {
    // 최후 폴백: 규격 마커는 없지만 최상위에 마크다운이 있으면 "싱글 에이전트, 엔트리=최상위 md"로 수용.
    const loose = scanAgentFolder(selected);
    if (!loose.entryFile && loose.members.length === 0) {
      throw new Error(
        ko
          ? "이 폴더 안에서 에이전트를 찾지 못했어요. 에이전트 폴더나 그 상위 폴더를 골라 주세요."
          : "Couldn't find an agent inside this folder. Pick an agent folder or its parent folder.",
      );
    }
    roots.push(selected);
  }
  const selectedIsAgenty = isAgentyDir(selected);
  const junky = JUNK_DIRS.test(path.basename(selected).toLowerCase());
  // 선택 폴더가 그 자체로 에이전트/팀이면 그대로. 아니면: 여러 에이전트를 담은(정크명 아닌) 폴더는
  // 팀으로 리패징해 조직도에 구성원 등록, 하나면 그 실제 에이전트 폴더로 이동해 임포트.
  const forceTeam = !selectedIsAgenty && roots.length >= 2 && !junky;
  const dir = selectedIsAgenty || forceTeam ? selected : roots[0];

  const labels = detectRuntimeLabels(dir);
  const runtime = labels[0];
  // 결정적 스캐너: manifest roster → 컨테이너 디렉토리 → 정의 하위폴더 → 중첩 → 싱글 폴백.
  // LLM 유무와 무관하게 구성원/엔트리를 반드시 찾아내는 기반 계층.
  const scan: FolderScan = scanAgentFolder(dir);
  // 팀 이름: manifest name → 정체성 파일 헤딩 → 폴더명 (CLAUDE.md 어댑터 헤딩은 최후순위로 걸러짐)
  const name = scan.manifestName || readName(dir);
  // 등록은 로컬 DB 반영의 일부다. 여기서 활성 LLM을 다시 호출하면 Build가 이미 끝난
  // 뒤에도 수분간 조직도 등록이 멈출 수 있다. 결정적 스캐너가 즉시 권위 판정을 내리고,
  // 사용자가 명시적으로 조직 정밀 분석을 요청할 때만 org-resolver가 LLM으로 보강한다.
  let kind = scan.kind === "team" ? "team" : detectKind(dir);
  // 결정적 스캔이 구성원 2+를 찾았으면 팀으로 확정 (LLM이 "agent"로 오판해도 구성원을 버리지 않는다).
  if (scan.members.length >= 2) kind = "team";
  // 근본 가드: 정크/공유 폴더(trash 등)가 단지 ≥2개의 에이전트를 담고 있다는 이유만으로 회사로
  // 잡히는 걸 막는다. 명시적 팀 마커(TEAM.md/ceo 등)가 없으면 회사가 아니라 단일 에이전트로 본다.
  // (analysis.kind가 detectKind 가드를 우회하므로 여기 결정 지점에서 한 번 더 막아야 한다.)
  if (kind === "team" && JUNK_DIRS.test(path.basename(dir).toLowerCase()) && !hasTeamMarkers(dir)) {
    kind = "agent";
  }
  // 근방에 여러 에이전트가 있어 선택 폴더를 팀으로 리패징하기로 한 경우 팀으로 확정.
  if (forceTeam) kind = "team";
  // 팀으로 잡혔는데 실제 구성원(에이전트)을 못 찾으면 "구성원 없음" 빈 조직도로 등록하지 않는다.
  // 단일 에이전트 실체가 있으면 에이전트로 격하, 그마저 없으면 명확한 메시지로 중단한다.
  if (kind === "team") {
    const teamHasMembers =
      scan.members.length > 0 ||
      readTeamDepartments(dir).length > 0;
    if (!teamHasMembers) {
      if (hasAgentSubstance(dir)) {
        kind = "agent";
      } else {
        throw new Error(
          ko
            ? "이 폴더는 팀처럼 보이는데 구성원(에이전트)을 찾지 못했어요. 각 구성원 폴더에 CLAUDE.md · AGENT.md 같은 정의 파일이나 .agentlas 폴더가 있는지 확인해 주세요."
            : "This folder looks like a team, but no member agents were found. Check that each member folder has a definition file like CLAUDE.md/AGENT.md or an .agentlas folder.",
        );
      }
    }
  }
  const tagline = readTagline(dir) || (kind === "team" ? "Imported local team" : "Imported local agent");
  const systemPrompt =
    kind === "team"
      ? buildTeamSystemPrompt(dir, name)
      : readCanonicalPromptFromDirectory(dir)?.content ||
        (scan.entryFile ? readFirst(dir, [scan.entryFile]) : "") ||
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
  }
  let firmId: string | undefined;
  const db = getDb();
  const nextRoute = { agentId: id, path: dir, runtime, labels, kind, importedAt: now } as const;
  const staleRouteIds = existing && existing.agentId !== id ? [existing.agentId] : [];
  // routes.json uses atomic replacement. Persist it before the synchronous DB
  // transaction so a route-write failure cannot leave a newly visible agent
  // without its executable local path.
  replaceRoute(nextRoute, staleRouteIds);
  try {
    db.transaction(() => {
      if (existing && row) {
        db.prepare(
          "UPDATE installed_agents SET name = ?, name_en = ?, tagline = ?, tagline_en = ?, system_prompt = ?, env_requirements_json = ?, visibility = 'visible', entity_kind = ? WHERE id = ?",
        ).run(name, name, tagline, tagline, systemPrompt, envReqsJson, kind, id);
      } else {
        db.prepare(
          `INSERT INTO installed_agents
           (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
            env_requirements_json, preferred_backend, trust_grade, installed_at, tone, visibility, entity_kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'visible', ?)`,
        ).run(id, slug, name, name, tagline, tagline, systemPrompt, "[]", envReqsJson, null, "A", now, tone, kind);
      }

      // 팀이면 대표 agent + firm + resolved org가 하나의 SQLite commit이다. 어느 한
      // 단계라도 실패하면 "조직도에 추가됨" 성공 영수증을 만들지 않는다.
      if (kind === "team") {
        const registeredFirm = registerTeamAsFirm(dir, id, slug, name, tagline, undefined, scan.members);
        if (!registeredFirm) throw new Error(ko ? "팀 조직도를 등록하지 못했습니다." : "Could not register the team org chart.");
        firmId = registeredFirm.id;
        const divisions: ResolvedOrg["divisions"] = scan.members.map((m) => ({
          id: m.id,
          name: m.name,
          role: m.role,
          prompt: m.promptFileRef ? readFirst(dir, [m.promptFileRef], 8000) || undefined : undefined,
          promptFileRef: m.promptFileRef,
          specialists: [],
        }));
        if (divisions.length > 0) {
          const org: ResolvedOrg = {
            source: "resolver",
            ceo: { id, name, role: "CEO", agentId: id, prompt: systemPrompt },
            divisions,
            sourcePath: dir,
            resolvedAt: now,
          };
          saveResolvedOrg(registeredFirm.id, org);
        } else {
          // A previous richer resolve must not outlive the latest on-disk team
          // structure. Fall back to the newly committed firm orgChart.
          clearResolvedOrg(registeredFirm.id);
        }
      } else {
        // The same user-owned folder may legitimately evolve from team to
        // single. Remove only its organization projection; the agent and chats
        // stay owned, and firm-linked chats detach through ON DELETE SET NULL.
        const staleFirm = getFirmBySlug(`firm-${slug}`);
        if (staleFirm) {
          clearResolvedOrg(staleFirm.id);
          db.prepare("DELETE FROM firms WHERE id = ?").run(staleFirm.id);
        }
      }
    })();
  } catch (error) {
    try {
      if (existing) replaceRoute(existing, [id]);
      else removeRoute(id);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Local agent registration and route rollback both failed");
    }
    throw error;
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
    trustGrade: "A",
    installedAt: now,
    tone,
    runtimeLabel: runtime,
    localPath: dir,
    kind,
    visibility: "visible",
  };
  return { agent, runtime, labels, kind, path: dir, ...(firmId ? { firmId } : {}) };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}
