/**
 * 설치된 엔진의 텍스트 파일을 사람이 직접 고칠 수 있게 한다 — 스킬, 호스트 훅, 어댑터
 * 매니페스트 같은 것들.
 *
 * 지금까지 이 파일들은 화면에서 읽을 수만 있거나(스킬), 아예 표면이 없었다(훅). 고치려면
 * 앱 밖에서 경로를 찾아야 했고, 그 경로가 어디인지도 제품이 말해 주지 않았다.
 *
 * ★이 폴더는 설치기와 업데이터가 함께 쓴다. 즉 여기 손으로 넣은 편집은 다음 엔진
 * 업데이트에서 사라진다. 그것을 막을 방법은 이 층에 없으므로, 감추지 않고 호출자에게
 * 사실로 돌려준다(`overwrittenByUpdate`). 사라질 수 있다는 걸 알고 고치는 것과 모르고
 * 잃는 것은 다르다.
 *
 * 경계는 좁게 잡는다:
 *  - 엔진 루트 **안**으로만. 심볼릭 링크는 따라가지 않는다.
 *  - 텍스트로 읽히는 확장자만. 바이너리와 실행 파일은 목록에 넣지 않는다.
 *  - 파일 하나 512 KiB, 목록 2000개 상한.
 */
import fs from "node:fs";
import path from "node:path";
import { hephaestusRoot } from "./root";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_ENTRIES = 2000;

/** 사람이 고칠 만한 텍스트 자산만. 확장자 화이트리스트가 바이너리를 막는 첫 관문이다. */
const EDITABLE_EXTENSIONS = new Set([
  ".md", ".markdown", ".json", ".yaml", ".yml", ".toml", ".txt", ".sh", ".py", ".mjs", ".cjs", ".js", ".ts",
]);

/**
 * 실행 경로와 캐시는 제외한다. bin 아래 실행 파일을 편집기로 열어 봐야 도움이 안 되고,
 * 캐시는 언제 지워질지 모르는 자리라 편집할 대상이 아니다.
 */
const EXCLUDED_TOP_LEVEL = new Set(["bin", "node_modules", ".git", "models", "cache", ".cache", "venv", ".venv"]);

export interface RuntimeFileEntry {
  /** 엔진 루트 기준 상대 경로 — 화면에도 이 값을 그대로 보여준다. */
  relPath: string;
  size: number;
  group: string;
}

export interface RuntimeFileListing {
  root: string | null;
  /** 이 폴더는 엔진 업데이트가 다시 쓴다 — 편집은 그때 사라질 수 있다. */
  overwrittenByUpdate: true;
  entries: RuntimeFileEntry[];
}

/** 상대 경로를 엔진 루트 안의 실제 파일로 푼다. 벗어나거나 링크면 던진다. */
function resolveRuntimeFile(relPath: string): { root: string; file: string } {
  const root = hephaestusRoot();
  if (!root) throw new Error("Agentlas engine is not installed here.");
  if (typeof relPath !== "string" || !relPath.trim()) throw new Error("A file path is required.");
  if (path.isAbsolute(relPath) || relPath.includes("\0")) throw new Error("Invalid engine file path.");

  const file = path.resolve(root, relPath);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Engine file path escapes the engine root.");
  }
  const top = relative.split(path.sep)[0];
  if (EXCLUDED_TOP_LEVEL.has(top)) throw new Error("That part of the engine is not editable.");
  if (!EDITABLE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    throw new Error("Only text assets of the engine can be edited.");
  }
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error("Engine file is a symbolic link.");
  if (!stat.isFile()) throw new Error("Engine path is not a regular file.");
  return { root, file };
}

/** 무엇으로 묶어 보여줄지 — 첫 두 경로 조각이면 사람이 찾기에 충분하다. */
function groupOf(relative: string): string {
  const parts = relative.split(path.sep);
  return parts.length <= 1 ? "." : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

export function listRuntimeFiles(): RuntimeFileListing {
  const root = hephaestusRoot();
  if (!root) return { root: null, overwrittenByUpdate: true, entries: [] };
  const entries: RuntimeFileEntry[] = [];

  const walk = (dir: string): void => {
    if (entries.length >= MAX_ENTRIES) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 읽을 수 없는 하위 폴더 하나가 목록 전체를 죽이지 않는다.
    }
    for (const dirent of dirents) {
      if (entries.length >= MAX_ENTRIES) return;
      const abs = path.join(dir, dirent.name);
      const relative = path.relative(root, abs);
      const top = relative.split(path.sep)[0];
      if (EXCLUDED_TOP_LEVEL.has(top)) continue;
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) { walk(abs); continue; }
      if (!dirent.isFile()) continue;
      if (!EDITABLE_EXTENSIONS.has(path.extname(dirent.name).toLowerCase())) continue;
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { continue; }
      if (size > MAX_FILE_BYTES) continue;
      entries.push({ relPath: relative, size, group: groupOf(relative) });
    }
  };
  walk(root);

  entries.sort((a, b) => a.relPath.localeCompare(b.relPath, "en"));
  return { root, overwrittenByUpdate: true, entries };
}

export function readRuntimeFile(relPath: string): { relPath: string; content: string; size: number } {
  const { file } = resolveRuntimeFile(relPath);
  const stat = fs.statSync(file);
  if (stat.size > MAX_FILE_BYTES) throw new Error("Engine file exceeds the 512 KiB editing limit.");
  const bytes = fs.readFileSync(file);
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error("Engine file is not valid UTF-8.");
  return { relPath, content, size: stat.size };
}

export function writeRuntimeFile(relPath: string, content: string): { ok: true; size: number } {
  const { file } = resolveRuntimeFile(relPath);
  if (typeof content !== "string") throw new Error("File content must be text.");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("Engine file exceeds the 512 KiB editing limit.");
  // 같은 폴더에 임시 파일을 쓰고 rename — 반쯤 쓰인 파일을 엔진이 읽는 일이 없게 한다.
  const tmp = `${file}.agentlas-edit-${process.pid}`;
  fs.writeFileSync(tmp, bytes, { mode: 0o644 });
  fs.renameSync(tmp, file);
  return { ok: true, size: bytes.byteLength };
}
