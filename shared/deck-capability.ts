import type { RuntimeKind } from "./types";

/*
 * Which runtimes are told to design a NEW deck in code (document.deck.build) and which keep building it op by op with
 * document.create + document.apply. A function of the runtime kind and the run's permission, never of model text: the prompt
 * line only appears where this says "code" (electron/runtime/prompt-modules.ts, module capability.documents.deck).
 *
 * "code" needs a model that writes a correct pptxgenjs script from a schema and reads the lint findings back. Measured 2026-10-23
 * on one task (a 5-6 slide executive deck), same host ports, no template:
 *   - claude-code (sonnet, low): 3/3 designed decks by its own script, 0/3 through document.* ops.
 *   - codex (gpt-6.1-sol, low): 2/2 designed decks by script once told to; 3/3 plain decks through document.* ops.
 *   - gpt-oss:20b through the local tool loop: 1/2 decks by script (crude: stray shape, text off the slide, no render check),
 *     1/2 stopped on a tool-call parse error; through the ops it saved 1/3 plain decks. A small local model is not made worse
 *     by being sent to code, it is kept on the ops path it already managed.
 * The other kinds have no measurement of their own; they are classed by what they run: a vendor coding agent or a large hosted
 * model is "code", a locally served model is "ops". Move a kind only with a measurement (docs/2026-10-23 ppt design research).
 */
export type DeckRoute = "code" | "ops";

interface DeckRouteRow { route: DeckRoute; evidence: "measured" | "classed" }

export const DECK_ROUTE_BY_RUNTIME = {
  "claude-code": { route: "code", evidence: "measured" },
  codex: { route: "code", evidence: "measured" },
  antigravity: { route: "code", evidence: "classed" },
  kimi: { route: "code", evidence: "classed" },
  grok: { route: "code", evidence: "classed" },
  cursor: { route: "code", evidence: "classed" },
  acp: { route: "code", evidence: "classed" },
  byok: { route: "code", evidence: "classed" },
  agentlas: { route: "code", evidence: "classed" },
  ollama: { route: "ops", evidence: "measured" },
  lmstudio: { route: "ops", evidence: "classed" },
  mlx: { route: "ops", evidence: "classed" },
  "agentlas-local": { route: "ops", evidence: "classed" },
} as const satisfies Record<RuntimeKind, DeckRouteRow>;

/**
 * The route for one run, or null when no new-deck instruction applies: an unknown runtime, or a run that may not write (it can
 * build nothing, by either route).
 */
export function deckRoute(runtimeKind: string | null | undefined, permission: "read" | "write" | "full" | null | undefined): DeckRoute | null {
  if (permission !== "write" && permission !== "full") return null;
  const row = runtimeKind ? (DECK_ROUTE_BY_RUNTIME as Record<string, DeckRouteRow | undefined>)[runtimeKind] : undefined;
  return row ? row.route : null;
}
