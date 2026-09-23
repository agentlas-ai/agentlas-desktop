/**
 * 런타임이 **내장으로** 제공하는 graph capability — 사실의 목록(카탈로그)이지 케이스 분기가 아니다.
 *
 * graph-tool-binding의 PROVIDER_CATALOG와 같은 지위다: 제공자 목록에 실행 런타임을
 * 더한 것. capability 해소(requirementStatus)는 이 목록을 "연결된 제공자" 중 하나로
 * 열거한다 — 특정 MCP 하나에 capability를 고정하지 않기 위한 조각이다.
 *
 * 항목을 더할 때는 실측 근거를 적을 것.
 *  - web.search: claude-code WebSearch 도구 · codex web search · antigravity GoogleSearch (실측 2026-08-06).
 *  - image.generate: codex 내장 image_gen (feature `image_generation` stable, app-server `imageGeneration`
 *    아이템 — `codex app-server generate-ts` 0.156.1 ImageGenerationItem.savedPath) · antigravity generate_image
 *    (antigravity.ts 가 결과를 generated-assets 로 옮긴다). claude-code 는 그림 도구가 없다 — 멀티모달 슬롯이
 *    준비됐을 때만 호스트 generate_image 도구를 따로 받는다(여기 적지 않는다).
 *  - shell/file.edit: 세 CLI 모두 쓰기 권한에서 셸·파일 편집을 내장한다.
 */
export const RUNTIME_NATIVE_CAPABILITIES: Record<string, string[]> = {
  "claude-code": ["web.search", "web.fetch", "shell", "file.edit"],
  codex: ["web.search", "image.generate", "shell", "file.edit"],
  antigravity: ["web.search", "image.generate", "shell", "file.edit"],
};

const ABILITY_WORDS: Record<string, string> = {
  "web.search": "built-in web search",
  "web.fetch": "built-in web page fetch",
  "image.generate": "built-in image generation (save the image into the working folder's assets/ and cite that path)",
  shell: "shell commands (within the granted permission)",
  "file.edit": "file reading and editing (within the granted permission)",
};

/**
 * One line telling the running model what it can do by itself, so a plugin
 * skill (for example a design ideation workflow that needs a renderer) finds
 * the runtime's own ability instead of reporting it missing. Empty when the
 * runtime has no catalogued native ability.
 */
export function runtimeNativeAbilitiesLine(runtimeKind: string | null | undefined, extra: readonly string[] = []): string {
  const abilities = [...(runtimeKind ? RUNTIME_NATIVE_CAPABILITIES[runtimeKind] ?? [] : []), ...extra];
  const words = [...new Set(abilities)].map((ability) => ABILITY_WORDS[ability]).filter(Boolean);
  if (!words.length) return "";
  return `Native abilities of this runtime (use them directly and combine them with plugins and MCP tools): ${words.join("; ")}.`;
}
