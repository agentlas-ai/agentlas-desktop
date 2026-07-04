// 문서 스튜디오 "내용" 생성 — 연결된 LLM(agy/codex, 키리스)이 실제 문서 초안을
// 구조화 JSON({title, subtitle, body(markdown), figureCaption})으로 작성한다.
// trex/content.ts와 동일 엔진 패턴(agy 우선 → codex). 키/네트워크 불필요(구독 CLI).
// no-fallback: LLM 미연결/실패면 {ok:false, reason}만 반환한다. 가짜 템플릿을 만들지 않는다.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DocumentMode = "report" | "paper" | "brief";
export type ReviseAction = "expand" | "rewrite" | "shorten" | "improve" | "formal" | "casual";

// 근거 소스(compact) — 렌더러 Reference에서 프롬프트 주입용으로 축약해 넘긴다.
export interface SourceLite {
  authors?: string;
  title: string;
  year?: string;
  container?: string;
}

export interface DocumentContent {
  title: string;
  subtitle: string;
  body: string; // 편집 가능한 본문(markdown/plain)
  figureCaption: string;
}

export interface DocumentContentResult {
  ok: boolean;
  doc?: DocumentContent;
  engine?: "agy" | "codex";
  reason?: string;
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

const AGY_PATHS = [path.join(os.homedir(), ".local/bin/agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy"];
const CODEX_PATHS = [path.join(os.homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"];

function sourcesBlock(sources: SourceLite[]): string {
  if (!sources.length) return "";
  const lines = sources
    .slice(0, 20)
    .map((s, i) => `[${i + 1}] ${[s.authors, s.year && `(${s.year})`, s.title, s.container].filter(Boolean).join(" ")}`);
  return [
    "GROUNDING SOURCES (cite these where relevant using the author's surname, e.g. (Smith); do NOT invent other sources):",
    ...lines,
  ].join("\n");
}

function buildPrompt(goal: string, mode: DocumentMode, locale: "ko" | "en", sources: SourceLite[]): string {
  const kind =
    mode === "paper"
      ? "a structured academic paper draft (abstract, introduction, method/approach, analysis, discussion, references)"
      : mode === "brief"
        ? "a decision-ready executive brief (situation, key findings as evidence blocks, options, recommendation, next actions)"
        : "a long-form report (thesis, context, structured argument in sections, evidence, conclusion)";
  const lang = locale === "ko" ? "Write the whole document in Korean." : "Write in the same language as the goal.";
  const grounding = sourcesBlock(sources);
  return [
    "You are an expert research writer. Output ONLY valid minified JSON — no markdown fences, no prose before or after.",
    `GOAL: ${goal}`,
    `DOCUMENT TYPE: ${kind}.`,
    grounding,
    'SCHEMA: {"title":str,"subtitle":str,"body":str,"figureCaption":str}',
    "RULES:",
    `- ${lang}`,
    '- "title": a specific, publishable title for the document (not a generic label).',
    '- "subtitle": one line describing the document\'s angle or scope.',
    '- "body": the FULL document as GitHub-flavored Markdown. Use ## / ### headings for sections, bullet lists, and numbered lists. Real, specific, concrete content — plausible figures, named concepts, concrete claims; NEVER placeholders like "item 1" or "lorem". Research-grade density: every section teaches something. 500-900 words.',
    grounding
      ? '- Weave in-text citations to the grounding sources by surname where they support a claim. Do NOT write a References section — it is appended automatically.'
      : '- Do NOT fabricate citations or a References section.',
    '- "figureCaption": one concrete caption describing a figure/diagram that would accompany the document (English scene ok).',
    "- Do not wrap the JSON in code fences. Output the JSON object only.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildRevisePrompt(text: string, action: ReviseAction, locale: "ko" | "en"): string {
  const instruction: Record<ReviseAction, string> = {
    expand: "Expand this passage with more detail, evidence, and depth (roughly 1.5-2x length). Keep the same voice and claims.",
    rewrite: "Rewrite this passage more clearly and compellingly, preserving meaning and approximate length.",
    shorten: "Tighten this passage to about half the length, keeping every key point.",
    improve: "Improve clarity, flow, and word choice. Fix awkward phrasing. Keep meaning and length.",
    formal: "Rewrite in a more formal, academic register. Keep meaning and length.",
    casual: "Rewrite in a clearer, more conversational register. Keep meaning and length.",
  };
  const lang = locale === "ko" ? "Respond in Korean." : "Respond in the same language as the passage.";
  return [
    "You are an expert editor. Rewrite the passage per the instruction.",
    `INSTRUCTION: ${instruction[action]}`,
    `${lang}`,
    "Output ONLY the revised passage as Markdown — no preamble, no explanation, no code fences, no quotes around it.",
    "PASSAGE:",
    text,
  ].join("\n");
}

function runViaStdin(bin: string, args: string[], prompt: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    // 청크를 Buffer로 모아 한 번에 UTF-8 디코딩(청크별 toString은 한글 경계에서 U+FFFD로 깨짐).
    const chunks: Buffer[] = [];
    const collected = () => Buffer.concat(chunks).toString("utf8").trim();
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let child;
    try {
      child = spawn(bin, args, { env });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(collected() || null);
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    child.on("close", () => {
      clearTimeout(timer);
      finish(collected() || null);
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    try {
      child.stdin?.write(prompt, "utf8");
      child.stdin?.end();
    } catch {
      /* ignore */
    }
  });
}

// LLM 출력에서 첫 완결 JSON 오브젝트를 추출·검증한다(codex는 잡음이 섞일 수 있음).
function parseDoc(raw: string): DocumentContent | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const body = typeof o.body === "string" ? o.body.trim() : "";
  if (!body) return null; // 본문 없으면 실패로 취급 → 폴백.
  return {
    title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : "",
    subtitle: typeof o.subtitle === "string" ? o.subtitle.trim() : "",
    body,
    figureCaption: typeof o.figureCaption === "string" ? o.figureCaption.trim() : "",
  };
}

export async function generateDocumentContent(
  goal: string,
  mode: DocumentMode,
  locale: "ko" | "en" = "en",
  sources: SourceLite[] = [],
): Promise<DocumentContentResult> {
  const clean = (goal || "").trim().slice(0, 600);
  if (!clean) return { ok: false, reason: "empty-goal" };
  const prompt = buildPrompt(clean, mode, locale, sources);
  const out = await runLlm(prompt);
  if (!out.text) return { ok: false, reason: out.reason };
  const doc = parseDoc(out.text);
  if (!doc) return { ok: false, reason: "unparseable" };
  return { ok: true, doc, engine: out.engine };
}

// AI 편집 툴바 — 선택 텍스트를 지시대로 개정한다(JSON 아닌 순수 텍스트 반환).
export async function reviseDocumentText(
  text: string,
  action: ReviseAction,
  locale: "ko" | "en" = "en",
): Promise<{ ok: boolean; text?: string; engine?: "agy" | "codex"; reason?: string }> {
  const clean = (text || "").trim();
  if (!clean) return { ok: false, reason: "empty-text" };
  const out = await runLlm(buildRevisePrompt(clean.slice(0, 6000), action, locale));
  if (!out.text) return { ok: false, reason: out.reason };
  // codex는 preamble/코드펜스가 섞일 수 있어 정리한다.
  const revised = stripArtifacts(out.text);
  if (!revised) return { ok: false, reason: "empty-result" };
  return { ok: true, text: revised, engine: out.engine };
}

// agy → codex 공통 실행. 성공 시 {text, engine}, 실패 시 {reason}.
async function runLlm(prompt: string): Promise<{ text?: string; engine?: "agy" | "codex"; reason?: string }> {
  const agy = resolveBin("agy", AGY_PATHS);
  if (agy) {
    const env = { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" };
    const out = await runViaStdin(agy, ["--print", ""], prompt, env, 140_000);
    if (out && out.trim()) return { text: out, engine: "agy" };
  }
  const codex = resolveBin("codex", CODEX_PATHS);
  if (codex) {
    const out = await runViaStdin(codex, ["exec", "-s", "read-only", "--skip-git-repo-check", "-"], prompt, process.env, 140_000);
    if (out && out.trim()) return { text: out, engine: "codex" };
  }
  return { reason: "no-llm-runtime" };
}

// 개정 결과에서 코드펜스/래핑 따옴표 제거.
function stripArtifacts(raw: string): string {
  let s = raw.trim();
  // 전체를 감싼 코드펜스 제거(여는 ```lang 줄 + 닫는 ``` 줄). 정확한 전체매치를 요구하지 않는다.
  if (s.startsWith("```")) {
    s = s.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }
  // 래핑 따옴표는 그 따옴표가 문자열 전체에 정확히 2개(=여는/닫는 한 쌍)일 때만 제거한다.
  // 그래야 '"Hello," she said, "bye"' 같이 내부에 정당한 따옴표가 있는 문단을 훼손하지 않는다.
  const q = s[0];
  if ((q === '"' || q === "'") && s.length > 1 && s.endsWith(q) && s.split(q).length - 1 === 2) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** 상태 표시용 — 문서 생성 LLM 가용 여부. */
export function documentContentAvailable(): { agy: boolean; codex: boolean } {
  return {
    agy: !!resolveBin("agy", AGY_PATHS),
    codex: !!resolveBin("codex", CODEX_PATHS),
  };
}
