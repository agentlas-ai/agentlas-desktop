import type { ChildProcess } from "node:child_process";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { detachedSpawnOpts, envForCli, killCliTree, spawnCli, trackRunChild } from "../runtime/exec";

/** Only SDK-safe defaults and OS temp locations are inherited; configured
 * credentials/locations retain precedence. Capture this before MCP consent. */
export function ownedStdioEnvironment(command: string, configured: Record<string, string> = {}): Record<string, string> {
  const temporary: Record<string, string> = {};
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    const value = process.env[key];
    if (typeof value === "string") temporary[key] = value;
  }
  return envForCli(command, { ...getDefaultEnvironment(), ...temporary, ...configured }) as Record<string, string>;
}

interface OwnedStdioParameters {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stderr?: "overlapped" | "pipe" | "ignore" | "inherit";
  /** Prepared authority already captured the complete environment. */
  environmentResolved?: boolean;
  validatePrepared?: () => void;
}

/** SDK framing with host-owned process groups: npm/uv wrappers may leave
 * servers behind when only their immediate PID is terminated. */
export class OwnedStdioClientTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  private child: ChildProcess | null = null;
  private started = false;
  private closed = false;
  private closing: Promise<void> | null = null;
  private readonly buffer = new ReadBuffer();
  private resolveClosed: (() => void) | null = null;
  private readonly didClose = new Promise<void>((resolve) => { this.resolveClosed = resolve; });

  constructor(private readonly parameters: OwnedStdioParameters) {}

  get pid(): number | null { return this.child?.pid ?? null; }

  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error("Owned stdio transport already started or closed");
    this.parameters.validatePrepared?.();
    this.started = true;
    const child = this.child = spawnCli(this.parameters.command, this.parameters.args ?? [], {
      env: this.parameters.environmentResolved ? { ...this.parameters.env }
        : ownedStdioEnvironment(this.parameters.command, this.parameters.env),
      stdio: ["pipe", "pipe", this.parameters.stderr ?? "inherit"],
      cwd: this.parameters.cwd,
      windowsHide: true,
      ...detachedSpawnOpts(),
    });
    trackRunChild(child);
    child.once("close", () => this.finishClose());
    child.stdin?.on("error", (error) => this.onerror?.(error));
    child.stdout?.on("error", (error) => this.onerror?.(error));
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        let message: JSONRPCMessage | null;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        void this.close();
      }
    });
    return new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.on("error", (error) => { reject(error); this.onerror?.(error); });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || this.closing || !this.child?.stdin?.writable) {
      return Promise.reject(new Error("Owned stdio transport is not connected"));
    }
    return new Promise((resolve, reject) => {
      this.child!.stdin!.write(serializeMessage(message), (error) => error ? reject(error) : resolve());
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return Promise.resolve();
    this.closing = this.closeOwnedChild();
    return this.closing;
  }

  private async closeOwnedChild(): Promise<void> {
    const child = this.child;
    if (!child) { this.finishClose(); return; }
    // EOF gives cooperative servers a chance to flush before group termination.
    try { child.stdin?.end(); } catch { /* already closed */ }
    await this.waitForClose(2_000);
    if (!this.closed) {
      killCliTree(child, 2_000);
      await this.waitForClose(2_250);
    }
    // Bound transport shutdown even if an escaped descendant retained a pipe.
    child.stdout?.destroy();
    child.stderr?.destroy();
    this.finishClose();
  }

  private async waitForClose(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.didClose, new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private finishClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer.clear();
    this.resolveClosed?.();
    this.onclose?.();
  }
}
