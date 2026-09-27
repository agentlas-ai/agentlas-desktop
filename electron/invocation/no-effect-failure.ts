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
  return READ_ONLY_EXECUTABLES.has(exe);
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
 * Whether a finished-but-failed call provably left the outside world unchanged, judged only from its
 * recorded name and arguments. Unknown names and unproven argument shapes answer false.
 */
export function failedCallLeftNoOutsideEffect(input: { toolName: unknown; toolArgs: unknown }): boolean {
  if (typeof input.toolName !== "string" || !input.toolName.trim()) return false;
  const name = input.toolName.trim();
  const browser = canonicalAgentlasBrowserToolName(name);
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
