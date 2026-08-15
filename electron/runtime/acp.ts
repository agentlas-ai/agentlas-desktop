// Generic ACP runner — one client for every runtime that speaks the Agent Client
// Protocol (PRD 2026-08-15 D-5). Replaces the weak hand-coded drivers of the
// "B" grade runtimes (cursor: no tool display; grok: tool kind guessed from
// `type` strings; kimi: absent from the terminal). Claude Code and Codex stay
// on their native stream drivers on purpose: ACP's usage_update is context
// occupancy, not input/output tokens, and their adapters add a process hop.
//
// What every ACP agent gives us identically:
//   agent_message_chunk → onPartial     agent_thought_chunk → onThinking
//   plan                → onStatus      tool_call(_update)  → onTool (fixed vocabulary)
//   stopReason          → RunnerResult.failure (marker, never a text guess)
//
// Boundaries (PRD 2026-08-13 §8 round 2, coverage plan §1.3): the initialize
// self-report is a tool surface, not a trust surface; session/request_permission
// is not the approval chokepoint (claude-agent-acp runs bypassPermissions and
// never asks) — read-only runs still refuse mutating tools when asked, but the
// real gate lives elsewhere.
import type { ChildProcess } from "node:child_process";
import { AcpConnection, ACP_PROTOCOL_VERSION, AcpRpcError, chooseAuthMethod, modelOptionsFromNewSession } from "./acp-protocol";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { wrapSystemPrompt } from "./runner";
import { agentRunCwd, detachedSpawnOpts, killCliTree, spawnCli, trackRunChild } from "./exec";
import { pickLocale, tStatus } from "./status-i18n";
import { abortReasonError } from "./abort-reason";
import { classifyDiscovery, type DiscoveryOutcome } from "../../shared/model-discovery";

/** How to spawn an ACP agent. Adding a runtime = one row (mirrors contracts/runtime-registry.json). */
export interface AcpAgentSpec {
  id: string;
  label: string;
  /** Executable; the detected absolute path (RuntimeStatus.source) replaces it at run time. */
  command: string;
  args: string[];
  /** Registry id in agentclientprotocol/registry, for drift monitoring. */
  registryId?: string;
}

export const ACP_AGENTS: Record<string, AcpAgentSpec> = {
  cursor: { id: "cursor", label: "Cursor Agent (ACP)", command: "cursor-agent", args: ["acp"], registryId: "cursor" },
  grok: { id: "grok", label: "Grok Build (ACP)", command: "grok", args: ["agent", "stdio"], registryId: "grok-build" },
  kimi: { id: "kimi", label: "Kimi CLI (ACP)", command: "kimi", args: ["acp"], registryId: "kimi" },
  // Reference rows for the C group — not dispatched by pickRunner yet (backlog:
  // TerminalProfile ACP mode); kept here so the discovery probe can use them.
  opencode: { id: "opencode", label: "OpenCode (ACP)", command: "opencode", args: ["acp"], registryId: "opencode" },
  goose: { id: "goose", label: "Goose (ACP)", command: "goose", args: ["acp"], registryId: "goose" },
  "github-copilot-cli": { id: "github-copilot-cli", label: "GitHub Copilot CLI (ACP)", command: "npx", args: ["-y", "@github/copilot@1.0.80", "--acp"], registryId: "github-copilot-cli" },
};

/** Runtimes whose pickRunner path prefers ACP over the legacy hand driver. */
export const ACP_PREFERRED_KINDS = new Set(["cursor", "grok", "kimi"]);

/** `AGENTLAS_DISABLE_ACP=1` (or `=cursor,grok`) restores the legacy drivers. */
export function acpDisabledFor(kind: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.AGENTLAS_DISABLE_ACP ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (raw === "1" || raw === "true" || raw === "all") return true;
  return raw.split(/[,\s]+/).includes(kind);
}

/** ACP tool-call kinds → label. Fixed by the protocol; identical across agents. */
const TOOL_KIND_LABEL: Record<string, string> = {
  read: "read", edit: "edit", delete: "delete", move: "move", search: "search",
  execute: "execute", think: "think", fetch: "fetch", other: "tool",
};
export function normalizeToolKind(kind: unknown): string {
  const k = String(kind ?? "other").toLowerCase();
  return TOOL_KIND_LABEL[k] ? k : "other";
}

interface ToolState { title?: string; kind?: string; status?: string; reported?: boolean }

/**
 * Live approval hook (tool-approval contract, v1.0.16). ACP is the only path
 * where the runtime asks BEFORE executing, so a real user decision can be
 * attached here. The arbiter is injected (not imported) so this file stays
 * standalone; electron/runtime/tool-approval.ts registers itself via
 * setAcpPermissionArbiter(...). Without an arbiter the conservative default
 * below applies (never a silent allow of a mutating tool on a read run).
 */
export interface AcpPermissionAsk {
  runtime: string;
  sessionKey: string;
  tool: string;
  kind: string;
  detail?: string;
  cwd?: string;
  permission: RunnerRequest["permission"];
  mutating: boolean;
}
export type AcpPermissionDecision = "allow_once" | "allow_session" | "deny";
export type AcpPermissionArbiter = (ask: AcpPermissionAsk) => Promise<AcpPermissionDecision>;
let permissionArbiter: AcpPermissionArbiter | null = null;
export function setAcpPermissionArbiter(arbiter: AcpPermissionArbiter | null): void {
  permissionArbiter = arbiter;
}

/** Client-side handling of one session's stream. */
class AcpSessionClient {
  text = "";
  contextUsed?: number;
  contextSize?: number;
  private readonly tools = new Map<string, ToolState>();
  private thinking = false;
  private thinkingStartedAt = 0;

  constructor(
    private readonly events: RunnerEvents,
    private readonly permission: RunnerRequest["permission"],
    private readonly locale: "ko" | "en",
    private readonly approval: { runtime: string; sessionKey: string; cwd?: string } = { runtime: "acp", sessionKey: "acp" },
  ) {}

  onUpdate(params: any): void {
    const update = params?.update ?? params;
    switch (update?.sessionUpdate) {
      case "agent_message_chunk": {
        const chunk = textOf(update.content);
        if (chunk) {
          this.endThinking();
          this.text += chunk;
          this.events.onPartial(this.text);
        }
        break;
      }
      case "agent_thought_chunk": {
        if (!this.thinking) {
          this.thinking = true;
          this.thinkingStartedAt = Date.now();
          this.events.onThinking?.("start");
        }
        break;
      }
      case "plan": {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        if (entries.length) this.events.onStatus(this.locale === "ko" ? `계획 ${entries.length}단계` : `Plan · ${entries.length} steps`);
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        this.endThinking();
        this.handleToolCall(update);
        break;
      }
      case "usage_update": {
        // Context occupancy, NOT tokens. Never forwarded as onUsage (it would lie).
        const used = numberOf(update.used);
        const size = numberOf(update.size);
        if (used !== undefined && size !== undefined) { this.contextUsed = used; this.contextSize = size; }
        break;
      }
      default:
        break;
    }
  }

  private handleToolCall(update: any): void {
    const id = String(update.toolCallId ?? update.tool_call_id ?? "");
    if (!id) return;
    const prev = this.tools.get(id) ?? {};
    const merged: ToolState = {
      title: update.title ?? prev.title,
      kind: update.kind ?? prev.kind,
      status: update.status ?? prev.status,
      reported: prev.reported,
    };
    this.tools.set(id, merged);
    const done = merged.status === "completed" || merged.status === "failed";
    if (!done || merged.reported) return;
    merged.reported = true;
    const kind = normalizeToolKind(merged.kind);
    const label = TOOL_KIND_LABEL[kind];
    this.events.onTool?.(merged.title ? `${label}: ${merged.title}` : label, undefined, undefined, id, merged.status === "failed");
  }

  /**
   * session/request_permission. With a registered arbiter (tool-approval
   * contract) the USER decides live — including read runs, where asking beats
   * a silent refusal. Without one: conservative default (read+mutating →
   * reject, else allow). Either way this is not the trust boundary — agents may
   * run with bypassPermissions and never ask.
   */
  async answerPermission(params: any): Promise<any> {
    const options: any[] = Array.isArray(params?.options) ? params.options : [];
    const readOnly = this.permission === "read" || this.permission === undefined;
    const kind = normalizeToolKind(params?.toolCall?.kind);
    const mutating = !["read", "search", "fetch", "think"].includes(kind);
    const find = (...kinds: string[]) => options.find((o) => kinds.includes(String(o?.kind)));
    const rejectOption = () => find("reject_once", "reject_always") ?? options.find((o) => /reject|deny/i.test(String(o?.optionId)));
    const allowOption = (session: boolean) =>
      (session ? find("allow_always", "allow_once") : find("allow_once", "allow_always")) ?? options.find((o) => /allow/i.test(String(o?.optionId)));
    const selected = (option: any) => (option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } });

    if (permissionArbiter) {
      let decision: AcpPermissionDecision = "deny";
      try {
        decision = await permissionArbiter({
          runtime: this.approval.runtime,
          sessionKey: this.approval.sessionKey,
          tool: String(params?.toolCall?.title ?? kind),
          kind,
          detail: typeof params?.toolCall?.rawInput === "string" ? params.toolCall.rawInput : undefined,
          cwd: this.approval.cwd,
          permission: this.permission,
          mutating,
        });
      } catch {
        decision = "deny"; // an arbiter failure must never turn into an allow
      }
      if (decision === "deny") return selected(rejectOption());
      return selected(allowOption(decision === "allow_session"));
    }
    if (readOnly && mutating) return selected(rejectOption());
    return selected(allowOption(false));
  }

  private endThinking(): void {
    if (!this.thinking) return;
    this.thinking = false;
    this.events.onThinking?.("end", Date.now() - this.thinkingStartedAt);
  }

  finish(): void { this.endThinking(); }
}

function textOf(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).join("");
  const c = content as Record<string, any>;
  return typeof c.text === "string" ? c.text : "";
}
function numberOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

interface Session {
  child: ChildProcess;
  conn: AcpConnection;
  init: any;
}

async function openAcp(
  spec: AcpAgentSpec,
  opts: { command?: string; cwd: string; env: NodeJS.ProcessEnv; handlers: { onNotification?: (m: string, p: any) => void; onRequest?: (m: string, p: any) => any } ; timeoutMs: number },
): Promise<Session> {
  const child = spawnCli(opts.command ?? spec.command, spec.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: opts.cwd,
    env: opts.env,
    ...detachedSpawnOpts(),
  });
  trackRunChild(child);
  const conn = new AcpConnection(child, opts.handlers);
  const init = await conn.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "agentlas-desktop", version: "1.0" },
  }, { timeoutMs: opts.timeoutMs });
  if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
    killCliTree(child);
    throw new Error(`ACP protocolVersion ${String(init?.protocolVersion)} unsupported (client speaks v${ACP_PROTOCOL_VERSION} only)`);
  }
  const authMethods: any[] = Array.isArray(init?.authMethods) ? init.authMethods : [];
  if (authMethods.length > 0) {
    const chosen = chooseAuthMethod(authMethods, opts.env);
    if (chosen?.id) {
      try {
        await conn.request("authenticate", { methodId: chosen.id }, { timeoutMs: opts.timeoutMs });
      } catch {
        // Already-logged-in runtimes may reject authenticate yet accept
        // session/new; if not, session/new fails loudly right after.
      }
    }
  }
  return { child, conn, init };
}

/**
 * Model discovery through ACP: session/new configOptions[category=model].
 * Zero text parsing. Used by detect for kinds that speak ACP.
 */
export async function probeAcpModels(
  spec: AcpAgentSpec,
  opts?: { command?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<DiscoveryOutcome & { init?: any }> {
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  let session: Session | null = null;
  try {
    session = await openAcp(spec, { command: opts?.command, cwd: opts?.cwd ?? agentRunCwd(), env: opts?.env ?? process.env, handlers: {}, timeoutMs });
    const created = await session.conn.request("session/new", { cwd: opts?.cwd ?? agentRunCwd(), mcpServers: [] }, { timeoutMs });
    const rows = modelOptionsFromNewSession(created);
    const outcome = classifyDiscovery({ stdout: rows.length ? rows.map((r) => r.id).join("\n") : "", models: rows.map((r) => r.id), source: "acp" });
    if (rows.length === 0) outcome.reason = "acp:no-model-config-option";
    return { ...outcome, init: session.init };
  } catch (err) {
    return { status: "failed", models: [], rawLineCount: 0, reason: `acp:${err instanceof Error ? err.message : String(err)}`, source: "acp" };
  } finally {
    if (session) {
      try { session.conn.close(); } catch { /* ignore */ }
      try { killCliTree(session.child, 500); } catch { /* ignore */ }
    }
  }
}

const acpProbeCache = new Map<string, { at: number; outcome: DiscoveryOutcome & { init?: any } }>();
export const ACP_PROBE_TTL_MS = 10 * 60 * 1000;

/**
 * Cached ACP discovery for detect(): spawning a full agent per 10s detect tick
 * would be far too heavy, so one probe per (spec, command) is reused for 10
 * minutes; a failed probe is retried after 1 minute.
 */
export async function probeAcpModelsCached(
  spec: AcpAgentSpec,
  opts?: { command?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; now?: number },
): Promise<DiscoveryOutcome & { init?: any }> {
  const key = `${spec.id}\u0000${opts?.command ?? spec.command}`;
  const now = opts?.now ?? Date.now();
  const hit = acpProbeCache.get(key);
  if (hit) {
    const ttl = hit.outcome.status === "ok" ? ACP_PROBE_TTL_MS : 60_000;
    if (now - hit.at < ttl) return hit.outcome;
  }
  const outcome = await probeAcpModels(spec, opts);
  acpProbeCache.set(key, { at: now, outcome });
  return outcome;
}

/** Test hook. */
export function resetAcpProbeCacheForTests(): void {
  acpProbeCache.clear();
}

/** Runner factory — one Runner per ACP agent spec. */
export function createAcpRunner(spec: AcpAgentSpec): Runner {
  return async (req: RunnerRequest, events: RunnerEvents): Promise<RunnerResult> => {
    const locale = pickLocale(req);
    events.onStatus(tStatus(locale, "callingBackend", { backend: req.backendLabel || spec.label }));
    const cwd = req.cwd ?? agentRunCwd();
    const client = new AcpSessionClient(events, req.permission, locale, {
      runtime: spec.id,
      sessionKey: `${spec.id}:${req.sessionFingerprintSeed ?? req.cwd ?? "default"}`,
      cwd,
    });
    let session: Session | null = null;
    const onAbort = () => { if (session) killCliTree(session.child); };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      session = await openAcp(spec, {
        command: req.runtimeSource,
        cwd,
        env: req.env ?? process.env,
        timeoutMs: 60_000,
        handlers: {
          onNotification: (method, params) => { if (method === "session/update") client.onUpdate(params); },
          onRequest: async (method, params) => {
            if (method === "session/request_permission") return client.answerPermission(params);
            throw new AcpRpcError({ code: -32601, message: `Method not found: ${method}` });
          },
        },
      });
      const created = await session.conn.request("session/new", { cwd, mcpServers: [] }, { timeoutMs: 60_000, signal: req.signal });
      const sessionId = String(created?.sessionId ?? "");
      if (!sessionId) throw new Error("ACP session/new returned no sessionId");
      if (req.model) {
        // Best effort: not every agent implements session/set_model.
        try { await session.conn.request("session/set_model", { sessionId, modelId: req.model }, { timeoutMs: 10_000 }); } catch { /* optional */ }
      }
      const systemPrompt = wrapSystemPrompt(req.systemPrompt, locale, req.permission, req.userPrompt);
      const promptText = [systemPrompt, req.turnContext, req.userPrompt].filter(Boolean).join("\n\n");
      const result = await session.conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: promptText }] }, { signal: req.signal });
      client.finish();
      if (req.signal?.aborted) throw abortReasonError(req);
      const stopReason = String(result?.stopReason ?? "");
      const text = client.text.trim();
      if (stopReason === "refusal") {
        return { text, failure: { kind: "refused", message: "ACP stopReason=refusal", runtime: spec.id, source: "marker" }, sessionId };
      }
      if (stopReason === "cancelled") throw abortReasonError(req);
      if (!text) {
        return { text: "", failure: { kind: "empty", message: session.conn.lastStderr.slice(-500) || `ACP stopReason=${stopReason || "unknown"}`, runtime: spec.id, source: "marker" }, sessionId };
      }
      if (client.contextUsed !== undefined && client.contextSize) {
        const pct = Math.round((client.contextUsed / client.contextSize) * 100);
        events.onStatus(locale === "ko" ? `컨텍스트 ${pct}% 사용` : `Context ${pct}% used`);
      }
      // observedUsage intentionally absent: ACP v1 gives context occupancy, not tokens.
      return { text, sessionId };
    } catch (err) {
      if (req.signal?.aborted) throw abortReasonError(req);
      const message = err instanceof Error ? err.message : String(err);
      if (/auth_required|not authenticated|login/i.test(message)) {
        return { text: "", failure: { kind: "auth", message, runtime: spec.id, source: "marker" } };
      }
      throw err;
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      if (session) {
        try { session.conn.close(); } catch { /* ignore */ }
        try { killCliTree(session.child); } catch { /* ignore */ }
      }
    }
  };
}

/**
 * Prefer the ACP runner for a kind; fall back to the legacy driver when ACP is
 * disabled by env. The decision is per call so a setting change needs no restart.
 */
export function acpOrLegacyRunner(kind: string, legacy: Runner): Runner {
  const spec = ACP_AGENTS[kind];
  if (!spec) return legacy;
  const acp = createAcpRunner(spec);
  return (req, events) => (acpDisabledFor(kind) ? legacy(req, events) : acp(req, events));
}
