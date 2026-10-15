import { APP_CONTROL_CATALOG, type AppControlCatalogEntry } from "./catalog.generated";
import { APP_CONTROL_ARGUMENT_SCHEMAS } from "./argument-schemas.generated";
import { classifyAppControlPolicy, type AppControlEffect, type AppControlPolicyClassification } from "./policy";
import type { AppControlEventChannel, AppControlGeneratedContract, AppControlOutputBasis } from "./operation-contracts.generated";

// Native-harness operation descriptors (docs/2026-10-13-native-harness/14 sections 6 and 8, notyet NH19): one
// OperationDescriptor per app-control operation, derived as DATA from facts the sources already declare. It changes no
// dispatch behaviour and grants nothing: `policyRef` names the policy class, `callable` mirrors appControlPolicy().allowed,
// and no field here is read by the authorization path.
//   kind          never guessed from words in an operation name:
//                   surface "app" (acts on the window itself, service.ts HOST_OPERATIONS)        -> device-action
//                   policy facet "screen-view" (a view/live frame that belongs to a screen)      -> device-action
//                   the start operation of a declared job (APP_CONTROL_JOBS below)                -> job
//                   policy effect read (explicit path or segment rule; a denial keeps its effect) -> query
//                   any other declared effect                                                    -> command
//                   no declared effect -> "unclassified" with a reason (none today)
//   outputSchema  operation-contracts.generated.ts: the registered Main handler's data before app.call serialization,
//                 else the renderer bridge's declared type, else the Science daemon command's return statements; "untyped"
//                 with the reason when no source types it. bridgeAgreement says whether the handler's result fits the bridge.
//   execution     which Main entry runs it: a domain service (registerAppControlDomainIpc: no renderer needed, so the
//                 background service, SDK and harness reach it headless) or an owner-interaction IPC handler (needs the
//                 owner's live authenticated window; headless callers get needs-owner-interaction)
//   idempotency   read -> natural; a required caller key in the input (idempotencyKey/commandId/requestId/clientRequestId/
//                 submissionId) -> caller-key; a required revision precondition (expectedRevision/expectedVersion/
//                 expectedContentSha256) -> revision-precondition; otherwise none: a repeat may apply the effect again, so a
//                 caller reads state before repeating. Field names come from the input schema, never from the operation name.
//   cancellation  a query is not-applicable (one request/response, nothing keeps running); a job start names its cancel
//                 operation; any other command completes in-line and is not-cancellable through app.call
//   receipt       service.ts records one app-call ledger receipt per non-read call (operation, effect, input digest,
//                 status, code); a read writes none
//   projections   where the operation is reachable: One's tools, the harness app.call port, the background service through
//                 the device bridge (all through the same service and policy), never the paired phone (its harness
//                 allowlist, shared/mobile-bridge.ts, has no app.call)

export type OperationKind = "query" | "command" | "job" | "subscription" | "device-action" | "unclassified";
export type OperationIdempotency = "natural" | "caller-key" | "revision-precondition" | "none";
export type OperationUnclassifiedReason = "policy-default-write" | "policy-denied";
export type OperationCancellation =
  | { kind: "not-applicable" }
  | { kind: "not-cancellable" }
  | { kind: "job"; jobId: string; cancelOperation: string };
export type OperationReceipt =
  | { kind: "none" }
  | { kind: "app-call-ledger"; records: readonly string[] };
export interface OperationExecution {
  /** Which process runs the handler. The window's own operations run in its renderer. */
  process: "main" | "renderer";
  entry: "domain-service" | "owner-interaction" | "window";
  /** True when a caller without a window (background service, SDK, harness) can run it. */
  headless: boolean;
  /** The file whose registration call names the channel (or the host table for window operations). */
  registration: string;
  /** The Science daemon command Main forwards the call to. */
  daemonCommand?: string;
}
export interface OperationJobRole { jobId: string; role: "start" | "status" | "cancel"; key: string }
export interface OperationProjections { oneTools: boolean; harnessAppCall: boolean; daemonDeviceBridge: boolean; mobile: false; mobileReason: string }

export interface OperationDescriptor {
  operationId: string;
  semanticsVersion: "2";
  kind: OperationKind;
  /** Why `kind` is "unclassified"; absent otherwise. */
  kindReason?: OperationUnclassifiedReason;
  /** Which declared fact decided `kind`. */
  kindBasis: "surface-app" | "policy-facet" | "policy-effect" | "policy-denied-effect" | "declared-job" | "undecided";
  surface: "desktop" | "science" | "app";
  /** The declared effect class (a denied operation keeps the effect its denial declares). */
  effect: AppControlEffect | null;
  inputSchema: Record<string, unknown> | "unknown";
  /** Handler data schema (flat call reply for window operations); exact discovery separately declares
   * the fulfilled service reply, including truncated previews. Referenced sub-schemas ride along under $defs. */
  outputSchema: Record<string, unknown>;
  outputBasis: AppControlOutputBasis | "host-reply";
  untypedReason?: string;
  /** The Main handler's result against the renderer bridge's declared type ("mismatch": the bridge promises another shape). */
  bridgeAgreement?: NonNullable<AppControlGeneratedContract["handlerAgreement"]>;
  /** Field names the catalog documents for the result (not a schema). */
  outputFields?: string[];
  /** "app-control:<effect>" or "app-control:denied". A label for the existing policy; it grants nothing. */
  policyRef: string;
  /** false when appControlPolicy denies One this operation. */
  callable: boolean;
  deniedReason?: string;
  execution: OperationExecution;
  requiredHostPorts: string[];
  idempotency: OperationIdempotency;
  /** The input field that carries the caller key or revision precondition. */
  idempotencyField?: string;
  cancellation: OperationCancellation;
  job?: OperationJobRole;
  /** Push channels a declared job ties to this operation ("<prefix>:<id>" for a per-id stream). */
  events: string[];
  receipt: OperationReceipt;
  projections: OperationProjections;
  /** Legacy IPC invoke keys that resolve to exactly this operation: the channel, plus the leading literal arguments when
   * the channel multiplexes operations (harness:call("settings.language.get")). */
  aliases: string[];
  /** Legacy keys this operation shares with another operation (two bridge names for one handler): not aliases, because
   * they would not resolve to one operation. */
  ambiguousAliases?: string[];
  flags: { retired: false; uiOnly: boolean; dynamic: false };
  flagReasons: { uiOnly?: string };
  handlerRef: string;
}

/** A push channel a bridge subscribes to. app.call is request/response, so none is callable through it. */
export interface EventChannelDescriptor {
  operationId: string;
  kind: "subscription";
  member: string;
  surface: "desktop" | "science";
  channel: string;
  payloadSchema: Record<string, unknown>;
  payloadBasis: AppControlEventChannel["payloadBasis"];
  callable: false;
  deniedReason: string;
  projections: { oneTools: false; harnessAppCall: false; daemonDeviceBridge: false; mobile: false };
}

// ── declared jobs ───────────────────────────────────────────────────────────────────────────────────────────────────
// A start operation, the operation that stops it and (when one exists) the one that reads its state, tied by the key
// they share. `key` is a path into the start's input ("input.payload.operationId") or result ("result.runId"); every
// other operation names the argument path that carries the same key. validateAppControlJobs checks each path against
// the generated input and output schemas, so a renamed field or a removed operation fails the gate.
export interface AppControlJobDeclaration {
  jobId: string;
  start: string;
  key: string;
  cancel: { operation: string; key: string };
  status?: { operation: string; key: string };
  events?: string[];
}
export const APP_CONTROL_JOBS: readonly AppControlJobDeclaration[] = [
  { jobId: "invoke.run", start: "invoke.run", key: "result.runId", cancel: { operation: "invoke.cancel", key: "runId" },
    status: { operation: "invoke.receipt", key: "runId" }, events: ["invoke:event:<id>"] },
  { jobId: "hephaestus.build", start: "hephaestus.build", key: "result.runId", cancel: { operation: "hephaestus.cancelBuild", key: "runId" },
    events: ["hephaestus:build:<id>"] },
  { jobId: "automations.runNow", start: "automations.runNow", key: "input.id", cancel: { operation: "automations.stopRun", key: "id" },
    status: { operation: "automations.latestRun", key: "automationId" }, events: ["automations:liveRun:<id>"] },
  { jobId: "automations.interviewGraph", start: "automations.interviewGraph", key: "input.context.requestId",
    cancel: { operation: "automations.cancelGraphAuthoring", key: "requestId" }, events: ["automations:interview:<id>"] },
  { jobId: "localModelHub.downloadModel", start: "localModelHub.downloadModel", key: "input.payload.operationId",
    cancel: { operation: "localModelHub.cancelOperation", key: "payload.operationId" } },
  { jobId: "localModelHub.downloadEngine", start: "localModelHub.downloadEngine", key: "input.payload.operationId",
    cancel: { operation: "localModelHub.cancelOperation", key: "payload.operationId" } },
  { jobId: "mcpTools.oauthStart", start: "mcpTools.oauthStart", key: "result.attemptId", cancel: { operation: "mcpTools.oauthCancel", key: "attemptId" },
    status: { operation: "mcpTools.oauthStatus", key: "serverId" } },
  { jobId: "runtime.connectStart", start: "runtime.connectStart", key: "input.kind", cancel: { operation: "runtime.connectCancel", key: "kind" },
    status: { operation: "runtime.connectGet", key: "kind" }, events: ["runtime:connectEvent"] },
  { jobId: "multimodal.startVideo", start: "multimodal.startVideo", key: "result.id", cancel: { operation: "multimodal.cancelVideo", key: "id" },
    status: { operation: "multimodal.getVideoJob", key: "id" } },
  { jobId: "science.composer.start", start: "science.composer.start", key: "result.turn.id", cancel: { operation: "science.composer.cancel", key: "input.turnId" },
    status: { operation: "science.composer.receipt", key: "input.turnId" }, events: ["science:turnEvent"] },
  { jobId: "science.manuscripts.createRenderJob", start: "science.manuscripts.createRenderJob", key: "result.id",
    cancel: { operation: "science.manuscripts.cancelRenderJob", key: "input.jobId" }, status: { operation: "science.manuscripts.getRenderJob", key: "input.jobId" } },
  { jobId: "science.math.command", start: "science.math.command", key: "input.input.requestId", cancel: { operation: "science.math.cancel", key: "input.requestId" } },
  { jobId: "site.launchAgentApp", start: "site.launchAgentApp", key: "input.payload.projectId", cancel: { operation: "site.stopAgentApp", key: "payload.projectId" },
    status: { operation: "site.agentAppRuntimeStatus", key: "payload.projectId" } },
  { jobId: "oneSupervisor.startWork", start: "oneSupervisor.startWork", key: "result.taskId", cancel: { operation: "oneSupervisor.stopTask", key: "input.taskId" } },
  { jobId: "oneSupervisor.send", start: "oneSupervisor.send", key: "result.runId", cancel: { operation: "oneSupervisor.stopReply", key: "input.runId" } },
];

// ── generated contracts (loaded on first use: the table is large and dispatch never reads it) ──────────────────────
type Contracts = typeof import("./operation-contracts.generated");
let contractsModule: Contracts | null = null;
function contracts(): Contracts {
  return contractsModule ??= require("./operation-contracts.generated") as Contracts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Resolve one shared sub-schema reference ({"$ref":"#/$defs/<id>"}); anything else is returned as it is. */
export function resolveOutputRef(node: unknown): unknown {
  let current = node;
  for (let depth = 0; depth < 8 && isRecord(current) && typeof current.$ref === "string" && current.$ref.startsWith("#/$defs/"); depth++) {
    current = contracts().APP_CONTROL_OUTPUT_DEFS[current.$ref.slice("#/$defs/".length)];
  }
  return current;
}

/** The schema plus every shared sub-schema it references (transitively) under $defs: a complete JSON Schema. */
export function withOutputDefs(schema: Record<string, unknown>): Record<string, unknown> {
  const defs: Record<string, Record<string, unknown>> = {};
  const table = contracts().APP_CONTROL_OUTPUT_DEFS;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!isRecord(node)) return;
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/$defs/")) {
      const id = node.$ref.slice("#/$defs/".length);
      if (!defs[id] && table[id]) { defs[id] = table[id]; visit(table[id]); }
      return;
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(schema);
  return Object.keys(defs).length ? { ...schema, $defs: defs } : schema;
}

/** True when `path` names a property the schema declares (through refs, anyOf variants and nested objects). */
export function schemaHasPath(schema: unknown, path: readonly string[]): boolean {
  if (!path.length) return true;
  const node = resolveOutputRef(schema);
  if (!isRecord(node)) return false;
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = node[key];
    if (Array.isArray(variants) && variants.some((variant) => schemaHasPath(variant, path))) return true;
  }
  const properties = isRecord(node.properties) ? node.properties : null;
  return !!properties && Object.hasOwn(properties, path[0]) && schemaHasPath(properties[path[0]], path.slice(1));
}

const CALLER_KEY_FIELDS = ["idempotencyKey", "commandId", "requestId", "clientRequestId", "submissionId"];
const REVISION_FIELDS = ["expectedRevision", "expectedVersion", "expectedContentSha256"];

/** A required field (at the top level or inside one required object argument) the operation takes. */
function requiredInputField(input: Record<string, unknown> | undefined, names: readonly string[]): string | undefined {
  if (!input) return undefined;
  const required = (node: Record<string, unknown>) => Array.isArray(node.required) ? node.required as string[] : [];
  const properties = (node: Record<string, unknown>) => isRecord(node.properties) ? node.properties : {};
  for (const name of names) if (required(input).includes(name)) return name;
  for (const argument of required(input)) {
    const value = properties(input)[argument];
    const variants = isRecord(value) && Array.isArray(value.anyOf) ? value.anyOf.filter(isRecord) : isRecord(value) ? [value] : [];
    for (const variant of variants) for (const name of names) if (required(variant).includes(name)) return `${argument}.${name}`;
  }
  return undefined;
}

function idempotencyOf(effect: AppControlEffect | null, input: Record<string, unknown> | undefined): Pick<OperationDescriptor, "idempotency" | "idempotencyField"> {
  if (effect === "read") return { idempotency: "natural" };
  const key = requiredInputField(input, CALLER_KEY_FIELDS);
  if (key) return { idempotency: "caller-key", idempotencyField: key };
  const revision = requiredInputField(input, REVISION_FIELDS);
  if (revision) return { idempotency: "revision-precondition", idempotencyField: revision };
  return { idempotency: "none" };
}

let jobRoles: Map<string, OperationJobRole & { declaration: AppControlJobDeclaration }> | null = null;
function jobRoleOf(operationId: string): (OperationJobRole & { declaration: AppControlJobDeclaration }) | undefined {
  if (!jobRoles) {
    jobRoles = new Map();
    for (const job of APP_CONTROL_JOBS) {
      jobRoles.set(job.start, { jobId: job.jobId, role: "start", key: job.key, declaration: job });
      if (!jobRoles.has(job.cancel.operation)) jobRoles.set(job.cancel.operation, { jobId: job.jobId, role: "cancel", key: job.cancel.key, declaration: job });
      if (job.status && !jobRoles.has(job.status.operation)) jobRoles.set(job.status.operation, { jobId: job.jobId, role: "status", key: job.status.key, declaration: job });
    }
  }
  return jobRoles.get(operationId);
}

const MOBILE_REASON = "the paired phone's harness allowlist (shared/mobile-bridge.ts MOBILE_HARNESS_READ/COMMAND_OPERATIONS) has no app.call";
const RECEIPT_RECORDS = ["operationId", "effect", "inputDigest", "status", "code", "ownerTurn"] as const;

function kindFrom(classification: AppControlPolicyClassification, surface: OperationDescriptor["surface"], startsJob: boolean):
  Pick<OperationDescriptor, "kind" | "kindBasis" | "kindReason"> {
  if (surface === "app") return { kind: "device-action", kindBasis: "surface-app" };
  if (classification.facet === "screen-view") return { kind: "device-action", kindBasis: "policy-facet" };
  const policy = classification.policy;
  if (!policy.allowed) {
    if (!classification.effect) return { kind: "unclassified", kindBasis: "undecided", kindReason: "policy-denied" };
    if (startsJob) return { kind: "job", kindBasis: "declared-job" };
    return { kind: classification.effect === "read" ? "query" : "command", kindBasis: "policy-denied-effect" };
  }
  if (classification.basis === "default") return { kind: "unclassified", kindBasis: "undecided", kindReason: "policy-default-write" };
  if (startsJob) return { kind: "job", kindBasis: "declared-job" };
  return { kind: policy.effect === "read" ? "query" : "command", kindBasis: "policy-effect" };
}

interface BuildInput {
  operationId: string; surface: OperationDescriptor["surface"]; classification: AppControlPolicyClassification;
  inputSchema: Record<string, unknown> | undefined; outputFields?: string[]; aliases: string[]; handlerRef: string;
  contract?: AppControlGeneratedContract; hostOutput?: Record<string, unknown>;
}

function build(input: BuildInput): OperationDescriptor {
  const { classification } = input;
  const policy = classification.policy;
  const effect: AppControlEffect | null = policy.allowed ? policy.effect : classification.effect ?? null;
  const role = jobRoleOf(input.operationId);
  const kind = kindFrom(classification, input.surface, role?.role === "start");
  const windowOperation = input.surface === "app";
  const entry: OperationExecution["entry"] = windowOperation ? "window" : input.contract?.execution ?? "owner-interaction";
  const execution: OperationExecution = {
    process: windowOperation ? "renderer" : "main", entry, headless: entry === "domain-service",
    registration: windowOperation ? "electron/app-control/service.ts HOST_OPERATIONS" : input.contract?.registration ?? "not-found-statically",
    ...(input.contract?.daemonCommand ? { daemonCommand: input.contract.daemonCommand } : {}),
  };
  const requiredHostPorts = windowOperation ? ["window"] : entry === "domain-service" ? ["main-process"] : ["main-process", "window"];
  if (execution.daemonCommand) requiredHostPorts.push("science-daemon");
  const cancellation: OperationCancellation = role?.role === "start"
    ? { kind: "job", jobId: role.jobId, cancelOperation: role.declaration.cancel.operation }
    : effect === "read" || role?.role === "cancel" ? { kind: "not-applicable" } : { kind: "not-cancellable" };
  const output = input.hostOutput ?? input.contract?.output ?? { description: "No generated contract names this operation." };
  return {
    operationId: input.operationId, semanticsVersion: "2", ...kind, surface: input.surface, effect,
    inputSchema: input.inputSchema ?? "unknown",
    outputSchema: input.hostOutput ? input.hostOutput : withOutputDefs(output),
    outputBasis: input.hostOutput ? "host-reply" : input.contract?.outputBasis ?? "untyped",
    ...(input.contract?.untypedReason ? { untypedReason: input.contract.untypedReason } : !input.contract && !input.hostOutput ? { untypedReason: "no-generated-contract" } : {}),
    ...(input.contract?.handlerAgreement ? { bridgeAgreement: input.contract.handlerAgreement } : {}),
    ...(input.outputFields?.length ? { outputFields: input.outputFields } : {}),
    policyRef: policy.allowed ? `app-control:${policy.effect}` : "app-control:denied",
    callable: policy.allowed, ...(policy.allowed ? {} : { deniedReason: policy.reason }),
    execution, requiredHostPorts,
    ...idempotencyOf(effect, input.inputSchema),
    cancellation,
    ...(role ? { job: { jobId: role.jobId, role: role.role, key: role.key } } : {}),
    events: role?.role === "start" || role?.role === "status" ? [...(role.declaration.events ?? [])] : [],
    receipt: effect === "read" ? { kind: "none" } : { kind: "app-call-ledger", records: RECEIPT_RECORDS },
    projections: { oneTools: policy.allowed, harnessAppCall: policy.allowed, daemonDeviceBridge: policy.allowed, mobile: false, mobileReason: MOBILE_REASON },
    aliases: input.aliases,
    flags: { retired: false, uiOnly: classification.facet === "screen-view", dynamic: false },
    flagReasons: classification.facet === "screen-view" && !policy.allowed ? { uiOnly: policy.reason } : classification.facet === "screen-view" ? { uiOnly: "operates a view on the owner's screen" } : {},
    handlerRef: input.handlerRef,
  };
}

export function legacyInvokeKey(entry: Pick<AppControlCatalogEntry, "channel" | "invokeArgs">): string {
  const leading: unknown[] = [];
  for (const arg of entry.invokeArgs) { if (!("literal" in arg)) break; leading.push(arg.literal); }
  return leading.length ? `${entry.channel}(${leading.map((value) => JSON.stringify(value)).join(",")})` : entry.channel;
}

let invokeKeyOwners: Map<string, number> | null = null;
function invokeKeyCount(key: string): number {
  if (!invokeKeyOwners) {
    invokeKeyOwners = new Map();
    for (const entry of APP_CONTROL_CATALOG) { const k = legacyInvokeKey(entry); invokeKeyOwners.set(k, (invokeKeyOwners.get(k) ?? 0) + 1); }
  }
  return invokeKeyOwners.get(key) ?? 0;
}

export function describeCatalogOperation(entry: AppControlCatalogEntry): OperationDescriptor {
  const key = legacyInvokeKey(entry);
  const ambiguous = invokeKeyCount(key) > 1;
  return { ...build({ operationId: entry.path, surface: entry.surface, classification: classifyAppControlPolicy(entry),
    inputSchema: APP_CONTROL_ARGUMENT_SCHEMAS[entry.path], outputFields: entry.keywords, aliases: ambiguous ? [] : [key], handlerRef: `ipc:${entry.channel}`,
    contract: contracts().APP_CONTROL_OPERATION_CONTRACTS[entry.path] }),
    ...(ambiguous ? { ambiguousAliases: [key] } : {}) };
}

/** The renderer's acknowledgement every window operation returns (service.ts rendererCall validates exactly this). */
const HOST_REPLY_SCHEMA: Record<string, unknown> = {
  type: "object", required: ["ok", "operation", "effect"], additionalProperties: true,
  properties: {
    ok: { type: "boolean" }, operation: { type: "string" }, effect: { enum: ["read", "write", "destructive", "consent"] },
    code: { type: "string", description: "Present when ok is false." },
    state: { type: "object", description: "The UI state after the operation: route, locale and theme preferences, sidebar, media display, UI preferences.",
      required: ["route", "localePreference", "locale", "themePreference", "theme", "darkThemeAvailable", "sidebarCollapsed", "sidebarWidth", "media", "uiPreferences"],
      properties: { route: { type: "string" }, localePreference: { enum: ["ko", "en", "system"] }, locale: { enum: ["ko", "en"] },
        themePreference: { enum: ["light", "dark", "system"] }, theme: { enum: ["light", "dark"] }, darkThemeAvailable: { type: "boolean" },
        sidebarCollapsed: { type: "boolean" }, sidebarWidth: { type: "number" },
        media: { type: "object", properties: { image: { type: "boolean" }, video: { type: "boolean" }, audio: { type: "boolean" } }, required: ["image", "video", "audio"] },
        uiPreferences: { type: "object" } } },
    preferences: { type: "object", description: "app.getUiPreferences only." },
    definitions: { type: "object", description: "app.getUiPreferences only: description and value_schema per preference." },
  },
};

/** Operations that act on the window itself (service.ts HOST_OPERATIONS); effect and schema are declared there. */
export function describeHostOperation(input: { path: string; effect: AppControlEffect; inputSchema?: Record<string, unknown> }): OperationDescriptor {
  return build({ operationId: input.path, surface: "app", classification: { policy: { allowed: true, effect: input.effect }, basis: "explicit-path" },
    inputSchema: input.inputSchema, aliases: [], handlerRef: `host:${input.path}`, hostOutput: HOST_REPLY_SCHEMA });
}

let cached: readonly OperationDescriptor[] | null = null;
/** One descriptor per catalog operation, in catalog order. */
export function appControlOperationDescriptors(): readonly OperationDescriptor[] {
  return cached ??= APP_CONTROL_CATALOG.map(describeCatalogOperation);
}

/** One descriptor per push channel the bridges subscribe to. */
export function appControlEventDescriptors(): readonly EventChannelDescriptor[] {
  return contracts().APP_CONTROL_EVENT_CHANNELS.map((event) => ({
    operationId: `event:${event.member}:${event.channel}`, kind: "subscription", member: event.member, surface: event.surface, channel: event.channel,
    payloadSchema: withOutputDefs(event.payloadSchema), payloadBasis: event.payloadBasis, callable: false,
    deniedReason: "a renderer push channel; app.call is request/response and no SDK, harness or mobile transport subscribes to it",
    projections: { oneTools: false, harnessAppCall: false, daemonDeviceBridge: false, mobile: false },
  }));
}

/** Every declared job names catalog operations, and every key path exists in the generated input/output schemas. */
export function validateAppControlJobs(jobs: readonly AppControlJobDeclaration[] = APP_CONTROL_JOBS): string[] {
  const errors: string[] = [];
  const byPath = new Map(APP_CONTROL_CATALOG.map((entry) => [entry.path, entry]));
  const events = new Set(contracts().APP_CONTROL_EVENT_CHANNELS.map((event) => event.channel));
  const output = (operation: string) => contracts().APP_CONTROL_OPERATION_CONTRACTS[operation]?.output;
  const ids = new Set<string>();
  for (const job of jobs) {
    if (ids.has(job.jobId)) errors.push(`duplicate job ${job.jobId}`);
    ids.add(job.jobId);
    for (const operation of [job.start, job.cancel.operation, ...(job.status ? [job.status.operation] : [])]) {
      if (!byPath.has(operation)) errors.push(`${job.jobId}: ${operation} is not a catalog operation`);
    }
    const [side, ...rest] = job.key.split(".");
    if (side === "result") {
      if (!schemaHasPath(output(job.start), rest)) errors.push(`${job.jobId}: the result of ${job.start} has no ${rest.join(".")}`);
    } else if (side === "input") {
      if (!schemaHasPath(APP_CONTROL_ARGUMENT_SCHEMAS[job.start], rest)) errors.push(`${job.jobId}: ${job.start} takes no ${rest.join(".")}`);
    } else errors.push(`${job.jobId}: key ${job.key} is neither input.* nor result.*`);
    for (const side of [job.cancel, ...(job.status ? [job.status] : [])]) {
      if (!schemaHasPath(APP_CONTROL_ARGUMENT_SCHEMAS[side.operation], side.key.split("."))) errors.push(`${job.jobId}: ${side.operation} takes no ${side.key}`);
    }
    if (classifyAppControlPolicy({ path: job.start }).facet === "screen-view") errors.push(`${job.jobId}: ${job.start} is a screen view`);
    for (const event of job.events ?? []) if (!events.has(event)) errors.push(`${job.jobId}: no bridge subscribes to ${event}`);
  }
  return errors;
}

export interface OperationDescriptorReport {
  total: number; catalogTotal: number; ok: boolean; errors: string[];
  byKind: Record<OperationKind, number>; unclassifiedByReason: Record<string, number>;
  byOutputBasis: Record<string, number>; byBridgeAgreement: Record<string, number>; byExecution: Record<string, number>; byIdempotency: Record<string, number>;
  /** Legacy keys shared by more than one operation (excluded from aliases). */
  ambiguousAliases: string[];
}

/** Zero operationId collisions, exactly one descriptor per catalog operation, every alias resolves to one operation,
 * every output schema declared (typed, or untyped with its reason), every declared job consistent with the schemas. */
export function validateOperationDescriptors(descriptors: readonly OperationDescriptor[] = appControlOperationDescriptors(),
  catalog: readonly Pick<AppControlCatalogEntry, "path" | "channel">[] = APP_CONTROL_CATALOG): OperationDescriptorReport {
  const errors: string[] = [];
  const byId = new Map<string, number>();
  for (const descriptor of descriptors) byId.set(descriptor.operationId, (byId.get(descriptor.operationId) ?? 0) + 1);
  for (const [id, count] of byId) if (count > 1) errors.push(`duplicate operationId ${id} (${count})`);
  const catalogPaths = new Set<string>();
  for (const entry of catalog) {
    if (catalogPaths.has(entry.path)) errors.push(`duplicate catalog path ${entry.path}`);
    catalogPaths.add(entry.path);
    if (byId.get(entry.path) !== 1) errors.push(`catalog operation ${entry.path} has ${byId.get(entry.path) ?? 0} descriptors`);
  }
  for (const id of byId.keys()) if (!catalogPaths.has(id) && !id.startsWith("app.")) errors.push(`descriptor ${id} is not in the catalog`);
  const aliasOwner = new Map<string, string>();
  for (const descriptor of descriptors) for (const alias of descriptor.aliases) {
    const owner = aliasOwner.get(alias);
    if (owner && owner !== descriptor.operationId) errors.push(`alias ${alias} resolves to ${owner} and ${descriptor.operationId}`);
    aliasOwner.set(alias, descriptor.operationId);
    if (byId.has(alias) && alias !== descriptor.operationId) errors.push(`alias ${alias} collides with an operationId`);
  }
  const byKind: Record<OperationKind, number> = { query: 0, command: 0, job: 0, subscription: 0, "device-action": 0, unclassified: 0 };
  const unclassifiedByReason: Record<string, number> = {}, byOutputBasis: Record<string, number> = {}, byBridgeAgreement: Record<string, number> = {}, byExecution: Record<string, number> = {}, byIdempotency: Record<string, number> = {};
  for (const descriptor of descriptors) {
    byKind[descriptor.kind] += 1;
    if (descriptor.kind === "unclassified") {
      if (!descriptor.kindReason) errors.push(`${descriptor.operationId} is unclassified without a reason`);
      unclassifiedByReason[descriptor.kindReason ?? "none"] = (unclassifiedByReason[descriptor.kindReason ?? "none"] ?? 0) + 1;
    }
    if (!isRecord(descriptor.outputSchema)) errors.push(`${descriptor.operationId} has no output schema`);
    if (descriptor.outputBasis === "untyped" && !descriptor.untypedReason) errors.push(`${descriptor.operationId} is untyped without a reason`);
    if (descriptor.execution.registration === "not-found-statically") errors.push(`${descriptor.operationId}: no registration call names ${descriptor.handlerRef}`);
    if (descriptor.kind === "query" && descriptor.cancellation.kind !== "not-applicable") errors.push(`${descriptor.operationId}: a query declares cancellation`);
    if (descriptor.kind === "job" && descriptor.cancellation.kind !== "job") errors.push(`${descriptor.operationId}: a job without its cancel operation`);
    byOutputBasis[descriptor.outputBasis] = (byOutputBasis[descriptor.outputBasis] ?? 0) + 1;
    byBridgeAgreement[descriptor.bridgeAgreement ?? "none"] = (byBridgeAgreement[descriptor.bridgeAgreement ?? "none"] ?? 0) + 1;
    byExecution[descriptor.execution.entry] = (byExecution[descriptor.execution.entry] ?? 0) + 1;
    byIdempotency[descriptor.idempotency] = (byIdempotency[descriptor.idempotency] ?? 0) + 1;
  }
  errors.push(...validateAppControlJobs());
  const ambiguousAliases = [...new Set(descriptors.flatMap((descriptor) => descriptor.ambiguousAliases ?? []))].sort();
  return { total: descriptors.length, catalogTotal: catalog.length, ok: errors.length === 0, errors, byKind, unclassifiedByReason,
    byOutputBasis, byBridgeAgreement, byExecution, byIdempotency, ambiguousAliases };
}
