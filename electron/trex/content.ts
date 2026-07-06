// T-rex 슬라이드 "내용" 생성 — 연결된 LLM(agy/codex, 키리스)이 슬라이드별 실제 카피·수치를
// 구조화 JSON으로 작성한다. 렌더러는 이 JSON을 parseDeckContent→buildDeckFromContent로 렌더.
// agy(Antigravity)가 깔끔한 JSON을 잘 뽑아 우선, 없으면 codex.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TrexContentResult {
  ok: boolean;
  text?: string; // 원본 JSON 텍스트(렌더러가 parseDeckContent로 파싱)
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

function buildPrompt(topic: string, count: number, mode?: string, sources?: string): string {
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

function runViaStdin(bin: string, args: string[], prompt: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    // 청크를 Buffer로 모아 한 번에 UTF-8 디코딩한다. 청크마다 toString하면
    // 멀티바이트 문자(한글=3바이트)가 청크 경계에서 쪼개져 U+FFFD로 깨진다.
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

export async function generateDeckContent(topic: string, count: number, mode?: string, sources?: string): Promise<TrexContentResult> {
  const clean = (topic || "").trim().slice(0, 500);
  const src = (sources || "").trim().slice(0, 24_000); // 첨부 파일 본문(캡). 소스가 있으면 주제 없이도 생성 가능.
  if (!clean && !src) return { ok: false, reason: "empty-topic" };
  const prompt = buildPrompt(clean || "(see source material)", count, mode, src);

  // 1) Antigravity CLI(agy) — 깔끔한 JSON. 워크스페이스 신뢰 우회 + 헤드리스 --print + stdin.
  const agy = resolveBin("agy", [path.join(os.homedir(), ".local/bin/agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy"]);
  if (agy) {
    const env = { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" };
    const out = await runViaStdin(agy, ["--print", ""], prompt, env, 140_000);
    if (out && out.includes("{") && out.includes("}")) return { ok: true, text: out, engine: "agy" };
  }

  // 2) Codex — exec 헤드리스. 출력에 잡음이 섞일 수 있어 렌더러가 {…} 구간만 추출한다.
  const codex = resolveBin("codex", [path.join(os.homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]);
  if (codex) {
    const out = await runViaStdin(codex, ["exec", "-s", "read-only", "--skip-git-repo-check", "-"], prompt, process.env, 140_000);
    if (out && out.includes("{") && out.includes("}")) return { ok: true, text: out, engine: "codex" };
  }

  return { ok: false, reason: "no-llm-runtime" };
}

/** 드롭다운/상태 표시용 — 내용 생성 LLM 가용 여부. */
export function trexContentAvailable(): { agy: boolean; codex: boolean } {
  const agy = !!resolveBin("agy", [path.join(os.homedir(), ".local/bin/agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy"]);
  const codex = !!resolveBin("codex", [path.join(os.homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]);
  return { agy, codex };
}
