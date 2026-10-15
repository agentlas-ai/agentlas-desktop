import { composeTracedPrompt, restoreTracedPrompt, type PromptCompositionTrace } from "./prompt-composition-trace";
import { orderPromptParts, registerDeclaredPromptModule, type DeclaredPromptPart } from "./prompt-order";
import { placeTurnContextForRuntime } from "./serving-prefix";
import { estimateTextTokens } from "./token-estimate";
import type { RunnerRequest } from "./runner";

/** Prompt provenance only. This module grants no owner, tool, permission or process authority. */
interface TurnContextSource {
  readonly parts: readonly DeclaredPromptPart[];
  readonly runtimeKind: string;
  readonly sessionCapable: boolean;
  readonly keepTurnContext: boolean;
  readonly systemPrompt: string;
  readonly systemPromptComposition?: PromptCompositionTrace;
  readonly userPrompt: string;
  readonly locale: RunnerRequest["locale"];
}
interface Held {
  readonly source: TurnContextSource;
  readonly expected: Pick<RunnerRequest, "systemPrompt" | "userPrompt" | "turnContext" | "locale" | "systemPromptComposition">;
}
const held = new WeakMap<object, Held>();
const lifetimes = new Set(["fixed-policy", "versioned-content", "configuration", "task-context", "turn-context", "final-boundary"]);

function snapshot(parts: readonly DeclaredPromptPart[]): readonly DeclaredPromptPart[] | null {
  if (!Array.isArray(parts)) return null;
  const ids = new Set<string>();
  const copied: DeclaredPromptPart[] = [];
  for (const part of parts) {
    if (!part || typeof part.id !== "string" || !part.id.trim() || ids.has(part.id)
      || !lifetimes.has(part.stability) || !Array.isArray(part.changeTriggers) || !part.changeTriggers.length
      || part.changeTriggers.some((value: unknown) => typeof value !== "string" || !value)
      || (part.revision !== undefined && (!Number.isSafeInteger(part.revision) || part.revision < 1))
      || (part.order !== undefined && !Number.isFinite(part.order))
      || (part.text !== undefined && part.text !== null && typeof part.text !== "string")) return null;
    ids.add(part.id);
    copied.push(Object.freeze({ id: part.id, revision: part.revision ?? 1, stability: part.stability,
      changeTriggers: Object.freeze([...part.changeTriggers]), order: part.order ?? 0, text: part.text ?? "" }));
  }
  return Object.freeze(copied);
}

/** Preserve the Main collector's exact empty-slot/separator behavior; only canonical metadata orders it. */
export function renderRunnerTurnContext(parts: readonly DeclaredPromptPart[]): string {
  for (const part of parts) registerDeclaredPromptModule(part);
  return orderPromptParts(parts).map(part => part.text ?? "").join("\n\n");
}

function projection(source: TurnContextSource): Held["expected"] {
  const text = renderRunnerTurnContext(source.parts);
  const placed = placeTurnContextForRuntime({ runtimeKind: source.runtimeKind, sessionCapable: source.sessionCapable,
    systemPrompt: source.systemPrompt, userPrompt: source.userPrompt, turnContext: text, locale: source.locale });
  const composition = source.systemPromptComposition?.kind === "main-host"
    ? placed.placement === "system-tail" && text.trim()
      ? composeTracedPrompt([...restoreTracedPrompt(source.systemPrompt, source.systemPromptComposition), ...source.parts],
          { separator: "\n\n", kind: "main-host" })
      : { text: source.systemPrompt, composition: source.systemPromptComposition }
    : null;
  return { systemPrompt: composition?.text ?? placed.systemPrompt, userPrompt: placed.userPrompt,
    ...(composition ? { systemPromptComposition: composition.composition } : {}),
    turnContext: source.keepTurnContext && text ? text : undefined, locale: source.locale };
}

function equal(request: RunnerRequest, expected: Held["expected"]): boolean {
  return request.systemPrompt === expected.systemPrompt && request.userPrompt === expected.userPrompt
    && request.turnContext === expected.turnContext && request.locale === expected.locale
    && (expected.systemPromptComposition === undefined || JSON.stringify(request.systemPromptComposition) === JSON.stringify(expected.systemPromptComposition));
}

/** Invalid metadata never drops a task or suppresses input. Only an exact host render acquires data custody. */
export function bindRunnerTurnContext<T extends RunnerRequest>(request: T, input: {
  parts: readonly DeclaredPromptPart[]; runtimeKind: string; sessionCapable: boolean;
  systemPrompt: string; systemPromptComposition?: PromptCompositionTrace; userPrompt: string; locale: RunnerRequest["locale"]; keepTurnContext?: boolean;
}): T {
  const parts = snapshot(input.parts);
  if (!parts || typeof input.runtimeKind !== "string" || typeof input.systemPrompt !== "string"
    || typeof input.userPrompt !== "string") { held.delete(request); return request; }
  const source = Object.freeze({ ...input, parts, keepTurnContext: input.keepTurnContext ?? input.sessionCapable });
  const expected = projection(source);
  if (equal(request, expected)) held.set(request, { source, expected });
  else held.delete(request);
  return request;
}

/** Public fields or an equal JSON copy cannot replace the original process-local host object. */
export function runnerTurnContextSource(request: RunnerRequest): TurnContextSource | null {
  const value = held.get(request);
  if (!value) return null;
  if (!equal(request, value.expected)) { held.delete(request); return null; }
  return value.source;
}

/** Explicit trusted copies keep data custody only while the actual prompt projection is unchanged. */
export function carryRunnerTurnContext<T extends RunnerRequest>(original: RunnerRequest, next: T): T {
  const source = runnerTurnContextSource(original);
  if (source && equal(next, projection(source))) held.set(next, { source, expected: projection(source) });
  else held.delete(next);
  return next;
}

function placed<T extends RunnerRequest>(request: T, source: TurnContextSource): T {
  const fields = projection(source), text = renderRunnerTurnContext(source.parts);
  const final = new Set(source.parts.filter(part => part.stability === "final-boundary").map(part => part.text));
  const turnContextStable = request.turnContextStable?.filter(block => !final.has(block));
  const placement = placeTurnContextForRuntime({ runtimeKind: source.runtimeKind, sessionCapable: source.sessionCapable,
    systemPrompt: source.systemPrompt, userPrompt: source.userPrompt, turnContext: text, locale: source.locale }).placement;
  const next = { ...request, ...fields, ...(turnContextStable ? { turnContextStable } : {}),
    ...(request.ledgerHints ? { ledgerHints: { ...request.ledgerHints, hostContextText: text,
      hostContextTokens: estimateTextTokens(text), ownerTextTokens: estimateTextTokens(source.userPrompt), hostContextPlacement: placement } } : {}) };
  held.set(next, { source, expected: fields });
  return next;
}

/** A changed continuation/image input is explicitly rebased by its host, never recovered by stripping prompt text. */
export function replaceRunnerUserPrompt<T extends RunnerRequest>(request: T, userPrompt: string,
  changes: Pick<Partial<RunnerRequest>, "images"> = {}): T {
  const source = runnerTurnContextSource(request), next = { ...request, ...changes, userPrompt };
  return source ? placed(next, Object.freeze({ ...source, userPrompt })) : next;
}

/** Known additions precede unknown input; opaque text is retained byte-for-byte, never labelled final/authoritative. */
function opaque<T extends RunnerRequest>(request: T, additions: readonly DeclaredPromptPart[], runtimeKind?: string): T {
  const prefix = renderRunnerTurnContext(additions), original = request.turnContext;
  registerDeclaredPromptModule({ id: "runner.turn-context.opaque", revision: 1, stability: "turn-context",
    changeTriggers: ["task", "owner-input", "checkpoint"], order: Number.MAX_SAFE_INTEGER });
  if (!prefix) return deliverUnboundTurnContext(request, runtimeKind);
  const turnContext = prefix + (original === undefined || original === "" ? "" : "\n\n" + original);
  return statelessFrame({ ...request, turnContext }, runtimeKind) ?? { ...request, turnContext };
}

/**
 * A stateless API/local host loop never reads req.turnContext; Main (serving-prefix) and the AgentContext wrapper place
 * it for that kind. An unbound request with no AgentContext (a direct selected-runner caller) has neither, so its turn
 * context is framed before the current user message here, exactly as serving-prefix places it. Any other request is
 * returned as the same object.
 */
export function deliverUnboundTurnContext<T extends RunnerRequest>(request: T, runtimeKind?: string): T {
  return runnerTurnContextSource(request) ? request : statelessFrame(request, runtimeKind) ?? request;
}

function statelessFrame<T extends RunnerRequest>(request: T, runtimeKind?: string): T | null {
  const turnContext = request.turnContext;
  if (!runtimeKind || request.agentContext || !turnContext?.trim()) return null;
  const body = placeTurnContextForRuntime({ runtimeKind, sessionCapable: false, systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt, turnContext, locale: request.locale });
  return body.placement === "user-message" ? { ...request, userPrompt: body.userPrompt, turnContext } : null;
}

/** `runtimeKind` is the selected adapter kind (selection.ts); it only decides where an unbound addition is delivered. */
export function extendRunnerTurnContext<T extends RunnerRequest>(request: T, additions: readonly DeclaredPromptPart[],
  stable: readonly string[] = [], runtimeKind?: string): T {
  const safe = snapshot(additions);
  if (!safe) return request;
  const source = runnerTurnContextSource(request);
  const replaced = new Set(safe.map(part => part.id));
  const parts = source ? snapshot([...source.parts.filter(part => !replaced.has(part.id)), ...safe]) : null;
  const target = stable.length ? { ...request, turnContextStable: [...(request.turnContextStable ?? []), ...stable] } : request;
  if (source && parts) return placed(target, Object.freeze({ ...source, parts }));
  return opaque(target, safe, runtimeKind);
}

/** Final AgentContext serialization uses current parts after ACK selection and the actual provider placement. */
export function finalizeRunnerTurnContext<T extends RunnerRequest>(request: T, parts: readonly DeclaredPromptPart[],
  providerKind: string, hostMessage: boolean): T {
  const source = runnerTurnContextSource(request), safe = snapshot(parts);
  if (!safe) return request;
  if (source) return placed(request, Object.freeze({ ...source, parts: safe, runtimeKind: providerKind,
    sessionCapable: !hostMessage, keepTurnContext: true }));
  // The foreign request's original strings remain data. No opaque binding is minted here.
  const text = renderRunnerTurnContext(safe);
  const body = placeTurnContextForRuntime({ runtimeKind: providerKind, sessionCapable: !hostMessage,
    systemPrompt: request.systemPrompt, userPrompt: request.userPrompt, turnContext: text, locale: request.locale });
  return { ...request, systemPrompt: body.systemPrompt, userPrompt: body.userPrompt, turnContext: text || undefined };
}
