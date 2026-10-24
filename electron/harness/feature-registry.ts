/*
 * Feature connection registry (docs/2026-10-13-native-harness/10 §3-4, 12 §3). Every Agentlas feature is declared
 * once with how each executor family connects to it, instead of `if (runtime === …)` branches across domains.
 *
 *   native            the executor provides this meaning itself; the adapter delegates
 *   host-equivalent   the host provides the same public meaning (queue, durable record, typed tool)
 *   host-alternative  the host helps, but the meaning differs (next-turn steer, replayed fork, JSON re-ask)
 *   provider-only     provider state Agentlas does not replicate (quota, hidden native state)
 *   unavailable       not reachable with the current binding
 *
 * `evidence` is separate from mode: a declaration is not a live success. Stages: source (code read / source
 * assertion), fake (contract-tested against a fake CLI or server), live (a real run recorded it).
 * Pure data + lookups; no electron import (the daemon and Terminal load it).
 */

import { registerDeclaredPromptModule } from "../runtime/prompt-order";

/** Selected host data returned by harness_describe feature:<id>; no execution authority. */
export const HARNESS_FEATURE_DECLARATION_MODULE = {"id":"harness.feature.declaration","revision":1,"stability":"turn-context","changeTriggers":["owner-input","release"],"order":0} as const;
export const HARNESS_FEATURE_DESCRIPTION_FORMULA = {"id":"desktop.harness.feature-description","channel":"tool-result","orderedModuleIds":["harness.feature.declaration"],module:HARNESS_FEATURE_DECLARATION_MODULE} as const;

export type ConnectionMode = "native" | "host-equivalent" | "host-alternative" | "provider-only" | "unavailable";
export type EvidenceStage = "source" | "fake" | "live";
export type ExecutorFamily = "codex-app-server" | "claude-print" | "acp" | "antigravity" | "api-loop" | "local-loop";

export interface FeatureConnection {
  mode: ConnectionMode;
  evidence: EvidenceStage;
  /** Short source citation (file:line) of the adapter path the claim was read from. */
  note?: string;
  /** Required for host-alternative: how the host-provided meaning differs from the native one (doc 10 section 5). */
  meaningDifference?: string;
  /** Required for evidence "live": an identifier of the recorded run (path or run id). Never invented. */
  receipt?: string;
}

/**
 * The domain side of a feature (12 §3 / F2): what it owns and who runs it. Declared once over the existing code — nothing
 * moves; scripts/test-feature-modules-domain.cjs checks every name against the source (the start function is called by
 * the declared host and by no other, each operation id, table and event kind exists, each acceptance gate exists).
 */
/** A consumer of the shared canonical wait partition, not another owner of the legacy Goal clocks. */
export interface FeatureCanonicalOwnerConsumer {
  host: "daemon";
  start: "pollGoalWaitSubscriptions";
  partition: "canonical-owner-waits";
  ownerBinding: "explicit-kind-epoch";
  currentness: "execution-owner-lease";
  clock: { source: "serviceHeartbeat"; intervalMs: 500; minPollIntervalMs: 60000 };
}

export interface FeatureDomain {
  version: string;
  dependencies: readonly string[];
  /** The one host whose startup starts the feature's clocks/consumers; `start` is the function that host calls. */
  /** Empty start and clocks: the feature has no background lifecycle (it runs only when an operation is called). */
  lifecycle: {
    host: "main" | "daemon"; start: readonly string[]; stop?: readonly string[]; clocks: readonly string[];
    /**
     * The other host may run the domain only as a lease-fenced standby: it builds the clocks only while it holds the
     * named owner row (one owner at a time, never a second clock for a life). `companionClocks` run there regardless,
     * because they belong to a domain that host owns (e.g. the AGI monitor beside Goal custody).
     */
    /** Only this partition may be consumed by the other host, under its current explicit owner. */
    canonicalOwnerConsumers?: readonly FeatureCanonicalOwnerConsumer[];
    standby?: { host: "main" | "daemon"; start: readonly string[]; stop?: readonly string[]; leaseTable: string; companionClocks: readonly string[] };
  };
  operations: {
    ipc?: readonly string[];
    appControl?: readonly string[];
    harness?: readonly string[];
    turnTools?: readonly string[];
    teamTools?: readonly string[];
  };
  persistence: { tables?: readonly string[]; metaPrefixes?: readonly string[]; files?: readonly string[] };
  events: readonly string[];
  acceptance: ReadonlyArray<{ gate: string; evidence: EvidenceStage }>;
}

export interface FeatureModule {
  featureId: string;
  semanticsVersion: number;
  /** Who executes the feature's logic: Agentlas domain core, or the executor. */
  executorOwner: "agentlas-core" | "executor";
  /** Who owns the model context for it. */
  contextOwner: "native" | "host" | "per-executor";
  /** Host ports the feature needs (store, clock, invocation, event, owner, device). */
  requiredHostPorts: readonly string[];
  /** Typed tools or operations that carry it to the model. */
  surfaces: readonly string[];
  connections: Readonly<Record<ExecutorFamily, FeatureConnection>>;
  /** Domain declaration (Alive, Goal, Toolchain so far). */
  domain?: FeatureDomain;
}

const MCP_TOOL = (evidence: EvidenceStage, note?: string): FeatureConnection => ({ mode: "host-equivalent", evidence, ...(note ? { note } : {}) });
/** Host-alternative with the mandatory meaning-difference note (doc 10 section 5). */
const ALT = (note: string, meaningDifference: string): FeatureConnection => ({ mode: "host-alternative", evidence: "source", note, meaningDifference });
const HOST_EQ = (note: string): FeatureConnection => ({ mode: "host-equivalent", evidence: "source", note });
const NATIVE = (note: string): FeatureConnection => ({ mode: "native", evidence: "source", note });
const IN_PROCESS_TEXT: FeatureConnection = { mode: "host-alternative", evidence: "source", note: "in-process loops keep the text protocol as fallback; the tool works when called" };

/** Map a RuntimeKind to its executor family. Unknown kinds are API loops (the host runs the model). */
export function executorFamily(runtimeKind: string): ExecutorFamily {
  if (runtimeKind === "codex") return "codex-app-server";
  if (runtimeKind === "claude-code") return "claude-print";
  if (runtimeKind === "antigravity") return "antigravity";
  if (runtimeKind === "grok" || runtimeKind === "kimi" || runtimeKind === "cursor" || runtimeKind === "acp" || runtimeKind === "github-copilot-cli") return "acp";
  if (runtimeKind === "ollama" || runtimeKind === "lmstudio" || runtimeKind === "mlx" || runtimeKind === "agentlas-local") return "local-loop";
  return "api-loop";
}

export const FEATURE_MODULES: readonly FeatureModule[] = [
  {
    featureId: "ask", semanticsVersion: 1, executorOwner: "agentlas-core", contextOwner: "per-executor",
    requiredHostPorts: ["invocation", "event", "device"], surfaces: ["ask_form", "<<agentlas-ask>>", "ask_user"],
    connections: {
      "codex-app-server": MCP_TOOL("fake", "ask_form recorded and re-entered as the canonical block"),
      "claude-print": MCP_TOOL("fake"), acp: MCP_TOOL("fake"), antigravity: MCP_TOOL("fake"),
      "api-loop": { mode: "host-equivalent", evidence: "source", note: "ask_user is a synchronous builtin tool" },
      "local-loop": { mode: "host-equivalent", evidence: "source", note: "ask_user is a synchronous builtin tool" },
    },
  },
  {
    featureId: "memory-receipt", semanticsVersion: 1, executorOwner: "agentlas-core", contextOwner: "per-executor",
    requiredHostPorts: ["store", "invocation"], surfaces: ["memory_note", "## Memory Events turn_summary"],
    connections: { "codex-app-server": MCP_TOOL("fake"), "claude-print": MCP_TOOL("fake"), acp: MCP_TOOL("fake"), antigravity: MCP_TOOL("fake"), "api-loop": IN_PROCESS_TEXT, "local-loop": IN_PROCESS_TEXT },
  },
  {
    featureId: "goal-lifecycle", semanticsVersion: 1, executorOwner: "agentlas-core", contextOwner: "per-executor",
    requiredHostPorts: ["store", "clock", "invocation", "event", "owner", "file"], surfaces: ["goal_wait", "goal_complete", "goal_tactic", "goal_plan_op", "goal_kpi"],
    connections: { "codex-app-server": MCP_TOOL("fake"), "claude-print": MCP_TOOL("fake"), acp: MCP_TOOL("fake"), antigravity: MCP_TOOL("fake"), "api-loop": IN_PROCESS_TEXT, "local-loop": IN_PROCESS_TEXT },
    domain: {
      version: "1", dependencies: ["store", "invocation"],
      // The wait poll rides the automation scheduler's 60 s tick; the blocked-goal sweep has its own 60 s interval.
      lifecycle: { host: "main", start: ["startAutomationScheduler", "sweepBlockedGoals", "pollGoalWaitSubscriptions"], stop: ["closeAutomationDispatchForShutdown"],
        clocks: ["automation-scheduler 60s tick (goal waits)", "blocked-goal sweep 60s"],
        canonicalOwnerConsumers: [{ host: "daemon", start: "pollGoalWaitSubscriptions", partition: "canonical-owner-waits",
          ownerBinding: "explicit-kind-epoch", currentness: "execution-owner-lease",
          clock: { source: "serviceHeartbeat", intervalMs: 500, minPollIntervalMs: 60000 } }] },
      operations: {
        ipc: ["goalPanel:view", "goalPanel:edit", "goalPanel:shape"],
        appControl: ["goalPanel.view", "goalPanel.edit", "goalPanel.shape"],
        turnTools: ["goal_wait", "goal_complete", "goal_tactic", "goal_plan_op", "goal_kpi"],
      },
      persistence: { tables: ["chat_goal_contracts", "chat_goal_revisions", "long_runs", "long_run_tasks", "long_run_events", "long_run_verification_receipts"] },
      events: ["goal_wait_registered", "goal_wait_refused", "goal_idle_pass_yield", "goal_owner_card_added", "goal_pass_budget_yield", "goal_native_episode_yield"],
      acceptance: [
        { gate: "goal-loop-contract.cjs", evidence: "fake" }, { gate: "goal-startup-continuity-contract.cjs", evidence: "fake" },
        { gate: "long-run-store-contract.cjs", evidence: "fake" }, { gate: "test-goal-wake-arbiter.cjs", evidence: "fake" },
      ],
    },
  },
  {
    featureId: "alive", semanticsVersion: 1, executorOwner: "agentlas-core", contextOwner: "host",
    requiredHostPorts: ["store", "clock", "invocation", "event", "owner"], surfaces: [],
    connections: {
      // A light wake runs the configured decision runtime through the same invocation path; the beat is host-owned.
      "codex-app-server": { mode: "host-equivalent", evidence: "source", note: "host clock; decision run through the invocation service" },
      "claude-print": { mode: "host-equivalent", evidence: "source" }, acp: { mode: "host-equivalent", evidence: "source" },
      antigravity: { mode: "host-equivalent", evidence: "source" }, "api-loop": { mode: "host-equivalent", evidence: "source" },
      "local-loop": { mode: "host-equivalent", evidence: "source" },
    },
    domain: {
      version: "1", dependencies: ["goal-lifecycle", "store", "invocation"],
      // NH21: the enrolled background service owns the organism clocks/store/wakes/actions (alive_domain_owner lease);
      // the window process takes them only while no service holds the lease, and otherwise forwards owner edits to the
      // service and executes the Goal actions it hands back (Goal custody stays in the window process).
      lifecycle: { host: "daemon", start: ["startDaemonAliveOrganisms"],
        clocks: ["desktopAliveClock work-organism", "desktopAliveClock one-organism"],
        standby: { host: "main", start: ["startAliveOrganisms"], stop: ["stopAliveOrganisms"], leaseTable: "alive_domain_owner",
          companionClocks: ["agi monitor", "bug-report flush 60s"] } },
      operations: {
        ipc: ["alive:getState", "alive:setEnabled", "alive:setTokenLimit", "alive:resumeUncertainWake"],
        appControl: ["alive.getState", "alive.setEnabled", "alive.setTokenLimit", "alive.resumeUncertainWake", "agi.getTokenLimits", "agi.setTokenLimits"],
      },
      persistence: { tables: ["alive_agents", "alive_attachments", "alive_events", "alive_wakes", "alive_actions"] },
      events: ["wake.reserved", "wake.settled", "action.dispatching", "action.forwarded", "alive_provider_attempt_started", "alive_provider_usage_observed"],
      acceptance: [
        { gate: "alive-decision-contract.cjs", evidence: "fake" }, { gate: "test-alive-stops-before-store-close.cjs", evidence: "fake" },
        { gate: "test-agi-native-harness.cjs", evidence: "fake" }, { gate: "test-alive-domain-owner-handoff.cjs", evidence: "fake" },
      ],
    },
  },
  {
    featureId: "toolchain", semanticsVersion: 1, executorOwner: "agentlas-core", contextOwner: "per-executor",
    requiredHostPorts: ["store", "invocation", "event", "owner", "file"], surfaces: ["toolchain_search", "toolchain_inspect", "toolchain_run", "toolchain_result", "toolchain_report"],
    connections: {
      "codex-app-server": MCP_TOOL("fake", "One team MCP server"), "claude-print": MCP_TOOL("fake"), acp: MCP_TOOL("source"), antigravity: MCP_TOOL("source"),
      "api-loop": MCP_TOOL("source", "behind the lazy tool menu"), "local-loop": MCP_TOOL("source", "behind the lazy tool menu"),
    },
    domain: {
      version: "1", dependencies: ["store", "invocation"],
      // A Toolchain is an MCP tool for an app or page once operated by hand (each callable one is also listed to agents as
      // its own tc_<name> tool). The only clock is the repeated-work detector; repairs follow real-use failures.
      lifecycle: { host: "main", start: ["startToolchainDetector"], clocks: ["repeated-work detector check 10m then 6h, a pass that calls a model at most once per 24h"] },
      operations: {
        appControl: ["toolchains.listAssets", "toolchains.getAsset", "toolchains.runAsset", "toolchains.publishVersion", "toolchains.withdrawAsset"],
        ipc: ["toolchains:assets-list", "toolchains:assets-run", "toolchains:assets-publish"],
        teamTools: ["toolchain_create", "toolchain_publish", "toolchain_search", "toolchain_inspect", "toolchain_run", "toolchain_result", "toolchain_report"],
      },
      persistence: { metaPrefixes: ["toolchain.asset.v1:", "toolchain.call.v1:", "toolchain.trial.v1:", "toolchain.detector.miss.v1:", "toolchain.detector.verdict.v1:", "toolchain.detector.state.v1"] },
      events: [],
      acceptance: [
        { gate: "test-toolchain-mcp-tools.cjs", evidence: "fake" }, { gate: "test-toolchain-health.cjs", evidence: "fake" },
        { gate: "test-toolchain-surfaces.cjs", evidence: "fake" }, { gate: "test-toolchain-detector.cjs", evidence: "fake" },
      ],
    },
  },
  {
    featureId: "ui-schema", semanticsVersion: 1, executorOwner: "agentlas-core", contextOwner: "per-executor",
    requiredHostPorts: [], surfaces: ["read_ui_schema", "read_surface_protocol", "read_automation_protocol"],
    connections: { "codex-app-server": MCP_TOOL("fake"), "claude-print": MCP_TOOL("fake"), acp: MCP_TOOL("fake"), antigravity: MCP_TOOL("fake"), "api-loop": MCP_TOOL("source", "behind the lazy tool menu"), "local-loop": MCP_TOOL("source", "behind the lazy tool menu") },
  },
  {
    featureId: "harness-ports", semanticsVersion: 1, executorOwner: "agentlas-core", contextOwner: "per-executor",
    requiredHostPorts: ["store", "owner"], surfaces: ["harness_search", "harness_describe", "harness_call"],
    connections: { "codex-app-server": MCP_TOOL("fake"), "claude-print": MCP_TOOL("fake"), acp: MCP_TOOL("fake"), antigravity: MCP_TOOL("fake"), "api-loop": MCP_TOOL("source", "behind the lazy tool menu"), "local-loop": MCP_TOOL("source", "behind the lazy tool menu") },
  },
  {
    // Doc 12 F6: added by this declaration and one harness port only; every executor reaches it through harness_call.
    featureId: "media-quality", semanticsVersion: 1, executorOwner: "agentlas-core", contextOwner: "per-executor",
    requiredHostPorts: ["file"], surfaces: ["harness_call media.quality.probe"],
    connections: { "codex-app-server": MCP_TOOL("fake"), "claude-print": MCP_TOOL("fake"), acp: MCP_TOOL("source"), antigravity: MCP_TOOL("source"), "api-loop": MCP_TOOL("source", "behind the lazy tool menu"), "local-loop": MCP_TOOL("source", "behind the lazy tool menu") },
    domain: {
      version: "1", dependencies: ["harness-ports"],
      lifecycle: { host: "main", start: [], clocks: [] },
      operations: { harness: ["media.quality.probe"] },
      persistence: {},
      events: [],
      acceptance: [{ gate: "test-media-quality.cjs", evidence: "fake" }],
    },
  },
  {
    // The common "steer" feature (doc 10 section 5): in-progress steering. Native only where the executor ACKs a live-turn steer.
    featureId: "turn-steer", semanticsVersion: 1, executorOwner: "executor", contextOwner: "per-executor",
    requiredHostPorts: ["invocation", "event"], surfaces: ["steer"],
    connections: {
      // Evidence was "live" with no recorded run; the only gate found (test-codex-residency.cjs) drives a fake app-server.
      "codex-app-server": { mode: "native", evidence: "fake", note: "turn/steer + expectedTurnId ACK: runtime/codex-native-steering.ts:84; host intake invocation/service.ts:5730" },
      // A resident (stream-json) turn the CLI confirmed by echoing its uuid publishes the controller; a one-shot turn (old
      // CLI, residency off, untrusted/no-tools runs) keeps the queued intake. The fake-CLI gate is test-claude-lane-settlement-and-steer.cjs.
      "claude-print": { mode: "native", evidence: "fake", note: "stream-json user message {uuid, priority:\"next\", origin:{kind:\"human\"}}; ACK = command_lifecycle started or user_message_uuids echo; Stop's interrupt receipt (cancelled / still_queued) settles directions not taken in: runtime/claude-code.ts maybePublishNativeController" },
      acp: ALT("queued intake invocation/service.ts:5730; ACP has no stable steer RPC (runtime/acp.ts)", "applied at the next session/prompt, not an ACK on the live turn"),
      antigravity: ALT("queued intake invocation/service.ts:5730; headless agy has no steer input (runtime/antigravity.ts)", "applied at the next prompt, not an ACK on the live turn"),
      "api-loop": ALT("ownerControlInbox take(phase) at loop boundaries: invocation/service.ts ownerControlInbox", "applied at the next loop boundary; target turn and apply time are recorded"),
      "local-loop": ALT("ownerControlInbox take(phase) at loop boundaries: invocation/service.ts ownerControlInbox", "applied at the next loop boundary; target turn and apply time are recorded"),
    },
  },
  // ---- doc 10 section 5: features whose meaning differs by executor. Every cell was read from the adapter named in
  // `note`; none is "live" (no recorded run), and host-alternative cells say how the meaning differs. ----
  {
    featureId: "session-fork", semanticsVersion: 1, executorOwner: "executor", contextOwner: "per-executor",
    requiredHostPorts: ["store", "invocation"], surfaces: [],
    connections: {
      "codex-app-server": NATIVE("thread/fork when a held thread changes model, else thread/resume: runtime/codex.ts:2318 (conditional, not a user-facing fork)"),
      "claude-print": ALT("--fork-session removed 2026-08-18 (runtime/claude-code.ts:1237); resume by session id", "new session built from retained history/resume; no copy of hidden state, cache or tool state"),
      acp: ALT("only session/load is used (runtime/acp.ts); session/fork is unstable in the pinned schema", "host replays stored history into a new session; hidden state is not forked"),
      antigravity: ALT("--conversation resume only (runtime/antigravity.ts:488)", "host replays stored history; no native conversation fork"),
      "api-loop": HOST_EQ("host owns the whole context; a fork is a copy of host history (runtime/agent-context.ts)"),
      "local-loop": HOST_EQ("host owns the whole context; a fork is a copy of host history (runtime/agent-context.ts)"),
    },
  },
  {
    // Mirrors shared/runtime-capabilities.ts RUNTIME_SCHEMA_OUTPUT (scripts/test-feature-registry-doc10.cjs locks the two together).
    featureId: "structured-output", semanticsVersion: 1, executorOwner: "executor", contextOwner: "per-executor",
    requiredHostPorts: [], surfaces: ["RunnerRequest.outputSchema"],
    connections: {
      "codex-app-server": NATIVE("turn/start outputSchema when openAiStrictSchemaOrNull accepts it: runtime/codex.ts:2422; otherwise instruction fallback runtime/strict-output-schema.ts"),
      "claude-print": NATIVE("--json-schema (StructuredOutput tool): runtime/claude-code.ts:1050"),
      acp: ALT("schemaFallbackInstruction in the prompt: runtime/acp.ts:1312 (grok --json-schema runtime/grok.ts:533 only on the legacy driver)", "schema instruction + host parse, not constrained decoding; the fallback is reported in the status line"),
      antigravity: NATIVE("--json-schema: runtime/antigravity.ts:487"),
      "api-loop": NATIVE("response_format json_schema: runtime/local-tool-loop.ts:1506; Agentlas serving falls back to the instruction when the server does not confirm outputFormat (runtime/agentlas-serving.ts:315); BYOK Anthropic Messages and Gemini put the schema in the prompt and say so in the status (runtime/byok.ts prepareContext)"),
      "local-loop": NATIVE("response_format json_schema: runtime/local-tool-loop.ts:1506; ollama native format runtime/ollama-native.ts:162"),
    },
  },
  {
    featureId: "usage-telemetry", semanticsVersion: 1, executorOwner: "executor", contextOwner: "native",
    requiredHostPorts: ["store", "event"], surfaces: ["onTerminalObservedUsage", "onUsage"],
    connections: {
      "codex-app-server": NATIVE("thread/tokenUsage/updated: runtime/codex.ts:1992"),
      "claude-print": NATIVE("result.usage / modelUsage: runtime/claude-code.ts:1945"),
      acp: ALT("usage_update is context occupancy: runtime/acp.ts:12,256", "used/size context occupancy; never converted into input/output tokens or billing"),
      antigravity: NATIVE("DONE usage aggregate: runtime/antigravity.ts:608; cache split not read"),
      "api-loop": HOST_EQ("provider-reported usage per call collected by the host: runtime/local-tool-loop.ts:187"),
      "local-loop": HOST_EQ("server-reported usage per call collected by the host: runtime/local-tool-loop.ts:187"),
    },
  },
  {
    featureId: "subagent", semanticsVersion: 1, executorOwner: "executor", contextOwner: "per-executor",
    requiredHostPorts: ["invocation", "store"], surfaces: ["workforce assignment"],
    connections: {
      "codex-app-server": ALT("native collab/subAgentActivity only observed (runtime/codex.ts:2021); delegation authority kept off for isolated runs (runtime/codex.ts:2729); Agentlas path: one/team-dispatch.ts", "Agentlas workforce assigns an independent task; provider-native subagent shared context and tool state are not reproduced"),
      "claude-print": ALT("Task/Agent sidechain output filtered from the parent answer (runtime/claude-code.ts:2101); Agentlas path: one/team-dispatch.ts", "Agentlas workforce assigns an independent task; the native sub-agent's shared context is not reproduced"),
      acp: ALT("subagent_update is unstable in the pinned ACP schema; Agentlas path: one/team-dispatch.ts", "Agentlas workforce assigns an independent task; no stable provider subagent exists to compare"),
      antigravity: ALT("no subagent surface read in runtime/antigravity.ts; Agentlas path: one/team-dispatch.ts", "Agentlas workforce assigns an independent task"),
      "api-loop": HOST_EQ("no native subagent; workforce via one/team-dispatch.ts is the only path"),
      "local-loop": HOST_EQ("no native subagent; workforce via one/team-dispatch.ts is the only path"),
    },
  },
  {
    featureId: "tool-control", semanticsVersion: 1, executorOwner: "executor", contextOwner: "per-executor",
    requiredHostPorts: ["invocation", "owner"], surfaces: ["tool approval"],
    connections: {
      "codex-app-server": NATIVE("item/{commandExecution,fileChange,permissions}/requestApproval callbacks answered before execution: runtime/codex-session.ts:798-899"),
      "claude-print": NATIVE("PreToolUse hook deny before the call: runtime/claude-code.ts:1124 (+ launch guard :394)"),
      acp: NATIVE("session/request_permission answered through tool-approval: runtime/acp.ts:1058; only tools the agent asks about, fs/terminal capability off"),
      antigravity: ALT("headless: permission level fixed by launch flags, denials arrive as events: runtime/antigravity.ts:372-383,613", "observation after the fact plus a pre-launch permission level; no per-call pre-execution control"),
      "api-loop": HOST_EQ("host approval before dispatch: runtime/tool-approval.ts, runtime/local-tool-loop.ts"),
      "local-loop": HOST_EQ("host approval before dispatch: runtime/tool-approval.ts, runtime/local-tool-loop.ts"),
    },
  },
  {
    featureId: "model-control", semanticsVersion: 1, executorOwner: "executor", contextOwner: "per-executor",
    requiredHostPorts: ["invocation"], surfaces: ["model", "effort"],
    connections: {
      "codex-app-server": NATIVE("turn/start model/effort; a held thread forks on model change: runtime/codex.ts:2318"),
      "claude-print": NATIVE("control set_model ACK before the next user turn: runtime/claude-session.ts setClaudeResidentModel; --effort at launch only when chosen (no chip effort = the CLI's own default, profile effortDefault \"provider\")"),
      acp: ALT("model via session/set_config_option (runtime/acp.ts:909) with legacy session/set_model (:927); effort config not wired", "model switch acknowledged by config currentValue; effort stays at the launch/default value"),
      antigravity: ALT("--model argv only at spawn: runtime/antigravity.ts:468", "model change applies to the next launch, not a live switch; no effort control"),
      "api-loop": HOST_EQ("model chosen per request by the host loop: runtime/local-tool-loop.ts"),
      "local-loop": HOST_EQ("model chosen per request by the host loop: runtime/local-tool-loop.ts"),
    },
  },
  {
    featureId: "compaction", semanticsVersion: 1, executorOwner: "executor", contextOwner: "per-executor",
    requiredHostPorts: ["store", "invocation"], surfaces: ["session generation"],
    connections: {
      "codex-app-server": NATIVE("thread/compacted + contextCompaction items observed, limit from nativeCompactionLimit: runtime/codex.ts:1834, runtime/session-generation.ts:72"),
      "claude-print": NATIVE("compact_boundary observed, native autocompact: runtime/claude-code.ts:2031"),
      acp: ALT("no compaction RPC or event consumed; generation switch at a turn boundary: runtime/session-generation.ts:31", "host starts a new generation from retained history instead of compacting the provider session"),
      antigravity: ALT("no compaction signal read; generation switch at a turn boundary: runtime/session-generation.ts:31", "host starts a new generation instead of compacting the provider session"),
      "api-loop": HOST_EQ("compactHistoryToBudget on host-owned history: runtime/local-tool-loop.ts:8, runtime/compact.ts"),
      "local-loop": HOST_EQ("compactHistoryToBudget on host-owned history: runtime/local-tool-loop.ts:8, runtime/compact.ts"),
    },
  },
  {
    featureId: "context-80", semanticsVersion: 1, executorOwner: "agentlas-core", contextOwner: "per-executor",
    requiredHostPorts: ["store", "invocation"], surfaces: ["session generation"],
    connections: {
      "codex-app-server": { mode: "native", evidence: "source", note: "native compaction projected to 80% of the model window" },
      "claude-print": { mode: "native", evidence: "source", note: "native compaction; host generation switch at turn boundary when needed" },
      acp: { mode: "host-alternative", evidence: "source", note: "occupancy only; host generation switch at turn boundary" },
      antigravity: { mode: "host-alternative", evidence: "source" },
      "api-loop": { mode: "host-equivalent", evidence: "source", note: "host owns the whole context and its generations" },
      "local-loop": { mode: "host-equivalent", evidence: "source", note: "host owns the whole context and its generations" },
    },
  },
  {
    featureId: "subscription-quota", semanticsVersion: 1, executorOwner: "executor", contextOwner: "native",
    requiredHostPorts: [], surfaces: [],
    connections: {
      "codex-app-server": { mode: "provider-only", evidence: "source" }, "claude-print": { mode: "provider-only", evidence: "source" },
      acp: { mode: "provider-only", evidence: "source" }, antigravity: { mode: "provider-only", evidence: "source" },
      "api-loop": { mode: "unavailable", evidence: "source", note: "API keys bill per request" }, "local-loop": { mode: "unavailable", evidence: "source" },
    },
  },
];

const BY_ID = new Map(FEATURE_MODULES.map((feature) => [feature.featureId, feature]));

export function featureModule(featureId: string): FeatureModule | null {
  const feature = BY_ID.get(featureId) ?? null;
  if (feature) registerDeclaredPromptModule(HARNESS_FEATURE_DESCRIPTION_FORMULA.module);
  return feature;
}

/** How one feature connects for one runtime kind; null when the feature is not declared. */
export function featureConnection(featureId: string, runtimeKind: string): (FeatureConnection & { family: ExecutorFamily }) | null {
  const feature = BY_ID.get(featureId);
  if (!feature) return null;
  const family = executorFamily(runtimeKind);
  return { family, ...feature.connections[family] };
}

/** True when this runtime's executor family provides the feature natively (the executor ACKs the meaning itself). */
export function featureIsNative(featureId: string, runtimeKind: string): boolean {
  return featureConnection(featureId, runtimeKind)?.mode === "native";
}
