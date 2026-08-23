/*
 * 모델 하나에 붙일 벤더 로고.
 *
 * ── 왜 필요한가 ──
 * 모델 목록이 글자만 스무 줄이면 고르는 사람이 훑어야 한다. 로고가 붙으면 아는 회사를
 * 눈으로 먼저 찾는다(오너 지시 2026-08-24: "모델 명과 모델 로고").
 *
 * ── 판정 기준 ──
 * 모델 id 는 벤더 접두사를 갖는 경우가 많고(`openai.…`, `us.anthropic.…`), 그렇지 않으면
 * 런타임·백엔드가 벤더를 말해 준다. 둘 다 아니면 **null 을 돌려준다** — 모르는 것을
 * 아무 로고나 붙여 아는 척하지 않는다. 화면은 그때 기본 아이콘을 그린다.
 *
 * 자산이 없는 벤더도 null 이다. 로고 파일을 넣기 전까지는 글자만 나오는 것이 맞다.
 */

/** `renderer/public/brand/llm/` 에 실제로 있는 파일만 적는다. 없는 것을 가리키면 깨진 이미지가 뜬다. */
const LOGO_FILES: Record<string, string> = {
  anthropic: "anthropic.svg",
  claude: "claude.svg",
  openai: "openai.svg",
  googlegemini: "googlegemini.svg",
  deepseek: "deepseek.svg",
  kimi: "kimi.svg",
  ollama: "ollama.svg",
  cursor: "cursor.svg",
  githubcopilot: "githubcopilot.svg",
  x: "x.svg",
  zai: "zai.png",
  zhipu: "zhipu.png",
};

/** 먼저 맞는 것이 이긴다 — 좁은 표식을 위에 둔다. */
const VENDOR_RULES: Array<{ match: RegExp; logo: keyof typeof LOGO_FILES }> = [
  { match: /\b(claude|anthropic)\b|^us\.anthropic\./i, logo: "claude" },
  { match: /\b(gpt|codex|openai|o[34]-mini)\b|^openai\./i, logo: "openai" },
  { match: /\b(gemini|gemma|antigravity)\b|^google\./i, logo: "googlegemini" },
  { match: /\bdeepseek\b/i, logo: "deepseek" },
  { match: /\b(kimi|moonshot(ai)?)\b/i, logo: "kimi" },
  { match: /\b(glm|zai)\b|^zai\./i, logo: "zai" },
  { match: /\bzhipu\b/i, logo: "zhipu" },
  { match: /\b(grok|xai)\b/i, logo: "x" },
  { match: /\bollama\b/i, logo: "ollama" },
  { match: /\bcursor\b/i, logo: "cursor" },
  { match: /\bcopilot\b/i, logo: "githubcopilot" },
];

/**
 * 모델·런타임에서 로고 주소를 고른다. 모르면 null.
 *
 * 모델 id 를 먼저 본다 — 같은 런타임이 여러 벤더의 모델을 돌릴 수 있기 때문이다
 * (예: 한 창구에서 여러 회사 모델을 고르는 경우, 런타임 이름으로 판정하면 전부 같은 로고가 된다).
 */
export function llmLogoSrc(input: {
  model?: string | null;
  backend?: string | null;
  kind?: string | null;
}): string | null {
  for (const candidate of [input.model, input.backend, input.kind]) {
    const value = (candidate ?? "").trim();
    if (!value) continue;
    const rule = VENDOR_RULES.find((entry) => entry.match.test(value));
    if (rule) return `/brand/llm/${LOGO_FILES[rule.logo]}`;
  }
  return null;
}
