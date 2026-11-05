/** Host-declared update lifetimes, never inferred from prompt wording or user intent. */
export type PromptStability =
  | "fixed-policy"
  | "versioned-content"
  | "configuration"
  | "task-context"
  | "turn-context"
  | "final-boundary";

export type PromptChangeTrigger =
  | "release" | "profile" | "locale" | "permission" | "runtime" | "capability-inventory"
  | "plugin-inventory" | "connector-inventory" | "agent-instructions" | "skill-package"
  | "project-instructions" | "owner-profile" | "goal-revision" | "plan-revision"
  | "tool-grant" | "managed-local" | "task" | "attachments" | "retrieval" | "checkpoint" | "owner-input"
  | "goal-runtime" | "lease" | "output-schema" | "validation-result" | "model-output" | "child-result" | "memory-ticket";

export interface PromptOrderingMetadata {
  id: string;
  revision?: number;
  stability: PromptStability;
  /** Inputs whose changes require fresh rendering/delivery; stable never means frozen. */
  changeTriggers: readonly PromptChangeTrigger[];
  /** Ordering inside one lifetime, when semantic or producer dependencies require it. */
  order?: number;
}

/** Bump when lifetime precedence changes; manifests can distinguish reordered delivery from content edits. */
export const PROMPT_ORDER_REVISION = 1;

const STABILITY_ORDER: Record<PromptStability, number> = {
  "fixed-policy": 0,
  "versioned-content": 1,
  configuration: 2,
  "task-context": 3,
  "turn-context": 4,
  // A closing authority guard must remain after even untrusted/updated instructions.
  "final-boundary": 5,
};

/** A stable sort of declared fields. No text parsing, hashing, omission or authority changes. */
export function orderPromptParts<T extends PromptOrderingMetadata>(parts: readonly T[]): T[] {
  return parts.map((part, index) => ({ part, index })).sort((a, b) =>
    STABILITY_ORDER[a.part.stability] - STABILITY_ORDER[b.part.stability]
    || (a.part.order ?? 0) - (b.part.order ?? 0)
    || a.index - b.index,
  ).map(({ part }) => part);
}

export interface DeclaredPromptPart extends PromptOrderingMetadata {
  text?: string | null;
  /**
   * Identity of a canonical data payload (`goal-checkpoint:<goalId>:<revision>:<checkpointId>`,
   * `runtime-catalog:<digest>`), set by the producer of the data, never derived from text. The compiler keeps the first
   * part per key and drops the rest; the drop is recorded in the trace.
   */
  contentKey?: string;
  /**
   * Content keys whose payload this part's text already contains because a layer above composed it (typed data carried
   * down with the request, never found by searching text). A part whose `contentKey` is embedded by any other part is dropped.
   */
  embeds?: readonly string[];
}

/** A part the compiler left out, with the reason. Plain data: no prompt text. */
export interface DroppedPromptPart { id: string; contentKey: string; reason: "duplicate-content-key" | "embedded-in-other-part" }

export interface ComposeDeclaredOptions {
  /** Keys the caller's own text already carries (for example an upper layer's request). Typed, never inferred. */
  carried?: readonly string[];
}

/**
 * Order, then keep the first part per `contentKey`. A part is also dropped when another part (or `options.carried`)
 * declares that it embeds the same key, so a lower layer cannot add a payload that already came down inside the
 * upper layer's text. Pure: returns the ordered kept parts and the drops.
 */
export function dedupeDeclaredPromptParts<T extends DeclaredPromptPart>(parts: readonly T[], options?: ComposeDeclaredOptions): { parts: T[]; dropped: DroppedPromptPart[] } {
  const ordered = orderPromptParts(parts);
  const embedded = new Set<string>(options?.carried ?? []);
  for (const part of ordered) for (const key of part.embeds ?? []) embedded.add(key);
  const seen = new Set<string>();
  const dropped: DroppedPromptPart[] = [];
  const kept: T[] = [];
  for (const part of ordered) {
    const key = part.contentKey;
    if (key && part.text?.trim()) {
      if (embedded.has(key) && !(part.embeds ?? []).includes(key)) { dropped.push({ id: part.id, contentKey: key, reason: "embedded-in-other-part" }); continue; }
      if (seen.has(key)) { dropped.push({ id: part.id, contentKey: key, reason: "duplicate-content-key" }); continue; }
      seen.add(key);
    }
    kept.push(part);
  }
  return { parts: kept, dropped };
}

const MIN_DETECTABLE_PAYLOAD_CHARS = 64;

/**
 * Gate-time detector. A kept part that declares a `contentKey` must not have its exact text inside another kept part:
 * that is the old pattern (a layer flattened the payload into text and a lower layer added its own copy) made visible.
 */
export function findEmbeddedContentKeyPayloads(parts: readonly DeclaredPromptPart[], options?: ComposeDeclaredOptions): Array<{ contentKey: string; payloadId: string; holderId: string }> {
  const kept = dedupeDeclaredPromptParts(parts, options).parts;
  const found: Array<{ contentKey: string; payloadId: string; holderId: string }> = [];
  for (const payload of kept) {
    const text = payload.text?.trim();
    if (!payload.contentKey || !text || text.length < MIN_DETECTABLE_PAYLOAD_CHARS) continue;
    for (const holder of kept) {
      if (holder === payload || !holder.text) continue;
      if (holder.text.includes(text)) found.push({ contentKey: payload.contentKey, payloadId: payload.id, holderId: holder.id });
    }
  }
  return found;
}

const declaredModules = new Map<string, PromptOrderingMetadata>();

/** Registration contains only host-authored metadata; prompt data and secrets are never retained here. */
export function registerDeclaredPromptModule(part: PromptOrderingMetadata): void {
  if (!part.id.trim() || !part.changeTriggers.length) throw new Error("prompt-module-declaration-required");
  const declaration = { id: part.id, revision: part.revision ?? 1, stability: part.stability,
    changeTriggers: [...part.changeTriggers], order: part.order ?? 0 };
  // A producer ID can have declared mode variants; each variant has a deterministic registry key.
  const key = JSON.stringify(declaration);
  if (!declaredModules.has(key)) declaredModules.set(key, Object.freeze(declaration));
}

export function declaredPromptModules(): readonly PromptOrderingMetadata[] { return [...declaredModules.values()]; }

/** Order only host-declared lifetimes within one authority channel; never reorder conversation messages. */
export function composeDeclaredPrompt(parts: readonly DeclaredPromptPart[], separator = "\n\n", options?: ComposeDeclaredOptions): string {
  return composeDeclaredPromptDetailed(parts, separator, options).text;
}

/** Same text as `composeDeclaredPrompt`, plus the content keys the text carries and the parts the compiler dropped. */
export function composeDeclaredPromptDetailed(parts: readonly DeclaredPromptPart[], separator = "\n\n", options?: ComposeDeclaredOptions): { text: string; contentKeys: string[]; dropped: DroppedPromptPart[] } {
  for (const part of parts) registerDeclaredPromptModule(part);
  const { parts: kept, dropped } = dedupeDeclaredPromptParts(parts, options);
  const used = kept.filter((part) => Boolean(part.text?.trim()));
  const contentKeys = [...new Set(used.flatMap((part) => [...(part.contentKey ? [part.contentKey] : []), ...(part.embeds ?? [])]))];
  return { text: used.map((part) => part.text as string).join(separator), contentKeys, dropped };
}

/** Keep producer slots stable until dispatch refresh, then order only at serialization. */
export class PromptContextCollector {
  readonly parts: string[] = [];
  private readonly declarations: PromptOrderingMetadata[] = [];

  add(id: string, stability: PromptStability, changeTriggers: readonly PromptChangeTrigger[], text: string, order?: number): number {
    if (this.declarations.some((part) => part.id === id)) throw new Error(`prompt-context-duplicate:${id}`);
    const index = this.parts.length;
    this.parts.push(text);
    const declaration = { id, stability, changeTriggers, ...(order === undefined ? {} : { order }) };
    registerDeclaredPromptModule(declaration);
    this.declarations.push(declaration);
    return index;
  }

  compose(refreshed: readonly string[] = this.parts): string {
    if (refreshed.length !== this.declarations.length) throw new Error("prompt-context-undeclared-slot");
    return composeDeclaredPrompt(this.declarations.map((part, index) => ({ ...part, text: refreshed[index] })));
  }

  manifest(refreshed: readonly string[] = this.parts): DeclaredPromptPart[] {
    if (refreshed.length !== this.declarations.length) throw new Error("prompt-context-undeclared-slot");
    return orderPromptParts(this.declarations.map((part, index) => ({ ...part, text: refreshed[index] })));
  }
}
