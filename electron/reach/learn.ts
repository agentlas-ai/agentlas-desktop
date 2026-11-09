import { createHash } from "node:crypto";
import { cleanLabel, type ElementRecord } from "./dialog-probe";
import { isSensitiveApp } from "./explore-policy";
import type { CapabilityRegistry } from "./registry";
import type { Capability, CapabilityParameter, Postcondition } from "./types";

// Reach learns from the screen work an agent already did.
//
//   no port yet -> the agent works the app's screen (Cua)  -> the work is recorded as a trace
//   trace       -> induced into a typed capability (candidate) -> a second matching trace, or one proven replay, makes it verified
//   verified    -> served as a port: reach.invoke replays it, and the replay itself is the next proof
//   app updated -> the replay looks for the same control by role, caption and neighbours (heal) instead of failing; a heal is written back
//                  only after the run's outcome check held
//   cannot heal -> NOT an error: the caller is handed back to the screen with the old steps as hints; the new trace replaces the old steps
//
// What is kept is the shape of the work (roles, captions, neighbours, which text slots), never what was typed or read. Text the agent typed becomes a
// parameter. A trace that touches a password field, a card number, a sensitive app, or does not end in a success the caller vouched for, is refused.
// No Electron import: the daemon and the terminal engine load this.

export const LEARNED_TRAIT = "learned";
export const RISKY_STEP_TRAIT = "risky-step";
export const LEARN_MAX_STEPS = 40;
export const HEAL_MIN_SCORE = 0.72;
export const HEAL_MIN_MARGIN = 0.15;

export const isLearned = (capability: Pick<Capability, "traits">): boolean => capability.traits?.includes(LEARNED_TRAIT) === true;

// ---- shapes --------------------------------------------------------------------------------------------------------------------------

export interface LearnElement { index: number; role: string; label?: string; value?: string; parent?: number; enabled?: boolean }

export interface TargetDescriptor {
  role: string;
  label?: string;
  // the captions around it: ancestors (innermost first, at most 3) and siblings (at most 6). Used only to tell look-alikes apart after an update.
  path?: string[];
  nearby?: string[];
  nth?: number;
}

export type TraceOp = "click" | "type" | "set_value" | "key";
export interface TraceStep { op: TraceOp; target?: TargetDescriptor; text?: string; key?: string; ok: boolean }

export interface OutcomeCheck {
  kind: "element-present" | "element-value-changed";
  role: string;
  label: string;
}

export interface LearnTrace {
  app: { key: string; name: string; bundleId?: string; fingerprint: string };
  // A short verb phrase the caller names the work with ("add two numbers"); the capability's identity.
  name: string;
  description?: string;
  steps: TraceStep[];
  // The caller vouches that the work succeeded AND says how a later run can tell. Without both nothing is learned as proven.
  succeeded: boolean;
  check?: OutcomeCheck;
  // The recorder read the screen before the work: true when the check already held then. Such a check proves nothing (the screen looked the same before and after).
  checkHeldBefore?: boolean;
  day: string;
}

export interface LearnAction {
  kind: "click" | "type" | "set_value" | "key";
  element?: LearnElement;
  text?: string;
  key?: string;
}

export interface LearnDriver {
  snapshot(): Promise<LearnElement[] | null>;
  act(action: LearnAction): Promise<{ ok: boolean; code?: string }>;
}

// ---- small helpers ---------------------------------------------------------------------------------------------------------------------

export function norm(label: string | null | undefined): string {
  return (label ?? "").normalize("NFKC").toLowerCase().replace(/[…]|\.{3}/g, "").replace(/&/g, "").replace(/\s+/g, " ").trim();
}

function trigrams(text: string): Set<string> {
  const padded = `  ${text} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

export function labelSimilarity(a: string | undefined, b: string | undefined): number {
  const x = norm(a); const y = norm(b);
  if (x === y) return x === "" ? 0.5 : 1;
  if (x === "" || y === "") return 0;
  // a one- or two-character caption (7, +, OK) is either the same or a different control
  if (x.length <= 2 || y.length <= 2) return 0;
  const shorter = x.length <= y.length ? x : y; const longer = shorter === x ? y : x;
  if (shorter.length >= 3 && longer.includes(shorter)) return 0.6 + 0.3 * (shorter.length / longer.length);
  const A = trigrams(x); const B = trigrams(y);
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / (A.size + B.size - hit);
}

function overlap(a: readonly string[] | undefined, b: readonly string[] | undefined): number {
  const A = new Set((a ?? []).map(norm).filter(Boolean)); const B = new Set((b ?? []).map(norm).filter(Boolean));
  if (A.size === 0 && B.size === 0) return 0.5;
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0;
  for (const item of A) if (B.has(item)) hit += 1;
  return hit / (A.size + B.size - hit);
}

// Words on a control that mean "this cannot be taken back / this sends something out". A control like that is never healed to a look-alike.
const RISKY_LABEL = /\b(delete|erase|remove|send|submit|pay|purchase|buy|order|sign ?out|log ?out|empty trash|format|reset|uninstall|publish|transfer)\b|삭제|지우|제거|보내기|전송|결제|구매|주문|초기화|로그아웃|게시|송금|発送|削除|送信|支払|购买|删除|发送/i;
const SECRET_LABEL = /pass(word|code|phrase)|secret|cvv|cvc|security code|card number|ssn|social security|pin\b|비밀번호|암호|카드 ?번호|인증번호|보안 ?코드|パスワード|密码|密碼/i;
const SECRET_ROLE = /secure|password/i;

export const isRiskyLabel = (label: string | undefined): boolean => !!label && RISKY_LABEL.test(label);

// A screen snapshot as the engine reads it: the driver's records with their toolkit noise taken off the captions.
export function toLearnElements(records: readonly ElementRecord[]): LearnElement[] {
  return records.map((record) => {
    const label = cleanLabel(record.label ?? undefined);
    const value = typeof record.value === "string" && record.value.length <= 200 ? record.value : undefined;
    return {
      index: record.element_index,
      role: record.role ?? "",
      ...(label !== undefined ? { label } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(record.parent_index !== undefined ? { parent: record.parent_index } : {}),
      ...(record.enabled !== undefined && record.enabled !== null ? { enabled: record.enabled } : {}),
    };
  });
}

export function describeElement(elements: readonly LearnElement[], index: number): TargetDescriptor | null {
  const byIndex = new Map(elements.map((element) => [element.index, element]));
  const element = byIndex.get(index);
  if (!element || !element.role) return null;
  const path: string[] = [];
  let parent = element.parent === undefined ? undefined : byIndex.get(element.parent);
  for (let hops = 0; parent && hops < 12 && path.length < 3; hops += 1) {
    if (parent.label) path.push(parent.label);
    parent = parent.parent === undefined ? undefined : byIndex.get(parent.parent);
  }
  const siblings = elements.filter((other) => other.index !== element.index && other.parent === element.parent && other.label).slice(0, 6).map((other) => other.label as string);
  // the same role and caption more than once: which of them, counted in tree order
  let nth = 0;
  for (const other of elements) {
    if (other.index === element.index) break;
    if (other.role === element.role && norm(other.label) === norm(element.label)) nth += 1;
  }
  return { role: element.role, ...(element.label ? { label: element.label } : {}), ...(path.length ? { path } : {}), ...(siblings.length ? { nearby: siblings } : {}), ...(nth > 0 ? { nth } : {}) };
}

// ---- finding a control: exact first, healed second, never a guess ----------------------------------------------------------------------

export type Located =
  | { status: "exact"; element: LearnElement; score: 1 }
  | { status: "healed"; element: LearnElement; score: number; from: TargetDescriptor; to: TargetDescriptor }
  | { status: "ambiguous" }
  | { status: "missing" };

// A symbol that became a word (= -> Equals, + -> Add, gear -> Settings) has no caption in common with its old self. These are general interface words, in the
// languages Agentlas ships in; a control is recognised through this table only when the new caption is one of the listed words. Anything else is "gone".
const SYMBOL_WORDS: Record<string, readonly string[]> = {
  "+": ["add", "plus", "new", "more", "create", "추가", "더하기", "新增", "追加"], "-": ["minus", "subtract", "less", "빼기"], "−": ["minus", "subtract", "less", "빼기"],
  "=": ["equals", "equal", "result", "calculate", "같음", "계산", "결과", "等于"], "×": ["multiply", "times", "곱하기"], "÷": ["divide", "나누기"], "%": ["percent", "percentage", "퍼센트"],
  c: ["clear", "all clear", "지우기"], ac: ["clear", "all clear", "지우기"], "(": ["open paren", "left paren"], ")": ["close paren", "right paren"], "√": ["root", "square root"],
  "✕": ["close", "cancel", "dismiss", "닫기", "취소"], "x": ["close", "cancel", "dismiss", "닫기"], "⚙": ["settings", "preferences", "options", "설정", "환경설정"], "☰": ["menu", "navigation", "메뉴"],
  "…": ["more", "menu", "options", "더보기"], "?": ["help", "도움말"], "⟳": ["refresh", "reload", "새로고침"], "✓": ["done", "ok", "apply", "accept", "완료", "확인", "적용"],
  "▶": ["play", "start", "재생"], "⏸": ["pause", "일시정지"], "←": ["back", "previous", "뒤로"], "→": ["next", "forward", "다음", "앞으로"], "★": ["favorite", "star", "bookmark", "즐겨찾기"],
};
const SYMBOL_KEYS = new Set(Object.keys(SYMBOL_WORDS));
function symbolWordMatch(a: string | undefined, b: string | undefined): boolean {
  const x = norm(a); const y = norm(b);
  if (!x || !y) return false;
  if (SYMBOL_KEYS.has(x) && (SYMBOL_WORDS[x] as readonly string[]).includes(y)) return true;
  if (SYMBOL_KEYS.has(y) && (SYMBOL_WORDS[y] as readonly string[]).includes(x)) return true;
  return false;
}

// Rules, in the order they are applied (each one was added because a benchmark trial showed a wrong press without it; scripts/bench-reach-learn.cjs):
//  1. an exact caption + role is the control (a second one of the same caption: `nth`, else it is ambiguous)
//  2. a risky caption (Delete, Send, Pay ...) is only ever found exactly, and a control is never healed ONTO a risky caption
//  3. a candidate whose caption was already a NEIGHBOUR when the work was learned is another control that existed then, not the renamed one
//  4. the caption has to be close (similarity >= 0.6) or be a known word for the symbol that was there; neighbours and container only add to that, they never replace it
//  5. the best has to clear the threshold and lead the second by a margin; two that fit are "which of these?", not a guess
export function locate(target: TargetDescriptor, elements: readonly LearnElement[], options: { allowHeal?: boolean } = {}): Located {
  const sameRole = elements.filter((element) => element.role === target.role);
  const wanted = norm(target.label);
  const exact = sameRole.filter((element) => norm(element.label) === wanted);
  if (exact.length > 0) {
    const picked = exact[target.nth ?? 0] ?? (exact.length === 1 ? exact[0] : undefined);
    return picked ? { status: "exact", element: picked, score: 1 } : { status: "ambiguous" };
  }
  if (options.allowHeal === false || isRiskyLabel(target.label) || !wanted) return { status: "missing" };
  const known = new Set((target.nearby ?? []).map(norm).filter(Boolean));
  const scored = sameRole
    .filter((element) => !known.has(norm(element.label)))
    .map((element) => {
      const description = describeElement(elements, element.index);
      const caption = Math.max(labelSimilarity(target.label, element.label), symbolWordMatch(target.label, element.label) ? 0.85 : 0);
      const nearbyVote = overlap(target.nearby, description?.nearby);
      const pathVote = overlap(target.path, description?.path);
      return { element, caption, score: caption >= 0.6 ? 0.7 * caption + 0.2 * nearbyVote + 0.1 * pathVote : 0, description };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0]; const second = scored[1];
  if (!best || best.score < HEAL_MIN_SCORE) return { status: "missing" };
  if (second && best.score - second.score < HEAL_MIN_MARGIN) return { status: "ambiguous" };
  if (isRiskyLabel(best.element.label)) return { status: "missing" };
  return { status: "healed", element: best.element, score: Number(best.score.toFixed(3)), from: target, to: best.description ?? { role: best.element.role } };
}

// ---- trace -> capability -----------------------------------------------------------------------------------------------------------------

export type TraceRefusal = "no_steps" | "too_many_steps" | "not_succeeded" | "no_outcome_check" | "vacuous_check" | "sensitive_app" | "secret_field" | "bad_name" | "bad_step";

export function refuseReason(trace: LearnTrace): TraceRefusal | null {
  if (!trace.name || trace.name.length > 60 || norm(trace.name).length < 3) return "bad_name";
  if (trace.steps.length === 0) return "no_steps";
  if (trace.steps.length > LEARN_MAX_STEPS * 3) return "too_many_steps";
  if (isSensitiveApp({ name: trace.app.name, ...(trace.app.bundleId ? { bundleId: trace.app.bundleId } : {}) })) return "sensitive_app";
  for (const step of trace.steps) {
    if (step.op === "type" || step.op === "set_value") {
      if (step.target && (SECRET_ROLE.test(step.target.role) || SECRET_LABEL.test(step.target.label ?? ""))) return "secret_field";
    }
    if (step.target && (SECRET_LABEL.test(step.target.label ?? "") && /field|text|edit|secure/i.test(step.target.role))) return "secret_field";
    if ((step.op === "click" || step.op === "type" || step.op === "set_value") && step.target && !step.target.role) return "bad_step";
  }
  if (!trace.succeeded) return "not_succeeded";
  // a control with no caption is named by its role alone: the label may be empty, the role may not
  if (!trace.check || !trace.check.role) return "no_outcome_check";
  if (trace.check.kind === "element-present" && trace.checkHeldBefore === true) return "vacuous_check";
  return null;
}

// What happened, minus what did not matter: failed attempts are dropped, and a click repeated on the very same control back to back stays (a button pressed twice
// is the work), but a key press that did nothing observable cannot be told apart here, so keys are kept as seen.
function cleanedSteps(trace: LearnTrace): TraceStep[] {
  return trace.steps.filter((step) => step.ok).slice(0, LEARN_MAX_STEPS);
}

export function shapeOf(steps: readonly TraceStep[]): string {
  return steps.map((step) => [step.op, step.target?.role ?? "", norm(step.target?.label), step.op === "key" ? step.key ?? "" : ""].join(":")).join("|");
}

export function capabilityId(appKey: string, name: string): string {
  const slug = norm(name).replace(/[^a-z0-9가-힣぀-ヿ一-鿿]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "work";
  return `learned:${slug}:${createHash("sha1").update(`${appKey}\n${norm(name)}`).digest("hex").slice(0, 8)}`;
}

export function induce(trace: LearnTrace): Capability {
  const steps = cleanedSteps(trace);
  const parameters: CapabilityParameter[] = [];
  let slots = 0;
  const bodySteps = steps.map((step) => {
    if (step.op === "type" || step.op === "set_value") {
      slots += 1;
      const name = slots === 1 ? "text" : `text${slots}`;
      parameters.push({ name, type: "string", required: true, description: `the text typed in step ${slots}${step.target?.label ? ` (${step.target.label})` : ""}` });
      return { tool: step.op === "type" ? "type_text" : "set_value", args: { ...(step.target ? { target: step.target } : {}), text: "${" + name + "}" } as Record<string, unknown> };
    }
    if (step.op === "key") return { tool: "press_key", args: { key: step.key ?? "" } as Record<string, unknown> };
    return { tool: "click", args: { target: step.target } as Record<string, unknown> };
  });
  const risky = steps.some((step) => isRiskyLabel(step.target?.label));
  const check = trace.check as OutcomeCheck;
  const postcondition: Postcondition = { kind: check.kind === "element-value-changed" ? "element-value-changed" : "element-present", detail: { role: check.role, label: check.label } };
  return {
    id: capabilityId(trace.app.key, trace.name),
    tier: "explored",
    source: { kind: "learned-trace", ref: createHash("sha1").update(shapeOf(steps)).digest("hex").slice(0, 12) },
    name: trace.name,
    ...(trace.description ? { description: trace.description.slice(0, 200) } : {}),
    kind: "command",
    granularity: "operation",
    traits: risky ? [LEARNED_TRAIT, RISKY_STEP_TRAIT] : [LEARNED_TRAIT],
    status: "candidate",
    verification: "structural",
    body: { kind: "steps", steps: bodySteps },
    postconditions: [postcondition],
    boundFingerprint: trace.app.fingerprint,
    revision: 1,
    evidence: { observations: 1, firstSeenDay: trace.day, lastSeenDay: trace.day },
    parameters,
    effect: { class: "unknown", basis: "unverified" },
  };
}

// ---- the lifecycle over the registry -------------------------------------------------------------------------------------------------------

export type LearnOutcome =
  | { action: "refused"; reason: TraceRefusal }
  | { action: "created" | "merged" | "promoted" | "relearned"; capability: Capability };

const shapeOfCapability = (capability: Capability): string =>
  capability.body?.kind === "steps" ? capability.body.steps.map((step) => {
    const target = step.args.target as TargetDescriptor | undefined;
    return [step.tool === "type_text" ? "type" : step.tool, target?.role ?? "", norm(target?.label), step.tool === "press_key" ? String(step.args.key ?? "") : ""].join(":");
  }).join("|") : "";

const toTraceShape = (capability: Capability): string => shapeOfCapability(capability).replace(/(^|\|)set_value:/g, "$1set_value:").replace(/(^|\|)type_text:/g, "$1type:");

export async function learnFromTrace(registry: CapabilityRegistry, trace: LearnTrace): Promise<LearnOutcome> {
  const reason = refuseReason(trace);
  if (reason) return { action: "refused", reason };
  const fresh = induce(trace);
  const existing = (await registry.capabilities(trace.app.key)).find((capability) => capability.id === fresh.id);
  if (!existing) {
    await registry.put(trace.app.key, trace.app.fingerprint, fresh);
    return { action: "created", capability: fresh };
  }
  const sameShape = toTraceShape(existing).replace(/set_value:/g, "set_value:") === shapeOf(cleanedSteps(trace)).replace(/\bset_value:/g, "set_value:") || shapeOfCapability(existing) === shapeOfCapability(fresh);
  if (sameShape) {
    // another independent success of the same work: the second one (with its outcome check) is what makes it a port
    const merged: Capability = { ...existing, evidence: { observations: (existing.evidence?.observations ?? 0) + 1, firstSeenDay: existing.evidence?.firstSeenDay ?? trace.day, lastSeenDay: trace.day }, boundFingerprint: trace.app.fingerprint };
    const promote = existing.status !== "verified" && (merged.evidence?.observations ?? 0) >= 2;
    if (promote) { merged.status = "verified"; merged.verification = "behavioral"; }
    if (existing.status === "degraded") { merged.status = "verified"; merged.verification = "behavioral"; }
    await registry.put(trace.app.key, trace.app.fingerprint, merged);
    return { action: promote ? "promoted" : "merged", capability: merged };
  }
  // the same named work done differently: the app moved under the old steps. This success replaces them; it had an outcome check, so it is proven at once.
  const replaced: Capability = {
    ...fresh,
    revision: (existing.revision ?? 1) + 1,
    status: "verified",
    verification: "behavioral",
    evidence: { observations: (existing.evidence?.observations ?? 0) + 1, firstSeenDay: existing.evidence?.firstSeenDay ?? trace.day, lastSeenDay: trace.day },
  };
  await registry.put(trace.app.key, trace.app.fingerprint, replaced);
  return { action: "relearned", capability: replaced };
}

// ---- replay: the hybrid -----------------------------------------------------------------------------------------------------------------

export type LearnRunCode = "bad_parameters" | "unsupported_body" | "no_screen" | "element_not_found" | "element_ambiguous" | "step_refused" | "outcome_unsatisfied" | "aborted";

export interface HealRecord { step: number; from: TargetDescriptor; to: TargetDescriptor; score: number }

export interface LearnRunResult {
  ok: boolean;
  code?: LearnRunCode;
  stepsRun: number;
  outcome: "satisfied" | "unsatisfied" | "unknown";
  healed: HealRecord[];
  // set when the run could not go on and the caller should do the rest on the screen: the steps that were not reached, as captions (never values)
  handoff?: { atStep: number; reason: LearnRunCode; remaining: Array<{ op: string; target?: string }> };
  // the capability with its healed steps written in; only present when the outcome check held
  updated?: Capability;
}

function validateParameters(capability: Capability, params: Record<string, unknown>): string | null {
  for (const key of Object.keys(params)) if (!capability.parameters.some((parameter) => parameter.name === key)) return `unknown parameter ${key.slice(0, 40)}`;
  for (const parameter of capability.parameters) {
    const value = params[parameter.name];
    if (value === undefined) { if (parameter.required) return `missing parameter ${parameter.name}`; continue; }
    if (typeof value !== "string") return `${parameter.name} must be text`;
    if (value.length > 2000) return `${parameter.name} is too long`;
  }
  return null;
}

function checkOutcome(condition: Postcondition | undefined, before: readonly LearnElement[], after: readonly LearnElement[] | null): "satisfied" | "unsatisfied" | "unknown" {
  if (!condition || !after) return "unknown";
  const role = String(condition.detail?.role ?? ""); const label = norm(String(condition.detail?.label ?? ""));
  const now = after.filter((element) => element.role === role && norm(element.label) === label);
  if (condition.kind === "element-present") {
    if (now.length > 0) return "satisfied";
    // A kind of element this screen never shows cannot be judged here: the replay reads the app through the driver's structured elements, which carry buttons
    // but no static text (dev-app run 33 elements, no AXStaticText before or after, while the check was the static text "최근 표현식"). That is
    // "unknown", not a failed run: a failed one would degrade a port that worked. A kind it does show, without the caption, is unsatisfied as before.
    const shown = after.some((element) => element.role === role) || before.some((element) => element.role === role);
    return shown ? "unsatisfied" : "unknown";
  }
  if (condition.kind === "element-value-changed") {
    const was = before.find((element) => element.role === role && norm(element.label) === label);
    // a control this screen never shows (the check was read from another view of the app) cannot be judged here; one that was there and is gone is unsatisfied
    if (now.length === 0) return was ? "unsatisfied" : "unknown";
    return (was?.value ?? "") !== (now[0].value ?? "") ? "satisfied" : "unsatisfied";
  }
  return "unknown";
}

export interface RunLearnedOptions {
  sleep?: (ms: number) => Promise<void>;
  settleMs?: number;
  signal?: AbortSignal;
  allowHeal?: boolean;
  // A different way of finding the control: for experiments and benchmarks only (the product always uses `locate`).
  locator?: typeof locate;
}

// How many more times the screen is read when the expected change is not there yet, each (settle time x 4) after the last.
const OUTCOME_RECHECKS = 3;

export async function runLearned(driver: LearnDriver, capability: Capability, params: Record<string, unknown>, options: RunLearnedOptions = {}): Promise<LearnRunResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const result = (partial: Partial<LearnRunResult> & { ok: boolean; stepsRun: number }): LearnRunResult => ({ outcome: "unknown", healed: [], ...partial });
  if (capability.body?.kind !== "steps" || !isLearned(capability)) return result({ ok: false, code: "unsupported_body", stepsRun: 0 });
  const invalid = validateParameters(capability, params);
  if (invalid) return result({ ok: false, code: "bad_parameters", stepsRun: 0 });
  const steps = capability.body.steps;
  if (steps.length === 0 || steps.length > LEARN_MAX_STEPS) return result({ ok: false, code: "unsupported_body", stepsRun: 0 });
  const allowHeal = options.allowHeal !== false && !capability.traits?.includes(RISKY_STEP_TRAIT);
  const start = await driver.snapshot();
  if (!start) return result({ ok: false, code: "no_screen", stepsRun: 0 });
  const healed: HealRecord[] = [];
  const nextSteps = steps.map((step) => ({ tool: step.tool, args: { ...step.args } }));
  let run = 0;
  const remaining = (from: number): Array<{ op: string; target?: string }> =>
    steps.slice(from).map((step) => ({ op: step.tool, ...((step.args.target as TargetDescriptor | undefined)?.label ? { target: (step.args.target as TargetDescriptor).label } : {}) }));
  const handoff = (code: LearnRunCode, at: number): LearnRunResult => result({ ok: false, code, stepsRun: run, healed, handoff: { atStep: at, reason: code, remaining: remaining(at) } });

  for (let i = 0; i < steps.length; i += 1) {
    if (options.signal?.aborted) return result({ ok: false, code: "aborted", stepsRun: run, healed });
    const step = steps[i];
    if (step.tool === "press_key") {
      const key = String(step.args.key ?? "");
      const acted = await driver.act({ kind: "key", key });
      if (!acted.ok) return handoff("step_refused", i);
      run += 1; await sleep(options.settleMs ?? 150); continue;
    }
    const target = step.args.target as TargetDescriptor | undefined;
    if (!target) return result({ ok: false, code: "unsupported_body", stepsRun: run, healed });
    const screen = await driver.snapshot();
    if (!screen) return handoff("no_screen", i);
    const found = (options.locator ?? locate)(target, screen, { allowHeal });
    if (found.status === "missing") return handoff("element_not_found", i);
    if (found.status === "ambiguous") return handoff("element_ambiguous", i);
    if (found.status === "healed") { healed.push({ step: i, from: found.from, to: found.to, score: found.score }); nextSteps[i] = { tool: step.tool, args: { ...step.args, target: found.to } }; }
    let action: LearnAction;
    if (step.tool === "click") action = { kind: "click", element: found.element };
    else {
      const slot = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(String(step.args.text ?? ""));
      const text = slot ? String(params[slot[1]] ?? "") : String(step.args.text ?? "");
      action = { kind: step.tool === "set_value" ? "set_value" : "type", element: found.element, text };
    }
    const acted = await driver.act(action);
    if (!acted.ok) return handoff("step_refused", i);
    run += 1;
    await sleep(options.settleMs ?? 150);
  }
  await sleep(options.settleMs ?? 150);
  let after = await driver.snapshot();
  let outcome = checkOutcome(capability.postconditions?.[0], start, after);
  // A screen that has not caught up yet is read again (read-only, no input): the change an app draws a moment late is not reported as missing.
  for (let look = 0; outcome === "unsatisfied" && look < OUTCOME_RECHECKS; look += 1) {
    if (options.signal?.aborted) return result({ ok: false, code: "aborted", stepsRun: run, healed });
    await sleep((options.settleMs ?? 150) * 4);
    after = await driver.snapshot();
    outcome = checkOutcome(capability.postconditions?.[0], start, after);
  }
  if (outcome === "unsatisfied") return result({ ok: false, code: "outcome_unsatisfied", stepsRun: run, outcome, healed });
  // a heal is only written back when the run ended in the state the work is for
  const updated: Capability | undefined = healed.length > 0 && outcome === "satisfied"
    ? { ...capability, body: { kind: "steps", steps: nextSteps }, revision: (capability.revision ?? 1) + 1, status: "verified", verification: "behavioral" }
    : undefined;
  return result({ ok: true, stepsRun: run, outcome, healed, ...(updated ? { updated } : {}) });
}

// One call's outcome, written where the next call finds it: a proven run keeps the port verified; a healed run rewrites the steps; a run handed
// back to the screen leaves the port in place (the caller is about to do the work again, and learnFromTrace replaces the steps when it succeeds).
export async function recordRun(registry: CapabilityRegistry, appKey: string, fingerprint: string, capability: Capability, run: LearnRunResult, day: string): Promise<void> {
  if (run.ok) {
    // "unknown" is never read as success: a run whose outcome could not be read proves nothing and changes nothing
    if (run.outcome !== "satisfied") return;
    if (run.updated) await registry.put(appKey, fingerprint, { ...run.updated, boundFingerprint: fingerprint, evidence: { observations: (capability.evidence?.observations ?? 0) + 1, firstSeenDay: capability.evidence?.firstSeenDay ?? day, lastSeenDay: day } });
    else await registry.recordOutcome(appKey, fingerprint, capability.id, { ok: true }, day);
    return;
  }
  if (run.code === "bad_parameters" || run.code === "aborted" || run.code === "unsupported_body") return;
  // the screen no longer matches: mark it so the next learn replaces it, but it stays callable (the caller gets a handoff, not a refusal)
  await registry.recordOutcome(appKey, fingerprint, capability.id, { ok: false, code: run.code ?? "step_failed", repairable: true }, day);
}
