import type { OneActivityItem, OneActivityState } from "./one-activity";
import { normalizeToolCall, mcpServerName, stripCwdPrefix, type ToolCallDetail } from "@shared/tool-call-detail";
import { parseShellCommand, stripShellWrapper } from "@shared/exploratory-shell";
import type { ToolFailureCode } from "@shared/tool-failure";

/**
 * One turn's work, in the shape Codex draws it.
 *
 * `OneActivityState` is the typed protocol projection (one row per event id).
 * This module folds those rows into the cells a person reads: consecutive
 * reads/lists/searches become one "Explored" cell, an `npm test` is "Ran", a
 * patch is "Edited file (+n −m)", a reasoning span is "Thought for Ns" whose
 * body is the model's own summary. Nothing here invents copy about *what* the
 * model is doing — the headline while working is the model's latest thought
 * headline; when a runtime gives none, the verb of the running cell is used.
 *
 * Reference: `openai/codex` `codex-rs/tui/src/exec_cell/render.rs`
 * (Exploring/Explored · Running/Ran · Read/List/Search lines) and
 * `history_cell/{patches,mcp,search,separators}.rs` (Edited · Called ·
 * Searched the web · "Worked for").
 */

export type OneWorkCellStatus = "running" | "completed" | "failed" | "cancelled";

export interface OneWorkExploreEntry {
  op: "read" | "list" | "search";
  /** "a.ts, b.ts" · "src/" · "query in path" — already joined for display. */
  label: string;
}

export interface OneWorkEditFile {
  path: string;
  op: "edit" | "write";
  added?: number;
  removed?: number;
}

interface CellBase {
  id: string;
  status: OneWorkCellStatus;
  startedAt: string;
  /**
   * Delegated teammate who performed this step (typed event attribution). In a
   * group room the tool log must say *who* called the tool (G-4); absent for
   * One's own orchestrator steps.
   */
  agent?: string;
  agentId?: string;
  model?: string;
  observedModel?: string;
  updatedAt?: string;
}

export type OneWorkCell =
  | (CellBase & { kind: "thought"; headline?: string; body?: string; durationMs?: number })
  | (CellBase & { kind: "explore"; entries: OneWorkExploreEntry[] })
  | (CellBase & { kind: "run"; command: string; output?: string; exitCode?: number | null })
  | (CellBase & { kind: "edit"; files: OneWorkEditFile[]; diff?: string })
  | (CellBase & { kind: "web_search"; query: string })
  | (CellBase & { kind: "fetch"; url: string; statusCode?: number })
  | (CellBase & { kind: "call"; label: string; toolName?: string; detail?: string; args?: string; result?: string; failureCode?: ToolFailureCode })
  | (CellBase & { kind: "agent"; name: string; role?: string; phase?: OneActivityItem["phase"]; terminalObserved?: boolean })
  | (CellBase & { kind: "notice"; level: "info" | "success" | "warning" | "error"; message: string; details?: string; activityCode?: OneActivityItem["activityCode"] })
  /** Only when a turn had no thought and no tool: the one thing that happened was writing the answer. */
  | (CellBase & { kind: "answer"; chars?: number });

export interface OneWorkDivider {
  id: string;
  message: string;
  observedAt: string;
}

export interface OneWorkPresentation {
  cells: OneWorkCell[];
  /** Conversation-boundary notices (context compaction) — drawn outside the collapsible block. */
  dividers: OneWorkDivider[];
  running: boolean;
  /** Live one-line status: the model's latest thought headline, else the running cell's verb. */
  headline: string;
  /** Immutable run duration once the lifecycle row settled. */
  durationMs?: number;
  /** Model/runtime label the run actually executed with (표시=실행, C-D-1). */
  model?: string;
  terminal?: "completed" | "failed" | "cancelled";
  /** Message carried by a failed/cancelled terminal row, if any. */
  terminalMessage?: string;
}

export function formatWorkElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
}

const MARKDOWN_EMPHASIS_RE = /(\*\*|__|\*|_|`)/g;

/**
 * First readable line of a thought: Codex sends `**Headline**` lines, Gemini
 * `**Subject**\n\nbody`, Claude free prose. Strip emphasis/list markers and cap.
 */
export function thoughtHeadline(text: string | undefined, max = 96): string | undefined {
  if (!text) return undefined;
  const line = text
    .split(/\r?\n/)
    .map((candidate) => candidate.replace(MARKDOWN_EMPHASIS_RE, "").replace(/^\s*(?:[-*•]|\d+\.)\s+/, "").replace(/^#+\s*/, "").trim())
    .find((candidate) => candidate.length > 0);
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function itemStatus(item: OneActivityItem): OneWorkCellStatus {
  if (item.status === "running" || item.status === "cancelling") return "running";
  if (item.status === "failed") return "failed";
  if (item.status === "cancelled") return "cancelled";
  return "completed";
}

function mergeStatus(a: OneWorkCellStatus, b: OneWorkCellStatus): OneWorkCellStatus {
  if (a === "running" || b === "running") return "running";
  if (a === "failed" || b === "failed") return "failed";
  if (a === "cancelled" || b === "cancelled") return "cancelled";
  return "completed";
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) || path;
}

type Classified =
  | { cell: "explore"; entries: OneWorkExploreEntry[] }
  | { cell: "run"; command: string; output?: string; exitCode?: number | null }
  | { cell: "edit"; file: OneWorkEditFile; diff?: string }
  | { cell: "web_search"; query: string }
  | { cell: "fetch"; url: string; statusCode?: number }
  | { cell: "call"; label: string; detail?: string; connected?: boolean };

/** Sentinel label; localized at render ("연결된 도구 사용" / "Use connected tool"). */
export const CONNECTED_TOOL_LABEL = "__connected_tool__";

function parseJsonRecord(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function pickText(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = source[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function exploreEntriesFromShell(command: string, cwd: string | null): OneWorkExploreEntry[] | null {
  const parsed = parseShellCommand(command);
  const rel = (value: string) => {
    const unquoted = value.replace(/^["']|["']$/g, "");
    return stripCwdPrefix(unquoted, cwd ?? undefined) || unquoted;
  };
  if (parsed.length === 0 || parsed.some((segment) => segment.op === "run")) return null;
  const entries: OneWorkExploreEntry[] = [];
  const reads: string[] = [];
  const flushReads = () => {
    if (reads.length > 0) {
      entries.push({ op: "read", label: [...new Set(reads)].join(", ") });
      reads.length = 0;
    }
  };
  for (const segment of parsed) {
    if (segment.op === "read") {
      reads.push(segment.name);
      continue;
    }
    flushReads();
    if (segment.op === "list") entries.push({ op: "list", label: rel(segment.path) });
    else if (segment.op === "search") {
      const label = segment.query && segment.path
        ? `${segment.query} in ${rel(segment.path)}`
        : segment.query ?? segment.cmd;
      entries.push({ op: "search", label });
    }
  }
  flushReads();
  return entries;
}

function classifyTool(item: OneActivityItem, workspacePath: string | null): Classified {
  const tool = item.tool!;
  const detail: ToolCallDetail = normalizeToolCall({
    name: tool.name,
    args: tool.args,
    result: tool.result,
    cwd: workspacePath ?? undefined,
  });
  switch (detail.type) {
    case "read":
      return { cell: "explore", entries: [{ op: "read", label: basename(detail.filePath) || detail.filePath }] };
    case "list":
      return { cell: "explore", entries: [{ op: "list", label: detail.path || "." }] };
    case "search": {
      if (detail.mode === "web") return { cell: "web_search", query: detail.query };
      const searchPath = detail.path ? (stripCwdPrefix(detail.path, workspacePath ?? undefined) || detail.path) : "";
      const label = detail.query && searchPath ? `${detail.query} in ${searchPath}` : (detail.query || searchPath || "");
      return { cell: "explore", entries: [{ op: "search", label }] };
    }
    case "shell": {
      const command = stripShellWrapper(detail.command);
      const entries = command ? exploreEntriesFromShell(command, workspacePath) : null;
      if (entries && entries.length > 0) return { cell: "explore", entries };
      return {
        cell: "run",
        command,
        ...(detail.output ? { output: detail.output } : {}),
        ...(detail.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
      };
    }
    case "edit":
      return {
        cell: "edit",
        file: {
          path: detail.filePath,
          op: "edit",
          ...(detail.diffStat ? { added: detail.diffStat.added, removed: detail.diffStat.removed } : {}),
        },
        ...(detail.unifiedDiff ? { diff: detail.unifiedDiff } : {}),
      };
    case "write":
      return { cell: "edit", file: { path: detail.filePath, op: "write" } };
    case "fetch":
      return { cell: "fetch", url: detail.url, ...(detail.statusCode !== undefined ? { statusCode: detail.statusCode } : {}) };
    case "sub_agent":
      return { cell: "call", label: detail.subAgentType ?? tool.name, ...(detail.description ? { detail: detail.description } : {}) };
    case "plan":
      return { cell: "call", label: "plan", ...(detail.text ? { detail: detail.text } : {}) };
    case "todo": {
      const done = detail.items.filter((entry) => entry.completed).length;
      return {
        cell: "call",
        label: "todo",
        detail: `${done}/${detail.items.length}\n${detail.items.map((entry) => `${entry.completed ? "☑" : "☐"} ${entry.text}`).join("\n")}`,
      };
    }
    case "browser":
      return { cell: "call", label: `browser:${detail.action}`, ...(detail.target ? { detail: detail.target } : {}) };
    case "plain_text":
      return { cell: "call", label: detail.label };
    case "unknown":
    default: {
      // Some Codex hosts expose only the `mcp_tool_call` envelope and omit the
      // private tool arguments from the durable ledger. The envelope name is
      // not an action a person can read; name the server/tool when the args
      // carry them, otherwise say truthfully that a connected tool was used.
      if (/^(?:mcp[_. -]*tool[_. -]*call|custom_tool_call)$/i.test(tool.name.trim())) {
        const parsed = parseJsonRecord(tool.args);
        const server = pickText(parsed, ["server", "server_name", "serverName", "mcp_server"]);
        const named = pickText(parsed, ["tool", "tool_name", "toolName", "name"]);
        const readable = server && named ? `${server} · ${named}` : named || server;
        return { cell: "call", label: readable ?? CONNECTED_TOOL_LABEL, connected: !readable };
      }
      const server = mcpServerName(tool.name);
      const leaf = server ? tool.name.split("__").slice(2).join("__").replace(/[-_]+/g, " ").trim() : "";
      return { cell: "call", label: server ? (leaf ? `${server} · ${leaf}` : server) : tool.name };
    }
  }
}

/** Identity is scoped to this single invocation projection. Names never join workers. */
function cellAttribution(item: OneActivityItem): Pick<CellBase, "agent" | "agentId" | "model" | "observedModel" | "updatedAt"> {
  return {
    ...(item.agentName?.trim() ? { agent: item.agentName.trim() } : {}),
    ...(item.agentId ? { agentId: item.agentId } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.observedModel ? { observedModel: item.observedModel } : {}),
    updatedAt: item.updatedAt ?? item.completedAt ?? item.observedAt,
  };
}

function sameCellActor(cell: OneWorkCell, item: OneActivityItem): boolean {
  if (cell.agentId || item.agentId) return Boolean(cell.agentId && cell.agentId === item.agentId);
  // Unattributed owner rows can fold; named workers without identity cannot.
  return !cell.agent && !item.agentName;
}

export interface OneWorkerWorkGroup {
  agentId: string;
  name?: string;
  model?: string;
  cells: OneWorkCell[];
  latest: OneWorkCell;
  lifecycle?: Extract<OneWorkCell, { kind: "agent" }>;
}

/** A completed observation belongs to history until the current worker call settles. */
export function workerModelLabel(group: OneWorkerWorkGroup, active: boolean, locale: "ko" | "en"): string {
  const running = active && group.lifecycle?.status === "running" && !group.lifecycle.terminalObserved;
  const unknown = locale === "ko" ? "실제 미확인" : "execution unconfirmed";
  if (running) return group.lifecycle?.model
    ? `${locale === "ko" ? "요청" : "Requested"}: ${group.lifecycle.model} · ${unknown}`
    : unknown;
  return group.model || (locale === "ko" ? "실행 모델 미확인" : "Execution model unconfirmed");
}

export function groupOneWorkerWork(cells: readonly OneWorkCell[]): OneWorkerWorkGroup[] {
  const groups = new Map<string, OneWorkerWorkGroup>();
  const modelTimes = new Map<string, number>();
  for (const cell of cells) {
    if (!cell.agentId) continue;
    let group = groups.get(cell.agentId);
    if (!group) {
      group = { agentId: cell.agentId, cells: [], latest: cell };
      groups.set(cell.agentId, group);
    }
    group.cells.push(cell);
    if (cell.agent) group.name = cell.agent;
    const observed = Date.parse(cell.updatedAt ?? cell.startedAt);
    if (cell.observedModel && (!modelTimes.has(cell.agentId) || observed >= modelTimes.get(cell.agentId)!)) {
      group.model = cell.observedModel;
      modelTimes.set(cell.agentId, observed);
    }
    if (Date.parse(cell.updatedAt ?? cell.startedAt) >= Date.parse(group.latest.updatedAt ?? group.latest.startedAt)) group.latest = cell;
    if (cell.kind === "agent" && (!group.lifecycle || Date.parse(cell.updatedAt ?? cell.startedAt) >= Date.parse(group.lifecycle.updatedAt ?? group.lifecycle.startedAt))) group.lifecycle = cell;
  }
  return [...groups.values()];
}

function pushExplore(cells: OneWorkCell[], item: OneActivityItem, entries: OneWorkExploreEntry[]) {
  const status = itemStatus(item);
  const last = cells.at(-1);
  // Never coalesce steps performed by different teammates into one row — the
  // row's attribution (G-4) must stay truthful.
  if (last && last.kind === "explore" && sameCellActor(last, item)) {
    // Codex coalesces consecutive reads ("Read a, b") and keeps list/search lines in order.
    for (const entry of entries) {
      const tail = last.entries.at(-1);
      if (entry.op === "read" && tail?.op === "read") {
        const merged = [...new Set([...tail.label.split(", "), ...entry.label.split(", ")])];
        tail.label = merged.join(", ");
      } else if (!last.entries.some((existing) => existing.op === entry.op && existing.label === entry.label)) {
        last.entries.push(entry);
      }
    }
    last.status = mergeStatus(last.status, status);
    last.updatedAt = item.updatedAt ?? item.completedAt ?? item.observedAt;
    return;
  }
  cells.push({
    kind: "explore",
    id: item.id,
    status,
    startedAt: item.observedAt,
    entries: [...entries],
    ...cellAttribution(item),
  });
}

function pushEdit(cells: OneWorkCell[], item: OneActivityItem, file: OneWorkEditFile, diff?: string) {
  const status = itemStatus(item);
  const last = cells.at(-1);
  if (last && last.kind === "edit" && sameCellActor(last, item)) {
    const existing = last.files.find((candidate) => candidate.path === file.path);
    if (existing) {
      existing.op = file.op === "write" ? existing.op : "edit";
      if (file.added !== undefined) existing.added = (existing.added ?? 0) + file.added;
      if (file.removed !== undefined) existing.removed = (existing.removed ?? 0) + file.removed;
    } else {
      last.files.push({ ...file });
    }
    if (diff) last.diff = last.diff ? `${last.diff}\n${diff}` : diff;
    last.status = mergeStatus(last.status, status);
    last.updatedAt = item.updatedAt ?? item.completedAt ?? item.observedAt;
    return;
  }
  cells.push({
    kind: "edit",
    id: item.id,
    status,
    startedAt: item.observedAt,
    files: [{ ...file }],
    ...(diff ? { diff } : {}),
    ...cellAttribution(item),
  });
}

export function buildOneWorkPresentation(
  state: OneActivityState,
  locale: "ko" | "en",
  workspacePath: string | null,
): OneWorkPresentation {
  const cells: OneWorkCell[] = [];
  const dividers: OneWorkDivider[] = [];
  const cwd = workspacePath ?? state.cwd ?? null;
  let answerRow: OneActivityItem | undefined;
  let durationMs: number | undefined;
  let terminal: OneWorkPresentation["terminal"];
  let terminalMessage: string | undefined;

  for (const item of state.items) {
    switch (item.kind) {
      case "run": {
        if (item.durationMs != null) durationMs = item.durationMs;
        if (item.status === "failed") {
          terminal = "failed";
          if (item.message?.trim()) terminalMessage = item.message.trim();
        } else if (item.status === "cancelled") terminal = "cancelled";
        else if (item.status === "completed") terminal = "completed";
        break;
      }
      case "terminal": {
        terminal = item.status === "failed" ? "failed" : item.status === "cancelled" ? "cancelled" : "completed";
        if (item.message?.trim()) terminalMessage = item.message.trim();
        break;
      }
      case "result":
        // The answer streams beneath the block; a "Writing answer" row is not
        // something Codex draws and it double-counts the visible text. It is
        // kept aside and used only when nothing else happened (see below).
        if (item.id === "answer:stream") answerRow = item;
        break;
      case "reasoning": {
        const headline = thoughtHeadline(item.text);
        cells.push({
          kind: "thought",
          id: item.id,
          status: itemStatus(item),
          startedAt: item.observedAt,
          ...cellAttribution(item),
          ...(headline ? { headline } : {}),
          ...(item.text?.trim() ? { body: item.text.trim() } : {}),
          ...(item.durationMs != null ? { durationMs: item.durationMs } : {}),
        });
        break;
      }
      case "agent": {
        cells.push({
          kind: "agent",
          id: item.id,
          status: itemStatus(item),
          startedAt: item.observedAt,
          ...cellAttribution(item),
          name: [item.agentName?.trim() || (locale === "ko" ? "에이전트" : "Agent"), item.model].filter(Boolean).join(" · "),
          ...(item.role?.trim() && item.role.trim() !== item.agentName?.trim() ? { role: item.role.trim() } : {}),
          ...(item.phase ? { phase: item.phase } : {}),
          terminalObserved: item.agentTerminalObserved === true,
        });
        break;
      }
      case "notice": {
        const message = (item.noticeI18n?.[locale] ?? item.message ?? "").trim();
        if (!message && !item.activityCode) break;
        const level = item.noticeLevel ?? "info";
        // A `divider` notice (context compaction) is a boundary of the
        // conversation, not a step of this turn's work — Codex draws it as its
        // own line between messages. The typed display flag decides, never the
        // wording.
        if (message && item.noticeDisplay === "divider") {
          dividers.push({ id: item.id, message, observedAt: item.observedAt });
          break;
        }
        cells.push({
          kind: "notice",
          id: item.id,
          status: level === "error" ? "failed" : "completed",
          startedAt: item.observedAt,
          ...cellAttribution(item),
          level,
          message: message || activityCodeCopy(item.activityCode, locale),
          ...(item.activityCode ? { activityCode: item.activityCode } : {}),
          ...(item.detail?.trim() ? { details: item.detail.trim() } : {}),
        });
        break;
      }
      case "tool": {
        if (!item.tool) break;
        const classified = classifyTool(item, cwd);
        const agent = item.agentName?.trim();
        switch (classified.cell) {
          case "explore":
            pushExplore(cells, item, classified.entries);
            break;
          case "edit":
            pushEdit(cells, item, classified.file, classified.diff);
            break;
          case "run":
            cells.push({
              kind: "run",
              id: item.id,
              status: itemStatus(item),
              startedAt: item.observedAt,
              ...cellAttribution(item),
              command: classified.command,
              ...(classified.output ? { output: classified.output } : {}),
              ...(classified.exitCode !== undefined ? { exitCode: classified.exitCode } : {}),
              ...(agent ? { agent } : {}),
            });
            break;
          case "web_search":
            cells.push({ kind: "web_search", id: item.id, status: itemStatus(item), startedAt: item.observedAt, ...cellAttribution(item), query: classified.query, ...(agent ? { agent } : {}) });
            break;
          case "fetch":
            cells.push({
              kind: "fetch",
              id: item.id,
              status: itemStatus(item),
              startedAt: item.observedAt,
              ...cellAttribution(item),
              url: classified.url,
              ...(classified.statusCode !== undefined ? { statusCode: classified.statusCode } : {}),
              ...(agent ? { agent } : {}),
            });
            break;
          case "call":
          default:
            cells.push({
              kind: "call",
              id: item.id,
              status: itemStatus(item),
              startedAt: item.observedAt,
              ...cellAttribution(item),
              label: classified.label,
              toolName: item.tool.name,
              ...(classified.detail ? { detail: classified.detail } : {}),
              ...(item.tool.args ? { args: item.tool.args } : {}),
              ...(item.tool.result ? { result: item.tool.result } : {}),
              ...(item.tool.failureCode ? { failureCode: item.tool.failureCode } : {}),
              ...(agent ? { agent } : {}),
            });
            break;
        }
        break;
      }
      default:
        break;
    }
  }

  const running = !state.terminalStatus && state.items.some((item) => item.status === "running" || item.status === "cancelling");
  // A turn with no thought and no tool still did one thing: it wrote the
  // answer. The block then reads "3s 동안 작업 › 답변 작성함 · 12자" instead of
  // opening onto nothing — every turn keeps its collapsible process.
  if (!cells.some((cell) => cell.kind !== "notice") && answerRow && (answerRow.status !== "running" || running)) {
    cells.push({
      kind: "answer",
      id: answerRow.id,
      status: itemStatus(answerRow),
      startedAt: answerRow.observedAt,
      ...(answerRow.answerChars != null ? { chars: answerRow.answerChars } : {}),
    });
  }
  return {
    cells,
    dividers,
    running,
    headline: liveHeadline(cells, state, locale),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(terminal ? { terminal } : {}),
    ...(terminalMessage ? { terminalMessage } : {}),
  };
}

function activityCodeCopy(code: OneActivityItem["activityCode"], locale: "ko" | "en"): string {
  if (code === "runtime_wait") return locale === "ko" ? "실행 결과를 기다리는 중" : "Waiting for runtime output";
  if (code === "queue_wait") return locale === "ko" ? "차례를 기다리는 중" : "Waiting in queue";
  if (code === "recovery_retry") return locale === "ko" ? "중단된 단계를 다시 시도하는 중" : "Retrying a blocked step";
  if (code === "goal_pass_retry") return locale === "ko" ? "실패한 턴을 잠시 뒤 다시 시도하는 중" : "Retrying the failed pass shortly";
  if (code === "session_resume") return locale === "ko" ? "이전 실행을 이어가는 중" : "Resuming the previous run";
  return "";
}

/** Verb for a cell, in the tense its status calls for. */
export function cellVerb(cell: OneWorkCell, locale: "ko" | "en"): string {
  const running = cell.status === "running";
  const ko = locale === "ko";
  switch (cell.kind) {
    case "thought":
      return running ? (ko ? "생각하는 중" : "Thinking") : (ko ? "생각함" : "Thought");
    case "explore":
      return running ? (ko ? "탐색하는 중" : "Exploring") : (ko ? "탐색함" : "Explored");
    case "run":
      return running ? (ko ? "실행하는 중" : "Running") : (ko ? "실행함" : "Ran");
    case "edit": {
      const allWrites = cell.files.every((file) => file.op === "write");
      if (allWrites) return running ? (ko ? "작성하는 중" : "Writing") : (ko ? "작성함" : "Wrote");
      return running ? (ko ? "편집하는 중" : "Editing") : (ko ? "편집함" : "Edited");
    }
    case "web_search":
      return running ? (ko ? "웹 검색하는 중" : "Searching the web") : (ko ? "웹 검색함" : "Searched the web");
    case "fetch":
      return running ? (ko ? "페이지 읽는 중" : "Fetching") : (ko ? "페이지 읽음" : "Fetched");
    case "call":
      return running ? (ko ? "호출하는 중" : "Calling") : (ko ? "호출함" : "Called");
    case "agent":
      // A whole-run final closes pending display rows too. Only the worker's
      // own typed terminal receipt can say that this agent finished.
      if (!running && !cell.terminalObserved) {
        if (cell.phase === "plan") return ko ? "계획 기록" : "Planning activity";
        if (cell.phase === "synthesize") return ko ? "종합 기록" : "Synthesis activity";
        return ko ? "작업자 실행 기록" : "Worker activity";
      }
      if (cell.status === "failed") return ko ? "단계 실패" : "Step failed";
      if (cell.status === "cancelled") return ko ? "단계 취소" : "Step cancelled";
      if (cell.phase === "plan") return running ? (ko ? "계획 중" : "Planning") : (ko ? "계획 완료" : "Planned");
      if (cell.phase === "synthesize") return running ? (ko ? "결과 종합 중" : "Synthesizing") : (ko ? "결과 종합 완료" : "Synthesized");
      return running ? (ko ? "작업자 실행 중" : "Worker running") : (ko ? "이번 실행 종료" : "Run ended");
    case "answer":
      return running ? (ko ? "답변 작성 중" : "Writing") : (ko ? "답변 작성함" : "Wrote the answer");
    case "notice":
      return "";
    default:
      return "";
  }
}

/** Short object of a cell for the running headline ("Running npm test"). */
export function cellObject(cell: OneWorkCell): string {
  switch (cell.kind) {
    case "explore":
      return cell.entries.at(-1)?.label ?? "";
    case "run":
      return cell.command.length > 60 ? `${cell.command.slice(0, 59)}…` : cell.command;
    case "edit":
      return cell.files.map((file) => basename(file.path)).join(", ");
    case "web_search":
      return cell.query;
    case "fetch":
      return cell.url;
    case "call":
      return cell.label === CONNECTED_TOOL_LABEL ? "" : cell.label;
    case "agent":
      return cell.name;
    default:
      return "";
  }
}

function liveHeadline(cells: OneWorkCell[], state: OneActivityState, locale: "ko" | "en"): string {
  const ko = locale === "ko";
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const cell = cells[index];
    if (cell.status !== "running") continue;
    if (cell.kind === "thought") return cell.headline ?? (ko ? "생각하는 중" : "Thinking");
    if (cell.kind === "notice") continue;
    const object = cellObject(cell);
    const verb = cellVerb(cell, locale);
    return object ? `${verb} · ${object}` : verb;
  }
  // Nothing specific is running (answer streaming, or the runtime is between
  // steps). Reuse the last thought headline rather than a generic word — the
  // model told us what it was doing last.
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const cell = cells[index];
    if (cell.kind === "thought" && cell.headline) return cell.headline;
  }
  if (state.items.some((item) => item.id === "answer:stream" && item.status === "running")) {
    return ko ? "답변 작성 중" : "Writing";
  }
  // 아직 아무것도 안 일어난 실행이 큐에서 차례를 기다리는 중이라면 그렇게 말한다.
  // "작업 중"은 이 경우 사실이 아니고, 사실이 아닌 진행 표시가 재전송을 부른다.
  if (state.items.some((item) => item.kind === "run" && item.status === "running" && item.activityCode === "queue_wait")) {
    return ko ? "차례를 기다리는 중" : "Waiting in queue";
  }
  return ko ? "작업 중" : "Working";
}
