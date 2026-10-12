// Always-on instruction lines for the shared system prompt (wrapSystemPrompt).
//
// Owner 2026-10-13: prompts keep shrinking and the host does what it can. Nothing here is loaded by a
// keyword list over the user's text any more: the connection rule is one paragraph on every turn, and
// reference material the model may want (the Intellect UI schema) is fetched through a read-only tool
// (`read_ui_schema`, electron/ui-schema/mcp-server.ts). MEDIA_INTENT survives only for Codex's own
// image contract in codex.ts.
import { CONNECTION_CORE_RULE } from "./global-skill";

export { CONNECTION_CORE_RULE };

/** Image / video / audio generation or editing. Used only for Codex's own image contract (codex.ts). */
const MEDIA_INTENT =
  /\b(image|images|img|picture|photo|photograph|draw|drawing|illustrat\w*|logo|icon|thumbnail|poster|banner|mockup|wallpaper|video|clip|movie|animation|animate|audio|voice|speech|tts|narrat\w*|podcast|music|song|sound|dall-?e|midjourney|sora|veo|nanobanana|imagen|image_gen)\b|이미지|사진|그림|그려|영상|비디오|동영상|음성|음악|목소리|낭독|내레이션|로고|아이콘|일러스트|썸네일|포스터|배너|목업|애니메이션|효과음|노래/i;

export interface PromptSectionPlan {
  /** Codex's built-in image generation contract rides this turn (codex.ts). */
  media: boolean;
}

export function planPromptSections(gateText: string | undefined): PromptSectionPlan {
  if (gateText === undefined) return { media: true };
  return { media: MEDIA_INTENT.test(gateText) };
}

/**
 * Always-on UI line. The component schema is NOT in any prompt: whether a turn needs it is the model's
 * decision, not a keyword list over the user's text. The model calls the read-only `read_ui_schema`
 * tool (agentlas-ui built-in MCP, attached to every ordinary turn) when it wants to draw a component.
 */
export const INTELLECT_UI_CORE_RULE = [
  "## Intellect UI",
  "Chat renders tables, comparisons, flows, metrics, charts and choices from `agentlas-ui`, ```chart or ```visual fences. When one beats prose, call `read_ui_schema` first and follow it; never emit one unread. For an interactive surface the user will return to (tracker, dashboard, console), call `read_surface_protocol` first.",
].join("\n");

/** No tools exist in a restricted read boundary, so the schema cannot be read: prose only. */
export const INTELLECT_UI_UNAVAILABLE_RULE = [
  "## Intellect UI",
  "UI blocks (agentlas-ui, chart, visual) and surfaces are unavailable in this mode; answer in prose.",
].join("\n");

/** The connection rule is the same on every turn: no keyword-loaded playbook. */
export function connectionSectionText(): string {
  return CONNECTION_CORE_RULE;
}

export function intellectUiSectionText(options?: { toolless?: boolean }): string {
  return options?.toolless ? INTELLECT_UI_UNAVAILABLE_RULE : INTELLECT_UI_CORE_RULE;
}

/** No section is loaded on demand any more; kept for the stateless-prefix and resident-session callers. */
export function onDemandSectionTurnBlocks(_gateText?: string, _locale?: string): string[] {
  return [];
}

const IMAGE_COPY_RULE = "The host copies every generated image into the working folder's `assets/` directory and reports that path. Use that path for later steps (browser uploads, documents, slides); do not look for images in the runtime's private image store.";
const IMAGE_HONESTY_RULE = "Say an image was generated only after a tool or your image generation actually returned one; if it failed, say so and preserve the reason. Never claim an image is above, attached, or displayed without that result.";

/**
 * Image output contract for runtimes with their own image generation (Codex). `hostToolName` names the
 * Agentlas image tool when one is attached to the thread; without it the runtime's built-in generation is used.
 */
export function imageOutputContract(hostToolName?: string): string {
  return hostToolName
    ? [
        "## Agentlas image output contract",
        `To create or edit an image, call the host tool \`${hostToolName}\` (the owner's configured image engine) or use your own built-in image generation.`,
        IMAGE_COPY_RULE,
        IMAGE_HONESTY_RULE,
      ].join("\n")
    : [
        "## Agentlas image output contract",
        "No host image-generation tool is attached to this thread. Use your own built-in image generation when an image is needed.",
        IMAGE_COPY_RULE,
        IMAGE_HONESTY_RULE,
      ].join("\n");
}
