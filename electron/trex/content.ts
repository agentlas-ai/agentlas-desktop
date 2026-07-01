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

function buildPrompt(topic: string, count: number, mode?: string): string {
  const middle = Math.max(3, Math.min(12, count - 2));
  const modeLine = mode ? `Set "mode" to ${mode}.` : `Pick "mode" by topic: cinematic(narrative), editorial(business), diagrammatic(academic), hybrid(sports/data).`;
  return [
    "You are an expert presentation content designer. Output ONLY valid minified JSON — no markdown, no code fences, no prose before or after.",
    `TOPIC: ${topic}`,
    'SCHEMA: {"title":str,"subtitle":str,"mode":"cinematic|editorial|diagrammatic|hybrid","slides":[ {"role":"agenda","title":str,"items":[str,str,str,str]} | {"role":"metrics","title":str,"kpis":[{"value":str,"label":str}]} | {"role":"comparison","title":str,"bars":[{"label":str,"value":int}]} | {"role":"structure","title":str,"cards":[{"label":str,"text":str}]} | {"role":"process","title":str,"steps":[{"label":str,"text":str}]} | {"role":"highlight","title":str,"stat":{"value":str,"label":str},"text":str} | {"role":"statement","text":str} ]}',
    "RULES:",
    "- Write in the SAME language as the topic.",
    "- One idea per slide. Titles are ACTION CLAIMS, not topic labels.",
    "- Real, specific, concrete content — plausible real numbers and concrete claims, never placeholders like 'item 1'.",
    `- Exactly ${middle} middle slides. Start with an "agenda", then a VARIED mix of metrics/comparison/structure/process/highlight/statement (2-4 kpis/bars/cards/steps each).`,
    `- ${modeLine}`,
    "- Keep each text concise (roughly under 40 chars for CJK, 8 words for English).",
  ].join("\n");
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

export async function generateDeckContent(topic: string, count: number, mode?: string): Promise<TrexContentResult> {
  const clean = (topic || "").trim().slice(0, 500);
  if (!clean) return { ok: false, reason: "empty-topic" };
  const prompt = buildPrompt(clean, count, mode);

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
