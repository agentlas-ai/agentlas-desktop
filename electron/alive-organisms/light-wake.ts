/**
 * Lightweight controller wake for One/Work lives — decision only.
 *
 * The first cut ran each wake as a full Work invocation (hidden ⟦alive⟧ chat → invocationService → client.ts),
 * which carried the CLI's project conventions, CLAUDE.md/memory, MCP servers and tool schemas: 59–72k tokens
 * per wake and 3 tool calls in a read-only review (isolated live run 2026-09-24). A controller decides from the
 * host observation alone, so this calls the selected runtime's runner directly on the judgment no-tools path
 * (the same one resident judgment uses): `untrustedNoTools + judgmentOnly` — claude gets --safe-mode,
 * --strict-mcp-config, --tools "", --system-prompt-file (replacing, not appending), no session persistence;
 * codex/others their equivalent no-tools boundary — plus a strict output schema and an output ceiling.
 *
 * Durable ledger (alive_light_wakes, Main single writer) replaces the invocation receipt:
 *  - the row is written with attempt_started=1 BEFORE the provider call (invariant c: a started attempt without
 *    usage is unknown; a wake refused before this row charges 0);
 *  - a row still 'running' that belongs to an earlier process lifetime is host-lost → interrupted, usage unknown
 *    (a provider call may have been billed); a reserved wake with no row at all → interrupted, 0.
 */
import type Database from "better-sqlite3";
import type { RuntimeSelection, RuntimeStatus } from "../../shared/types";
import type { Runner, RunnerFailure } from "../runtime/runner";

export interface LightWakeRow {
  wakeId: string; agentId: string; status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  inputTokens: number | null; outputTokens: number | null; toolCalls: number; finalText: string | null;
  errorCode: string | null; processStartedAtMs: number; createdAtMs: number; settledAtMs: number | null;
}

export interface LightWakeDeps {
  db: Database.Database;
  processStartedAtMs: number;
  pickRunner(status: RuntimeStatus): { runner: Runner; label: string } | null;
  noteFailure(status: RuntimeStatus, failure: RunnerFailure): void;
  now(): number;
  timeoutMs?: number;
}

/** Provider refusals that arrive before any generation: the charge is a known 0. */
const PRE_GENERATION_FAILURES = new Set(["quota", "auth", "unsupported"]);

export function ensureLightWakeSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS alive_light_wakes (
    wake_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','interrupted')),
    attempt_started INTEGER NOT NULL DEFAULT 1, input_tokens INTEGER, output_tokens INTEGER,
    tool_calls INTEGER NOT NULL DEFAULT 0, final_text TEXT, error_code TEXT,
    process_started_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER)`);
  const columns = (db.prepare("PRAGMA table_info(alive_light_wakes)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!columns.includes("tool_names_json")) db.exec("ALTER TABLE alive_light_wakes ADD COLUMN tool_names_json TEXT");
}

/**
 * Claude implements --json-schema as its own synthetic "StructuredOutput" tool: that is the answer channel, not a
 * tool the controller used. Every other tool id counts; the no-tools boundary means it should always be 0.
 */
const ANSWER_CHANNEL_TOOLS = new Set(["StructuredOutput"]);

export class LightWakeRunner {
  private readonly active = new Map<string, AbortController>();
  private readonly listeners = new Set<(row: LightWakeRow) => void>();
  private readonly toolFacts = new Map<string, { count: () => number; names: () => string[] }>();
  constructor(private readonly deps: LightWakeDeps) { ensureLightWakeSchema(deps.db); }

  isActive(wakeId: string): boolean { return this.active.has(wakeId); }

  onSettled(listener: (row: LightWakeRow) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  row(wakeId: string): LightWakeRow | null {
    const r = this.deps.db.prepare("SELECT * FROM alive_light_wakes WHERE wake_id=?").get(wakeId) as Record<string, any> | undefined;
    return r ? { wakeId: r.wake_id, agentId: r.agent_id, status: r.status, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
      toolCalls: r.tool_calls, finalText: r.final_text, errorCode: r.error_code, processStartedAtMs: r.process_started_at_ms,
      createdAtMs: r.created_at_ms, settledAtMs: r.settled_at_ms } : null;
  }

  cancel(wakeId: string): void { this.active.get(wakeId)?.abort(new Error("alive-wake-cancelled")); }

  /** Abort every in-flight wake (app quit). Rows stay 'running' only if the process dies before settling. */
  cancelAll(): void { for (const controller of this.active.values()) controller.abort(new Error("alive-wake-shutdown")); }

  /** Durable row, then the provider call; resolves nothing to the caller — settlement arrives via onSettled. */
  start(input: { wakeId: string; agentId: string; status: RuntimeStatus; selection: RuntimeSelection;
    systemPrompt: string; userPrompt: string; schema: Record<string, unknown> }): { accepted: boolean; reasonCode?: string } {
    const picked = this.deps.pickRunner(input.status);
    if (!picked) return { accepted: false, reasonCode: "alive-runner-unavailable" }; // before the row: a known 0
    this.deps.db.prepare(`INSERT INTO alive_light_wakes(wake_id,agent_id,status,attempt_started,process_started_at_ms,created_at_ms)
      VALUES (?,?,'running',1,?,?)`).run(input.wakeId, input.agentId, this.deps.processStartedAtMs, this.deps.now());
    const controller = new AbortController();
    this.active.set(input.wakeId, controller);
    const timer = setTimeout(() => controller.abort(new Error("alive-wake-timeout")), this.deps.timeoutMs ?? 180_000);
    timer.unref?.();
    const toolIds = new Map<string, string>();
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    void Promise.resolve().then(() => picked.runner({
      systemPrompt: input.systemPrompt, history: [], userPrompt: input.userPrompt, backendLabel: picked.label,
      runtimeSource: input.status.source, model: input.selection.model, effort: "low",
      longContext: false, permission: "read", untrustedNoTools: true, judgmentOnly: true, surfaceGate: "exclude",
      maxOutputTokens: 600, outputSchema: { name: "agentlas_alive_goal_decision_v2", schema: input.schema },
      signal: controller.signal, locale: "en",
    }, {
      onPartial: () => {}, onStatus: () => {},
      onTool: (name, _args, _result, id) => { toolIds.set(id ?? `${name}:${toolIds.size}`, String(name).slice(0, 80)); },
      onTerminalObservedUsage: (observed) => { usage = observed; },
    })).then((result) => {
      const observed = result.observedUsage ?? usage;
      if (result.failure) {
        this.deps.noteFailure(input.status, result.failure);
        const known = observed ?? (PRE_GENERATION_FAILURES.has(result.failure.kind) ? { inputTokens: 0, outputTokens: 0 } : null);
        this.settle(input.wakeId, "failed", known, null, `runtime-${result.failure.kind}`);
      } else {
        this.settle(input.wakeId, "completed", observed, result.text ?? "", null);
      }
    }, (error: unknown) => {
      const reason = controller.signal.aborted ? String((controller.signal.reason as Error)?.message ?? "") : "";
      const cancelled = reason === "alive-wake-cancelled" || reason === "alive-wake-shutdown";
      this.settle(input.wakeId, cancelled ? "cancelled" : "failed", usage, null,
        reason === "alive-wake-timeout" ? "alive-wake-timeout" : cancelled ? reason : "alive-runner-threw");
      void error;
    }).finally(() => { clearTimeout(timer); this.active.delete(input.wakeId); });
    const toolCallsOf = () => [...toolIds.values()].filter((name) => !ANSWER_CHANNEL_TOOLS.has(name)).length;
    const toolNames = () => [...new Set(toolIds.values())];
    this.toolFacts.set(input.wakeId, { count: toolCallsOf, names: toolNames });
    return { accepted: true };
  }

  private settle(wakeId: string, status: LightWakeRow["status"], usage: { inputTokens: number; outputTokens: number } | null,
    finalText: string | null, errorCode: string | null): void {
    const facts = this.toolFacts.get(wakeId);
    this.toolFacts.delete(wakeId);
    try {
      this.deps.db.prepare(`UPDATE alive_light_wakes SET status=?,input_tokens=?,output_tokens=?,tool_calls=?,tool_names_json=?,final_text=?,error_code=?,settled_at_ms=?
        WHERE wake_id=? AND status='running'`).run(status, usage?.inputTokens ?? null, usage?.outputTokens ?? null, facts?.count() ?? 0,
        JSON.stringify(facts?.names() ?? []),
        finalText === null ? null : finalText.slice(0, 4_096), errorCode, this.deps.now(), wakeId);
    } catch { return; /* the DB closed under a quit: the next process reconciles this row as host-lost */ }
    const row = this.row(wakeId);
    if (row) for (const listener of [...this.listeners]) { try { listener(row); } catch { /* a listener cannot stop settlement */ } }
  }
}
