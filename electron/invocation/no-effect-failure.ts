/**
 * A failed tool call that could not have changed anything outside is a settled effect.
 *
 * Measured 2026-09-27 on the owner's store (1.2.45, read-only copy), One goals "X Marketing" and
 * "Thread Marketing": every continuation wait was refused as goal_wait_effects_uncertain, and every
 * pending effect ref was `operation:root:root:item_N:failed` — a call whose typed failed result the
 * host had observed. What those calls were:
 *   - bash `wc -l <two skill files> && sed -n '1,320p' <file> && …` (one file did not exist, exit 1)
 *   - agentlas-browser.browser_navigate to a Threads permalink ("agentlas proxy reconnecting")
 *   - agentlas-browser.browser_tabs {"action":"new","url":"https://…"}, browser_wait_for {"text":…},
 *     browser_tabs {"action":"select","index":2} (tab not found)
 *   - hephaestus-network.context.verify / context.impact ("path is not in the map"),
 *     agentlas_tool_search, workforce.goal_context, hephaestus_cloud_search
 * None of them can post, click, type or write. Yet each one kept the whole episode "uncertain", so the
 * next cycle could not be scheduled, an extra read-only observation run had to be spent, and after two
 * such episodes the automatic-goal cap stopped the goal with "I checked twice and could not confirm".
 *
 * The decision uses only machine fields the host recorded before/at the call — the tool name and its
 * arguments — never the result text (a preview is truncated, redacted prose). A call whose arguments
 * cannot be proven observation-only (click, type, evaluate, run_code, python, unknown tools) stays
 * uncertain; that is the truly ambiguous case and goes to the existing read-only effect observation.
 */
import { canonicalAgentlasBrowserToolName } from "../../shared/graph-browser-observation";
import { readOnlyBrowserToolIsMutating } from "../../shared/read-only-browser-tools";

const BROWSER_PREFIX = "mcp__agentlas-browser__";

/**
 * Hephaestus network / Agentlas tools that only read or query (no publish, purchase, lease, invoke,
 * bind, complete or memory write). Names are compared after folding `.` to `_` so the codex spelling
 * (`hephaestus-network.context.impact`) and the Claude spelling (`…__context_impact`) meet.
 */
const READ_ONLY_NETWORK_TOOLS = new Set([
  "workforce_goal_context",
  "agentlas_tool_search",
  "hephaestus_cloud_search",
  "hephaestus_search",
  "hephaestus_network_status",
  "agentlas_auth_status",
  "agentlas_resolve_plugins",
  "workforce_preflight_work_order",
  "context_locate",
  "context_slice",
  "context_refs",
  "context_impact",
  "context_verify",
]);
const NETWORK_SERVER = /^(?:hephaestus-network|agentlas)\.|^mcp__(?:plugin_hephaestus_)?hephaestus-network__|^mcp__agentlas__/;

function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function networkLeaf(name: string): string | null {
  const match = NETWORK_SERVER.exec(name);
  if (!match) return null;
  return name.slice(match[0].length).replace(/\./g, "_");
}

const SHELL_TOOL_NAMES = new Set(["bash", "shell", "exec_command", "run_shell_command", "local_shell"]);

/** Executables whose every form below only reads (no file output option is admitted). */
const READ_ONLY_EXECUTABLES = new Set([
  "cat", "head", "tail", "wc", "ls", "pwd", "stat", "file", "du", "df", "nl", "grep", "egrep", "fgrep",
  "basename", "dirname", "realpath", "readlink", "which", "echo", "true", "test", "date", "uname", "whoami",
  "id", "cut", "tr", "jq", "diff", "cmp", "md5", "shasum", "sha256sum",
]);
const READ_ONLY_GIT = new Set(["status", "log", "show", "diff", "rev-parse", "ls-files", "blame"]);
/** Lookup-only executables whose every form reads (recorded 0b8772c1: `printenv A; printenv B`, `command -v yt-dlp`). */
const READ_ONLY_LOOKUPS = new Set(["printenv", "type", "whereis"]);

function unwrapShell(command: string): string {
  let current = command.trim();
  for (let depth = 0; depth < 2; depth += 1) {
    const match = /^(?:\/usr\/bin\/env\s+)?(?:\/bin\/|\/usr\/bin\/)?(?:ba|z|)sh\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(current);
    if (!match) break;
    current = match[2].trim();
  }
  return current;
}

function words(segment: string): string[] | null {
  const out: string[] = [];
  let word = "", quote: "'" | '"' | null = null;
  for (const char of segment) {
    if (quote) { if (char === quote) quote = null; else word += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/u.test(char)) { if (word) out.push(word); word = ""; continue; }
    word += char;
  }
  if (quote) return null;
  if (word) out.push(word);
  return out;
}

function readOnlySimpleCommand(segment: string): boolean {
  const argv = words(segment);
  if (!argv?.length) return false;
  const raw = argv[0];
  if (raw.includes("/") && !/^\/(?:usr\/)?bin\/[A-Za-z0-9._-]+$/u.test(raw)) return false;
  const exe = raw.replace(/^.*\//u, "");
  const rest = argv.slice(1);
  if (exe === "sed") {
    // Line printing only: `sed -n '1,320p' FILE…`. Any other script (w, e, s///w) or -i is refused.
    return rest[0] === "-n" && /^\d+(?:,\d+)?p$/u.test(rest[1] ?? "") && rest.slice(2).every((word) => !word.startsWith("-"));
  }
  if (exe === "rg") return !rest.some((word) => /^--(?:pre|replace|command)(?:=|$)/u.test(word));
  if (exe === "find") return !rest.some((word) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/u.test(word));
  if (exe === "git") return READ_ONLY_GIT.has(rest[0] ?? "") && !rest.some((word) => /^--output(?:=|$)/u.test(word));
  // `command NAME` runs NAME; only the lookup forms `command -v|-V NAME…` are reads.
  if (exe === "command") return (rest[0] === "-v" || rest[0] === "-V") && rest.length > 1 && rest.slice(1).every((word) => !word.startsWith("-"));
  return READ_ONLY_EXECUTABLES.has(exe) || READ_ONLY_LOOKUPS.has(exe);
}

/** True only for commands made entirely of read-only simple commands joined by && || ; or |. */
export function isNoEffectShellCommand(command: string): boolean {
  const body = unwrapShell(command);
  if (!body || body.length > 4_000) return false;
  // No substitution, redirection, subshell, background job, escape or multi-line script.
  if (/[`$<>()\\\n\r]/u.test(body)) return false;
  const segments: string[] = [];
  let current = "", quote: "'" | '"' | null = null;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote) { if (char === quote) quote = null; current += char; continue; }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    const pair = body.slice(index, index + 2);
    if (pair === "&&" || pair === "||") { segments.push(current); current = ""; index += 1; continue; }
    if (char === "&") return false;
    if (char === ";" || char === "|") { segments.push(current); current = ""; continue; }
    current += char;
  }
  if (quote) return false;
  segments.push(current);
  return segments.every((segment) => readOnlySimpleCommand(segment.trim()));
}

function shellCommand(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  const value = args.command ?? args.cmd;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    const argv = value as string[];
    if (argv.length === 3 && /(?:^|\/)(?:ba|z|)sh$/u.test(argv[0]) && /^-l?c$/u.test(argv[1])) return argv[2];
    return argv.join(" ");
  }
  return null;
}

/**
 * The runtime's own web search (codex `web_search`, Claude `WebSearch`) returns search results to the model and
 * has no argument that can post, send or write. Recorded 0b8772c1 (Youtube launch, 2026-09-27): seven searches were
 * the "last recorded actions" of an interrupted attempt that three read-only looks could never settle.
 */
const RUNTIME_WEB_SEARCH = new Set(["web_search", "WebSearch"]);

/**
 * Playwright MCP spoken by another server name (codex's own `playwright` plugin: `playwright.browser_navigate`;
 * Claude spelling `mcp__playwright__…` / `mcp__plugin_playwright_playwright__…`). Same tool contract as the bundled
 * browser, so the same argument proof applies; only the name spelling differs.
 */
const PLAYWRIGHT_BROWSER = /^(?:playwright\.|mcp__playwright__|mcp__plugin_playwright_playwright__)(browser_[a-z_]+)$/u;

/**
 * Codex computer use (`cua_repl.js`) runs JavaScript, so it is judged by its code: only a program made entirely of
 * awaited getter calls on `cua` (or on a handle one of them returned) with literal arguments is a read. Anything
 * else — tab.click, setValue, typeText, goto, createBrowserTab, expressions, templates, functions — stays unproven.
 * Recorded 0b8772c1: `await cua.getState();` and `let tab = await cua.getTab("…", { browser: "1" });`.
 */
const CUA_TOOL_NAMES = new Set(["cua_repl.js", "mcp__cua_repl__js"]);
const CUA_READ_METHODS = new Set(["getState", "getTab", "getApp", "getBrowser", "listTabs", "getAXState", "getScreenshot", "getAXStateAndScreenshot"]);
const JS_LITERAL = String.raw`(?:"[^"\\\n]*"|'[^'\\\n]*'|-?\d+(?:\.\d+)?|true|false|null)`;
const JS_ARG = String.raw`(?:${JS_LITERAL}|\{\s*(?:[A-Za-z_$][\w$]*\s*:\s*${JS_LITERAL}\s*,?\s*)*\})`;
const CUA_READ_STATEMENT = new RegExp(String.raw`^(?:(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*)?await\s+([A-Za-z_$][\w$]*)\.([A-Za-z]+)\(\s*(?:${JS_ARG}\s*(?:,\s*${JS_ARG}\s*)*)?\)$`, "u");

export function isReadOnlyCuaCode(code: unknown): boolean {
  if (typeof code !== "string" || !code.trim() || code.length > 2_000) return false;
  const statements = code.split(/[;\n]/u).map((statement) => statement.trim()).filter(Boolean);
  if (!statements.length || statements.length > 8) return false;
  const handles = new Set(["cua"]);
  for (const statement of statements) {
    const match = CUA_READ_STATEMENT.exec(statement);
    if (!match || !handles.has(match[2]) || !CUA_READ_METHODS.has(match[3])) return false;
    if (match[1]) handles.add(match[1]);
  }
  return true;
}

/**
 * Whether a recorded call provably left the outside world unchanged, judged only from its recorded name and
 * arguments (never its result text). Holds for a failed call and for a finished one alike: these calls only read.
 * Unknown names and unproven argument shapes answer false.
 */
export function callLeftNoOutsideEffect(input: { toolName: unknown; toolArgs: unknown }): boolean {
  if (typeof input.toolName !== "string" || !input.toolName.trim()) return false;
  const name = input.toolName.trim();
  if (RUNTIME_WEB_SEARCH.has(name)) return true;
  if (CUA_TOOL_NAMES.has(name)) return isReadOnlyCuaCode(parseArgs(input.toolArgs)?.code);
  const playwright = PLAYWRIGHT_BROWSER.exec(name);
  const browser = playwright ? `${BROWSER_PREFIX}${playwright[1]}` : canonicalAgentlasBrowserToolName(name);
  if (browser.startsWith(BROWSER_PREFIX)) {
    const args = parseArgs(input.toolArgs ?? "{}");
    if (!args) return false;
    return !readOnlyBrowserToolIsMutating({ toolName: browser.slice(BROWSER_PREFIX.length), args });
  }
  const leaf = networkLeaf(name);
  if (leaf !== null) return READ_ONLY_NETWORK_TOOLS.has(leaf);
  if (SHELL_TOOL_NAMES.has(name.toLowerCase())) {
    const command = shellCommand(parseArgs(input.toolArgs));
    return command !== null && isNoEffectShellCommand(command);
  }
  return false;
}

/** A finished-but-failed call that provably left the outside world unchanged (see callLeftNoOutsideEffect). */
export function failedCallLeftNoOutsideEffect(input: { toolName: unknown; toolArgs: unknown }): boolean {
  return callLeftNoOutsideEffect(input);
}
