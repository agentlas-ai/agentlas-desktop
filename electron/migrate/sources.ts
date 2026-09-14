// 마이그레이션 소스 스캐너 — OpenClaw / Hermes 설정 디렉토리를 읽어
// 정규화된 ParsedSource로 만든다. 디스크 읽기는 전부 여기 모인다.
//
// 시크릿 주의: envVars에는 실제 값이 들어간다. ParsedSource는 main 프로세스
// 안에서만 돈다. renderer로 나가는 preview에는 키 "이름"만 담긴다 (index.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  MigrationSourceKind,
  RuntimeBackend,
} from "../../shared/types";
import { currentUiLocale } from "../ui-locale";

const uiText = (ko: string, en: string): string => (currentUiLocale() === "ko" ? ko : en);

/** 소스에서 추출한 예약 작업 1개 (Agentlas Automation 초안) */
export interface ParsedCronJob {
  name: string;
  scheduleHuman: string;
  promptTemplate: string;
}

/** main 내부 표현 — envVars에 실제 시크릿 값 포함. renderer로 절대 안 나감. */
export interface ParsedSource {
  kind: MigrationSourceKind;
  label: string;
  rootPath: string;
  available: boolean;
  /** 합쳐진 시스템 프롬프트 (SOUL/AGENTS/USER 등). 없으면 "" */
  persona: string;
  /** 표시용 이름 */
  personaName: string;
  /** 한 줄 설명 */
  tagline: string;
  /** env 이름→값. 값은 main에만 머묾 */
  envVars: Record<string, string>;
  cronJobs: ParsedCronJob[];
  /** 메모리/워크스페이스 파일 절대 경로 */
  memoryFiles: string[];
}

interface SourceSpec {
  kind: MigrationSourceKind;
  label: string;
  /** 후보 루트 경로들 — 처음 존재하는 것을 사용 */
  roots: string[];
  /** persona 파일 후보 (루트 기준 상대경로). 존재하는 것만, 이 순서로 합침 */
  personaFiles: string[];
  /** persona 파일을 찾을 추가 디렉토리 (루트 기준). 안의 *.md를 모음 */
  personaDirs: string[];
  /** .env 후보 경로 */
  envFiles: string[];
  /** cron jobs.json 후보 경로 */
  cronFiles: string[];
  /** 메모리 디렉토리 후보 */
  memoryDirs: string[];
  defaultName: string;
  defaultTagline: string;
}

const HOME = os.homedir();
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? path.join(HOME, "AppData", "Local");

const SPECS: SourceSpec[] = [
  {
    kind: "openclaw",
    label: "OpenClaw",
    roots: [path.join(HOME, ".openclaw")],
    // OpenClaw는 워크스페이스 안에 페르소나 마크다운을 둔다.
    personaFiles: [
      "workspace/SOUL.md",
      "workspace/IDENTITY.md",
      "workspace/USER.md",
      "workspace/AGENTS.md",
      "workspace/TOOLS.md",
    ],
    personaDirs: [],
    envFiles: [".env"],
    cronFiles: ["cron/jobs.json"],
    memoryDirs: ["workspace/memory"],
    get defaultName() { return uiText("OpenClaw에서 가져온 에이전트", "Agent imported from OpenClaw"); },
    get defaultTagline() { return uiText("OpenClaw SOUL을 옮겨온 개인 어시스턴트", "Personal assistant carried over from OpenClaw SOUL"); },
  },
  {
    kind: "hermes",
    label: "Hermes",
    // Hermes: ~/.hermes (Linux/macOS), %LOCALAPPDATA%\hermes (Windows)
    roots: [path.join(HOME, ".hermes"), path.join(LOCALAPPDATA, "hermes")],
    personaFiles: ["SOUL.md", "AGENTS.md", "USER.md", "IDENTITY.md"],
    personaDirs: ["workspace"],
    envFiles: [".env"],
    cronFiles: ["cron/jobs.json", "automations/jobs.json"],
    memoryDirs: ["memories", "workspace/memory"],
    get defaultName() { return uiText("Hermes에서 가져온 에이전트", "Agent imported from Hermes"); },
    get defaultTagline() { return uiText("Hermes SOUL을 옮겨온 개인 어시스턴트", "Personal assistant carried over from Hermes SOUL"); },
  },
];

function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  return null;
}

function readTextSafe(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** .env 파싱 — KEY=VALUE, 따옴표/주석/export 처리. 시크릿 값 포함. */
function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7) : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

const PERSONA_CAP = 96 * 1024; // 96KB — 시스템 프롬프트 폭주 방지

function buildPersona(spec: SourceSpec, root: string): { persona: string; name: string } {
  const parts: string[] = [];
  let derivedName = "";

  for (const rel of spec.personaFiles) {
    const text = readTextSafe(path.join(root, rel));
    if (!text || !text.trim()) continue;
    const label = path.basename(rel, ".md");
    parts.push(`## ${label}\n\n${text.trim()}`);
    if (!derivedName) derivedName = firstHeading(text);
  }

  for (const dir of spec.personaDirs) {
    const abs = path.join(root, dir);
    let entries: string[] = [];
    try {
      entries = fs.existsSync(abs)
        ? fs.readdirSync(abs).filter((f) => f.toLowerCase().endsWith(".md"))
        : [];
    } catch {
      entries = [];
    }
    for (const f of entries.sort()) {
      const text = readTextSafe(path.join(abs, f));
      if (!text || !text.trim()) continue;
      parts.push(`## ${path.basename(f, ".md")}\n\n${text.trim()}`);
      if (!derivedName) derivedName = firstHeading(text);
    }
  }

  let persona = parts.join("\n\n---\n\n");
  if (persona.length > PERSONA_CAP) {
    persona = persona.slice(0, PERSONA_CAP) + "\n\n…(truncated on import)";
  }
  return { persona, name: derivedName };
}

function firstHeading(md: string): string {
  for (const line of md.split(/\r?\n/)) {
    const m = /^#{1,3}\s+(.+)$/.exec(line.trim());
    if (m) {
      // "SOUL.md - Who You Are" → "Who You Are" 류 정리
      return m[1].replace(/\.md\b/i, "").replace(/^[A-Z]+\s*[-–]\s*/, "").trim();
    }
  }
  return "";
}

function parseCronJobs(content: string): ParsedCronJob[] {
  try {
    const data = JSON.parse(content) as {
      jobs?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(data.jobs)) return [];
    return data.jobs.map((j, i) => ({
      name: String(j.name ?? j.id ?? `job-${i + 1}`),
      scheduleHuman: String(j.schedule ?? j.cron ?? j.when ?? ""),
      promptTemplate: String(j.prompt ?? j.message ?? j.command ?? ""),
    }));
  } catch {
    return [];
  }
}

function listMemoryFiles(spec: SourceSpec, root: string): string[] {
  const files: string[] = [];
  for (const dir of spec.memoryDirs) {
    const abs = path.join(root, dir);
    try {
      if (!fs.existsSync(abs)) continue;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (e.isFile()) files.push(path.join(abs, e.name));
      }
    } catch {
      // ignore
    }
  }
  return files;
}

/** env 키 이름을 BYOK 백엔드로 매핑. 인식 못하면 null (글로벌 env vault). */
export function backendForEnvKey(key: string): RuntimeBackend | null {
  const k = key.toUpperCase();
  if (/(ANTHROPIC|CLAUDE)/.test(k)) return "anthropic";
  if (/OPENAI/.test(k)) return "openai";
  if (/(GEMINI|GOOGLE|GENAI|VERTEX)/.test(k)) return "google";
  return null;
}

/** vault로 가져올 가치가 있는 시크릿성 키인지 (이름 기준). */
export function looksLikeSecretKey(key: string): boolean {
  return /(_API_KEY|_TOKEN|_SECRET|_KEY|_PASSWORD|APIKEY)$/i.test(key) ||
    backendForEnvKey(key) !== null;
}

/** 한 소스를 스캔. 없으면 available:false인 빈 ParsedSource. */
export function parseSource(kind: MigrationSourceKind): ParsedSource {
  const spec = SPECS.find((s) => s.kind === kind)!;
  const root = firstExisting(spec.roots);

  if (!root) {
    return {
      kind: spec.kind,
      label: spec.label,
      rootPath: spec.roots[0],
      available: false,
      persona: "",
      personaName: spec.defaultName,
      tagline: spec.defaultTagline,
      envVars: {},
      cronJobs: [],
      memoryFiles: [],
    };
  }

  const { persona, name } = buildPersona(spec, root);

  const envFile = firstExisting(spec.envFiles.map((f) => path.join(root, f)));
  const envVars = envFile ? parseEnvFile(readTextSafe(envFile) ?? "") : {};

  const cronFile = firstExisting(spec.cronFiles.map((f) => path.join(root, f)));
  const cronJobs = cronFile ? parseCronJobs(readTextSafe(cronFile) ?? "") : [];

  const memoryFiles = listMemoryFiles(spec, root);

  return {
    kind: spec.kind,
    label: spec.label,
    rootPath: root,
    available: true,
    persona,
    personaName: name || spec.defaultName,
    tagline: spec.defaultTagline,
    envVars,
    cronJobs,
    memoryFiles,
  };
}

export function parseAllSources(): ParsedSource[] {
  return SPECS.map((s) => parseSource(s.kind));
}
