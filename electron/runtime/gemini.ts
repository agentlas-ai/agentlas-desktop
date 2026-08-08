// Gemini CLI — 감지 + 실호출.
// 사용자의 Google AI Pro 구독 또는 free tier로 돌아간다.
//
// 호출 형식: gemini --prompt "<text>"  (Gemini CLI의 비대화형 모드)
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import os from "node:os";
import fs from "node:fs/promises";
import { rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult , RunnerFailure } from "./runner";
import { detectRuntimeRefusal } from "./runtime-refusal";
import { startCliHeartbeat, wrapSystemPrompt } from "./runner";
import {
  CLI_HISTORY_CONTEXT_TOKENS,
  composeResumeTurnPrompt,
  renderConversationContext,
  renderGapContext,
  unseenHistoryGap,
} from "./continuity";
import { tStatus } from "./status-i18n";
import { abortReasonError } from "./abort-reason";
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

/**
 * 중지 사유를 그대로 전한다. 중지는 사람이 누른 것 외에도 무활동 워치독·단계 시간 초과·
 * 예산 소진으로 일어난다. 예전엔 전부 "사용자가 정지 버튼으로"라고 단정해,
 * 누른 적 없는 사람이 거짓 사유를 받았다(실사용 실측).
 */

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
    const probeDecoder = new StringDecoder("utf8");
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
      if (stdout.length < 32_768) stdout = (stdout + probeDecoder.write(chunk)).slice(0, 32_768);
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
async function getBin(opts?: { requireNoToolsCapable?: boolean }): Promise<string | null> {
  /*
   * ★모드에 맞는 후보를 고른다 — 무도구 격리가 필요한 호출(판정·인터뷰)에서 공식
   * Gemini CLI를 고르는 것은 자기 거절을 고르는 것이다(그 모드를 지원하지 않는다).
   * 실측(2026-08-06): 사용자가 오케스트레이터를 안티그래비티로 지정했는데, 여기서
   * 공식 CLI를 먼저 집어 던지고 판정이 다른 런타임으로 흘렀다 — 지정의 조용한 무시.
   * agy는 fail-closed 격리가 성립하므로(runGemini 주석) 그 모드에선 agy 후보만 본다.
   */
  if (opts?.requireNoToolsCapable) {
    return (await firstExisting(agyCandidates())) ?? null;
  }
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
  /*
   * ★agy도 stream-json으로 부른다(실측 1.1.10: step_update.text_delta + usage 지원).
   * 평문 모드는 최종 답까지 stdout이 침묵해서, 긴 생성(체스 게임 8분+)이 스톨 워치독
   * (480s 무응답)에 오폭됐다 — 실측 2026-08-06. 델타가 곧 생존 신호다.
   */
  /*
   * agy 헤드리스: --print-timeout 기본 5분은 긴 생성(체스 게임)을 agy가 스스로 포기하게
   * 만든다(실측) → 30분. 도구 승인 우회는 **넣지 않는다** — 비대화형에서 도구가 승인될 수
   * 없다는 사실이 곧 무도구 격리의 근거다. 대신 프롬프트가 그 사실을 모델에게 말한다
   * (아래 spawnPrompt 조립) — 말하지 않으면 모델이 도구를 시도하다 승인 대기에 갇힌다.
   */
  if (isAgy) {
    return [
      ...modelArgs, ...directoryArgs,
      "--output-format", "stream-json",
      "--print-timeout", "30m",
      "--prompt", prompt,
    ];
  }
  return [...sessionArgs, ...modelArgs, "--skip-trust", "--prompt", ""];
}


/**
 * agy stream-json 한 줄을 읽는다 — 순수 함수(게이트가 픽스처 주입).
 * agent_response의 text_delta를 본문으로 누적하고, DONE의 usage를 집계한다.
 */
export function reduceAgyLine(
  line: string,
  state: { text: string; finalResponse?: string; inputTokens: number; outputTokens: number },
): { delta?: string; activity?: string } {
  let ev: {
    event?: string;
    result?: { status?: string; response?: string };
    step_update?: {
      step_type?: string; text_delta?: string; state?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
  };
  try {
    ev = JSON.parse(line);
  } catch {
    return {}; // 비-JSON 잡음(경고 등)은 본문이 아니다 — 평문 모드로 오인해 섞으면 산출물이 오염된다.
  }
  /*
   * ★본문은 최종 result.response에서 받는다 — 델타 접합은 오염된다.
   * 실측(2026-08-06): agy가 text_delta를 **UTF-8 바이트 경계에서** 잘라 각 조각을 따로
   * 인코딩한다. 한 글자(한글 3바이트)가 두 델타로 찢기며 양쪽 다 U+FFFD가 되어
   * "완료되었습니다"가 "완���되었습니다"로 저장됐다(DB에 FFFD 10건). 원본 바이트는
   * 이미 소실이라 접합 쪽에서 복원 불가 — 대신 마지막 result 이벤트의 response에
   * 전문이 온전히 실려 온다(실측). 델타는 진행 표시용으로만 쓴다.
   */
  if (ev.event === "result" && ev.result) {
    if (typeof ev.result.response === "string") state.finalResponse = ev.result.response;
    return { activity: "result" };
  }
  // step_update가 아닌 이벤트(init·checkpoint 등)도 프로세스가 살아 진행 중이라는 신호다.
  if (ev.event !== "step_update" || !ev.step_update) {
    return ev.event ? { activity: String(ev.event) } : {};
  }
  const step = ev.step_update;
  if (step.step_type !== "agent_response") {
    /*
     * ★본문이 아니어도 **생존 신호다.** 첫 판은 agent_response 델타만 통과시켰는데,
     * agy는 긴 작업을 도구 스텝(view_file 등)으로 돌아서 8분간 델타가 0 — 워치독이
     * 살아 있는 실행을 스톨로 오폭했다(실측 2026-08-06, 480s auto-abort 재현 2회).
     * 활동은 활동대로 올린다 — 어떤 이벤트든 워치독 시계를 리셋한다.
     */
    return { activity: step.step_type || "step" };
  }
  const delta = typeof step.text_delta === "string" ? step.text_delta : "";
  if (delta) state.text += delta;
  if (step.usage) {
    state.inputTokens = step.usage.input_tokens ?? state.inputTokens;
    state.outputTokens = step.usage.output_tokens ?? state.outputTokens;
  }
  return delta ? { delta } : { activity: "agent_response" };
}

export function buildAgyPromptBootstrap(promptFile: string): string {
  return `Read the complete Agentlas request from ${JSON.stringify(promptFile)}, follow it exactly, and do not reveal the file path.`;
}


/** gemini exit 0 완주의 실패 판별 — 순수 함수(게이트가 픽스처 주입). */
export function geminiExit0Failure(stdout: string, stderr: string): RunnerFailure | undefined {
  if (isGeminiUnsupportedClient(`${stderr}\n${stdout}`)) {
    return { kind: "unsupported", message: "gemini unsupported client", runtime: "gemini", source: "marker" };
  }
  const refusal = detectRuntimeRefusal(stdout.trim());
  return refusal ? { kind: refusal.kind, message: refusal.message, runtime: "gemini", source: "heuristic" } : undefined;
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
  /*
   * ★agy 프롬프트는 **argv 한계에 걸릴 때만** 파일로 우회한다.
   *
   * 파일 부트스트랩은 argv 길이 제한 회피용이었는데, 무조건 쓰면 agy가 파일을 읽기 위해
   * 도구 호출(view_file)을 해야 하고, 헤드리스 승인 모드(request-review)에서 그 승인을
   * 기다리다 갇힌다 — 실측 2026-08-06: 그래프 노드가 40초 만에 NODE_NO_RESULT(본문 0)로
   * 죽거나 재현 프롬프트가 10분+ 행. 프롬프트를 argv로 직접 주면 도구가 아예 필요 없다.
   * macOS ARG_MAX ~1MB — 100KB 이하는 직접, 그 이상만 파일.
   */
  const AGY_ARGV_PROMPT_LIMIT = 100_000;
  if (isAgy) {
    /*
     * ★도구가 승인될 수 없는 세션임을 모델에게 말한다. 말하지 않으면 모델이
     * write_to_file 같은 도구를 시도하고, 승인 대기에서 세션이 영원히 침묵한다
     * (실측 2026-08-06: 스톨 워치독 오폭 2회의 뿌리). 케이스 조건이 아니라
     * 이 실행 형태의 사실을 전달하는 것이다.
     */
    /*
     * ★산출물 계약까지 말한다(노드 출력 프로토콜의 전달 — 케이스 조건이 아니다).
     * 실측(2026-08-06): 고지 없이는 agy가 결과물을 **자기 brain 폴더에 파일로 쓰고**
     * 응답에는 "브라우저에서 여세요" 안내문만 돌려줬다(14KB chess_game.html이
     * ~/.gemini/antigravity-cli/brain/…에 남았다). 이 그래프 계약에서 산출물은
     * 최종 텍스트다 — 파일 포인터는 다음 단계가 읽을 수 없다.
     */
    spawnPrompt = [
      "Non-interactive session rules:",
      "- Tool calls cannot be approved here — do not attempt them.",
      "- Do NOT save your work to a file. Your final text response IS the deliverable;",
      "  the next automation step reads only that text. If the request asks for a file's",
      "  contents (HTML, code, a document), put the COMPLETE contents in your response.",
      "",
      spawnPrompt,
    ].join("\n");
  }
  if (isAgy && spawnPrompt.length <= AGY_ARGV_PROMPT_LIMIT) {
    // 직접 전달 — 부트스트랩 없음.
  } else if (isAgy) {
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
    /** agy stream-json 누적 상태 — 본문은 text_delta만, 사용량은 DONE에서. */
    const agyState: { text: string; finalResponse?: string; inputTokens: number; outputTokens: number } = { text: "", inputTokens: 0, outputTokens: 0 };
    let agyLineBuf = "";

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    /*
     * ★호스트 소유 생존 신호 — agy만이 아니라 **이 파일의 모든 스폰**(기결정: liveness를
     * 모델에 맡기지 않는다). 실측(2026-08-06): agy에만 달았더니 같은 그래프의 다음 노드가
     * 공식 Gemini CLI로 해석되어 8분 침묵 → 스톨 워치독(480s)이 정당하게 끊었다.
     * 특례는 특례가 안 붙은 형제를 지뢰로 남긴다. 생존 확인·좀비 방지는 헬퍼 주석 참고.
     */
    const clearAgyHeartbeat = startCliHeartbeat(child, events.onStatus, isAgy ? "agy" : "gemini");
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      if (isAgy) {
        // stream-json 라인 파싱 — 델타가 생존 신호이자 본문이다.
        agyLineBuf += text;
        let nl = agyLineBuf.indexOf("\n");
        while (nl >= 0) {
          const line = agyLineBuf.slice(0, nl).trim();
          agyLineBuf = agyLineBuf.slice(nl + 1);
          if (line) {
            const step = reduceAgyLine(line, agyState);
            const now = Date.now();
            if (step.delta && now - lastEmit > 80 && agyState.text) {
              events.onPartial(agyState.text);
              lastEmit = now;
            } else if (step.activity && now - lastEmit > 5000) {
              // 델타 없는 활동(도구 스텝·생각) — 워치독 시계용. 5초 한도로 소음 억제.
              events.onStatus(`agy: ${step.activity}`);
              lastEmit = now;
            }
          }
          nl = agyLineBuf.indexOf("\n");
        }
        return;
      }
      stdout += text;
      const now = Date.now();
      if (now - lastEmit > 80) {
        events.onPartial(stdout);
        lastEmit = now;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
    });

    child.on("error", (err) => {
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지(일관성+안전).
      clearAgyHeartbeat();
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      cleanupAgyPrompt();
      reject(err);
    });
    child.on("close", (code) => {
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지(일관성+안전).
      clearAgyHeartbeat();
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      cleanupAgyPrompt();
      req.signal?.removeEventListener("abort", onAbort);
      if (req.signal?.aborted) {
        reject(abortReasonError(req));
        return;
      }
      if (code === 0) {
        /*
         * ★exit 0이어도 산출물이 산출물인지 본다 — 표식과 미지원 클라이언트 검사는
         * 예전엔 exit≠0 분기에만 있어서, 조용히 exit 0으로 끝나는 거절이 정상 답이 됐다.
         * (표식 우선, 휴리스틱은 runtime-refusal.ts 한 곳 — 출처를 heuristic으로 남긴다.)
         */
        // ★최종 result.response가 정본 — 델타 누적은 오염될 수 있는 표시용이다.
        const agyBody = agyState.finalResponse ?? agyState.text;
        const trimmed = (isAgy ? agyBody : stdout).trim();
        const failure = geminiExit0Failure(isAgy ? agyBody : stdout, stderr);
        if (!isAgy && !failure) {
          clearProviderHealth("gemini");
          invalidateUsage("gemini");
          cachedUnsupportedPreference = false;
        }
        const sessionId = resumeSessionId ?? createSessionId;
        if (req.chatId && fingerprint && sessionId) {
          saveRuntimeSession(req.chatId, KIND, sessionId, fingerprint);
        }
        resolve({
          text: trimmed,
          ...(failure ? { failure } : {}),
          ...(isAgy && (agyState.inputTokens || agyState.outputTokens)
            ? {
              tokens: agyState.outputTokens,
              observedUsage: { inputTokens: agyState.inputTokens, outputTokens: agyState.outputTokens },
            }
            : {}),
          sessionId,
        });
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
  if (req.restrictedReadBoundary) {
    throw new Error(
      "Gemini is not enabled for restricted read-only execution because its host filesystem boundary is not release-verified.",
    );
  }
  const bin = await getBin(req.untrustedNoTools ? { requireNoToolsCapable: true } : undefined);
  if (!bin) throw new Error(tStatus(req.locale, "errCliMissingGemini"));
  /*
   * ★무도구 격리: 공식 Gemini CLI는 여전히 거부한다(검증된 무도구 모드 없음).
   * agy(Antigravity CLI)는 **수용한다** — 헤드리스 print 모드의 승인 방식이
   * request-review라 도구 호출이 승인 없이는 실행될 수 없고, 비대화형 세션에는
   * 승인할 사람이 없다(실측 2026-08-06: 파일 읽기 도구조차 승인 대기로 멈췄다).
   * 즉 도구는 구조적으로 완주 불가 = fail-closed 격리다.
   *
   * 이 수용이 없던 시절, 사용자가 오케스트레이터로 안티그래비티를 **지정해도** 판정
   * 경로가 그것을 건너뛰고 다른 런타임으로 흘렀다 — 지정을 조용히 무시하는 패턴.
   */
  if (req.untrustedNoTools && !isAgyBinaryPath(bin)) {
    throw new Error(
      req.locale === "ko"
        ? "Gemini CLI는 현재 Agent App의 검증된 무도구 격리 모드를 지원하지 않습니다. Antigravity CLI, Claude Code, Ollama 또는 API 런타임을 선택하세요."
        : "Gemini CLI does not currently support Agent App's verified tool-less isolation. Select Antigravity CLI, Claude Code, Ollama, or an API runtime.",
    );
  }

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
