// Tool-use episodes: what the agent did by hand on one surface (a site, an app's command line, a script) in one run.
//
// A Toolchain is a deterministic, MCP-shaped tool for something the owner keeps operating by hand: a desktop app that has
// no MCP (Blender), a web page worked through the browser (posting to Threads). Sentences alone cannot see that; the
// repeated thing is the tool use. This file turns a run's tool events into episodes the repeated-work detector can compare.
//
// The rules, each from a measured fact (owner's store, 2026-10-20):
//   · a tool call is two events — a start event with `toolArgs` and a completion event without them (claude-code) — joined
//     by `toolId`;
//   · browser calls after `browser_navigate` carry no URL, so the site is the last one navigated to in the run;
//   · a click's `target` is a snapshot ref (`e148`) that is different on every page load; only a CSS selector is stable.
//     A type's `target` is a selector, so it is stable. Model-written `element` prose is never a template;
//   · values (typed text, dates, ids, paths) vary and become inputs; selectors, key names, flags and script bodies are the
//     stable structure, compared as a hash of the masked step;
//   · reading a page (navigate, look, wait) is not a tool. An episode needs an action.
// Nothing here reads a store or writes anything.

import { createHash } from "node:crypto";
import { normalizeToolName, shellCommandOf, toolClassOf, isHostPseudoToolEvent } from "./toolchain";
import { looksSecret } from "./secret-patterns";

export const TOOL_USE_EPISODE_POLICY = Object.freeze({
  maxStepsPerEpisode: 60,
  /** Characters of one step kept as a readable detail for the judgment and the generalizer. */
  maxDetailChars: 500,
  maxCommandChars: 4000,
  /** Heredoc/inline script body characters hashed as the step's template. */
  maxScriptChars: 4000,
});

export type StepOp = "navigate" | "back" | "click" | "type" | "fill" | "press" | "select" | "upload" | "drag" | "code" | "replay"
  | "look" | "wait" | "hover" | "run" | "inline";
/** Steps that change something or run something. Reading a page is not one. */
const ACTION_OPS = new Set<StepOp>(["click", "type", "fill", "press", "select", "upload", "drag", "code", "replay", "run", "inline"]);

export interface ToolUseStep {
  op: StepOp;
  /** Hash of the masked structure (selector, key, flags, script body); null when the step has no stable structure. */
  template: string | null;
  /** Readable, secret-free description of the step with input values masked. */
  detail: string;
  /**
   * The whole page or inline script of a code step (secret-free, bounded): the evidence a Toolchain is built from. A selector in
   * a Playwright script (getByRole, locator) is what the tool reproduces; a 500-character detail cannot carry it.
   */
  code?: string;
  count: number;
  error: boolean;
}

export interface ToolUseEpisode {
  runId: string;
  chatId: string | null;
  /** `site:threads.com`, `app:blender`, `script:video_pipeline.py`, `inline:python3`. */
  surface: string;
  startedAt: string;
  steps: ToolUseStep[];
  /** Steps after consecutive identical ones are folded, in order, with their template: the flow the detector compares. */
  tokens: string[];
  actionSteps: number;
  /** The last action failed, or most calls errored: such an episode shows the way not to do it. */
  failed: boolean;
}

export interface ToolUseCall {
  toolId: string | null;
  name: string;
  args: Record<string, unknown> | null;
  completed: boolean;
  isError: boolean;
  ts: string;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  let parsed: unknown = value;
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { return null; } }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

/**
 * Joins the start and completion events of each call (by toolId) into one call, in the order the calls began.
 * Host bookkeeping events are not calls. A call with no toolId stands alone.
 */
export function toolUseCallsFromEvents(events: ReadonlyArray<{ ts: string; payload: unknown }>): ToolUseCall[] {
  const calls: ToolUseCall[] = [];
  const byId = new Map<string, ToolUseCall>();
  for (const event of events) {
    const payload = parseObject(event.payload);
    if (!payload || typeof payload.toolName !== "string" || !payload.toolName || isHostPseudoToolEvent(payload)) continue;
    const toolId = typeof payload.toolId === "string" && payload.toolId ? payload.toolId : null;
    const args = parseObject(payload.toolArgs);
    const completed = payload.toolCompleted === true, isError = payload.toolIsError === true;
    const existing = toolId ? byId.get(toolId) : undefined;
    if (existing) {
      if (!existing.args && args) existing.args = args;
      if (completed) { existing.completed = true; existing.isError = isError; }
      continue;
    }
    const call: ToolUseCall = { toolId, name: payload.toolName, args, completed, isError: completed && isError, ts: event.ts };
    calls.push(call);
    if (toolId) byId.set(toolId, call);
  }
  return calls;
}

// ── masking ─────────────────────────────────────────────────────────────────

function hash(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 10); }

/** A snapshot ref or a bare index: different on every page load, so it names nothing. */
const VOLATILE_TARGET = /^(?:[a-z]?\d+(?:e\d+)?|e\d+|f\d+(?:e\d+)?)$/i;

function stableTarget(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const target = value.trim();
  return target && target.length <= 300 && !VOLATILE_TARGET.test(target) ? target : null;
}

/**
 * A script's identity for comparing runs: the set of quoted strings it contains (selectors, field names, URLs, flags), digits
 * masked. The model rewrites the same page script a little each run (variable names, order, a date); the elements it
 * touches stay. A script with fewer than two strings falls back to its whitespace-folded body.
 */
function codeTemplate(code: unknown): string | null {
  if (typeof code !== "string" || !code.trim()) return null;
  const literals = new Set<string>();
  for (const match of code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n]){2,80})\1/g)) literals.add(match[2].replace(/\d+/g, "0"));
  if (literals.size >= 2) return hash([...literals].sort().join("\0").slice(0, TOOL_USE_EPISODE_POLICY.maxScriptChars));
  const folded = code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1").replace(/\s+/g, " ").replace(/\d+/g, "0").trim();
  return folded ? hash(folded.slice(0, TOOL_USE_EPISODE_POLICY.maxScriptChars)) : null;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TOOL_USE_EPISODE_POLICY.maxDetailChars ? `${flat.slice(0, TOOL_USE_EPISODE_POLICY.maxDetailChars)}…` : flat;
}

/** Detail text for a step; never carries a secret-shaped value. */
function safeDetail(text: string): string { return looksSecret(text) ? "<redacted>" : clip(text); }

function pathShape(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean).slice(0, 4).map(part =>
    /^(?:[0-9]+|[0-9a-f]{8,}|[A-Za-z0-9_-]{20,}|UC[\w-]{20,}|@.+)$/i.test(part) ? ":id" : part.toLowerCase().slice(0, 40));
  return `/${parts.join("/")}`;
}

function siteOf(url: unknown): { host: string; shape: string } | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (!host || host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost")) return null;
    return { host, shape: pathShape(parsed.pathname) };
  } catch { return null; }
}

// ── browser steps ───────────────────────────────────────────────────────────

const LOOK = new Set(["browser_snapshot", "browser_find", "browser_take_screenshot", "browser_network_requests", "browser_network_request",
  "browser_console_messages", "browser_skill_list", "browser_handle_dialog"]);
const NEUTRAL = new Set(["browser_tabs", "browser_resize", "browser_close", "browser_emulate_media"]);

interface Shaped { op: StepOp; template: string | null; detail: string; code?: string }

/** A script kept as evidence: bounded, and dropped entirely when it holds a secret-shaped value. */
function evidenceCode(code: string | null | undefined): { code?: string } {
  if (!code || !code.trim() || looksSecret(code)) return {};
  return { code: code.length > TOOL_USE_EPISODE_POLICY.maxScriptChars ? code.slice(0, TOOL_USE_EPISODE_POLICY.maxScriptChars) : code };
}

function browserStep(tool: string, args: Record<string, unknown> | null): Shaped | null {
  const a = args ?? {};
  if (NEUTRAL.has(tool)) return null;
  if (LOOK.has(tool)) return { op: "look", template: null, detail: tool.replace(/^browser_/, "") };
  switch (tool) {
    case "browser_navigate_back": return { op: "back", template: null, detail: "back" };
    case "browser_wait_for": return { op: "wait", template: null, detail: "wait" };
    case "browser_hover": return { op: "hover", template: null, detail: "hover" };
    case "browser_click": {
      const target = stableTarget(a.target);
      return { op: "click", template: target ? hash(`click\0${target}`) : null, detail: safeDetail(`click ${target ?? `"${String(a.element ?? "element").slice(0, 80)}"`}`) };
    }
    case "browser_type": case "browser_fill": {
      const target = stableTarget(a.target);
      return { op: "type", template: target ? hash(`type\0${target}`) : null,
        detail: safeDetail(`type into ${target ?? `"${String(a.element ?? "field").slice(0, 80)}"`} <text>`) };
    }
    case "browser_fill_form": {
      const fields = Array.isArray(a.fields) ? a.fields : [];
      const names = fields.flatMap(field => field && typeof field === "object" && typeof (field as { name?: unknown }).name === "string"
        ? [String((field as { name: string }).name).slice(0, 60)] : []);
      return { op: "fill", template: names.length ? hash(`fill\0${names.join("\0")}`) : null, detail: safeDetail(`fill form fields: ${names.join(", ") || "?"} <values>`) };
    }
    case "browser_press_key": {
      const key = typeof a.key === "string" ? a.key.slice(0, 30) : "?";
      return { op: "press", template: hash(`press\0${key}`), detail: `press ${key}` };
    }
    case "browser_select_option": {
      const target = stableTarget(a.target);
      return { op: "select", template: target ? hash(`select\0${target}`) : null, detail: safeDetail(`select in ${target ?? "dropdown"} <value>`) };
    }
    case "browser_file_upload": case "browser_drop": return { op: "upload", template: hash("upload"), detail: "upload <file>" };
    case "browser_drag": return { op: "drag", template: null, detail: "drag" };
    case "browser_evaluate": case "browser_run_code_unsafe": case "browser_run_code": {
      const code = typeof a.function === "string" ? a.function : typeof a.code === "string" ? a.code : "";
      return { op: "code", template: codeTemplate(code), detail: safeDetail(`run page script: ${code}`), ...evidenceCode(code) };
    }
    case "browser_skill_replay": {
      const name = typeof a.name === "string" ? a.name.slice(0, 80) : "?";
      return { op: "replay", template: hash(`replay\0${name}`), detail: `replay saved browser skill ${name}` };
    }
    default: return null;
  }
}

// ── shell steps ─────────────────────────────────────────────────────────────

/** Programs every shell session uses; seeing one says nothing about which app the work was for. */
const COMMON_PROGRAMS = new Set(("ls cat grep rg sed awk head tail echo cd pwd mkdir rm mv cp touch find sort uniq wc cut tr xargs tee test true false sleep date " +
  "env export set which type dirname basename readlink realpath stat du df diff cmp chmod chown ln git gh npm pnpm yarn tsc zsh bash sh open curl wget jq " +
  "sqlite3 shasum md5 md5sum sha256sum sudo kill pkill pgrep ps lsof printf read exit source printenv nl tar zip unzip gzip gunzip mktemp file less more man " +
  "code vim nano node npx python python3 pip pip3 uv uvx deno bun ruby perl make cargo go java swift xcrun xcodebuild brew agentlas hephaestus claude codex sysctl nproc uptime uname sw_vers whoami hostname id launchctl defaults say afplay pbcopy pbpaste osascript killall top vm_stat df mdfind ioreg system_profiler").split(/\s+/));
/** Words that begin a line of shell or Python but name no program (a heredoc body or a loop is not an app). */
const NOT_PROGRAMS = new Set(("for do done if then fi else elif while until case esac function select in time assert import from def class return with try except " +
  "finally raise pass break continue lambda print yield async await and or not none true false null no ok yes").split(/\s+/));
/** Programs that run a script: the script (or inline body) is the tool, not the interpreter. */
const INTERPRETERS = new Set(["python", "python3", "node", "deno", "bun", "ruby", "perl", "bash", "sh", "zsh", "uv"]);
const WRAPPERS = new Set(["env", "sudo", "time", "nice", "nohup", "caffeinate", "command", "exec", "arch", "stdbuf", "timeout"]);

const SHELL_WRAP = /^(?:\/(?:usr\/)?bin\/)?(?:zsh|bash|sh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/;

/** Splits on the shell operators that start a new command, outside quotes. Only the first logical line (before a heredoc) is read. */
function commandSegments(command: string): { segments: string[]; heredoc: string | null } {
  let text = command.length > TOOL_USE_EPISODE_POLICY.maxCommandChars ? command.slice(0, TOOL_USE_EPISODE_POLICY.maxCommandChars) : command;
  const wrapped = SHELL_WRAP.exec(text.trim());
  if (wrapped) text = wrapped[2];
  let heredoc: string | null = null;
  const marker = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n/.exec(text);
  if (marker) {
    const bodyStart = marker.index + marker[0].length;
    const end = text.indexOf(`\n${marker[2]}`, bodyStart);
    heredoc = text.slice(bodyStart, end >= 0 ? end : text.length);
    text = text.slice(0, marker.index + marker[0].length - 1);
  }
  const segments: string[] = [];
  let current = "", quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { current += ch; if (ch === "\\" && quote === '"') { current += text[++i] ?? ""; } else if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "\\") { current += ch + (text[++i] ?? ""); continue; }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") { if (current.trim()) segments.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return { segments, heredoc };
}

function words(segment: string): string[] {
  const out: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let match = pattern.exec(segment); match; match = pattern.exec(segment)) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

/** The last segment of a path in either spelling: `C:\\Program Files\\Blender\\blender.exe` is the same program as `/usr/bin/blender`. */
function baseName(path: string): string { return path.split(/[\\/]/).pop() ?? path; }

function programName(word: string): string {
  const base = baseName(word);
  return base.replace(/\.(?:exe|app)$/i, "").toLowerCase();
}

/**
 * What a command line IS, for comparing runs: its subcommand word and the set of flag names before any `--`. Flag values,
 * paths and pass-through arguments are inputs, so `blender -b -t 4 -P a.py -- --still` and `-P b.py -- --layout` are one shape.
 */
function cliShape(argv: readonly string[]): string {
  const flags = new Set<string>();
  let subcommand = "";
  for (const word of argv) {
    if (word === "--") break;
    if (word.startsWith("-")) { flags.add(word.split("=")[0]); continue; }
    if (!subcommand && flags.size === 0 && /^[a-z][a-z0-9-]{1,24}$/.test(word)) subcommand = word;
  }
  return [subcommand, ...[...flags].sort()].filter(Boolean).join(" ");
}

/** The same command line with its inputs masked, for a person reading the step. */
function maskedShape(argv: readonly string[]): string {
  const shape: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word.startsWith("-")) { shape.push(word.split("=")[0]); continue; }
    if (/^[a-z][a-z0-9-]{1,24}$/.test(word) && shape.length === 0) { shape.push(word); continue; }
    // A file or script name says what the command works on; the directory is the owner's machine. Names stay, numbers and prose do not.
    shape.push(/^https?:/.test(word) ? `<url ${siteOf(word)?.host ?? ""}>`.replace(" >", ">") : /[\\/]|\.\w{1,5}$/.test(word) ? `<${baseName(word).slice(0, 40)}>` : /^\d/.test(word) ? "<n>" : "<s>");
  }
  return shape.join(" ");
}

function shellSteps(command: string): Array<Shaped & { surface: string }> {
  const { segments, heredoc } = commandSegments(command);
  const steps: Array<Shaped & { surface: string }> = [];
  for (const segment of segments) {
    const argv = words(segment);
    while (argv.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]) || WRAPPERS.has(programName(argv[0])))) argv.shift();
    if (!argv.length) continue;
    const program = programName(argv[0]);
    const rest = argv.slice(1);
    if (INTERPRETERS.has(program)) {
      const flagIndex = rest.findIndex(word => word === "-c" || word === "-e" || word === "-");
      const scriptIndex = rest.findIndex(word => !word.startsWith("-") && /\.(?:py|m?js|cjs|ts|rb|pl|sh)$/i.test(word));
      if (scriptIndex >= 0 && (flagIndex < 0 || scriptIndex < flagIndex)) {
        const name = baseName(rest[scriptIndex]).toLowerCase();
        steps.push({ surface: `script:${name}`, op: "run", template: hash(`script\0${name}\0${cliShape(rest.slice(scriptIndex + 1))}`),
          detail: safeDetail(`run script ${name} ${maskedShape(rest.slice(scriptIndex + 1))}`) });
      } else if (flagIndex >= 0) {
        // `python3 - <<'PY'` reads its body from the heredoc; `-c "…"` carries it as the next word.
        const body = rest[flagIndex] === "-" ? heredoc : rest[flagIndex + 1] ?? null;
        // An inline script is its own tool: the surface carries the script's hash, so only the same script grouped together counts.
        const template = body === null ? null : codeTemplate(body);
        if (template) steps.push({ surface: `inline:${program}#${template}`, op: "inline", template, detail: safeDetail(`run inline ${program} script: ${body}`), ...evidenceCode(body) });
      }
      continue;
    }
    if (COMMON_PROGRAMS.has(program) || NOT_PROGRAMS.has(program) || !/^[a-z][a-z0-9._+-]{1,40}$/.test(program)) continue;
    const shape = maskedShape(rest);
    steps.push({ surface: `app:${program}`, op: "run", template: hash(`app\0${program}\0${cliShape(rest)}`), detail: safeDetail(`${program} ${shape}`) });
  }
  return steps;
}

// ── episodes ────────────────────────────────────────────────────────────────

function tokenOf(surface: string, step: Pick<ToolUseStep, "op" | "template">): string {
  return `${surface}|${step.op}${step.template ? `#${step.template}` : ""}`;
}

/**
 * The episodes of one run: its calls grouped by surface, in order. An episode needs an action step; a browser episode needs
 * at least two steps (arriving and acting). Consecutive identical steps fold into one with a count.
 */
export function buildToolUseEpisodes(run: { runId: string; chatId: string | null }, calls: readonly ToolUseCall[]): ToolUseEpisode[] {
  const bySurface = new Map<string, { startedAt: string; steps: ToolUseStep[]; errors: number; total: number }>();
  const order: string[] = [];
  let site: string | null = null;
  const push = (surface: string, shaped: Shaped, call: ToolUseCall) => {
    let entry = bySurface.get(surface);
    if (!entry) { entry = { startedAt: call.ts, steps: [], errors: 0, total: 0 }; bySurface.set(surface, entry); order.push(surface); }
    entry.total++; if (call.isError) entry.errors++;
    const last = entry.steps.at(-1);
    if (last && last.op === shaped.op && last.template === shaped.template) { last.count++; last.error = last.error || call.isError; return; }
    if (entry.steps.length < TOOL_USE_EPISODE_POLICY.maxStepsPerEpisode) entry.steps.push({ op: shaped.op, template: shaped.template, detail: shaped.detail,
      ...(shaped.code ? { code: shaped.code } : {}), count: 1, error: call.isError });
  };
  for (const call of calls) {
    const tool = normalizeToolName(call.name);
    if (tool.startsWith("browser_")) {
      if (tool === "browser_navigate") {
        const target = siteOf(call.args?.url);
        if (!target) { site = null; continue; }
        site = `site:${target.host}`;
        push(site, { op: "navigate", template: hash(`navigate\0${target.host}${target.shape}`), detail: `navigate ${target.host}${target.shape}` }, call);
        continue;
      }
      if (!site) continue;
      const shaped = browserStep(tool, call.args);
      if (shaped) push(site, shaped, call);
      continue;
    }
    const cls = toolClassOf(call.name, call.args ?? undefined);
    if (cls !== "shell") continue;
    for (const step of shellSteps(shellCommandOf(call.args ?? undefined))) push(step.surface, step, call);
  }
  const episodes: ToolUseEpisode[] = [];
  for (const surface of order) {
    const entry = bySurface.get(surface)!;
    const actionSteps = entry.steps.filter(step => ACTION_OPS.has(step.op)).length;
    const isSite = surface.startsWith("site:");
    if (!actionSteps || (isSite && entry.steps.length < 2)) continue;
    const lastAction = [...entry.steps].reverse().find(step => ACTION_OPS.has(step.op));
    episodes.push({ runId: run.runId, chatId: run.chatId, surface, startedAt: entry.startedAt, steps: entry.steps,
      tokens: entry.steps.filter(step => step.op !== "look" && step.op !== "wait").map(step => tokenOf(surface, step)),
      actionSteps, failed: Boolean(lastAction?.error) || entry.errors * 2 > entry.total });
  }
  return episodes;
}

export function isActionStep(step: Pick<ToolUseStep, "op">): boolean { return ACTION_OPS.has(step.op); }
export function surfaceKind(surface: string): "site" | "app" | "script" | "inline" | "other" {
  const kind = surface.split(":")[0];
  return kind === "site" || kind === "app" || kind === "script" || kind === "inline" ? kind : "other";
}
