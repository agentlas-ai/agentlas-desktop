// CLI 슬래시 명령 자동 스캔 — 설치된 CLI들의 커스텀 커맨드를 파일시스템에서 읽어
// 챗 입력의 `/` 자동완성에 공급한다. 매 호출마다 재스캔하므로 사용자가 새 워크플로우
// 커맨드를 추가하거나 CLI가 업데이트되면 자동으로 최신화된다.
//
// ★어느 CLI가 어디에 명령을 두는지는 shared/runtime-capabilities.ts 의
// commandSurfaces 가 정본이다 — 예전처럼 여기 손 목록(claude·codex 둘만)을 두면
// cursor(~/.cursor/commands/*.md, 이 머신 실물 확인)와 antigravity 스킬
// (~/.gemini/config/skills/*/SKILL.md)이 조용히 빠진다.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { RuntimeCommand } from "../../shared/types";
import { RUNTIME_CAPABILITIES, COMMAND_SURFACE_RUNTIMES } from "../../shared/runtime-capabilities";

const MAX = 200;

/** RuntimeCommand.source 전 멤버 — satisfies 로 유니온과 동기화를 강제. */
const COMMAND_SOURCE_KINDS = ["claude-code", "codex", "antigravity", "cursor"] as const satisfies readonly RuntimeCommand["source"][];

function descFromMd(content: string): string {
  // frontmatter의 description
  const fm = content.match(/description:\s*(.+)$/m);
  if (fm) return fm[1].replace(/^["']|["']$/g, "").trim().slice(0, 120);
  // 첫 번째 의미 있는 줄 (헤더/프론트매터 제외)
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t === "---" || t.startsWith("#")) continue;
    return t.slice(0, 120);
  }
  return "";
}

function descFromToml(content: string): string {
  const m = content.match(/^\s*description\s*=\s*["'](.+?)["']/m);
  return m ? m[1].slice(0, 120) : "";
}

function walk(dir: string, ext: string, acc: string[]): void {
  if (acc.length >= MAX) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (acc.length >= MAX) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, ext, acc);
    else if (e.isFile() && e.name.toLowerCase().endsWith(ext)) acc.push(full);
  }
}

function scan(baseDir: string, ext: string, source: RuntimeCommand["source"], out: RuntimeCommand[]): void {
  if (!fs.existsSync(baseDir)) return;
  const files: string[] = [];
  walk(baseDir, ext, files);
  for (const file of files) {
    const rel = path.relative(baseDir, file).replace(new RegExp(`${ext.replace(".", "\\.")}$`, "i"), "");
    const name = "/" + rel.split(path.sep).join(":");
    let content = "";
    try {
      content = fs.readFileSync(file, "utf8").slice(0, 4000);
    } catch {
      // ignore unreadable
    }
    out.push({ name, description: ext === ".toml" ? descFromToml(content) : descFromMd(content), source });
  }
}

/** skill-dirs 레이아웃 — 하위 디렉터리 하나가 스킬 하나, 설명은 SKILL.md frontmatter. */
function scanSkillDirs(baseDir: string, source: RuntimeCommand["source"], out: RuntimeCommand[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX) break;
    if (!e.isDirectory()) continue;
    let content = "";
    try {
      content = fs.readFileSync(path.join(baseDir, e.name, "SKILL.md"), "utf8").slice(0, 4000);
    } catch {
      continue; // SKILL.md 없는 디렉터리는 스킬이 아니다.
    }
    out.push({ name: `/${e.name}`, description: descFromMd(content), source });
  }
}

/**
 * 설치된 CLI들의 커스텀 슬래시 명령을 전부 스캔해 반환 (매번 최신).
 * 어느 CLI를 어디서 스캔할지는 shared/runtime-capabilities.ts 가 결정한다.
 */
export function listRuntimeCommands(): RuntimeCommand[] {
  const home = os.homedir();
  const out: RuntimeCommand[] = [];
  for (const kind of COMMAND_SURFACE_RUNTIMES) {
    // RuntimeCommand.source 는 명령 표면이 실재하는 런타임들의 부분집합이다.
    // 서술자에 표면이 새로 생겼는데 source 유니온이 못 배우면, 조용히 빼는 대신 소리낸다.
    if (!(COMMAND_SOURCE_KINDS as readonly string[]).includes(kind)) {
      console.warn(`[commands] runtime "${kind}" declares command surfaces but RuntimeCommand.source has no member for it — update shared/types.ts`);
      continue;
    }
    const source = kind as RuntimeCommand["source"];
    for (const surface of RUNTIME_CAPABILITIES[kind].commandSurfaces) {
      const baseDir = path.join(home, ...surface.segments);
      if (surface.layout === "skill-dirs") scanSkillDirs(baseDir, source, out);
      else scan(baseDir, ".md", source, out);
    }
  }
  const seen = new Set<string>();
  return out
    .filter((c) => {
      const k = `${c.source}${c.name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX);
}
