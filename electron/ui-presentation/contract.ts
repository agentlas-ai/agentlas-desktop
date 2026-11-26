import CONTRACT from "../../shared/ui-presentation/ui-presentation.json";

/*
 * The `presentation` question (shared/ui-presentation/ui-presentation.json, the same contract the phone app reads).
 * Electron-free: the daemon loads this module. Everything here is a pure function of the contract; the decider is a registry.
 */

export const UI_PRESENTATION_CHOICES = [
  "text", "table", "bar_chart", "line_chart", "scatter_plot", "distribution", "part_to_whole",
  "flowchart", "static_diagram", "interactive_diagram", "calculator", "result_card",
] as const;
export type UiPresentationChoice = typeof UI_PRESENTATION_CHOICES[number];

export const UI_PRESENTATION_RENDERERS = ["markdown", "agentlas-ui", "chart", "visual", "canvas"] as const;
export type UiPresentationRenderer = typeof UI_PRESENTATION_RENDERERS[number];

export const UI_PRESENTATION_SURFACES = [
  "desktop-work", "desktop-finance", "desktop-personal-agent", "desktop-one", "phone-personal-agent",
] as const;
export type UiPresentationSurface = typeof UI_PRESENTATION_SURFACES[number];

export interface UiPresentationMessage { role: "user" | "assistant"; text: string }

const CATEGORIES = CONTRACT.categories as unknown as Record<string, { when: string; renderers: readonly string[] }>;
const SURFACES = CONTRACT.surfaces as unknown as Record<string, readonly string[]>;

export const UI_PRESENTATION_CONTRACT_VERSION: string = CONTRACT.version;
export const UI_PRESENTATION_INSTRUCTION: string = CONTRACT.question.instruction;
export const UI_PRESENTATION_MAX_MESSAGES: number = CONTRACT.question.input.maxMessages;
export const UI_PRESENTATION_MAX_CHARS_PER_MESSAGE: number = CONTRACT.question.input.maxCharsPerMessage;
/** null = no confidence gate (the contract's value today). */
export const UI_PRESENTATION_MIN_CONFIDENCE: number | null = CONTRACT.decision.minConfidence as number | null;

/** The contract's own list: the TS unions above must equal it. */
export function contractChoices(): string[] { return [...CONTRACT.question.output.properties.choice.enum]; }
export function contractRenderers(): string[] { return Object.keys(CONTRACT.renderers); }
export function contractSurfaces(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(SURFACES).map(([name, list]) => [name, [...list]]));
}
/** Category rows (`when` criteria and renderer preference) for a decider's instruction. */
export function contractCategories(): Array<{ choice: UiPresentationChoice; when: string; renderers: string[] }> {
  return UI_PRESENTATION_CHOICES.map((choice) => ({ choice, when: CATEGORIES[choice].when, renderers: [...CATEGORIES[choice].renderers] }));
}

export function isUiPresentationChoice(value: unknown): value is UiPresentationChoice {
  return typeof value === "string" && (UI_PRESENTATION_CHOICES as readonly string[]).includes(value);
}

export function isUiPresentationSurface(value: unknown): value is UiPresentationSurface {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SURFACES, value);
}

/** The renderers the screen can draw, in the contract's order. */
export function surfaceRenderers(surface: UiPresentationSurface): UiPresentationRenderer[] {
  return [...(SURFACES[surface] ?? [])] as UiPresentationRenderer[];
}

/**
 * decision.renderer: the first of the category's `renderers` that the surface lists; none listed = `markdown`
 * (the answer is text). Unknown surface = nothing is listed = markdown.
 */
export function resolveRenderer(choice: UiPresentationChoice, surface: UiPresentationSurface): UiPresentationRenderer {
  const listed = SURFACES[surface] ?? [];
  const first = CATEGORIES[choice].renderers.find((renderer) => listed.includes(renderer));
  return (first ?? "markdown") as UiPresentationRenderer;
}

function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  // Never end in half of a surrogate pair.
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * The decider's input (contract `question.input`): the last `maxMessages` person/assistant messages that have text, oldest first,
 * each cut to `maxCharsPerMessage`. Text only: system rows, tool results, code and files never enter.
 */
export function presentationDecisionInput(history: ReadonlyArray<{ role?: unknown; text?: unknown }>): UiPresentationMessage[] {
  const withText: UiPresentationMessage[] = [];
  for (const row of history) {
    if ((row.role !== "user" && row.role !== "assistant") || typeof row.text !== "string" || !row.text.trim()) continue;
    withText.push({ role: row.role, text: row.text });
  }
  return withText.slice(-UI_PRESENTATION_MAX_MESSAGES)
    .map((message) => ({ role: message.role, text: cutText(message.text, UI_PRESENTATION_MAX_CHARS_PER_MESSAGE) }));
}
