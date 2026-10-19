import { composeDeclaredPrompt, orderPromptParts, type DeclaredPromptPart } from "./prompt-order";

/** Plain composition metadata only. No prompt text, permissions, grants or executable callbacks. */
export interface PromptCompositionTrace {
  revision: 1;
  /** Omitted for the original Build trace contract. Main uses its existing double-newline transport. */
  separator?: "\n" | "\n\n";
  kind?: "main-host" | "company-work";
  parts: readonly (Omit<DeclaredPromptPart, "text"> & { start: number; end: number })[];
}

/** Exact UTF-16 spans into the already transported string avoid duplicating large canonical sources. */
export function composeTracedPrompt(parts: readonly DeclaredPromptPart[], options?: { separator: "\n" | "\n\n"; kind?: "main-host" | "company-work" }): { text: string; composition: PromptCompositionTrace } {
  const separator = options?.separator ?? "\n";
  const registeredText = composeDeclaredPrompt(parts, separator);
  const ordered = orderPromptParts(parts).filter(part => options?.kind === "main-host" && part.id === "main.system.host.agent-definition"
    ? typeof part.text === "string" : part.text?.trim());
  // Retain even an empty/whitespace package definition exactly; it is a source value, never padding.
  const text = options?.kind === "main-host" ? ordered.map(part => part.text as string).join(separator) : registeredText;
  let cursor = 0;
  const spans = ordered.map(part => {
    const { text: raw, ...metadata } = part;
    const value = raw as string;
    const start = cursor;
    cursor += value.length;
    const span = Object.freeze({ ...metadata, ...(options?.kind === "main-host" ? { revision: part.revision ?? 1, order: part.order ?? 0 } : {}), changeTriggers: Object.freeze([...metadata.changeTriggers]), start, end: cursor });
    cursor += separator.length;
    return span;
  });
  return { text, composition: Object.freeze({ revision: 1, ...(options ? { separator, ...(options.kind ? { kind: options.kind } : {}) } : {}), parts: Object.freeze(spans) }) };
}

/** A trace describes this exact host string; it never substitutes another string or authorizes an action. */
export function restoreTracedPrompt(text: string, trace: PromptCompositionTrace): readonly DeclaredPromptPart[] {
  const fail = (): never => { throw new Error("prompt_composition_trace_mismatch"); };
  if (trace?.revision !== 1 || !Array.isArray(trace.parts)) return fail();
  const separator = trace.separator ?? "\n";
  if (!["\n", "\n\n"].includes(separator) || (trace.kind !== undefined && trace.kind !== "main-host" && trace.kind !== "company-work")) return fail();
  let cursor = 0;
  const parts = trace.parts.map(span => {
    if (!span || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
      || span.start !== cursor || span.end < span.start || span.end > text.length
      || (span.end === span.start && !(trace.kind === "main-host" && span.id === "main.system.host.agent-definition"))
      || typeof span.id !== "string" || !span.id.trim()
      || !["fixed-policy", "versioned-content", "configuration", "task-context", "turn-context", "final-boundary"].includes(span.stability)
      || !Array.isArray(span.changeTriggers) || span.changeTriggers.length === 0
      || span.changeTriggers.some((value: unknown) => typeof value !== "string" || !value)
      || (span.revision !== undefined && (!Number.isSafeInteger(span.revision) || span.revision < 1))
      || (span.order !== undefined && !Number.isFinite(span.order))) return fail();
    const { start, end, ...metadata } = span;
    const value = text.slice(start, end);
    if (!value.trim() && !(trace.kind === "main-host" && span.id === "main.system.host.agent-definition")) return fail();
    cursor = end + separator.length;
    if (end < text.length && text.slice(end, end + separator.length) !== separator) return fail();
    return { ...metadata, text: value } as DeclaredPromptPart;
  });
  if ((parts.length ? cursor - separator.length : 0) !== text.length || composeTracedPrompt(parts, trace.separator !== undefined || trace.kind === "main-host" ? { separator, ...(trace.kind ? { kind: trace.kind } : {}) } : undefined).text !== text) return fail();
  return parts;
}
