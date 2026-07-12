// Grok Imagine via the official xAI Grok CLI 0.2.x.
// This is a media-only, OAuth-subscription boundary: exact tool allowlists, minimal env,
// prompt-file input, isolated session harvesting, and deterministic cleanup.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { grokAuthSource } from "./availability";
import { detachedSpawnOpts, killCliTree, spawnCli, trackRunChild } from "../runtime/exec";

const GROK_BIN_CANDIDATES = [
  path.join(os.homedir(), ".grok/bin/grok"),
  path.join(os.homedir(), ".local/bin/grok"),
  "/opt/homebrew/bin/grok",
  "/usr/local/bin/grok",
  path.join(os.homedir(), ".bun/bin/grok"),
];

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VIDEO_EXTS = new Set([".mp4"]);
const DEFAULT_GROK_SESSIONS_DIR = path.join(os.homedir(), ".grok", "sessions");

function grokSessionsDir(): string {
  return process.env.AGENTLAS_GROK_SESSIONS_DIR || DEFAULT_GROK_SESSIONS_DIR;
}

export function resolveGrokBin(): string | null {
  const override = process.env.AGENTLAS_GROK_BIN?.trim();
  const fromPath = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, process.platform === "win32" ? "grok.exe" : "grok"));
  for (const candidate of [...(override ? [override] : []), ...GROK_BIN_CANDIDATES, ...fromPath]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function canonicalCwd(cwd: string): string {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function sessionRoot(cwd: string, sessionId: string): string {
  return path.join(grokSessionsDir(), encodeURIComponent(canonicalCwd(cwd)), sessionId);
}

function validMedia(file: string, kind: "image" | "video"): boolean {
  let head: Buffer;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 32) return false;
    const fd = fs.openSync(file, "r");
    try {
      head = Buffer.alloc(Math.min(32, stat.size));
      fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  if (kind === "video") return head.subarray(4, 8).toString("ascii") === "ftyp";
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const png = head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP";
  return jpeg || png || webp;
}

/** Harvest only the exact session requested by this invocation. */
function harvestBySession(cwd: string, sessionId: string, kind: "image" | "video"): string | null {
  const mediaDir = path.join(sessionRoot(cwd, sessionId), kind === "video" ? "videos" : "images");
  const exts = kind === "video" ? VIDEO_EXTS : IMAGE_EXTS;
  const found: Array<{ file: string; mtime: number }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(mediaDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !exts.has(path.extname(entry.name).toLowerCase())) continue;
    const file = path.join(mediaDir, entry.name);
    if (!validMedia(file, kind)) continue;
    try {
      found.push({ file, mtime: fs.statSync(file).mtimeMs });
    } catch {
      // ignore disappeared file
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.file ?? null;
}

function mediaChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SHELL",
    "LANG",
    "LC_ALL",
    "SystemRoot",
    "WINDIR",
    "APPDATA",
    "LOCALAPPDATA",
  ];
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
  // Deterministic test seam only; production never sets it.
  if (process.env.AGENTLAS_GROK_SESSIONS_DIR) env.AGENTLAS_GROK_SESSIONS_DIR = process.env.AGENTLAS_GROK_SESSIONS_DIR;
  return env;
}

export interface GrokImagineOptions {
  prompt: string;
  cwd: string;
  kind: "image" | "video";
  /** Main-owned output path. Supplying it lets the helper remove the private Grok session immediately. */
  targetPath?: string;
  /** Keep the generated image's real extension when copying into a caller-owned basename. */
  preserveExtension?: boolean;
  timeoutMs?: number;
  isCancelled?: () => boolean;
}

export async function runGrokImagine(opts: GrokImagineOptions): Promise<string | null> {
  const bin = resolveGrokBin();
  if (!bin) return null;
  // Never charge an API key while the UI says subscription/zero incremental cost.
  if ((await grokAuthSource()) !== "oauth") return null;

  try {
    fs.mkdirSync(opts.cwd, { recursive: true });
  } catch {
    return null;
  }

  const sessionId = randomUUID();
  const promptFile = path.join(os.tmpdir(), `agentlas-grok-imagine-${sessionId}.txt`);
  const timeoutMs = opts.timeoutMs ?? (opts.kind === "video" ? 15 * 60_000 : 5 * 60_000);
  try {
    const mediaInstruction =
      opts.kind === "image"
        ? "Agentlas media job: generate the requested IMAGE with image_gen. Do not run terminal commands or edit files."
        : "Agentlas media job: generate the requested VIDEO with text_to_video or image_to_video. Do not run terminal commands or edit files.";
    fs.writeFileSync(promptFile, `${mediaInstruction}\n\n${opts.prompt}`, { encoding: "utf8", mode: 0o600 });
  } catch {
    return null;
  }

  await new Promise<void>((resolve) => {
    let finished = false;
    let timeout: NodeJS.Timeout | null = null;
    let cancelPoll: NodeJS.Timeout | null = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      if (cancelPoll) clearInterval(cancelPoll);
      try {
        fs.rmSync(promptFile, { force: true });
      } catch {
        // ignore
      }
      resolve();
    };

    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(
        bin,
        [
          "--prompt-file",
          promptFile,
          "--cwd",
          opts.cwd,
          "--output-format",
          "json",
          // Grok CLI 0.2.93 cannot create a session when --tools removes
          // run_terminal_cmd: its internal background defaults become invalid.
          // Keep the tool registered but kernel-sandbox the process and deny
          // every shell/edit permission so only internal media tools can act.
          "--sandbox",
          "strict",
          "--disallowed-tools",
          "search_replace,web_search,web_fetch",
          "--deny",
          "Bash",
          "--deny",
          "Edit",
          "--deny",
          "Write",
          "--always-approve",
          "--disable-web-search",
          "--no-memory",
          "--no-subagents",
          "--max-turns",
          "4",
          "--session-id",
          sessionId,
        ],
        { cwd: opts.cwd, env: mediaChildEnv(), stdio: ["ignore", "ignore", "ignore"], ...detachedSpawnOpts() },
      );
      trackRunChild(child);
    } catch {
      finish();
      return;
    }

    timeout = setTimeout(() => killCliTree(child), timeoutMs);
    if (opts.isCancelled) {
      cancelPoll = setInterval(() => {
        if (opts.isCancelled?.()) killCliTree(child);
      }, 250);
    }
    child.once("close", finish);
    child.once("error", finish);
  });

  const root = sessionRoot(opts.cwd, sessionId);
  const harvested = harvestBySession(opts.cwd, sessionId, opts.kind);
  if (!harvested) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return null;
  }
  if (!opts.targetPath) return harvested;

  const targetPath = opts.preserveExtension
    ? `${opts.targetPath.slice(0, opts.targetPath.length - path.extname(opts.targetPath).length)}${path.extname(harvested)}`
    : opts.targetPath;
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(harvested, targetPath);
    return targetPath;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
