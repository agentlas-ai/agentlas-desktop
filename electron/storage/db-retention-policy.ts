/**
 * The typed retention policy of the Desktop SQLite store (agentlas.sqlite) and the memory store attached to it
 * (memory.sqlite, `agentlas_memory`). One table, declared here, enforced by db-retention.ts. Owner complaint:
 * "the DB keeps piling up" (agentlas.sqlite 3.37 GB, memory.sqlite 2.55 GB on the owner's Mac).
 *
 * Every row says: what is written, by whom, who reads it, what stays, and the evidence. A table or kind that is not listed
 * is kept as it is; a new unbounded writer adds its row here, with the reader list that justifies it
 * (scripts/test-db-retention.cjs pins the rows below and that each one carries writer, readers and evidence).
 *
 * Shape of the decisions
 * - `keep-forever`        receipts, ledgers, owner-visible history, anything a receipt cites.
 * - `delete-settled`      rows of a run that has been quiet for `days`; the run keeps its result, cost and error summary.
 * - `compact-payload`     the row stays (ids, seq, digest, event ids stay citeable); only the part no reader uses is replaced
 *                         by a short digest marker, and the fields a reader tests for presence are kept present.
 * - `keep-newest-per-key` older rows of a key that no reader can reach.
 * - `vacuum`              returns freed pages to the file system (deletes alone leave the file as large as before).
 */

/** The only host that runs the retention job. The daemon and the terminal engine are followers of this store. */
export const DB_RETENTION_HOST = "desktop-main" as const;

export type DbRetentionAction =
  | { type: "keep-forever" }
  | { type: "delete-settled"; days: number; abandonedDays: number }
  | { type: "compact-payload"; days: number; /** Rows without a clock: old when this many entries behind their journal head. */ behindHeadEntries?: number }
  | { type: "keep-newest-per-key"; keepRows: number; days?: number }
  | { type: "delete-all" }
  | { type: "delete-closed"; spec: ClosedRowSpec }
  | { type: "vacuum"; minFreeBytes: number; minFreeRatio: number };

/**
 * Rows of a delivery/ledger table whose work is over: removed `days` after their last clock value, in batches, children first.
 * A row is deleted only when ALL of these hold: its state is in `closedStates`, `closedWhen` holds, none of `keepWhen` holds and
 * every `timeColumns` value is older than the cutoff (NULL counts as old). The same predicate is the WHERE of the DELETE, so a
 * row that a daemon or Main moved back to work between the look and the delete is not touched.
 */
export interface ClosedRowSpec {
  days: number;
  /** "iso": TEXT ISO-8601 timestamps; "ms": INTEGER epoch milliseconds. */
  timeUnit: "iso" | "ms";
  stateColumn: string;
  closedStates: readonly string[];
  /** Extra SQL over the table alias `t` that says the row is reported/closed (not just in a final state). */
  closedWhen?: string;
  /** Rows kept while one of these holds (SQL over `t`); a clause whose `table` is missing from the store is skipped. */
  keepWhen?: ReadonlyArray<{ table: string; sql: string }>;
  timeColumns: readonly string[];
  /** Rows of other tables that belong to the doomed row; deleted first, in the same transaction. */
  children?: ReadonlyArray<{ table: string; column: string; parentColumn: string }>;
  /** Columns of the table the spec reads; a store that lacks one is an older shape and the table is left alone. */
  requires: readonly string[];
}

export interface DbRetentionRule {
  /** Stable id; the maintenance report and the lease use it. */
  id: string;
  /** Store table the rule is about. */
  table: string;
  /** Row kinds (run_events.kind, agent_context_entries.kind) the rule covers; empty for the whole table. */
  kinds: readonly string[];
  /** Observed on a real store (table + indexes where the rule trims them), in MB. */
  observedMb: number;
  action: DbRetentionAction;
  writer: string;
  readers: string;
  evidence: string;
}

const DAY = 1;

/** Checkpoints kept per namespace: the head and the one it replaced. Shared by the writer and the job. */
export const SESSION_CHECKPOINTS_KEPT = 2;

export const DB_RETENTION_POLICY: readonly DbRetentionRule[] = [
  {
    id: "run_events.chat-call-detail",
    table: "run_events",
    kinds: ["mcp_tool-use", "mcp_notice", "mcp_reasoning", "mcp_thinking"],
    observedMb: 275 + 14,
    action: { type: "delete-settled", days: 3 * DAY, abandonedDays: 30 * DAY },
    writer: "store/run-events.ts recordRunEvent (kind mcp_tool-use / mcp_notice / mcp_reasoning), one row per tool call and per notice",
    readers: "live run view and Goal facts while the run is open (agi/goal-facts.ts, active/blocked Goal chats are excluded); "
      + "revision comparison reads the per-run toolSummary that run-detail-summary.ts keeps on agent_revision_run_finished BEFORE the rows go",
    evidence: "storage/run-detail-retention.ts already deletes these after 3 days, but only walks terminal markers forward from a saved "
      + "watermark: 164,376 rows of settled runs older than 3 days were still in the owner store (the watermark had passed them) and a run "
      + "without invoke_completed/failed/result was never settled (130 runs, 9,646 rows). Running the legacy pass from watermark zero on an "
      + "APFS clone deleted 164,376 rows in 31 s. The sweep is row-driven and self-draining, so a rule change or a late-settling run cannot be skipped.",
  },
  {
    id: "run_events.automation-call-detail",
    table: "run_events",
    kinds: ["mcp_tool-use", "mcp_notice"],
    observedMb: 231,
    action: { type: "compact-payload", days: 3 * DAY },
    writer: "store/run-events.ts recordRunEvent for automation runs",
    readers: "graph resume compares a node's toolArgs with the previous run before it re-sends an external action (kept)",
    evidence: "run-detail-retention.ts compactAutomationDetail: 80,227 of 82,502 automation call rows already carry detailCompacted. "
      + "No change; the legacy pass is the executor.",
  },
  {
    id: "run_events.one_domain_event.run.step_changed",
    table: "run_events",
    kinds: ["one_domain_event"],
    observedMb: 196 + 120,
    action: { type: "keep-newest-per-key", keepRows: 500, days: 7 * DAY },
    writer: "invocation/service.ts recordObservableRunStep -> one/domain-events.ts recordOneDomainEvent, 243,653 rows (one per tool step and status)",
    readers: "listOneDomainEvents(entity, <=500) newest first, read by workspace-projection, task-projection, value-closure, "
      + "completion-suggestion-producer, accepted-result-value-closure, artifact-preview; none of them reads a step older than the newest 500 events of its entity",
    evidence: "Every reader caps at 500 rows by seq DESC (one/domain-events.ts:132). The step flood pushed the real events (run.started, "
      + "task.state_changed, receipt.recorded) OUT of that window for the 6 entities with 6k-77k events (one task: 77,474 events, 62.8 MB). "
      + "Deleting step rows outside the newest 500 only widens what a reader sees. All other event types (about 14 MB) are receipts and stay.",
  },
  {
    id: "run_events.one_domain_event.other",
    table: "run_events",
    kinds: ["one_domain_event"],
    observedMb: 14,
    action: { type: "keep-forever" },
    writer: "one/domain-events.ts",
    readers: "value-closure, briefing dismissal feedback (listOneDomainEventsByType), improvement proof",
    evidence: "task.state_changed 7,577, receipt.recorded 3,610, run.started 3,995, briefing.* 2,373: 14 MB, owner-visible history and cited receipts.",
  },
  {
    id: "run_events.ledgers",
    table: "run_events",
    kinds: [
      "automation_scheduler_terminal", "runtime_effect_boundary", "runtime_adapter_effect_started", "runtime_adapter_effect_completed",
      "model_call_ledger", "invoke_started", "invoke_result", "invoke_completed", "invoke_failed", "mcp_final", "mcp_error",
      "agent_revision_run_finished", "runtime_usage_started", "runtime_usage_recorded", "workflow_node_state", "goal_result_presentation",
    ],
    observedMb: 35 + 35 + 21 + 22 + 25,
    action: { type: "keep-forever" },
    writer: "automation-scheduler.ts, effect-boundary-reader.ts, runtime adapters, model-call ledger",
    readers: "terminal receipts, effect ledger (outward-effect), accounting, resume, phone sync, Goal evidence",
    evidence: "automation_scheduler_terminal payload is the run's terminal receipt with its output; runtime_effect_boundary lists every outward effect "
      + "of a run (operations[].outcome). Both are cited by receipts. The remaining kinds are each under 8 MB.",
  },
  {
    id: "run_events.host-recovery-claim",
    table: "run_events",
    kinds: ["host_recovery_requested", "host_recovery_start", "host_recovery_link", "host_recovery_outcome"],
    observedMb: 0,
    action: { type: "keep-forever" },
    writer: "invocation/host-recovery.ts: one claim row per internal failure that is retried (host_recovery_requested, with a restart-data object `replay` of at most 16 KB: "
      + "settings, hashes and attachment ids, never a copy of the owner's words or image bytes), one start claim and one link/outcome row",
    readers: "the claim is the at-most-once marker (hostRecoveryRequested); the boot sweep (sweepOrphanedHostRecoveries) reads `replay` to start the retry again after a restart; "
      + "supersession of the failed attempt reads the link and outcome rows",
    evidence: "The rows themselves are a few hundred bytes and one set per failed owner turn. `replay` is removed by dropHostRecoveryReplay when the recovery closes "
      + "(outcome row) and by the boot sweep for any claim older than HOST_RECOVERY_KEEP_DAYS, so the large part lives for as long as the claim is actionable. "
      + "A retry that failed inside the app with nothing sent keeps it (parked) so the next start or update tries once more, at most twice per app version.",
  },
  {
    id: "agent_context_entries.tool",
    table: "agent_context_entries",
    kinds: ["tool"],
    observedMb: 369 + 30,
    action: { type: "compact-payload", days: 3 * DAY },
    writer: "runtime/agent-context.ts onTool: two rows per call, a start row (name, arguments) and an end row (arguments again, full result)",
    readers: "materializeAgentContextHistory (agent-context.ts:557) replays ONE ledger line per call from the LAST row of its callId: "
      + "name, isError, artifactPaths, first 160 characters of arguments, image flag, createdAt; session-checkpoints.ts:237 tests only "
      + "`payload.result === undefined` of the last row per call; materializeAttachments reads imageDataUrl",
    evidence: "result is never replayed (agent-context.ts comment: the model re-reads a result if it needs one): 200 MB of 369 MB; the start row "
      + "of a call that has an end row is never read (84,150 rows, 78.5 MB, arguments duplicated in the end row). Compaction keeps seq, event_id, "
      + "digest, name, callId, isError, artifactPaths, imageDataUrl, the first 2,048 characters of arguments and a PRESENT result marker.",
  },
  {
    id: "agent_context_entries.turn-context",
    table: "agent_context_entries",
    kinds: ["turn-context"],
    observedMb: 58,
    action: { type: "compact-payload", days: 0, behindHeadEntries: 200 },
    writer: "runtime/agent-context.ts prepareAgentContextTurn: host background text of each turn (about 20 KB each)",
    readers: "materializeAgentContextHistory skips the kind (agent-context.ts:565); acknowledgeDelivery reads payload.stableBlocks of the rows in the "
      + "delivery's own range to refresh the stable-block ACK index",
    evidence: "Comment at agent-context.ts:547: replaying every earlier turn's background re-sent the same persona once per past turn. The compacted row "
      + "keeps stableBlockHashes, which acknowledgeDelivery now reads.",
  },
  {
    id: "agent_context_entries.conversation",
    table: "agent_context_entries",
    kinds: ["message", "attachment", "system", "checkpoint-reference"],
    observedMb: 27,
    action: { type: "keep-forever" },
    writer: "runtime/agent-context.ts",
    readers: "bootstrap replay of a conversation, session handoff turnSummary, memory source citations",
    evidence: "Messages are the conversation itself (8.5 MB); attachments are replayed as images (17.8 MB, 22 rows).",
  },
  {
    id: "memory_session_checkpoints",
    table: "memory_session_checkpoints",
    kinds: [],
    observedMb: 2148,
    action: { type: "keep-newest-per-key", keepRows: SESSION_CHECKPOINTS_KEPT },
    writer: "memory/session-checkpoints.ts save (desktop) and agentlas_cloud/memory_runtime.py (terminal engine): an INSERT of a full snapshot on every save, never a replace",
    readers: "memory/session-checkpoints.ts read(): checkpoint_heads JOIN checkpoints, the HEAD row only; restore() and save() use that; "
      + "memory_runtime.py reads the head the same way. parentId is written and never followed.",
    evidence: "17,184 rows of 163 namespaces, 122 KB each, 2,148 of the 2,550 MB memory.sqlite. Only 163 are heads. Rule: the head and the newest two "
      + "rows per namespace stay; the writer now prunes inside its own transaction, the job removes the backlog and the terminal engine's rows.",
  },
  {
    id: "memory_source_versions",
    table: "memory_source_versions",
    kinds: [],
    observedMb: 145,
    action: { type: "delete-all" },
    writer: "none any more: memory/source-catalogue.ts and agentlas_cloud/memory_sources.py stopped writing it (an insert per catalogue change)",
    readers: "none: no SELECT in TypeScript or Python; the catalogue row is the current source",
    evidence: "An agent journal moved its catalogue range on every append, so each journal row added a version row: insert-only history nothing reads.",
  },
  {
    id: "run_events.indexes",
    table: "run_events",
    kinds: [],
    observedMb: 576,
    action: { type: "keep-forever" },
    writer: "store/db.ts",
    readers: "see evidence",
    evidence: "EXPLAIN QUERY PLAN on the owner clone: chat_kind_ts, agent_kind_ts, kind_ts, agent_ts (MAX(ts) WHERE agent_id) are chosen by real code queries. "
      + "idx_run_events_ts (55 MB) is chosen only by `ORDER BY ts DESC` without a leading key, which no code query issues, and "
      + "idx_run_events_automation (68 MB) loses to kind_ts for the two dominant automation queries: both are drop candidates, but a drop "
      + "needs a schema bump and a 2.9 GB pre-upgrade copy, so they wait for the next planned bump. The indexes shrink with the rows above.",
  },
  {
    id: "chat_message_attachments",
    table: "chat_message_attachments",
    kinds: [],
    observedMb: 285,
    action: { type: "keep-forever" },
    writer: "store/chat-message-attachments.ts",
    readers: "invocation/renderer-send-queue.ts, pending-chat-sends.ts (bytes by sha256), artifact-preview.ts, updater/controller.ts (profile copy)",
    evidence: "storage-policy.ts: desktop chat images are conversation content and are never removed. 846 rows, 779 distinct hashes (duplicates 9 MB). "
      + "Moving the blobs to hash-named files changes where the bytes live, not how many: it needs the three readers above, the updater profile copy "
      + "and the phone attachment path to move together, so it is a separate change.",
  },
  {
    id: "automation_runs",
    table: "automation_runs",
    kinds: [],
    observedMb: 70,
    action: { type: "keep-forever" },
    writer: "workflow/run-graph.ts: checkpoint_json of every run (14 KB each, one automation has 4,082 runs = 57.7 MB)",
    readers: "ipc.ts:6522 latest run, automation-scheduler.ts:109 rerun by occurrence, run-graph.ts:3011 and graph-dispatch.ts:180 by run id (resume)",
    evidence: "Owner-visible run history and resume by id. Not compacted here: a resume of an old failed run reads its checkpoint.",
  },
  {
    id: "long_run_events",
    table: "long_run_events",
    kinds: [],
    observedMb: 61,
    action: { type: "keep-forever" },
    writer: "store/long-runs.ts",
    readers: "Goal ledger, resume, phone sync",
    evidence: "run.task_checkpoint 13.9 MB, run.usage_recorded 8 MB, the rest under 5 MB each: Goal evidence.",
  },
  {
    id: "pending_chat_sends.closed",
    table: "pending_chat_sends",
    kinds: [],
    observedMb: 0,
    action: { type: "delete-closed", spec: {
      days: 14 * DAY, timeUnit: "ms", stateColumn: "state",
      closedStates: ["started", "failed", "gave_up", "abandoned", "uncertain", "held"],
      keepWhen: [
        { table: "invocation_followup_custody", sql: "EXISTS (SELECT 1 FROM invocation_followup_custody c WHERE c.queue_id = t.id AND c.state = 'stopped')" },
        { table: "queued_owner_inputs", sql: "EXISTS (SELECT 1 FROM queued_owner_inputs o WHERE o.queue_id = t.id AND o.state = 'active')" },
      ],
      timeColumns: ["updated_at"], requires: ["id", "state", "updated_at"],
    } },
    writer: "invocation/pending-chat-sends.ts: one row per owner message the chat could not take at once; every state change sets updated_at (epoch ms)",
    readers: "queued/starting rows only: the drain, resend-forecast, queue-retry-fact, host-recovery. held/uncertain/failed/gave_up rows are read back only through "
      + "queued-owner-input-custody.ts (active queued_owner_inputs.queue_id) and followup-custody-core.ts (stopped invocation_followup_custody.queue_id), both kept",
    evidence: "invocation/pending-chat-sends.ts:58 states; queued and starting are the only states the drain acts on (headOf, startingOf). gave_up, held (not under custody), "
      + "abandoned and uncertain are never re-queued by the queue itself (the owner may have re-sent by hand), so they are history; 14 days after their last update they go.",
  },
  {
    id: "work_session_dispatches.closed",
    table: "work_session_dispatches",
    kinds: [],
    observedMb: 0,
    action: { type: "delete-closed", spec: {
      days: 30 * DAY, timeUnit: "iso", stateColumn: "state",
      closedStates: ["completed", "failed", "cancelled", "interrupted", "uncertain"],
      closedWhen: "(t.reported_at IS NOT NULL OR t.cancel_requested = 1 OR t.report_error = 'work_session_report_abandoned:owner_stopped')",
      keepWhen: [
        { table: "work_session_dispatches", sql: "t.effect_uncertain = 1" },
        { table: "work_session_dispatches", sql: "EXISTS (SELECT 1 FROM json_each(t.steering_json) WHERE json_extract(value, '$.runId') IS NULL AND COALESCE(json_extract(value, '$.endStatus'), 'held') = 'held')" },
      ],
      timeColumns: ["updated_at", "reported_at"],
      requires: ["state", "reported_at", "cancel_requested", "report_error", "effect_uncertain", "steering_json", "updated_at"],
    } },
    writer: "work/session-dispatch.ts: one row per child session a Work conversation delegated; the row is reused when the child is steered again (reported_at reset, updated_at moved)",
    readers: "work/session-dispatch.ts view/recover/report queries (all gated on state, reported_at, cancel_requested), workSessionChildrenOf, findWorkSessionChildRun "
      + "(only for runs the dispatcher itself started, long over)",
    evidence: "work/session-dispatch.ts:509-511 reported_at, :530 owner_stopped marker, :807 other abandoned markers are revived (so only owner_stopped closes), :837 the "
      + "pending-parent query that must keep a row (unreported terminal, held steer), effect_uncertain rows await owner reconciliation. The row is deleted whole: "
      + "result_json goes with it, so no separate compaction pass is needed.",
  },
  {
    id: "one_team_dispatches.closed",
    table: "one_team_dispatches",
    kinds: [],
    observedMb: 0,
    action: { type: "delete-closed", spec: {
      days: 30 * DAY, timeUnit: "iso", stateColumn: "status",
      closedStates: ["completed", "failed", "cancelled", "interrupted"],
      closedWhen: "(t.reported_at IS NOT NULL OR t.report_error = 'owner_stopped')",
      // The row is the only thing that hides a teammate chat made before the kind=division marker (dispatch-presentation.ts
      // oneDispatchSidebarPredicate) and the only thing that admits that chat's working folder (fs/access.ts), so it stays as long as the chat does.
      keepWhen: [{ table: "chats", sql: "EXISTS (SELECT 1 FROM chats c WHERE c.id = t.child_chat_id)" }],
      timeColumns: ["updated_at", "reported_at"],
      children: [{ table: "one_team_dispatch_results", column: "id", parentColumn: "id" }],
      requires: ["id", "status", "reported_at", "report_error", "updated_at", "child_chat_id"],
    } },
    writer: "one/team-dispatch.ts: one row per teammate session One started; one_team_dispatch_results keeps the result of each earlier run of the same dispatch (retainDispatchResult)",
    readers: "one/team-dispatch.ts report retry (reported_at IS NULL), graph-team-step (graph_owner), dispatch-presentation.ts, session-handoff.ts and invocation/service.ts lookups by id",
    evidence: "one/team-dispatch.ts:798/816/1044 reported_at, :846 ONE_TEAM_REPORT_OWNER_STOPPED is a closed 'withdrawn' report (:682), :1163 no-progress codes; "
      + "queued/running are not final states. one_team_dispatch_results rows have no clock of their own and are read by dispatch id only (presentation, handoff), so they go with their dispatch.",
  },
  {
    id: "one_supervisor_work_jobs.closed",
    table: "one_supervisor_work_jobs",
    kinds: [],
    observedMb: 0,
    action: { type: "delete-closed", spec: {
      days: 30 * DAY, timeUnit: "ms", stateColumn: "phase",
      closedStates: ["completed", "failed", "cancelled"],
      timeColumns: ["updated_at"], requires: ["command_id", "phase", "updated_at"],
    } },
    writer: "one/supervisor-work-queue.ts (phase moves through queued, claimed, starting, running, held to a final phase; updated_at epoch ms)",
    readers: "the executor reads queued/claimed/starting/running/held only (one_supervisor_work_dispatch and _live indexes)",
    evidence: "one/supervisor-work-queue.ts:20 TERMINAL = completed, failed, cancelled. one_supervisor_requests itself is kept: main.ts requestedWorkerChat (assertOneContextTask) reads it as One's authority to open a worker chat it asked for, so removing it would refuse One reading that work later.",
  },
  {
    id: "one_supervisor_notices.closed",
    table: "one_supervisor_notices",
    kinds: [],
    observedMb: 0,
    action: { type: "delete-closed", spec: {
      days: 30 * DAY, timeUnit: "iso", stateColumn: "review_state",
      closedStates: ["reviewed", "skipped", "unreviewed"],
      timeColumns: ["created_at", "reviewed_at"], requires: ["review_state", "created_at", "reviewed_at"],
    } },
    writer: "one/supervisor-store.ts notice inserts (INSERT OR IGNORE on one_id, task_id, run_id) and the review loop",
    readers: "the review loop reads pending and claimed rows only (supervisor-store.ts:293-349)",
    evidence: "supervisor-store.ts:317 reviewed, :340 unreviewed (three attempts spent) and 'skipped' are never claimed again; pending and claimed stay.",
  },
  {
    id: "store.vacuum",
    table: "*",
    kinds: [],
    observedMb: 0,
    action: { type: "vacuum", minFreeBytes: 256 * 1024 * 1024, minFreeRatio: 0.25 },
    writer: "storage/db-retention.ts",
    readers: "-",
    evidence: "auto_vacuum is NONE on the owner store: DELETE alone leaves the file at 3.37 GB (freelist 47 pages today). One VACUUM converts the store to "
      + "auto_vacuum=INCREMENTAL; after that each pass returns freed pages in bounded steps.",
  },
];

export const DB_RETENTION_LIMITS = {
  /** Rows a single write transaction may change. */
  sliceRows: 200,
  /** Longest a single slice may hold the write lock before it commits and yields to the main thread. */
  sliceMs: 40,
  /** Longest one 30-minute pass works on retention in total. */
  passMs: 15_000,
  /** The newest rows per entity that the domain-event readers can reach (one/domain-events.ts bounds every read at 500). */
  domainEventReadWindow: 500,
  /** Compacted tool/arguments text keeps this many characters (the replay shows 160). */
  toolArgumentChars: 2048,
  /** Rows one delete-closed batch removes (and the most it looks at when it picks them). */
  closedBatchRows: 500,
  /** The closed-row purge scans wide tables, so a finished pass waits this long before the next one. */
  closedRescanMs: 6 * 3_600_000,
  /** A lease not refreshed for this long is stale. */
  leaseStaleMs: 120_000,
  leaseHeartbeatMs: 15_000,
} as const;

export const DB_RETENTION_LEASE_KEY = "storage.dbRetention.lease.v1";
export const DB_RETENTION_CLOSED_KEY = "storage.dbRetention.closed.v1";
export const DB_RETENTION_CURSOR_KEY = "storage.dbRetention.cursors.v1";

export function retentionRule(id: string): DbRetentionRule {
  const rule = DB_RETENTION_POLICY.find((item) => item.id === id);
  if (!rule) throw new Error(`db_retention_rule_missing:${id}`);
  return rule;
}
