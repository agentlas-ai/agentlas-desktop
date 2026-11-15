// Write-time classification, the desktop's binding of `shared/memory-classification.ts` to this app's own ruleset copy and store.
// The pure rules live in shared/ (one port of the engine's memory_classify.py, pinned by the engine's shared vectors); this file only supplies what the
// rules need from the running app: the ruleset, the home state of this computer, and the question "how many live lines does that store hold".
// Nothing here is cached beyond the ruleset file (loaded once, as the other curator rules are): the home state and the counts are read at the moment of use.
import { loadCuratorRuleset } from "./curator-rules";
import { composeDeclaredPrompt, type DeclaredPromptPart } from "../runtime/prompt-order";
import {
  activeClassificationRules, ceilingCountsFrom, ceilingOf, equivalentKinds, forgetKey, forgetRules, fullReasonOf, homeStateKeyOf, homeStateOf, workspaceRulesStateKey, workspaceRulesValueOn,
  type ClassificationRules, type HomeState,
} from "../../shared/memory-classification";
import type { MemoryActorKind } from "../../shared/memory-ownership";

/** The usable classification rules, or null when this build's ruleset copy is older or damaged (the rules are then off: behaviour as before). */
export function memoryClassificationRules(): ClassificationRules | null {
  try { return activeClassificationRules(loadCuratorRuleset().ruleset); } catch { return null; }
}

/** The stored kinds a corrected kind stands for in a scope (duplicate check and forget stamp follow the corrected kind). `[kind]` when the rules are off. */
export function equivalentMemoryKinds(scope: string, kind: string): string[] { return equivalentKinds(memoryClassificationRules(), scope, kind); }

/**
 * The line ceiling of the store a scope writes into for this kind of actor, or null (no ceiling): `ceilingRows`, or a resident actor's own `residentActorCeilingRows` in `agent_repo`;
 * `countsFrom` is the instant before which a line is not counted (#1: a store that was already at 2,460 lines when the ceiling began refused every new one).
 */
export function memoryStoreCeiling(scope: string, actorKind?: MemoryActorKind): { rows: number; reason: string; countsFrom: string | null } | null {
  const rules = memoryClassificationRules();
  const rows = ceilingOf(rules, scope, actorKind);
  return rows === null ? null : { rows, reason: fullReasonOf(rules), countsFrom: ceilingCountsFrom(rules) };
}

/**
 * Whether this computer is the personal agent's home: the root store's `memory_store_meta` key (`stores.user_identity.admission.homeStateMetaKey`,
 * value home|away|sealed). READ ONLY here: no code of this app writes it yet (the personal-agent move writes it). A missing key, an unreadable store or
 * a value this build does not know is `home` — a reader that cannot tell never blocks a write.
 */
export function currentHomeState(): HomeState {
  try {
    const { getMemoryDb } = require("./database") as typeof import("./database");
    const row = getMemoryDb().prepare("SELECT value FROM memory_store_meta WHERE key=?").get(homeStateKeyOf(memoryClassificationRules())) as { value?: string } | undefined;
    return homeStateOf(row?.value);
  } catch { return "home"; }
}

/**
 * The workspace-rules switch (Agentlas 2.0 P2; the engine's `memory_classify.workspace_rules_on`): the root store's `memory_store_meta` row `workspaceRules.stateMetaKey`
 * (`workspace_rules_state`) says `on`. READ ONLY here: only the first-run step `workspace-rules` writes it (P5). A missing row, an unreadable store or any other value is OFF - and with the
 * switch off every read and write of memory is what it was before 1.7.0. Asked at the moment of use, never cached (the value changes while the app runs, when the step writes it).
 */
export function workspaceRulesOn(): boolean {
  try {
    const { getMemoryDb } = require("./database") as typeof import("./database");
    const row = getMemoryDb().prepare("SELECT value FROM memory_store_meta WHERE key=?").get(workspaceRulesStateKey(memoryClassificationRules())) as { value?: string } | undefined;
    return workspaceRulesValueOn(row?.value);
  } catch { return false; }
}

/**
 * The registered prompt module `memory.classification` (stability versioned-content, change cause curator-ruleset): the six-line definition of the four memory
 * stores, written ONCE in the ruleset file (`classification.promptBlock`) — never copied into this app. Absent (an older or damaged ruleset copy) = no module,
 * exactly as the engine behaves. The text carries no example.
 */
export function classificationPromptPart(): DeclaredPromptPart | null {
  try {
    const classification = loadCuratorRuleset().ruleset.classification as { promptBlock?: unknown; promptModule?: { id?: unknown } } | undefined;
    const text = typeof classification?.promptBlock === "string" ? classification.promptBlock.trim() : "";
    if (!text) return null;
    return { id: typeof classification?.promptModule?.id === "string" ? classification.promptModule.id : "memory.classification", stability: "versioned-content",
      changeTriggers: ["curator-ruleset"], text };
  } catch { return null; }
}

/** A curator's system text: its own rules (fixed policy) first, then the shared classification module. Fixed above changing, one lifetime order (docs/PROMPT-COMPOSITION-POLICY.md). */
export function composeCuratorSystemPrompt(rulesId: string, rulesText: string): string {
  const parts: DeclaredPromptPart[] = [{ id: rulesId, stability: "fixed-policy", changeTriggers: ["release"], text: rulesText }];
  const module = classificationPromptPart();
  if (module) parts.push(module);
  return composeDeclaredPrompt(parts, "\n");
}

/**
 * The forget stamp's comparison rules for this build's ruleset copy: whether it ignores the kind, and the hashes of every spelling of the offered text it counts as the same words.
 * Without a `stores.forget` block (an older or damaged ruleset copy) the stamp is the exact kind and the exact words, as before.
 */
export function forgetStampRules(): { kindBlind: boolean; trailingChars: string; key(text: string): string } {
  const rules = memoryClassificationRules();
  return { ...forgetRules(rules), key: (text: string) => forgetKey(rules, text) };
}
