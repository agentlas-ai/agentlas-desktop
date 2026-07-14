// T-rex 슬라이드 "내용" 생성 — 연결된 LLM(agy/codex, 키리스)이 슬라이드별 실제 카피·수치를
// 구조화 JSON으로 작성한다. 렌더러는 이 JSON을 parseDeckContent→buildDeckFromContent로 렌더.
// agy(Antigravity)가 깔끔한 JSON을 잘 뽑아 우선, 없으면 codex.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withCliPath, writeStdin } from "../runtime/exec";
import {
  deriveOpenCrabMatchSignal,
  queryOpenCrabContext,
  type OpenCrabMatchSignal,
} from "../opencrab/ontology";
import type { OpenCrabEnrichment } from "../../shared/types";

export interface TrexContentResult {
  ok: boolean;
  text?: string; // 원본 JSON 텍스트(렌더러가 parseDeckContent로 파싱)
  engine?: "agent" | "agy" | "codex";
  reason?: string;
  openCrab?: OpenCrabEnrichment;
}

function resolveBin(name: string, extra: string[]): string | null {
  const fromPath = (process.env.PATH || "").split(":").filter(Boolean).map((d) => path.join(d, name));
  for (const c of [...extra, ...fromPath]) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function buildPrompt(
  topic: string,
  count: number,
  mode?: string,
  sources?: string,
  openCrabSignal?: OpenCrabMatchSignal,
): string {
  // 클로징("감사합니다") 장표 폐기 — 덱 = 커버 1장 + 본문 (count-1)장, 마지막은 statement로 닫는다.
  const middle = Math.max(3, Math.min(13, count - 1));
  const modeLine = mode ? `Set "mode" to ${mode}.` : `Pick "mode" by topic: cinematic(narrative), editorial(business), diagrammatic(academic), hybrid(sports/data).`;
  const src = (sources || "").trim();
  return [
    "You are an expert presentation content designer. Output ONLY valid minified JSON — no markdown, no code fences, no prose before or after.",
    `TOPIC: ${topic}`,
    src
      ? `SOURCE MATERIAL (build the deck FROM these attached documents — use their real facts, figures, names, and structure; do NOT invent content that contradicts them; the TOPIC above is the framing/angle):\n${src}`
      : "",
    openCrabSignal?.evidenceCount
      ? `OPTIONAL OPENCRAB MATCH SIGNAL (main-owned metadata only; no ontology text is included; use it only to prioritize verification of user-authored terms):\n${JSON.stringify(openCrabSignal)}`
      : "",
    'SCHEMA: {"title":str,"subtitle":str,"mode":"cinematic|editorial|diagrammatic|hybrid","styleId":"consulting|swiss|bauhaus|didot|vignelli|brutal|hara","slides":[ {"role":"agenda","title":str,"items":[str],"note":str,"img":str} | {"role":"metrics","dek":str,"src":str,"layout":"row|bento|asym","title":str,"kpis":[{"value":str,"label":str}],"note":str,"img":str} | {"role":"comparison","dek":str,"src":str,"layout":"bars|asym","title":str,"bars":[{"label":str,"value":int}],"note":str,"img":str} | {"role":"structure","dek":str,"src":str,"layout":"columns|bento|split|zigzag|twopanel","title":str,"cards":[{"label":str,"text":str}],"panels":[{"title":str,"rows":[{"label":str,"text":str,"sub":str}]}],"note":str,"img":str} | {"role":"process","dek":str,"src":str,"layout":"timeline|cards","title":str,"steps":[{"label":str,"text":str}],"note":str,"img":str} | {"role":"highlight","dek":str,"src":str,"title":str,"stat":{"value":str,"label":str},"text":str,"img":str} | {"role":"statement","text":str,"note":str,"img":str} ]}',
    '- "layout" = page architecture. VARY it — never repeat the same layout on consecutive slides: bento(hero cell + small cells, dashboard feel), split(text left + image right half), zigzag(image/text alternating rows), asym(30% hero number + 70% detail), timeline(horizontal roadmap line), twopanel(two titled side-by-side panels with dense chip rows — the DENSEST, consulting/gov-report grammar for 실적/성과, 현황/개선 etc).',
    "RULES:",
    "- Write in the SAME language as the topic.",
    '- "styleId" = design school (art direction): consulting(Korean gov-briefing/MBB grammar — navy chapter band, titled panels, yellow highlighter, sources; THE DEFAULT for business plans, IR, 업무보고, strategy/finance/operations reviews), swiss(Müller-Brockmann grid+Helvetica — tech/pitch/strategy), bauhaus(primary-color geometry — creative/education/design), didot(Vogue serif+ivory — fashion/luxury/culture), vignelli(bold bands+hierarchy — reports/finance/ops), brutal(raw borders+mono — gaming/street/hackathon), hara(emptiness+whitespace — minimal/philosophy/wellness). Pick what a top art director would choose for this topic.',
    "- One idea per slide. Titles are ACTION CLAIMS, not topic labels.",
    "- Real, specific, concrete content — plausible real numbers and concrete claims, never placeholders like 'item 1'. Research-grade density: a reader should learn something from every slide.",
    `- Exactly ${middle} middle slides. Start with an "agenda", then a VARIED mix of metrics/comparison/structure/process/highlight (3-4 kpis/bars/cards/steps each — prefer 4). The LAST slide MUST be a "statement" (the one-line takeaway that closes the deck — no thank-you slide).`,
    '- "dek" (metrics/comparison/structure/process/highlight) = a one-line standfirst under the title (≤ 38 chars CJK / ≤ 80 latin): a NEW supporting fact or why-now, NOT a rephrase of the title or note.',
    "- EMPHASIS: wrap the single most decision-critical phrase in **double asterisks** — in the title AND in at most 2 body/card/step/note texts per slide (titles render as accent color, body as highlighter). NEVER more than 2 body marks per slide, never whole sentences.",
    '- "src" = short data-source footnote when the slide cites numbers (e.g. "출처: 중소벤처기업부, 2025.12"). Omit if no numbers.',
    '- "note" (every slide) = the SO-WHAT: one concrete conclusion/implication sentence (15-25 words CJK 30-50 chars) that a consultant would write at the bottom of the page.',
    '- agenda "items": 4-6 entries, each formatted "Title — one-line description" (em-dash separated).',
    '- "panels" (structure, consulting/report topics) = TWO side-by-side titled panels (e.g. 실적|성과, 현황|개선, Before|After), each with 4-5 dense "rows". Each row: "label" (2-6 char chip category), "text" (bold claim, may use **highlight**), optional "sub" (parenthetical detail/figure). Use this layout to hit government-report density — pack every panel with 4-5 rows.',
    '- cards "text": 1-2 short sentences (what it is + why it matters), ≤ 55 chars CJK / ≤ 110 latin. steps "text": a TERSE phrase (not a full sentence) ≤ 30 chars CJK / ≤ 60 latin — cards/timeline columns are narrow.',
    '- FIT-TO-BOX (critical): every text MUST fit its box. Text is NEVER truncated with an ellipsis — if a phrase feels long, you REWRITE it shorter using synonyms/omission (terse noun phrases beat full sentences). Prefer "규제특구 시범 → 기준선 확보" over "규제 특구 내 시범 운영으로 사고율·완주율 기준선을 만든다".',
    '- "img" (every slide) = a concrete photographable scene for an accompanying image, in English, no text/letters/numbers in the scene (e.g. "a delivery robot crossing a rainy Seoul crosswalk at dusk").',
    `- ${modeLine}`,
    src ? "- Prioritize the SOURCE MATERIAL for all facts/figures/quotes; keep the deck faithful to it." : "",
    "- LINE RULES (typography): titles ≤ 24 chars CJK / 7 words (must fit 1 line, 2 max). KPI labels ≤ 18 chars. Never phrase a sentence so its last line would be a single dangling word — rebalance the wording (no orphans/widows).",
  ]
    .filter(Boolean)
    .join("\n");
}

function runViaStdin(
  bin: string,
  args: string[],
  prompt: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    // 청크를 Buffer로 모아 한 번에 UTF-8 디코딩한다. 청크마다 toString하면
    // 멀티바이트 문자(한글=3바이트)가 청크 경계에서 쪼개져 U+FFFD로 깨진다.
    const chunks: Buffer[] = [];
    const collected = () => Buffer.concat(chunks).toString("utf8").trim();
    let done = false;
    let child: ReturnType<typeof spawn> | undefined;
    const kill = () => {
      try {
        child?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(v);
    };
    // 레이스에서 진 엔진은 abort로 즉시 죽인다 — 승자가 정해졌는데 140s 타임아웃까지 살아있는 낭비 방지.
    const onAbort = () => {
      kill();
      finish(null);
    };
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    try {
      // 패키지 GUI 앱은 로그인 셸 PATH를 상속 못해 최소 PATH다 — agy/codex가 자기 의존성(node 등)을
      // 못 찾아 조용히 실패하고 덱이 스켈레톤으로 떨어진다. withCliPath로 흔한 bin 디렉터리를 보강한다.
      child = spawn(bin, args, { env: withCliPath(env) });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      kill();
      finish(collected() || null);
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    child.on("close", () => finish(collected() || null));
    child.on("error", () => finish(null));
    writeStdin(child, prompt);
  });
}

function looksLikeDeckJson(out: string | null): boolean {
  return !!out && out.includes("{") && out.includes("}");
}

/** T-rex에 붙은 Hub 에이전트 — "Defect-Driven Slide Studio". Site의 web-master처럼 borrow해 실행한다.
 *  편집기는 나중에 손으로 고치는 용도고, 최초 제작(사용자 선택+소스 → 실제 덱)은 이 에이전트가 한다. */
export const TREX_SLIDE_AGENT_SLUG = "defect-driven-slide-studio";

/**
 * 붙은 Hub 에이전트를 활성 런타임(사용자 연결 LLM)으로 borrow 실행 — Site.generate.ts와 동일 경로라
 * PATH/인증을 런타임 레이어가 처리한다(패키지 GUI 앱에서도 견고). 에이전트의 슬라이드 지능으로
 * 콘텐츠를 만들되, 출력 계약은 T-rex 인앱 편집기가 먹는 JSON 스키마(prompt)로 강제한다.
 * 실패(에이전트 미가용/미차용/무출력)면 null 반환 → 호출부가 로컬 CLI 폴백.
 */
async function generateViaSlideAgent(
  prompt: string,
  locale: "ko" | "en",
  openCrabOptIn: boolean,
): Promise<string | null> {
  try {
    const { getOrCreateStudioSession } = await import("../store/chats");
    const { runMcpInvocation } = await import("../mcp/client");
    // An opt-in run has a separate persistent runtime/session pointer. Turning
    // OpenCrab off can therefore never resume or replay an earlier opt-in turn.
    const chat = getOrCreateStudioSession(openCrabOptIn ? "trex-opencrab" : "trex");
    let finalText = "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300_000);
    try {
      const result = await runMcpInvocation(
        {
          chatId: chat.id,
          userPrompt: prompt,
          borrowAgents: [TREX_SLIDE_AGENT_SLUG],
          permissions: "read",
          locale,
        },
        (ev) => {
          if (ev.kind === "final" && typeof ev.text === "string" && ev.text.trim()) finalText = ev.text.trim();
        },
        controller.signal,
      );
      const text = (result?.finalText || finalText || "").trim();
      return looksLikeDeckJson(text) ? text : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * 활성 런타임(사용자 연결 LLM: claude-code/codex/grok/gemini)으로 프롬프트 1회 실행.
 * 챗과 동일한 러너 레이어(spawnCli + withCliPath)를 타므로 PATH/인증이 처리돼 패키지 GUI 앱에서도 견고하다.
 * 붙은 에이전트가 아직 callable로 게시되지 않았을 때의 1급 폴백(T-rex 자체 콘텐츠 독트린을 그대로 실행).
 */
async function generateViaActiveRuntime(prompt: string, locale: "ko" | "en", signal?: AbortSignal): Promise<string | null> {
  try {
    const { detectRuntimes } = await import("../runtime/detect");
    const { pickActive, pickRunner } = await import("../runtime/selection");
    const active = pickActive(await detectRuntimes());
    if (!active) return null;
    const picked = pickRunner(active);
    if (!picked) return null;
    let out = "";
    const result = await picked.runner(
      {
        systemPrompt: "",
        history: [],
        userPrompt: prompt,
        backendLabel: picked.label,
        permission: "read",
        locale,
        ...(signal ? { signal } : {}),
      },
      { onPartial: (c) => { out += c; }, onStatus: () => {} },
    );
    const text = (result?.text || out || "").trim();
    return looksLikeDeckJson(text) ? text : null;
  } catch {
    return null;
  }
}

export async function generateDeckContent(
  topic: string,
  count: number,
  mode?: string,
  sources?: string,
  locale: "ko" | "en" = "en",
  useOpenCrab = false,
): Promise<TrexContentResult> {
  const clean = (topic || "").trim().slice(0, 500);
  const src = (sources || "").trim().slice(0, 24_000); // 첨부 파일 본문(캡). 소스가 있으면 주제 없이도 생성 가능.
  if (!clean && !src) return { ok: false, reason: "empty-topic" };
  let openCrab: OpenCrabEnrichment | undefined;
  let openCrabSignal: OpenCrabMatchSignal | undefined;
  if (useOpenCrab) {
    // Only the topic is sent. Attached source bodies are intentionally excluded
    // from the external ontology query.
    const enrichment = await queryOpenCrabContext(clean, {
      limit: 6,
      timeoutMs: 12_000,
      maxContextChars: 6_000,
    });
    openCrabSignal = enrichment.used ? deriveOpenCrabMatchSignal(clean, enrichment.context) : undefined;
    openCrab = {
      requested: true,
      used: Boolean(openCrabSignal?.evidenceCount),
      reason: enrichment.reason,
      ...(openCrabSignal ? openCrabSignal : {}),
    };
  }
  const finish = (result: TrexContentResult): TrexContentResult =>
    openCrab ? { ...result, openCrab } : result;
  const prompt = buildPrompt(clean || "(see source material)", count, mode, src, openCrabSignal);

  // 1순위: 붙은 Hub 에이전트(Defect-Driven Slide Studio)를 borrow해 실행 — callable로 게시되면 자동 우선.
  const viaAgent = await generateViaSlideAgent(prompt, locale, useOpenCrab);
  if (viaAgent) return finish({ ok: true, text: viaAgent, engine: "agent" });
  // 2순위: 활성 런타임(연결된 LLM)으로 실행 — 견고(런타임 레이어가 PATH/인증 처리), 패키지 앱에서도 됨.
  const viaRuntime = await generateViaActiveRuntime(prompt, locale);
  if (viaRuntime) return finish({ ok: true, text: viaRuntime, engine: "agent" });
  // 최후: 활성 런타임/에이전트가 없을 때만 로컬 CLI(agy/codex) 직접 spawn(PATH 보강됨).
  const agy = resolveBin("agy", [path.join(os.homedir(), ".local/bin/agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy"]);
  const codex = resolveBin("codex", [path.join(os.homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]);

  type Engine = { engine: "agy" | "codex"; run: (signal: AbortSignal) => Promise<string | null> };
  const engines: Engine[] = [];
  // agy(Antigravity) — 깔끔한 JSON. 워크스페이스 신뢰 우회 + 헤드리스 --print + stdin.
  if (agy)
    engines.push({
      engine: "agy",
      run: (signal) => runViaStdin(agy, ["--print", ""], prompt, { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" }, 140_000, signal),
    });
  // codex — exec 헤드리스. 출력에 잡음이 섞일 수 있어 렌더러가 {…} 구간만 추출한다.
  if (codex)
    engines.push({
      engine: "codex",
      run: (signal) => runViaStdin(codex, ["exec", "-s", "read-only", "--skip-git-repo-check", "-"], prompt, process.env, 140_000, signal),
    });
  if (!engines.length) return finish({ ok: false, reason: "no-llm-runtime" });

  // 병렬 레이스: agy·codex를 동시에 돌려 먼저 유효 JSON을 내는 쪽을 채택하고 나머지는 abort.
  // (예전엔 직렬 agy(≤140s)→codex(≤140s)라 한 엔진이 빈 결과로 140s를 통째로 먹으면 최대 280s가 걸려
  //  사용자가 못 기다리고 스켈레톤 폴백을 최종본으로 오인했다. 레이스는 느린/실패 엔진에 안 묶인다.)
  const controller = new AbortController();
  return await new Promise<TrexContentResult>((resolve) => {
    let settled = false;
    let pending = engines.length;
    for (const e of engines) {
      e.run(controller.signal)
        .then((out) => {
          if (settled) return;
          if (looksLikeDeckJson(out)) {
            settled = true;
            controller.abort(); // 진 엔진 즉시 종료
            resolve(finish({ ok: true, text: out as string, engine: e.engine }));
            return;
          }
          pending -= 1;
          if (pending === 0) {
            settled = true;
            resolve(finish({ ok: false, reason: "no-parseable-output" }));
          }
        })
        .catch(() => {
          if (settled) return;
          pending -= 1;
          if (pending === 0) {
            settled = true;
            resolve(finish({ ok: false, reason: "engine-error" }));
          }
        });
    }
  });
}

export interface TrexRefineResult {
  ok: boolean;
  text?: string;
  reason?: string;
}

function buildRefinePrompt(current: string, instruction: string, context?: string): string {
  return [
    "You rewrite ONE slide text element. Output ONLY the rewritten text — no JSON, no quotes, no markdown, no code fences, no prose before or after, no explanation.",
    "Keep it the SAME language as the current text. Keep it tight enough to fit a slide (one short line/phrase unless the instruction asks otherwise).",
    "You MAY wrap the single most decision-critical phrase in **double asterisks** for emphasis (at most one).",
    context ? `SLIDE CONTEXT (for tone/consistency, do not repeat): ${context.slice(0, 600)}` : "",
    `CURRENT TEXT:\n${current.slice(0, 1200)}`,
    `INSTRUCTION: ${instruction.slice(0, 500)}`,
    "Rewritten text:",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 선택한 슬라이드 텍스트 요소를 자연어 지시로 LLM이 다시 쓴다(사이트 스튜디오식 select-to-edit).
 * JSON이 아니라 순수 텍스트를 반환 — 렌더러가 그대로 블록에 반영한다. agy·codex 병렬 레이스.
 */
export async function refineTrexText(current: string, instruction: string, context?: string): Promise<TrexRefineResult> {
  const cur = (current || "").trim();
  const ins = (instruction || "").trim();
  if (!ins) return { ok: false, reason: "empty-instruction" };
  const prompt = buildRefinePrompt(cur, ins, context);

  const agy = resolveBin("agy", [path.join(os.homedir(), ".local/bin/agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy"]);
  const codex = resolveBin("codex", [path.join(os.homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]);
  type Engine = { run: (signal: AbortSignal) => Promise<string | null> };
  const engines: Engine[] = [];
  if (agy) engines.push({ run: (s) => runViaStdin(agy, ["--print", ""], prompt, { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" }, 90_000, s) });
  if (codex) engines.push({ run: (s) => runViaStdin(codex, ["exec", "-s", "read-only", "--skip-git-repo-check", "-"], prompt, process.env, 90_000, s) });
  if (!engines.length) return { ok: false, reason: "no-llm-runtime" };

  const controller = new AbortController();
  const clean = (out: string | null): string | null => {
    if (!out) return null;
    // 코드펜스/따옴표/라벨 잡음 제거 후 첫 유효 줄들을 취한다.
    let t = out.replace(/```[a-z]*|```/gi, "").trim();
    t = t.replace(/^(rewritten text|수정(된)?\s*텍스트)\s*[:：]\s*/i, "").trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
    return t || null;
  };

  return await new Promise<TrexRefineResult>((resolve) => {
    let settled = false;
    let pending = engines.length;
    for (const e of engines) {
      e.run(controller.signal)
        .then((out) => {
          if (settled) return;
          const t = clean(out);
          if (t) {
            settled = true;
            controller.abort();
            resolve({ ok: true, text: t });
            return;
          }
          pending -= 1;
          if (pending === 0) {
            settled = true;
            resolve({ ok: false, reason: "no-output" });
          }
        })
        .catch(() => {
          if (settled) return;
          pending -= 1;
          if (pending === 0) {
            settled = true;
            resolve({ ok: false, reason: "engine-error" });
          }
        });
    }
  });
}

/** 드롭다운/상태 표시용 — 내용 생성 LLM 가용 여부. */
export function trexContentAvailable(): { agy: boolean; codex: boolean } {
  const agy = !!resolveBin("agy", [path.join(os.homedir(), ".local/bin/agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy"]);
  const codex = !!resolveBin("codex", [path.join(os.homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]);
  return { agy, codex };
}
