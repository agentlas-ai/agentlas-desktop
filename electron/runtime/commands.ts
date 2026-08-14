// CLI 슬래시 명령 자동 스캔 — Claude Code / Codex가 쓰는 커스텀 커맨드를
// 파일시스템에서 읽어 챗 입력의 `/` 자동완성에 공급한다. 매 호출마다 재스캔하므로
// 사용자가 새 워크플로우 커맨드를 추가하거나 CLI가 업데이트되면 자동으로 최신화된다.
//
// 위치(커스텀 커맨드):
//   - Claude Code: ~/.claude/commands/**/*.md   (하위폴더는 name:sub 네임스페이스)
//   - Codex:       ~/.codex/prompts/**/*.md
//   - Antigravity: no local slash-command directory is assumed.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { RuntimeCommand } from "../../shared/types";

const MAX = 200;

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

/** 설치된 CLI들의 커스텀 슬래시 명령을 전부 스캔해 반환 (매번 최신). */
export function listRuntimeCommands(): RuntimeCommand[] {
  const home = os.homedir();
  const out: RuntimeCommand[] = [];
  scan(path.join(home, ".claude", "commands"), ".md", "claude-code", out);
  scan(path.join(home, ".codex", "prompts"), ".md", "codex", out);
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
