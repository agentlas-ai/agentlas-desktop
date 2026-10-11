// On-demand instruction sections for the shared system prompt (wrapSystemPrompt).
//
// Why this exists: every model request carried ~2.7k tokens (account-connecting playbook 1,571 +
// Intellect UI schema 1,079, measured o200k_base) whether or not the turn had anything to do with
// connecting an account or drawing a chart. Each section now has
//   - a tiny always-on CORE line holding the rule that must never be missing, and
//   - a FULL body that is added only when the feature is used.
//
// "Used" is decided from the cumulative user text (cumulativeSurfaceGateText), exactly like the
// Surface protocol gate: the decision is monotone within a conversation, so the system bytes only
// ever grow once and the prompt-cache prefix stays stable. Callers that pass no text (legacy
// callers) get every section, as before.
import {
  CONNECTION_INTRO_LINES,
  CONNECTION_PLAYBOOK_LINES,
  MEDIA_ROUTING_LINES,
} from "./global-skill";
import { intellectUiPrompt } from "../../shared/intellect-ui-prompt";

/** Providers and verbs that mean the task is about reaching a third-party account or service. */
const CONNECTION_INTENT =
  /\b(connect(?:ion|ing|ed)?|integrat\w*|log ?in|sign ?(?:in|up)|oauth|api|token|credential|secret|webhook|password|passkey|2fa|captcha|account|payment|checkout|billing|slack|gmail|google|notion|github|gitlab|stripe|discord|telegram|firebase|openai|anthropic|twitter|instagram|youtube|facebook|linkedin|shopify|aws|vercel|supabase|cloudflare|airtable|trello|jira|zapier|elevenlabs|paypal|kakao|naver)\b|api[ _-]?key|연결|연동|계정|로그인|가입|인증|발급|토큰|결제|웹훅|비밀번호|슬랙|지메일|구글|노션|깃허브|스트라이프|디스코드|텔레그램|파이어베이스|인스타|유튜브|페이스북|링크드인|카카오|네이버|키를|키 ?값/i;

/** Image / video / audio generation or editing: the only turns that touch the multimodal routing rules. */
const MEDIA_INTENT =
  /\b(image|images|img|picture|photo|photograph|draw|drawing|illustrat\w*|logo|icon|thumbnail|poster|banner|mockup|wallpaper|video|clip|movie|animation|animate|audio|voice|speech|tts|narrat\w*|podcast|music|song|sound|dall-?e|midjourney|sora|veo|nanobanana|imagen|image_gen)\b|이미지|사진|그림|그려|영상|비디오|동영상|음성|음악|목소리|낭독|내레이션|로고|아이콘|일러스트|썸네일|포스터|배너|목업|애니메이션|효과음|노래/i;

/** Charts, comparisons, diagrams, calculators and choice controls: where the agentlas-ui schema is needed. */
const UI_INTENT =
  /\b(chart|charts|graph|plot|diagram|flowchart|visuali[sz]\w*|compar\w*|versus|vs|table|calculator|calculate|calculation|simulat\w*|slider|dashboard|metric|trend|breakdown|agentlas-ui|options?|choose|choice|pros and cons|tradeoffs?)\b|차트|그래프|도표|다이어그램|시각화|비교|표로|표를|표 |계산|계산기|시뮬|슬라이더|지표|추이|추세|선택지|장단점|항목별/i;

/** Marker an earlier assistant turn leaves when it already used the native UI blocks. */
const UI_FENCE = "```agentlas-ui";

export interface PromptSectionPlan {
  /** "full" = the whole playbook (and provider addresses); "core" = the compact rule only. */
  connection: "core" | "full";
  /** Generative image/video/audio routing rules. */
  media: boolean;
  /** The agentlas-ui component schema. */
  intellectUi: boolean;
}

export function planPromptSections(gateText: string | undefined): PromptSectionPlan {
  // Legacy callers (no text) keep every section.
  if (gateText === undefined) return { connection: "full", media: true, intellectUi: true };
  return {
    connection: CONNECTION_INTENT.test(gateText) ? "full" : "core",
    media: MEDIA_INTENT.test(gateText),
    intellectUi: UI_INTENT.test(gateText) || gateText.includes(UI_FENCE),
  };
}

/**
 * Always-on connection rule. Every safety invariant of the full playbook is here in one paragraph;
 * the playbook only adds the step-by-step hand-holding, so a turn that never mentions a service
 * still cannot leak a secret, skip a payment pause, or dead-end with "there is no API".
 */
export const CONNECTION_CORE_RULE = [
  "## Connecting accounts",
  "When a task needs a third-party service, never stop at \"there is no API/MCP/connector\": reuse an installed, permitted connector or authorized browser tool, prepare integration code locally when authorized, or name the exact missing secure boundary. Account creation, new grants or scopes, key generation/storage, security changes and provider charges need the user's dedicated native confirmation; before a payment, pause and state merchant, amount, currency and recurrence. The user alone enters a credential, in the provider's protected page or the native Vault input; never ask for, read, copy or store one through chat, tools, shell, files, environment variables or memory. Never bypass a CAPTCHA or 2FA: save progress, hand it to the user with the exact action, wait a bounded time. Speak plainly to non-technical users and avoid the words API, MCP, token and OAuth. The detailed account-connecting playbook is added automatically when a request is about connecting a service.",
].join("\n");

/** Always-on UI line: the model may not emit agentlas-ui blocks unless the schema is present. */
export const INTELLECT_UI_CORE_RULE = [
  "## Intellect UI",
  "Chat can render native interactive components (charts, comparisons, diagrams, calculators, choices) from a fenced `agentlas-ui` block. The component schema is added automatically when the request calls for them; do not emit an `agentlas-ui` block unless that schema is present below.",
].join("\n");

export function connectionSectionText(plan: PromptSectionPlan): string {
  if (plan.connection === "core") {
    return plan.media ? [CONNECTION_CORE_RULE, ...MEDIA_ROUTING_LINES].join("\n") : CONNECTION_CORE_RULE;
  }
  return [
    ...CONNECTION_INTRO_LINES,
    ...(plan.media ? MEDIA_ROUTING_LINES : []),
    ...CONNECTION_PLAYBOOK_LINES,
  ].join("\n");
}

export function intellectUiSectionText(plan: PromptSectionPlan, locale?: string): string {
  return plan.intellectUi ? intellectUiPrompt(locale) : INTELLECT_UI_CORE_RULE;
}

/**
 * Sections a stateless-prefix runtime carries in the current turn instead of the retained system
 * prefix (retainedResponsesPromptPacket): everything the plan loads beyond the always-on core.
 */
export function onDemandSectionTurnBlocks(gateText: string | undefined, locale?: string): string[] {
  const plan = planPromptSections(gateText);
  const blocks: string[] = [];
  if (plan.connection === "full") blocks.push(connectionSectionText(plan));
  else if (plan.media) blocks.push(MEDIA_ROUTING_LINES.join("\n"));
  if (plan.intellectUi) blocks.push(intellectUiPrompt(locale));
  return blocks;
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
