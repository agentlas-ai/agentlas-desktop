import { createHash } from "node:crypto";
import { createRuntimeUsageCollector } from "../../shared/observed-usage";
import type Database from "better-sqlite3";
import type { RuntimeSelection, RuntimeStatus } from "../../shared/types";
import type { AliveRuntimeStart } from "../alive-core/contracts";
import type { AliveLifetimeStore } from "../alive-core/lifetime-store";
import { ALIVE_CONTROLLER_SLUG, builtinAgentId } from "../architecture/manifest";
import { ALIVE_GOAL_CONTROLLER_PROMPT } from "../alive-organisms/controller-prompt";
import { ALIVE_GOAL_DECISION_OUTPUT_SCHEMA } from "../alive-organisms/goal-decision";
import { createDaemonAgentContextHost } from "./agent-context-host";
import type { NativeAuthenticatedIdentity } from "./native-session-auth";
import { agentContextSessionKey, agentContextHostBinding, reconcileInterruptedAgentContext } from "../runtime/agent-context";
import { registerAliveDecisionProfile } from "../runtime/alive-decision-context";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "../runtime/runner";

export const ALIVE_DECISION_PROTOCOL = "agentlas.alive-decision.v1";
export interface AliveDecisionOwner { ownerScope: string; serviceIdentity: string }
export interface AliveDecisionWake extends AliveDecisionOwner {
  organism: "one" | "work";
  lifeAgentId: string;
  wakeId: string;
  controlEpoch: number;
  attachmentDigest: string;
}
export interface AliveDecisionChoice {
  kind: RuntimeSelection["kind"];
  source: string | null;
  backend: RuntimeSelection["backend"] | null;
  model: string | null;
}
declare const bindingBrand: unique symbol;
export interface AliveDecisionBinding { readonly [bindingBrand]: true }
const bindings = new WeakMap<AliveDecisionBinding, { wake: AliveDecisionWake; assertCurrent(): void }>();
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function decisionResult(value: unknown): RunnerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("alive_decision_result_invalid");
  const r = value as RunnerResult;
  if (typeof r.text !== "string" || r.text.length > 4096
    || (r.ownerControlTerminal !== undefined && !["completed", "uncertain"].includes(r.ownerControlTerminal))) fail("alive_decision_result_invalid");
  if (r.failure && (Object.keys(r.failure).some(key => !["kind", "runtime", "message", "source", "providerCode", "exitCode", "retryAfterHint"].includes(key))
    || !["quota", "auth", "refused", "empty", "exit", "timeout", "unavailable", "unsupported"].includes(r.failure.kind)
    || typeof r.failure.runtime !== "string" || typeof r.failure.message !== "string" || r.failure.message.length > 4096
    || !["heuristic", "marker", "exit"].includes(r.failure.source)
    || (r.failure.providerCode !== undefined && (typeof r.failure.providerCode !== "string" || r.failure.providerCode.length > 200))
    || (r.failure.retryAfterHint !== undefined && (typeof r.failure.retryAfterHint !== "string" || r.failure.retryAfterHint.length > 1000))
    || (r.failure.exitCode !== undefined && !Number.isSafeInteger(r.failure.exitCode)))) fail("alive_decision_result_invalid");
  const measured = createRuntimeUsageCollector().total(r.observedUsage);
  return { text: r.text, ownerControlTerminal: r.ownerControlTerminal ?? "uncertain",
    ...(r.failure ? { failure: { ...r.failure } } : {}), ...(measured ? { observedUsage: measured } : {}) };
}
function attached(db: Database.Database, lifeId: string): unknown[] {
  return (db.prepare("SELECT attachment_id,domain,scope_json,status FROM alive_attachments WHERE agent_id=? ORDER BY attachment_id")
    .all(lifeId) as Array<{ attachment_id: string; domain: string; scope_json: string; status: string }>).map(row =>
    [row.attachment_id, row.domain, JSON.parse(row.scope_json), row.status]);
}
function validateLife(db: Database.Database, wake: AliveDecisionWake, now: number, turn: boolean): void {
  const life = db.prepare(`SELECT a.status,a.control_epoch,a.budget_json,l.organism
    FROM alive_agents a JOIN alive_organism_lives l ON l.agent_id=a.agent_id WHERE a.agent_id=?`).get(wake.lifeAgentId) as
    { status: string; control_epoch: number; budget_json: string; organism: string } | undefined;
  if (!life || life.status !== "enabled" || life.organism !== wake.organism || life.control_epoch !== wake.controlEpoch
    || digest(attached(db, wake.lifeAgentId)) !== wake.attachmentDigest) fail("alive_decision_life_changed");
  if (!db.prepare("SELECT id FROM installed_agents WHERE id=? AND slug=? AND builtin=1")
    .get(builtinAgentId(ALIVE_CONTROLLER_SLUG), ALIVE_CONTROLLER_SLUG)) fail("alive_decision_controller_missing");
  if (!turn) return;
  const budget = JSON.parse(life.budget_json) as { deadlineMs: number | null; tokenLimit: number | null; tokensUsed: number };
  if ((budget.deadlineMs !== null && now >= budget.deadlineMs)
    || (budget.tokenLimit !== null && budget.tokensUsed >= budget.tokenLimit)) fail("alive_decision_budget_spent");
  const reserved = db.prepare("SELECT agent_id,control_epoch,status FROM alive_wakes WHERE wake_id=?").get(wake.wakeId) as
    { agent_id: string; control_epoch: number; status: string } | undefined;
  if (!reserved || reserved.agent_id !== wake.lifeAgentId || reserved.control_epoch !== wake.controlEpoch
    || !["reserved", "running"].includes(reserved.status)) fail("alive_decision_wake_changed");
}
/** Main mints before the attempt row; the daemon independently revalidates
 * these durable fences after that row exists. No authority travels as JSON. */
export function createAliveDecisionBinding(input: {
  store: AliveLifetimeStore; organism: "one" | "work"; start: AliveRuntimeStart;
  ownerBinding(): AliveDecisionOwner; assertCurrent(): void; now(): number;
}): AliveDecisionBinding {
  if (!input.store.owns(input.start.agentId)) fail("alive_decision_life_scope_changed");
  const owner = input.ownerBinding();
  const wake: AliveDecisionWake = Object.freeze({ ...owner, organism: input.organism, lifeAgentId: input.start.agentId,
    wakeId: input.start.wakeId, controlEpoch: input.start.controlEpoch, attachmentDigest: digest(attached(input.store.db, input.start.agentId)) });
  const assertCurrent = () => {
    input.assertCurrent();
    if (!input.store.owns(wake.lifeAgentId) || digest(input.ownerBinding()) !== digest(owner)) fail("alive_decision_owner_changed");
    validateLife(input.store.db, wake, input.now(), true);
  };
  assertCurrent();
  const binding = Object.freeze({}) as AliveDecisionBinding;
  bindings.set(binding, { wake, assertCurrent });
  return binding;
}
export interface AliveDecisionTransport {
  ownerBinding(): AliveDecisionOwner;
  run(binding: AliveDecisionBinding, status: RuntimeStatus, selection: RuntimeSelection, request: RunnerRequest, events: RunnerEvents): Promise<RunnerResult>;
  release(lifeAgentId: string): void;
  close(): void;
}
/** The dispatch callback must be the existing authenticated native GUI
 * channel. Failed/uncertain transport never falls back or replays a wake. */
export function createAliveDecisionTransport(options: {
  ownerBinding(): AliveDecisionOwner;
  dispatch(wire: unknown): Promise<unknown>;
}): AliveDecisionTransport {
  const captured = new Map<string, AliveDecisionWake>();
  let closed = false;
  const control = (wake: AliveDecisionWake, operation: "cancel" | "release") => {
    void options.dispatch({ version: ALIVE_DECISION_PROTOCOL, operation, wake }).catch(() => { /* original Main receipt stays uncertain */ });
  };
  return {
    ownerBinding: options.ownerBinding,
    async run(binding, status, selection, request, _events) {
      const held = bindings.get(binding);
      if (!held || closed) fail("alive_decision_binding_required");
      held.assertCurrent(); request.signal?.throwIfAborted();
      captured.set(held.wake.lifeAgentId, held.wake);
      const cancel = () => control(held.wake, "cancel");
      request.signal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = await options.dispatch({ version: ALIVE_DECISION_PROTOCOL, operation: "run", wake: held.wake,
          choice: { kind: status.kind, source: status.source ?? null, backend: selection.backend ?? null, model: selection.model ?? null },
          userPrompt: request.userPrompt });
        if (!exact(result, ["version", "wakeId", "result", "nativeActivity", "toolNames"]) || result.version !== ALIVE_DECISION_PROTOCOL
          || result.wakeId !== held.wake.wakeId || typeof result.nativeActivity !== "boolean" || !Array.isArray(result.toolNames)
          || result.toolNames.length > 16 || result.toolNames.some(name => typeof name !== "string" || name.length > 80)) fail("alive_decision_result_invalid");
        // One daemon receipt aggregates its observed provider attempts. This
        // marks original activity for Main's ledger; it never starts a call.
        if (result.nativeActivity) _events.onRuntimeAttemptStarted?.(`alive-daemon:${held.wake.wakeId}`);
        result.toolNames.forEach((name, index) => _events.onTool?.(name as string, undefined, undefined, `alive-decision-observed:${index}`));
        // Main still records measured usage when an epoch changes during the
        // call. Its lifetime ledger, not this response, owns action admission.
        return decisionResult(result.result);
      } finally { request.signal?.removeEventListener("abort", cancel); }
    },
    release(lifeId) { const wake = captured.get(lifeId); if (wake) { captured.delete(lifeId); control(wake, "release"); } },
    close() { if (closed) return; closed = true; for (const wake of captured.values()) control(wake, "release"); captured.clear(); },
  };
}
export interface AliveDecisionPeer {
  identity: NativeAuthenticatedIdentity;
  assertCurrent(): void;
  onClose(listener: () => void): () => void;
}
export function createDaemonAliveDecisionPort(options: {
  db: Database.Database; bootId: string; ownerBinding(): AliveDecisionOwner; assertOwner(): void; now(): number;
  /** Host resolves the exact installed runtime; returned runner already has
   * the agent-context wrapper. No arbitrary wire runner/config is accepted. */
  resolveRuntime(choice: AliveDecisionChoice): Promise<{ runner: Runner; label: string; status: RuntimeStatus } | null>;
}) {
  const owner = options.ownerBinding();
  let closed = false;
  type Life = { wake: AliveDecisionWake; identity: { ownerScope: string; serviceIdentity: string; agentId: string; visibilityDomain: string };
    peer: NativeAuthenticatedIdentity; controller: AbortController | null; resources: Map<string, () => void | Promise<void>>; bindingKey?: string; detach?: () => void };
  const lives = new Map<string, Life>();
  const active = new Set<string>();
  const closeResources = (life: Life) => { for (const close of life.resources.values()) { try { void Promise.resolve(close()).catch(() => {}); } catch {} } life.resources.clear(); };
  const assertOwner = () => {
    if (closed) fail("alive_decision_port_closed");
    options.assertOwner();
    if (digest(options.ownerBinding()) !== digest(owner)) fail("alive_decision_owner_changed");
  };
  const actor = createDaemonAgentContextHost({ bootId: options.bootId, ...owner, assertOwner,
    awakeLifetime(identity) {
      const life = [...lives.values()].find(value => value.identity.visibilityDomain === identity.visibilityDomain);
      return life ? { assertCurrent() { assertOwner(); validateLife(options.db, life.wake, options.now(), false); } } : null;
    } });
  const release = (life: Life) => { life.controller?.abort(new Error("alive-wake-cancelled")); actor.stop(life.identity); closeResources(life);
    life.detach?.(); if (lives.get(life.wake.lifeAgentId) === life) lives.delete(life.wake.lifeAgentId); };
  function parseWake(value: unknown): AliveDecisionWake {
    if (!exact(value, ["organism", "lifeAgentId", "wakeId", "controlEpoch", "attachmentDigest", "ownerScope", "serviceIdentity"])
      || !["one", "work"].includes(String(value.organism)) || typeof value.lifeAgentId !== "string" || !UUID.test(value.lifeAgentId)
      || typeof value.wakeId !== "string" || !UUID.test(value.wakeId) || !Number.isSafeInteger(value.controlEpoch) || Number(value.controlEpoch) < 0
      || typeof value.attachmentDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.attachmentDigest)
      || value.ownerScope !== owner.ownerScope || value.serviceIdentity !== owner.serviceIdentity) fail("alive_decision_descriptor_invalid");
    return Object.freeze({ ...value }) as unknown as AliveDecisionWake;
  }
  return {
    async dispatch(value: unknown, peer: AliveDecisionPeer): Promise<unknown> {
      if (!value || typeof value !== "object") fail("alive_decision_request_invalid");
      const wire = value as Record<string, unknown>, wake = parseWake(wire.wake);
      if (wire.version !== ALIVE_DECISION_PROTOCOL) fail("alive_decision_request_invalid");
      const old = lives.get(wake.lifeAgentId);
      // Captured stop follows the authenticated connection, independently of
      // the current life/epoch/controller availability and budget.
      if (wire.operation === "cancel" || wire.operation === "release") {
        if (!exact(wire, ["version", "operation", "wake"]) || !old || old.peer !== peer.identity
          || old.wake.wakeId !== wake.wakeId) fail("alive_decision_capture_required");
        peer.assertCurrent();
        if (wire.operation === "release") release(old); else old.controller?.abort(new Error("alive-wake-cancelled"));
        return { cancelled: true };
      }
      if (!exact(wire, ["version", "operation", "wake", "choice", "userPrompt"]) || wire.operation !== "run"
        || typeof wire.userPrompt !== "string" || Buffer.byteLength(wire.userPrompt) > 16 * 1024
        || !exact(wire.choice, ["kind", "source", "backend", "model"]) || typeof wire.choice.kind !== "string"
        || [wire.choice.source, wire.choice.backend, wire.choice.model].some(item => item !== null && (typeof item !== "string" || item.length > 2048))) fail("alive_decision_request_invalid");
      assertOwner(); peer.assertCurrent();
      if (peer.identity.bootId !== options.bootId || peer.identity.serviceIdentity !== owner.serviceIdentity) fail("alive_decision_peer_changed");
      validateLife(options.db, wake, options.now(), true);
      const attempt = options.db.prepare("SELECT agent_id,status FROM alive_light_wakes WHERE wake_id=? AND attempt_started=1").get(wake.wakeId) as
        { agent_id: string; status: string } | undefined;
      if (!attempt || attempt.agent_id !== wake.lifeAgentId || attempt.status !== "running") fail("alive_decision_attempt_required");
      if (active.has(wake.lifeAgentId)) fail("alive_decision_life_busy");
      const choice = wire.choice as unknown as AliveDecisionChoice;
      const selected = options.db.prepare(`SELECT payload_json FROM alive_events WHERE agent_id=? AND kind='wake.runtime-selected'
        AND json_extract(payload_json,'$.wakeId')=? ORDER BY sequence DESC LIMIT 1`).get(wake.lifeAgentId, wake.wakeId) as { payload_json: string } | undefined;
      const selection = selected ? JSON.parse(selected.payload_json) : null;
      if (!selection || selection.kind !== choice.kind || (selection.model || null) !== choice.model
        || (selection.backend ?? null) !== choice.backend) fail("alive_decision_runtime_changed");
      active.add(wake.lifeAgentId);
      const controller = new AbortController();
      const usage = createRuntimeUsageCollector();
      let nativeActivity = false;
      let providerResult: RunnerResult | undefined;
      const toolNames: string[] = [];
      let life: Life | undefined;
      let admitted = false;
      try {
        if (old && (old.wake.controlEpoch !== wake.controlEpoch || old.wake.attachmentDigest !== wake.attachmentDigest || old.peer !== peer.identity)) release(old);
        life = lives.get(wake.lifeAgentId) ?? { wake, identity: { ...owner, agentId: builtinAgentId(ALIVE_CONTROLLER_SLUG),
          visibilityDomain: `alive-decision:${wake.organism}:${wake.lifeAgentId}` }, peer: peer.identity, controller: null, resources: new Map() };
        life.wake = wake; life.controller = controller; lives.set(wake.lifeAgentId, life);
        const heldLife = life;
        life.detach ??= peer.onClose(() => release(heldLife));
        const picked = await options.resolveRuntime(choice);
        if (!picked || picked.status.kind !== choice.kind || (picked.status.source ?? null) !== choice.source) fail("alive_decision_runtime_unavailable");
        const assertTurn = () => {
          controller.signal.throwIfAborted(); assertOwner(); peer.assertCurrent(); validateLife(options.db, wake, options.now(), true);
          const row = options.db.prepare("SELECT status FROM alive_light_wakes WHERE wake_id=?").get(wake.wakeId) as { status: string } | undefined;
          if (row?.status !== "running") fail("alive_decision_attempt_changed");
        };
        assertTurn();
        const bindingKey = digest([choice, "alive-no-tools.v1", ALIVE_GOAL_CONTROLLER_PROMPT, ALIVE_GOAL_DECISION_OUTPUT_SCHEMA]);
        if (life.bindingKey && life.bindingKey !== bindingKey) closeResources(life);
        life.bindingKey = bindingKey;
        // Re-enable is a new verified epoch over the same durable journal.
        // A stopped actor only resumes after all original resources settled.
        actor.resume(life.identity);
        admitted = true;
        const result = await actor.runTurn(life.identity, { turnId: `alive-decision:${wake.wakeId}`, adapterKey: bindingKey,
          assertCurrent: assertTurn, signal: controller.signal }, async (capability, signal) => {
          reconcileInterruptedAgentContext(capability, previous => {
            if (!previous.startsWith("alive-decision:")) fail("alive_decision_previous_turn_unknown");
            const row = options.db.prepare("SELECT agent_id,status FROM alive_light_wakes WHERE wake_id=?").get(previous.slice(15)) as { agent_id: string; status: string } | undefined;
            if (!row || row.agent_id !== wake.lifeAgentId || !["completed", "failed", "cancelled", "interrupted"].includes(row.status)) fail("alive_decision_previous_turn_unsettled");
          });
          const request: RunnerRequest = { agentId: life!.identity.agentId, agentContext: capability, systemPrompt: ALIVE_GOAL_CONTROLLER_PROMPT,
            history: [], userPrompt: wire.userPrompt as string, backendLabel: picked.label, runtimeSource: picked.status.source,
            model: choice.model ?? undefined, effort: "low", longContext: false, permission: "read", untrustedNoTools: true,
            judgmentOnly: true, surfaceGate: "exclude", maxOutputTokens: 600,
            outputSchema: { name: "agentlas_alive_goal_decision_v2", schema: ALIVE_GOAL_DECISION_OUTPUT_SCHEMA }, signal, locale: "en",
            ...(choice.kind === "codex" ? { isolatedMcpConfig: true } : {}) };
          const remove = registerAliveDecisionProfile(capability, request, { kind: "alive-no-tools", lifeAgentId: wake.lifeAgentId,
            wakeId: wake.wakeId, resourceOwnerKey: agentContextSessionKey(capability), bindingKey, maxHistoryChars: 8192, signal,
            assertCurrent() { agentContextHostBinding(capability).assertCurrent(); assertTurn(); },
            retainResource() { try { assertOwner(); validateLife(options.db, heldLife.wake, options.now(), false); return lives.get(wake.lifeAgentId) === heldLife; } catch { return false; } },
            registerResource(key, close) { assertTurn(); if (!key || heldLife.resources.size >= 1) fail("alive_decision_resource_owned");
              heldLife.resources.set(key, close); return () => { if (heldLife.resources.get(key) === close) heldLife.resources.delete(key); }; },
          });
          try {
            providerResult = await picked.runner(request, { onPartial: () => { nativeActivity = true; }, onStatus: () => {},
              onThinking: () => { nativeActivity = true; }, onUsage: () => { nativeActivity = true; },
              onNativeTurnController: value => { if (value) nativeActivity = true; },
              onRuntimeAttemptStarted: id => { nativeActivity = true; usage.start(id); },
              onTerminalObservedUsage: (observed, id) => { nativeActivity = true; usage.recordTerminal(observed, id); }, onTool(name) {
              nativeActivity = true;
              if (toolNames.length < 16) toolNames.push(String(name).slice(0, 80));
              if (name !== "StructuredOutput") { controller.abort(new Error("alive-decision-tool-denied")); fail("alive_decision_tool_denied"); }
            } });
            if (providerResult.text || providerResult.observedUsage || providerResult.ownerControlTerminal === "completed") nativeActivity = true;
            return providerResult;
          } finally { remove(); }
        });
        const measured = usage.total(result.observedUsage);
        return { version: ALIVE_DECISION_PROTOCOL, wakeId: wake.wakeId, nativeActivity, toolNames,
          result: decisionResult({ ...result, text: result.text.slice(0, 4096), observedUsage: measured }) };
      } catch (error) {
        if (!admitted && !old && life) release(life);
        // Once native activity was observed, preserve measured usage even if
        // the provider throws or the turn fence expires before journal ACK.
        if (!nativeActivity) throw error;
        return { version: ALIVE_DECISION_PROTOCOL, wakeId: wake.wakeId, nativeActivity: true, toolNames,
          result: decisionResult({ text: providerResult?.text.slice(0, 4096) ?? "", ownerControlTerminal: "uncertain",
            observedUsage: usage.total(providerResult?.observedUsage) }) };
      } finally { active.delete(wake.lifeAgentId); if (life?.controller === controller) life.controller = null; }
    },
    close() { if (closed) return; closed = true; for (const life of [...lives.values()]) release(life); actor.close(); },
  };
}
