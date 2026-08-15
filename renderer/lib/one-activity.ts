import type { McpInvocationEvent, RunEventUi } from "@shared/types";
import type { OneArtifactBindingRequestV1 } from "@shared/one-artifacts";

export type OneActivityStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled" | "info";
export type OneActivityKind = "run" | "reasoning" | "tool" | "agent" | "notice" | "result" | "terminal";
export type OneActivityCode = "runtime_wait" | "recovery_retry" | "session_resume";

export interface OneActivityTool {
  name: string;
  args?: string;
  result?: string;
  id?: string;
  isError?: boolean;
}

export interface OneActivityItem {
  id: string;
  kind: OneActivityKind;
  status: OneActivityStatus;
  observedAt: string;
  completedAt?: string;
  durationMs?: number;
  agentName?: string;
  role?: string;
  phase?: "plan" | "delegate" | "synthesize";
  message?: string;
  detail?: string;
  noticeLevel?: "info" | "success" | "warning" | "error";
  /** A durable notice carries both product locales so a mirrored screen does not inherit the sender's language. */
  noticeI18n?: { ko: string; en: string };
  activityCode?: OneActivityCode;
  /** notice rows: `divider` marks a conversation boundary (context compaction) — a typed fact, not a wording. */
  noticeDisplay?: "row" | "divider";
  tool?: OneActivityTool;
  /** Characters of the streamed answer so far — only on the live `answer:stream` result row. */
  answerChars?: number;
  /**
   * Reasoning rows only: the model's own summary/thought text for this span
   * (Codex reasoning-summary headline, Claude thinking block, ACP thought chunk).
   * Streams in through `reasoning.delta`; the `end` event may replace it with
   * the full span text (also what the ledger keeps). Never mixed into the answer.
   */
  text?: string;
}

export interface OneActivityArtifact {
  id: string;
  kind: "file" | "image";
  label: string;
  agentName?: string;
  // An artifact is actionable only with Main's opaque, version-pinned binding.
  // The renderer never receives or opens a filesystem path on its own.
  binding: OneArtifactBindingRequestV1;
}

export interface OneActivitySource {
  id: string;
  url: string;
  label: string;
  toolName: string;
  status: OneActivityStatus;
}

export interface OneActivityState {
  items: OneActivityItem[];
  artifacts: OneActivityArtifact[];
  sources: OneActivitySource[];
  tokens?: number;
  lastSequence: number;
  activeReasoningId?: string;
  effectivePermission?: "read" | "write" | "full";
  selectedPermissionMode?: "auto" | "read" | "write" | "full";
  terminalStatus?: "completed" | "failed" | "cancelled";
  /** The run's working folder from the lifecycle start fact — tool paths are shown relative to it. */
  cwd?: string;
}

/** Same ceiling as Main's reasoning span cap — a thought row is evidence, not a transcript. */
const REASONING_TEXT_CAP = 6_000;

export function initialOneActivityState(): OneActivityState {
  return { items: [], artifacts: [], sources: [], lastSequence: 0 };
}

/**
 * Show the accepted local dispatch immediately, before Main's first protocol
 * event makes the renderer round trip. This row does not consume a protocol
 * sequence, so the authoritative lifecycle event can still update it at
 * sequence 1 instead of being mistaken for a replay.
 */
export function beginOneActivityState(input: {
  observedAt: string;
  selectedPermissionMode: "auto" | "read" | "write" | "full";
  effectivePermission: "read" | "write" | "full";
}): OneActivityState {
  return {
    items: [{
      id: "run:lifecycle",
      kind: "run",
      status: "running",
      observedAt: input.observedAt,
    }],
    artifacts: [],
    sources: [],
    lastSequence: 0,
    selectedPermissionMode: input.selectedPermissionMode,
    effectivePermission: input.effectivePermission,
  };
}

function sourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

function mergeSources(current: OneActivitySource[], event: McpInvocationEvent): OneActivitySource[] {
  if (event.kind !== "tool-use" || !event.tool || event.tool.isError || !event.tool.sourceUrls?.length) return current;
  const next = [...current];
  for (const url of event.tool.sourceUrls) {
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:"
        || parsed.username
        || parsed.password
        || parsed.hostname.endsWith(".invalid")
        || parsed.hostname.endsWith(".local")
      ) continue;
      const normalized = parsed.href;
      const id = `source:${normalized}`;
      const source: OneActivitySource = {
        id,
        url: normalized,
        label: sourceLabel(normalized),
        toolName: event.tool.name,
        status: event.tool.result !== undefined ? "completed" : "running",
      };
      const index = next.findIndex((candidate) => candidate.id === id);
      if (index >= 0) next[index] = { ...next[index], ...source };
      else next.push(source);
    } catch {
      // Source URLs come from untrusted tool text; malformed references never render.
    }
  }
  return next;
}

function closeRunning(
  items: OneActivityItem[],
  completedAt: string,
  status: "completed" | "failed" | "cancelled" = "completed",
  onlyReasoning = false,
): OneActivityItem[] {
  let changed = false;
  const completedMs = Date.parse(completedAt);
  const next = items.map((item) => {
    if ((item.status !== "running" && item.status !== "cancelling") || (onlyReasoning && item.kind !== "reasoning")) return item;
    changed = true;
    const startedMs = Date.parse(item.observedAt);
    return {
      ...item,
      status,
      completedAt,
      ...(Number.isFinite(startedMs) && Number.isFinite(completedMs)
        ? { durationMs: Math.max(0, completedMs - startedMs) }
        : {}),
    };
  });
  return changed ? next : items;
}

function upsertItem(items: OneActivityItem[], item: OneActivityItem): OneActivityItem[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  const next = index >= 0
    ? items.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, ...item } : candidate)
    : [...items, item];
  return next;
}

function mergeVerifiedSurfaceArtifacts(
  current: OneActivityArtifact[],
  event: McpInvocationEvent,
): OneActivityArtifact[] {
  // Main-owned `oneArtifacts` binding is the sole artifact source. Raw tool
  // result text is deliberately retained only inside its Activity row.
  if (!event.oneArtifacts?.length) return current;
  const next = [...current];
  for (const artifact of event.oneArtifacts) {
    const binding: OneArtifactBindingRequestV1 = {
      taskId: artifact.taskId,
      taskVersion: artifact.taskVersion,
      chatId: artifact.chatId,
      runId: artifact.runId,
      manifestId: artifact.manifestId,
      artifactRef: artifact.artifactRef,
    };
    const kind: OneActivityArtifact["kind"] = artifact.type === "image" ? "image" : "file";
    const nextArtifact: OneActivityArtifact = {
      id: `bound:${artifact.runId}:${artifact.artifactRef}`,
      kind,
      label: artifact.label,
      binding,
      ...(event.agentName?.trim() ? { agentName: event.agentName.trim() } : {}),
    };
    const index = next.findIndex((candidate) => candidate.id === nextArtifact.id);
    if (index >= 0) next[index] = { ...next[index], ...nextArtifact };
    else next.push(nextArtifact);
  }
  return next;
}

/**
 * One activity is a projection of the structured runtime protocol only.
 * Free-form status strings never choose a stage or become progress copy.
 */
export function reduceOneActivity(
  state: OneActivityState,
  event: McpInvocationEvent,
): OneActivityState {
  const hasTypedSequence = Number.isSafeInteger(event.sequence);
  const incomingSequence = hasTypedSequence ? Number(event.sequence) : null;
  // Reattach/replay can deliver an already-applied suffix. A typed sequence is
  // an identity, not a suggestion that may be renumbered.
  if (incomingSequence !== null && incomingSequence <= state.lastSequence) return state;
  // A terminal turn is immutable. Late provider/tool events must not reopen it.
  if (state.terminalStatus) return state;
  const sequence = incomingSequence !== null
    ? incomingSequence
    : state.lastSequence + 1;
  const observedAt = event.observedAt || new Date().toISOString();
  let items = state.items;
  let activeReasoningId = state.activeReasoningId;
  let tokens = state.tokens;
  let effectivePermission = state.effectivePermission;
  let selectedPermissionMode = state.selectedPermissionMode;
  let cwd = state.cwd;
  let terminalStatus: OneActivityState["terminalStatus"] = undefined;

  if (event.kind === "lifecycle" && event.lifecycle?.phase === "start") {
    effectivePermission = event.lifecycle.permission ?? effectivePermission;
    selectedPermissionMode = event.lifecycle.selectedPermissionMode ?? selectedPermissionMode;
    if (typeof event.lifecycle.cwd === "string" && event.lifecycle.cwd.trim()) cwd = event.lifecycle.cwd.trim();
    items = upsertItem(items, {
      id: "run:lifecycle",
      kind: "run",
      status: "running",
      observedAt,
    });
  } else if (event.kind === "lifecycle" && event.lifecycle?.phase === "cancel_requested") {
    items = items.map((item) => item.kind === "run" && item.status === "running"
      ? { ...item, status: "cancelling" }
      : item);
  } else if (event.kind === "usage") {
    if (typeof event.tokens === "number" && Number.isFinite(event.tokens)) {
      tokens = Math.max(tokens ?? 0, event.tokens);
    }
  } else if (event.kind === "reasoning" && event.reasoning?.phase === "start") {
    const id = `reasoning:${sequence}`;
    items = upsertItem(items, {
      id,
      kind: "reasoning",
      status: "running",
      observedAt,
      ...(event.agentName?.trim() ? { agentName: event.agentName.trim() } : {}),
    });
    activeReasoningId = id;
  } else if (event.kind === "reasoning" && event.reasoning?.phase === "delta") {
    // A delta can arrive before the runner's explicit start (some runtimes emit
    // text first). Open the span implicitly so no thought text is ever lost.
    let id = activeReasoningId;
    if (!id) {
      id = `reasoning:${sequence}`;
      items = upsertItem(items, { id, kind: "reasoning", status: "running", observedAt });
      activeReasoningId = id;
    }
    const chunk = typeof event.reasoning.text === "string" ? event.reasoning.text : "";
    if (chunk) {
      const target = id;
      items = items.map((item) => item.id === target
        ? { ...item, text: `${item.text ?? ""}${chunk}`.slice(0, REASONING_TEXT_CAP) }
        : item);
    }
  } else if (event.kind === "reasoning" && event.reasoning?.phase === "end") {
    const id = activeReasoningId;
    const fullText = typeof event.reasoning.text === "string" && event.reasoning.text.trim()
      ? event.reasoning.text.slice(0, REASONING_TEXT_CAP)
      : undefined;
    if (id) {
      items = items.map((item) => item.id === id ? {
        ...item,
        status: "completed",
        completedAt: observedAt,
        ...(typeof event.reasoning?.durationMs === "number"
          ? { durationMs: Math.max(0, event.reasoning.durationMs) }
          : {}),
        ...(fullText ? { text: fullText } : {}),
      } : item);
      activeReasoningId = undefined;
    } else if (fullText) {
      // Ledger replay: the start row may be older than the retained window, or
      // a runner reported a whole summary in one end event. Keep the thought.
      items = upsertItem(items, {
        id: `reasoning:${sequence}`,
        kind: "reasoning",
        status: "completed",
        observedAt,
        completedAt: observedAt,
        text: fullText,
        ...(typeof event.reasoning?.durationMs === "number"
          ? { durationMs: Math.max(0, event.reasoning.durationMs) }
          : {}),
      });
    }
  } else if (event.kind === "thinking") {
    // The legacy provider bridge emits one generic owner `thinking` pulse for
    // almost every turn. Rendering it beside the lifecycle row duplicates
    // "Working" and makes a no-tool greeting look like orchestration. Show an
    // agent item only when the protocol carries an actual typed phase/tier.
    if (
      (event.agentId || event.runtimeAgentId || event.agentName)
      && (event.phase !== undefined || (event.tier ?? 1) > 1)
    ) {
      const agentId = event.runtimeAgentId || event.agentId || event.agentName || `agent-${sequence}`;
      const id = `agent:${agentId}:${event.phase || "work"}`;
      items = upsertItem(items, {
        id,
        kind: "agent",
        status: event.done ? "completed" : "running",
        observedAt,
        ...(event.done ? { completedAt: observedAt } : {}),
        ...(event.agentName?.trim() ? { agentName: event.agentName.trim() } : {}),
        ...(event.role?.trim() ? { role: event.role.trim() } : {}),
        ...(event.phase ? { phase: event.phase } : {}),
      });
    } else if (
      !(event.agentId || event.runtimeAgentId || event.agentName)
      && !activeReasoningId
    ) {
      const id = `reasoning:${sequence}`;
      items = upsertItem(items, { id, kind: "reasoning", status: "running", observedAt });
      activeReasoningId = id;
    }
  } else if (
    event.kind === "tool-use"
    && event.tool
    // Host plugin-universe discovery is invocation plumbing, not work the
    // user asked One to perform. It must not become two fake tool rows at the
    // start of every greeting or promote the conversation to a Task.
    && !event.tool.name.trim().startsWith("Agentlas Plugins ·")
  ) {
    items = closeRunning(items, observedAt, "completed", true);
    activeReasoningId = undefined;
    const existing = event.tool.id
      ? items.find((item) => item.id === `tool:${event.tool?.id}`)
      : [...items].reverse().find((item) => (
          item.kind === "tool"
          && item.status === "running"
          && item.tool?.name === event.tool?.name
        ));
    const id = existing?.id || `tool:${event.tool.id || sequence}`;
    const status: OneActivityStatus = event.tool.isError
      ? "failed"
      : event.tool.result !== undefined
        ? "completed"
        : "running";
    items = upsertItem(items, {
      id,
      kind: "tool",
      status,
      observedAt: existing?.observedAt || observedAt,
      ...(status !== "running" ? { completedAt: observedAt } : {}),
      ...(event.agentName?.trim() ? { agentName: event.agentName.trim() } : {}),
      ...(event.role?.trim() ? { role: event.role.trim() } : {}),
      // A completion event often repeats the tool without its arguments. A
      // spread copies `args: undefined` over the start event's real args and
      // the live row loses its command until the ledger replays it — keep
      // only the keys the new event actually carries.
      tool: {
        ...existing?.tool,
        ...Object.fromEntries(Object.entries(event.tool).filter(([, value]) => value !== undefined)),
      } as OneActivityTool,
    });
  } else if (event.kind === "tool-use" && event.activity) {
    const id = `notice:${event.activity.code}`;
    const existing = items.find((item) => item.id === id);
    items = upsertItem(items, {
      id,
      kind: "notice",
      status: "info",
      observedAt: existing?.observedAt || observedAt,
      activityCode: event.activity.code,
      noticeLevel: "info",
    });
  } else if (event.kind === "notice" && event.notice?.message) {
    items = upsertItem(items, {
      id: `notice:${sequence}`,
      kind: "notice",
      status: event.notice.level === "error" ? "failed" : "info",
      observedAt,
      message: event.notice.message,
      detail: event.notice.details,
      noticeLevel: event.notice.level,
      ...(event.notice.display ? { noticeDisplay: event.notice.display } : {}),
      ...(event.notice.i18n?.ko?.trim() && event.notice.i18n?.en?.trim()
        ? { noticeI18n: { ko: event.notice.i18n.ko.trim(), en: event.notice.i18n.en.trim() } }
        : {}),
      ...(event.agentName?.trim() ? { agentName: event.agentName.trim() } : {}),
    });
  } else if (event.kind === "surface") {
    items = closeRunning(items, observedAt);
    activeReasoningId = undefined;
    items = upsertItem(items, {
      id: `result:${event.surfaceId || event.oneSurface?.manifestId || sequence}`,
      kind: "result",
      status: "completed",
      observedAt,
      completedAt: observedAt,
    });
  } else if (event.kind === "partial") {
    items = closeRunning(items, observedAt, "completed", true);
    activeReasoningId = undefined;
    // The answer is streaming. Without this the timeline sat on the run row's
    // generic "Working" for the whole generation (measured: 45s of "Working"
    // while 300 lines were visibly arriving underneath). Say what is happening
    // and how far along, the way tool rows do; the row closes on final/error.
    // Live partials are deltas: the size lives in `textLen`; replay/fallback
    // partials still carry the accumulated `text`.
    const answerLength = typeof event.textLen === "number" && Number.isFinite(event.textLen)
      ? event.textLen
      : typeof event.text === "string"
        ? event.text.length
        : 0;
    const existing = items.find((item) => item.id === "answer:stream");
    items = upsertItem(items, {
      id: "answer:stream",
      kind: "result",
      status: "running",
      observedAt: existing?.observedAt || observedAt,
      answerChars: Math.max(existing?.answerChars ?? 0, answerLength),
    });
  } else if (event.kind === "final") {
    // The answer row is closed by closeRunning below; settle its final size.
    // A ledger replay never saw the live partials (they are not persisted),
    // so the row is created here from the recorded length instead of vanishing
    // from Activity the moment the run settles.
    const finalAnswerChars = typeof event.textLen === "number" && Number.isFinite(event.textLen)
      ? event.textLen
      : typeof event.text === "string"
        ? event.text.length
        : null;
    if (finalAnswerChars != null && finalAnswerChars > 0) {
      const existing = items.find((item) => item.id === "answer:stream");
      items = upsertItem(items, {
        id: "answer:stream",
        kind: "result",
        status: existing?.status ?? "running",
        observedAt: existing?.observedAt || observedAt,
        answerChars: Math.max(existing?.answerChars ?? 0, finalAnswerChars),
      });
    }
    items = closeRunning(items, observedAt);
    activeReasoningId = undefined;
    if (!items.some((item) => item.kind === "run")) {
      items = upsertItem(items, {
        id: `terminal:${sequence}`,
        kind: "terminal",
        status: "completed",
        observedAt,
        completedAt: observedAt,
      });
    }
    if (typeof event.tokens === "number" && Number.isFinite(event.tokens)) {
      tokens = Math.max(tokens ?? 0, event.tokens);
    }
    terminalStatus = "completed";
  } else if (event.kind === "error") {
    // A run the person stopped ends through the same error channel as a
    // runtime failure; the earlier cancel_requested lifecycle fact (or an
    // explicit cancel code) tells them apart. "Stopped" is not "failed".
    // Typed facts only — never the wording of the message.
    const cancelled = /^(?:cancelled|canceled|user_cancelled|user-cancelled|aborted_by_user)$/i.test(event.error?.code ?? "")
      || items.some((item) => item.status === "cancelling");
    const status = cancelled ? "cancelled" : "failed";
    items = closeRunning(items, observedAt, status);
    activeReasoningId = undefined;
    if (!items.some((item) => item.kind === "run")) {
      items = upsertItem(items, {
        id: `terminal:${sequence}`,
        kind: "terminal",
        status,
        observedAt,
        completedAt: observedAt,
        message: event.error?.message,
      });
    }
    terminalStatus = status;
  }

  return {
    items,
    artifacts: mergeVerifiedSurfaceArtifacts(state.artifacts, event),
    sources: mergeSources(state.sources, event),
    ...(tokens !== undefined ? { tokens } : {}),
    lastSequence: sequence,
    ...(activeReasoningId ? { activeReasoningId } : {}),
    ...(effectivePermission ? { effectivePermission } : {}),
    ...(selectedPermissionMode ? { selectedPermissionMode } : {}),
    ...(cwd ? { cwd } : {}),
    ...(terminalStatus ? { terminalStatus } : {}),
  };
}

function ledgerString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function ledgerBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === "boolean" ? value : undefined;
}

function ledgerHttpsUrls(payload: Record<string, unknown>, key: string): string[] | undefined {
  const value = payload[key];
  if (!Array.isArray(value)) return undefined;
  const urls = value.filter((item): item is string => {
    if (typeof item !== "string") return false;
    try {
      const parsed = new URL(item);
      return parsed.protocol === "https:"
        && !parsed.username
        && !parsed.password
        && !parsed.hostname.endsWith(".invalid")
        && !parsed.hostname.endsWith(".local");
    } catch {
      return false;
    }
  });
  return urls.length ? urls : undefined;
}

function ledgerOneArtifacts(payload: Record<string, unknown>): NonNullable<McpInvocationEvent["oneArtifacts"]> | undefined {
  const value = payload.oneArtifacts;
  if (!Array.isArray(value)) return undefined;
  const accepted = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const type = row.type;
    if (
      typeof row.taskId !== "string" || typeof row.taskVersion !== "number" || !Number.isSafeInteger(row.taskVersion)
      || typeof row.chatId !== "string" || typeof row.runId !== "string" || typeof row.manifestId !== "string"
      || typeof row.artifactRef !== "string" || typeof row.label !== "string"
      || !["document", "spreadsheet", "image", "video", "audio", "archive", "data", "other"].includes(String(type))
    ) return [];
    return [{
      taskId: row.taskId,
      taskVersion: row.taskVersion,
      chatId: row.chatId,
      runId: row.runId,
      manifestId: row.manifestId,
      artifactRef: row.artifactRef,
      label: row.label,
      type: type as NonNullable<McpInvocationEvent["oneArtifacts"]>[number]["type"],
      ...(typeof row.sizeBytes === "number" && Number.isSafeInteger(row.sizeBytes) ? { sizeBytes: row.sizeBytes } : {}),
    }];
  });
  return accepted.length ? accepted : undefined;
}

function ledgerPermission(value: unknown): "read" | "write" | "full" | undefined {
  return value === "read" || value === "write" || value === "full" ? value : undefined;
}

function ledgerPermissionMode(value: unknown): "auto" | "read" | "write" | "full" | undefined {
  return value === "auto" || value === "read" || value === "write" || value === "full"
    ? value
    : undefined;
}

function ledgerActivityCode(value: unknown): NonNullable<McpInvocationEvent["activity"]>["code"] | undefined {
  return value === "runtime_wait" || value === "recovery_retry" || value === "session_resume"
    ? value
    : undefined;
}

function ledgerNoticeI18n(payload: Record<string, unknown>): { ko: string; en: string } | undefined {
  const value = payload.noticeI18n;
  let candidate: unknown = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  const ko = typeof record.ko === "string" ? record.ko.trim() : "";
  const en = typeof record.en === "string" ? record.en.trim() : "";
  return ko && en ? { ko, en } : undefined;
}

/** Rebuild the latest Activity from Main's redacted append-only run ledger. */
export function projectOneActivityFromLedger(events: RunEventUi[]): OneActivityState {
  let state = initialOneActivityState();
  let projectedSequence = 0;
  const observedToolIds = new Set<string>();
  const apply = (event: Omit<McpInvocationEvent, "sequence" | "observedAt">, observedAt: string) => {
    projectedSequence += 1;
    state = reduceOneActivity(state, { ...event, sequence: projectedSequence, observedAt });
  };

  // A stop arrives as mcp_error followed by invoke_cancelled. The first row
  // would otherwise seal the run as "failed" before the cancel row is read.
  const cancelledRun = events.some((row) => row.kind === "invoke_cancelled");
  for (const row of events) {
    const payload = row.payload ?? {};
    if (row.kind === "invoke_started") {
      const permission = ledgerPermission(payload.permissions);
      const selectedPermissionMode = ledgerPermissionMode(payload.onePermissionMode);
      apply({
        kind: "lifecycle",
        lifecycle: {
          phase: "start",
          ...(permission ? { permission } : {}),
          ...(selectedPermissionMode ? { selectedPermissionMode } : {}),
        },
      }, row.ts);
      continue;
    }
    if (row.kind === "mcp_lifecycle") {
      // The desktop lifecycle fact carries the run's working folder; the
      // invoke_started row above does not.
      const lifecycleCwd = ledgerString(payload, "lifecycleCwd");
      if (ledgerString(payload, "lifecyclePhase") === "start" && lifecycleCwd) {
        apply({ kind: "lifecycle", lifecycle: { phase: "start", cwd: lifecycleCwd } }, row.ts);
      }
      continue;
    }
    if (row.kind === "invoke_cancel_requested") {
      apply({ kind: "lifecycle", lifecycle: { phase: "cancel_requested" } }, row.ts);
      continue;
    }
    if (row.kind === "mcp_tool-use") {
      const toolName = ledgerString(payload, "toolName");
      const toolId = ledgerString(payload, "toolId");
      const toolIsError = ledgerBoolean(payload, "toolIsError") === true;
      const toolSourceUrls = ledgerHttpsUrls(payload, "toolSourceUrls");
      const oneArtifacts = ledgerOneArtifacts(payload);
      if (toolName) {
        // A ledger row that carries a result preview is a completion even when
        // the tool id was never observed (single-event runners like agy DONE).
        const toolArgs = ledgerString(payload, "toolArgs");
        const rawResultPreview = payload.toolResultPreview;
        const hasResultPreview = typeof rawResultPreview === "string";
        const isCompletion = toolIsError || hasResultPreview || Boolean(toolId && observedToolIds.has(toolId));
        if (toolId) observedToolIds.add(toolId);
        const agentName = ledgerString(payload, "agentName");
        const role = ledgerString(payload, "role");
        apply({
          kind: "tool-use",
          tool: {
            name: toolName,
            ...(toolId ? { id: toolId } : {}),
            ...(toolArgs ? { args: toolArgs } : {}),
            ...(isCompletion ? { result: hasResultPreview ? (rawResultPreview as string) : "" } : {}),
            ...(toolIsError ? { isError: true } : {}),
            ...(toolSourceUrls ? { sourceUrls: toolSourceUrls } : {}),
          },
          ...(row.agentId ? { agentId: row.agentId } : {}),
          ...(agentName ? { agentName } : {}),
          ...(role ? { role } : {}),
          ...(oneArtifacts ? { oneArtifacts } : {}),
        }, row.ts);
        continue;
      }
      const activityCode = ledgerActivityCode(payload.activityCode);
      if (activityCode) {
        apply({ kind: "tool-use", activity: { code: activityCode } }, row.ts);
      }
      continue;
    }
    if (row.kind === "mcp_reasoning") {
      const phase = ledgerString(payload, "reasoningPhase");
      if (phase === "start" || phase === "end") {
        const durationValue = Number(payload.reasoningDurationMs);
        const reasoningText = ledgerString(payload, "reasoningText");
        apply({
          kind: "reasoning",
          reasoning: {
            phase,
            ...(phase === "end" && Number.isFinite(durationValue)
              ? { durationMs: Math.max(0, durationValue) }
              : {}),
            ...(phase === "end" && reasoningText ? { text: reasoningText } : {}),
          },
        }, row.ts);
      }
      continue;
    }
    if (row.kind === "mcp_thinking") {
      const agentName = ledgerString(payload, "agentName");
      const role = ledgerString(payload, "role");
      const rawPhase = ledgerString(payload, "phase");
      const phase = rawPhase === "plan" || rawPhase === "delegate" || rawPhase === "synthesize"
        ? rawPhase
        : undefined;
      apply({
        kind: "thinking",
        ...(row.agentId ? { agentId: row.agentId } : {}),
        ...(agentName ? { agentName } : {}),
        ...(role ? { role } : {}),
        ...(phase ? { phase } : {}),
      }, row.ts);
      continue;
    }
    if (row.kind === "mcp_notice") {
      const noticeI18n = ledgerNoticeI18n(payload);
      const message = ledgerString(payload, "noticeMessage") || noticeI18n?.en || noticeI18n?.ko;
      const rawLevel = ledgerString(payload, "noticeLevel");
      const level = rawLevel === "info" || rawLevel === "success" || rawLevel === "warning" || rawLevel === "error"
        ? rawLevel
        : "info";
      const display = ledgerString(payload, "noticeDisplay");
      if (message) {
        apply({
          kind: "notice",
          notice: {
            level,
            message,
            ...(ledgerString(payload, "noticeCode") ? { code: ledgerString(payload, "noticeCode") } : {}),
            ...(noticeI18n ? { i18n: noticeI18n } : {}),
            ...(ledgerString(payload, "noticeDetails") ? { details: ledgerString(payload, "noticeDetails") } : {}),
            ...(display === "row" || display === "divider" ? { display } : {}),
          },
          ...(row.agentId ? { agentId: row.agentId } : {}),
        }, row.ts);
      }
      continue;
    }
    if (row.kind === "mcp_surface") {
      const oneArtifacts = ledgerOneArtifacts(payload);
      apply({ kind: "surface", surfaceId: ledgerString(payload, "surfaceId"), ...(oneArtifacts ? { oneArtifacts } : {}) }, row.ts);
      continue;
    }
    if (row.kind === "mcp_final" || row.kind === "invoke_completed") {
      const tokenValue = Number(payload.tokens);
      const textLenValue = Number(payload.textLen);
      apply({
        kind: "final",
        ...(Number.isFinite(tokenValue) ? { tokens: tokenValue } : {}),
        ...(Number.isFinite(textLenValue) && textLenValue > 0 ? { textLen: textLenValue } : {}),
      }, row.ts);
      continue;
    }
    if (row.kind === "mcp_error" || row.kind === "invoke_failed" || row.kind === "invoke_cancelled") {
      const cancelled = row.kind === "invoke_cancelled" || cancelledRun;
      apply({
        kind: "error",
        error: {
          code: cancelled ? "cancelled" : ledgerString(payload, "errorCode") || "runtime_error",
          message: ledgerString(payload, "errorMessage") || (cancelled ? "Run cancelled" : "Run stopped"),
        },
      }, row.ts);
    }
  }
  return state;
}
