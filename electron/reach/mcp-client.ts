import { spawn, type ChildProcess } from "node:child_process";

// A small MCP client over a child process's stdin/stdout (line-delimited JSON-RPC). It talks to the Cua Driver MCP proxy, which
// forwards to the host-owned daemon. Bounded on every side: message size, request deadline, abort, and the child dying.

export interface McpToolResult {
  isError: boolean;
  text: string;
  structured?: Record<string, unknown>;
  imageCount: number;
}

export class McpClientError extends Error {
  constructor(public readonly code: "mcp_closed" | "mcp_timeout" | "mcp_aborted" | "mcp_protocol" | "mcp_spawn_failed", message: string) {
    super(message);
    this.name = "McpClientError";
  }
}

export interface McpSpawn {
  (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }): ChildProcess;
}

const MAX_LINE_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export const defaultMcpSpawn: McpSpawn = (command, args, options) =>
  spawn(command, [...args], { env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: McpClientError) => void;
  timer: NodeJS.Timeout;
  detach: () => void;
}

export class StdioMcpClient {
  private child: ChildProcess | null = null;
  private buffer = "";
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  public stderrTail = "";

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly env: NodeJS.ProcessEnv,
    private readonly spawnFn: McpSpawn = defaultMcpSpawn,
  ) {}

  async start(clientName = "agentlas-reach", version = "1"): Promise<{ serverName?: string; serverVersion?: string }> {
    let child: ChildProcess;
    try {
      child = this.spawnFn(this.command, this.args, { env: this.env });
    } catch (error) {
      throw new McpClientError("mcp_spawn_failed", error instanceof Error ? error.message : "spawn failed");
    }
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-2000); });
    child.on("error", () => this.fail(new McpClientError("mcp_spawn_failed", "the MCP process could not start")));
    child.on("close", () => this.fail(new McpClientError("mcp_closed", "the MCP process ended")));
    const init = (await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: clientName, version },
    }, { timeoutMs: 20_000 })) as { serverInfo?: { name?: string; version?: string } };
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    return { serverName: init?.serverInfo?.name, serverVersion: init?.serverInfo?.version };
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed || !this.child?.stdin?.writable) throw new McpClientError("mcp_closed", "the MCP process is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes("\n")) {
      this.fail(new McpClientError("mcp_protocol", "a message exceeded the size ceiling"));
      return;
    }
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.detach();
      if (message.error) pending.reject(new McpClientError("mcp_protocol", message.error.message ?? "MCP error"));
      else pending.resolve(message.result);
    }
  }

  private fail(error: McpClientError): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.detach();
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  request(method: string, params: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new McpClientError("mcp_closed", "the MCP process is not running")); return; }
      if (options.signal?.aborted) { reject(new McpClientError("mcp_aborted", "aborted")); return; }
      const id = ++this.nextId;
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(new McpClientError("mcp_aborted", "aborted"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.detach();
        reject(new McpClientError("mcp_timeout", `${method} did not answer within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`));
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, detach: () => options.signal?.removeEventListener("abort", onAbort) });
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(error instanceof McpClientError ? error : new McpClientError("mcp_closed", "write failed"));
      }
    });
  }

  async callTool(name: string, args: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<McpToolResult> {
    const raw = (await this.request("tools/call", { name, arguments: args }, options)) as {
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
    };
    const content = Array.isArray(raw?.content) ? raw.content : [];
    return {
      isError: raw?.isError === true,
      text: content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n"),
      ...(raw?.structuredContent && typeof raw.structuredContent === "object" ? { structured: raw.structuredContent } : {}),
      imageCount: content.filter((item) => item.type === "image").length,
    };
  }

  get running(): boolean { return !this.closed; }

  async close(): Promise<void> {
    this.fail(new McpClientError("mcp_closed", "closed"));
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) return;
    try { child.stdin?.end(); } catch { /* already closed */ }
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 1500);
      child.once("close", () => { clearTimeout(kill); resolve(); });
      try { child.kill("SIGTERM"); } catch { clearTimeout(kill); resolve(); }
    });
  }
}
