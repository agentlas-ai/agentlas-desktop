import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { ONE_GRAPH_TOOLS } from "../../shared/graph-authoring";
import { ONE_SUPERVISOR_TOOLS } from "../../shared/one-supervisor-tools";
import { BUILTIN_TOOLS } from "../../shared/builtin-tools";
import { AGENTLAS_TURN_TOOLS } from "../turn-tools/mcp-server";
import { UI_PRESENT_INPUT_SCHEMA } from "../../shared/inline-ui-presentation";
import { RETAINED_RESULT_READ_SCHEMA } from "../../shared/retained-result-schema";
import { missingArgumentsMessage } from "../../shared/did-you-mean";
import type { HarnessCallContext } from "./capability-ports";

/*
 * Canonical 18-area registry (docs/2026-10-13-native-harness/03-도구-인벤토리와-로드맵.md §2, §3).
 *
 * One declarative list of `agentlas.<area>.<action>` entries. Every entry points at a REAL existing handler:
 *   - { kind: "port" }  a harness port operationId, executable through callHarnessPort;
 *   - { kind: "tool" }  an existing MCP / builtin tool the model calls directly (tool.canonical.call answers with the
 *                       exact tool name as `next` and runs nothing);
 *   - { kind: "none" }  the action is designed but has no handler: listed as unavailable with a reason, never claimed.
 * Aliases are names only: they never add an area (the owner's alias table is materialized into `aliases`).
 * Search is a deterministic token match over names / descriptions / input names / aliases. There is no synonym or
 * keyword table: a query word either occurs in the entry's own metadata or it does not match.
 *
 * No electron import at top level (the daemon loads this through the turn-tools control server); the port dispatcher
 * is imported lazily so wiring the handlers into capability-ports cannot make a cycle.
 */

export type CanonicalBacking =
  | { kind: "port"; operationId: string }
  | { kind: "tool"; server: string; name: string }
  | { kind: "none"; reason: string; next?: string };

export type CanonicalEffect = "read" | "write" | "exec" | "network" | "external" | "send" | "spend" | "secret" | "ui" | "state";
export type CanonicalConsent =
  | "none"
  | "grant_check"
  | "owner_turn_required"
  | "owner_native_consent"
  | "operation_policy"
  | "never_return_values"
  | "closed";

export interface CanonicalEntry {
  canonicalId: string;
  area: string;
  action: string;
  aliases: string[];
  version: string;
  purpose: string;
  whenNotToUse: string;
  inputSchema: Record<string, unknown>;
  effects: CanonicalEffect[];
  consentPolicy: CanonicalConsent;
  /** Current tools / prompt blocks this entry replaces or reuses (doc §2 column 3). */
  replaces: string[];
  /** Output virtualization (doc §2 column 6). */
  virtualization: string;
  backing: CanonicalBacking;
  sourceRef: string;
}

export const CANONICAL_AREAS = [
  "tool", "result", "exec", "fs", "browser", "ui", "account", "vault", "pay",
  "ledger", "publish", "media", "memory", "settings", "team", "goal", "graph", "skill",
] as const;
export type CanonicalArea = (typeof CANONICAL_AREAS)[number];

interface AreaMeta { replaces: string[]; consent: CanonicalConsent; virtualization: string; }
const AREA_META: Record<CanonicalArea, AreaMeta> = {
  tool: { replaces: ["agentlas_tools_*", "agentlas_tool_search", "find_science_tools"], consent: "grant_check", virtualization: "metadata first, schema fetched on demand" },
  result: { replaces: ["read_tool_result", "read_science_tool_result", "check.prev.tool.result"], consent: "grant_check", virtualization: "original page / hash / handle" },
  exec: { replaces: ["bash", "native exec"], consent: "operation_policy", virtualization: "stdout/stderr original plus exit code" },
  fs: { replaces: ["builtin file tools", "filesystem MCP", "native edit"], consent: "grant_check", virtualization: "large reads and diffs by handle" },
  browser: { replaces: ["CDP + Playwright + approval"], consent: "owner_turn_required", virtualization: "observation plus one image in total" },
  ui: { replaces: ["UI / surface readers", "ask_user", "Interactive surfaces"], consent: "none", virtualization: "deferred reference text, render receipt" },
  account: { replaces: ["Connecting accounts", "connection IPC"], consent: "owner_native_consent", virtualization: "secret-free status receipt" },
  vault: { replaces: ["vault UI", "environment injection"], consent: "never_return_values", virtualization: "values never stored or summarized" },
  pay: { replaces: ["payment UI", "external payment"], consent: "closed", virtualization: "receipt only" },
  ledger: { replaces: ["tool / effect / run events"], consent: "grant_check", virtualization: "bounded query plus handle" },
  publish: { replaces: ["browser post", "Site / mail / upload"], consent: "owner_turn_required", virtualization: "success / unknown / failure evidence" },
  media: { replaces: ["read_image", "generate_image", "native image generation"], consent: "grant_check", virtualization: "artifact path and hash, one image" },
  memory: { replaces: ["memory_note", "preflight", "recall", "Memory Events"], consent: "none", virtualization: "recall input kept verbatim (original text, rank, scope); only receipts are small" },
  settings: { replaces: ["one_app_* settings", "Settings reference text"], consent: "operation_policy", virtualization: "reviewed diff plus receipt" },
  team: { replaces: ["one_team_*", "room_say", "one_chat_send"], consent: "grant_check", virtualization: "state delta, result handle" },
  goal: { replaces: ["workforce.goal_context", "goal_wait", "goal_complete"], consent: "grant_check", virtualization: "revision + bytes + ACK, then delta" },
  graph: { replaces: ["one_graph_*"], consent: "operation_policy", virtualization: "plan / result pages, pinned reference" },
  skill: { replaces: ["full skill list", "reference text"], consent: "none", virtualization: "metadata first, body on demand" },
};

// ── schema helpers ────────────────────────────────────────────────────────────────────────────────────────────────

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });
const s = (description?: string): Record<string, unknown> => ({ type: "string", ...(description ? { description } : {}) });
const PLACEHOLDER: Record<string, unknown> = { type: "object", additionalProperties: true, "x-schema": "see_tool_list" };

/** A port's contract exposes its required fields; every required argument is a string unless named in `objects`. */
const portSchema = (required: string[], optional: Record<string, unknown> = {}, objects: string[] = []): Record<string, unknown> =>
  obj({ ...Object.fromEntries(required.map((key) => [key, objects.includes(key) ? { type: "object" } : s()])), ...optional }, required);

function listedSchema(list: readonly { name: string; inputSchema?: unknown; parameters?: unknown }[], name: string): Record<string, unknown> {
  const tool = list.find((item) => item.name === name);
  const schema = tool?.inputSchema ?? tool?.parameters;
  return schema && typeof schema === "object" ? (schema as Record<string, unknown>) : PLACEHOLDER;
}

// ── entry builder ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Spec {
  action: string;
  purpose: string;
  whenNotToUse: string;
  backing: CanonicalBacking;
  inputSchema: Record<string, unknown>;
  effects: CanonicalEffect[];
  consent?: CanonicalConsent;
  aliases?: string[];
  sourceRef: string;
}

const PORTS_SRC = "agentlas_desktop/electron/harness/capability-ports.ts";
const NONE_NEXT = "tell the owner this action is not available yet; do not simulate it with another tool";

function entry(area: CanonicalArea, spec: Spec): CanonicalEntry {
  const meta = AREA_META[area];
  return {
    canonicalId: `agentlas.${area}.${spec.action}`,
    area,
    action: spec.action,
    aliases: [...(spec.aliases ?? [])].sort(),
    version: "1",
    purpose: spec.purpose,
    whenNotToUse: spec.whenNotToUse,
    inputSchema: spec.inputSchema,
    effects: spec.effects,
    consentPolicy: spec.consent ?? meta.consent,
    replaces: meta.replaces,
    virtualization: meta.virtualization,
    backing: spec.backing,
    sourceRef: spec.sourceRef,
  };
}
const port = (operationId: string): CanonicalBacking => ({ kind: "port", operationId });
const tool = (server: string, name: string): CanonicalBacking => ({ kind: "tool", server, name });
const none = (reason: string, next: string = NONE_NEXT): CanonicalBacking => ({ kind: "none", reason, next });

const TURN_SRC = "agentlas_desktop/electron/turn-tools/mcp-server.ts";
const TEAM_SRC = "agentlas_desktop/electron/one/team-mcp-server.ts";
const SUP_SRC = "agentlas_desktop/shared/one-supervisor-tools.ts";
const GRAPH_SRC = "agentlas_desktop/shared/graph-authoring.ts";
const BUILTIN_SRC = "agentlas_desktop/shared/builtin-tools.ts";
const UI_SRC = "agentlas_desktop/electron/ui-schema/mcp-server.ts";
const BROWSER_SRC = "agentlas_desktop/electron/mcp-tools/browser-cdp-launcher.ts";
const OS_SRC = "Agentlas-OS/agentlas_cloud/mcp_stdio.py";

const connectAlias = (action: string) => [`agentlas.connect.${action}`];
const settingAlias = (action: string) => [`agentlas.setting.${action}`];
const vaultAlias = (action: string) => [`agentlas.setting.vault.${action}`];

const builtin = (name: string) => listedSchema(BUILTIN_TOOLS, name);
const turn = (name: string) => listedSchema(AGENTLAS_TURN_TOOLS, name);
const graph = (name: string) => listedSchema(ONE_GRAPH_TOOLS, name);
const sup = (name: string) => listedSchema(ONE_SUPERVISOR_TOOLS, name);
const emptyArgs = obj({});

const session = s("session_id returned by one_team_start_session");

export const CANONICAL_ENTRIES: readonly CanonicalEntry[] = Object.freeze([
  // tool
  entry("tool", { action: "search", purpose: "Search installed catalog tools and explicitly unready candidates by words; inert.", whenNotToUse: "To find canonical agentlas.* actions use tool.canonical.search; it does not run or install anything.", backing: port("tool.search"), inputSchema: portSchema(["query"], { includeUnready: { type: "boolean" } }), effects: ["read"], sourceRef: PORTS_SRC }),
  entry("tool", { action: "describe", purpose: "Read one catalog tool's exact schema, provider, availability and result contract.", whenNotToUse: "When you only need a name list; search returns candidates.", backing: port("tool.describe"), inputSchema: portSchema(["toolId"]), effects: ["read"], sourceRef: PORTS_SRC }),
  entry("tool", { action: "prepare", purpose: "Pin a tool's schema digest before calling it.", whenNotToUse: "Not a separate step today: pass schemaDigest to tool.call.", backing: none("prepare_is_part_of_call", "pass schemaDigest and providerRef to agentlas.tool.call"), inputSchema: emptyArgs, effects: ["read"], sourceRef: PORTS_SRC }),
  entry("tool", { action: "call", purpose: "Dispatch one catalog tool once through policy, auth and the current binding; the exact result is preserved.", whenNotToUse: "For tools already listed in your tool list: call them directly.", backing: port("tool.call"), inputSchema: portSchema(["toolId", "providerRef", "schemaDigest", "arguments"], {}, ["arguments"]), effects: ["exec", "external"], consent: "grant_check", sourceRef: PORTS_SRC }),
  // result
  entry("result", { action: "read", purpose: "Read an exact retained original, structured data or artifact part by result reference.", whenNotToUse: "To only learn whether a previous call finished, use result.check_previous.", backing: port("result.read"), inputSchema: RETAINED_RESULT_READ_SCHEMA, effects: ["read"], sourceRef: PORTS_SRC }),
  entry("result", { action: "list", purpose: "List retained results of earlier calls.", whenNotToUse: "Not available: there is no listing handler yet.", backing: none("no_result_list_handler"), inputSchema: emptyArgs, effects: ["read"], sourceRef: "agentlas_desktop/electron/runtime/tool-result-context.ts" }),
  entry("result", { action: "check_previous", purpose: "Read the exact invocation state and retained result handle of an earlier tool call; never re-runs it.", whenNotToUse: "When you want to run the call again; that is a new call.", backing: port("tool.result"), inputSchema: portSchema(["callId"]), effects: ["read"], aliases: ["check.prev.tool.result"], sourceRef: PORTS_SRC }),
  // exec
  entry("exec", { action: "run", purpose: "Run one shell command in the workspace; returns stdout, stderr and the exit code.", whenNotToUse: "For reading or editing files use the fs actions; for page work use browser.", backing: tool("builtin", "bash"), inputSchema: builtin("bash"), effects: ["exec", "write"], sourceRef: BUILTIN_SRC }),
  entry("exec", { action: "write_stdin", purpose: "Write to the stdin of a running process.", whenNotToUse: "Not available: commands run to completion.", backing: none("no_interactive_process_handler"), inputSchema: emptyArgs, effects: ["exec"], sourceRef: BUILTIN_SRC }),
  entry("exec", { action: "kill", purpose: "Stop a running process unconditionally.", whenNotToUse: "Not available: no process handle API; a command ends with its timeout.", backing: none("no_process_kill_handler"), inputSchema: emptyArgs, effects: ["exec"], consent: "none", sourceRef: BUILTIN_SRC }),
  // fs
  // judgment-exempt: a catalog row binding Main's own builtin read_file to its declared effect; it never classifies an observed runtime tool name.
  entry("fs", { action: "read", purpose: "Read one workspace file.", whenNotToUse: "For images use media.read; for directories use fs.list.", backing: tool("builtin", "read_file"), inputSchema: builtin("read_file"), effects: ["read"], sourceRef: BUILTIN_SRC }),
  entry("fs", { action: "list", purpose: "List the entries of one workspace directory.", whenNotToUse: "To read file content use fs.read.", backing: tool("builtin", "list_dir"), inputSchema: builtin("list_dir"), effects: ["read"], sourceRef: BUILTIN_SRC }),
  entry("fs", { action: "glob", purpose: "Find workspace files by name pattern.", whenNotToUse: "Not available as a dedicated handler; list directories or run a command.", backing: none("no_glob_handler"), inputSchema: emptyArgs, effects: ["read"], sourceRef: BUILTIN_SRC }),
  entry("fs", { action: "grep", purpose: "Search file contents.", whenNotToUse: "Not available as a dedicated handler; use exec.run with a search command.", backing: none("no_grep_handler"), inputSchema: emptyArgs, effects: ["read"], sourceRef: BUILTIN_SRC }),
  entry("fs", { action: "write", purpose: "Create or overwrite one workspace file.", whenNotToUse: "To change part of an existing file use fs.edit.", backing: tool("builtin", "write_file"), inputSchema: builtin("write_file"), effects: ["write"], sourceRef: BUILTIN_SRC }),
  entry("fs", { action: "edit", purpose: "Replace an exact string in one workspace file.", whenNotToUse: "To create a new file use fs.write.", backing: tool("builtin", "edit_file"), inputSchema: builtin("edit_file"), effects: ["write"], sourceRef: BUILTIN_SRC }),
  // browser
  entry("browser", { action: "open", purpose: "Open a URL in the Agentlas browser.", whenNotToUse: "Pages that need a logged-in account the owner has not connected: ask via account first.", backing: tool("agentlas-browser", "browser_navigate"), inputSchema: obj({ url: s() }, ["url"]), effects: ["network", "external"], sourceRef: BROWSER_SRC }),
  entry("browser", { action: "act", purpose: "Click an element on the current page.", whenNotToUse: "Payments, 2FA and other gated steps need the owner's own turn.", backing: tool("agentlas-browser", "browser_click"), inputSchema: obj({ element: s(), ref: s() }, ["ref"]), effects: ["external", "write"], consent: "owner_turn_required", sourceRef: BROWSER_SRC }),
  entry("browser", { action: "read", purpose: "Read an accessibility snapshot of the current page.", whenNotToUse: "When pixels matter use browser.screenshot.", backing: tool("agentlas-browser", "browser_snapshot"), inputSchema: obj({}), effects: ["read"], consent: "none", sourceRef: BROWSER_SRC }),
  entry("browser", { action: "screenshot", purpose: "Take one screenshot of the current page.", whenNotToUse: "When text is enough use browser.read.", backing: tool("agentlas-browser", "browser_take_screenshot"), inputSchema: obj({ filename: s() }), effects: ["read"], consent: "none", sourceRef: BROWSER_SRC }),
  // ui
  entry("ui", { action: "read_schema", purpose: "Read the chat's native UI component schema (agentlas-ui blocks) and chart guidance.", whenNotToUse: "After you have read it this turn; do not re-read.", backing: tool("agentlas-ui", "read_ui_schema"), inputSchema: emptyArgs, effects: ["read"], consent: "none", sourceRef: UI_SRC }),
  entry("ui", { action: "read_surface_protocol", purpose: "Read the spec for an interactive surface (tracker, dashboard, console, board).", whenNotToUse: "Never emit a surface without reading it; skip it for plain answers.", backing: tool("agentlas-ui", "read_surface_protocol"), inputSchema: emptyArgs, effects: ["read"], consent: "none", sourceRef: UI_SRC }),
  entry("ui", { action: "read_automation_protocol", purpose: "Read the spec for scheduling, monitoring or changing a recurring run.", whenNotToUse: "For saved automations as assets use the graph area.", backing: tool("agentlas-ui", "read_automation_protocol"), inputSchema: emptyArgs, effects: ["read"], consent: "none", sourceRef: UI_SRC }),
  entry("ui", { action: "render", purpose: "Project a durable tool result into a result view instance.", whenNotToUse: "Charts are emitted as agentlas-ui blocks in the answer text after ui.read_schema.", backing: port("ui.present"), inputSchema: UI_PRESENT_INPUT_SCHEMA, effects: ["ui"], consent: "none", sourceRef: PORTS_SRC }),
  entry("ui", { action: "chart", purpose: "Draw a chart in the chat.", whenNotToUse: "No tool: write an agentlas-ui chart block in the answer after ui.read_schema.", backing: none("chart_is_an_answer_block", "call agentlas.ui.read_schema, then write the chart block in the answer"), inputSchema: emptyArgs, effects: ["ui"], consent: "none", sourceRef: UI_SRC }),
  entry("ui", { action: "ask", purpose: "Ask the owner a structured question and wait for the answer.", whenNotToUse: "Unattended and mobile-durable runs never list it; do not ask what you can find out.", backing: tool("agentlas-turn", "ask_form"), inputSchema: turn("ask_form"), effects: ["ui"], consent: "none", sourceRef: TURN_SRC }),
  // account
  entry("account", { action: "connect", purpose: "Prepare the exact connection for a connector, negotiate and observe its inventory.", whenNotToUse: "When it is already connected: read account.status.", backing: port("connector.connect"), inputSchema: portSchema(["connectorId"]), effects: ["network", "external"], aliases: connectAlias("connect"), sourceRef: PORTS_SRC }),
  entry("account", { action: "status", purpose: "Read redacted stored auth metadata; no refresh, probe or browser.", whenNotToUse: "To start a login use account.login.", backing: port("auth.status"), inputSchema: portSchema(["connectionId"]), effects: ["read"], consent: "none", aliases: connectAlias("status"), sourceRef: PORTS_SRC }),
  entry("account", { action: "ensure", purpose: "Reuse a matching connector sign-in, Vault keys or a signed-in Agentlas browser session (connectionId or site); report a login need.", whenNotToUse: "When the owner just logged out on purpose.", backing: port("auth.ensure"), inputSchema: portSchema([], { connectionId: s(), site: s() }), effects: ["network"], aliases: connectAlias("ensure"), sourceRef: PORTS_SRC }),
  entry("account", { action: "login", purpose: "Open the login for a connection after usable assets are absent.", whenNotToUse: "Before account.ensure reports a login need.", backing: port("auth.login"), inputSchema: portSchema([], { connectionId: s(), site: s() }), effects: ["external", "ui"], aliases: connectAlias("login"), sourceRef: PORTS_SRC }),
  entry("account", { action: "logout", purpose: "End the exact credential session; other accounts and results stay.", whenNotToUse: "To only pause a connector use connector disconnect.", backing: port("auth.logout"), inputSchema: portSchema(["connectionId"]), effects: ["external", "state"], aliases: connectAlias("logout"), sourceRef: PORTS_SRC }),
  entry("account", { action: "disconnect", purpose: "Close the exact connector connection; credentials and artifacts are kept.", whenNotToUse: "To end the credential session use account.logout.", backing: port("connector.disconnect"), inputSchema: portSchema(["connectionId"]), effects: ["state"], aliases: connectAlias("disconnect"), sourceRef: PORTS_SRC }),
  // vault
  entry("vault", { action: "has", purpose: "Check whether a named secret exists in the Vault, without its value.", whenNotToUse: "Never to read a value: values are never returned.", backing: none("no_model_facing_vault_handler", "ask the owner to add the secret in Settings, Vault"), inputSchema: obj({ name: s() }, ["name"]), effects: ["secret"], aliases: ["agentlas.setting.vault", ...vaultAlias("has")], sourceRef: "agentlas_desktop/electron/harness/capability-ports.ts" }),
  entry("vault", { action: "inject", purpose: "Inject a named secret into a command environment without showing it.", whenNotToUse: "Never to display a secret.", backing: none("no_model_facing_vault_handler", "ask the owner to add the secret in Settings, Vault"), inputSchema: obj({ name: s(), env: s() }, ["name"]), effects: ["secret"], aliases: vaultAlias("inject"), sourceRef: "agentlas_desktop/electron/harness/capability-ports.ts" }),
  // pay
  entry("pay", { action: "quote", purpose: "Quote a purchase.", whenNotToUse: "Closed: hub commerce is closed (LEASE_TOOLS empty); do not restore it through this area.", backing: none("hub_commerce_closed", "a payment needs the owner to act in the product"), inputSchema: emptyArgs, effects: ["spend"], sourceRef: "Agentlas-OS/agentlas_cloud/networking/lease_tools.py" }),
  entry("pay", { action: "request", purpose: "Request a payment.", whenNotToUse: "Closed: needs merchant, amount, currency and repeat confirmation by the owner.", backing: none("hub_commerce_closed", "a payment needs the owner to act in the product"), inputSchema: emptyArgs, effects: ["spend"], sourceRef: "Agentlas-OS/agentlas_cloud/networking/lease_tools.py" }),
  entry("pay", { action: "status", purpose: "Read a payment's status.", whenNotToUse: "Closed with the rest of the pay area.", backing: none("hub_commerce_closed", "a payment needs the owner to act in the product"), inputSchema: emptyArgs, effects: ["read"], sourceRef: "Agentlas-OS/agentlas_cloud/networking/lease_tools.py" }),
  // ledger
  entry("ledger", { action: "record", purpose: "Record a tool, effect or run event in the host ledger.", whenNotToUse: "Not available: the host writes receipts itself; the model cannot append.", backing: none("host_writes_ledger"), inputSchema: emptyArgs, effects: ["write"], sourceRef: PORTS_SRC }),
  entry("ledger", { action: "get", purpose: "Query the host ledger with a bounded page.", whenNotToUse: "To read one earlier call use result.check_previous.", backing: none("no_ledger_query_handler", "use agentlas.result.check_previous for one earlier call"), inputSchema: emptyArgs, effects: ["read"], sourceRef: PORTS_SRC }),
  // publish
  entry("publish", { action: "post", purpose: "Post content to an external site, mail or upload.", whenNotToUse: "Not available as one handler: compose from browser actions with the owner's turn and consent.", backing: none("no_publish_handler", "use agentlas.browser.* actions within an owner turn"), inputSchema: emptyArgs, effects: ["external", "send"], sourceRef: BROWSER_SRC }),
  entry("publish", { action: "status", purpose: "Read the status of a post.", whenNotToUse: "Not available.", backing: none("no_publish_handler"), inputSchema: emptyArgs, effects: ["read"], sourceRef: BROWSER_SRC }),
  entry("publish", { action: "reconcile", purpose: "Settle an uncertain post as success, unknown or failure from evidence.", whenNotToUse: "Never retry an uncertain post blindly.", backing: none("no_publish_handler"), inputSchema: emptyArgs, effects: ["read"], sourceRef: BROWSER_SRC }),
  // media
  entry("media", { action: "probe", purpose: "List image, video and speech routes with class, transport, operations, billing and readiness.", whenNotToUse: "To make media use media.generate.", backing: port("media.routes"), inputSchema: portSchema([], { live: { type: "boolean" } }), effects: ["read"], consent: "none", sourceRef: PORTS_SRC }),
  entry("media", { action: "generate", purpose: "Generate one image through a subscription route.", whenNotToUse: "For video use media.generate_video.", backing: port("media.image.generate"), inputSchema: portSchema(["prompt"]), effects: ["write", "spend", "network"], sourceRef: PORTS_SRC }),
  entry("media", { action: "generate_video", purpose: "Text-to-video on a ready route the owner selected.", whenNotToUse: "To animate an existing image use media.animate_image.", backing: port("media.video.generate"), inputSchema: portSchema(["prompt"]), effects: ["write", "spend", "network"], sourceRef: PORTS_SRC }),
  entry("media", { action: "animate_image", purpose: "Start an image-to-video job on a route.", whenNotToUse: "For text-to-video use media.generate_video.", backing: port("media.video.animate-image"), inputSchema: portSchema(["routeId", "prompt"]), effects: ["write", "spend", "network"], sourceRef: PORTS_SRC }),
  entry("media", { action: "job_status", purpose: "Read one media job's state and output.", whenNotToUse: "To stop a job use media.job_cancel.", backing: port("media.job.status"), inputSchema: portSchema(["jobId"]), effects: ["read"], consent: "none", sourceRef: PORTS_SRC }),
  entry("media", { action: "job_cancel", purpose: "Cancel one media job.", whenNotToUse: "A finished job cannot be cancelled.", backing: port("media.job.cancel"), inputSchema: portSchema(["jobId"]), effects: ["state"], consent: "none", sourceRef: PORTS_SRC }),
  entry("media", { action: "read", purpose: "Read one image file so you can see it.", whenNotToUse: "For text files use fs.read.", backing: tool("builtin", "read_image"), inputSchema: builtin("read_image"), effects: ["read"], sourceRef: BUILTIN_SRC }),
  entry("media", { action: "verify", purpose: "Verify a media artifact against its brief.", whenNotToUse: "Not available: no verifier handler; read the artifact and judge.", backing: none("no_media_verify_handler", "use agentlas.media.read and judge the artifact"), inputSchema: emptyArgs, effects: ["read"], sourceRef: PORTS_SRC }),
  // memory
  entry("memory", { action: "note", purpose: "Propose one durable learning for the memory curator; never writes memory directly.", whenNotToUse: "For trivial or unverified conjecture; mark those as hypothesis.", backing: tool("agentlas-turn", "memory_note"), inputSchema: turn("memory_note"), effects: ["state"], consent: "none", sourceRef: TURN_SRC }),
  entry("memory", { action: "recall", purpose: "Recall stored memory on demand.", whenNotToUse: "Not available: recall is injected by the host at session start.", backing: none("recall_injected_by_host", "use the memory the session already carries"), inputSchema: emptyArgs, effects: ["read"], consent: "none", sourceRef: TURN_SRC }),
  entry("memory", { action: "turn_receipt", purpose: "Emit the turn receipt (turn_summary and memory events).", whenNotToUse: "Not a tool: the host builds the receipt from the Memory Events block.", backing: none("receipt_written_by_host"), inputSchema: emptyArgs, effects: ["state"], consent: "none", sourceRef: TURN_SRC }),
  // settings
  entry("settings", { action: "get", purpose: "Discover app operations and read an operation's exact input schema and live availability.", whenNotToUse: "To change anything use settings.propose.", backing: tool("one-team", "one_app_operations"), inputSchema: sup("one_app_operations"), effects: ["read"], consent: "none", aliases: settingAlias("get"), sourceRef: SUP_SRC }),
  entry("settings", { action: "propose", purpose: "Run one app operation through the same validation and stores as the owner's click.", whenNotToUse: "Destructive or consent actions need an owner-written turn.", backing: tool("one-team", "one_app_call"), inputSchema: sup("one_app_call"), effects: ["write", "state"], aliases: settingAlias("propose"), sourceRef: SUP_SRC }),
  // team
  entry("team", { action: "list", purpose: "List teammates with exact member ids and current work.", whenNotToUse: "To read one session's result use team.status.", backing: tool("one-team", "one_team_list"), inputSchema: emptyArgs, effects: ["read"], consent: "none", sourceRef: TEAM_SRC }),
  entry("team", { action: "start", purpose: "Assign work to an existing teammate's own session.", whenNotToUse: "To redirect a running session use team.steer.", backing: tool("one-team", "one_team_start_session"), inputSchema: obj({ member: s(), brief: s(), new_session: { type: "boolean" } }, ["member", "brief"]), effects: ["send", "state"], sourceRef: TEAM_SRC }),
  entry("team", { action: "steer", purpose: "Send a follow-up direction to a teammate session you started.", whenNotToUse: "To start new work use team.start.", backing: tool("one-team", "one_team_steer"), inputSchema: obj({ session_id: session, message: s() }, ["session_id", "message"]), effects: ["send"], sourceRef: TEAM_SRC }),
  entry("team", { action: "status", purpose: "Status of a teammate session you started; the final answer once finished.", whenNotToUse: "Do not poll: completion wakes you.", backing: tool("one-team", "one_team_session_status"), inputSchema: obj({ session_id: session, wait_seconds: { type: "integer" } }, ["session_id"]), effects: ["read"], consent: "none", sourceRef: TEAM_SRC }),
  entry("team", { action: "room_say", purpose: "Post a short message in the group room as yourself.", whenNotToUse: "To message another conversation use team.chat.", backing: tool("one-team", "room_say"), inputSchema: obj({ text: s(), to: s(), reply_to: s() }, ["text"]), effects: ["send"], sourceRef: TEAM_SRC }),
  entry("team", { action: "chat", purpose: "Send a message as One into an existing Agentlas conversation (Work session, teammate chat, group room).", whenNotToUse: "To post inside the room you work in use team.room_say.", backing: tool("one-team", "one_chat_send"), inputSchema: sup("one_chat_send"), effects: ["send"], consent: "owner_turn_required", aliases: ["agentlas.message.chat"], sourceRef: SUP_SRC }),
  // goal
  entry("goal", { action: "context", purpose: "Read the project's goal roster and continuity before nontrivial work.", whenNotToUse: "Trivial turns.", backing: tool("hephaestus-network", "workforce.goal_context"), inputSchema: obj({ projectDir: s() }, ["projectDir"]), effects: ["read"], consent: "none", sourceRef: OS_SRC }),
  entry("goal", { action: "tactic", purpose: "Record the Goal's tactic or its blocker with a cause.", whenNotToUse: "Outside Goal turns.", backing: tool("agentlas-turn", "goal_tactic"), inputSchema: turn("goal_tactic"), effects: ["state"], sourceRef: TURN_SRC }),
  entry("goal", { action: "plan_op", purpose: "Apply one plan operation to the Goal's plan.", whenNotToUse: "Outside Goal turns.", backing: tool("agentlas-turn", "goal_plan_op"), inputSchema: turn("goal_plan_op"), effects: ["state"], sourceRef: TURN_SRC }),
  entry("goal", { action: "kpi", purpose: "Record a Goal KPI measurement.", whenNotToUse: "Outside Goal turns.", backing: tool("agentlas-turn", "goal_kpi"), inputSchema: turn("goal_kpi"), effects: ["state"], sourceRef: TURN_SRC }),
  entry("goal", { action: "wait", purpose: "Wait for an invocation, artifact, automation or timer, then resume.", whenNotToUse: "Do not poll; outside Goal turns.", backing: tool("agentlas-turn", "goal_wait"), inputSchema: turn("goal_wait"), effects: ["state"], consent: "none", sourceRef: TURN_SRC }),
  entry("goal", { action: "complete", purpose: "Complete the Goal with acceptance evidence.", whenNotToUse: "When acceptance evidence is missing.", backing: tool("agentlas-turn", "goal_complete"), inputSchema: turn("goal_complete"), effects: ["state"], sourceRef: TURN_SRC }),
  // graph
  entry("graph", { action: "schema", purpose: "Read the canonical automation blueprint schema.", whenNotToUse: "When you already hold it.", backing: tool("one-team", "one_graph_schema"), inputSchema: graph("one_graph_schema"), effects: ["read"], consent: "none", sourceRef: GRAPH_SRC }),
  entry("graph", { action: "list", purpose: "List saved automations owned by this conversation (compact identities and revisions).", whenNotToUse: "For one graph's nodes use graph.inspect with graph_id.", backing: tool("one-team", "one_graph_inspect"), inputSchema: graph("one_graph_inspect"), effects: ["read"], consent: "none", sourceRef: GRAPH_SRC }),
  entry("graph", { action: "inspect", purpose: "Read one saved automation's nodes and revision.", whenNotToUse: "Toolchains are independent assets: use toolchain_inspect.", backing: tool("one-team", "one_graph_inspect"), inputSchema: graph("one_graph_inspect"), effects: ["read"], consent: "none", sourceRef: GRAPH_SRC }),
  entry("graph", { action: "build", purpose: "Compile and save a structured blueprint as an automation.", whenNotToUse: "To change a few nodes use one_graph_patch.", backing: tool("one-team", "one_graph_save"), inputSchema: graph("one_graph_save"), effects: ["write", "state"], sourceRef: GRAPH_SRC }),
  entry("graph", { action: "run", purpose: "Execute an enabled saved automation through the host queue.", whenNotToUse: "A disabled or stale-revision graph is refused.", backing: tool("one-team", "one_graph_run"), inputSchema: graph("one_graph_run"), effects: ["exec", "external"], sourceRef: GRAPH_SRC }),
  entry("graph", { action: "result", purpose: "Read the result and status of this conversation's exact graph event.", whenNotToUse: "To run again use graph.run.", backing: tool("one-team", "one_graph_result"), inputSchema: graph("one_graph_result"), effects: ["read"], consent: "none", sourceRef: GRAPH_SRC }),
  // skill
  entry("skill", { action: "list", purpose: "Find skill metadata by words; does not activate or run.", whenNotToUse: "To read a skill's body use skill.open.", backing: port("skill.search"), inputSchema: portSchema(["query"]), effects: ["read"], sourceRef: PORTS_SRC }),
  entry("skill", { action: "open", purpose: "Read a skill's exact instruction text, revision and linked resources.", whenNotToUse: "To switch on optional activation use skill.activate.", backing: port("skill.read"), inputSchema: portSchema(["skillId"]), effects: ["read"], sourceRef: PORTS_SRC }),
  entry("skill", { action: "activate", purpose: "Activate an optional skill and record the actual delivery.", whenNotToUse: "Installing a skill is a separate owner consent.", backing: port("skill.activate"), inputSchema: portSchema(["skillId", "skillRevision"]), effects: ["state"], consent: "none", sourceRef: PORTS_SRC }),
]);

// ── digests ───────────────────────────────────────────────────────────────────────────────────────────────────────

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const CANONICAL_REGISTRY_REVISION: string = sha256(canonicalJson(CANONICAL_ENTRIES));
export const canonicalSchemaDigest = (entryValue: CanonicalEntry): string => sha256(canonicalJson(entryValue.inputSchema));

const BY_ID = new Map(CANONICAL_ENTRIES.map((item) => [item.canonicalId, item]));
const BY_ALIAS = new Map<string, CanonicalEntry>();
for (const item of CANONICAL_ENTRIES) for (const alias of item.aliases) BY_ALIAS.set(alias, item);

// ── availability ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface CanonicalAvailability {
  status: "available" | "unavailable";
  reason?: string;
  next?: string;
  direct?: boolean;
  /**
   * G31: `available` | `unavailable:<reason>`. The entry EXISTS in every case here (no match is a different answer:
   * noMatch). `cause` separates a designed-but-unbuilt action ("not_built") from an existing capability whose provider
   * cannot be reached right now ("unreachable": provider_offline | not_installed | auth_required).
   */
  label?: string;
  cause?: "not_built" | "unreachable";
}

/** Reasons a readiness probe may report; anything else is treated as provider_offline. */
export const CANONICAL_UNREACHABLE_REASONS = ["provider_offline", "not_installed", "auth_required"] as const;
export type CanonicalReadinessProbe = (item: CanonicalEntry) => string | null | undefined;
let readinessProbe: CanonicalReadinessProbe | null = null;
/**
 * Hosts that already know connector / plugin / login state register it here (no network probe lives in this file).
 * The probe is synchronous and must only read state the app already holds. Pass null to clear.
 */
export function setCanonicalReadinessProbe(probe: CanonicalReadinessProbe | null): void { readinessProbe = probe; }

function labelled(value: CanonicalAvailability, cause?: CanonicalAvailability["cause"]): CanonicalAvailability {
  return { ...value, label: value.status === "available" ? "available" : `unavailable:${value.reason ?? "unknown"}`, ...(cause ? { cause } : {}) };
}

async function availabilityOf(item: CanonicalEntry): Promise<CanonicalAvailability> {
  const base = await baseAvailabilityOf(item);
  if (base.status === "available" && readinessProbe) {
    let reported: string | null | undefined = null;
    try { reported = readinessProbe(item); } catch { reported = "provider_offline"; }
    if (reported) {
      const reason = (CANONICAL_UNREACHABLE_REASONS as readonly string[]).includes(reported) ? reported : "provider_offline";
      return labelled({ status: "unavailable", reason }, "unreachable");
    }
  }
  return labelled(base, base.status === "unavailable" ? "not_built" : undefined);
}

async function baseAvailabilityOf(item: CanonicalEntry): Promise<CanonicalAvailability> {
  const backing = item.backing;
  if (backing.kind === "none") return { status: "unavailable", reason: backing.reason, ...(backing.next ? { next: backing.next } : {}) };
  if (backing.kind === "tool") return { status: "available", direct: true, next: `call tool ${backing.name} directly` };
  const { harnessPortStatus } = await import("./capability-ports");
  const status = harnessPortStatus(backing.operationId);
  if (status === "implemented") return { status: "available" };
  return status === null
    ? { status: "unavailable", reason: "port_missing" }
    : { status: "unavailable", reason: "port_not_wired" };
}

// ── search ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CanonicalSearchInput {
  query?: string;
  area?: string;
  effects?: string[];
  cursor?: string;
  limit?: number;
  registryRevision?: string;
}
export interface CanonicalCandidate {
  canonicalId: string;
  version: string;
  purpose: string;
  whenNotToUse: string;
  schemaDigest: string;
  effects: CanonicalEffect[];
  consentPolicy: CanonicalConsent;
  availability: CanonicalAvailability;
  sourceRef: string;
}
export interface CanonicalSearchOutput {
  /** G31: "degraded" when served from the offline snapshot or when a returned candidate's provider is unreachable. */
  status: "ok" | "degraded";
  degradedReasons?: string[];
  /** "live" = this process's registry; "snapshot" = userData/harness/registry-snapshot.json (stale-able). */
  source?: "live" | "snapshot";
  registryRevision: string;
  candidates: CanonicalCandidate[];
  nextCursor: string | null;
  noMatch: boolean;
  /** Present when the request cannot be served (stale revision or bad cursor); candidates are empty then. */
  refused?: { reason: "tool_registry_changed" | "cursor_invalid"; currentRevision: string };
}

/** Lowercase letters / digits; every other character separates tokens. Underscores and dots split names into words. */
export function canonicalTokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function inputNames(schema: Record<string, unknown>): string[] {
  const props = schema.properties;
  return props && typeof props === "object" ? Object.keys(props as Record<string, unknown>) : [];
}

interface Indexed { item: CanonicalEntry; id: Set<string>; alias: Set<string>; input: Set<string>; text: Set<string> }
const buildIndex = (entries: readonly CanonicalEntry[]): Indexed[] => entries.map((item) => ({
  item,
  id: new Set(canonicalTokens(`${item.canonicalId} ${item.backing.kind === "none" ? "" : item.backing.kind === "port" ? item.backing.operationId : item.backing.name}`)),
  alias: new Set(item.aliases.flatMap(canonicalTokens)),
  input: new Set(inputNames(item.inputSchema).flatMap(canonicalTokens)),
  text: new Set(canonicalTokens(`${item.purpose} ${item.whenNotToUse}`)),
}));
const INDEX: Indexed[] = buildIndex(CANONICAL_ENTRIES);

/** The leading `agentlas` token is the shared namespace of every canonical id, not a content word. */
function queryTokens(query: string): string[] {
  const tokens = canonicalTokens(query);
  const content = tokens.filter((token) => token !== "agentlas");
  return [...new Set(content.length ? content : tokens)];
}

function scoreOf(index: Indexed, tokens: string[]): number {
  let score = 0;
  for (const token of tokens) {
    for (const [set, weight] of [[index.id, 6], [index.alias, 4], [index.input, 3], [index.text, 1]] as const) {
      if (set.has(token)) { score += weight; continue; }
      // Prefix of an own word (3+ letters) counts half: a literal-text rule, not a vocabulary.
      if (token.length >= 3) for (const word of set) if (word.startsWith(token)) { score += weight / 2; break; }
    }
  }
  return score;
}

function encodeCursor(revision: string, offset: number): string { return Buffer.from(`${revision}:${offset}`).toString("base64url"); }
function decodeCursor(cursor: string): { revision: string; offset: number } | null {
  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    const at = text.lastIndexOf(":");
    const offset = Number(text.slice(at + 1));
    return at > 0 && Number.isInteger(offset) && offset >= 0 ? { revision: text.slice(0, at), offset } : null;
  } catch { return null; }
}

async function candidateOf(item: CanonicalEntry): Promise<CanonicalCandidate> {
  return {
    canonicalId: item.canonicalId, version: item.version, purpose: item.purpose, whenNotToUse: item.whenNotToUse,
    schemaDigest: canonicalSchemaDigest(item), effects: item.effects, consentPolicy: item.consentPolicy,
    availability: await availabilityOf(item), sourceRef: item.sourceRef,
  };
}

/** Ranked entries for the words; no words lists everything in canonicalId order. Pure and deterministic. */
function rankedEntries(query: string, area?: string, effects?: string[], index: Indexed[] = INDEX): CanonicalEntry[] {
  const tokens = queryTokens(query);
  const wanted = (effects ?? []).filter((effect) => typeof effect === "string");
  return index
    .filter(({ item }) => (!area || item.area === area) && wanted.every((effect) => (item.effects as string[]).includes(effect)))
    .map((index) => ({ item: index.item, score: tokens.length ? scoreOf(index, tokens) : 1 }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || (a.item.canonicalId < b.item.canonicalId ? -1 : a.item.canonicalId > b.item.canonicalId ? 1 : 0))
    .map((row) => row.item);
}

export async function canonicalSearch(input: CanonicalSearchInput = {}): Promise<CanonicalSearchOutput> {
  const revision = CANONICAL_REGISTRY_REVISION;
  const empty = (refused?: CanonicalSearchOutput["refused"]): CanonicalSearchOutput => ({ status: "ok", source: "live", registryRevision: revision, candidates: [], nextCursor: null, noMatch: !refused, ...(refused ? { refused } : {}) });
  if (input.registryRevision && input.registryRevision !== revision) return empty({ reason: "tool_registry_changed", currentRevision: revision });
  let offset = 0;
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (!decoded) return empty({ reason: "cursor_invalid", currentRevision: revision });
    if (decoded.revision !== revision) return empty({ reason: "tool_registry_changed", currentRevision: revision });
    offset = decoded.offset;
  }
  const limit = Math.min(50, Math.max(1, Number.isInteger(input.limit) ? (input.limit as number) : 8));
  const ranked = rankedEntries(typeof input.query === "string" ? input.query : "", input.area, input.effects);
  const page = ranked.slice(offset, offset + limit);
  const candidates = await Promise.all(page.map(candidateOf));
  const unreachable = candidates.filter((candidate) => candidate.availability.cause === "unreachable");
  void writeRegistrySnapshot();
  return {
    status: unreachable.length ? "degraded" : "ok",
    ...(unreachable.length ? { degradedReasons: [...new Set(unreachable.map((candidate) => candidate.availability.label as string))].sort() } : {}),
    source: "live",
    registryRevision: revision,
    candidates,
    nextCursor: offset + limit < ranked.length ? encodeCursor(revision, offset + limit) : null,
    noMatch: ranked.length === 0,
  };
}

// ── G31 offline snapshot ──────────────────────────────────────────────────────────────────────────────────────────

export interface CanonicalRegistrySnapshot {
  schema: "agentlas.canonical-registry-snapshot.v1";
  registryRevision: string;
  entries: CanonicalEntry[];
  schemaDigests: Record<string, string>;
}

export function canonicalRegistrySnapshot(): CanonicalRegistrySnapshot {
  return {
    schema: "agentlas.canonical-registry-snapshot.v1",
    registryRevision: CANONICAL_REGISTRY_REVISION,
    entries: CANONICAL_ENTRIES.map((item) => JSON.parse(JSON.stringify(item)) as CanonicalEntry),
    schemaDigests: Object.fromEntries(CANONICAL_ENTRIES.map((item) => [item.canonicalId, canonicalSchemaDigest(item)])),
  };
}

export const registrySnapshotPath = (): string => userDataPath("harness", "registry-snapshot.json");

/** Best effort and idempotent (skips the write when the revision on disk is current). Never throws. */
export async function writeRegistrySnapshot(file: string = safeSnapshotPath()): Promise<boolean> {
  try {
    if (!file) return false;
    try { if ((JSON.parse(fs.readFileSync(file, "utf8")) as CanonicalRegistrySnapshot).registryRevision === CANONICAL_REGISTRY_REVISION) return false; } catch { /* absent or unreadable: rewrite */ }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(canonicalRegistrySnapshot()));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}
function safeSnapshotPath(): string { try { return registrySnapshotPath(); } catch { return ""; } }

export function readRegistrySnapshot(file: string = safeSnapshotPath()): CanonicalRegistrySnapshot | null {
  try {
    if (!file) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CanonicalRegistrySnapshot;
    return parsed && parsed.schema === "agentlas.canonical-registry-snapshot.v1" && Array.isArray(parsed.entries) && typeof parsed.registryRevision === "string" ? parsed : null;
  } catch { return null; }
}

/**
 * Search that survives a live-registry failure. `live` defaults to canonicalSearch; if it throws, the last written
 * snapshot answers the same deterministic token match with status "degraded" (availability is not re-evaluated, so every
 * candidate says unavailable:snapshot_only until a live build succeeds). No snapshot -> degraded, empty, snapshot_missing.
 */
export async function canonicalSearchResilient(input: CanonicalSearchInput = {}, live: (input: CanonicalSearchInput) => Promise<CanonicalSearchOutput> = canonicalSearch, snapshotFile?: string): Promise<CanonicalSearchOutput> {
  try { return await live(input); } catch (error) {
    const reason = `live_registry_unavailable:${error instanceof Error ? error.message.slice(0, 120) : "error"}`;
    const snapshot = readRegistrySnapshot(snapshotFile);
    if (!snapshot) return { status: "degraded", degradedReasons: [reason, "snapshot_missing"], source: "snapshot", registryRevision: "unknown", candidates: [], nextCursor: null, noMatch: false };
    const limit = Math.min(50, Math.max(1, Number.isInteger(input.limit) ? (input.limit as number) : 8));
    const ranked = rankedEntries(typeof input.query === "string" ? input.query : "", input.area, input.effects, buildIndex(snapshot.entries)).slice(0, limit);
    const candidates: CanonicalCandidate[] = ranked.map((item) => ({
      canonicalId: item.canonicalId, version: item.version, purpose: item.purpose, whenNotToUse: item.whenNotToUse,
      schemaDigest: snapshot.schemaDigests[item.canonicalId] ?? "", effects: item.effects, consentPolicy: item.consentPolicy,
      availability: { status: "unavailable", reason: "snapshot_only", label: "unavailable:snapshot_only", cause: "unreachable" }, sourceRef: item.sourceRef,
    }));
    return { status: "degraded", degradedReasons: [reason, `snapshot_revision:${snapshot.registryRevision}`], source: "snapshot", registryRevision: snapshot.registryRevision, candidates, nextCursor: null, noMatch: candidates.length === 0 };
  }
}

// ── resolve / describe ────────────────────────────────────────────────────────────────────────────────────────────

export interface UnknownTool {
  status: "unknown_tool";
  name: string;
  inputHash: string;
  registryRevision: string;
  candidates: CanonicalCandidate[];
}

/** `check.prev.tool.result(id)` style call syntax is reduced to the bare name. */
function bareName(name: string): string { return name.trim().replace(/\([^)]*\)\s*$/, "").trim(); }

/** Exact canonicalId or declared alias only. Unknown names never fall back to a "closest" entry. */
export async function canonicalResolve(nameOrAlias: string, args?: unknown): Promise<CanonicalEntry | UnknownTool> {
  const name = bareName(typeof nameOrAlias === "string" ? nameOrAlias : "");
  const found = BY_ID.get(name) ?? BY_ALIAS.get(name);
  if (found) return found;
  const search = await canonicalSearch({ query: name, limit: 8 });
  return {
    status: "unknown_tool",
    name,
    inputHash: sha256(canonicalJson({ name, args: args ?? null })),
    registryRevision: CANONICAL_REGISTRY_REVISION,
    candidates: search.candidates,
  };
}

export function isUnknownTool(value: CanonicalEntry | UnknownTool): value is UnknownTool {
  return (value as UnknownTool).status === "unknown_tool";
}

export async function canonicalDescribe(nameOrAlias: string): Promise<(CanonicalCandidate & { canonicalId: string; area: string; action: string; aliases: string[]; inputSchema: Record<string, unknown>; backing: CanonicalBacking; replaces: string[]; virtualization: string }) | UnknownTool> {
  const resolved = await canonicalResolve(nameOrAlias);
  if (isUnknownTool(resolved)) return resolved;
  return { ...(await candidateOf(resolved)), area: resolved.area, action: resolved.action, aliases: resolved.aliases, inputSchema: resolved.inputSchema, backing: resolved.backing, replaces: resolved.replaces, virtualization: resolved.virtualization };
}

// ── extension ports (the parent wires these into capability-ports) ───────────────────────────────────────────────

type PortOutcome =
  | { status: "ok"; data: unknown }
  | { status: "refused" | "unavailable"; reason: string; next?: string; data?: unknown };

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function missingRequired(schema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return required.filter((key) => args[key] === undefined || args[key] === null || (typeof args[key] === "string" && !(args[key] as string).trim()));
}

/**
 * One registry, every wire (doc 03 §1 / R3): the same entries projected for an MCP tools/list, Codex app-server
 * dynamicTools, and Anthropic deferred loading (defer_loading). Each projected tool carries the registry revision and
 * the entry's schemaDigest, so a host can prove the three views are the same contract. Entries without a backing
 * handler are not projected.
 */
export type CanonicalProjectionTarget = "mcp" | "codex-dynamic" | "anthropic-deferred";
export const CANONICAL_PROJECTION_TARGETS: readonly CanonicalProjectionTarget[] = ["mcp", "codex-dynamic", "anthropic-deferred"];

export function canonicalProjection(target: CanonicalProjectionTarget): Array<Record<string, unknown>> {
  return CANONICAL_ENTRIES.filter((item) => item.backing.kind !== "none").map((item) => {
    const name = item.canonicalId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    const description = `${item.purpose} Not for: ${item.whenNotToUse}`;
    const meta = { canonicalId: item.canonicalId, schemaDigest: canonicalSchemaDigest(item), registryRevision: CANONICAL_REGISTRY_REVISION };
    if (target === "anthropic-deferred") return { name, description, input_schema: item.inputSchema, defer_loading: true, metadata: meta };
    if (target === "codex-dynamic") return { name, description, inputSchema: item.inputSchema, metadata: meta };
    return { name, description, inputSchema: item.inputSchema,
      annotations: { readOnlyHint: item.effects.every((effect) => effect === "read") }, _meta: meta };
  });
}

export const CANONICAL_PORT_HANDLERS: Record<string, (args: Record<string, unknown>, ctx: HarnessCallContext) => Promise<PortOutcome>> = {
  "tool.canonical.project": async (args) => {
    const target = text(record(args).target) as CanonicalProjectionTarget;
    if (!CANONICAL_PROJECTION_TARGETS.includes(target)) return { status: "refused", reason: "projection_target_unknown", next: `target: ${CANONICAL_PROJECTION_TARGETS.join(" | ")}` };
    return { status: "ok", data: { target, registryRevision: CANONICAL_REGISTRY_REVISION, tools: canonicalProjection(target) } };
  },
  "tool.canonical.search": async (args) => {
    const input = record(args);
    const output = await canonicalSearchResilient({
      query: text(input.query), area: text(input.area) || undefined,
      effects: Array.isArray(input.effects) ? (input.effects as unknown[]).filter((item): item is string => typeof item === "string") : undefined,
      cursor: text(input.cursor) || undefined, limit: typeof input.limit === "number" ? input.limit : undefined,
      registryRevision: text(input.registryRevision) || undefined,
    });
    return output.refused ? { status: "refused", reason: output.refused.reason, next: "search again without registryRevision or cursor", data: output } : { status: "ok", data: output };
  },
  "tool.canonical.describe": async (args) => {
    const name = text(record(args).name) || text(record(args).canonicalId);
    if (!name) return { status: "refused", reason: "arguments_missing", next: "required: name" };
    const described = await canonicalDescribe(name);
    return isUnknownTool(described)
      ? { status: "refused", reason: "unknown_tool", next: "pick a canonicalId from candidates; nothing was run", data: described }
      : { status: "ok", data: described };
  },
  "tool.canonical.call": async (args, ctx) => {
    const input = record(args);
    const name = text(input.name) || text(input.canonicalId);
    if (!name) return { status: "refused", reason: "arguments_missing", next: "required: name" };
    const callArgs = record(input.arguments);
    const resolved = await canonicalResolve(name, input.arguments);
    if (isUnknownTool(resolved)) return { status: "refused", reason: "unknown_tool", next: "pick a canonicalId from candidates; nothing was run", data: resolved };
    const wantedRevision = text(input.registryRevision);
    if (wantedRevision && wantedRevision !== CANONICAL_REGISTRY_REVISION) return { status: "refused", reason: "tool_registry_changed", next: "search again for a fresh registryRevision", data: { registryRevision: CANONICAL_REGISTRY_REVISION } };
    const wantedDigest = text(input.schemaDigest);
    if (wantedDigest && wantedDigest !== canonicalSchemaDigest(resolved)) return { status: "refused", reason: "tool_registry_changed", next: "describe the entry again for its current schemaDigest", data: { schemaDigest: canonicalSchemaDigest(resolved) } };
    const backing = resolved.backing;
    if (backing.kind === "none") return { status: "unavailable", reason: backing.reason, ...(backing.next ? { next: backing.next } : {}) };
    // Direct tools run in their own server with their own grants; this port never executes them on their behalf.
    if (backing.kind === "tool") return { status: "refused", reason: "call_tool_directly", next: backing.name, data: { server: backing.server, tool: backing.name } };
    // Permission and schema problems are answered as such, never as unknown_tool.
    const missing = missingRequired(resolved.inputSchema, callArgs);
    if (missing.length) return { status: "refused", reason: "arguments_missing", next: missingArgumentsMessage(missing, Object.keys(callArgs), inputNames(resolved.inputSchema)) };
    const { callHarnessPort } = await import("./capability-ports");
    const result = await callHarnessPort(backing.operationId, callArgs, ctx);
    return result.status === "ok"
      ? { status: "ok", data: { canonicalId: resolved.canonicalId, operationId: backing.operationId, receiptId: result.receiptId, result: result.data } }
      : { status: result.status, reason: result.reason ?? "operation_failed", ...(result.next ? { next: result.next } : {}) };
  },
};
