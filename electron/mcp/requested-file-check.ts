// Host check: a file the owner asked for, that the answer names, must exist before the answer stands as delivered.
//
// Windows 1.3.88 test (2026-10-23, Ollama qwen3:1.7b, One chat): "Write a file named hello.txt in the folder
// C:\Users\reach\Documents\WinTestProject …" was answered "The file "hello.txt" has been created in the specified folder"
// after a run with no tool call at all; the file did not exist and nothing on screen said so (shots 55-57). Whether the
// model called a tool, called one that failed, or only wrote the sentence, the fact that matters is checkable in code:
// does the file exist? So the host checks it, for every runtime, instead of asking the model to be careful.
//
// Only identifiers are read from text (path and file-name tokens with a known file extension); no sentence is
// interpreted. A name counts when the owner's own request names it AND the answer names it AND no successful tool call
// of this run mentions it AND no file by that name exists at any location the request, the answer or the run's folder
// points to. The result is a factual correction (which names, which paths were checked), true whatever the answer said.
//
// No electron import: Main and the daemon both finish runs.
import fs from "node:fs";
import path from "node:path";
import { registerDeclaredPromptModule } from "../runtime/prompt-order";

/** File extensions that make a token a file name. Bare TLD-like endings (.ai, .io, .app, .dev, .com) are left out on purpose. */
const FILE_EXTENSIONS = [
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "html", "htm", "css", "scss",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs",
  "php", "sh", "ps1", "bat", "sql", "log", "ini", "toml", "cfg", "conf", "ipynb", "tex", "bib", "rtf",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "hwp", "hwpx", "odt", "ods", "odp", "key", "pages", "numbers",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "tif", "tiff", "mp3", "wav", "m4a", "mp4", "mov", "webm", "zip",
] as const;
const EXT = FILE_EXTENSIONS.join("|");
const TRAILING = /[.,;:!?)\]}'"`’”»>]+$/u;
const WINDOWS_ABSOLUTE = /(?<![\p{L}\p{N}_])[A-Za-z]:[\\/][^\s"'`<>|*?]*/gu;
const POSIX_ABSOLUTE = /(?<![\p{L}\p{N}_:/.~\\-])(?:~\/|\/)[^\s"'`<>()[\]{}]*/gu;
const RELATIVE_WITH_DIR = new RegExp(`(?<![\\p{L}\\p{N}_./\\\\:~-])(?:\\.{1,2}[\\\\/])?(?:[\\p{L}\\p{N}_.-]+[\\\\/])+[\\p{L}\\p{N}_.-]*\\.(?:${EXT})(?![\\p{L}\\p{N}_])`, "giu");
const BARE_NAME = new RegExp(`(?<![\\p{L}\\p{N}_./\\\\:@-])[\\p{L}\\p{N}_][\\p{L}\\p{N}_.-]*\\.(?:${EXT})(?![\\p{L}\\p{N}_])`, "giu");
const HAS_EXTENSION = new RegExp(`\\.(?:${EXT})$`, "iu");

export interface MissingRequestedFile {
  /** The file name as the owner wrote it. */
  name: string;
  /** Every location checked, none of which holds a file by that name. */
  checked: string[];
}

export interface RequestedFileCheckInput {
  /** The owner's own request for this turn (never a host-written prompt). */
  userPrompt: string;
  /** The answer as it will be shown and saved. */
  answer: string;
  /** The run's working folder, when it has one. */
  cwd?: string | null;
  /** Names, arguments and results of the tool calls of this run that completed without error. */
  successfulToolText?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  /** Injected for tests; default: a regular file exists at the path. */
  isFile?: (candidate: string) => boolean;
}

interface Tokens { absolute: string[]; relative: string[]; names: string[] }

function tidy(token: string): string {
  return token.replace(TRAILING, "");
}

function tokens(text: string, platform: NodeJS.Platform, homeDir: string): Tokens {
  const absolute: string[] = [];
  const relative: string[] = [];
  const names: string[] = [];
  const source = text.slice(0, 200_000);
  if (platform === "win32") for (const match of source.matchAll(WINDOWS_ABSOLUTE)) absolute.push(tidy(match[0]));
  else {
    // A URL's path is not a file on this machine: the look-behind refuses a slash after ':' '/' or a letter.
    for (const match of source.matchAll(POSIX_ABSOLUTE)) {
      const token = tidy(match[0]);
      if (token.length > 1) absolute.push(token.startsWith("~/") ? path.posix.join(homeDir, token.slice(2)) : token);
    }
  }
  const withoutAbsolute = absolute.reduce((rest, token) => rest.split(token).join(" "), source.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, " "));
  for (const match of withoutAbsolute.matchAll(RELATIVE_WITH_DIR)) relative.push(tidy(match[0]).trim());
  for (const match of source.matchAll(BARE_NAME)) names.push(tidy(match[0]));
  for (const token of [...absolute, ...relative]) {
    const base = (platform === "win32" ? path.win32 : path.posix).basename(token.replace(/\\/g, platform === "win32" ? "\\" : "/"));
    if (HAS_EXTENSION.test(base)) names.push(base);
  }
  return { absolute, relative, names };
}

const key = (name: string) => name.normalize("NFC").toLowerCase();

/** Requested files the answer names that exist nowhere it points to, and that no successful tool call of the run touched. */
export function missingRequestedFiles(input: RequestedFileCheckInput): MissingRequestedFile[] {
  const platform = input.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  const homeDir = input.homeDir ?? (process.env.HOME || process.env.USERPROFILE || "/");
  const isFile = input.isFile ?? ((candidate: string) => { try { return fs.statSync(candidate).isFile(); } catch { return false; } });
  const asked = tokens(input.userPrompt ?? "", platform, homeDir);
  const answered = tokens(input.answer ?? "", platform, homeDir);
  if (!asked.names.length || !answered.names.length) return [];
  const answeredNames = new Set(answered.names.map(key));
  const toolText = key(input.successfulToolText ?? "");
  const cwd = input.cwd && p.isAbsolute(input.cwd) ? input.cwd : undefined;
  // Folders the request or the answer point at: absolute tokens without a file extension.
  const folders = [...asked.absolute, ...answered.absolute].filter((token) => !HAS_EXTENSION.test(p.basename(token)));
  const missing: MissingRequestedFile[] = [];
  const seen = new Set<string>();
  for (const name of asked.names) {
    const k = key(name);
    if (seen.has(k) || !answeredNames.has(k)) continue;
    seen.add(k);
    // A successful tool call that mentions the name acted on it (wrote, moved, deleted): the run did something real.
    if (toolText.includes(k)) continue;
    const candidates = new Set<string>();
    for (const token of [...asked.absolute, ...answered.absolute]) if (key(p.basename(token)) === k) candidates.add(p.normalize(token));
    for (const token of [...asked.relative, ...answered.relative]) if (cwd && key(p.basename(token)) === k) candidates.add(p.resolve(cwd, token));
    for (const folder of folders) candidates.add(p.join(folder, name));
    if (cwd) candidates.add(p.join(cwd, name));
    // Nowhere to look: say nothing rather than guess.
    if (!candidates.size) continue;
    const checked = [...candidates].slice(0, 6);
    if (checked.some((candidate) => isFile(candidate))) continue;
    missing.push({ name, checked });
  }
  return missing.slice(0, 5);
}

/** Host-written correction shown under the answer and saved with it, so the next turn does not build on the claim. */
export function requestedFileCorrection(missing: readonly MissingRequestedFile[], locale: "ko" | "en"): string {
  // Saved with the answer, so later turns read it in the conversation history: a declared host module like the
  // task-force artifact-proof note (borrowed-task-force.ts stripUnsupportedArtifactClaims).
  registerDeclaredPromptModule({ id: "one.answer.host.requested-file-check", revision: 1, stability: "turn-context", changeTriggers: ["model-output"], order: 0 });
  const lines = missing.map((file) => `- ${file.name}: ${file.checked.join(", ")}`);
  return locale === "ko"
    ? ["**호스트 확인:** 요청하신 파일이 실제로 없습니다. 이번 실행에서 이 파일을 쓴 도구 호출도 성공하지 않았습니다. 위 답에서 만들었다고 했더라도 사실이 아닙니다.", ...lines].join("\n")
    : ["**Host check:** the file you asked for does not exist, and no tool call in this run wrote it. If the answer above says it was created, that is not so.", ...lines].join("\n");
}
