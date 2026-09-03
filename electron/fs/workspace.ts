// 워킹 폴더 트리 IPC — 에이전트가 작업하는 로컬 디렉터리를 우측 패널 트리로 보여주기 위한 read-only fs.
//
// 안전 정책:
//   - 트리는 lazy expand. 한 번에 모든 자식만 (sub-tree 재귀는 클라이언트가 별 요청).
//   - 숨김 파일(.git, .DS_Store)은 기본 제외, 옵션으로 노출 가능.
//   - 파일 미리보기는 텍스트만, 사이즈 cap (256KB). 큰 텍스트는 앞부분만 보여준다.
//   - 모든 path는 절대경로로 받고, main이 해석한 scope의 realpath 내부만 허용한다.
//   - 쓰기/삭제는 노출하지 않는다 (이번 단계 read-only).
import type { BrowserWindow } from "electron";
import fs from "node:fs/promises";
import { existsSync, Stats } from "node:fs";
import path from "node:path";
import type { FsPathGrant, FsReadScope } from "../../shared/types";
import { grantPath, resolveFsReadPath, resolveMainOwnedReadPath } from "./access";

const TEXT_PREVIEW_MAX = 256 * 1024;
const TEXT_EXT = new Set([
  ".txt", ".md", ".mdx", ".json", ".yml", ".yaml", ".toml", ".csv", ".tsv",
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".swift", ".sh", ".bash", ".zsh", ".html", ".htm", ".css",
  ".scss", ".sass", ".less", ".xml", ".svg", ".url", ".webloc", ".vue", ".astro", ".sql", ".env",
  ".gitignore", ".npmrc", ".editorconfig", ".prettierrc", ".eslintrc",
  ".dockerfile", ".gradle", ".properties", ".ini", ".conf", ".log",
]);
const HIDDEN_PREFIX = ".";
const HIDDEN_ALLOW = new Set([".gitignore", ".env.example", ".npmrc", ".editorconfig"]);

export interface WorkspaceNode {
  name: string;
  /** 절대 경로 — 클라이언트가 다음 expand에 그대로 쓴다 */
  path: string;
  kind: "dir" | "file";
  /** 디렉터리는 size 0, file은 byte 수 */
  size: number;
  /** dir이면 자식 fetch 전이라도 'has children' 힌트 (UI에서 ▶ chevron 표시) */
  hasChildren?: boolean;
  /** 텍스트로 미리보기 가능한지 */
  isTextLike?: boolean;
}

export interface DirListing {
  /** 부모 절대경로 — 클라이언트가 보낸 path 그대로 echo */
  path: string;
  /** 부모가 존재하지 않거나 디렉터리가 아니면 null */
  exists: boolean;
  entries: WorkspaceNode[];
  /** A main-owned source disappeared; this is a recoverable inventory state, not an IPC error. */
  reason?: "source-missing";
}

export interface TextFilePreview {
  path: string;
  /** UTF-8로 디코드한 본문 (cap된 경우 truncated=true) */
  content: string;
  truncated: boolean;
  size: number;
  /** 텍스트가 아니라고 판정되면 content=''; reason 필드에 사유 */
  reason?: "binary" | "too-large" | "not-text-ext";
}

function isHiddenName(name: string): boolean {
  if (!name.startsWith(HIDDEN_PREFIX)) return false;
  return !HIDDEN_ALLOW.has(name);
}

function hasTextLikeName(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_EXT.has(path.extname(lower))) return true;
  // 확장자 없는 흔한 파일들 (README, LICENSE, Makefile)
  const base = path.basename(lower);
  if (base === "readme" || base === "license" || base === "makefile" || base === "dockerfile") {
    return true;
  }
  return false;
}

function isTextLike(name: string): boolean {
  return hasTextLikeName(name);
}

/** OS native picker — 사용자가 폴더를 직접 고른다. parent는 modal 부착용. */
export async function pickDirectory(parent: BrowserWindow | null): Promise<FsPathGrant | null> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { dialog } = require("electron") as typeof import("electron");
  const res = await dialog.showOpenDialog(parent ?? undefined!, {
    properties: ["openDirectory", "showHiddenFiles"],
    title: "Choose a working folder",
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return grantPath(res.filePaths[0], { durable: true });
}

async function listDirectoryResolved(resolved: string, showHidden = false): Promise<DirListing> {
  if (!existsSync(resolved)) {
    return { path: resolved, exists: false, entries: [] };
  }
  let parentStat: Stats;
  try {
    parentStat = await fs.stat(resolved);
  } catch {
    return { path: resolved, exists: false, entries: [] };
  }
  if (!parentStat.isDirectory()) {
    return { path: resolved, exists: false, entries: [] };
  }

  let raw: string[];
  try {
    raw = await fs.readdir(resolved);
  } catch {
    return { path: resolved, exists: true, entries: [] };
  }
  const entries: WorkspaceNode[] = [];
  for (const name of raw) {
    if (!showHidden && isHiddenName(name)) continue;
    const full = path.join(resolved, name);
    let stat: Stats;
    try {
      stat = await fs.lstat(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      entries.push({
        name,
        path: full,
        kind: "dir",
        size: 0,
        hasChildren: true, // lazy — 실제 children 비어도 chevron만 표시되고 펼치면 빈 트리
      });
    } else if (stat.isFile()) {
      entries.push({
        name,
        path: full,
        kind: "file",
        size: stat.size,
        isTextLike: isTextLike(name),
      });
    }
    // 심볼릭 링크 등은 무시 (escape 방지)
  }
  // 디렉터리 먼저, 그 다음 파일. 알파벳 순.
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { path: resolved, exists: true, entries };
}

export async function listDirectory(absPath: string, scope: FsReadScope, showHidden = false): Promise<DirListing> {
  return listDirectoryResolved(resolveFsReadPath(absPath, scope), showHidden);
}

export async function listDirectoryFromMainRoot(absPath: string, mainRoot: string, showHidden = false): Promise<DirListing> {
  return listDirectoryResolved(resolveMainOwnedReadPath(absPath, mainRoot), showHidden);
}

async function readTextFilePreviewResolved(resolved: string): Promise<TextFilePreview> {
  let stat: Stats;
  try {
    stat = await fs.lstat(resolved);
  } catch {
    return { path: resolved, content: "", truncated: false, size: 0, reason: "binary" };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { path: resolved, content: "", truncated: false, size: 0, reason: "binary" };
  }
  if (!isTextLike(path.basename(resolved))) {
    return { path: resolved, content: "", truncated: false, size: stat.size, reason: "not-text-ext" };
  }
  const handle = await fs.open(resolved, "r");
  let buf: Buffer;
  try {
    const readSize = Math.min(stat.size, TEXT_PREVIEW_MAX);
    buf = Buffer.alloc(readSize);
    await handle.read(buf, 0, readSize, 0);
  } finally {
    await handle.close();
  }
  const truncated = buf.byteLength > TEXT_PREVIEW_MAX;
  const slice = buf.byteLength > TEXT_PREVIEW_MAX ? buf.subarray(0, TEXT_PREVIEW_MAX) : buf;
  // UTF-8로 디코드 — 바이너리면 깨진 문자가 들어가지만 clients가 reason으로 판단 안 하므로 우리가 한 번 더 검사.
  const text = slice.toString("utf8");
  // NULL byte가 보이면 바이너리로 간주 (가벼운 heuristic)
  if (text.indexOf("\u0000") >= 0) {
    return { path: resolved, content: "", truncated: false, size: stat.size, reason: "binary" };
  }
  return { path: resolved, content: text, truncated: truncated || stat.size > TEXT_PREVIEW_MAX, size: stat.size };
}

export async function readTextFilePreview(absPath: string, scope: FsReadScope): Promise<TextFilePreview> {
  return readTextFilePreviewResolved(resolveFsReadPath(absPath, scope));
}

export async function readTextFilePreviewFromMainRoot(absPath: string, mainRoot: string): Promise<TextFilePreview> {
  return readTextFilePreviewResolved(resolveMainOwnedReadPath(absPath, mainRoot));
}
