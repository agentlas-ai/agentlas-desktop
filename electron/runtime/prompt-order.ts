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

export interface DeclaredPromptPart extends PromptOrderingMetadata { text?: string | null }

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
export function composeDeclaredPrompt(parts: readonly DeclaredPromptPart[], separator = "\n\n"): string {
  for (const part of parts) registerDeclaredPromptModule(part);
  return orderPromptParts(parts).map((part) => part.text).filter((text): text is string => Boolean(text?.trim())).join(separator);
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
