// Host-facts overlay for every generation switch (docs/2026-10-13-native-harness 07 G07/G11, 05 session architecture).
//
// A new generation (CLI thread rotation, API/serving/local stable-history rebuild) starts from a bounded history plus,
// sometimes, a model-made digest. Facts that must survive the switch must NOT depend on that summary, so the HOST writes
// them from its own stores and the next generation reads them ahead of any summary: which effects are still unconfirmed
// (never "done"), which permissions are in force (ids/scopes only), where the history frontier stands (digest), and which
// Goal revision / plan node / Toolchain release this conversation is serving. The overlay also says whether the new
// generation resumes a native session or replays host history; the two are different and are never conflated.
//
// Pure assembly + injectable sources: no electron import, no module-level store require (the daemon switches too).
import { createHash } from "node:crypto";
import type { ChatHistoryEntry } from "../../shared/types";
import { boundHandoffHistory, recordRotationReceipt, type RotationReason, type ThreadHealth } from "./session-rotation";

export const HANDOFF_FACTS_SCHEMA = "agentlas.handoff-facts.v1";
/** How many of the last delivered history items the frontier digest covers. */
export const FRONTIER_DIGEST_ITEMS = 8;
const MAX_UNCERTAIN = 20, MAX_GRANTS = 40, MAX_NODES = 8;

/** native-resume: the runtime's own session/thread continues. host-replay: a fresh session seeded from Agentlas history. */
export type HandoffKind = "native-resume" | "host-replay";

/**
 * How a fact family was read (native-harness notyet NH13): `observed` = read in full, `partial` = read but only the first
 * entries are carried, `unavailable` = the lookup failed or its store is absent. Unavailable is unknown, never "none".
 */
export type HostFactStatus = "observed" | "partial" | "unavailable";

export interface HostFacts {
  schema: typeof HANDOFF_FACTS_SCHEMA;
  chatId: string | null;
  runtime: string | null;
  kind: HandoffKind;
  fromGeneration: number | string | null;
  toGeneration: number | string | null;
  reason: RotationReason | "none";
  frontierDigest: string;
  frontierItems: number;
  /** Always state "uncertain": an unconfirmed effect is never reported as done across a generation switch. */
  uncertainEffects: Array<{ ref: string; tool: string; state: "uncertain"; at: string }>;
  /** Ids and scopes only: no pattern, no command text, no credential-bearing field. */
  activeGrants: Array<{ id: number; capability: string; decision: "allow" | "deny"; scope: string; permission?: "read" | "write" | "full" }>;
  goal: { goalId: string; revision: number | null; activeNodes: string[] } | null;
  toolchain: { id: string; release: string } | null;
  /** Read status per family and the totals behind a partial list. Absent on facts captured before NH13. */
  status?: { uncertainEffects: HostFactStatus; grants: HostFactStatus; goal: HostFactStatus | "not-requested" };
  totals?: { uncertainEffects: number | null; grants: number | null };
}

export interface HostFactsSources {
  uncertainEffects?: (chatId: string | null) => Promise<Array<{ ref: string; tool: string; at: string }>> | Array<{ ref: string; tool: string; at: string }>;
  /** All grants that apply (not truncated); the collector carries the first ones and reports the rest as partial. */
  grants?: (chatId: string | null, agentId: string | null) => HostFacts["activeGrants"];
  goal?: (goalId: string) => HostFacts["goal"];
}

export interface HostFactsInput {
  chatId?: string | null;
  agentId?: string | null;
  runtime?: string | null;
  kind: HandoffKind;
  fromGeneration?: number | string | null;
  toGeneration?: number | string | null;
  reason?: RotationReason;
  /** The history the previous generation had been delivered (frontier = its last items). */
  deliveredHistory: ChatHistoryEntry[];
  goalId?: string | null;
  toolchain?: { id: string; release: string } | null;
  sources?: HostFactsSources;
}

/** Hash of the last delivered items (role + id + text). Identical history => identical digest; one more item => different. */
export function frontierDigest(history: ChatHistoryEntry[]): { digest: string; items: number } {
  const tail = history.filter((row) => row.role !== "system").slice(-FRONTIER_DIGEST_ITEMS);
  const hash = createHash("sha256");
  for (const row of tail) hash.update(row.role).update("\0").update(row.id ?? "").update("\0").update(row.text ?? "").update("\u0001");
  return { digest: `sha256:${hash.digest("hex").slice(0, 16)}`, items: tail.length };
}

function defaultSources(): Required<HostFactsSources> {
  return {
    // A lookup that fails throws: the collector records the family as unavailable, never as an empty "none".
    uncertainEffects: async (chatId) => {
      const ledger = await import("../harness/effect-ledger");
      const rows = await ledger.uncertainEffects(chatId);
      const readError = ledger.effectLedgerReadError();
      if (readError) throw new Error(`effect_ledger_unreadable:${readError}`);
      return rows;
    },
    grants: (chatId, agentId) => {
      const { listCapabilityGrants } = require("../store/capability-grants") as typeof import("../store/capability-grants");
      return grantSummary(listCapabilityGrants(), chatId, agentId, Number.POSITIVE_INFINITY);
    },
    goal: (goalId) => {
      const { getChatGoalRevision } = require("../store/chat-goals") as typeof import("../store/chat-goals");
      const { readGoalPlan } = require("../store/goal-plans") as typeof import("../store/goal-plans");
      const plan = readGoalPlan(goalId);
      const nodes = plan ? [...plan.strategies, ...plan.tactics].filter((n) => (n as { status?: string }).status === "active").map((n) => n.id) : [];
      return { goalId, revision: getChatGoalRevision(goalId)?.revision ?? plan?.revision ?? null, activeNodes: nodes.slice(0, MAX_NODES) };
    },
  };
}

/** Reduce grant rows to id/capability/decision/scope. Rows scoped to another chat or agent are not carried. */
export function grantSummary(
  rows: Array<{ id: number; capability: string; decision: "allow" | "deny"; scope: string; binding?: { permissionScope: "read" | "write" | "full" } }>,
  chatId: string | null, agentId: string | null, limit = MAX_GRANTS,
): HostFacts["activeGrants"] {
  return rows
    .filter((row) => row.scope === "global" || row.scope.startsWith("consent:v1:")
      || (chatId !== null && row.scope === `chat:${chatId}`) || (agentId !== null && row.scope === `agent:${agentId}`))
    .slice(0, limit)
    .map((row) => ({ id: row.id, capability: row.capability.slice(0, 64), decision: row.decision, scope: row.scope.slice(0, 32),
      ...(row.binding ? { permission: row.binding.permissionScope } : {}) }));
}

/** Produced by host code from host stores; never from a model summary. */
export async function collectHostFacts(input: HostFactsInput): Promise<HostFacts> {
  const defaults = defaultSources();
  const src = { ...defaults, ...(input.sources ?? {}) };
  const chatId = input.chatId ?? null, agentId = input.agentId ?? null;
  const frontier = frontierDigest(input.deliveredHistory);
  // A failed or malformed lookup is "unavailable" (unknown), never an observed empty list; a list longer than what is
  // carried is "partial" with its total.
  let uncertain: Array<{ ref: string; tool: string; at: string }> = [];
  let uncertainStatus: HostFactStatus = "observed";
  try {
    const rows = await src.uncertainEffects(chatId);
    if (!Array.isArray(rows)) throw new Error("uncertain_effects_not_a_list");
    uncertain = rows;
  } catch { uncertain = []; uncertainStatus = "unavailable"; }
  if (uncertainStatus === "observed" && uncertain.length > MAX_UNCERTAIN) uncertainStatus = "partial";
  let grants: HostFacts["activeGrants"] = [];
  let grantStatus: HostFactStatus = "observed";
  try {
    const rows = src.grants(chatId, agentId);
    if (!Array.isArray(rows)) throw new Error("grants_not_a_list");
    grants = rows;
  } catch { grants = []; grantStatus = "unavailable"; }
  if (grantStatus === "observed" && grants.length > MAX_GRANTS) grantStatus = "partial";
  let goal: HostFacts["goal"] = null;
  let goalStatus: HostFactStatus | "not-requested" = "not-requested";
  if (input.goalId) {
    try {
      goal = src.goal(input.goalId);
      if (!goal) throw new Error("goal_not_found");
      goalStatus = "observed";
    } catch { goal = { goalId: input.goalId, revision: null, activeNodes: [] }; goalStatus = "unavailable"; }
  }
  return {
    schema: HANDOFF_FACTS_SCHEMA, chatId, runtime: input.runtime ?? null, kind: input.kind,
    fromGeneration: input.fromGeneration ?? null, toGeneration: input.toGeneration ?? null, reason: input.reason ?? "none",
    frontierDigest: frontier.digest, frontierItems: frontier.items,
    // Whatever the source said, the state carried across is "uncertain".
    uncertainEffects: uncertain.slice(0, MAX_UNCERTAIN).map((e) => ({ ref: e.ref, tool: e.tool, state: "uncertain" as const, at: e.at })),
    activeGrants: grants.slice(0, MAX_GRANTS),
    goal, toolchain: input.toolchain ?? null,
    status: { uncertainEffects: uncertainStatus, grants: grantStatus, goal: goalStatus },
    totals: { uncertainEffects: uncertainStatus === "unavailable" ? null : uncertain.length, grants: grantStatus === "unavailable" ? null : grants.length },
  };
}

/** One fact family's value: "unavailable" is unknown (never "none"); a partial list states how many it carries. */
function factList(items: string[], status: HostFactStatus | undefined, total: number | null | undefined): string {
  if (status === "unavailable") return "unavailable (lookup failed: unknown, not none)";
  const listed = items.length === 0 ? "none" : items.join("; ");
  return status === "partial" && typeof total === "number" ? `${listed} (first ${items.length} of ${total})` : listed;
}

/**
 * The compact key: value block the next generation sees ahead of any model summary. No prose that could be read as an
 * instruction; the line after the heading states precedence.
 */
export function renderHostFacts(facts: HostFacts): string {
  // Composition order: fixed → variable (docs/PROMPT-COMPOSITION-POLICY.md, ledger desktop.main.handoff.host-facts).
  const lines = [
    "[HOST FACTS]",
    "precedence: these host-recorded facts override any summary below; an uncertain effect is not done until a read tool confirms it.",
    `schema: ${facts.schema}`,
    `handoff: ${facts.kind}${facts.kind === "native-resume" ? " (runtime session continues)" : " (fresh session seeded from host history; runtime memory not carried)"}`,
    `generation: ${facts.fromGeneration ?? "?"} -> ${facts.toGeneration ?? "?"}${facts.reason !== "none" ? ` (${facts.reason})` : ""}`,
    `frontier: ${facts.frontierDigest} (last ${facts.frontierItems} delivered items)`,
    `uncertain_effects: ${factList(facts.uncertainEffects.map((e) => `${e.tool}#${e.ref.slice(0, 8)}=uncertain@${e.at}`),
      facts.status?.uncertainEffects, facts.totals?.uncertainEffects)}`,
    `grants: ${factList(facts.activeGrants.map((g) => `#${g.id}:${g.capability}:${g.decision}:${g.scope}${g.permission ? `:${g.permission}` : ""}`),
      facts.status?.grants, facts.totals?.grants)}`,
    `goal: ${facts.goal ? facts.status?.goal === "unavailable" ? `${facts.goal.goalId} unavailable (lookup failed: unknown, not none)`
      : `${facts.goal.goalId} rev=${facts.goal.revision ?? "?"} active=${facts.goal.activeNodes.join(",") || "none"}` : "none"}`,
    `toolchain: ${facts.toolchain ? `${facts.toolchain.id} release=${facts.toolchain.release}` : "none"}`,
  ];
  return lines.join("\n");
}

/** Facts block first, then the model/excerpt summary. The summary text itself is never edited. */
export function withHostFactsAhead(factsBlock: string, summary: string | null | undefined): string {
  return summary && summary.trim() ? `${factsBlock}\n\n${summary}` : factsBlock;
}

/**
 * Put the facts ahead of a handoff history. The block rides as the first entry's text prefix when that entry is a user
 * row, otherwise as a new leading user row; the delivered rows are otherwise untouched, so no input is duplicated or
 * reordered (the last user message appears exactly once).
 */
export function historyWithHostFacts(history: ChatHistoryEntry[], factsBlock: string, createdAt = new Date(0).toISOString()): ChatHistoryEntry[] {
  const [first, ...rest] = history;
  if (first && first.role === "user") return [{ ...first, text: `${factsBlock}\n\n${first.text}` }, ...rest];
  const lead: ChatHistoryEntry = { id: "host-facts", role: "user", text: factsBlock, createdAt };
  return [lead, ...history];
}

/**
 * G07: the one generation-ledger record, written the same way for CLI thread rotations, API/serving stable-history
 * rebuilds and local-model rebuilds. `previousSessionId` is the CLI thread id, or `api:<chatId>:g<n>` for a stateless
 * runtime (no provider session; Agentlas keeps the "session").
 */
export function recordGenerationSwitch(input: {
  chatId: string; runtime: string; previousSessionId: string; reason: RotationReason; facts?: HostFacts | null;
  reportedInputTokens?: number | null; health?: ThreadHealth | null; rotatedAt?: string;
}): boolean {
  return recordRotationReceipt({
    schemaVersion: "agentlas.runtime-thread-rotation.v1", chatId: input.chatId, previousThreadId: input.previousSessionId,
    reasons: [input.reason], health: input.health ?? null, reportedInputTokens: input.reportedInputTokens ?? null,
    rotatedAt: input.rotatedAt ?? new Date().toISOString(), runtime: input.runtime, ...(input.facts ? { facts: input.facts } : {}),
  });
}

/** Ledger id for a stateless (API/serving/local) generation: stable per chat + generation number. */
export const statelessSessionId = (runtime: string, chatId: string, generation: number | string): string => `${runtime}:${chatId}:g${generation}`;

type MetaApi = { getMeta(key: string): string | null; setMeta(key: string, value: string): void };
function meta(): MetaApi | null {
  try { return require("../store/meta") as MetaApi; } catch { return null; }
}
const generationKey = (runtime: string, chatId: string): string => `runtime-generation:${runtime}:${chatId}`;

export interface StatelessGenerationRecord { generation: number; capturedAt: string; facts: HostFacts }

/** The facts captured when this stateless conversation last switched generation (null before its first switch). */
export function readStatelessGeneration(runtime: string, chatId: string): StatelessGenerationRecord | null {
  try {
    const raw = meta()?.getMeta(generationKey(runtime, chatId));
    const v = raw ? JSON.parse(raw) as StatelessGenerationRecord : null;
    return v && typeof v.generation === "number" && v.facts?.schema === HANDOFF_FACTS_SCHEMA ? v : null;
  } catch { return null; }
}

/**
 * G07 for API / serving / local runtimes. `generations` is stableHistoryWindow(...).generations (how many times the
 * handoff was rebuilt walking the journal). When it exceeds the last recorded generation, the switch is recorded ONCE
 * through the same recorder as a CLI rotation and the host facts are captured and stored. Every later turn of the same
 * generation re-renders the stored block, so the prefix stays byte-stable (provider/KV cache keeps hitting) and no
 * input is added twice. Returns the block to put ahead of the stable digest, or null when no switch has happened.
 */
export async function noteStatelessGeneration(input: {
  chatId: string; runtime: string; generations: number; deliveredHistory: ChatHistoryEntry[];
  agentId?: string | null; goalId?: string | null; toolchain?: HostFactsInput["toolchain"]; sources?: HostFactsSources;
  reason?: RotationReason; now?: string;
}): Promise<{ switched: boolean; block: string | null; facts: HostFacts | null }> {
  const prior = readStatelessGeneration(input.runtime, input.chatId);
  if (input.generations <= 0) return { switched: false, block: null, facts: null };
  if (prior && prior.generation >= input.generations) return { switched: false, block: renderHostFacts(prior.facts), facts: prior.facts };
  const facts = await collectHostFacts({ chatId: input.chatId, agentId: input.agentId, runtime: input.runtime, kind: "host-replay",
    fromGeneration: prior?.generation ?? 0, toGeneration: input.generations, reason: input.reason ?? "context_ratio",
    deliveredHistory: input.deliveredHistory, goalId: input.goalId, toolchain: input.toolchain, sources: input.sources });
  recordGenerationSwitch({ chatId: input.chatId, runtime: input.runtime, reason: facts.reason === "none" ? "context_ratio" : facts.reason, facts,
    previousSessionId: statelessSessionId(input.runtime, input.chatId, prior?.generation ?? 0), rotatedAt: input.now });
  try {
    meta()?.setMeta(generationKey(input.runtime, input.chatId),
      JSON.stringify({ generation: input.generations, capturedAt: input.now ?? new Date().toISOString(), facts } satisfies StatelessGenerationRecord));
  } catch { /* the receipt is the record; a lost pointer re-captures on the next turn */ }
  return { switched: true, block: renderHostFacts(facts), facts };
}

/**
 * CLI rotation (codex today; any CLI that rotates a thread): record the generation switch and return the bounded handoff
 * history with the host facts ahead of it. Facts are computed from the FULL pre-bound history (what the old thread was
 * delivered), the bounded rows are the same rows the old code sent, so nothing is added twice or reordered.
 */
export async function prepareRotationHandoff(input: {
  chatId: string; runtime: string; previousThreadId: string; reason: RotationReason; history: ChatHistoryEntry[];
  kind?: HandoffKind; fromGeneration?: number | string | null; toGeneration?: number | string | null;
  health?: ThreadHealth | null; reportedInputTokens?: number | null; agentId?: string | null; goalId?: string | null;
  toolchain?: HostFactsInput["toolchain"]; sources?: HostFactsSources;
}): Promise<{ history: ChatHistoryEntry[]; facts: HostFacts }> {
  const facts = await collectHostFacts({ chatId: input.chatId, agentId: input.agentId, runtime: input.runtime, kind: input.kind ?? "host-replay",
    fromGeneration: input.fromGeneration ?? input.previousThreadId, toGeneration: input.toGeneration ?? "next", reason: input.reason,
    deliveredHistory: input.history, goalId: input.goalId, toolchain: input.toolchain, sources: input.sources });
  recordGenerationSwitch({ chatId: input.chatId, runtime: input.runtime, previousSessionId: input.previousThreadId, reason: input.reason,
    facts, health: input.health, reportedInputTokens: input.reportedInputTokens });
  return { history: historyWithHostFacts(boundHandoffHistory(input.history), renderHostFacts(facts)), facts };
}
