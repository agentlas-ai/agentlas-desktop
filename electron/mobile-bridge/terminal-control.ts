import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { IPty } from "node-pty";

import type {
  MobileBridgeTerminalCancelDto,
  MobileBridgeTerminalDispatchDto,
  MobileBridgeTerminalLineDto,
  MobileBridgeTerminalPreviewDto,
  MobileBridgeTerminalReadDto,
  MobileBridgeTerminalReleaseDto,
  MobileBridgeTerminalTakeoverDto,
  MobileBridgeTerminalRisk,
  MobileBridgeTerminalRefusalDto,
} from "../../shared/mobile-bridge";
import type { ToolApprovalOutcome } from "../runtime/tool-approval";
import type { MobileBridgeTerminalControl } from "./authority";
import type { MobileBridgeConnectionContext } from "./server";
import {
  onToolApprovalRequested,
  onToolApprovalResolved,
  requestToolApproval,
  resolveToolApproval,
} from "../runtime/tool-approval";
import {
  detachedSpawnOpts,
  killCliTree,
  spawnCli,
  trackRunChild,
} from "../runtime/exec";
import { onHostShutdown } from "../host-lifecycle";
import { getChatWorkingFolder, listRecentChats } from "../store/chats";
import { getProject } from "../store/projects";
import {
  sanitizeMobileBridgeText,
  truncateMobileBridgeUtf8,
} from "./sanitize";

/**
 * The Mobile Bridge is only a transport.  This controller is the Desktop-side
 * owner of the process it exposes: the phone never supplies an executable,
 * cwd, environment, or process id.  A terminal is a long-lived shell with a
 * bounded, sanitized output ring; commands are written to that shell only
 * after the bridge has granted the mobile owner epoch and the command passed
 * the preview/approval gate.
 *
 * node-pty owns the actual POSIX PTY / Windows ConPTY session. A pipe child is
 * retained only as a bounded startup fallback when the native addon cannot be
 * loaded (for example a developer ran Electron before rebuilding native
 * dependencies); that fallback is reported by the live contract test and is
 * never described as a PTY.
 */

const OUTPUT_RING_LIMIT = 5_000;
const MAX_TERMINALS = 8;
const COMMAND_MAX_CHARS = 4_000;
const PREVIEW_TTL_MS = 60_000;
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const TERMINAL_ID_RE = /^[^\u0000-\u001f]{1,160}$/;
const REQUEST_ID_RE = /^[^\u0000-\u001f]{1,160}$/;
const PREVIEW_ID_RE = /^[^\u0000-\u001f]{1,160}$/;
const DONE_PREFIX = "__AGENTLAS_MOBILE_TERMINAL_DONE__";

type TerminalRequestState = "queued" | "running" | "completed" | "cancelled";

interface TerminalRequest {
  requestId: string;
  marker: string;
  status: TerminalRequestState;
  startedAt: number;
}

interface TerminalPreview {
  terminalId: string;
  previewId: string;
  command: string;
  risk: MobileBridgeTerminalRisk;
  requiresApproval: boolean;
  ownerEpoch: number;
  expiresAt: string;
  expiresAtMs: number;
  approvalId: string | null;
  approvalOutcome: ToolApprovalOutcome | null;
}

interface TerminalProcess {
  terminalId: string;
  cwd: string;
  handle: TerminalProcessHandle;
  pty: boolean;
  exited: boolean;
  output: MobileBridgeTerminalLineDto[];
  nextSeq: number;
  dropped: boolean;
  partial: { stdout: string; stderr: string };
  previews: Map<string, TerminalPreview>;
  requests: Map<string, TerminalRequest>;
  mobileOwner: boolean;
  agentInputPaused: boolean;
}

interface TerminalProcessHandle {
  readonly pty: boolean;
  readonly pid: number | undefined;
  write(text: string): boolean;
  kill(signal?: string): void;
  /** Close the PTY master/ConPTY resources before the Electron app exits. */
  destroy(): void;
  onData(listener: (stream: "stdout" | "stderr", chunk: string) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  /** Only pipe handles participate in the existing run-child registry. */
  readonly child?: ChildProcess;
}

export interface DesktopMobileTerminalControlOptions {
  /** Explicit project folder chosen by the host. Never comes from the phone. */
  defaultCwd?: string | null;
  maxTerminals?: number;
}

export interface DesktopMobileTerminalControl
  extends MobileBridgeTerminalControl {
  /** Resolve after native PTY exit callbacks have drained. */
  dispose(): Promise<void>;
}

function refusal(
  code: MobileBridgeTerminalRefusalDto["code"],
  message: string,
): MobileBridgeTerminalRefusalDto {
  return { schemaVersion: 1, status: "refused", code, message };
}

function validDirectory(value: unknown): string | null {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  try {
    if (fs.statSync(value).isDirectory()) return path.resolve(value);
  } catch {
    // An unavailable project is not a reason to run in an arbitrary directory.
  }
  return null;
}

function resolveDefaultCwd(explicit: string | null | undefined): string {
  const configured = validDirectory(explicit);
  if (configured) return configured;

  // The most recently used project chat is the only implicit Desktop source.
  // If the store is not ready (unit tests, early startup), we do not create or
  // guess a project; the home directory is a bounded, predictable fallback.
  try {
    for (const chat of listRecentChats(16)) {
      const folder = validDirectory(getChatWorkingFolder(chat.id));
      if (folder) return folder;
    }
  } catch {
    // The bridge may start before the store has completed bootstrapping.
  }
  return validDirectory(process.cwd()) ?? os.homedir();
}

function resolveCwdForTerminal(terminalId: string, fallback: string): string {
  // A future desktop surface may pass project:<id>.  It is still resolved from
  // the local SQLite authority; the phone can never send an arbitrary path.
  const match = terminalId.match(/^project:(.{1,160})$/);
  if (match) {
    try {
      const folder = validDirectory(getProject(match[1])?.folderPath);
      if (folder) return folder;
    } catch {
      // Fall through to the host-selected folder.
    }
  }
  return fallback;
}

function shellSpec(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    const command = process.env.ComSpec?.trim() || "cmd.exe";
    return { command, args: ["/Q"] };
  }
  const candidates = process.platform === "darwin"
    ? ["/bin/zsh", "/bin/bash"]
    : [process.env.SHELL, "/bin/bash", "/bin/sh"];
  const command = candidates.find((candidate) => {
    if (!candidate || !path.isAbsolute(candidate)) return false;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? "/bin/sh";
  const shellArgs = path.basename(command) === "zsh"
    ? ["-f", "-i"]
    : path.basename(command) === "bash"
      ? ["--noprofile", "--norc", "-i"]
      : ["-i"];
  return { command, args: shellArgs };
}

function shellEnvironment(pty: boolean): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // PTY sessions need a terminal-capable TERM for 2FA/full-screen tools;
    // pipe fallback stays dumb so ANSI noise cannot be mistaken for output.
    TERM: pty ? "xterm-256color" : "dumb",
    NO_COLOR: "1",
    CLICOLOR: "0",
    PS1: "",
    PROMPT: "",
    RPROMPT: "",
    HISTFILE: "/dev/null",
  };
}

function stripControlText(value: string): string {
  // Keep newlines out of a single DTO line and remove terminal control/OSC
  // sequences before the value reaches Flutter.
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r/g, "")
    .trimEnd();
}

function safeDisplayText(value: string): string {
  return truncateMobileBridgeUtf8(
    sanitizeMobileBridgeText(stripControlText(value), 4 * 1024),
    4 * 1024,
  );
}

/**
 * Unknown shell strings require approval.  The safe set is intentionally
 * small and rejects every shell operator, substitution, redirection, and
 * command separator.  An explicit approval can still run a legitimate build
 * or login command, but the phone cannot turn a typo into an unreviewed write.
 */
function commandRisk(command: string): MobileBridgeTerminalRisk {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > COMMAND_MAX_CHARS) return "dangerous";
  // The v1 mobile field is explicitly one-line. A newline turns a harmless
  // prefix into a second shell statement, so it must never enter the safe
  // allowlist by accident.
  if (/[\r\n]/.test(trimmed)) return "dangerous";
  if (/[;&|><`$(){}[\]\\]/.test(trimmed)) return "dangerous";
  if (/\b(?:sudo|doas|rm|rmdir|mv|cp|chmod|chown|kill|pkill|killall|shutdown|reboot|launchctl|git\s+(?:push|reset|clean|checkout|restore)|npm\s+(?:install|uninstall|publish)|pnpm\s+(?:add|install|remove)|yarn\s+(?:add|install|remove)|curl|wget|ssh|scp|nc|bash|zsh|sh|exit|logout|exec)\b/i.test(trimmed)) {
    return "dangerous";
  }
  // Unapproved mobile commands may expose only bounded machine/process
  // metadata. File names, source, logs, and arbitrary environment values are
  // private local content, so even read-only commands such as ls/cat/rg/git
  // show must cross the Desktop approval gate before their output leaves the
  // host. This is a disclosure boundary, not only a write boundary.
  return /^(?:pwd|date|whoami|tty|git\s+(?:status(?:\s+(?:--short|--porcelain(?:=v1)?))?|branch(?:\s+--show-current)?))$/i.test(trimmed)
    ? "safe"
    : "dangerous";
}

function commandMarker(requestId: string): string {
  return `${DONE_PREFIX}${requestId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function isWritableChild(child: ChildProcess): boolean {
  const stdin = child.stdin;
  return Boolean(
    stdin &&
      !stdin.destroyed &&
      !stdin.writableEnded &&
      !stdin.writableFinished &&
      stdin.writable,
  );
}

function writeToPipe(child: ChildProcess, text: string): boolean {
  if (!isWritableChild(child)) return false;
  try {
    child.stdin!.write(text);
    return true;
  } catch {
    return false;
  }
}

class PtyTerminalHandle implements TerminalProcessHandle {
  readonly pty = true;

  constructor(private readonly session: IPty) {}

  get pid(): number {
    return this.session.pid;
  }

  write(text: string): boolean {
    try {
      this.session.write(text);
      return true;
    } catch {
      return false;
    }
  }

  kill(signal?: string): void {
    try {
      this.session.kill(signal);
    } catch {
      // The PTY may already have exited.
    }
  }

  destroy(): void {
    try {
      // node-pty closes the master fd first and only then sends SIGHUP. That
      // ordering avoids a late native callback racing Electron shutdown.
      const destroy = (this.session as IPty & { destroy?: () => void }).destroy;
      if (destroy) destroy.call(this.session);
      else this.session.kill();
    } catch {
      // The PTY may already have been destroyed during host shutdown.
    }
  }

  onData(listener: (stream: "stdout" | "stderr", chunk: string) => void): void {
    this.session.onData((chunk) => listener("stdout", chunk));
  }

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.session.onExit(({ exitCode, signal }) => {
      listener(exitCode, signal ? String(signal) : null);
    });
  }
}

class PipeTerminalHandle implements TerminalProcessHandle {
  readonly pty = false;

  constructor(readonly child: ChildProcess) {}

  get pid(): number | undefined {
    return this.child.pid;
  }

  write(text: string): boolean {
    return writeToPipe(this.child, text);
  }

  kill(signal?: string): void {
    try {
      this.child.kill(signal as NodeJS.Signals | undefined);
    } catch {
      // The pipe child may already have exited.
    }
  }

  destroy(): void {
    try {
      this.child.kill();
    } catch {
      // The pipe child may already have exited.
    }
  }

  onData(listener: (stream: "stdout" | "stderr", chunk: string) => void): void {
    this.child.stdout?.on("data", (chunk: Buffer | string) => {
      listener("stdout", Buffer.from(chunk).toString("utf8"));
    });
    this.child.stderr?.on("data", (chunk: Buffer | string) => {
      listener("stderr", Buffer.from(chunk).toString("utf8"));
    });
  }

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.child.once("error", (error) => listener(null, error.message));
    this.child.once("close", (code, signal) => listener(code, signal));
  }
}

function spawnTerminalHandle(
  spec: { command: string; args: string[] },
  cwd: string,
): TerminalProcessHandle {
  try {
    // Keep this lazy: an unrebuilt optional native addon must not prevent the
    // Desktop from booting. Packaged builds include node-pty and electron-
    // rebuild targets its native ABI; source/test hosts can still use pipe
    // fallback with an explicit pty=false receipt.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodePty = require("node-pty") as typeof import("node-pty");
    const session = nodePty.spawn(spec.command, spec.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd,
      env: shellEnvironment(true),
    });
    return new PtyTerminalHandle(session);
  } catch (error) {
    console.warn(
      `[mobile-terminal] PTY unavailable on ${process.platform}; using pipe fallback (${error instanceof Error ? error.name : "unknown"})`,
    );
    const child = spawnCli(spec.command, spec.args, {
      cwd,
      env: shellEnvironment(false),
      stdio: ["pipe", "pipe", "pipe"],
      ...detachedSpawnOpts(),
    });
    return new PipeTerminalHandle(child);
  }
}

export class DesktopMobileTerminalController
  implements DesktopMobileTerminalControl {
  private readonly terminals = new Map<string, TerminalProcess>();
  private readonly defaultCwd: string;
  private readonly maxTerminals: number;
  private readonly approvalPreviews = new Map<string, TerminalPreview>();
  private readonly unsubscribeApproval: () => void;
  private readonly unsubscribeApprovalResolved: () => void;
  private readonly unsubscribeShutdown: () => void;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(options: DesktopMobileTerminalControlOptions = {}) {
    this.defaultCwd = resolveDefaultCwd(options.defaultCwd);
    this.maxTerminals = Math.max(1, Math.min(MAX_TERMINALS, Math.floor(options.maxTerminals ?? 4)));

    // `requestToolApproval` creates the opaque approval id synchronously and
    // notifies listeners before returning its pending promise.  We capture
    // only our own runtime/tool requests; no raw command is added to the
    // bridge outside the existing approval projector.
    let latestTerminalApproval: { id: string; detail?: string } | null = null;
    const capture = (request: { id: string; runtime: string; tool: string; detail?: string }) => {
      if (request.runtime === "agentlas-mobile-terminal" && request.tool === "terminal") {
        latestTerminalApproval = { id: request.id, detail: request.detail };
      }
    };
    this.unsubscribeApproval = onToolApprovalRequested(capture);
    this.unsubscribeApprovalResolved = onToolApprovalResolved((id, outcome) => {
      const preview = this.approvalPreviews.get(id);
      if (!preview) return;
      preview.approvalOutcome = outcome;
    });
    // Keep a private hook for `queueApproval` without exposing the global
    // approval implementation to the bridge.  It is replaced per call below.
    this.captureLatestApproval = () => {
      const captured = latestTerminalApproval;
      latestTerminalApproval = null;
      return captured;
    };
    this.unsubscribeShutdown = onHostShutdown(() => this.dispose());
  }

  private captureLatestApproval: () => { id: string; detail?: string } | null = () => null;

  private ensureTerminal(terminalId: string): TerminalProcess {
    if (this.disposed) throw new Error("Mobile terminal controller is disposed");
    if (!TERMINAL_ID_RE.test(terminalId)) throw new Error("Invalid terminal id");
    const existing = this.terminals.get(terminalId);
    if (existing && !existing.exited) return existing;
    if (existing?.exited) this.terminals.delete(terminalId);
    if (this.terminals.size >= this.maxTerminals) {
      throw new Error("Mobile terminal capacity is exhausted");
    }
    const cwd = resolveCwdForTerminal(terminalId, this.defaultCwd);
    const spec = shellSpec();
    const handle = spawnTerminalHandle(spec, cwd);
    const terminal: TerminalProcess = {
      terminalId,
      cwd,
      handle,
      pty: handle.pty,
      exited: false,
      output: [],
      nextSeq: 1,
      dropped: false,
      partial: { stdout: "", stderr: "" },
      previews: new Map(),
      requests: new Map(),
      mobileOwner: false,
      agentInputPaused: false,
    };
    this.terminals.set(terminalId, terminal);
    if (handle.child) trackRunChild(handle.child);
    handle.onData((stream, chunk) => this.consumeOutput(terminal, stream, chunk));
    handle.onExit((code, signal) => {
      terminal.exited = true;
      for (const stream of ["stdout", "stderr"] as const) {
        const rest = terminal.partial[stream];
        if (rest) {
          this.appendLine(terminal, stream, rest);
          terminal.partial[stream] = "";
        }
      }
      for (const request of terminal.requests.values()) {
        if (request.status === "running" || request.status === "queued") request.status = "cancelled";
      }
      this.appendLine(
        terminal,
        "system",
        `Terminal process exited${code === null ? "" : ` (exit ${code})`}${signal ? ` [${signal}]` : ""}.`,
      );
    });
    // A shell may emit a prompt immediately.  It is useful proof that a real
    // process was attached, but keep it bounded and sanitized like all output.
    return terminal;
  }

  private consumeOutput(terminal: TerminalProcess, stream: "stdout" | "stderr", chunk: string): void {
    let value = terminal.partial[stream] + chunk;
    const parts = value.split(/\r\n|\n|\r/);
    terminal.partial[stream] = parts.pop() ?? "";
    for (const line of parts) {
      const cleaned = stripControlText(line);
      const marker = cleaned.match(new RegExp(`^${DONE_PREFIX}([a-zA-Z0-9_-]+):(-?\\d+)$`));
      if (marker) {
        const request = [...terminal.requests.values()].find((item) => item.marker.endsWith(marker[1]));
        if (request) {
          if (request.status !== "cancelled") request.status = "completed";
          this.appendLine(terminal, "system", `Command completed (exit ${marker[2]}).`);
        }
        continue;
      }
      this.appendLine(terminal, stream, cleaned);
    }
  }

  private appendLine(
    terminal: TerminalProcess,
    stream: MobileBridgeTerminalLineDto["stream"],
    text: string,
  ): void {
    const safe = safeDisplayText(text);
    const line: MobileBridgeTerminalLineDto = {
      seq: terminal.nextSeq++,
      stream,
      text: safe,
    };
    terminal.output.push(line);
    if (terminal.output.length > OUTPUT_RING_LIMIT) {
      terminal.output.splice(0, terminal.output.length - OUTPUT_RING_LIMIT);
      terminal.dropped = true;
    }
  }

  private async queueApproval(preview: TerminalPreview): Promise<void> {
    const safeDetail = safeDisplayText(preview.command);
    const approval = requestToolApproval({
      runtime: "agentlas-mobile-terminal",
      tool: "terminal",
      detail: safeDetail,
      sessionKey: `mobile-terminal:${preview.terminalId}:${preview.previewId}`,
      capability: "execute",
      timeoutMs: APPROVAL_TIMEOUT_MS,
    });
    const captured = this.captureLatestApproval();
    if (!captured) {
      // The global approval registry failed to expose the id.  Never execute
      // without a receipt; the promise is still consumed so it cannot become
      // an unhandled rejection.
      void approval.catch(() => undefined);
      throw new Error("Mobile terminal approval registration failed");
    }
    preview.approvalId = captured.id;
    this.approvalPreviews.set(captured.id, preview);
    void approval.then((outcome) => {
      preview.approvalOutcome = outcome;
      if (preview.expiresAtMs <= Date.now() && outcome.decision !== "deny") {
        // Expired previews cannot be revived by a late approval.
        preview.approvalOutcome = { decision: "deny", decidedAt: new Date().toISOString() };
      }
    }).catch(() => {
      preview.approvalOutcome = { decision: "deny", decidedAt: new Date().toISOString() };
    });
  }

  private expirePreview(preview: TerminalPreview): void {
    if (preview.expiresAtMs > Date.now()) return;
    const terminal = this.terminals.get(preview.terminalId);
    terminal?.previews.delete(preview.previewId);
    if (preview.approvalId) {
      this.approvalPreviews.delete(preview.approvalId);
      // Denying a pending approval clears the timer and prevents a stale
      // approval id from being replayed after a new preview is created.
      resolveToolApproval(preview.approvalId, "deny");
    }
  }

  async read(
    input: { terminalId: string; sinceSeq?: number; limit?: number },
    _context: MobileBridgeConnectionContext,
  ): Promise<MobileBridgeTerminalReadDto> {
    let terminal: TerminalProcess;
    try {
      terminal = this.ensureTerminal(input.terminalId);
    } catch (error) {
      return {
        schemaVersion: 1,
        terminalId: input.terminalId,
        status: "unavailable",
        owner: "none",
        ownerEpoch: 0,
        lines: [],
        nextSeq: 0,
        truncated: false,
        refusal: refusal("terminal_control_unavailable", error instanceof Error ? error.message : String(error)),
      };
    }
    const since = Number.isInteger(input.sinceSeq) ? Math.max(0, input.sinceSeq!) : 0;
    const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(500, input.limit!)) : 200;
    for (const preview of terminal.previews.values()) this.expirePreview(preview);
    const lines = terminal.output.filter((line) => line.seq > since).slice(-limit);
    const busy = [...terminal.requests.values()].some((request) => request.status === "running" || request.status === "queued");
    const pendingPreviews = [...terminal.previews.values()]
      .sort((left, right) => left.expiresAtMs - right.expiresAtMs)
      .slice(-8)
      .map((preview) => ({
        schemaVersion: 1 as const,
        terminalId: preview.terminalId,
        previewId: preview.previewId,
        command: preview.command,
        risk: preview.risk,
        requiresApproval: preview.requiresApproval,
        ownerEpoch: preview.ownerEpoch,
        expiresAt: preview.expiresAt,
        ...(preview.approvalId ? { approvalId: preview.approvalId } : {}),
      }));
    const requests = [...terminal.requests.values()]
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(-32)
      .map((request) => ({
        requestId: request.requestId,
        status: request.status,
        startedAt: new Date(request.startedAt).toISOString(),
      }));
    return {
      schemaVersion: 1,
      terminalId: input.terminalId,
      status: terminal.exited ? "unavailable" : busy ? "busy" : "ready",
      owner: terminal.mobileOwner ? "mobile" : "agent",
      ownerEpoch: 0,
      lines,
      nextSeq: terminal.nextSeq,
      truncated: terminal.dropped || (lines.length > 0 && lines[0].seq > since + 1),
      pendingPreviews,
      requests,
      ...(terminal.exited
        ? { refusal: refusal("terminal_control_unavailable", "The Desktop terminal process exited.") }
        : {}),
    };
  }

  async preview(
    input: { terminalId: string; command: string; ownerEpoch: number },
    _context: MobileBridgeConnectionContext,
  ): Promise<MobileBridgeTerminalPreviewDto> {
    if (!input.command.trim() || input.command.length > COMMAND_MAX_CHARS) {
      throw new Error("Terminal command is empty or too long");
    }
    const terminal = this.ensureTerminal(input.terminalId);
    if (terminal.exited) throw new Error("Terminal process exited");
    const risk = commandRisk(input.command);
    const preview: TerminalPreview = {
      terminalId: input.terminalId,
      previewId: `terminal-preview-${randomUUID()}`,
      command: input.command,
      risk,
      requiresApproval: risk === "dangerous",
      ownerEpoch: input.ownerEpoch,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
      expiresAtMs: Date.now() + PREVIEW_TTL_MS,
      approvalId: null,
      approvalOutcome: null,
    };
    for (const old of terminal.previews.values()) this.expirePreview(old);
    terminal.previews.set(preview.previewId, preview);
    if (preview.requiresApproval) await this.queueApproval(preview);
    return {
      schemaVersion: 1,
      terminalId: input.terminalId,
      previewId: preview.previewId,
      command: input.command,
      risk,
      requiresApproval: preview.requiresApproval,
      ownerEpoch: input.ownerEpoch,
      expiresAt: preview.expiresAt,
      ...(preview.approvalId ? { approvalId: preview.approvalId } : {}),
    } as MobileBridgeTerminalPreviewDto;
  }

  async takeover(
    input: { terminalId: string; expectedOwnerEpoch: number; nextOwnerEpoch: number },
    _context: MobileBridgeConnectionContext,
  ): Promise<MobileBridgeTerminalTakeoverDto> {
    const terminal = this.ensureTerminal(input.terminalId);
    if (terminal.exited) throw new Error("Terminal process exited");
    if (terminal.mobileOwner) throw new Error("Terminal is already owned by mobile");
    // No Desktop agent path is allowed to write to this controller while this
    // bit is set.  The bridge authority owns the epoch/device CAS around it.
    terminal.mobileOwner = true;
    terminal.agentInputPaused = true;
    return { schemaVersion: 1, terminalId: input.terminalId, owner: "mobile", ownerEpoch: input.nextOwnerEpoch };
  }

  async release(
    input: { terminalId: string; ownerEpoch: number; nextOwnerEpoch: number },
    _context: MobileBridgeConnectionContext,
  ): Promise<MobileBridgeTerminalReleaseDto> {
    const terminal = this.ensureTerminal(input.terminalId);
    if (terminal.exited) throw new Error("Terminal process exited");
    terminal.mobileOwner = false;
    terminal.agentInputPaused = false;
    for (const preview of terminal.previews.values()) this.expirePreview(preview);
    return { schemaVersion: 1, terminalId: input.terminalId, owner: "agent", ownerEpoch: input.nextOwnerEpoch };
  }

  async dispatch(
    input: { terminalId: string; ownerEpoch: number; previewId: string; approvalId?: string },
    _context: MobileBridgeConnectionContext,
  ): Promise<MobileBridgeTerminalDispatchDto> {
    const terminal = this.ensureTerminal(input.terminalId);
    if (terminal.exited) throw new Error("Terminal process exited");
    if (!terminal.mobileOwner || !terminal.agentInputPaused) throw new Error("Mobile terminal ownership is not active");
    const preview = terminal.previews.get(input.previewId);
    if (!preview || preview.ownerEpoch !== input.ownerEpoch) throw new Error("Terminal preview is missing or stale");
    this.expirePreview(preview);
    if (!terminal.previews.has(input.previewId)) throw new Error("Terminal preview expired");
    if (preview.requiresApproval) {
      if (!input.approvalId || preview.approvalId !== input.approvalId) throw new Error("Terminal approval is required");
      const outcome = preview.approvalOutcome;
      if (!outcome || (outcome.decision !== "allow_once" && outcome.decision !== "allow_session" && outcome.decision !== "allow_always")) {
        throw new Error("Terminal approval is not resolved");
      }
    }
    const requestId = `terminal-request-${randomUUID()}`;
    const marker = commandMarker(requestId);
    const request: TerminalRequest = { requestId, marker, status: "running", startedAt: Date.now() };
    terminal.requests.set(requestId, request);
    // The marker is emitted by the same shell after the command, giving the
    // read surface a real completion boundary without inventing a timer-based
    // success.  Commands are never interpolated into a second shell: they are
    // written exactly as previewed, followed by the fixed marker line.
    // Canonical PTY input is committed with carriage return; a pipe shell
    // consumes newline. This is the small but important distinction that
    // makes the same reviewed command work in both execution modes.
    const lineEnding = terminal.pty ? "\r" : "\n";
    const payload = `${preview.command}${lineEnding}printf '\\n${marker}:%s\\n' "$?"${lineEnding}`;
    if (!terminal.handle.write(payload)) {
      request.status = "cancelled";
      throw new Error("Terminal process stdin is unavailable");
    }
    terminal.previews.delete(input.previewId);
    if (preview.approvalId) this.approvalPreviews.delete(preview.approvalId);
    return {
      schemaVersion: 1,
      terminalId: input.terminalId,
      requestId,
      status: "running",
      ownerEpoch: input.ownerEpoch,
    };
  }

  async cancel(
    input: { terminalId: string; ownerEpoch: number; requestId: string },
    _context: MobileBridgeConnectionContext,
  ): Promise<MobileBridgeTerminalCancelDto> {
    const terminal = this.ensureTerminal(input.terminalId);
    if (!REQUEST_ID_RE.test(input.requestId)) throw new Error("Invalid terminal request id");
    const request = terminal.requests.get(input.requestId);
    if (!request) throw new Error("Terminal request was not found");
    if (request.status === "running" || request.status === "queued") {
      request.status = "cancelled";
      if (terminal.pty) {
        // PTY line discipline turns this byte into SIGINT for the foreground
        // process group while preserving the long-lived shell session.
        terminal.handle.write("\u0003");
      } else if (process.platform !== "win32" && terminal.handle.pid) {
        // A byte written to a pipe is not a terminal interrupt: on POSIX it
        // would merely sit in the shell's input buffer until the foreground
        // command exits. The pipe fallback is detached into its own process
        // group, so signal that group instead.
        try {
          process.kill(-terminal.handle.pid, "SIGINT");
        } catch {
          // The group may have exited between the read and the signal. The
          // cancellation receipt remains truthful because the request was
          // already marked cancelled and the shell close handler reconciles it.
        }
      } else {
        // Windows pipe fallback has no signal-equivalent; keep the byte path
        // explicit until node-pty/ConPTY is available.
        terminal.handle.write("\u0003");
      }
    }
    return {
      schemaVersion: 1,
      terminalId: input.terminalId,
      requestId: input.requestId,
      status: "cancelled",
      ownerEpoch: input.ownerEpoch,
    };
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.unsubscribeApproval();
    this.unsubscribeApprovalResolved();
    this.unsubscribeShutdown();
    for (const preview of this.approvalPreviews.values()) {
      if (preview.approvalId) resolveToolApproval(preview.approvalId, "deny");
    }
    this.approvalPreviews.clear();
    const closing = [...this.terminals.values()].map((terminal) => {
      if (terminal.handle.child) {
        try { killCliTree(terminal.handle.child, 500); } catch { /* already exited */ }
        terminal.exited = true;
        return Promise.resolve();
      }
      if (terminal.exited) {
        terminal.handle.destroy();
        return Promise.resolve();
      }
      // node-pty's native exit callback is asynchronous. Keep Electron alive
      // until it arrives (or a bounded timeout elapses) so N-API cannot call
      // into a destroyed environment during app shutdown.
      return new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        terminal.handle.onExit(() => {
          if (timer) clearTimeout(timer);
          resolve();
        });
        timer = setTimeout(() => {
          terminal.exited = true;
          resolve();
        }, 750);
        timer.unref?.();
        terminal.handle.destroy();
      });
    });
    this.disposePromise = Promise.all(closing).then(() => {
      this.terminals.clear();
    });
    return this.disposePromise;
  }
}

export function createDesktopMobileTerminalControl(
  options: DesktopMobileTerminalControlOptions = {},
): DesktopMobileTerminalControl {
  return new DesktopMobileTerminalController(options);
}
