/**
 * A file a shell command wrote leaves a receipt too ("파일 쓰기: 셸").
 *
 * The personal agent asked to put agenda.md into a project wrote it with `cat > <project folder>/agenda.md` in a shell: no write tool event, so no file receipt, no card, and the
 * screen only had the model's "I made it". A typed write (Write/Edit/apply_patch/edit kind) already has its receipt (mcp/client.ts onTool). This is the same door for the shell lane, from what is
 * SEEN on the disk, never from the answer's words: a path the finished shell call names, that is a file, modified since the turn began. The receipt says `observed` ("seen changed, not a tool
 * record"), and names where it landed: the conversation's own project or workspace, ANOTHER project's folder (root `project`, the card names that project), or outside every root.
 *
 * Every runtime that reports a shell tool event goes through the same onTool callback (claude-code Bash, codex command_execution, ACP `execute`, antigravity/grok/kimi/cursor/copilot shells,
 * BYOK/serving/local loops' shell tools), so one hook covers them. Pure over its ports: no model call, no timer, no table (a receipt is one existing row). Never throws.
 */
import os from "node:os";
import nodePath from "node:path";
import { recordFileWriteReceipt, rootOfPath, rootsOfChat, FILE_MTIME_RESOLUTION_MS } from "./turn-receipts";
import type { FileRoots } from "./turn-receipts";

/** Tool names (and the typed `execute` kind) that run a shell command. A read or a typed write is not here: it has its own rule. */
const SHELL_TOOL_NAME = /^(?:bash|shell|sh|zsh|fish|powershell|pwsh|cmd|exec|execute|exec_command|run_shell_command|run_command|local_shell|shell_command|command_execution|terminal|run_terminal_cmd)$/iu;
export function isShellToolEvent(name: string, kind?: string): boolean { return kind === "execute" || SHELL_TOOL_NAME.test(name.trim()); }

/** The most paths read out of one command, and the most receipts one call makes (a command that touches a whole tree is one line of receipts, not hundreds). */
const MAX_CANDIDATES = 64;
const MAX_RECEIPTS_PER_CALL = 8;
/** Shell calls started and not yet finished, by run + call id: a call that never reports a result leaves at most this many commands (oldest dropped). */
const MAX_PENDING_CALLS = 64;
const pendingShellArgs = new Map<string, string>();

/** The text a shell tool event's arguments carry: its JSON string values (`command`, `cmd`, `script`...), or the raw string. */
function commandTextOf(args: string | undefined): string {
  if (!args) return "";
  try {
    const value: unknown = JSON.parse(args);
    const out: string[] = [];
    const walk = (v: unknown, depth: number): void => {
      if (depth > 3) return;
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) { if (v.every((x) => typeof x === "string")) out.push(v.join(" ")); else v.forEach((x) => walk(x, depth + 1)); }
      else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach((x) => walk(x, depth + 1));
    };
    walk(value, 0);
    return out.join("\n").slice(0, 20_000);
  } catch { return args.slice(0, 20_000); }
}

/** Path-looking words of a command, resolved against the run's folder (and the last `cd` target before them). Candidates only: nothing is a receipt until the disk shows the file changed. */
export function shellPathCandidates(command: string, cwd: string | null, platform: NodeJS.Platform = process.platform): string[] {
  const api = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const home = os.homedir();
  const found: string[] = [];
  let base = cwd && api.isAbsolute(cwd) ? cwd : null;
  // A heredoc body is text, not paths (a command wrote a whole agenda through `cat > agenda.md <<'EOF' ... EOF`): it is dropped so its words never use up the candidate cap.
  command = command.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/gu, "");
  const pattern = /"([^"\n]+)"|'([^'\n]+)'|([^\s"'`;&|<>()]+)/gu;
  let previous = "";
  for (let m = pattern.exec(command); m && found.length < MAX_CANDIDATES; m = pattern.exec(command)) {
    let token = (m[1] ?? m[2] ?? m[3] ?? "").replace(/^[0-9]*>>?/u, "").replace(/[,]+$/u, "");
    const wasCd = previous === "cd";
    previous = token;
    if (!token || token.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//iu.test(token) || /[\u0000\r]/u.test(token) || token.length > 1024) continue;
    if (token === "~") token = home; else if (token.startsWith("~/")) token = api.join(home, token.slice(2));
    const abs = api.isAbsolute(token) ? token : base ? api.resolve(base, token) : null;
    if (!abs) continue;
    if (wasCd) { base = abs; continue; }
    if (!found.includes(abs)) found.push(abs);
  }
  return found;
}

export interface ShellWritePorts {
  /** When the run's turn began (ms), or null when unknown (nothing is observed then). */
  turnStartedAtMs(runId: string): number | null;
  stat(file: string): { isFile(): boolean; mtimeMs: number } | null;
  /** The folder of the project that holds `file`, when it is not the conversation's own roots: [folder, name]. */
  otherProjectOf(file: string): { folder: string } | null;
  roots(chatId: string): FileRoots;
  cwd(chatId: string): string | null;
  record: typeof recordFileWriteReceipt;
  platform?: NodeJS.Platform;
}

/**
 * Receipts for the files a finished shell call changed. Returns the paths that got a receipt. `args` is the event's raw arguments; `result` is set only for a finished call.
 * Roots are the conversation's own; a file in another project's folder is a `project` receipt of that folder (the live card names the project), and anything else outside is `outside`.
 */
export function recordShellWriteReceipts(input: { chatId: string; runId: string; toolName: string; toolKind?: string; toolId?: string; args?: string; isError?: boolean; finished: boolean }, ports: ShellWritePorts = productionPorts()): string[] {
  const done: string[] = [];
  try {
    if (!input.runId || !isShellToolEvent(input.toolName, input.toolKind)) return done;
    // Claude Code (and others) name the command on the tool_use event and report the result on a LATER event that carries no arguments: the command is kept by the call's id until its result arrives.
    const key = input.toolId ? `${input.runId}|${input.toolId}` : null;
    if (!input.finished) {
      if (key && input.args) { pendingShellArgs.set(key, input.args); while (pendingShellArgs.size > MAX_PENDING_CALLS) pendingShellArgs.delete(pendingShellArgs.keys().next().value as string); }
      return done;
    }
    const args = input.args ?? (key ? pendingShellArgs.get(key) : undefined);
    if (key) pendingShellArgs.delete(key);
    if (input.isError) return done;
    const since = ports.turnStartedAtMs(input.runId);
    if (since === null) return done;
    const command = commandTextOf(args);
    if (!command) return done;
    const platform = ports.platform ?? process.platform;
    const roots = ports.roots(input.chatId);
    for (const candidate of shellPathCandidates(command, ports.cwd(input.chatId), platform)) {
      if (done.length >= MAX_RECEIPTS_PER_CALL) break;
      const info = ports.stat(candidate);
      if (!info || !info.isFile() || info.mtimeMs < since - FILE_MTIME_RESOLUTION_MS) continue;
      let useRoots: FileRoots = roots;
      if (rootOfPath(candidate, roots, platform) === "outside") {
        const other = ports.otherProjectOf(candidate);
        if (other) useRoots = { ...roots, project: other.folder };
      }
      const made = ports.record({ path: candidate, chatId: input.chatId, runId: input.runId, roots: useRoots, platform, observed: true });
      if (made.recorded) done.push(candidate);
    }
  } catch { /* a receipt that cannot be made never breaks the run */ }
  return done;
}

const startedCache = new Map<string, number>();
function productionPorts(): ShellWritePorts {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const db = () => (require("../store/db") as typeof import("../store/db")).getDb();
  return {
    turnStartedAtMs: (runId) => {
      const hit = startedCache.get(runId);
      if (hit !== undefined) return hit;
      const row = db().prepare("SELECT ts FROM run_events WHERE run_id = ? AND kind = 'invoke_started' ORDER BY seq LIMIT 1").get(runId) as { ts?: string } | undefined;
      const ms = row?.ts ? Date.parse(row.ts) : NaN;
      if (!Number.isFinite(ms)) return null;
      startedCache.set(runId, ms);
      while (startedCache.size > 64) startedCache.delete(startedCache.keys().next().value as string);
      return ms;
    },
    stat: (file) => { try { return (require("node:fs") as typeof import("node:fs")).statSync(file); } catch { return null; } },
    otherProjectOf: (file) => {
      const rows = db().prepare("SELECT folder_path AS folder FROM projects WHERE folder_path IS NOT NULL AND folder_path <> ''").all() as Array<{ folder: string }>;
      let best: string | null = null;
      for (const { folder } of rows) {
        if (rootOfPath(file, { project: folder }) === "project" && (!best || folder.length > best.length)) best = folder;
      }
      return best ? { folder: best } : null;
    },
    roots: (chatId) => rootsOfChat(chatId),
    cwd: (chatId) => {
      try {
        const row = db().prepare("SELECT working_folder AS w FROM chats WHERE id = ?").get(chatId) as { w?: string | null } | undefined;
        return row?.w ?? null;
      } catch { return null; }
    },
    record: recordFileWriteReceipt,
  };
  /* eslint-enable @typescript-eslint/no-require-imports */
}
