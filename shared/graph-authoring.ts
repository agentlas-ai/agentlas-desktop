import { BLUEPRINT_SCHEMA, CONDITION_OPS } from "./graph-blueprint";
import { CAPABILITIES } from "./graph-tool-binding";

// Wire shape only. All topology/data-flow semantics still belong to the
// canonical blueprint validator/compiler; the host never compiles model ids.
type Shape = {
  type?: string; const?: unknown; enum?: readonly unknown[]; anyOf?: Shape[];
  properties?: Record<string, Shape>; required?: string[];
  additionalProperties?: boolean; items?: Shape;
  minLength?: number; maxLength?: number; minItems?: number; maxItems?: number;
  minimum?: number; maximum?: number; pattern?: string; description?: string;
};
const string = (maxLength = 8000): Shape => ({ type: "string", minLength: 1, maxLength });
const object = (properties: Record<string, Shape>, required: string[] = []): Shape =>
  ({ type: "object", properties, required, additionalProperties: false });
const array = (items: Shape, maxItems = 32, minItems = 0): Shape => ({ type: "array", items, maxItems, minItems });
const index: Shape = { type: "integer", minimum: 0, maximum: 63 };
const revision: Shape = { type: "string", pattern: "^[a-f0-9]{64}$" };
const id = string(128);
export const GRAPH_MCP_CALL_INPUT_SCHEMA = object({ catalogId: string(128), toolName: string(200),
  arguments: { type: "object", additionalProperties: true }, schemaDigest: revision,
}, ["catalogId", "toolName", "arguments"]);

export const GRAPH_BLUEPRINT_INPUT_SCHEMA = object({
  schema: { const: BLUEPRINT_SCHEMA }, name: string(160), goal: string(4000),
  trigger: object({ kind: { enum: ["cron", "input"] }, schedule: string(256), label: string(160), varName: string(80) }, ["kind"]),
  steps: array(object({
    title: string(160), instruction: string(16000), effect: { enum: ["read", "mutation"] },
    produces: string(80), consumes: array(string(80)),
    uses: array(object({ capability: { enum: CAPABILITIES }, provider: { anyOf: [{ type: "null" }, string(128)] } }, ["capability"])),
    kind: { enum: ["agent", "code", "runGraph", "mcp_call"] }, graphRef: id,
    mcpCall: GRAPH_MCP_CALL_INPUT_SCHEMA,
    // The runner contract (electron/workflow/code-runner.ts). Without it a model saving a code step
    // had to guess or read host source (measured 2026-10-04: five source reads before one save).
    code: { ...string(24000), description: "Code step body. Earlier values arrive in `vars` (python dict: vars.get('text'); js object: vars.text) — list the names in consumes. Assign the output to `result`; it becomes this step's produces value. print/console output is a log only." },
    codeLang: { enum: ["python", "js"] }, packages: array(string(120)),
    role: string(200), roleEn: string(200),
  }, ["title", "instruction", "effect"]), 32, 1),
  branches: array(object({
    afterStep: index, var: string(80), op: { enum: CONDITION_OPS },
    value: { anyOf: [{ type: "string", maxLength: 8000 }, { type: "number" }] }, yesStep: index, noStep: index,
    repeatStep: index, repeatOn: { enum: ["yes", "no"] }, maxRepeats: { type: "integer", minimum: 1, maximum: 20 },
  }, ["afterStep", "var", "op"])),
  checks: array(object({ afterStep: index, subject: string(80), criteria: string(4000),
    items: array(object({ text: string(2000), kind: { enum: ["must", "mustNot"] } }, ["text", "kind"])),
    produces: string(80), evidence: string(80),
  }, ["afterStep", "subject", "criteria"])),
}, ["schema", "name", "goal", "trigger", "steps"]);

const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const act = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
export const ONE_GRAPH_TOOLS = [
  { name: "one_graph_schema", annotations: ro, description: "Canonical blueprint schema. Optional catalog_id returns exact installed toolName, schemaDigest and argument schema for mcp_call execution steps (no LLM). Steps/value flow/checks/branches compile in host. Request include_registration_protocol only for typed monitor sources outside blueprint.", inputSchema: object({ catalog_id: string(128), include_registration_protocol: { type: "boolean" } }) },
  { name: "one_graph_inspect", annotations: ro, description: "Saved automations owned by this conversation. Omit graph_id for compact identities/revisions. if_cache_key avoids unchanged instructions. node_ids returns bounded selected nodes and remaining ids; one oversized node returns paged node_json with offset/limit. node_offset pages large topology summaries. Legacy prompt jobs automatically appear as one step.", inputSchema: object({ graph_id: id, if_cache_key: string(200), node_ids: array(id, 32, 1), node_offset: { type: "integer", minimum: 0 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 32000 } }) },
  { name: "one_graph_save", annotations: act, description: "Compile and save a structured blueprint using this run's authority. Enables when connections are ready unless enabled:false; no extra user confirmation. Existing graph_id requires its current expected_revision. Identical creation returns its saved receipt. Schedule/input triggers, reasoning/code steps, checks and bounded repeats are compiled by host. No implicit Goal/workspace grant.", inputSchema: object({ blueprint: GRAPH_BLUEPRINT_INPUT_SCHEMA, graph_id: id, expected_revision: revision, enabled: { type: "boolean" } }, ["blueprint"]) },
  { name: "one_graph_patch", annotations: act, description: "Change specified node instructions or native MCP calls/arguments and optional purpose. Pass exact node ids/current expected_revision. Provide instructions and/or mcp_calls. Keeps topology, effect declarations, runtime and grants; actual Main tool permission still dominates effect claims. No full graph copy for a strategy change. A code step changes through one_graph_save with graph_id and the revised blueprint.", inputSchema: object({ graph_id: id, expected_revision: revision,
    instructions: array(object({ node_id: id, instruction: string(16000) }, ["node_id", "instruction"]), 32, 1),
    mcp_calls: array(object({ node_id: id, call: GRAPH_MCP_CALL_INPUT_SCHEMA }, ["node_id", "call"]), 32, 1), goal: string(4000),
  }, ["graph_id", "expected_revision"]) },
  { name: "one_graph_set_enabled", annotations: act, description: "Enable/resume the exact inspected definition with expected_revision, or disable and request Stop. Stop remains available with read permission; enabling checks connections and pending execution/effects. Never silently revises or replaces a job.", inputSchema: object({ graph_id: id, enabled: { type: "boolean" }, expected_revision: revision }, ["graph_id", "enabled"]) },
  { name: "one_graph_run", annotations: act, description: "Execute an enabled saved graph through the host queue and return its result when ready (wait_seconds default 20, at most 50). Pass current expected_revision and stable request_id; retries never duplicate execution. Input contains named strings; no prompt copy. If still running, retain event_id and use one_graph_result. One owns strategy and may evaluate returned data itself or encode reasoning steps in the blueprint.", inputSchema: object({ graph_id: id, expected_revision: revision, request_id: string(128), wait_seconds: { type: "integer", minimum: 0, maximum: 50 },
    input: { type: "object", additionalProperties: true }, dry_run: { type: "boolean" },
  }, ["graph_id", "expected_revision", "request_id"]) },
  { name: "toolchain_publish", annotations: act, description: "Make a graph this conversation saved callable from other conversations (a Toolchain) when future requests will reuse it. Host drafts the contract (purpose, when to use and not, input schema, pessimistic effects) and runs a fresh-session test with no tools; only a passing test makes it callable, otherwise it stays a draft and the result says where the test failed. Pass graph_id and its current expected_revision. The owner can withdraw it from Toolchains.", inputSchema: object({ graph_id: id, expected_revision: revision }, ["graph_id", "expected_revision"]) },
  { name: "toolchain_search", annotations: ro, description: "Find an owner-approved callable automation (Toolchain) for a task before doing the work yourself. Returns at most 5 contracts (purpose, when_to_use, when_not_to_use, input_schema, input_examples, effects, expected_revision) or none. None means do the work normally. To use one, call one_graph_run with its graph_id, expected_revision, a stable request_id and input matching input_schema.", inputSchema: object({ task: string(2000), limit: { type: "integer", minimum: 1, maximum: 5 } }, ["task"]) },
  { name: "toolchain_report", annotations: act, description: "Tell whoever made a Toolchain that one of your runs of it was wrong for its input. Use it only after a one_graph_run you requested returned a wrong or unusable result: pass that graph_id and event_id, what was wrong (problem), and optionally the expected result. You cannot change a Toolchain you did not make; after reporting, do the request without it. It starts no work and changes nothing outside.", inputSchema: object({ graph_id: id, event_id: id, problem: string(1000), expected: string(1000) }, ["graph_id", "event_id", "problem"]) },
  { name: "one_graph_result", annotations: ro, description: "Result/status of this conversation's exact graph event. Optional wait_seconds waits up to 50 seconds; repeated reads never execute work. Includes bounded node outputs and typed failures. Fetch a longer output by node_id and offset/limit without loading all instructions/history.", inputSchema: object({ graph_id: id, event_id: id, wait_seconds: { type: "integer", minimum: 0, maximum: 50 }, node_id: id, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 32000 } }, ["graph_id", "event_id"]) },
] as const;
export const ONE_GRAPH_TOOL_NAMES = ONE_GRAPH_TOOLS.map(tool => tool.name);

/**
 * A saved graph may not drive the graph/Toolchain control surface itself (save, patch, run,
 * publish, search …). Membership, not a name prefix: the old `one_graph_` prefix rule let a graph
 * step call toolchain_publish unattended (independent review 2026-10-04).
 */
export function isGraphControlTool(catalogId: unknown, toolName: unknown): boolean {
  return catalogId === "one-team" && typeof toolName === "string" && (ONE_GRAPH_TOOL_NAMES as readonly string[]).includes(toolName);
}

/** Validate the finite JSON-schema vocabulary above before calling semantic
 * validators (which deliberately accept already typed blueprint objects). */
export function graphAuthoringShapeProblems(value: unknown, shape: Shape, at = "input"): string[] {
  const fail = (why: string) => [`${at}: ${why}`];
  if (shape.anyOf) return shape.anyOf.some(option => !graphAuthoringShapeProblems(value, option, at).length) ? [] : fail("invalid value type");
  if (shape.const !== undefined && value !== shape.const) return fail("unsupported schema");
  if (shape.enum && !shape.enum.includes(value)) return fail("unsupported value");
  if (shape.type === "string") {
    if (typeof value !== "string") return fail("expected string");
    if ((shape.minLength && value.trim().length < shape.minLength) || (shape.maxLength && value.length > shape.maxLength)) return fail("invalid length");
    if (shape.pattern && !new RegExp(shape.pattern).test(value)) return fail("invalid format");
  } else if (shape.type === "null" && value !== null) return fail("expected null");
  else if (shape.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return fail("expected finite number");
  else if (shape.type === "boolean" && typeof value !== "boolean") return fail("expected boolean");
  else if (shape.type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || (shape.minimum !== undefined && value < shape.minimum) || (shape.maximum !== undefined && value > shape.maximum)) return fail("invalid integer");
  } else if (shape.type === "array") {
    if (!Array.isArray(value)) return fail("expected array");
    if (value.length < (shape.minItems ?? 0) || value.length > (shape.maxItems ?? 32)) return fail("invalid item count");
    return value.flatMap((item, i) => graphAuthoringShapeProblems(item, shape.items!, `${at}[${i}]`));
  } else if (shape.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail("expected object");
    const data = value as Record<string, unknown>;
    const properties = shape.properties ?? {};
    const errors = (shape.required ?? []).filter(key => data[key] === undefined).map(key => `${at}.${key}: required`);
    if (shape.additionalProperties === false) errors.push(...Object.keys(data).filter(key => !Object.hasOwn(properties, key)).map(key => `${at}.${key}: unknown field`));
    for (const [key, field] of Object.entries(properties)) if (Object.hasOwn(data, key)) errors.push(...graphAuthoringShapeProblems(data[key], field, `${at}.${key}`));
    return errors;
  }
  return [];
}
