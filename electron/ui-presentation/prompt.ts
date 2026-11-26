import { CHAT_VISUAL_BLOCK_INSTRUCTIONS, INTELLECT_UI_GENERATION_INSTRUCTIONS, UI_CANVAS_INSTRUCTIONS } from "../../shared/intellect-ui-prompt";
import { registerDeclaredPromptModule, type PromptOrderingMetadata } from "../runtime/prompt-order";
import type { UiPresentationChoice, UiPresentationRenderer } from "./contract";

/*
 * The one turn-context module of a presentation decision (registered prompt module; collector
 * desktop.main.turn-context, part `ui.presentation`). It changes with every person message (the decision), so it is
 * `turn-context` and is pushed last in the collector: at the end of the turn context, only a final boundary after it.
 * With `model-self` the module does not exist for the turn and nothing else changes.
 */
export const UI_PRESENTATION_MODULE_ID = "ui.presentation";
export const UI_PRESENTATION_DECLARATION: PromptOrderingMetadata & { revision: number } = {
  id: UI_PRESENTATION_MODULE_ID, revision: 1, stability: "turn-context", changeTriggers: ["owner-input"],
};
registerDeclaredPromptModule(UI_PRESENTATION_DECLARATION);

/** Only the chosen renderer's part of the UI spec; `markdown` has none (plain markdown needs no spec). */
export function rendererSpec(renderer: UiPresentationRenderer): string | null {
  switch (renderer) {
    case "agentlas-ui": return INTELLECT_UI_GENERATION_INSTRUCTIONS.trim();
    case "chart":
    case "visual": return CHAT_VISUAL_BLOCK_INSTRUCTIONS.trim();
    case "canvas": return UI_CANVAS_INSTRUCTIONS.trim();
    case "markdown": return null;
  }
}

/**
 * The line (`key: value`) naming the choice and the renderer, then that renderer's spec. `text` has no UI line at all (null).
 * read_ui_schema is named as not needed: this line replaces it for the turn (the tool itself stays listed, see client.ts).
 */
export function renderUiPresentation(choice: UiPresentationChoice, renderer: UiPresentationRenderer): string | null {
  if (choice === "text") return null;
  const line = `ui: show this answer as ${choice} with ${renderer} (decided for this message; read_ui_schema not needed; no other visual form this turn)`;
  const spec = rendererSpec(renderer);
  return spec ? `${line}\n${spec}` : line;
}
