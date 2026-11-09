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

/**
 * What every runtime that can run a step provides, whatever its kind: reading and writing files on this computer. The CLIs
 * read and edit files themselves; an API or local-model lane gets the host's read_file / write_file / edit_file built-in tools
 * (shared/builtin-tools.ts). `files.read` / `files.write` were met only by the optional `filesystem` MCP server, so a graph
 * step that declared them could not be turned on or run until the owner installed it: "Not connected yet, so this cannot be
 * turned on: This computer" (one_graph_run, production). Empty when no runtime is detected: nothing could run.
 */
export const RUNTIME_BASELINE_CAPABILITIES: readonly string[] = ["files.read", "files.write"];

/** The graph capabilities the detected runtimes provide themselves (tool-inventory.ts hands this to requirementStatus). */
export function runtimeCapabilitiesFor(kinds: readonly string[]): string[] {
  if (kinds.length === 0) return [];
  return [...new Set([...kinds.flatMap((kind) => RUNTIME_NATIVE_CAPABILITIES[kind] ?? []), ...RUNTIME_BASELINE_CAPABILITIES])];
}

const ABILITY_WORDS: Record<string, string> = {
  "web.search": "web search",
  "web.fetch": "web fetch",
  // No "image.generate" word: the model picks an image tool when the task needs one, and the host copies what the CLI saved;
  // the capability stays in RUNTIME_NATIVE_CAPABILITIES for graph requirements.
  shell: "shell",
  "file.edit": "file edit",
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
  return words.join(", ");
}
