// 로컬 폴더 결정적(deterministic) 스캐너 — 임포트 시 "구성원 없음"이 절대 안 나오게 하는
// 관대한 감지 사다리. LLM 리졸버(org-resolver)와 별개로, 순수 함수라 단위 테스트 가능하다.
// 감지 순서:
//   1) manifest.json / agentlas.json 의 roster/agents 배열 (패키지형)
//   2) 멤버 컨테이너 디렉토리(agents/, team/, .claude/agents/ …)의 하위 폴더 또는 *.md 파일
//   3) 에이전트 정의 파일을 가진 하위 폴더들 (≥1)
//   4) 더 깊이 중첩된 에이전트 정의 폴더 (재귀, 얕은 스캔이 비었을 때)
//   5) 루트 단일 정의 파일(AGENT.md/AGENTS.md/CLAUDE.md …) → 싱글 에이전트
//   6) 최후 폴백: 최상위 아무 .md → 싱글 에이전트 (구성원 0으로 팀 등록되는 일이 없도록)
// 싱글/멀티 판정: 구성원 2+ 또는 오케스트레이터/CEO 마커 존재 = team, 아니면 agent.
import fs from "node:fs";
import path from "node:path";

export interface ScanMember {
  /** 폴더/파일 기반 안정 id (slug) */
  id: string;
  /** 표시 이름 (md 헤딩 > frontmatter name > 폴더/파일명 프리티) */
  name: string;
  /** 역할 라벨 ("00-orchestrator" → "Orchestrator") */
  role: string;
  /** 이 멤버를 정의하는 파일의 루트 기준 상대경로 (없을 수 있음) */
  promptFileRef?: string;
}

export type ScanSource =
  | "manifest-roster"
  | "container-dirs"
  | "container-files"
  | "member-subdirs"
  | "nested-members"
  | "single-def"
  | "loose-markdown";

export interface FolderScan {
  kind: "agent" | "team";
  /** manifest.json/agentlas.json 이 이름을 선언하면 그 이름 (팀 이름 최우선 소스) */
  manifestName: string | null;
  /** 팀 구성원 (오케스트레이터 포함, CEO 폴더 제외) */
  members: ScanMember[];
  /** 싱글일 때 시스템 프롬프트로 쓸 엔트리 파일 (루트 기준 상대경로) */
  entryFile: string | null;
  /** 어떤 감지 단계가 성공했는가 (디버깅/테스트용) */
  source: ScanSource;
}

// import-local.ts 와 정합 유지 — 에이전트 1명을 정의하는 흔한 파일들.
const AGENT_DEF_FILES = [
  "AGENT.md",
  "agent.md",
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
const SKIP_SCAN_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "release", "vendor",
  ".cache", "coverage", ".turbo", ".venv", "venv", "__pycache__", ".idea", ".vscode",
]);
// 멤버가 아닌 흔한 보조 폴더 (팀 루트 직속에 있어도 구성원으로 세지 않는다)
const NON_MEMBER_DIRS = new Set([
  "ceo", "projects", "docs", "doc", "examples", "example", "scripts", "skills",
  "contracts", "assets", "data", "output", "outputs", "templates", "knowledge",
  "commands", "workflows", "hooks",
]);
const ORCHESTRATOR_RE = /orchestrator|^ceo$|team[-_ ]?lead|coordinator/i;

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
function readText(p: string, max = 4000): string {
  try {
    return fs.readFileSync(p, "utf8").slice(0, max);
  } catch {
    return "";
  }
}
function listEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function hasAgentDef(d: string): boolean {
  return AGENT_DEF_FILES.some((f) => exists(path.join(d, f)));
}
function firstAgentDef(d: string): string | null {
  for (const f of AGENT_DEF_FILES) if (exists(path.join(d, f)) && !isDir(path.join(d, f))) return f;
  return null;
}

/** "60-design-worker" → "Design Worker" (숫자 프리픽스 제거 + 프리티) */
export function prettyLabel(raw: string): string {
  return raw
    .replace(/\.(md|markdown|mdx)$/i, "")
    .replace(/^\d+[-_.]?/, "")
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .trim();
}

function slugify(s: string): string {
  return (
    s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "member"
  );
}

/** md 파일에서 표시 이름 추출 — frontmatter name: > 첫 # 헤딩 > null */
function nameFromMarkdown(absFile: string): string | null {
  const text = readText(absFile, 2000);
  if (!text) return null;
  const fm = text.match(/^---\n[\s\S]*?\bname:\s*["']?([^\n"']+)["']?\s*$/m);
  if (fm && text.startsWith("---")) return fm[1].trim().slice(0, 60) || null;
  const h = text.match(/^#\s+(.+)$/m);
  if (h) {
    const clean = h[1].replace(/^[\s#>►▶▷▸▹•·\-–—*]+/, "").replace(/\(.*?\)/g, "").trim();
    if (clean && !/어댑터|adapter|\.md\b|read\s*me/i.test(clean)) return clean.slice(0, 60);
  }
  return null;
}

function memberFromDir(root: string, absDir: string): ScanMember {
  const base = path.basename(absDir);
  const def = firstAgentDef(absDir);
  const label = prettyLabel(base) || base;
  const display = def ? nameFromMarkdown(path.join(absDir, def)) : null;
  return {
    id: slugify(base),
    name: display || label,
    role: label,
    promptFileRef: def ? path.relative(root, path.join(absDir, def)) : undefined,
  };
}

function memberFromFile(root: string, absFile: string): ScanMember {
  const base = path.basename(absFile);
  const label = prettyLabel(base) || base;
  return {
    id: slugify(base.replace(/\.(md|markdown|mdx)$/i, "")),
    name: nameFromMarkdown(absFile) || label,
    role: label,
    promptFileRef: path.relative(root, absFile),
  };
}

function dedupe(members: ScanMember[]): ScanMember[] {
  const seen = new Set<string>();
  const out: ScanMember[] = [];
  for (const m of members) {
    let id = m.id;
    let i = 2;
    while (seen.has(id)) id = `${m.id}-${i++}`;
    seen.add(id);
    out.push(id === m.id ? m : { ...m, id });
  }
  return out;
}

/** manifest.json / agentlas.json 파싱 — { name, rosterPaths } */
function readManifest(root: string): { name: string | null; roster: string[] } {
  let name: string | null = null;
  const roster: string[] = [];
  for (const file of ["manifest.json", "agentlas.json", "team.json", "crew.json"]) {
    const p = path.join(root, file);
    if (!exists(p) || isDir(p)) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!name) {
      for (const k of ["name", "displayName", "package", "title"]) {
        const v = data[k];
        if (typeof v === "string" && v.trim()) {
          name = prettyLabel(v.trim()) || v.trim();
          break;
        }
      }
    }
    // roster: 문자열 경로 배열 또는 {path|file|name} 객체 배열 모두 수용
    for (const k of ["roster", "agents", "members", "team"]) {
      const v = data[k];
      if (!Array.isArray(v)) continue;
      for (const item of v) {
        if (typeof item === "string") roster.push(item);
        else if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          const ref = [o.path, o.file, o.agent, o.promptFileRef].find((x) => typeof x === "string");
          if (typeof ref === "string") roster.push(ref);
          else if (typeof o.name === "string") roster.push(o.name);
        }
      }
      if (roster.length > 0) break;
    }
    if (roster.length > 0) break;
  }
  return { name, roster };
}

/** roster 항목(상대경로 또는 이름)을 ScanMember로 변환. 존재하지 않는 경로는 이름으로만 취급. */
function membersFromRoster(root: string, roster: string[]): ScanMember[] {
  const members: ScanMember[] = [];
  for (const entry of roster.slice(0, 64)) {
    const safe = path.normalize(entry).replace(/^(\.\.(\/|\\|$))+/, "");
    const abs = path.join(root, safe);
    if (abs.startsWith(root) && exists(abs) && !isDir(abs)) {
      // 파일 경로 — 부모 폴더명이 정체성(agents/00-x/agent.md)이면 폴더명 기준
      const parent = path.dirname(abs);
      if (AGENT_DEF_FILES.includes(path.basename(abs)) && path.resolve(parent) !== path.resolve(root)) {
        members.push({ ...memberFromDir(root, parent), promptFileRef: path.relative(root, abs) });
      } else {
        members.push(memberFromFile(root, abs));
      }
    } else if (abs.startsWith(root) && isDir(abs)) {
      members.push(memberFromDir(root, abs));
    } else {
      const label = prettyLabel(entry) || entry;
      members.push({ id: slugify(entry), name: label, role: label });
    }
  }
  return dedupe(members);
}

/** 컨테이너 디렉토리(agents/ 등)에서 멤버 수집 — 하위 폴더 우선, 없으면 *.md 파일. */
function membersFromContainers(root: string): { members: ScanMember[]; source: ScanSource } | null {
  for (const base of [root, path.join(root, ".claude"), path.join(root, ".agents")]) {
    for (const c of ["", ...TEAM_CONTAINER_DIRS]) {
      const container = c ? path.join(base, c) : base;
      // base 자체는 컨테이너로 안 봄 (c==="" 은 .claude/.agents 전용: .claude/agents 케이스와 별개로
      // .agents/<member>/agent.md 같은 구조를 잡기 위함)
      if (!c && container === root) continue;
      if (!isDir(container)) continue;
      const entries = listEntries(container);
      const dirs = entries.filter(
        (e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_SCAN_DIRS.has(e.name.toLowerCase()),
      );
      const dirMembers = dirs
        .filter((e) => c !== "" || hasAgentDef(path.join(container, e.name)))
        .map((e) => memberFromDir(root, path.join(container, e.name)));
      if (dirMembers.length > 0) return { members: dedupe(dirMembers), source: "container-dirs" };
      // Claude Code 스타일: .claude/agents/*.md (폴더가 아니라 md 파일이 곧 멤버)
      const fileMembers = entries
        .filter((e) => e.isFile() && /\.(md|markdown|mdx)$/i.test(e.name) && !/^readme/i.test(e.name))
        .map((e) => memberFromFile(root, path.join(container, e.name)));
      if (c && fileMembers.length > 0) return { members: dedupe(fileMembers), source: "container-files" };
    }
  }
  return null;
}

/** 루트(및 .claude) 직속에서 에이전트 정의를 가진 하위 폴더들. */
function membersFromSubdirs(root: string): ScanMember[] {
  for (const base of [root, path.join(root, ".claude")]) {
    const members = listEntries(base)
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith(".") &&
          !SKIP_SCAN_DIRS.has(e.name.toLowerCase()) &&
          !NON_MEMBER_DIRS.has(e.name.toLowerCase()) &&
          hasAgentDef(path.join(base, e.name)),
      )
      .map((e) => memberFromDir(root, path.join(base, e.name)));
    if (members.length > 0) return dedupe(members);
  }
  return [];
}

/** 더 깊이 중첩된 에이전트 정의 폴더 (BFS, 루트 발견 시 그 안으로 안 내려감). */
function membersNested(root: string, maxDepth = 4): ScanMember[] {
  const members: ScanMember[] = [];
  let frontier: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (frontier.length > 0 && members.length < 48) {
    const next: Array<{ dir: string; depth: number }> = [];
    for (const { dir, depth } of frontier) {
      if (depth >= maxDepth) continue;
      for (const e of listEntries(dir)) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        if (SKIP_SCAN_DIRS.has(e.name.toLowerCase()) || NON_MEMBER_DIRS.has(e.name.toLowerCase())) continue;
        const child = path.join(dir, e.name);
        if (hasAgentDef(child) || isDir(path.join(child, ".agentlas"))) members.push(memberFromDir(root, child));
        else next.push({ dir: child, depth: depth + 1 });
      }
    }
    frontier = next;
  }
  return dedupe(members);
}

function hasOrchestratorMarker(root: string, members: ScanMember[]): boolean {
  if (members.some((m) => ORCHESTRATOR_RE.test(`${m.id} ${m.role}`))) return true;
  for (const base of [root, path.join(root, ".claude")]) {
    if (isDir(path.join(base, "ceo"))) return true;
    if (exists(path.join(base, "TEAM.md")) || exists(path.join(base, "orgspec.yaml"))) return true;
  }
  return false;
}

/** 루트 단일 정의 파일 → 싱글. 그것도 없으면 최상위 아무 .md → 싱글 (최후 폴백). */
function singleEntry(root: string): { entryFile: string; source: ScanSource } | null {
  const def = firstAgentDef(root) || firstAgentDef(path.join(root, ".claude"));
  if (def) {
    const base = firstAgentDef(root) ? root : path.join(root, ".claude");
    return { entryFile: path.relative(root, path.join(base, def)), source: "single-def" };
  }
  // 아무 규격도 없는 마크다운 뭉치: README보다 다른 md를 우선, 그마저 없으면 README
  const mds = listEntries(root)
    .filter((e) => e.isFile() && /\.(md|markdown|mdx)$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => (/^readme/i.test(a) ? 1 : 0) - (/^readme/i.test(b) ? 1 : 0) || a.localeCompare(b));
  if (mds.length > 0) return { entryFile: mds[0], source: "loose-markdown" };
  return null;
}

/**
 * 폴더를 결정적으로 스캔 — 순수 함수 (DB/네트워크/LLM 없음).
 * 어떤 구조든 members 또는 entryFile 중 하나는 채워 반환하려 시도한다.
 */
export function scanAgentFolder(root: string): FolderScan {
  const abs = path.resolve(root);
  const { name: manifestName, roster } = readManifest(abs);

  // 1) manifest roster
  if (roster.length > 0) {
    const members = membersFromRoster(abs, roster);
    if (members.length > 0) {
      return finalize(abs, manifestName, members, null, "manifest-roster");
    }
  }
  // 2) 컨테이너 디렉토리 (agents/, .claude/agents/*.md …)
  const contained = membersFromContainers(abs);
  if (contained) return finalize(abs, manifestName, contained.members, null, contained.source);
  // 3) 정의 파일 가진 하위 폴더들
  const sub = membersFromSubdirs(abs);
  if (sub.length > 0) return finalize(abs, manifestName, sub, null, "member-subdirs");
  // 4) 중첩 재귀
  const nested = membersNested(abs);
  if (nested.length >= 2) return finalize(abs, manifestName, nested, null, "nested-members");
  // 5~6) 싱글 (정의 파일 → 아무 md)
  const single = singleEntry(abs);
  if (single) {
    return { kind: "agent", manifestName, members: [], entryFile: single.entryFile, source: single.source };
  }
  if (nested.length === 1) return finalize(abs, manifestName, nested, null, "nested-members");
  // 완전 빈 폴더 — 호출부가 에러 처리
  return { kind: "agent", manifestName, members: [], entryFile: null, source: "loose-markdown" };
}

function finalize(
  root: string,
  manifestName: string | null,
  members: ScanMember[],
  entryFile: string | null,
  source: ScanSource,
): FolderScan {
  // 싱글/멀티 판정: 구성원 2+ 또는 오케스트레이터 마커 존재 = team
  const kind: "agent" | "team" =
    members.length >= 2 || (members.length >= 1 && hasOrchestratorMarker(root, members)) ? "team" : "agent";
  if (kind === "agent" && members.length === 1) {
    // 구성원 1명뿐인 "팀 아닌" 구조 → 그 멤버의 정의 파일을 엔트리로 하는 싱글
    return { kind, manifestName, members: [], entryFile: members[0].promptFileRef ?? entryFile, source };
  }
  return { kind, manifestName, members, entryFile, source };
}
