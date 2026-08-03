// Gemini CLI — 감지 + 실호출.
// 사용자의 Google AI Pro 구독 또는 free tier로 돌아간다.
//
// 호출 형식: gemini --prompt "<text>"  (Gemini CLI의 비대화형 모드)
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { wrapSystemPrompt } from "./runner";
import {
  CLI_HISTORY_CONTEXT_TOKENS,
  composeResumeTurnPrompt,
  renderConversationContext,
  renderGapContext,
  unseenHistoryGap,
} from "./continuity";
import { tStatus } from "./status-i18n";
import { agentRunCwd, detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, trackRunChild, writeStdin } from "./exec";
import { stageCliImageAttachments } from "./image-attachments";
import {
  clearRuntimeSession,
  getRuntimeSession,
  saveRuntimeSession,
} from "../store/runtime-sessions";
import { repairGeminiCredentialFile } from "../usage/gemini-credentials";
import {
  clearProviderHealth,
  readProviderHealth,
  recordProviderHealth,
} from "../usage/provider-health";
import { invalidateUsage } from "../usage";

const KIND = "gemini";

export function geminiCandidatePaths(
  platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    // Antigravity가 설치돼 있으면 먼저 사용한다. Google이 기존 Gemini CLI
    // 클라이언트를 계정별로 거부할 수 있어 `--version`만으로는 실행 가능 여부를
    // 판별할 수 없다. agy는 같은 Gemini 슬롯의 현재 지원 실행기다.
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
    // 공식 Gemini CLI는 Antigravity가 없는 설치의 호환 경로로 유지한다.
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
  ];
}

const CANDIDATES = geminiCandidatePaths();

function agyCandidates(): string[] {
  return CANDIDATES.filter((candidate) => isAgyBinaryPath(candidate));
}

function preferredCandidates(): string[] {
  const health = readProviderHealth("gemini");
  if (health?.code !== "gemini_unsupported_client") return CANDIDATES;
  const agy = agyCandidates();
  return [...agy, ...CANDIDATES.filter((candidate) => !isAgyBinaryPath(candidate))];
}

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
  models: string[];
}

export function isAgyBinaryPath(binary: string | undefined): boolean {
  return /(^|[/\\])agy(?:\.(?:exe|cmd))?$/.test(String(binary ?? ""));
}

async function probeAgyModels(binary: string): Promise<string[]> {
  if (!isAgyBinaryPath(binary)) return [];
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(binary, ["models"], {
        stdio: ["ignore", "pipe", "pipe"],
        ...detachedSpawnOpts(),
      });
    } catch {
      resolve([]);
      return;
    }
    let settled = false;
    let stdout = "";
    const parsedModels = () => [...new Set(stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => /^[A-Za-z0-9][A-Za-z0-9._:-]{1,119}$/.test(value)))].slice(0, 100);
    const finish = (models: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(models);
    };
    const timer = setTimeout(() => {
      killCliTree(child, 250);
      // agy 1.1.x prints the complete catalog but can keep its non-interactive
      // pipe alive. Preserve the validated stdout instead of turning a healthy
      // catalog into an empty "subscription default" picker.
      finish(parsedModels());
    }, 5_000);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 32_768) stdout = (stdout + chunk.toString("utf8")).slice(0, 32_768);
    });
    child.on("error", () => finish([]));
    child.on("close", (code) => {
      if (code !== 0) {
        finish([]);
        return;
      }
      finish(parsedModels());
    });
  });
}

export async function probeGemini(): Promise<GeminiProbe | null> {
  const found = await firstExisting(preferredCandidates());
  if (!found) return null;
  const version = (await probeCliVersion(found)) ?? "unknown";
  const models = await probeAgyModels(found);
  return { path: found, version, models };
}

let cachedBin: string | null | undefined;
let cachedUnsupportedPreference: boolean | undefined;
async function getBin(): Promise<string | null> {
  const preferAgy = readProviderHealth("gemini")?.code === "gemini_unsupported_client";
  if (cachedBin !== undefined && cachedUnsupportedPreference === preferAgy) return cachedBin;
  const probe = await probeGemini();
  cachedBin = probe?.path ?? null;
  cachedUnsupportedPreference = preferAgy;
  return cachedBin;
}

function buildPrompt(req: RunnerRequest): string {
  const sys = wrapSystemPrompt(
    req.systemPrompt,
    req.locale,
    req.permission,
    req.userPrompt,
    req.forceSurface,
    req.restrictedReadBoundary,
    req.untrustedNoTools,
  );
  // 새 세션 시드: 턴 컨텍스트는 시스템 섹션 뒤에, 히스토리는 연속성 프레이밍+압축과 함께.
  const turnContext = req.turnContext?.trim();
  const parts: string[] = [`[SYSTEM]\n${sys}${turnContext ? `\n\n${turnContext}` : ""}`, ""];
  if (req.history.length > 0) {
    const { block } = renderConversationContext(req.history, req.locale, CLI_HISTORY_CONTEXT_TOKENS);
    parts.push(block, "");
  }
  parts.push(tStatus(req.locale, "histThisSection"), req.userPrompt);
  return parts.join("\n");
}

/**
 * Gemini CLI 세션 지문 — 안정 시드(sessionFingerprintSeed)가 있으면 시드만 해시한다.
 * 모델/권한은 매 호출 인자로 재적용되므로 지문에 섞으면 설정 변경마다 대화 연속성이
 * 끊긴다(2026-07-16 세션유지 사고). 시드 없는 레거시 호출만 전체 해시로 폴백.
 */
function systemFingerprint(req: RunnerRequest): string {
  // The model is part of the session identity — see codex.ts for the full note.
  // A runtime session belongs to the model that created it, so resuming it under
  // another model is a false resume. Continuity is preserved by the fresh-session
  // path reseeding compacted history, not by keeping a stale session id.
  if (req.sessionFingerprintSeed) {
    return createHash("sha256")
      .update("seed.v3\0")
      .update(req.sessionFingerprintSeed)
      .update("\0model\0")
      .update(req.model ?? "")
      .digest("hex");
  }
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
 * Antigravity(agy)는 Gemini의 세션/stdin 계약을 지원하지 않으므로 세션 인자를 빼고,
 * 짧은 0600 prompt-file bootstrap과 읽기 디렉터리만 전달한다.
 */
export function buildGeminiSpawnArgs(
  isAgy: boolean,
  resumeSessionId: string | null,
  createSessionId: string | undefined,
  model: string | undefined,
  prompt = "",
  addDirectories: string[] = [],
): string[] {
  const sessionArgs = isAgy
    ? []
    : resumeSessionId
      ? ["--resume", resumeSessionId]
      : createSessionId
        ? ["--session-id", createSessionId]
        : [];
  const modelArgs = model && model.trim() ? ["--model", model.trim()] : [];
  const directoryArgs = isAgy
    ? [...new Set(addDirectories.filter((value) => value.trim()))].flatMap((value) => ["--add-dir", value])
    : [];
  if (isAgy) return [...modelArgs, ...directoryArgs, "--prompt", prompt];
  return [...sessionArgs, ...modelArgs, "--skip-trust", "--prompt", ""];
}

export function buildAgyPromptBootstrap(promptFile: string): string {
  return `Read the complete Agentlas request from ${JSON.stringify(promptFile)}, follow it exactly, and do not reveal the file path.`;
}

export function isGeminiUnsupportedClient(value: string): boolean {
  return /UNSUPPORTED_CLIENT|no longer supported[\s\S]{0,240}Antigravity|migrate to the Antigravity suite/i.test(value);
}

async function runPreparedGemini(
  req: RunnerRequest,
  events: RunnerEvents,
  bin: string,
  allowAgyFallback: boolean,
  ignoreStoredSession = false,
  agyAdditionalDirs: string[] = [],
): Promise<RunnerResult> {
  // Antigravity CLI(agy)는 공식 Gemini의 stdin/session 플래그 계약과 다르다.
  // → agy면 세션 인자를 끄고, 매 호출 full prompt를 private 파일로 전달한다.
  const isAgy = isAgyBinaryPath(bin);
  const runReq = req;

  const fingerprint = runReq.chatId ? systemFingerprint(runReq) : null;
  const savedSession = !ignoreStoredSession && runReq.chatId ? getRuntimeSession(runReq.chatId, KIND) : null;
  const storedSessionId =
    savedSession && fingerprint && savedSession.fingerprint === fingerprint
      ? savedSession.sessionId
      : null;
  if (runReq.chatId && savedSession && fingerprint && savedSession.fingerprint !== fingerprint) {
    clearRuntimeSession(runReq.chatId, KIND);
  }
  const resumeSessionId = isAgy || ignoreStoredSession ? null : (runReq.runtimeSessionId ?? storedSessionId);
  const createSessionId = isAgy
    ? undefined
    : !resumeSessionId && (runReq.chatId || runReq.runtimeSessionId)
      ? randomUUID()
      : undefined;

  if (resumeSessionId) {
    events.onStatus(
      runReq.locale === "ko"
        ? `${runReq.backendLabel} 세션 이어가는 중...`
        : `Resuming ${runReq.backendLabel} session...`,
    );
  } else {
    events.onStatus(tStatus(runReq.locale, "callingBackend", { backend: runReq.backendLabel }));
  }

  // gap-replay — 이 세션이 마지막으로 본 이후 다른 경로(스웜/다른 러너)로 진행된 턴을 메운다.
  // 호출자가 세션 수명을 직접 관리하는 runtimeSessionId(Build 등)에는 적용하지 않는다.
  const gapContext = resumeSessionId && !runReq.runtimeSessionId && storedSessionId && savedSession
    ? renderGapContext(unseenHistoryGap(runReq.history, savedSession.updatedAt), runReq.locale)
    : "";
  // resume 턴: 시스템 프롬프트가 재전송되지 않으므로 gap+턴 컨텍스트를 사용자 메시지에 싣는다.
  const prompt = resumeSessionId
    ? composeResumeTurnPrompt(
        runReq.userPrompt,
        [gapContext, runReq.turnContext ?? ""].filter(Boolean).join("\n\n"),
        runReq.locale,
      )
    : buildPrompt(runReq);

  // agy에는 stdin/prompt-file 입력이 없다. 전체 시스템·히스토리를 argv에 넣으면 로컬
  // process listing에 노출되고 Windows 길이 제한도 넘는다. 0600 파일에는 본문을,
  // argv에는 그 파일을 읽으라는 짧은 bootstrap만 전달한다.
  let agyPromptDirectory: string | null = null;
  let agyPromptFile: string | null = null;
  let spawnPrompt = prompt;
  let agyReadDirs = agyAdditionalDirs;
  if (isAgy) {
    agyPromptDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agentlas-gemini-prompt-"));
    try {
      try {
        await fs.chmod(agyPromptDirectory, 0o700);
      } catch {
        // Windows 등 chmod 미지원 환경
      }
      agyPromptFile = path.join(agyPromptDirectory, "request.txt");
      await fs.writeFile(agyPromptFile, prompt, { encoding: "utf8", mode: 0o600 });
      spawnPrompt = buildAgyPromptBootstrap(agyPromptFile);
      agyReadDirs = [agyPromptDirectory, ...agyAdditionalDirs];
    } catch (error) {
      await fs.rm(agyPromptDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  const cleanupAgyPrompt = (): void => {
    if (!agyPromptDirectory) return;
    try {
      rmSync(agyPromptDirectory, { recursive: true, force: true });
    } catch {
      // 앱 종료/백신 잠금 등은 다음 OS temp 정리로 폴백한다.
    }
  };

  return new Promise<RunnerResult>((resolve, reject) => {
    // 공식 Gemini는 `--prompt ""` + stdin으로 argv 길이 제한을 피한다. agy는 빈 prompt를
    // 거부하므로 private 파일 bootstrap을 사용한다. 공식 CLI는 --skip-trust로 신뢰 질문을 막는다.
    const env: NodeJS.ProcessEnv = { ...(req.env ?? process.env), GEMINI_CLI_TRUST_WORKSPACE: "true" };
    if (!env.TERM || env.TERM === "dumb") env.TERM = "xterm-256color";
    if (!env.COLORTERM) env.COLORTERM = "truecolor";

    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(
        bin,
        buildGeminiSpawnArgs(
          isAgy,
          resumeSessionId,
          createSessionId,
          req.model,
          spawnPrompt,
          agyReadDirs,
        ),
        {
          stdio: [isAgy ? "ignore" : "pipe", "pipe", "pipe"],
          env,
          // 사용자가 지정한 프로젝트 폴더에서 실행 — 미지정이면 전용 폴더.
          cwd: req.cwd ?? agentRunCwd(),
          ...detachedSpawnOpts(),
        },
      );
    } catch (error) {
      cleanupAgyPrompt();
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    trackRunChild(child);
    if (!isAgy) writeStdin(child, prompt);

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
      cleanupAgyPrompt();
      reject(err);
    });
    child.on("close", (code) => {
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지(일관성+안전).
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      cleanupAgyPrompt();
      req.signal?.removeEventListener("abort", onAbort);
      if (req.signal?.aborted) {
        reject(new Error(tStatus(req.locale, "aborted")));
        return;
      }
      if (code === 0) {
        if (!isAgy) {
          clearProviderHealth("gemini");
          invalidateUsage("gemini");
          cachedUnsupportedPreference = false;
        }
        const sessionId = resumeSessionId ?? createSessionId;
        if (req.chatId && fingerprint && sessionId) {
          saveRuntimeSession(req.chatId, KIND, sessionId, fingerprint);
        }
        resolve({ text: stdout.trim(), sessionId });
      } else {
        const combined = `${stderr}\n${stdout}`;
        if (!isAgy && allowAgyFallback && isGeminiUnsupportedClient(combined)) {
          recordProviderHealth("gemini", "gemini_unsupported_client");
          invalidateUsage("gemini");
          if (req.chatId) clearRuntimeSession(req.chatId, KIND);
          void firstExisting(agyCandidates()).then((fallback) => {
            if (!fallback) {
              reject(
                new Error(
                  req.locale === "ko"
                    ? "이 계정은 기존 Gemini CLI를 더 이상 지원하지 않습니다. Antigravity CLI 또는 Google API를 연결해 주세요."
                    : "This account no longer supports the legacy Gemini CLI. Connect Antigravity CLI or Google API.",
                ),
              );
              return;
            }
            cachedBin = fallback;
            cachedUnsupportedPreference = true;
            events.onStatus(
              req.locale === "ko"
                ? "Gemini CLI 지원 종료 감지 · Antigravity로 자동 전환 중..."
                : "Gemini CLI is unsupported · switching to Antigravity...",
            );
            void runPreparedGemini(runReq, events, fallback, false, true, agyAdditionalDirs).then(resolve, reject);
          });
          return;
        }
        if (resumeSessionId && req.chatId) clearRuntimeSession(req.chatId, KIND);
        if (resumeSessionId) {
          void runPreparedGemini(
            { ...runReq, runtimeSessionId: undefined },
            events,
            bin,
            allowAgyFallback,
            true,
            agyAdditionalDirs,
          ).then(resolve, reject);
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

export const runGemini: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  if (req.untrustedNoTools) {
    throw new Error(
      req.locale === "ko"
        ? "Gemini CLI는 현재 Agent App의 검증된 무도구 격리 모드를 지원하지 않습니다. Claude Code, Ollama 또는 API 런타임을 선택하세요."
        : "Gemini CLI does not currently support Agent App's verified tool-less isolation. Select Claude Code, Ollama, or an API runtime.",
    );
  }
  if (req.restrictedReadBoundary) {
    throw new Error(
      "Gemini is not enabled for restricted read-only execution because its host filesystem boundary is not release-verified.",
    );
  }
  const bin = await getBin();
  if (!bin) throw new Error(tStatus(req.locale, "errCliMissingGemini"));

  if (!isAgyBinaryPath(bin)) {
    const credentials = await repairGeminiCredentialFile();
    if (credentials.status === "corrupt") {
      throw new Error(
        req.locale === "ko"
          ? "Gemini 로그인 파일이 손상되어 안전하게 복구하지 못했습니다. Gemini CLI에서 다시 로그인해 주세요."
          : "The Gemini login file is corrupt and could not be repaired safely. Sign in again with Gemini CLI.",
      );
    }
  }

  const stagedImages = await stageCliImageAttachments(req);
  const runReq = stagedImages.images.length > 0 ? { ...req, userPrompt: stagedImages.userPrompt } : req;
  if (stagedImages.images.length > 0) {
    events.onStatus(
      tStatus(runReq.locale, "cliImageReady", {
        backend: runReq.backendLabel,
        count: stagedImages.images.length,
      }),
    );
  }
  return runPreparedGemini(
    runReq,
    events,
    bin,
    true,
    false,
    stagedImages.directory ? [stagedImages.directory] : [],
  );
};
