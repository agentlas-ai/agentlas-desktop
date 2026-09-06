// Minimal ACP (Agent Client Protocol) v1 transport: JSON-RPC 2.0 over an agent
// subprocess' stdio, newline-delimited (PRD 2026-08-15 D-5).
//
// Deliberately dependency-free. The official @agentclientprotocol/sdk is
// ESM-only (awkward inside the CJS Electron main bundle) and would have to be
// vendored twice — here and into the terminal's desktop-core copy. ~150 lines
// of transport is cheaper than that, and the terminal loads this very file.
//
// Roles (the naming trips people up): WE are the *client* (editor/host side),
// the runtime CLI is the *agent* and runs as our child. The agent may call
// back into us (session/request_permission, fs/*, terminal/*) — those arrive
// as requests with an id and must be answered.
import type { ChildProcess } from "node:child_process";
import readline from "node:readline";

export const ACP_PROTOCOL_VERSION = 1;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(err: JsonRpcError) {
    super(err.message || `ACP error ${err.code}`);
    this.name = "AcpRpcError";
    this.code = err.code;
    this.data = err.data;
  }
}

export class AcpTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`ACP ${method} timed out after ${ms}ms`);
    this.name = "AcpTimeoutError";
  }
}

export interface AcpConnectionHandlers {
  /** session/update and other notifications (no id). */
  onNotification?: (method: string, params: any) => void;
  /** Agent → client requests. Return a result to answer; throw to answer with an error. */
  onRequest?: (method: string, params: any) => Promise<unknown> | unknown;
  /** Transport closed (agent exited or stdout ended). */
  onClose?: (code: number | null) => void;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
  method: string;
}

/** One JSON-RPC connection over a child's stdio. */
export class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private stderrTail = "";

  constructor(private readonly child: ChildProcess, private readonly handlers: AcpConnectionHandlers = {}) {
    if (!child.stdout || !child.stdin) throw new Error("ACP agent must be spawned with piped stdio");
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.onLine(line));
    child.stderr?.on("data", (buf: Buffer) => {
      this.stderrTail = (this.stderrTail + buf.toString("utf8")).slice(-4000);
    });
    const finish = (code: number | null) => {
      if (this.closed) return;
      this.closed = true;
      const err = new Error(`ACP agent closed (exit ${code ?? "?"})${this.stderrTail ? `: ${this.stderrTail.trim().slice(-300)}` : ""}`);
      for (const p of this.pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.handlers.onClose?.(code);
    };
    child.on("close", finish);
    child.on("error", () => finish(null));
    child.stdout.on("end", () => finish(child.exitCode));
  }

  get lastStderr(): string {
    return this.stderrTail;
  }

  private send(obj: unknown): void {
    if (this.closed) throw new Error("ACP connection closed");
    this.child.stdin!.write(JSON.stringify(obj) + "\n");
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // agents sometimes log to stdout; ignore non-JSON lines
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.id !== undefined && msg.method) {
      void this.answer(msg);
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new AcpRpcError(msg.error));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) this.handlers.onNotification?.(String(msg.method), msg.params ?? {});
  }

  private async answer(req: any): Promise<void> {
    const method = String(req.method);
    let reply: any = { jsonrpc: "2.0", id: req.id };
    try {
      if (!this.handlers.onRequest) throw new AcpRpcError({ code: -32601, message: `Method not found: ${method}` });
      const result = await this.handlers.onRequest(method, req.params ?? {});
      reply.result = result ?? {};
    } catch (err) {
      reply.error = err instanceof AcpRpcError
        ? { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) }
        : { code: -32603, message: err instanceof Error ? err.message : String(err) };
    }
    try {
      this.send(reply);
    } catch {
      /* connection gone */
    }
  }

  request(method: string, params: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject, method };
      if (opts?.timeoutMs && opts.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpTimeoutError(method, opts.timeoutMs!));
        }, opts.timeoutMs);
        pending.timer.unref?.();
      }
      if (opts?.signal) {
        const onAbort = () => {
          this.pending.delete(id);
          if (pending.timer) clearTimeout(pending.timer);
          reject(new Error("aborted"));
        };
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, pending);
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    try {
      this.send({ jsonrpc: "2.0", method, params });
    } catch {
      /* closed */
    }
  }

  close(): void {
    if (this.closed) return;
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
  }
}

/** Auth methods that need a secret env var to work — matched on the method id, not the vendor. */
const SECRET_AUTH_ENV: Array<{ match: RegExp; envVars: string[] }> = [
  { match: /api[-_]?key/i, envVars: ["CODEX_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY"] },
];

/**
 * `authMethods` is a menu, not a priority list (measured 2026-08-14: codex-acp
 * advertises [api-key, chat-gpt]; picking [0] fails when the user is logged in
 * via ChatGPT). Prefer methods that need no secret; take a secret-backed one
 * only when the secret is present. Never invent or ask for credentials.
 */
export function chooseAuthMethod(
  methods: Array<Record<string, any>>,
  env: NodeJS.ProcessEnv,
): Record<string, any> | undefined {
  const needsMissingSecret = (m: Record<string, any>): boolean => {
    const id = String(m?.id ?? "");
    for (const rule of SECRET_AUTH_ENV) {
      if (!rule.match.test(id)) continue;
      return !rule.envVars.some((name) => !!env[name]);
    }
    return false;
  };
  const usable = methods.filter((m) => m && !needsMissingSecret(m));
  if (usable.length > 0) return usable[0];
  return methods[0];
}

/**
 * Session modes from a session/new response. Two shapes are in the wild and both
 * are real: the spec's `modes: { currentModeId, availableModes }` and the
 * `configOptions[category=mode]` select (measured 2026-08-18: grok advertises
 * neither, gemini/cursor use one of the two). Parsing only — which mode a run
 * should pick is policy and lives in acp.ts.
 */
export function modeOptionsFromNewSession(response: any): Array<{ id: string; name: string; description?: string; current?: boolean }> {
  const rows: Array<{ id: string; name: string; description?: string; current?: boolean }> = [];
  const seen = new Set<string>();
  const push = (id: unknown, name: unknown, description: unknown, current: boolean) => {
    const mid = String(id ?? "").trim();
    if (!mid || seen.has(mid)) return;
    seen.add(mid);
    rows.push({ id: mid, name: String(name ?? mid), ...(description ? { description: String(description) } : {}), ...(current ? { current: true } : {}) });
  };
  const modes = response?.modes;
  if (modes && Array.isArray(modes.availableModes)) {
    for (const mode of modes.availableModes) if (mode) push(mode.id, mode.name, mode.description, mode.id === modes.currentModeId);
  }
  const options: any[] = Array.isArray(response?.configOptions) ? response.configOptions : [];
  const picked = options.find((o) => o && o.category === "mode") ?? options.find((o) => o && o.id === "mode");
  if (picked && Array.isArray(picked.options)) {
    for (const choice of picked.options) if (choice) push(choice.value, choice.name, choice.description, choice.value === picked.currentValue);
  }
  return rows;
}

/** What the agent said it can do with MCP beyond the always-available stdio transport. */
export interface AcpMcpCapabilities {
  http?: boolean;
  sse?: boolean;
}

/** One translated `session/new` mcpServers row plus what we could not translate. */
export interface AcpMcpTranslation {
  servers: Array<Record<string, unknown>>;
  /** Server names dropped because the agent does not speak that transport. */
  unsupported: Array<{ name: string; transport: "http" | "sse" }>;
  /** Server names dropped because the entry had neither a command nor a url. */
  malformed: string[];
}

/**
 * Our MCP config (`{ mcpServers: { name: {command,args,env} | {url,headers} } }`,
 * the same file Claude Code takes as `--mcp-config`) → ACP's session/new
 * `mcpServers` parameter.
 *
 * ACP models env vars and headers as `[{ name, value }]` arrays, not objects,
 * and gates http/sse behind `agentCapabilities.mcpCapabilities`. stdio needs no
 * capability flag — it is the protocol's baseline transport.
 */
export function acpMcpServersFromConfig(
  config: unknown,
  capabilities?: AcpMcpCapabilities | null,
): AcpMcpTranslation {
  const out: AcpMcpTranslation = { servers: [], unsupported: [], malformed: [] };
  const servers = (config as any)?.mcpServers;
  if (!servers || typeof servers !== "object") return out;
  const pairs = (value: unknown): Array<{ name: string; value: string }> =>
    value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).map(([name, v]) => ({ name, value: String(v ?? "") }))
      : [];
  for (const [name, raw] of Object.entries(servers as Record<string, any>)) {
    if (!raw || typeof raw !== "object") { out.malformed.push(name); continue; }
    const command = typeof raw.command === "string" ? raw.command.trim() : "";
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (command) {
      out.servers.push({
        name,
        command,
        args: Array.isArray(raw.args) ? raw.args.map(String) : [],
        env: pairs(raw.env),
      });
      continue;
    }
    if (url) {
      const declared = String(raw.type ?? raw.transport ?? "").toLowerCase();
      const transport: "http" | "sse" = declared === "sse" || (!declared && !/^https?:\/\//i.test(url)) ? "sse" : "http";
      if (!capabilities?.[transport]) { out.unsupported.push({ name, transport }); continue; }
      out.servers.push({ type: transport, name, url, headers: pairs(raw.headers) });
      continue;
    }
    out.malformed.push(name);
  }
  return out;
}

/**
 * ACP select options are either a flat option list or a list of documented
 * `{ group, name, options }` groups. Treat mixed and merely nested lookalikes
 * as malformed instead of guessing a provider-specific shape.
 */
function sessionConfigSelectOptionEntries(options: unknown): any[] {
  if (!Array.isArray(options)) return [];
  const isOption = (value: unknown): value is { value: string } =>
    Boolean(value)
    && typeof value === "object"
    && typeof (value as { value?: unknown }).value === "string"
    && Boolean((value as { value: string }).value.trim());
  if (options.every(isOption)) return options;

  const isGroup = (value: unknown): value is { group: string; name: string; options: Array<{ value: string }> } => {
    if (!value || typeof value !== "object") return false;
    const group = value as { group?: unknown; name?: unknown; options?: unknown };
    return typeof group.group === "string"
      && typeof group.name === "string"
      && Array.isArray(group.options) && group.options.every(isOption);
  };
  if (!options.every(isGroup)) return [];
  return options.flatMap((group) => group.options);
}

/**
 * A model selector the ACP agent explicitly advertised through session/new or
 * session/load. `configId` is agent-owned: clients must send it back verbatim
 * to session/set_config_option instead of guessing that every selector is
 * named "model".
 */
export interface AcpModelConfigOption {
  configId: string;
  currentValue: string | null;
  values: string[];
}

/**
 * ACP v1's preferred model-selection contract. Categories are optional in the
 * protocol, so preserve the established exact `id: "model"` fallback after a
 * semantic category match. An acknowledgement is located by the exact config
 * id originally selected: agents need not repeat category or option order.
 */
export function modelConfigOptionFromSession(response: any, expectedConfigId?: string): AcpModelConfigOption | null {
  const options: any[] = Array.isArray(response?.configOptions) ? response.configOptions : [];
  const picked = expectedConfigId !== undefined
    ? options.find((option) => option && option.id === expectedConfigId)
    : options.find((option) => option && option.category === "model")
      ?? options.find((option) => option && option.id === "model");
  const configId = typeof picked?.id === "string" && picked.id.trim() ? picked.id : "";
  if (!configId) return null;
  const values: string[] = [...new Set<string>(sessionConfigSelectOptionEntries(picked?.options)
    .map((choice: any): string => typeof choice?.value === "string" ? choice.value : "")
    .filter((value: string) => Boolean(value.trim())))];
  if (values.length === 0) return null;
  const currentValue = typeof picked.currentValue === "string" && picked.currentValue.trim()
    ? picked.currentValue
    : null;
  return { configId, currentValue, values };
}

/**
 * Older agents sometimes expose the pre-configOptions vendor model envelope.
 * It has no config id or acknowledgement contract, so callers may use only
 * the legacy session/set_model method when this exact envelope is present.
 */
export interface AcpLegacyModelSelection {
  currentModelId: string | null;
  modelIds: string[];
}

export function legacyModelSelectionFromSession(response: any): AcpLegacyModelSelection | null {
  const models = response?.models;
  if (!models || !Array.isArray(models.availableModels)) return null;
  const modelIds: string[] = [...new Set<string>(models.availableModels
    .map((choice: any): string => typeof (choice?.modelId ?? choice?.id) === "string"
      ? String(choice.modelId ?? choice.id)
      : "")
    .filter((value: string) => Boolean(value.trim())))];
  if (modelIds.length === 0) return null;
  const currentModelId = typeof models.currentModelId === "string" && models.currentModelId.trim()
    ? models.currentModelId
    : null;
  return { currentModelId, modelIds };
}

/** Model options from a session/new response — configOptions[category=model] first, vendor models[] second. */
export function modelOptionsFromNewSession(response: any): Array<{ id: string; name: string; description?: string; current?: boolean }> {
  const rows: Array<{ id: string; name: string; description?: string; current?: boolean }> = [];
  const seen = new Set<string>();
  const push = (id: unknown, name: unknown, description: unknown, current: boolean) => {
    const mid = String(id ?? "").trim();
    if (!mid || seen.has(mid)) return;
    seen.add(mid);
    rows.push({ id: mid, name: String(name ?? mid), ...(description ? { description: String(description) } : {}), ...(current ? { current: true } : {}) });
  };
  const options: any[] = Array.isArray(response?.configOptions) ? response.configOptions : [];
  const picked = options.find((o) => o && o.category === "model") ?? options.find((o) => o && o.id === "model");
  if (picked) {
    for (const choice of sessionConfigSelectOptionEntries(picked.options)) {
      push(choice.value, choice.name, choice.description, choice.value === picked.currentValue);
    }
  }
  const vendor = response?.models;
  if (vendor && Array.isArray(vendor.availableModels)) {
    for (const choice of vendor.availableModels) if (choice) push(choice.modelId ?? choice.id, choice.name, choice.description, (choice.modelId ?? choice.id) === vendor.currentModelId);
  }
  return rows;
}
