/**
 * Graph drafts (docs native-harness 24 §3): build a graph a few operations at a time instead of writing a whole
 * blueprint JSON in one go. A draft is a blueprint whose steps carry stable refs; branches and checks point at refs,
 * not indices, so inserting or moving a step never silently re-points them.
 *
 * The draft only edits a scratch document. Validation is the same check one_graph_save runs (shape, compiler, MCP
 * effect, references, schedule) and commit IS one_graph_save — same revision check, transaction, permission and
 * receipt — so the incremental path adds no second graph compiler or store.
 *
 * apply is all-or-nothing: every operation runs on a copy and the draft changes only when all of them succeed.
 * A request_id makes a retry return the first result; reusing it for different operations is refused.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { userDataPath } from "../runtime-paths";
import type { OneTeamCaller } from "./team-dispatch";
import type { GraphOriginBinding } from "./graph-origin";
import type { BlueprintBranch, BlueprintCheck, BlueprintStep, BlueprintTrigger, GraphBlueprint } from "../../shared/graph-blueprint";
import { BLUEPRINT_SCHEMA, CONDITION_OPS } from "../../shared/graph-blueprint";
import { didYouMean } from "../../shared/did-you-mean";

export const GRAPH_DRAFT_SCHEMA = "agentlas.graph-draft.v1" as const;
const MAX_STEPS = 32;
const MAX_DRAFTS_PER_OWNER = 20;
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REF_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const STEP_FIELDS = ["title", "instruction", "effect", "produces", "consumes", "uses", "kind", "toolchainCall", "mcpCall", "graphRef", "code", "codeLang", "packages", "role", "roleEn"] as const;

type DraftStep = { ref: string } & Partial<BlueprintStep>;
type DraftBranch = { id: string; after: string; var: string; test: BlueprintBranch["op"]; value?: string | number; yes?: string; no?: string; repeat?: string; repeatOn?: "yes" | "no"; maxRepeats?: number };
type DraftCheck = { id: string; after: string } & Omit<BlueprintCheck, "afterStep">;

export interface GraphDraft {
  schemaVersion: typeof GRAPH_DRAFT_SCHEMA;
  draftId: string;
  ownerChatId: string;
  /** Host-only creation provenance; absent on legacy drafts and never exposed in the model view. */
  originRunId?: string | null;
  /** Committing replaces this saved graph (one_graph_save with graph_id + expected_revision). */
  base: { graphId: string; expectedRevision: string } | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  name?: string;
  goal?: string;
  trigger?: BlueprintTrigger;
  steps: DraftStep[];
  branches: DraftBranch[];
  checks: DraftCheck[];
  requests: Record<string, { digest: string; result: unknown }>;
  committed?: { graphId: string; revision: string; at: string };
}

export class GraphDraftError extends Error {
  constructor(readonly code: string, readonly detail?: string) { super(code); }
}

export interface GraphDraftHost {
  /** The conversation that owns graphs for this caller (one_graph_* owner rule). */
  ownerChatId(caller: OneTeamCaller): string;
  /** one_graph_save's checks without saving. */
  validate(caller: OneTeamCaller, blueprint: GraphBlueprint, graphId: string | null): Promise<{ ok: true } | { ok: false; code: string; problems: unknown }>;
  /** one_graph_save itself. */
  save(caller: OneTeamCaller, input: Record<string, unknown>): Promise<unknown>;
}

const fail = (code: string, detail?: string): never => { throw new GraphDraftError(code, detail); };
const now = (): string => new Date().toISOString();
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const draftsDir = (): string => userDataPath("graph-drafts");
const draftFile = (draftId: string): string => {
  if (!/^[0-9a-f-]{36}$/.test(draftId)) fail("graph_draft_unknown");
  return path.join(draftsDir(), `${draftId}.json`);
};

function readDraft(draftId: string, ownerChatId: string): GraphDraft {
  let draft: GraphDraft;
  try { draft = JSON.parse(fs.readFileSync(draftFile(draftId), "utf8")) as GraphDraft; }
  catch { return fail("graph_draft_unknown"); }
  // Another conversation's draft reads exactly like a missing one.
  if (draft.schemaVersion !== GRAPH_DRAFT_SCHEMA || draft.ownerChatId !== ownerChatId) fail("graph_draft_unknown");
  return draft;
}

function writeDraft(draft: GraphDraft): void {
  fs.mkdirSync(draftsDir(), { recursive: true, mode: 0o700 });
  const target = draftFile(draft.draftId);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(draft), { mode: 0o600 });
  fs.renameSync(temp, target);
}

function pruneDrafts(ownerChatId: string): void {
  let names: string[] = [];
  try { names = fs.readdirSync(draftsDir()).filter((name) => name.endsWith(".json")); } catch { return; }
  const mine: Array<{ file: string; updatedAt: number }> = [];
  for (const name of names) {
    const file = path.join(draftsDir(), name);
    try {
      const draft = JSON.parse(fs.readFileSync(file, "utf8")) as GraphDraft;
      const updatedAt = Date.parse(draft.updatedAt);
      if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > DRAFT_TTL_MS) { fs.rmSync(file, { force: true }); continue; }
      if (draft.ownerChatId === ownerChatId) mine.push({ file, updatedAt });
    } catch { /* a half-written file from a crash stays until its TTL is decided by mtime below */ }
  }
  mine.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const old of mine.slice(MAX_DRAFTS_PER_OWNER - 1)) fs.rmSync(old.file, { force: true });
}

const str = (value: unknown, field: string, max = 16000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail("graph_draft_argument_invalid", field);
  return value as string;
};
const optStr = (value: unknown, field: string, max = 16000): string | undefined => value === undefined ? undefined : str(value, field, max);
const ref = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !REF_RE.test(value)) fail("graph_draft_ref_invalid", field);
  return value as string;
};
const stepIndex = (draft: GraphDraft, value: unknown, field: string): number => {
  const index = draft.steps.findIndex((step) => step.ref === ref(value, field));
  if (index < 0) fail("graph_draft_ref_unknown", `${field}: ${String(value)}`);
  return index;
};

/** Seed steps from a blueprint (new draft or a saved definition the model already has). */
function seedFromBlueprint(draft: GraphDraft, blueprint: GraphBlueprint): void {
  if (!blueprint || typeof blueprint !== "object" || !Array.isArray(blueprint.steps)) fail("graph_draft_argument_invalid", "blueprint");
  draft.name = blueprint.name; draft.goal = blueprint.goal; draft.trigger = blueprint.trigger;
  draft.steps = blueprint.steps.map((step, i) => ({ ref: `step${i + 1}`, ...step }));
  const at = (index: number | undefined, field: string): string | undefined => {
    if (index === undefined) return undefined;
    const step = draft.steps[index];
    if (!step) fail("graph_draft_argument_invalid", field);
    return step.ref;
  };
  draft.branches = (blueprint.branches ?? []).map((b, i) => ({ id: `branch${i + 1}`, after: at(b.afterStep, "branches.afterStep")!, var: b.var, test: b.op,
    ...(b.value !== undefined ? { value: b.value } : {}), ...(b.yesStep !== undefined ? { yes: at(b.yesStep, "branches.yesStep") } : {}),
    ...(b.noStep !== undefined ? { no: at(b.noStep, "branches.noStep") } : {}), ...(b.repeatStep !== undefined ? { repeat: at(b.repeatStep, "branches.repeatStep"), repeatOn: b.repeatOn, maxRepeats: b.maxRepeats } : {}) }));
  draft.checks = (blueprint.checks ?? []).map((c, i) => { const { afterStep, ...rest } = c; return { id: `check${i + 1}`, after: at(afterStep, "checks.afterStep")!, ...rest }; });
}

function stepFields(input: Record<string, unknown>, partial: boolean): Partial<BlueprintStep> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (["op", "ref", "before", "after", "set", "unset"].includes(key)) continue;
    if (!(STEP_FIELDS as readonly string[]).includes(key)) fail("graph_draft_field_unknown", key);
    out[key] = input[key];
  }
  if (!partial) { str(out.title, "title", 160); str(out.instruction, "instruction"); }
  if (out.effect !== undefined && out.effect !== "read" && out.effect !== "mutation") fail("graph_draft_argument_invalid", "effect");
  if (!partial && out.effect === undefined) fail("graph_draft_argument_invalid", "effect");
  return out as Partial<BlueprintStep>;
}

/** Steps, branches or checks that still point at a step or read its value. */
function usesOf(draft: GraphDraft, stepRef: string): string[] {
  const step = draft.steps.find((s) => s.ref === stepRef);
  const users: string[] = [];
  for (const b of draft.branches) if ([b.after, b.yes, b.no, b.repeat].includes(stepRef)) users.push(`branch ${b.id}`);
  for (const c of draft.checks) if (c.after === stepRef) users.push(`check ${c.id}`);
  if (step?.produces) for (const other of draft.steps) if (other.ref !== stepRef && other.consumes?.includes(step.produces)) users.push(`step ${other.ref} consumes ${step.produces}`);
  return users;
}

function placeStep(draft: GraphDraft, step: DraftStep, op: Record<string, unknown>): void {
  if (op.before !== undefined && op.after !== undefined) fail("graph_draft_argument_invalid", "before and after together");
  if (op.before !== undefined) draft.steps.splice(stepIndex(draft, op.before, "before"), 0, step);
  else if (op.after !== undefined) draft.steps.splice(stepIndex(draft, op.after, "after") + 1, 0, step);
  else draft.steps.push(step);
}

/** The operation names applyOne handles (one per `case`); used only to name the closest one when an operation is unknown. */
export const GRAPH_DRAFT_OPERATIONS = ["draft.set", "trigger.set", "node.create", "node.update", "node.move", "node.remove", "edge.connect",
  "edge.disconnect", "branch.set", "repeat.set", "branch.remove", "check.add", "check.remove"] as const;

function applyOne(draft: GraphDraft, op: Record<string, unknown>): void {
  switch (op.op) {
    case "draft.set": {
      if (op.name !== undefined) draft.name = str(op.name, "name", 160);
      if (op.goal !== undefined) draft.goal = str(op.goal, "goal", 4000);
      return;
    }
    case "trigger.set": {
      if (op.kind === "cron") draft.trigger = { kind: "cron", schedule: str(op.schedule, "schedule", 256) };
      else if (op.kind === "input") draft.trigger = { kind: "input", label: str(op.label, "label", 160), varName: str(op.varName, "varName", 80) };
      else fail("graph_draft_argument_invalid", "kind");
      return;
    }
    case "node.create": {
      const stepRef = ref(op.ref, "ref");
      if (draft.steps.some((s) => s.ref === stepRef)) fail("graph_draft_ref_exists", stepRef);
      if (draft.steps.length >= MAX_STEPS) fail("graph_draft_too_many_steps");
      placeStep(draft, { ref: stepRef, ...stepFields(op, false) }, op);
      return;
    }
    case "node.update": {
      const index = stepIndex(draft, op.ref, "ref");
      const set = op.set && typeof op.set === "object" && !Array.isArray(op.set) ? op.set as Record<string, unknown> : {};
      const unset = Array.isArray(op.unset) ? op.unset : [];
      if (!Object.keys(set).length && !unset.length) fail("graph_draft_argument_invalid", "set or unset");
      const next: DraftStep = { ...draft.steps[index], ...stepFields(set, true) };
      for (const key of unset) {
        if (typeof key !== "string" || !(STEP_FIELDS as readonly string[]).includes(key) || ["title", "instruction", "effect"].includes(key)) fail("graph_draft_field_unknown", String(key));
        delete (next as Record<string, unknown>)[key as string];
      }
      const previous = draft.steps[index];
      if (previous.produces && previous.produces !== next.produces) {
        const readers = draft.steps.filter((s) => s.ref !== previous.ref && s.consumes?.includes(previous.produces!)).map((s) => s.ref);
        if (readers.length) fail("graph_draft_value_in_use", `${previous.produces} is consumed by ${readers.join(", ")}`);
      }
      draft.steps[index] = next;
      return;
    }
    case "node.move": {
      const index = stepIndex(draft, op.ref, "ref");
      const [step] = draft.steps.splice(index, 1);
      placeStep(draft, step, op);
      return;
    }
    case "node.remove": {
      const stepRef = draft.steps[stepIndex(draft, op.ref, "ref")].ref;
      const users = usesOf(draft, stepRef);
      if (users.length) fail("graph_draft_node_in_use", users.join("; "));
      draft.steps = draft.steps.filter((s) => s.ref !== stepRef);
      return;
    }
    case "edge.connect": {
      const from = stepIndex(draft, op.from, "from"), to = stepIndex(draft, op.to, "to");
      if (from >= to) fail("graph_draft_edge_backwards", "move the target after the source (node.move) — repeats use repeat.set");
      const produces = draft.steps[from].produces;
      if (!produces) fail("graph_draft_source_produces_nothing", "set produces on the source step");
      const target = draft.steps[to];
      if (!target.consumes?.includes(produces!)) draft.steps[to] = { ...target, consumes: [...(target.consumes ?? []), produces!] };
      return;
    }
    case "edge.disconnect": {
      const from = stepIndex(draft, op.from, "from"), to = stepIndex(draft, op.to, "to");
      const produces = draft.steps[from].produces;
      const target = draft.steps[to];
      if (!produces || !target.consumes?.includes(produces)) fail("graph_draft_edge_unknown");
      draft.steps[to] = { ...target, consumes: target.consumes!.filter((name) => name !== produces) };
      return;
    }
    case "branch.set":
    case "repeat.set": {
      const id = ref(op.id, "id");
      if (!(CONDITION_OPS as readonly unknown[]).includes(op.test)) fail("graph_draft_argument_invalid", `test: ${CONDITION_OPS.join("|")}`);
      const branch: DraftBranch = { id, after: draft.steps[stepIndex(draft, op.after, "after")].ref, var: str(op.var, "var", 80), test: op.test as DraftBranch["test"] };
      if (op.value !== undefined) {
        if (typeof op.value !== "string" && (typeof op.value !== "number" || !Number.isFinite(op.value))) fail("graph_draft_argument_invalid", "value");
        branch.value = op.value as string | number;
      }
      if (op.op === "branch.set") {
        if (op.yes !== undefined) branch.yes = draft.steps[stepIndex(draft, op.yes, "yes")].ref;
        if (op.no !== undefined) branch.no = draft.steps[stepIndex(draft, op.no, "no")].ref;
        if (!branch.yes && !branch.no) fail("graph_draft_argument_invalid", "yes or no");
      } else {
        const back = stepIndex(draft, op.repeat, "repeat");
        if (back > stepIndex(draft, op.after, "after")) fail("graph_draft_repeat_forward", "repeat goes back to an earlier (or the same) step");
        if (op.repeatOn !== "yes" && op.repeatOn !== "no") fail("graph_draft_argument_invalid", "repeatOn");
        if (!Number.isInteger(op.maxRepeats) || (op.maxRepeats as number) < 1 || (op.maxRepeats as number) > 20) fail("graph_draft_argument_invalid", "maxRepeats 1-20");
        Object.assign(branch, { repeat: draft.steps[back].ref, repeatOn: op.repeatOn, maxRepeats: op.maxRepeats });
      }
      draft.branches = [...draft.branches.filter((b) => b.id !== id), branch];
      return;
    }
    case "branch.remove": {
      const id = ref(op.id, "id");
      if (!draft.branches.some((b) => b.id === id)) fail("graph_draft_ref_unknown", id);
      draft.branches = draft.branches.filter((b) => b.id !== id);
      return;
    }
    case "check.add": {
      const id = ref(op.id, "id");
      if (draft.checks.some((c) => c.id === id)) fail("graph_draft_ref_exists", id);
      const check: DraftCheck = { id, after: draft.steps[stepIndex(draft, op.after, "after")].ref, subject: str(op.subject, "subject", 80), criteria: str(op.criteria, "criteria", 4000) };
      if (op.items !== undefined) {
        if (!Array.isArray(op.items) || op.items.some((item) => !item || typeof item !== "object" || typeof (item as { text?: unknown }).text !== "string"
          || !["must", "mustNot"].includes((item as { kind?: unknown }).kind as string))) fail("graph_draft_argument_invalid", "items");
        check.items = op.items as DraftCheck["items"];
      }
      if (op.produces !== undefined) check.produces = str(op.produces, "produces", 80);
      if (op.evidence !== undefined) check.evidence = str(op.evidence, "evidence", 80);
      draft.checks = [...draft.checks, check];
      return;
    }
    case "check.remove": {
      const id = ref(op.id, "id");
      if (!draft.checks.some((c) => c.id === id)) fail("graph_draft_ref_unknown", id);
      draft.checks = draft.checks.filter((c) => c.id !== id);
      return;
    }
    default: {
      const near = didYouMean(String(op.op), GRAPH_DRAFT_OPERATIONS);
      return fail("graph_draft_operation_unknown", `${String(op.op)}${near ? `.${near}` : ""}`);
    }
  }
}

/** The blueprint one_graph_save receives: refs resolved to the current step positions. */
export function draftBlueprint(draft: GraphDraft): GraphBlueprint {
  const index = new Map(draft.steps.map((step, i) => [step.ref, i]));
  const at = (stepRef: string | undefined): number | undefined => stepRef === undefined ? undefined : index.get(stepRef);
  const blueprint: GraphBlueprint = {
    schema: BLUEPRINT_SCHEMA,
    name: draft.name ?? "",
    goal: draft.goal ?? "",
    trigger: draft.trigger ?? { kind: "input", label: "", varName: "" },
    steps: draft.steps.map(({ ref: _ref, ...step }) => step as BlueprintStep),
  };
  if (draft.branches.length) blueprint.branches = draft.branches.map((b) => ({ afterStep: at(b.after)!, var: b.var, op: b.test,
    ...(b.value !== undefined ? { value: b.value } : {}), ...(b.yes ? { yesStep: at(b.yes) } : {}), ...(b.no ? { noStep: at(b.no) } : {}),
    ...(b.repeat ? { repeatStep: at(b.repeat), repeatOn: b.repeatOn, maxRepeats: b.maxRepeats } : {}) }));
  if (draft.checks.length) blueprint.checks = draft.checks.map(({ id: _id, after, ...rest }) => ({ afterStep: at(after)!, ...rest }));
  return blueprint;
}

function view(draft: GraphDraft): Record<string, unknown> {
  return {
    draftId: draft.draftId, draftRevision: draft.revision, base: draft.base, committed: draft.committed ?? null,
    name: draft.name ?? null, goal: draft.goal ?? null, trigger: draft.trigger ?? null,
    steps: draft.steps.map((step, i) => ({ position: i, ref: step.ref, title: step.title, kind: step.kind ?? "agent", effect: step.effect, produces: step.produces ?? null, consumes: step.consumes ?? [] })),
    branches: draft.branches, checks: draft.checks.map(({ id, after, subject, criteria }) => ({ id, after, subject, criteria })),
  };
}

export function createGraphDraftService(host: GraphDraftHost) {
  const owned = (caller: OneTeamCaller): string => host.ownerChatId(caller);

  async function create(caller: OneTeamCaller, args: Record<string, unknown>) {
    const ownerChatId = owned(caller);
    pruneDrafts(ownerChatId);
    const at = now();
    const binding = caller as OneTeamCaller & GraphOriginBinding;
    const originRunId = binding.supervisorReplyRunId ?? binding.personalSource?.runId ?? binding.historySource?.runId;
    const draft: GraphDraft = { schemaVersion: GRAPH_DRAFT_SCHEMA, draftId: randomUUID(), ownerChatId, originRunId: typeof originRunId === "string" && originRunId ? originRunId : null, base: null, revision: 1, createdAt: at, updatedAt: at,
      steps: [], branches: [], checks: [], requests: {} };
    if (args.graphId !== undefined || args.expectedRevision !== undefined) {
      const graphId = str(args.graphId, "graphId", 128);
      const expectedRevision = str(args.expectedRevision, "expectedRevision", 64);
      if (!/^[a-f0-9]{64}$/.test(expectedRevision)) fail("graph_draft_argument_invalid", "expectedRevision");
      draft.base = { graphId, expectedRevision };
    }
    if (args.blueprint !== undefined) seedFromBlueprint(draft, args.blueprint as GraphBlueprint);
    if (args.name !== undefined) draft.name = str(args.name, "name", 160);
    if (args.goal !== undefined) draft.goal = str(args.goal, "goal", 4000);
    writeDraft(draft);
    return view(draft);
  }

  function read(caller: OneTeamCaller, args: Record<string, unknown>) {
    const draft = readDraft(str(args.draftId, "draftId", 64), owned(caller));
    return { ...view(draft), ...(args.includeBlueprint === true ? { blueprint: draftBlueprint(draft) } : {}) };
  }

  async function apply(caller: OneTeamCaller, args: Record<string, unknown>) {
    const draft = readDraft(str(args.draftId, "draftId", 64), owned(caller));
    const operations = args.operations;
    if (!Array.isArray(operations) || !operations.length || operations.length > 64) fail("graph_draft_argument_invalid", "operations: 1-64");
    const requestId = optStr(args.requestId, "requestId", 128);
    const opsDigest = digest(operations);
    if (requestId && draft.requests[requestId]) {
      if (draft.requests[requestId].digest !== opsDigest) fail("graph_draft_request_id_reused");
      return draft.requests[requestId].result;
    }
    if (args.expectedDraftRevision !== undefined && args.expectedDraftRevision !== draft.revision) fail("graph_draft_revision_conflict", `current ${draft.revision}`);
    const next: GraphDraft = JSON.parse(JSON.stringify(draft));
    for (let i = 0; i < (operations as unknown[]).length; i++) {
      const op = (operations as unknown[])[i];
      if (!op || typeof op !== "object" || Array.isArray(op)) fail("graph_draft_argument_invalid", `operations[${i}]`);
      try { applyOne(next, op as Record<string, unknown>); }
      catch (error) {
        if (error instanceof GraphDraftError) throw new GraphDraftError(error.code, `operations[${i}] ${String((op as { op?: unknown }).op)}: ${error.detail ?? ""}`.trim());
        throw error;
      }
    }
    next.revision = draft.revision + 1;
    next.updatedAt = now();
    const result = { ok: true, ...view(next), applied: (operations as unknown[]).length };
    if (requestId) next.requests[requestId] = { digest: opsDigest, result };
    writeDraft(next);
    return result;
  }

  async function validate(caller: OneTeamCaller, args: Record<string, unknown>) {
    const draft = readDraft(str(args.draftId, "draftId", 64), owned(caller));
    const verdict = await host.validate(caller, draftBlueprint(draft), draft.base?.graphId ?? null);
    return { ...verdict, draftRevision: draft.revision, positions: draft.steps.map((step, i) => ({ position: i, ref: step.ref })) };
  }

  async function commit(caller: OneTeamCaller, args: Record<string, unknown>) {
    const draft = readDraft(str(args.draftId, "draftId", 64), owned(caller));
    const requestId = str(args.requestId, "requestId", 128);
    const key = `commit:${requestId}`;
    const commitDigest = digest({ revision: draft.revision, enabled: args.enabled ?? null });
    if (draft.requests[key]) {
      if (draft.requests[key].digest !== commitDigest) fail("graph_draft_request_id_reused");
      return draft.requests[key].result;
    }
    if (args.expectedDraftRevision !== undefined && args.expectedDraftRevision !== draft.revision) fail("graph_draft_revision_conflict", `current ${draft.revision}`);
    const input: Record<string, unknown> = { blueprint: draftBlueprint(draft) };
    if (draft.base) { input.graph_id = draft.base.graphId; input.expected_revision = draft.base.expectedRevision; }
    if (args.enabled === false) input.enabled = false;
    // Keep current scope/permission; only origin resolution uses the draft creation run.
    const originCaller = { ...caller, draftOriginRunId: typeof draft.originRunId === "string" && draft.originRunId ? draft.originRunId : null };
    const result = await host.save(originCaller, input) as { ok?: boolean; graph_id?: string; definition_revision?: string } | null;
    // A saved graph becomes the base of the next commit, so further edits replace it under its new revision.
    const graphId = result && typeof result.graph_id === "string" ? result.graph_id : null;
    const revision = result && typeof result.definition_revision === "string" ? result.definition_revision : null;
    const latest = readDraft(draft.draftId, draft.ownerChatId);
    if (result?.ok === true && graphId && revision) {
      latest.base = { graphId, expectedRevision: revision };
      latest.committed = { graphId, revision, at: now() };
    }
    latest.requests[key] = { digest: commitDigest, result };
    latest.updatedAt = now();
    writeDraft(latest);
    return result;
  }

  function discard(caller: OneTeamCaller, args: Record<string, unknown>) {
    const draft = readDraft(str(args.draftId, "draftId", 64), owned(caller));
    fs.rmSync(draftFile(draft.draftId), { force: true });
    return { ok: true, draftId: draft.draftId, discarded: true };
  }

  return { create, read, apply, validate, commit, discard };
}
