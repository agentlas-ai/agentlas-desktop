// Gemini CLI — 감지 + 실호출.
// 사용자의 Google AI Pro 구독 또는 free tier로 돌아간다.
//
// 호출 형식: gemini --prompt "<text>"  (Gemini CLI의 비대화형 모드)
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { wrapSystemPrompt } from "./runner";
import { tStatus } from "./status-i18n";
import { agentRunCwd, probeCliVersion, spawnCli, writeStdin } from "./exec";

const CANDIDATES = [
  "gemini",
  path.join(os.homedir(), ".local/bin/gemini"), // 네이티브 인스톨러 기본 위치
  path.join(os.homedir(), ".gemini/bin/gemini"),
  "/opt/homebrew/bin/gemini",
  "/usr/local/bin/gemini",
  // Windows npm 전역 심 — GUI 앱이 PATH를 못 받았을 때의 fallback.
  ...(process.platform === "win32"
    ? [
        path.join(process.env.APPDATA ?? "", "npm", "gemini.cmd"),
        path.join(process.env.LOCALAPPDATA ?? "", "npm", "gemini.cmd"),
      ]
    : []),
];

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    if (!path.isAbsolute(p)) {
      // bare 커맨드명 — PATH(+Windows PATHEXT)로 해석. .cmd 심 포함.
      if ((await probeCliVersion(p, 2000)) !== null) return p;
      continue;
    }
    try {
      await fs.access(p);
      return p;
    } catch {
      continue;
    }
  }
  return null;
}

export interface GeminiProbe {
  path: string;
  version: string;
}

export async function probeGemini(): Promise<GeminiProbe | null> {
  const found = await firstExisting(CANDIDATES);
  if (!found) return null;
  const version = (await probeCliVersion(found)) ?? "unknown";
  return { path: found, version };
}

let cachedBin: string | null | undefined;
async function getBin(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  const probe = await probeGemini();
  cachedBin = probe?.path ?? null;
  return cachedBin;
}

function buildPrompt(req: RunnerRequest): string {
  const sys = wrapSystemPrompt(req.systemPrompt, req.locale);
  const user = tStatus(req.locale, "speakerUser");
  const assistant = tStatus(req.locale, "speakerAssistant");
  const parts: string[] = [`[SYSTEM]\n${sys}`, ""];
  if (req.history.length > 0) {
    parts.push(tStatus(req.locale, "histPrevSection"));
    for (const m of req.history) {
      const tag = m.role === "user" ? user : assistant;
      parts.push(`${tag}: ${m.text}`);
    }
    parts.push("");
  }
  parts.push(tStatus(req.locale, "histThisSection"), req.userPrompt);
  return parts.join("\n");
}

export const runGemini: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const bin = await getBin();
  if (!bin) {
    throw new Error(tStatus(req.locale, "errCliMissingGemini"));
  }

  if (req.images && req.images.length > 0) {
    events.onStatus(tStatus(req.locale, "cliNoImage", { backend: req.backendLabel }));
  } else {
    events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));
  }

  const prompt = buildPrompt(req);

  return new Promise<RunnerResult>((resolve, reject) => {
    // Gemini CLI 비대화형(헤드리스) 모드 — `-p ""`로 헤드리스를 트리거하고 실제 프롬프트는
    // stdin으로 싣는다(`-p`는 stdin 입력 뒤에 append됨). argv로 큰 프롬프트를 넘기면 Windows
    // cmd.exe 8191자 한계로 잘려 exit 1. GEMINI_CLI_TRUST_WORKSPACE: 비대화형은 신뢰-폴더
    // 프롬프트를 띄울 수 없어, 미설정 시 "not running in a trusted directory"로 죽는다(exit 55).
    const child = spawnCli(bin, ["--prompt", ""], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...(req.env ?? process.env), GEMINI_CLI_TRUST_WORKSPACE: "true" },
      // 사용자가 지정한 프로젝트 폴더에서 실행 — 미지정이면 전용 폴더.
      cwd: req.cwd ?? agentRunCwd(),
    });
    writeStdin(child, prompt);

    // 취소 — Stop 누르면 자식 프로세스 종료.
    const onAbort = () => child.kill();
    if (req.signal) {
      if (req.signal.aborted) child.kill();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }

    let stdout = "";
    let stderr = "";
    let lastEmit = 0;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      const now = Date.now();
      if (now - lastEmit > 80) {
        events.onPartial(stdout);
        lastEmit = now;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      req.signal?.removeEventListener("abort", onAbort);
      if (req.signal?.aborted) {
        reject(new Error(tStatus(req.locale, "aborted")));
        return;
      }
      if (code === 0) {
        resolve({ text: stdout.trim() });
      } else {
        reject(
          new Error(
            `gemini CLI exit ${code}${stderr ? `\n${stderr.slice(0, 500)}` : ""}`,
          ),
        );
      }
    });
  });
};
