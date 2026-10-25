// The phone terminal speaks to one long-lived shell. What that shell is decides
// three things: how the controller writes the completion marker after a
// command, which unapproved commands only print bounded machine metadata, and
// whether the pipe fallback must switch the shell's output to UTF-8.
//
// Windows runs cmd.exe. Before this module the marker was always the POSIX
// `printf '\n<marker>:%s\n' "$?"`; cmd.exe has neither printf nor $?, so every
// phone command stayed "running" forever, and the unapproved `date` made cmd
// wait for a new date (the next marker line was read as that date).

import path from "node:path";

export type TerminalShellDialect = "posix" | "cmd";

export interface TerminalShellSpec {
  readonly command: string;
  readonly args: string[];
  readonly dialect: TerminalShellDialect;
}

/**
 * Windows: %ComSpec% when it is cmd.exe, else cmd.exe under %SystemRoot% — the
 * marker below is cmd syntax, so a ComSpec pointing at another shell must not
 * receive it. `/Q` turns echo off so no prompt is printed before output lines.
 */
export function windowsTerminalShell(env: NodeJS.ProcessEnv = process.env): TerminalShellSpec {
  const comSpec = env.ComSpec?.trim() || env.COMSPEC?.trim() || "";
  const systemRoot = env.SystemRoot?.trim() || env.SYSTEMROOT?.trim() || "C:\\Windows";
  const command = comSpec && path.win32.basename(comSpec).toLowerCase() === "cmd.exe"
    ? comSpec
    : path.win32.join(systemRoot, "System32", "cmd.exe");
  return { command, args: ["/Q"], dialect: "cmd" };
}

/**
 * The line written after every reviewed command. It prints an empty line first
 * so the marker always starts its own line even when the command output had no
 * trailing newline. cmd expands %ERRORLEVEL% when it reads this line, i.e.
 * after the previous command finished.
 */
export function completionMarkerLine(dialect: TerminalShellDialect, marker: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(marker)) throw new Error("Invalid terminal completion marker");
  return dialect === "cmd"
    ? `echo.&echo ${marker}:%ERRORLEVEL%`
    : `printf '\\n${marker}:%s\\n' "$?"`;
}

/**
 * Unapproved commands may expose only bounded machine/process metadata (see
 * terminal-control commandRisk). The set is per shell: `pwd`/`tty` do not
 * exist in cmd, plain `date`/`time` wait for input there, and a bare `cd`
 * prints the current folder in cmd while it changes folder in POSIX shells.
 */
export function isUnapprovedSafeTerminalCommand(dialect: TerminalShellDialect, trimmed: string): boolean {
  const git = String.raw`git\s+(?:status(?:\s+(?:--short|--porcelain(?:=v1)?))?|branch(?:\s+--show-current)?)`;
  const pattern = dialect === "cmd"
    ? new RegExp(String.raw`^(?:cd|whoami|date\s+/t|time\s+/t|${git})$`, "i")
    : new RegExp(String.raw`^(?:pwd|date|whoami|tty|${git})$`, "i");
  return pattern.test(trimmed);
}

/**
 * Text written once after the shell starts, before any phone command. The
 * pipe fallback decodes output as UTF-8, while cmd prints in the OEM code page
 * (949 on Korean Windows) unless told otherwise. A PTY (ConPTY) already hands
 * over UTF-8, and POSIX shells need nothing.
 */
export function terminalShellPreamble(dialect: TerminalShellDialect, pty: boolean): string {
  return dialect === "cmd" && !pty ? "chcp 65001>nul\n" : "";
}

export interface CompletionMarkerMatch {
  /** Visible text the shell printed on the same row before the marker (ConPTY repaint without a newline). */
  readonly before: string;
  readonly id: string;
  readonly exitCode: string;
}

/**
 * The marker ends a line. POSIX printf always starts it on a fresh line, so
 * `before` is empty there; a ConPTY repaint may leave earlier output on the
 * same row, which is returned instead of being dropped. The echoed marker
 * command itself never matches (it ends in %ERRORLEVEL% / "$?", not digits).
 */
export function matchCompletionMarker(line: string, prefix: string): CompletionMarkerMatch | null {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = line.match(new RegExp(`^(.*?)${escaped}([a-zA-Z0-9_-]+):(-?\\d+)\\s*$`));
  if (!match) return null;
  return { before: match[1], id: match[2], exitCode: match[3] };
}
