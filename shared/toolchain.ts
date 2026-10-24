// Toolchain — shared pure rules (no Electron, no store).
//
// A Toolchain is an MCP-shaped deterministic tool for an app or web page the agents used to operate by hand
// (owner definition, 2026-10-20): Blender with no MCP gets its own tool; a page posted by looking at it every
// time gets a tool that follows the page's structure, and the tool is repaired when the page changes and
// calls start failing. A Graph is a different thing — recurring work that orchestrates AIs or runs on a
// schedule — and is never a Toolchain.
//
// What lives here: the runtime-independent tool vocabulary repeat detection reads, the fresh-session
// cold-start rule, the search acceptance rule, and the per-Toolchain report ledger shape.
// Nothing here writes anything. Callers own persistence and side effects.

import type { ToolchainAssetsApi } from "./toolchain-asset";

import { isHostPreflightTool } from "./tool-activity";
import { classifyTool } from "./tool-taxonomy";

// ── Runtime-independent tool vocabulary ──────────────────────────────────────

export type ToolClass =
  | "shell_read" // a shell command proven observation-only by parseShellRead
  | "shell" // any other shell command (unknown effect)
  | "file_read"
  | "file_write"
  | "browse_nav"
  | "browse_read"
  | "browse_act"
  | "browse_code"
  | "web_search"
  | "clock"
  | "other";

/** `mcp__agentlas-browser__browser_navigate` / `playwright.browser_navigate` → `browser_navigate`. */
export function normalizeToolName(name: string): string {
  let value = String(name || "").trim();
  const mcp = value.match(/^mcp__[^_]+(?:[-_][^_]+)*__(.+)$/);
  if (mcp) value = mcp[1];
  // `server.tool` → `tool`, but a script name such as `cua_repl.js` is the tool itself.
  const dotted = value.lastIndexOf(".");
  if (dotted >= 0 && dotted < value.length - 1 && !/\.(?:m?js|cjs|py)$/i.test(value)) value = value.slice(dotted + 1);
  return value.toLowerCase();
}

/**
 * Runtime-independent step class. Which runtime calls what by which name is the
 * canonical taxonomy's job (shared/tool-taxonomy.ts) — this file only maps its
 * answer onto the classes repeat detection needs, so a new runtime's tool names are
 * learned in one place.
 */
export function toolClassOf(name: string, args?: unknown): ToolClass {
  const tool = normalizeToolName(name);
  if (tool === "get_current_time") return "clock";
  if (tool.startsWith("browser_") || tool === "cua_repl.js") return browserStepOf(tool);
  const action = classifyTool(tool);
  if (action === "command") return parseShellRead(shellCommandOf(args)) ? "shell_read" : "shell";
  if (action === "read" || action === "search") return "file_read";
  if (action === "file") return "file_write";
  if (action === "fetch") return "web_search";
  if (action === "browser") return "browse_act";
  return "other";
}

// judgment-exempt: this splits a browser step into navigation / observation /
//   interaction so repeat detection can tell one hand-operation from another. It never
//   answers "did the outside change" — that stays with couldHaveChangedTheOutsideWorld.
function browserStepOf(tool: string): ToolClass {
  if (/^browser_(?:navigate|navigate_back|tabs|resize)$/.test(tool)) return "browse_nav";
  if (/^browser_(?:snapshot|find|take_screenshot|wait_for|network_requests?|console_messages|skill_list)$/.test(tool)) return "browse_read";
  if (/^browser_(?:evaluate|run_code|run_code_unsafe|cua_repl)$/.test(tool) || tool === "cua_repl.js") return "browse_code";
  return "browse_act";
}

/**
 * Host rows are not agent actions. The host's own recognizer is the single
 * definition (shared/tool-activity.ts) — a second copy here would drift.
 */
export function isHostPseudoToolEvent(payload: { toolName?: unknown }): boolean {
  return typeof payload.toolName === "string" && isHostPreflightTool(payload.toolName);
}

// ── Shell reads ──────────────────────────────────────────────────────────────

/** The command string inside a tool's argument bag, whatever the runtime calls it. */
export function shellCommandOf(args: unknown): string {
  let value: unknown = args;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return value as string; }
  }
  if (!value || typeof value !== "object") return "";
  const bag = value as Record<string, unknown>;
  const raw = bag.command ?? bag.cmd ?? bag.CommandLine ?? bag.commandLine;
  if (Array.isArray(raw)) return raw.map(String).join(" ");
  return typeof raw === "string" ? raw : "";
}

export interface ShellRead {
  verb: "tail" | "head" | "cat";
  /** Relative to the run's working folder; never absolute, never escaping it. */
  path: string;
  /** Lines requested (tail/head); null for cat. */
  lines: number | null;
}

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9가-힣._\-/]+$/;

/**
 * A shell command that only reads one relative file. Anything with a pipe,
 * redirect, substitution, glob, chain or absolute path is not proven read-only.
 */
export function parseShellRead(command: string): ShellRead | null {
  let text = String(command || "").trim();
  // Runtime login-shell wrappers: /bin/zsh -lc '…', bash -lc "…", sh -c '…'
  const wrapped = text.match(/^(?:\/(?:usr\/)?bin\/)?(?:zsh|bash|sh)\s+-l?c\s+(['"])([\s\S]*)\1$/);
  if (wrapped) text = wrapped[2].trim();
  if (!text || /[|;&<>`$*?(){}\[\]\\\n]/.test(text)) return null;
  const parts = text.split(/\s+/);
  const verb = parts[0];
  if (verb === "cat" && parts.length === 2 && SAFE_PATH.test(parts[1])) return { verb: "cat", path: parts[1], lines: null };
  if (verb !== "tail" && verb !== "head") return null;
  let lines: number | null = 10;
  let index = 1;
  if (parts[index] === "-n" && /^\d{1,4}$/.test(parts[index + 1] ?? "")) { lines = Number(parts[index + 1]); index += 2; }
  else if (/^-n\d{1,4}$/.test(parts[index] ?? "")) { lines = Number(parts[index].slice(2)); index += 1; }
  else if (/^-\d{1,4}$/.test(parts[index] ?? "")) { lines = Number(parts[index].slice(1)); index += 1; }
  if (parts.length !== index + 1 || !SAFE_PATH.test(parts[index])) return null;
  return { verb, path: parts[index], lines };
}

// ── Fresh-session cold start ─────────────────────────────────────────────────

/** A fresh session, given only the task and the catalog, must find, choose and fill the Toolchain. */
export interface ToolchainColdStartResult {
  at: string;
  positives: number;
  /** Positives where search returned this Toolchain at all (search recall, before the model chooses). */
  positiveFound?: number;
  positiveSelected: number;
  positiveBound: number;
  negatives: number;
  negativeSelected: number;
  passed: boolean;
  model: string | null;
  /** Every probe, so a failure says where it failed: search, choice, or input binding. */
  cases?: Array<{ kind: "positive" | "negative"; task: string; found: boolean; selected: boolean; bound: boolean }>;
}

export const COLD_START_POLICY = { minSelectionAndBinding: 0.9, maxNegativeSelections: 0, maxCallable: 30, searchLimit: 5 } as const;

export function coldStartPassed(result: ToolchainColdStartResult): boolean {
  if (result.positives <= 0 || result.negatives <= 0) return false;
  return result.positiveSelected / result.positives >= COLD_START_POLICY.minSelectionAndBinding
    && result.positiveBound / result.positives >= COLD_START_POLICY.minSelectionAndBinding
    && result.negativeSelected <= COLD_START_POLICY.maxNegativeSelections;
}

// ── Search acceptance ────────────────────────────────────────────────────────
//
// Ranking itself is the product's one hybrid ranker (electron/memory/local-embedding
// rankHybridLocal: multilingual model2vec + lexical, thresholds already calibrated
// for Korean). This is only the acceptance rule on its measurements, so it can be
// tested without a model. Search is for recall — the caller (an agent, or the
// cold-start selector) reads when_not_to_use and decides. Below both floors nothing returns:
// the empty answer is the honest one (the design plugin was attached to 370 runs
// by a keyword fallback and used by 3).

export interface ToolchainSearchMeasurement {
  id: string;
  score: number;
  lexicalScore: number;
  /** The ranker's own semantic gate (model-specific floor and relative floor). */
  semanticEligible: boolean;
}

export interface ToolchainSearchHit {
  id: string;
  score: number;
}

export const SEARCH_POLICY = { lexicalFloor: 0.2 } as const;

export function acceptToolchainHits(measured: ToolchainSearchMeasurement[], limit: number = COLD_START_POLICY.searchLimit): ToolchainSearchHit[] {
  return measured
    // Exclusions are not scored here. A first version dropped a hit when the task
    // matched when_not_to_use "better" — comparing scores across two rankings, so an
    // English request overlapping boilerplate words ("the", "output") lost a correct
    // match (cold-start: 0/5 found). The contract carries when_not_to_use and the
    // caller decides; in real cold-start tests that caller made 0 wrong picks.
    .filter((entry) => entry.semanticEligible || entry.lexicalScore >= SEARCH_POLICY.lexicalFloor)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(limit, COLD_START_POLICY.searchLimit)))
    .map(({ id, score }) => ({ id, score }));
}

// ── Per-Toolchain ledger (meta document) ─────────────────────────────────────

/** One small document per Toolchain (key `asset:<id>`): caller reports, repairs and search exposure. */
export interface ToolchainLedgerState {
  schemaVersion: "agentlas.toolchain-state.v1";
  /** The ledger key. The field name is kept so documents already stored keep parsing. */
  automationId: string;
  /** Compare-and-set counter; every write must present the revision it read. */
  revision: number;
  /** Problems callers reported (toolchain_report): the event that travels up to whoever made it. Newest last. */
  reports?: ToolchainReport[];
  /** Repairs its making conversation applied (repair budget). Newest last. */
  repairs?: Array<{ at: string; chatId: string }>;
}

/**
 * A caller's "this call was wrong for this input" (result → repair loop). A caller never
 * repairs a Toolchain it did not make; it reports, and the conversation that made it decides.
 */
export interface ToolchainReport {
  id: string;
  at: string;
  /** The conversation (Work task or One's) that ran it and reported. */
  reporterChatId: string;
  /** The exact call the report is about. */
  eventId: string;
  problem: string;
  expected: string | null;
  /** open until a repair changes the definition or the owner dismisses it. */
  state: "open" | "repaired" | "dismissed";
  settledAt?: string;
}

export const TOOLCHAIN_REPORT_POLICY = {
  /** Open reports kept per Toolchain; more are refused until the maker acts (no flood upward). */
  maxOpen: 5,
  /** Reports kept in total, newest last. */
  keep: 20,
  /** Repairs by its making conversation per 24 h without the owner speaking there. */
  repairBudget: 3,
} as const;

export function emptyToolchainLedger(key: string): ToolchainLedgerState {
  return { schemaVersion: "agentlas.toolchain-state.v1", automationId: key, revision: 0 };
}

export type ToolchainsApi = ToolchainAssetsApi;
