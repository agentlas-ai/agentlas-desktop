/**
 * Outward effect — did this run change something outside the agent's own workspace toward its goal?
 *
 * Why this is a separate question from "could this tool call have changed the outside world"
 * (shared/tool-activity.ts): that predicate answers replay safety, where "unknown" must mean
 * "maybe changed" (conservative = do not replay). Used as a *progress* signal the same "unknown"
 * became success. Measured 2026-09-24 on the owner's Threads automation (f7a61706): runs
 * 18:00–23:00Z posted nothing, yet every run showed acting calls — apply_patch/bash on the agent's
 * own playbook file in userData/agent-cwd, and browser_click on activity-filter tabs. So
 * actionCalls > 0, no self_hold, no replan, six hours of holds counted as work.
 *
 * Progress counts only outcomes (the OKR "outcome, not activity" rule; tau-bench grades the end
 * state, not the trajectory). Local ledger edits, shell, navigation and filter clicks are activity.
 *
 * The rules reuse existing classifiers instead of new name lists:
 *  - browser: the shipped browser approval classifier (BROWSER_APPROVAL_CLASSIFIER_SOURCE). Its
 *    send/publish class is deliberately over-inclusive for safety (a "답글 필터" tab click reads as
 *    "send"), so for progress a send/publish only counts as a commit when it completes something
 *    the run composed (typed/filled/uploaded) or when the control is an explicit finalize
 *    (the same classifier's EXPLICIT_FINALIZE_RE). delete/payment count as they are.
 *  - files: shared/tool-taxonomy "file" actions. A write inside the host's own scratch cwd
 *    (userData/agent-cwd — where the agent works when the owner declared no folder) is the agent's
 *    notebook; a write anywhere else (project folder, chat working folder, any declared path) is a
 *    deliverable.
 *  - one-click social engagement (follow/like/repost/subscribe) counts only from the launcher's
 *    post-click state receipt (browser_action_logs "social-engage" / "changed"), never from intent.
 *  - shell: only a command that clearly sends outward — curl/wget/httpie with a write method or a
 *    request body, to a non-loopback URL (shellSendsOutward). Other shell never counts.
 *  - host builtins that are read-only by construction (system time) and host preflight/supervisor
 *    notices never count; read/search/fetch/delegate never count on their own.
 *  - anything else keeps the existing couldHaveChangedTheOutsideWorld answer (external MCP writes).
 *  - a call whose receipt failed did nothing.
 */
import path from "node:path";
import fs from "node:fs";
import { classifyTool } from "../shared/tool-taxonomy";
import { couldHaveChangedTheOutsideWorld, isHostPreflightTool, isHostSupervisorNotice } from "../shared/tool-activity";
import { BROWSER_APPROVAL_CLASSIFIER_SOURCE } from "./mcp-tools/browser-cdp-launcher";
import { AGENTLAS_SYSTEM_TIME_CATALOG_ID, AGENTLAS_SYSTEM_TIME_TOOL_NAMES } from "./mcp-tools/system-time-server";

export type OutwardEffectKind = "browser_commit" | "social_engage" | "external_mutation" | "shell_send" | "deliverable_file";

export interface OutwardToolCall {
  name: string;
  /** Parsed tool arguments (object/array) or the raw JSON string the runtime reported. */
  args: unknown;
  failed: boolean;
}

export interface OutwardEffectContext {
  /** The agent's own scratch roots. Writes inside them are notes, not deliverables. */
  scratchRoots: string[];
  /** Directory relative paths resolve against (the run cwd). Defaults to the first scratch root. */
  cwd?: string | null;
  /** One-click engagements the browser launcher verified by a post-click state change during this run. */
  verifiedSocialEngagements?: number;
}

export interface OutwardEffectSummary {
  outwardEffects: number;
  kinds: OutwardEffectKind[];
  /** Calls that were local work only (notes, shell, navigation, observation). */
  localWork: number;
}

type BrowserClass = "payment" | "delete" | "publish" | "send" | "unsafe-code" | null;
let browserClassifier: { classify: (name: string, args: unknown) => BrowserClass; finalize: RegExp } | null = null;

function browserApproval(): { classify: (name: string, args: unknown) => BrowserClass; finalize: RegExp } {
  if (browserClassifier) return browserClassifier;
  // The exact source the materialized launcher runs — no drift between the gate and this signal.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const built = new Function(`${BROWSER_APPROVAL_CLASSIFIER_SOURCE}\nreturn { classifyAction, EXPLICIT_FINALIZE_RE };`)() as {
    classifyAction: (name: string, args: unknown, currentUrl?: string) => BrowserClass;
    EXPLICIT_FINALIZE_RE: RegExp;
  };
  browserClassifier = { classify: (name, args) => built.classifyAction(name, args, ""), finalize: built.EXPLICIT_FINALIZE_RE };
  return browserClassifier;
}

/** Last segment of a namespaced tool name (`mcp__srv__tool`, `srv·tool`, `srv/tool`, `srv.tool`). */
export function outwardToolLeaf(name: string): string {
  return name.split(/__|·|\/|\./).pop()?.trim().toLowerCase() ?? "";
}

function toolServer(name: string): string {
  const parts = name.split(/__|·|\/|\./).map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (parts[0] === "mcp") parts.shift();
  return parts.length > 1 ? parts[0] : "";
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== "string") return args;
  try { return JSON.parse(args); } catch { return null; }
}

const COMPOSE_LEAVES = new Set(["browser_type", "browser_fill", "browser_fill_form", "browser_file_upload"]);

function isBrowserTool(name: string, leaf: string): boolean {
  return leaf.startsWith("browser_") || classifyTool(leaf || name) === "browser";
}

function controlText(args: unknown): string {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  return [input.element, input.target, input.name, input.label]
    .filter((value): value is string => typeof value === "string").join(" ");
}

/** Paths a file tool touched (codex apply_patch lists, claude/grok/filesystem path arguments). */
function fileTargets(args: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const row = value as Record<string, unknown>;
    for (const key of ["path", "file_path", "filePath", "target_file", "targetFile", "notebook_path"]) {
      if (typeof row[key] === "string" && row[key]) out.push(row[key] as string);
    }
    if (Array.isArray(row.changes)) visit(row.changes);
    if (Array.isArray(row.files)) visit(row.files);
  };
  visit(args);
  return out;
}

function canonical(p: string): string {
  const resolved = path.resolve(p);
  try { return fs.realpathSync(resolved); } catch { /* the file may be gone; canonicalize its parent */ }
  try { return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)); } catch { return resolved; }
}

function isInside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function insideScratch(target: string, ctx: OutwardEffectContext): boolean {
  const roots = ctx.scratchRoots.filter(Boolean);
  if (roots.length === 0) return false;
  const base = ctx.cwd || roots[0];
  const absolute = path.isAbsolute(target) ? target : path.join(base, target);
  const candidates = [path.resolve(absolute), canonical(absolute)];
  return roots.some((root) => {
    const rootForms = [path.resolve(root), canonical(root)];
    return candidates.some((c) => rootForms.some((r) => isInside(c, r)));
  });
}

/** Classify one run's host-recorded tool calls, in order. */
export function summarizeOutwardEffects(calls: OutwardToolCall[], ctx: OutwardEffectContext): OutwardEffectSummary {
  const kinds = new Set<OutwardEffectKind>();
  let outwardEffects = 0;
  let localWork = 0;
  let composed = false;
  const count = (kind: OutwardEffectKind) => { outwardEffects += 1; kinds.add(kind); };
  for (const call of calls) {
    const name = call.name.trim();
    if (!name || isHostPreflightTool(name) || isHostSupervisorNotice(name)) continue;
    if (call.failed) { localWork += 1; continue; }
    const leaf = outwardToolLeaf(name);
    const args = parseArgs(call.args);
    if (toolServer(name) === AGENTLAS_SYSTEM_TIME_CATALOG_ID
      && (AGENTLAS_SYSTEM_TIME_TOOL_NAMES as readonly string[]).includes(leaf)) { localWork += 1; continue; }
    if (isBrowserTool(name, leaf)) {
      const approval = browserApproval();
      let klass: BrowserClass = null;
      try { klass = approval.classify(leaf, args); } catch { klass = null; }
      if (klass === "payment" || klass === "delete") { count("browser_commit"); composed = false; continue; }
      if (klass === "publish" || klass === "send") {
        const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
        const typedAndSubmitted = leaf === "browser_type" && input.submit === true;
        if (composed || typedAndSubmitted || approval.finalize.test(controlText(args))) {
          count("browser_commit");
          composed = false;
          continue;
        }
      }
      if (COMPOSE_LEAVES.has(leaf)) composed = true;
      localWork += 1;
      continue;
    }
    const action = classifyTool(leaf || name);
    if (action === "file") {
      const targets = fileTargets(args);
      // A write we cannot place is not proven to be the agent's notebook.
      if (targets.length === 0 || targets.some((target) => !insideScratch(target, ctx))) count("deliverable_file");
      else localWork += 1;
      continue;
    }
    if (action === "command") {
      const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
      const command = typeof input.command === "string" ? input.command
        : Array.isArray(input.command) ? input.command.filter((part) => typeof part === "string").join(" ") : "";
      if (shellSendsOutward(command)) count("shell_send");
      else localWork += 1;
      continue;
    }
    if (action === "read" || action === "search" || action === "fetch" || action === "delegate" || action === "browser") {
      localWork += 1;
      continue;
    }
    if (couldHaveChangedTheOutsideWorld(name)) count("external_mutation");
    else localWork += 1;
  }
  for (let i = 0; i < Math.max(0, Math.min(500, ctx.verifiedSocialEngagements ?? 0)); i += 1) count("social_engage");
  return { outwardEffects, kinds: [...kinds], localWork };
}

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|[^.]+\.local|[^.]+\.localhost|host\.docker\.internal)$/i;
const HTTP_CLIENT = /(?:^|[\s;&|(/'"])(curl|wget|http|https|xh)(?=\s)/;
const WRITE_METHOD = /(?:^|\s)(?:-X\s*|--request[=\s]+|--method[=\s]+)['"]?(POST|PUT|DELETE|PATCH)\b/i;
const CURL_BODY = /(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?|-F|--form(?:-string)?|--json|-T|--upload-file)(?=[\s=]|$)|(?:^|\s)-d\S/;
const WGET_BODY = /(?:^|\s)--(?:post-data|post-file|body-data|body-file)(?=[\s=])/;
const HTTPIE_METHOD = /(?:^|[\s;&|(/'"])(?:http|https|xh)\s+(?:--?\S+\s+)*(POST|PUT|DELETE|PATCH)\s/i;

/**
 * Does this shell command clearly send something outward? Only an HTTP client (curl, wget, httpie,
 * xh) with a write method or a request body, aimed at a non-loopback URL. Reads (a plain GET),
 * loopback/dev servers, and every other command stay local work — "unknown" is not progress.
 */
export function shellSendsOutward(command: string): boolean {
  if (!command || command.length > 20_000) return false;
  const segments = command.split(/\n|&&|\|\||;|\|/);
  return segments.some((segment) => {
    const client = HTTP_CLIENT.exec(segment)?.[1];
    if (!client) return false;
    const urls = [...segment.matchAll(/https?:\/\/([^\s/'"?#:]+|\[[^\]]+\])/gi)].map((m) => m[1]);
    if (urls.length === 0 || urls.every((host) => LOOPBACK_HOST.test(host))) return false;
    if (client === "curl") return WRITE_METHOD.test(segment) || CURL_BODY.test(segment);
    if (client === "wget") return WRITE_METHOD.test(segment) || WGET_BODY.test(segment);
    return HTTPIE_METHOD.test(segment);
  });
}
