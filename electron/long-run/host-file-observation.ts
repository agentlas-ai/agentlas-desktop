/**
 * The host looks at the filesystem itself — coordinator/owner direction 2026-09-25.
 *
 * File criteria used to be provable only by a receipt from the tool that wrote the file (Write/Edit/builtin/MCP
 * observers). A page written with shell redirection, an Edit where the sub-goal said "write", or codex apply_patch
 * without a matching receipt left the criterion unprovable while the file sat on disk — live: a two-strategy docs goal
 * and an automatic website goal never completed. Which tool wrote a file is not what the owner asked for; that the
 * file is there, with the right content, made by this goal, is.
 *
 * At verification the host reads the files the goal's own completion conditions name (sub-goal done_when, the
 * requested outcome), resolved only inside the goal's allowed roots — saved chat folder, then Project folder, then
 * agentRunCwd (the executor's order) — and records one host observation per file: existence, size, sha256, mtime and
 * whether it changed inside this goal's run window, plus a bounded text preview the judge can check content against.
 *
 * Safety:
 *  - Paths are resolved against the allowed roots only; `..`, absolute paths outside a root and symlinks whose real
 *    target leaves the root are refused. Nothing is written; directories are not listed.
 *  - Run-window binding: a file counts as this goal's write/edit only if its mtime is at or after the goal's run
 *    started (minus clock slack). A pre-existing file proves existence (read-kind criteria) but not creation.
 *  - Bounded: at most MAX_FILES names, MAX_HASH_BYTES hashed per file, PREVIEW_CHARS of text shown to the judge.
 * Observations are recorded as host ledger events and cited by ref; the verifier re-hashes a chosen ref before it
 * persists a pass, so a file changed after judging never becomes proof.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { getChat, getChatWorkingFolder } from "../store/chats";
import { getProject } from "../store/projects";
import { appendLongRunEvent } from "../store/long-runs";
import { agentRunCwd } from "../runtime/exec";

const MAX_FILES = 24;
const MAX_HASH_BYTES = 16 * 1024 * 1024;
const PREVIEW_CHARS = 2_000;
/** Clock slack between the ledger timestamp and filesystem mtimes. */
const WINDOW_SLACK_MS = 5_000;

export interface HostFileObservation {
  ref: string;
  relativePath: string;
  root: "chat" | "project" | "agent";
  exists: true;
  bytes: number;
  sha256: string;
  mtime: string;
  /** Modified at/after this goal's run started: counts as this goal's write/edit. */
  inRunWindow: boolean;
  /** Bounded UTF-8 preview for the judge's content check (null for binary or unreadable). */
  preview: string | null;
}

/** File-like names an AI-written condition mentions: tokens with an extension, optionally with directories. */
export function namedFiles(texts: readonly string[]): string[] {
  const names = new Set<string>();
  for (const text of texts) {
    for (const match of String(text).matchAll(/(?:^|[\s"'`(\[<,:])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,10})(?=$|[\s"'`)\]>,;:.!?])/g)) {
      const name = match[1].replace(/^\.\//, "");
      // An extension is letters (optionally with digits): "v1.2.3", "3.5" are versions and numbers, not files.
      if (!/\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/.test(name) || /^https?:/i.test(name) || name.includes("..")) continue;
      names.add(name);
      if (names.size >= MAX_FILES) return [...names];
    }
  }
  return [...names];
}

function allowedRoots(chatId: string): Array<{ kind: HostFileObservation["root"]; dir: string }> {
  const roots: Array<{ kind: HostFileObservation["root"]; dir: string }> = [];
  const chatFolder = getChatWorkingFolder(chatId);
  if (chatFolder) roots.push({ kind: "chat", dir: chatFolder });
  const projectId = getChat(chatId)?.projectId;
  const projectFolder = projectId ? getProject(projectId)?.folderPath ?? null : null;
  if (projectFolder) roots.push({ kind: "project", dir: projectFolder });
  if (!roots.length) roots.push({ kind: "agent", dir: agentRunCwd() });
  return roots.flatMap((root) => {
    try { return [{ kind: root.kind, dir: fs.realpathSync(root.dir) }]; } catch { return []; }
  });
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function observeOne(roots: ReturnType<typeof allowedRoots>, name: string, windowStartMs: number) {
  for (const root of roots) {
    const candidate = path.isAbsolute(name) ? name : path.resolve(root.dir, name);
    if (!inside(root.dir, candidate)) continue;
    let real: string;
    try { real = fs.realpathSync(candidate); } catch { continue; }
    // A symlink (at any level) whose real target leaves the allowed root is refused.
    if (!inside(root.dir, real)) continue;
    let stat: fs.Stats;
    try { stat = fs.statSync(real); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_HASH_BYTES) continue;
    let bytes: Buffer;
    try { bytes = fs.readFileSync(real); } catch { continue; }
    const text = bytes.includes(0) ? null : bytes.toString("utf8");
    return {
      relativePath: path.relative(root.dir, real), root: root.kind, bytes: stat.size,
      sha256: createHash("sha256").update(bytes).digest("hex"), mtime: stat.mtime.toISOString(),
      inRunWindow: stat.mtimeMs >= windowStartMs - WINDOW_SLACK_MS,
      preview: text === null ? null : text.slice(0, PREVIEW_CHARS),
    };
  }
  return null;
}

/**
 * Observe the files named by `texts` for a Goal's long run and record each as a host ledger event.
 * Returns the observations with their citable refs (`long-run-event:<run>:<seq>`).
 */
export function recordHostFileObservations(input: { longRunId: string; chatId: string; verifierAttemptId: string; texts: readonly string[] }): HostFileObservation[] {
  const run = getDb().prepare("SELECT created_at FROM long_runs WHERE id = ?").get(input.longRunId) as { created_at: string } | undefined;
  if (!run) return [];
  const windowStartMs = Date.parse(run.created_at);
  const roots = allowedRoots(input.chatId);
  if (!roots.length || !Number.isFinite(windowStartMs)) return [];
  const observations: HostFileObservation[] = [];
  const seen = new Set<string>();
  for (const name of namedFiles(input.texts)) {
    const observed = observeOne(roots, name, windowStartMs);
    if (!observed || seen.has(`${observed.root}:${observed.relativePath}`)) continue;
    seen.add(`${observed.root}:${observed.relativePath}`);
    const { preview, ...recorded } = observed;
    const seq = appendLongRunEvent({ runId: input.longRunId, kind: "verification.host_file_observation", actorKind: "host",
      payload: { schemaVersion: "agentlas.host-file-observation.v1", verifierAttemptId: input.verifierAttemptId, namedAs: name,
        ...recorded, previewSha256: preview === null ? null : createHash("sha256").update(preview).digest("hex") } });
    observations.push({ ref: `long-run-event:${input.longRunId}:${seq}`, exists: true, ...observed });
  }
  return observations;
}

/** Re-hash a recorded observation right before a pass is persisted. False when the file changed or vanished. */
export function hostFileObservationStillHolds(observation: HostFileObservation, chatId: string, longRunId: string): boolean {
  const run = getDb().prepare("SELECT created_at FROM long_runs WHERE id = ?").get(longRunId) as { created_at: string } | undefined;
  if (!run) return false;
  const current = observeOne(allowedRoots(chatId).filter((root) => root.kind === observation.root), observation.relativePath, Date.parse(run.created_at));
  return Boolean(current && current.sha256 === observation.sha256 && current.bytes === observation.bytes);
}
