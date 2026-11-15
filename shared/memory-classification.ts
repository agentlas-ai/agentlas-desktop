// Write-time classification of one curated memory proposal (Agentlas 2.0 §12). Desktop half of the engine's
// `agentlas_cloud/memory_classify.py`: the same ruleset file (`curator-ruleset.json` `stores`, `classification`, `limits`), the same memory contract
// (`actorKind`, `personalSet`) and the same shared vectors (`Agentlas-OS/contracts/test-vectors/memory-classification-vectors.json`) — one input, one answer.
//
// Pure: no database, no model, no disk, no Electron. The caller passes the ruleset object. A ruleset without a usable `stores` block switches the rules
// off (`activeClassificationRules` returns null) and the caller behaves as it did before. Nothing here adds a kind, a scope, a column or a table.
//
// Two stages. `classifyStage1` decides the scope and kind a proposal ends up with: the model's answer is corrected by code and never asked again, except a
// too-long Personal line (`askAgain`; the desktop has no second ask once a turn is over, so its sink keeps such a line out of Personal and writes nothing —
// no format reason kills a turn). `classifyStage2` is what the writer decides at write time: a forgotten text, a replacement, a full store.
import { PERSONAL_SET, memoryActorKind, type MemoryActorKind } from "./memory-ownership";
import { isOneMemoryActor } from "./memory-actor-family";

export const CLASSIFICATION_STORE_SCOPES = ["user_identity", "agent_repo", "project"] as const;
export type ClassificationStoreScope = (typeof CLASSIFICATION_STORE_SCOPES)[number];
export type HomeState = "home" | "away" | "sealed";
export const HOME_STATES: readonly HomeState[] = ["home", "away", "sealed"];
export const DEFAULT_HOME_STATE_KEY = "one_home_state";
const FULL_REASON_FALLBACK = "store_" + "full";
const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

type Json = Record<string, unknown>;
export interface ClassificationRules { [key: string]: unknown }

const record = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
const posInt = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null);

/** The whole ruleset when its `stores` block is usable, else null (the rules are then off). */
export function activeClassificationRules(rs: unknown): ClassificationRules | null {
  const root = record(rs);
  const stores = record(root?.stores);
  if (!root || !stores) return null;
  for (const scope of CLASSIFICATION_STORE_SCOPES) {
    const block = record(stores[scope]);
    if (!block || !Array.isArray(block.acceptedKinds)) return null;
  }
  if (!record(record(stores.user_identity)?.admission)) return null;
  return root;
}

const storesOf = (rs: ClassificationRules): Json => rs.stores as Json;
const block = (rs: ClassificationRules, scope: string): Json => (record(storesOf(rs)[scope]) ?? {});
const isStoreScope = (scope: string): scope is ClassificationStoreScope => (CLASSIFICATION_STORE_SCOPES as readonly string[]).includes(scope);

/** The plain kind-to-kind corrections of one store (an entry that is not a string is a conditional rule). */
export function kindRemapTable(rs: ClassificationRules, scope: string): Record<string, string> {
  const table = record(block(rs, scope).kindRemap);
  if (!table) return {};
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(table)) if (typeof to === "string") out[from] = to;
  return out;
}

export function acceptedKindsOf(rs: ClassificationRules, scope: string): string[] { return strings(block(rs, scope).acceptedKinds); }

/** How a STORED line reads (stored lines are never rewritten): a Personal line that is not a fact reads as a preference; elsewhere the store's own correction applies. */
export function readKind(rs: ClassificationRules, scope: string, kind: string): string {
  if (scope === "user_identity") return kind === "fact" ? "fact" : "preference";
  return isStoreScope(scope) ? kindRemapTable(rs, scope)[kind] ?? kind : kind;
}

/**
 * Who may read the owner's Personal lines (`user_identity` scope) - the ONE definition of the condition (Agentlas 2.0 P2; port of `memory_classify.reads_personal`, both answer the
 * shared vectors `personalRead`). `rulesOn` is the workspace-rules switch (`workspaceRulesOn()`), `personalRead` the host's word that this turn is the personal agent's own conversation
 * (`AGENTLAS_MEMORY_PERSONAL_READ=1` for an executor the engine serves; the desktop's own conversation test for its own turns).
 *
 * Switch OFF (what every earlier build answered): a Personal FACT is the personal agent's (the One family) while the ruleset says `readers.fact = one-family-only`; a Personal line that is
 * not a fact reads as a preference and every subject reads it. Switch ON (`readers.preferenceAfterWorkspaceRules = one-family-only`, also when the file has no such key): the answer is for
 * EVERY Personal line, a preference included: only the One family AND `personalRead`. A line outside Personal is never held back. Without a usable ruleset (`rs` null: an older or damaged
 * copy) nobody is held back, as before.
 */
export function personalReadable(rs: ClassificationRules | null, scope: unknown, kind: unknown, actorId: string | null | undefined,
  options: { rulesOn?: boolean; personalRead?: boolean } = {}): boolean {
  if (scope !== "user_identity" || !rs) return true;
  const readers = record(block(rs, "user_identity").readers);
  const narrowed = options.rulesOn === true && (readers?.preferenceAfterWorkspaceRules ?? "one-family-only") === "one-family-only";
  if (narrowed) return isOneMemoryActor(actorId) && options.personalRead === true;
  if (kind !== "fact") return true;
  return (readers?.fact ?? "one-family-only") !== "one-family-only" ? true : isOneMemoryActor(actorId);
}

/**
 * The older name for the Personal FACT condition, kept one release as a thin alias: the switch off. Without a usable ruleset (`rs` null) nobody is held back. A Personal line that is
 * not a fact reads as a preference and every subject reads it; no other scope or kind is touched. Both answer the same shared vectors (`personalFactRead`).
 */
export function personalFactReadable(rs: ClassificationRules | null, actorId: string | null | undefined): boolean {
  return personalReadable(rs, "user_identity", "fact", actorId);
}

/** The same condition for one stored line (`scope` and `kind`), the switch off: anything but a Personal fact is readable by every subject. Alias, see `personalReadable`. */
export function personalLineReadable(rs: ClassificationRules | null, scope: unknown, kind: unknown, actorId: string | null | undefined): boolean {
  return personalReadable(rs, scope, kind, actorId);
}

/** Every stored kind that the corrected `kind` stands for in `scope`: the duplicate check and the forget stamp follow the corrected kind (a text forgotten as a decision does not come back as a preference). */
export function equivalentKinds(rs: ClassificationRules | null, scope: string, kind: string): string[] {
  if (!rs || !isStoreScope(scope)) return [kind];
  const table = kindRemapTable(rs, scope);
  return [...new Set([kind, ...Object.entries(table).filter(([, to]) => to === kind).map(([from]) => from)])].sort();
}

export function fullReasonOf(rs: ClassificationRules | null): string {
  const value = rs ? record(storesOf(rs).ceiling)?.reason : null;
  return typeof value === "string" && /^[a-z0-9_]{1,40}$/.test(value) ? value : FULL_REASON_FALLBACK;
}

export function mergeOverlapMin(rs: ClassificationRules | null): number {
  const value = record(rs?.limits)?.mergeTokenOverlapMin;
  return typeof value === "number" && Number.isFinite(value) ? value : 0.6;
}

/**
 * The share of the SHORTER text's scoring tokens that the other text contains, at or above which a line the model NAMED (one id: revise, supersede) is replaced
 * (`stores.replacement.namedContainmentMin`; (b): "Deploy on Friday." -> "Deploy on Tuesday." is a correction, and it shares only half of the words under the Jaccard measure).
 * 0.5 when the ruleset has none.
 */
export function namedContainmentMin(rs: ClassificationRules | null): number {
  const value = record(record(rs?.stores)?.replacement)?.namedContainmentMin;
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.5;
}

/**
 * The ceiling of the store a scope writes into for this kind of actor: a resident actor's own agent store has `stores.agent_repo.residentActorCeilingRows`
 * (the personal agent's working knowledge on this computer, #1), every other actor and store has `ceilingRows`.
 */
export function ceilingOf(rs: ClassificationRules | null, scope: string, actorKind?: string): number | null {
  if (!rs || !isStoreScope(scope)) return null;
  if (scope === "agent_repo" && actorKind === "resident") {
    const resident = posInt(block(rs, scope).residentActorCeilingRows);
    if (resident !== null) return resident;
  }
  return posInt(block(rs, scope).ceilingRows);
}

/** `stores.ceiling.countsFrom`: only lines written on or after this instant are counted against a ceiling (a store that was already large before the rules began is not "full"). null = every live line counts. */
export function ceilingCountsFrom(rs: ClassificationRules | null): string | null {
  const value = rs ? record(storesOf(rs).ceiling)?.countsFrom : null;
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(value) ? value : null;
}

/** How the forget stamp compares words (`stores.forget`): whether it ignores the kind, and the closing marks that make `x.`, `x!` and `x` the same text. A ruleset without the block keeps the exact-kind, exact-words stamp. */
export function forgetRules(rs: ClassificationRules | null): { kindBlind: boolean; trailingChars: string } {
  const forget = rs ? record(storesOf(rs).forget) : null;
  const chars = typeof forget?.trailingChars === "string" ? Array.from(forget.trailingChars).join("") : "";
  return { kindBlind: forget?.kindBlind === true, trailingChars: chars };
}

/** The key two texts share when they are the same words for the forget stamp: NFKC, runs of space as one, lower case, then ONE trailing character of `trailingChars` removed. */
export function forgetKey(rs: ClassificationRules | null, text: string): string {
  const normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  const { trailingChars } = forgetRules(rs);
  const last = Array.from(normalized).pop();
  return last !== undefined && trailingChars && trailingChars.includes(last) ? normalized.slice(0, normalized.length - last.length) : normalized;
}

export function maxCharsOf(rs: ClassificationRules, scope: string): number | null { return posInt(block(rs, scope).maxChars); }

/** Length the way the engine counts it (code points, not UTF-16 units: an emoji is one character). */
export const charCount = (text: string): number => Array.from(text).length;

function patternOf(rs: ClassificationRules, name: string): RegExp | null {
  const spec = record(record(rs.patterns)?.[name]);
  if (!spec || typeof spec.regex !== "string") return null;
  const flags = typeof spec.flags === "string" ? spec.flags.replace(/[^imsu]/g, "") : "";
  try { return new RegExp(spec.regex, flags); } catch { return null; }
}

export function homeStateKeyOf(rs: ClassificationRules | null): string {
  const value = rs ? record(record(block(rs, "user_identity").admission))?.homeStateMetaKey : null;
  return typeof value === "string" && /^[a-z][a-z0-9_]{2,63}$/.test(value) ? value : DEFAULT_HOME_STATE_KEY;
}

/** A missing key or a value this build does not know is `home`: a reader that cannot tell never blocks a write. */
export function homeStateOf(value: unknown): HomeState {
  return typeof value === "string" && (HOME_STATES as readonly string[]).includes(value) ? value as HomeState : "home";
}

const RULES_STATE_KEY = "workspace_rules_state";
const PERSONAL_READ_ENV = "AGENTLAS_MEMORY_PERSONAL_READ";
/** `workspaceRules.stateMetaKey`: the root `memory_store_meta` key whose value `on` switches the workspace rules on (nothing else does). */
export function workspaceRulesStateKey(rs: ClassificationRules | null): string {
  const value = record(rs?.workspaceRules)?.stateMetaKey;
  return typeof value === "string" && /^[a-z][a-z0-9_]{2,63}$/.test(value) ? value : RULES_STATE_KEY;
}
/** `workspaceRules.personalReadEnv`: the environment variable (exactly `1`) by which the host tells an executor it serves the personal agent's own conversation. */
export function personalReadEnvName(rs: ClassificationRules | null): string {
  const value = record(rs?.workspaceRules)?.personalReadEnv;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(value) ? value : PERSONAL_READ_ENV;
}
/** The value of the switch row: only exactly `on` is on; a missing row or any other value is off. */
export function workspaceRulesValueOn(value: unknown): boolean { return value === "on"; }
export interface WorkspaceRulesLimits { loadMaxBytes: number; smallWindowMaxBytes: number; readMaxBytes: number; candidateLineMaxChars: number; candidateMaxLines: number }
/** `workspaceRules` numbers (a missing or damaged block falls back to the file's own 1.7.0 values). */
export function workspaceRulesLimits(rs: ClassificationRules | null): WorkspaceRulesLimits {
  const block = record(rs?.workspaceRules);
  const pick = (key: keyof WorkspaceRulesLimits, fallback: number): number => posInt(block?.[key]) ?? fallback;
  return { loadMaxBytes: pick("loadMaxBytes", 4096), smallWindowMaxBytes: pick("smallWindowMaxBytes", 1024), readMaxBytes: pick("readMaxBytes", 65536),
    candidateLineMaxChars: pick("candidateLineMaxChars", 200), candidateMaxLines: pick("candidateMaxLines", 30) };
}

export interface Stage1Input {
  scope: string;
  kind: string;
  confidence: string | null | undefined;
  text: string;
  surface: "desktop" | "engine-hook";
  /** A project is bound. */
  project: boolean;
  /** The binding came from an enclosing project root (engine: the hook's `in_project`; desktop: the same as `project`). null/undefined = unknown = false. */
  inProject?: boolean | null;
  actorKind: MemoryActorKind;
  /** The turn was started by a message the owner wrote. null = unknown (the engine hook; it does not require it). */
  ownerSpoke?: boolean | null;
  homeState?: HomeState | string | (() => HomeState | string);
  /** The workspace-rules switch (a bool, or a function asked at most once and only when the answer can differ). Off (the default): nothing below changes and the answer carries no `instruction`. */
  rulesOn?: boolean | (() => boolean);
  /** This turn is the personal agent's own conversation (the host decides: `isPersonalAgentConversation`). null/undefined = not known = no. The engine hook is never one. */
  personalConversation?: boolean | null;
}

/** The scope and kind a proposal ends up with, in the vector `expect` forms. */
export type Stage1Outcome =
  | { scope: string; kind: string; instruction?: boolean }
  | { scope: "session" }
  | { discard: true }
  | { askAgain: true }
  | { write: false; modelCall: false };

/** The confidence the ruleset's Personal admission compares against (`user_identity.admission.minConfidence`), or null when the ruleset has none. Additive: a caller that no longer wants the model's confidence to decide passes this value through. */
export function personalMinConfidence(rs: ClassificationRules): string | null {
  const admission = record(block(rs, "user_identity").admission);
  return admission && typeof admission.minConfidence === "string" ? admission.minConfidence : null;
}

export function classifyStage1(rs: ClassificationRules, input: Stage1Input): Stage1Outcome {
  const stores = storesOf(rs);
  if (input.actorKind === "hub") return { write: false, modelCall: false };
  // The original proposal's scope was Personal or its kind a preference: the host marks the line it writes (`origin:instruction`) so it never counts towards a skill. Answered only with the switch on.
  const instruction = input.scope === "user_identity" || input.kind === "preference";
  let switchValue: boolean | null = null;
  const on = (): boolean => {
    if (switchValue === null) switchValue = typeof input.rulesOn === "function" ? input.rulesOn() === true : input.rulesOn === true;
    return switchValue;
  };
  const secret = patternOf(rs, "secretValueShapes");
  if (secret && secret.test(input.text)) return { discard: true };
  let scope = input.scope;
  let kind = input.kind;
  const residentKinds = PERSONAL_SET.residentActorKinds;
  if (scope === "agent_repo") {
    const rule = record(stores.agent_repo)?.kindRemap ? (record(record(stores.agent_repo)!.kindRemap)![kind]) : undefined;
    const conditional = record(rule);
    if (conditional) { // the conditional correction: a preference from an agent_repo proposal
      if (residentKinds.includes(kind)) {
        if (input.actorKind === "resident") scope = "user_identity";
        else if (typeof conditional.folderAgent === "string") kind = conditional.folderAgent;
      }
    } else if (typeof rule === "string") kind = rule;
  } else if (scope === "user_identity" || scope === "project") {
    kind = kindRemapTable(rs, scope)[kind] ?? kind;
  }
  if (isStoreScope(scope) && !acceptedKindsOf(rs, scope).includes(kind)) return { scope: "session" };
  if (scope === "user_identity") {
    // Switch on: a Personal line is only written from the personal agent's own conversation. An instruction from any other conversation becomes the folder agent's or a special agent's
    // agent_repo procedure, a resident actor's project decision inside a project, and otherwise is not stored; a Personal fact from any other conversation is not stored.
    // An instruction from a turn the owner did not type is not stored at all (`ownerSpoke` not true, on a side that requires it).
    const admission = record(block(rs, "user_identity").admission)!;
    const side = record(admission[input.surface === "desktop" ? "desktop" : "engineHook"]);
    if (side && !(input.surface === "desktop" && input.personalConversation === true)) {
      const needs = input.surface === "desktop"
        ? (typeof side.requiresPersonalConversationAfterWorkspaceRules === "boolean" ? side.requiresPersonalConversationAfterWorkspaceRules : true)
        : !strings(side.kindsAfterWorkspaceRules).includes(kind);
      if (needs && on()) {
        if (kind !== "preference") return { scope: "session" };
        // A turn the owner did not type (a group member, an @ chain, a peer message, an automation) stores no instruction, exactly as with the switch off (W1; the same line as the engine's `stage1`).
        if (side.requiresOwnerSpoke && input.ownerSpoke !== true) return { scope: "session" };
        if (input.actorKind === "folderAgent" || input.actorKind === "special") { scope = "agent_repo"; kind = "procedure"; }
        else if (input.actorKind === "resident" && input.inProject === true) { scope = "project"; kind = "decision"; }
        else return { scope: "session" };
      }
    }
  }
  if (scope === "user_identity") {
    const admission = record(block(rs, "user_identity").admission)!;
    const side = record(admission[input.surface === "desktop" ? "desktop" : "engineHook"]);
    if (!side) return { scope: "session" };
    if (input.confidence !== admission.minConfidence || !strings(side.kinds).includes(kind)) return { scope: "session" };
    if (side.requiresOwnerSpoke && input.ownerSpoke !== true) return { scope: "session" };
    const state = homeStateOf(typeof input.homeState === "function" ? input.homeState() : input.homeState);
    const path = patternOf(rs, "hostAbsolutePath");
    if (strings(admission.deniedHomeStates).includes(state) || (path && path.test(input.text))) return { scope: "session" };
    const limit = maxCharsOf(rs, "user_identity");
    if (limit !== null && charCount(input.text) > limit) return { askAgain: true };
  }
  if (scope === "project" && !input.project) return { scope: "session" };
  if (scope === "agent_repo" && input.actorKind === "resident" && input.inProject) scope = "project";
  if (isStoreScope(scope) && on()) return { scope, kind, instruction };
  return { scope, kind };
}

export interface Stage2Input {
  scope: string;
  kind: string;
  /** The offered line's own words (the forget stamp compares them when it carries its text). */
  text?: string;
  /** The owner already forgot this text in this scope: the stamp does not look at the kind (#4); `text` (the stamp's words) is compared when given. */
  forgotten?: { scope?: string; kind?: string; text?: string } | null;
  /** The lines the ceiling COUNTS (live, written on or after `stores.ceiling.countsFrom`, not an overlay line, not disabled). */
  storeRows?: number;
  /** Jaccard overlap of the scoring tokens of the new line and the line it points at (or the lines it merges). */
  similarity?: number | null;
  /** The model named exactly ONE existing line (revise or supersede; a merge of several is not named), and the share of the shorter text's scoring tokens the two share. */
  named?: boolean;
  containment?: number | null;
  target?: { scope?: string; kind?: string } | null;
  actorKind?: MemoryActorKind;
}
export type Stage2Outcome = { scope: string; kind: string; replace?: boolean; instruction?: boolean } | { write: false; reason: string };

/**
 * What the writer decides after stage 1: a forgotten text is not written (the stamp does not look at the kind: a text forgotten as a decision does not come back as a fact or a
 * preference, nor with another ending mark); a line that replaces an older one (the two are similar enough as whole texts, or the model NAMED one line and the shorter of the two texts is
 * contained enough in the other; same scope and same corrected kind) is written even in a full store; any other new line in a full store is refused (`store_full`, not tried again).
 * Code never retires a line to make room.
 */
export function classifyStage2(rs: ClassificationRules, input: Stage2Input): Stage2Outcome {
  const { scope, kind } = input;
  const stamp = input.forgotten;
  if (stamp && stamp.scope === scope) {
    // A ruleset without `stores.forget` keeps the stamp of the corrected kind (an older build's rule); the kind-blind stamp looks at the scope and, when it carries them, the words.
    const sameKind = forgetRules(rs).kindBlind || equivalentKinds(rs, scope, kind).includes(stamp.kind ?? "");
    if (sameKind && (stamp.text === undefined || forgetKey(rs, stamp.text) === forgetKey(rs, input.text ?? ""))) return { write: false, reason: "forgotten" };
  }
  const out: { scope: string; kind: string; replace?: boolean } = { scope, kind };
  let replace: boolean | null = null;
  const similarity = input.similarity ?? null;
  const containment = input.containment ?? null;
  const target = input.target ?? null;
  if (similarity !== null || target !== null || input.named === true) {
    const sameStore = target === null || (target.scope === scope && readKind(rs, scope, target.kind ?? "") === kind);
    const alike = (similarity !== null && similarity >= mergeOverlapMin(rs)) || (input.named === true && containment !== null && containment >= namedContainmentMin(rs));
    replace = sameStore && alike;
    out.replace = replace;
  }
  const ceiling = ceilingOf(rs, scope, input.actorKind);
  if (ceiling !== null && (input.storeRows ?? 0) >= ceiling && !replace) return { write: false, reason: fullReasonOf(rs) };
  return out;
}

/** The reference answer for one code-judged vector case (both stages). The shared vectors call this. */
export interface VectorCase {
  text: string;
  host: { surface: "desktop" | "engine-hook"; project: boolean; inProject?: boolean; actorKind: MemoryActorKind; ownerSpoke?: boolean | null; homeState?: string; rulesOn?: boolean; personalConversation?: boolean | null;
    forgotten?: { scope?: string; kind?: string; text?: string }; storeRows?: number; similarity?: number; named?: boolean; containment?: number; target?: { scope?: string; kind?: string } };
  model: { scope: string; kind: string; confidence?: string };
}
export function classifyVectorCase(rs: ClassificationRules, c: VectorCase): Stage1Outcome | Stage2Outcome {
  const { host, model } = c;
  const project = Boolean(host.project);
  const first = classifyStage1(rs, { scope: model.scope, kind: model.kind, confidence: model.confidence, text: c.text, surface: host.surface, project,
    inProject: host.inProject ?? (host.surface === "desktop" ? project : false), actorKind: host.actorKind, ownerSpoke: host.ownerSpoke ?? null, homeState: host.homeState ?? "home",
    rulesOn: host.rulesOn === true, personalConversation: host.personalConversation ?? null });
  if (!("scope" in first) || first.scope === "session" || !("kind" in first)) return first;
  const second = classifyStage2(rs, { scope: first.scope, kind: first.kind, forgotten: host.forgotten ?? null, storeRows: host.storeRows ?? 0,
    text: c.text, similarity: host.similarity ?? null, named: host.named === true, containment: host.containment ?? null, target: host.target ?? null, actorKind: host.actorKind });
  return "instruction" in first && "scope" in second ? { ...second, instruction: first.instruction } : second;
}

/** Scoring tokens of `_recall_tokens` (engine one_workspace.py): attached punctuation removed, stopwords dropped. */
export function recallTokens(rs: ClassificationRules | null, text: string): Set<string> {
  const stop = new Set(strings(record(record(rs?.recallBudgets)?.one)?.stopwords));
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z가-힣0-9_./-]{2,}/g) ?? []) {
    const token = raw.replace(/^[./_-]+|[./_-]+$/g, "");
    if (token.length >= 2 && !stop.has(token)) tokens.add(token);
  }
  return tokens;
}

/** The share of the shorter text's scoring tokens that the other text contains (`replaceContainmentMin`). */
export function tokenContainment(rules: ClassificationRules | null, left: string, right: string): number {
  const a = recallTokens(rules, left), b = recallTokens(rules, right);
  const shorter = Math.min(a.size, b.size);
  if (!shorter) return 0;
  let both = 0;
  for (const token of a) if (b.has(token)) both += 1;
  return both / shorter;
}

/** Jaccard overlap of the scoring tokens: the engine's measure for "similar enough to replace" (`limits.mergeTokenOverlapMin`). */
export function tokenOverlap(rs: ClassificationRules | null, left: string, right: string): number {
  const a = recallTokens(rs, left), b = recallTokens(rs, right);
  const union = new Set([...a, ...b]);
  if (!union.size) return 0;
  let both = 0;
  for (const token of a) if (b.has(token)) both += 1;
  return both / union.size;
}

/** The lower of two confidence words (an unknown word is the lowest): Personal needs BOTH the emitter's and the reviewing model's confidence to be high. */
export function lowerConfidence(a: string | null | undefined, b: string | null | undefined): string | null {
  const ra = CONFIDENCE_RANK[a ?? ""] ?? 0, rb = CONFIDENCE_RANK[b ?? ""] ?? 0;
  const lowest = Math.min(ra, rb);
  return Object.keys(CONFIDENCE_RANK).find(key => CONFIDENCE_RANK[key] === lowest) ?? null;
}

export interface AlwaysLoadRow { id: string; kind: string; content: string; createdAt: string; /** K2b': the kind a Personal ticket was given before it was folded (identity, boundary); shown in front of the line. */ shownKind?: string; /** K2b': the block key (h:...) the model names in `targets`; shown in front of the line when given. */ blockKey?: string }
export interface AlwaysLoadSpec { kinds: string[]; maxLineChars: number; maxBytes: number }

/** `stores.user_identity.alwaysLoad`, or null when the ruleset has none (the always-loaded Personal piece is then off). */
export function alwaysLoadSpec(rs: ClassificationRules | null): AlwaysLoadSpec | null {
  if (!rs || !activeClassificationRules(rs)) return null;
  const spec = record(block(rs, "user_identity").alwaysLoad);
  const maxBytes = posInt(spec?.maxBytes), maxLineChars = posInt(spec?.maxLineChars);
  if (!spec || maxBytes === null || maxLineChars === null) return null;
  const kinds = strings(spec.kinds);
  return { kinds: kinds.length ? kinds : ["preference"], maxLineChars, maxBytes };
}

/**
 * The Personal lines that are always loaded (§12-6): a live `user_identity` line whose kind reads as one of `alwaysLoad.kinds` (a stored
 * decision/procedure/risk reads as preference) and that is at most `maxLineChars` long. Newest first until `maxBytes` (a line that does not fit is skipped and a
 * later, shorter one may still fit), then written in id order so the same lines give the same text every turn.
 */
export function pickAlwaysLoad<T extends AlwaysLoadRow>(rows: readonly T[], rs: ClassificationRules | null): T[] {
  const spec = alwaysLoadSpec(rs);
  if (!spec || !rs) return [];
  const newest = [...rows].sort((x, y) => (x.createdAt === y.createdAt ? (x.id < y.id ? 1 : -1) : x.createdAt < y.createdAt ? 1 : -1));
  const picked: T[] = [];
  let used = 0;
  for (const row of newest) {
    const text = row.content.trim();
    if (!text || charCount(text) > spec.maxLineChars || !spec.kinds.includes(readKind(rs, "user_identity", row.kind))) continue;
    const bytes = Buffer.byteLength(text, "utf8");
    if (used + bytes > spec.maxBytes) continue;
    picked.push(row);
    used += bytes;
  }
  return picked.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/** The text of the always-loaded piece: one line per picked row, nothing else. Empty when nothing is picked. */
export function renderAlwaysLoad(rows: readonly AlwaysLoadRow[]): string {
  if (!rows.length) return "";
  return ["## Owner preferences (standing instructions)", ...rows.map(row => `- ${row.blockKey ? `[${row.blockKey} · ${row.shownKind ?? row.kind}] ` : ""}${row.content.trim()}`)].join("\n");
}

export { memoryActorKind };
