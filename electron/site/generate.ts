// 사이트 디자인 스튜디오 — 생성/수정 엔진.
// 디자인 두뇌는 로컬 페르소나가 아니라 **Hub 에이전트 "웹앱 디자인 마스터"(web-master)**다:
// runMcpInvocation + borrowAgents(hep-call BYOM)로 빌려와 활성 런타임에서 실행한다.
// 이 모듈은 (1) 프로젝트별 division 챗 세션에서 에이전트를 호출하고 (2) 렌더 가능성을
// 지키는 출력 계약 검증 + 부분 patch 적용만 담당한다 — 디자인 독트린은 에이전트 소유.
import {
  extractSiteHtmlFromReply,
  validateSiteScreenHtml,
} from "../../shared/site-studio";
import { tagSiteHtml } from "./html-tagger";

/** 사이트 앱에 붙은 Hub 에이전트 슬러그 (cloud-callable, hep-call로 빌림). */
export const SITE_DESIGN_AGENT_SLUG = "web-master";

const INVOKE_TIMEOUT_MS = 600_000;

type SiteLocale = "ko" | "en";

export interface SiteGenerateResult {
  ok: boolean;
  html?: string;
  /** 실행 주체 라벨 — Hub 에이전트 슬러그. */
  engine?: string;
  reason?: string;
}

export interface SiteEditResult extends SiteGenerateResult {
  mode?: "patch" | "full";
}

/**
 * 웹앱 디자인 마스터 호출 1회 — 프로젝트 전용 division 챗(히스토리=프로젝트 연속성)에서
 * borrow 지시(hep-call이 가져온 에이전트 실지시문)와 함께 활성 런타임으로 실행.
 * 명명된 원격 에이전트이므로 로컬 폴백은 없다 — 실패는 이유와 함께 그대로 보고.
 */
async function runSiteAgentPrompt(
  projectId: string,
  prompt: string,
  locale: SiteLocale,
): Promise<{ text?: string; engine: string; reason?: string }> {
  const { getOrCreateSiteSession } = await import("../store/chats");
  const { runMcpInvocation } = await import("../mcp/client");
  const chat = getOrCreateSiteSession(projectId);
  let finalText = "";
  let errorMessage: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INVOKE_TIMEOUT_MS);
  try {
    const result = await runMcpInvocation(
      {
        chatId: chat.id,
        userPrompt: prompt,
        borrowAgents: [SITE_DESIGN_AGENT_SLUG],
        permissions: "read",
        locale,
      },
      (ev) => {
        if (ev.kind === "final" && typeof ev.text === "string" && ev.text.trim()) {
          finalText = ev.text;
        } else if (ev.kind === "error" && ev.error) {
          errorMessage = ev.error.message;
        }
      },
      controller.signal,
    );
    const text = (result?.finalText || finalText || "").trim();
    if (text) return { text, engine: SITE_DESIGN_AGENT_SLUG };
    return { engine: SITE_DESIGN_AGENT_SLUG, reason: errorMessage ?? "no-final-text" };
  } catch (err) {
    return {
      engine: SITE_DESIGN_AGENT_SLUG,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 출력 계약(하드 룰)만 — 디자인 방향/품질 지시는 넣지 않는다. 그건 에이전트의 영역.
 * 이 계약은 산출물이 sandbox iframe에서 결정적으로 렌더되기 위한 기술 조건이다.
 */
function outputContract(): string {
  return [
    "OUTPUT CONTRACT (hard technical rules — a validator rejects violations; everything the contract does not constrain is governed by YOUR own design doctrine and skills):",
    "- Output EXACTLY ONE complete self-contained HTML5 document: <!doctype html><html><head>…</head><body>…</body></html>, wrapped in a single ```html fenced code block. No prose before or after the fence.",
    "- ALL CSS inline in <style> tag(s) in <head>. No external resources of any kind: no CDN, no <link href>, no <script src>, no <img src=\"http…\">, no @import, no url(http…), no iframes, no web fonts.",
    "- Fonts: system font stacks only. Images/graphics: inline SVG or pure CSS only (no image files, no heavy base64 photos).",
    "- JavaScript: small inline <script> for light interactions only. No fetch/XHR/WebSocket/polling.",
    "- The design must render correctly at 375px and 1280px viewports.",
  ].join("\n");
}

function buildGeneratePrompt(
  brief: string,
  styleHint: string | null,
  baseHtml: string | null,
  retryErrors: string[] | null,
): string {
  return [
    "TASK: design ONE production-grade web screen for the brief below, at the level of your best award-grade work.",
    `BRIEF: ${brief}`,
    styleHint ? `STYLE DIRECTION (from the user): ${styleHint}` : "",
    baseHtml
      ? `EXISTING SCREEN (match its visual language — palette, typography, spacing — so the new screen belongs to the same product):\n\`\`\`html\n${baseHtml}\n\`\`\``
      : "",
    retryErrors && retryErrors.length
      ? `YOUR PREVIOUS OUTPUT WAS REJECTED by the validator for these reasons — fix them all and output the corrected document:\n- ${retryErrors.join("\n- ")}`
      : "",
    outputContract(),
    "Now output the single fenced HTML document.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function generateOnce(projectId: string, prompt: string, locale: SiteLocale): Promise<SiteGenerateResult> {
  const run = await runSiteAgentPrompt(projectId, prompt, locale);
  if (!run.text) return { ok: false, reason: run.reason ?? "no-final-text", engine: run.engine };
  const html = extractSiteHtmlFromReply(run.text);
  if (!html) return { ok: false, reason: "no-document", engine: run.engine };
  const contract = validateSiteScreenHtml(html);
  if (!contract.ok) return { ok: false, reason: contract.errors.join("; "), engine: run.engine };
  return { ok: true, html, engine: run.engine };
}

export async function generateSiteScreen(input: {
  projectId: string;
  brief: string;
  styleHint?: string | null;
  baseHtml?: string | null;
  locale?: SiteLocale;
}): Promise<SiteGenerateResult> {
  const brief = (input.brief || "").trim().slice(0, 4_000);
  if (!brief) return { ok: false, reason: "empty-brief" };
  const locale: SiteLocale = input.locale === "en" ? "en" : "ko";
  const baseHtml = (input.baseHtml || "").slice(0, 60_000) || null;
  const styleHint = (input.styleHint || "").trim().slice(0, 500) || null;

  const first = await generateOnce(input.projectId, buildGeneratePrompt(brief, styleHint, baseHtml, null), locale);
  if (first.ok || first.reason === "no-final-text") return first;
  // 계약 위반/문서 누락 — 검증 오류를 피드백으로 1회 재시도.
  const retry = await generateOnce(
    input.projectId,
    buildGeneratePrompt(brief, styleHint, baseHtml, [first.reason || "contract violation"]),
    locale,
  );
  return retry.ok ? retry : { ...retry, reason: retry.reason || first.reason };
}

function buildEditPrompt(
  sourceHtml: string,
  instruction: string,
  selection: { tagName: string; snippet: string } | null,
  retryErrors: string[] | null,
): string {
  return [
    "TASK: modify the screen below according to the instruction. Preserve the existing art direction and keep everything else pixel-identical — do not re-theme unless the instruction asks for it.",
    `CURRENT SCREEN:\n\`\`\`html\n${sourceHtml}\n\`\`\``,
    selection
      ? [
          `SELECTED ELEMENT (the user pointed at this <${selection.tagName}> — the instruction targets it):`,
          "```html",
          selection.snippet,
          "```",
          `PREFERRED OUTPUT — PARTIAL PATCH: if the change can be fully expressed inside the selected element, output ONLY the replacement outer HTML of that single <${selection.tagName}> element in one \`\`\`html fence (it will be spliced in place). If the change requires touching CSS in <head> or other parts of the page, output the FULL corrected document instead.`,
        ].join("\n")
      : "OUTPUT: the FULL corrected document in one ```html fence.",
    `INSTRUCTION: ${instruction}`,
    retryErrors && retryErrors.length
      ? `YOUR PREVIOUS OUTPUT WAS REJECTED:\n- ${retryErrors.join("\n- ")}\nOutput the corrected result.`
      : "",
    outputContract(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type SiteEditSelection = { tagName: string; snippet: string; start: number; end: number };

/** selectionId("a"+소스오프셋)를 현재 소스 기준 요소 범위로 재해석(스테일 오프셋 방지). */
export function resolveSiteSelection(sourceHtml: string, selectionId: string | null | undefined): SiteEditSelection | null {
  if (!selectionId) return null;
  const { elements } = tagSiteHtml(sourceHtml);
  const el = elements.find((e) => e.id === selectionId);
  if (!el) return null;
  return {
    tagName: el.tagName,
    start: el.start,
    end: el.end,
    snippet: sourceHtml.slice(el.start, Math.min(el.end, el.start + 6_000)),
  };
}

export function extractElementBlockFromReply(reply: string, tagName: string): string | null {
  const fence = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(reply);
  const candidate = (fence ? fence[1] : reply).trim();
  if (/<!doctype\s+html|<html[\s>]/i.test(candidate)) return null; // 전체 문서 — patch 아님
  const open = new RegExp(`<${tagName}[\\s>/]`, "i");
  const at = candidate.search(open);
  if (at < 0) return null;
  const block = candidate.slice(at).trim();
  // 닫힘 검증: 같은 태그의 close가 있거나 self-closing/void면 통과.
  const hasClose = new RegExp(`</${tagName}\\s*>\\s*$`, "i").test(block);
  const selfClosed = /\/>\s*$/.test(block);
  if (!hasClose && !selfClosed) return null;
  return block;
}

/**
 * 모델 응답을 소스에 적용 — 선택이 있으면 부분 patch(요소 블록 splice) 우선,
 * 응답이 전체 문서면 full 교체. 결과는 항상 계약 검증을 통과해야 한다. (순수 함수 — 테스트 대상)
 */
export function applySiteEditReply(
  sourceHtml: string,
  selection: SiteEditSelection | null,
  replyText: string,
  engine: string,
): SiteEditResult {
  if (selection) {
    const block = extractElementBlockFromReply(replyText, selection.tagName);
    if (block) {
      const patched = sourceHtml.slice(0, selection.start) + block + sourceHtml.slice(selection.end);
      const contract = validateSiteScreenHtml(patched);
      if (contract.ok) return { ok: true, html: patched, engine, mode: "patch" };
      return { ok: false, reason: contract.errors.join("; "), engine };
    }
  }
  const full = extractSiteHtmlFromReply(replyText);
  if (!full) return { ok: false, reason: "no-document", engine };
  const contract = validateSiteScreenHtml(full);
  if (!contract.ok) return { ok: false, reason: contract.errors.join("; "), engine };
  return { ok: true, html: full, engine, mode: "full" };
}

/**
 * 선택 요소 기준 부분 patch 우선 수정. selectionId는 태거가 부여한 data-agentlas-id
 * ("a"+소스오프셋) — 오프셋 범위는 resolveSiteSelection이 현재 소스로 재계산한다.
 */
export async function editSiteScreen(input: {
  projectId: string;
  sourceHtml: string;
  instruction: string;
  selectionId?: string | null;
  locale?: SiteLocale;
}): Promise<SiteEditResult> {
  const instruction = (input.instruction || "").trim().slice(0, 4_000);
  if (!instruction) return { ok: false, reason: "empty-instruction" };
  const locale: SiteLocale = input.locale === "en" ? "en" : "ko";
  const sourceHtml = input.sourceHtml;
  const selection = resolveSiteSelection(sourceHtml, input.selectionId);

  const promptSelection = selection ? { tagName: selection.tagName, snippet: selection.snippet } : null;
  const first = await runSiteAgentPrompt(
    input.projectId,
    buildEditPrompt(sourceHtml, instruction, promptSelection, null),
    locale,
  );
  if (!first.text) return { ok: false, reason: first.reason ?? "no-final-text", engine: first.engine };
  const applied = applySiteEditReply(sourceHtml, selection, first.text, first.engine);
  if (applied.ok) return applied;

  const retryRun = await runSiteAgentPrompt(
    input.projectId,
    buildEditPrompt(sourceHtml, instruction, promptSelection, [applied.reason || "contract violation"]),
    locale,
  );
  if (!retryRun.text) return applied;
  const retried = applySiteEditReply(sourceHtml, selection, retryRun.text, retryRun.engine);
  return retried.ok ? retried : { ...retried, reason: retried.reason || applied.reason };
}

/** UI 게이팅 — 활성 런타임 존재 여부 + 붙어 있는 Hub 에이전트 슬러그. */
export async function siteEngineStatus(): Promise<{ ready: boolean; agent: string }> {
  try {
    const { pickActiveRunner } = await import("../mcp/client");
    const picked = await pickActiveRunner();
    return { ready: !!picked, agent: SITE_DESIGN_AGENT_SLUG };
  } catch {
    return { ready: false, agent: SITE_DESIGN_AGENT_SLUG };
  }
}
