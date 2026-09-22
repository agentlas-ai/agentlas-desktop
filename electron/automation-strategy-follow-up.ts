/**
 * Host-only evidence for the second half of the strategy loop.
 *
 * A strategy revision is not evidence that the next run used it. The graph
 * runner already emits a digest-bound `automation_strategy_revision_consumed`
 * event; this module reduces that event together with host-observed run facts
 * into a small, content-free follow-up receipt. It deliberately does not
 * invoke a model, provider, browser, or mutation adapter.
 */

export interface AutomationStrategyRunEventLike {
  kind: string;
  nodeId?: string;
  payload?: Record<string, unknown>;
}

export interface AutomationStrategyToolActivityLike {
  callCount: number;
  toolNames: readonly string[];
}

export type AutomationStrategyRunMetricsCoverageV1 =
  | "complete"
  | "truncated"
  | "unavailable"
  /** Legacy receipts written before the host started recording coverage. */
  | "unknown";

export interface AutomationStrategyConsumedRevisionV1 {
  revision: number;
  sourceRunId: string;
  strategyDigest: string | null;
  graphDigest: string | null;
  definitionDigest: string | null;
}

export interface AutomationStrategyRunMetricsV1 {
  schemaVersion: "agentlas.automation-strategy-run-metrics.v1";
  /**
   * `complete` is required before event-derived counts or revision consumption
   * can be used as follow-up evidence. A bounded prefix is never presented as
   * a complete run when the ledger read was truncated or unavailable.
  */
  coverage: AutomationStrategyRunMetricsCoverageV1;
  /** Coverage of the separate bounded host tool-activity read. */
  toolActivityCoverage: AutomationStrategyRunMetricsCoverageV1;
  toolCallCount: number;
  toolNames: string[];
  completedNodeCount: number;
  failedNodeCount: number;
  occurrenceId: string | null;
  nextRunAt: string | null;
  consumedRevision: AutomationStrategyConsumedRevisionV1 | null;
}

export interface AutomationStrategyRunSummaryV1 {
  metrics: AutomationStrategyRunMetricsV1;
  consumedRevision: AutomationStrategyConsumedRevisionV1 | null;
}

export interface AutomationStrategyFollowUpEvidenceV1 {
  schemaVersion: "agentlas.automation-strategy-follow-up.v1";
  automationId: string;
  runId: string;
  sourceRunId: string;
  consumedRevision: number;
  strategyDigest: string | null;
  occurrenceId: string | null;
  metrics: AutomationStrategyRunMetricsV1;
  nextRunAt: string | null;
  observedAt: string;
}

const MAX_EVENT_COUNT = 500;
/**
 * The strategy scheduler fetches only the relevant event kinds and one
 * sentinel row beyond the reducer's bounded window. This avoids the generic
 * run-event reader's 500-row cap hiding a late revision event.
 */
export const AUTOMATION_STRATEGY_RUN_EVENT_QUERY_LIMIT = MAX_EVENT_COUNT + 1;
const MAX_TOOL_NAMES = 20;
const MAX_TOOL_NAME_CHARS = 120;
const MAX_ID_CHARS = 512;
const MAX_OCCURRENCE_CHARS = 240;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

function boundedCount(value: unknown, ceiling: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? Math.min(ceiling, value as number)
    : 0;
}

function boundedId(value: unknown, ceiling = MAX_ID_CHARS): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > ceiling || value.includes("\0")) return null;
  return value;
}

function digestOrNull(value: unknown): string | null {
  return typeof value === "string" && DIGEST_RE.test(value) ? value : null;
}

function dateOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function consumedRevisionFromEvent(event: AutomationStrategyRunEventLike): AutomationStrategyConsumedRevisionV1 | null {
  if (event.kind !== "automation_strategy_revision_consumed") return null;
  const payload = event.payload;
  if (!payload || payload.status !== "consumed") return null;
  const revision = payload.revision;
  const sourceRunId = boundedId(payload.sourceRunId);
  if (!Number.isSafeInteger(revision) || (revision as number) < 1 || !sourceRunId) return null;
  return {
    revision: revision as number,
    sourceRunId,
    strategyDigest: digestOrNull(payload.strategyDigest),
    graphDigest: digestOrNull(payload.revisionGraphDigest),
    definitionDigest: typeof payload.revisionDefinitionDigest === "string"
      && /^[a-f0-9]{64}$/u.test(payload.revisionDefinitionDigest)
      ? payload.revisionDefinitionDigest
      : null,
  };
}

/**
 * Reduce only host-written event fields. Later state events win, so a retry
 * does not inflate the completed/failed node counts.
 */
export function summarizeAutomationStrategyRun(
  events: readonly AutomationStrategyRunEventLike[],
  activity: AutomationStrategyToolActivityLike,
  nextRunAt: string | null | undefined,
  options: {
    eventWindowCoverage?: Exclude<AutomationStrategyRunMetricsCoverageV1, "unknown">;
    toolActivityCoverage?: Exclude<AutomationStrategyRunMetricsCoverageV1, "unknown">;
  } = {},
): AutomationStrategyRunSummaryV1 {
  const coverage = options.eventWindowCoverage
    ?? (events.length >= MAX_EVENT_COUNT ? "truncated" : "complete");
  const toolActivityCoverage = options.toolActivityCoverage ?? "complete";
  const nodeStates = new Map<string, string>();
  let occurrenceId: string | null = null;
  let consumedRevision: AutomationStrategyConsumedRevisionV1 | null = null;
  for (const event of events.slice(0, MAX_EVENT_COUNT)) {
    if (event.kind === "workflow_graph_started") {
      const candidate = boundedId(event.payload?.occurrenceId, MAX_OCCURRENCE_CHARS);
      if (candidate) occurrenceId = candidate;
    }
    if (event.kind === "workflow_node_state" && event.nodeId && typeof event.payload?.state === "string") {
      nodeStates.set(event.nodeId, event.payload.state);
    }
    const consumed = consumedRevisionFromEvent(event);
    if (consumed) consumedRevision = consumed;
  }
  const toolNames = [...new Set((activity.toolNames ?? [])
    .filter((name): name is string => typeof name === "string" && name.length > 0 && name.length <= MAX_TOOL_NAME_CHARS)
    .slice(0, MAX_TOOL_NAMES))];
  const metrics: AutomationStrategyRunMetricsV1 = {
    schemaVersion: "agentlas.automation-strategy-run-metrics.v1",
    coverage,
    toolActivityCoverage,
    toolCallCount: boundedCount(activity.callCount, MAX_EVENT_COUNT),
    toolNames,
    completedNodeCount: [...nodeStates.values()].filter((state) => state === "done").length,
    failedNodeCount: [...nodeStates.values()].filter((state) => state === "failed").length,
    // A truncated prefix may contain an earlier occurrence or revision, but
    // it cannot prove that the latest event did not replace it. Keep those
    // fields explicitly absent instead of presenting stale state as current.
    occurrenceId: coverage === "complete" ? occurrenceId : null,
    nextRunAt: dateOrNull(nextRunAt),
    consumedRevision: coverage === "complete" ? consumedRevision : null,
  };
  return { metrics, consumedRevision: metrics.consumedRevision };
}

/**
 * Build a durable follow-up only when the current run consumed a prior
 * revision. The caller records the returned value with a sourceEventId tied to
 * this run, making retries idempotent while leaving the run result untouched.
 */
export function buildAutomationStrategyFollowUpEvidence(input: {
  automationId: string;
  runId: string;
  events: readonly AutomationStrategyRunEventLike[];
  activity: AutomationStrategyToolActivityLike;
  nextRunAt: string | null | undefined;
  observedAt?: string;
  eventWindowCoverage?: Exclude<AutomationStrategyRunMetricsCoverageV1, "unknown">;
  toolActivityCoverage?: Exclude<AutomationStrategyRunMetricsCoverageV1, "unknown">;
}): AutomationStrategyFollowUpEvidenceV1 | null {
  const automationId = boundedId(input.automationId);
  const runId = boundedId(input.runId);
  if (!automationId || !runId) return null;
  const summary = summarizeAutomationStrategyRun(input.events, input.activity, input.nextRunAt, {
    ...(input.eventWindowCoverage ? { eventWindowCoverage: input.eventWindowCoverage } : {}),
    ...(input.toolActivityCoverage ? { toolActivityCoverage: input.toolActivityCoverage } : {}),
  });
  if (summary.metrics.coverage !== "complete" || summary.metrics.toolActivityCoverage !== "complete") return null;
  const consumed = summary.consumedRevision;
  if (!consumed) return null;
  const observedAt = dateOrNull(input.observedAt ?? new Date().toISOString());
  if (!observedAt) return null;
  return {
    schemaVersion: "agentlas.automation-strategy-follow-up.v1",
    automationId,
    runId,
    sourceRunId: consumed.sourceRunId,
    consumedRevision: consumed.revision,
    strategyDigest: consumed.strategyDigest,
    occurrenceId: summary.metrics.occurrenceId,
    metrics: summary.metrics,
    nextRunAt: summary.metrics.nextRunAt,
    observedAt,
  };
}
