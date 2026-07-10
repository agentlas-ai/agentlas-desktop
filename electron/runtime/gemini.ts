// Gemini CLI — 감지 + 실호출.
// 사용자의 Google AI Pro 구독 또는 free tier로 돌아간다.
//
// 호출 형식: gemini --prompt "<text>"  (Gemini CLI의 비대화형 모드)
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { wrapSystemPrompt } from "./runner";
import { tStatus } from "./status-i18n";
import { agentRunCwd, detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, trackRunChild, writeStdin } from "./exec";
import { stageCliImageAttachments } from "./image-attachments";
import {
  clearRuntimeSession,
  getRuntimeSession,
  saveRuntimeSession,
} from "../store/runtime-sessions";

const KIND = "gemini";

export function geminiCandidatePaths(
  platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    // 공식 Gemini CLI 우선: 사용자 전역 extension/skills/MCP를 실제 로드한다.
    ...(platform === "win32"
      ? [
          "gemini.cmd",
          "gemini.exe",
          path.join(env.APPDATA ?? "", "npm", "gemini.cmd"),
          path.join(env.LOCALAPPDATA ?? "", "npm", "gemini.cmd"),
        ]
      : []),
    "gemini",
    path.join(home, ".local/bin/gemini"),
    path.join(home, ".agentlas/npm/bin/gemini"),
    path.join(home, ".gemini/bin/gemini"),
    "/opt/homebrew/bin/gemini",
    "/usr/local/bin/gemini",
    // Antigravity(agy)는 공식 Gemini가 없는 기존 키리스 설치의 호환 폴백이다.
    ...(platform === "win32"
      ? [
          "agy.cmd",
          "agy.exe",
          path.join(home, ".local", "bin", "agy.exe"),
          path.join(home, ".local", "bin", "agy.cmd"),
        ]
      : []),
    "agy",
    path.join(home, ".local/bin/agy"),
    path.join(home, ".agentlas/npm/bin/agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ];
}

const CANDIDATES = geminiCandidatePaths();

export async function firstAvailableGeminiCandidate(
  paths: string[],
  available: (candidate: string) => Promise<boolean>,
): Promise<string | null> {
  for (const p of paths) {
    if (await available(p)) return p;
  }
  return null;
}

async function firstExisting(paths: string[]): Promise<string | null> {
  return firstAvailableGeminiCandidate(paths, async (candidate) => {
    if (!path.isAbsolute(candidate)) {
      // bare 커맨드명 — PATH(+Windows PATHEXT)로 해석. .cmd 심 포함.
      return (await probeCliVersion(candidate, 2000)) !== null;
    }
    try {
      await fs.access(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

export interface GeminiProbe {
  path: string;
  version: string;
}

export function isAgyBinaryPath(binary: string | undefined): boolean {
  return /(^|[/\\])agy(?:\.(?:exe|cmd))?$/.test(String(binary ?? ""));
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
  const sys = wrapSystemPrompt(req.systemPrompt, req.locale, req.permission, req.userPrompt, req.forceSurface);
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

/**
 * Gemini CLI 세션 지문. 사용자 입력은 매 턴 달라지므로 제외하고, 세션을 갈라야 하는
 * 시스템/권한/표면/모델 설정만 반영한다.
 */
function systemFingerprint(req: RunnerRequest): string {
  return createHash("sha256")
    .update(req.systemPrompt)
    .update("\0")
    .update(req.locale)
    .update("\0")
    .update(req.permission ?? "")
    .update("\0")
    .update(req.forceSurface ? "force-surface" : "normal")
    .update("\0")
    .update(req.model ?? "")
    .digest("hex");
}

/**
 * 공식 Gemini CLI는 사용자 전역 extension/skills/MCP를 기본값 그대로 로드한다.
 * Antigravity(agy)는 Gemini의 세션 플래그를 지원하지 않으므로 그 둘만 제외하고,
 * 공통 헤드리스 프롬프트/모델 인자는 유지한다.
 */
export function buildGeminiSpawnArgs(
  isAgy: boolean,
  resumeSessionId: string | null,
  createSessionId: string | undefined,
  model: string | undefined,
): string[] {
  const sessionArgs = isAgy
    ? []
    : resumeSessionId
      ? ["--resume", resumeSessionId]
      : createSessionId
        ? ["--session-id", createSessionId]
        : [];
  const modelArgs = model && model.trim() ? ["--model", model.trim()] : [];
  return [...sessionArgs, ...modelArgs, "--prompt", ""];
}

export const runGemini: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const bin = await getBin();
  if (!bin) {
    throw new Error(tStatus(req.locale, "errCliMissingGemini"));
  }
  // Antigravity CLI(agy)는 gemini-cli와 헤드리스 stdin(`--prompt ""`)은 동일하지만
  // `--session-id`/`--resume`를 지원하지 않는다("flags provided but not defined").
  // → agy면 세션 인자를 끄고, 매 호출 full prompt(컨텍스트 포함)로 보낸다.
  const isAgy = isAgyBinaryPath(bin);
  const stagedImages = await stageCliImageAttachments(req);
  const runReq = stagedImages.images.length > 0 ? { ...req, userPrompt: stagedImages.userPrompt } : req;

  const fingerprint = runReq.chatId ? systemFingerprint(runReq) : null;
  const savedSession = runReq.chatId ? getRuntimeSession(runReq.chatId, KIND) : null;
  const storedSessionId =
    savedSession && fingerprint && savedSession.fingerprint === fingerprint
      ? savedSession.sessionId
      : null;
  if (runReq.chatId && savedSession && fingerprint && savedSession.fingerprint !== fingerprint) {
    clearRuntimeSession(runReq.chatId, KIND);
  }
  const resumeSessionId = isAgy ? null : (runReq.runtimeSessionId ?? storedSessionId);
  const createSessionId = isAgy
    ? undefined
    : !resumeSessionId && (runReq.chatId || runReq.runtimeSessionId)
      ? randomUUID()
      : undefined;

  if (stagedImages.images.length > 0) {
    events.onStatus(
      tStatus(runReq.locale, "cliImageReady", {
        backend: runReq.backendLabel,
        count: stagedImages.images.length,
      }),
    );
  } else if (resumeSessionId) {
    events.onStatus(
      runReq.locale === "ko"
        ? `${runReq.backendLabel} 세션 이어가는 중...`
        : `Resuming ${runReq.backendLabel} session...`,
    );
  } else {
    events.onStatus(tStatus(runReq.locale, "callingBackend", { backend: runReq.backendLabel }));
  }

  const prompt = resumeSessionId ? runReq.userPrompt : buildPrompt(runReq);

  return new Promise<RunnerResult>((resolve, reject) => {
    // Gemini CLI 비대화형(헤드리스) 모드 — `-p ""`로 헤드리스를 트리거하고 실제 프롬프트는
    // stdin으로 싣는다(`-p`는 stdin 입력 뒤에 append됨). argv로 큰 프롬프트를 넘기면 Windows
    // cmd.exe 8191자 한계로 잘려 exit 1. GEMINI_CLI_TRUST_WORKSPACE: 비대화형은 신뢰-폴더
    // 프롬프트를 띄울 수 없어, 미설정 시 "not running in a trusted directory"로 죽는다(exit 55).
    const env: NodeJS.ProcessEnv = { ...(req.env ?? process.env), GEMINI_CLI_TRUST_WORKSPACE: "true" };
    if (!env.TERM || env.TERM === "dumb") env.TERM = "xterm-256color";
    if (!env.COLORTERM) env.COLORTERM = "truecolor";

    const child = spawnCli(
      bin,
      buildGeminiSpawnArgs(isAgy, resumeSessionId, createSessionId, req.model),
      {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        // 사용자가 지정한 프로젝트 폴더에서 실행 — 미지정이면 전용 폴더.
        cwd: req.cwd ?? agentRunCwd(),
        ...detachedSpawnOpts(),
      },
    );
    trackRunChild(child);
    writeStdin(child, prompt);

    // 취소 — Stop 누르면 자식 프로세스 트리 종료.
    const onAbort = () => killCliTree(child);
    if (req.signal) {
      if (req.signal.aborted) killCliTree(child);
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

    child.on("error", (err) => {
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지(일관성+안전).
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      reject(err);
    });
    child.on("close", (code) => {
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지(일관성+안전).
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      req.signal?.removeEventListener("abort", onAbort);
      if (req.signal?.aborted) {
        reject(new Error(tStatus(req.locale, "aborted")));
        return;
      }
      if (code === 0) {
        const sessionId = resumeSessionId ?? createSessionId;
        if (req.chatId && fingerprint && sessionId) {
          saveRuntimeSession(req.chatId, KIND, sessionId, fingerprint);
        }
        resolve({ text: stdout.trim(), sessionId });
      } else {
        if (resumeSessionId && req.chatId) clearRuntimeSession(req.chatId, KIND);
        if (resumeSessionId) {
          void runGemini({ ...req, runtimeSessionId: undefined }, events).then(resolve, reject);
          return;
        }
        reject(
          new Error(
            `gemini CLI exit ${code}${stderr ? `\n${stderr.slice(0, 500)}` : ""}`,
          ),
        );
      }
    });
  });
};
