/*
 * The files one answer made or changed, for the line under it (Agentlas 2.0 AK; pictures desktop-impl-gaps-8 AK-1..AK-4).
 * Pure. The list comes from what the turn's own tool calls recorded (the typed edit cells of lib/one-turn-work.ts: a finished write or edit of one
 * path); nothing is read from the disk here and no model is asked.
 *
 * Where each value comes from:
 *   name, folder   <- the tool call's file path (relative paths are joined to the conversation's work folder)
 *   created        <- a finished `write` of the path (the tool that writes a whole file); edited <- only `edit`s of it
 *   kind icon      <- the file name's extension (closed list below)
 * Not recorded, so not drawn: a file written by a shell command or a script (no typed call names it), and whether a written path was new or
 * overwritten (a whole-file write is "created").
 */
import { buildOneWorkPresentation, type OneWorkCell, type OneWorkEditFile } from "./one-turn-work";
import type { OneActivityState } from "./one-activity";

export type TurnFileKind = "text" | "code" | "table" | "image" | "pdf" | "other";
export type TurnFileOp = "created" | "edited";
export interface TurnFile {
  /** Absolute when the call or the work folder made it so; otherwise as the call wrote it. */
  path: string;
  name: string;
  /** The folder the file sits in: relative to the work folder when inside it, else absolute; "" for a bare name. Ends with "/" when not empty. */
  dir: string;
  op: TurnFileOp;
  kind: TurnFileKind;
  /** True when `path` is absolute (the folder can be opened and the preview asked). */
  absolute: boolean;
}

const EXT: Record<TurnFileKind, readonly string[]> = {
  text: ["md", "markdown", "txt", "rtf", "doc", "docx", "odt", "pages", "tex", "rst"],
  code: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp", "cs", "php", "sh", "bash", "zsh", "sql", "css", "scss", "html", "htm", "json", "yaml", "yml", "toml", "xml", "ipynb", "vue", "svelte"],
  table: ["csv", "tsv", "xls", "xlsx", "ods", "numbers"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "avif", "tiff", "ico"],
  pdf: ["pdf"],
  other: [],
};
const KIND_OF_EXT = new Map<string, TurnFileKind>(Object.entries(EXT).flatMap(([kind, list]) => list.map((ext) => [ext, kind as TurnFileKind] as const)));

export function turnFileKind(name: string): TurnFileKind {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? KIND_OF_EXT.get(name.slice(dot + 1).toLowerCase()) ?? "other" : "other";
}

const isAbsolutePath = (value: string): boolean => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
const slashed = (value: string): string => value.replace(/\\/g, "/");

function splitPath(full: string): { dir: string; name: string } {
  const normalized = slashed(full).replace(/\/+$/, "");
  const cut = normalized.lastIndexOf("/");
  return cut < 0 ? { dir: "", name: normalized } : { dir: normalized.slice(0, cut + 1), name: normalized.slice(cut + 1) };
}

/** Joined and cleaned of `.` / `..` segments (a path a tool wrote relative to the work folder). */
function joinPath(base: string, rel: string): string {
  const parts: string[] = [];
  const drive = /^[A-Za-z]:/.exec(slashed(base))?.[0] ?? "";
  for (const part of `${slashed(base).slice(drive.length)}/${slashed(rel)}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `${drive}/${parts.join("/")}`;
}

/** The turn's files in the order they were first touched; one entry per path. Failed or cancelled calls and empty paths are left out. */
export function turnFilesOfCells(cells: readonly OneWorkCell[], workspacePath: string | null | undefined): TurnFile[] {
  const base = workspacePath && isAbsolutePath(workspacePath) ? slashed(workspacePath).replace(/\/+$/, "") : null;
  const found = new Map<string, { file: OneWorkEditFile; created: boolean }>();
  for (const cell of cells) {
    if (cell.kind !== "edit" || cell.status !== "completed") continue;
    for (const file of cell.files) {
      const raw = (file.path ?? "").trim();
      if (!raw) continue;
      const full = isAbsolutePath(raw) ? slashed(raw) : base ? joinPath(base, raw) : slashed(raw);
      const prior = found.get(full);
      found.set(full, { file: prior?.file ?? file, created: (prior?.created ?? false) || file.op === "write" });
    }
  }
  const out: TurnFile[] = [];
  for (const [full, entry] of found) {
    const { dir, name } = splitPath(full);
    if (!name) continue;
    const absolute = isAbsolutePath(full);
    const inside = base && absolute && (full === base || full.startsWith(`${base}/`));
    out.push({
      path: full, name, absolute,
      dir: inside ? slashed(dir).slice(base.length + 1) : dir,
      op: entry.created ? "created" : "edited",
      kind: turnFileKind(name),
    });
  }
  return out;
}

/** The files of one answer: its run(s) activity, read through the same typed projection the work block above the answer draws. */
export function turnFilesOfActivity(states: readonly OneActivityState[], locale: "ko" | "en", workspacePath: string | null | undefined): TurnFile[] {
  const cells: OneWorkCell[] = [];
  for (const state of states) cells.push(...buildOneWorkPresentation(state, locale, workspacePath ?? null).cells);
  return turnFilesOfCells(cells, workspacePath);
}

export const TURN_FILES_CHIP_LIMIT = 3;
export const TURN_FILES_LIST_ROWS = 8;
export const TURN_FILE_NAME_MAX_PX = 230;

export function turnFilesCounts(files: readonly Pick<TurnFile, "op">[]): { created: number; edited: number } {
  return { created: files.filter((f) => f.op === "created").length, edited: files.filter((f) => f.op === "edited").length };
}

type Lang = "ko" | "en";
export const turnFileWords = (lang: Lang) => lang === "ko"
  ? { created: "생성", edited: "수정", deleted: "삭제됨", more: (n: number) => `외 ${n}개`, head: (n: number) => `파일 ${n}개`, headCount: (c: number, e: number) => [c ? `생성 ${c}` : "", e ? `수정 ${e}` : ""].filter(Boolean).join(" · "), moreRows: (n: number) => `${n}개 더 보기`, preview: "미리보기", folder: "폴더 열기", copy: "경로 복사", collapse: "접기", expand: "펼치기" }
  : { created: "New", edited: "Edited", deleted: "Deleted", more: (n: number) => `${n} more`, head: (n: number) => `${n} files`, headCount: (c: number, e: number) => [c ? `${c} new` : "", e ? `${e} edited` : ""].filter(Boolean).join(" · "), moreRows: (n: number) => `${n} more`, preview: "Preview", folder: "Show in folder", copy: "Copy path", collapse: "Collapse", expand: "Expand" };
