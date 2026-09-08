// Antigravity CLI (agy) — 감지 + 실호출.
// Google 계정의 Antigravity 구독 런타임만 지원한다.
import path from "node:path";
import { acquireAgyMcpLease } from "./agy-mcp-lease";
import { preparedMcpBindings, preparedMcpTransport } from "../mcp-tools/prepared-transport";
import { RuntimeJudgmentRefusal } from "./judgment-refusal";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import os from "node:os";
import fs from "node:fs/promises";
import { lstatSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult, RunnerFailure, RunnerFailureKind } from "./runner";
import { detectRuntimeRefusal } from "./runtime-refusal";
import { cumulativeSurfaceGateText, ensureChildCloseAfterExit, startCliHeartbeat, wrapSystemPrompt } from "./runner";
import { announceToolDenied } from "./tool-approval";
import {
  CLI_HISTORY_CONTEXT_TOKENS,
  renderConversationContext,
} from "./continuity";
import { tStatus } from "./status-i18n";
import { abortReasonError } from "./abort-reason";
import { agentRunCwd, detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, trackRunChild } from "./exec";
import { stageCliImageAttachments } from "./image-attachments";
import { parseAgyModels, unsupportedDiscovery, type DiscoveryOutcome } from "../../shared/model-discovery";
import { settleDiscovery } from "./model-discovery-store";
import { getRuntimeSession, saveRuntimeSession } from "../store/runtime-sessions";
import { createHash } from "node:crypto";
import {
  MCP_PROXY_CONTROL_FILE_ENV,
  MCP_PROXY_SERVER_KEY_ENV,
  MCP_PROXY_SESSION_ENV,
  MCP_PROXY_TARGET_ENV,
} from "../mcp-tools/proxy-channel";
import { BROWSER_CDP_LAUNCHER_BASENAME } from "../mcp-tools/browser-cdp-launcher";
import { observeCliExecutableIdentity } from "./cli-executable-identity";

/**
 * 중지 사유를 그대로 전한다. 중지는 사람이 누른 것 외에도 무활동 워치독·단계 시간 초과·
 * 예산 소진으로 일어난다. 예전엔 전부 "사용자가 정지 버튼으로"라고 단정해,
 * 누른 적 없는 사람이 거짓 사유를 받았다(실사용 실측).
 */

const ANTIGRAVITY_KIND = "antigravity";
// `agy models` is a network-backed catalog. A cold 1.1.26 fetch can remain
// silent for more than five seconds before returning a complete list; timing
// it out there leaves a first-time user's picker empty despite a healthy CLI.
export const ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS = 12_000;

export function antigravityCandidatePaths(
  platform = process.platform,
  home = os.homedir(),
): string[] {
  return [
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

const AGY_CANDIDATES = antigravityCandidatePaths();

export async function firstAvailableAntigravityCandidate(
  paths: string[],
  available: (candidate: string) => Promise<boolean>,
): Promise<string | null> {
  for (const p of paths) {
    if (await available(p)) return p;
  }
  return null;
}

async function firstExisting(paths: string[]): Promise<string | null> {
  return firstAvailableAntigravityCandidate(paths, async (candidate) => {
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

export interface AntigravityProbe {
  path: string;
  version: string;
  /** Model ids to offer (last-good ids when discovery failed — see `discovery.stale`). */
  models: string[];
  /** DiscoveryOutcome contract (PRD 2026-08-15 D-1): ok / unsupported / failed, never a silent []. */
  discovery: DiscoveryOutcome;
}

export function isAgyBinaryPath(binary: string | undefined): boolean {
  return /(^|[/\\])agy(?:\.(?:exe|cmd))?$/.test(String(binary ?? ""));
}

async function probeAgyModels(binary: string): Promise<DiscoveryOutcome> {
  if (!isAgyBinaryPath(binary)) return unsupportedDiscovery("not-agy-binary");
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(binary, ["models"], {
        stdio: ["ignore", "pipe", "pipe"],
        ...detachedSpawnOpts(),
      });
    } catch (err) {
      resolve(settleDiscovery("antigravity", { stdout: "", models: [], exitCode: null, source: "cli" }));
      return;
    }
    let settled = false;
    let stdout = "";
    const probeDecoder = new StringDecoder("utf8");
    // agy 1.1.12 실측(2026-08-14): 출력이 `<id>\t<사람용 이름>` 2열로 바뀌었다.
    //   gemini-3.7-flash-high\tGemini 3.7 Flash (High)
    // 줄 전체를 식별자로 검사하던 예전 파서는 탭·공백·괄호 때문에 14줄을 전부 버리고
    // 0개를 반환했다 — 예외도 로그도 없이 모델 선택기가 비어 Gemini 3.7이 보이지 않았다.
    // 같은 1.1.x 안에서 형식이 바뀌었으므로 버전 게이트로는 잡을 수 없는 종류의 드리프트다.
    // 파서는 shared/model-discovery.ts(parseAgyModels)로 옮겨 픽스처 테스트가 가능하고,
    // 결과는 DiscoveryOutcome으로 분류된다: stdout이 있는데 0개면 `failed`(수확량 회귀).
    const finish = (input: { timedOut?: boolean; exitCode?: number | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(settleDiscovery("antigravity", { stdout, models: parseAgyModels(stdout), source: "cli", ...input }));
    };
    const timer = setTimeout(() => {
      killCliTree(child, 250);
      // agy 1.1.x prints the complete catalog but can keep its non-interactive
      // pipe alive. Preserve the validated stdout instead of turning a healthy
      // catalog into an empty engine-setting picker.
      finish({ timedOut: parseAgyModels(stdout).length === 0 });
    }, ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 32_768) stdout = (stdout + probeDecoder.write(chunk)).slice(0, 32_768);
    });
    child.on("error", () => finish({ exitCode: null }));
    child.on("close", (code) => {
      stdout += probeDecoder.end();
      finish({ exitCode: code });
    });
  });
}

export async function probeAntigravity(): Promise<AntigravityProbe | null> {
  const found = await firstExisting(AGY_CANDIDATES);
  if (!found) return null;
  const version = (await probeCliVersion(found)) ?? "unknown";
  const discovery = await probeAgyModels(found);
  return { path: found, version, models: discovery.models, discovery };
}

async function getBin(opts?: { source?: string }): Promise<string | null> {
  if (opts?.source) {
    return isAgyBinaryPath(opts.source) ? firstExisting([opts.source]) : null;
  }
  return firstExisting(AGY_CANDIDATES);
}

/**
 * A browser-only run must not replay an entire long-lived automation chat.
 * Antigravity receives this prompt directly in argv, and the browser-only
 * policy intentionally cannot use a private prompt file to bypass argv
 * limits. Keep enough recent context to make the current browser task
 * coherent, but bound the replay independently from the normal CLI budget.
 */
export const AGY_BROWSER_HISTORY_CONTEXT_TOKENS = 8_000;
export const AGY_ARGV_PROMPT_LIMIT = 100_000;
const AGY_BROWSER_HISTORY_CHAR_LIMIT = 32_000;

function capBrowserHistoryBlock(block: string): string {
  if (block.length <= AGY_BROWSER_HISTORY_CHAR_LIMIT) return block;
  // Keep the section header and the newest tail. A giant single recent
  // message must not be able to recreate the argv overflow after compaction.
  const head = block.slice(0, 1_000);
  const tail = block.slice(-(AGY_BROWSER_HISTORY_CHAR_LIMIT - head.length - 80));
  return `${head}\n[… browser history shortened by Agentlas …]\n${tail}`;
}

export function buildAntigravityPrompt(req: RunnerRequest): string {
  const sys = wrapSystemPrompt(
    req.systemPrompt,
    req.locale,
    req.permission,
    cumulativeSurfaceGateText(req.history, req.userPrompt),
    req.forceSurface,
    req.restrictedReadBoundary,
    req.untrustedNoTools,
  );
  // 새 세션 시드: 턴 컨텍스트는 시스템 섹션 뒤에, 히스토리는 연속성 프레이밍+압축과 함께.
  const turnContext = req.turnContext?.trim();
  const parts: string[] = [`[SYSTEM]\n${sys}${turnContext ? `\n\n${turnContext}` : ""}`, ""];
  if (req.history.length > 0) {
    const historyBudget = req.browserOnly ? AGY_BROWSER_HISTORY_CONTEXT_TOKENS : CLI_HISTORY_CONTEXT_TOKENS;
    const { block } = renderConversationContext(req.history, req.locale, historyBudget);
    parts.push(req.browserOnly ? capBrowserHistoryBlock(block) : block, "");
  }
  parts.push(tStatus(req.locale, "histThisSection"), req.userPrompt);
  return parts.join("\n");
}

// Kept as a local alias for callers that are not concerned with the prompt's
// transport boundary. Tests and diagnostics use the named export above.
const buildPrompt = buildAntigravityPrompt;

/**
 * ★권한 칩 → agy 권한 플래그. 형제 러너와 같은 규칙이다.
 *
 * claude는 `--permission-mode acceptEdits|bypassPermissions`, codex는
 * `--sandbox workspace-write|--dangerously-bypass-approvals-and-sandbox`를 권한에 맞춰
 * 넘긴다. agy만 **아무 플래그도 넘기지 않아서**, 쓰기 권한 실행인데도 도구가 전부
 * 자동 거부됐다 — 모델은 코드를 텍스트로 그려줄 뿐 파일 하나 만들지 못했다.
 *
 * agy 자신이 그 사실을 정확히 말해 준다(실측 1.1.13, 플래그 없이 파일 생성 요청):
 *   `a tool required the "write_file" permission that headless mode cannot prompt for,
 *    so it was auto-denied. ... re-run with --dangerously-skip-permissions`
 *
 * 실측(1.1.13, 임시 디렉터리에 실제 파일 생성):
 * - 플래그 없음 → 파일 0개(auto-denied)
 * - `--dangerously-skip-permissions` → 생성됨
 * - `--dangerously-skip-permissions --sandbox` → **생성됨**(샌드박스는 터미널만 제한)
 *
 * 그래서 write는 codex의 workspace-write와 같은 자리에 `--sandbox`를 함께 준다 —
 * 파일 작업은 되고 셸은 묶인다. full만 샌드박스를 푼다.
 * read는 플래그를 주지 않는다(도구 없이 텍스트만 = 기존 격리 계약 유지).
 *
 * ★read 를 "읽기 도구는 살리고 변경만 막는" 모양으로 바꾸려는 시도는 이미 재 봤다 —
 *   되지 않는다 (실측 2026-09-07, agy 1.1.27, scripts/probe-runtime-permission-bypass.mjs
 *   --live --candidates). agy 에는 도구를 이름으로 빼는 플래그가 아예 없고(`--help` 전수),
 *   유일한 후보였던 `--dangerously-skip-permissions --sandbox --mode plan` 은:
 *     1차 측정 → 파일 안 생김. "쓰기를 막는다"로 보였다.
 *     2차 측정(셸까지 명시적으로 시킴) → `run_command` 가 **그대로 통과**해 파일이 생겼다.
 *   즉 plan 모드는 경계가 아니다. 1차는 모델이 셸을 안 써 본 것뿐이었다.
 *   그래서 agy 의 read 는 "전부 열거나 전부 막거나" 둘뿐이고, 우리는 막는 쪽을 고른다.
 *   대신 그 사실을 사용자에게 **말한다**(아래 read 전용 고지) — 조용한 빈 실행 금지.
 */
export function antigravityPermissionArgs(
  permission?: "read" | "write" | "full",
  browserOnly = false,
): string[] {
  // Antigravity's headless CLI does not honor project settings' allow-rules for
  // MCP calls; its own diagnostic says to use `--dangerously-skip-permissions`
  // when no interactive approver is attached. Browser-only runs therefore need
  // the CLI bypass to get past its internal MCP gate, but keep `--sandbox` and
  // the Agentlas-owned one-server MCP config/Browser approval rail. This opens
  // the headless CLI gate without opening an unmanaged shell/browser path.
  if (browserOnly) return ["--dangerously-skip-permissions", "--sandbox"];
  if (permission === "full") return ["--dangerously-skip-permissions"];
  if (permission === "write") return ["--dangerously-skip-permissions", "--sandbox"];
  return [];
}

const AGY_BROWSER_PROJECT_ID = "agentlas-browser-automation-v1";
const AGY_BROWSER_POLICY_MARKER = "agentlas.desktop.browser-policy.v1";

export interface AntigravityBrowserProjectPolicy {
  projectId: string;
  workspace: string;
  configPath: string;
}

/**
 * Create the Agentlas-owned Antigravity project used by browser-only runs.
 * It is intentionally outside every user project and carries only the canonical
 * Agentlas Browser MCP. The CLI's headless permission gate is opened separately
 * because project allow-rules do not authorize MCP calls in print mode; shell,
 * file, and provider-native browser fallbacks remain outside the serialized
 * server set and are denied by the runtime prompt/rail.
 */
export async function ensureAntigravityBrowserProjectPolicy(
  home = os.homedir(),
): Promise<AntigravityBrowserProjectPolicy> {
  const workspace = path.join(home, ".agentlas", "runtime-homes", "antigravity-browser-v1");
  const configDir = path.join(home, ".gemini", "config", "projects");
  const configPath = path.join(configDir, `${AGY_BROWSER_PROJECT_ID}.json`);
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });

  if (await fs.stat(configPath).then(() => true, () => false)) {
    try {
      const current = JSON.parse(await fs.readFile(configPath, "utf8")) as { agentlasOwner?: string };
      if (current.agentlasOwner !== AGY_BROWSER_POLICY_MARKER) {
        throw new Error("Antigravity browser policy id is already owned by another project");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("already owned")) throw error;
      throw new Error("Existing Antigravity browser policy is unreadable; refusing to overwrite it");
    }
  }

  const policy = {
    id: AGY_BROWSER_PROJECT_ID,
    name: "Agentlas Browser Automation",
    agentlasOwner: AGY_BROWSER_POLICY_MARKER,
    projectResources: {
      resources: [{ folderUri: pathToFileURL(workspace).href }],
    },
    permissionGrants: {
      permissionGrants: {
        allow: ["mcp(agentlas-browser/*)"],
        deny: ["command(*)", "read_file(*)", "write_file(*)", "read_url(*)"],
      },
    },
    settings: {
      fileAccessPolicy: "AGENT_SETTING_POLICY_DENY",
      internetPolicy: "AGENT_SETTING_POLICY_DENY",
      autoExecutionPolicy: "CASCADE_COMMANDS_AUTO_EXECUTION_OFF",
      artifactReviewMode: "ARTIFACT_REVIEW_MODE_NEVER",
    },
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(policy, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, configPath);
  return { projectId: AGY_BROWSER_PROJECT_ID, workspace, configPath };
}

/** Antigravity의 헤드리스 실행 인자. 세션/stdin 계약은 사용하지 않는다. */
export function buildAntigravitySpawnArgs(
  model: string | undefined,
  prompt = "",
  addDirectories: string[] = [],
  permission?: "read" | "write" | "full",
  /** 출력 형태 계약 — 실측 agy 1.1.14 `--json-schema`(문자열 또는 파일 경로). */
  outputSchema?: Record<string, unknown>,
  /**
   * 이어갈 대화 ID. 있으면 히스토리를 통째로 재전송하지 않는다 — 실측 2026-08-19:
   * `--conversation <id>` 로 되돌린 턴이 이전 턴의 코드워드를 기억했다.
   */
  resumeConversationId?: string,
  browserProjectId?: string,
): string[] {
  const modelArgs = model && model.trim() ? ["--model", model.trim()] : [];
  const directoryArgs = [...new Set(addDirectories.filter((value) => value.trim()))]
    .flatMap((value) => ["--add-dir", value]);
  /*
   * ★agy도 stream-json으로 부른다(실측 1.1.10: step_update.text_delta + usage 지원).
   * 평문 모드는 최종 답까지 stdout이 침묵해서, 긴 생성(체스 게임 8분+)이 스톨 워치독
   * (480s 무응답)에 오폭됐다 — 실측 2026-08-06. 델타가 곧 생존 신호다.
   */
  /*
   * agy 헤드리스: --print-timeout 기본 5분은 긴 생성(체스 게임)을 agy가 스스로 포기하게
   * 만든다(실측) → 30분.
   */
  return [
    ...modelArgs, ...directoryArgs,
    ...(browserProjectId ? ["--project", browserProjectId] : []),
    ...antigravityPermissionArgs(permission, Boolean(browserProjectId)),
    "--output-format", "stream-json",
    "--print-timeout", "30m",
    ...(outputSchema ? ["--json-schema", JSON.stringify(outputSchema)] : []),
    ...(resumeConversationId ? ["--conversation", resumeConversationId] : []),
    "--prompt", prompt,
  ];
}


/** Metadata is only a freshness preflight; Main still owns scope and byte sealing. */
export function freshAgyArtifactPaths(paths: readonly string[], invocationStartedAtMs: number): string[] {
  if (!Number.isFinite(invocationStartedAtMs)) return [];
  return paths.filter((candidate) => {
    if (!path.isAbsolute(candidate) || /[\u0000\r\n]/u.test(candidate)) return false;
    try {
      const stat = lstatSync(candidate);
      return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0
        && stat.mtimeMs >= invocationStartedAtMs;
    } catch {
      return false;
    }
  });
}

/**
 * agy stream-json 한 줄을 읽는다 — 순수 함수(게이트가 픽스처 주입).
 * agent_response의 text_delta를 본문으로 누적하고, DONE의 usage를 집계한다.
 */
export function reduceAgyLine(
  line: string,
  state: {
    text: string;
    finalResponse?: string;
    inputTokens: number;
    outputTokens: number;
    /** 승인이 없어 거부된 도구 호출 — 구조 신호로 모은다(문구 판별이 아니다). */
    deniedTools?: { tool: string; detail: string }[];
    /**
     * ★agy 가 이 실행에 붙인 대화 ID. 실측 2026-08-19(agy 1.1.14): 최상위와
     * `result`·`step_update` 어디에나 `conversation_id` 로 실려 온다. 이걸 저장해
     * 다음 턴에 `--conversation` 으로 되돌리면 히스토리를 매 턴 통째로 재전송하지
     * 않아도 된다 — 재개가 실제로 기억한다는 것은 코드워드 실측으로 확인했다.
     */
    conversationId?: string;
    /** result 이벤트의 status/error — 표식이지 문구 판별이 아니다. */
    resultStatus?: string;
    resultError?: string;
    resultErrorCode?: string;
    resultRetryAfterHint?: string;
  },
): {
  delta?: string;
  activity?: string;
  approvalDenied?: { tool: string; detail: string };
  /*
   * ★agy 가 무슨 도구를 썼는지 — 예전에는 여기서 그냥 버렸다.
   *
   * agy 스트림은 step_type:"tool" 과 tool_name 을 그대로 준다. 그런데 러너가 그것을
   * 화면 이벤트로 올리지 않아, agy 실행은 활동 목록에도 출력 패널에도 아무것도 남기지
   * 못했다(실측: 도구 이벤트 0건, 다른 런타임은 Write/Bash 가 보인다). 사용자에게는
   * 일하는 동안 "작업 중" 한 줄만 보인다.
   */
  tool?: {
    name: string;
    id: string;
    failed: boolean;
    /** JSON of `tool_info.parameters` — 실측 1.1.13: list_dir {DirectoryPath}, view_file 등. */
    args?: string;
    /** `tool_info.output` — DONE 스텝에만 온다. */
    result?: string;
    done: boolean;
    /** Exact output argument from a successful, known write operation; never prose. */
    artifactPaths?: string[];
  };
} {
  let ev: {
    event?: string;
    conversation_id?: string;
    result?: {
      status?: string;
      response?: string;
      conversation_id?: string;
      /** 실측 agy 1.1.27 — 이 실행에서 승인이 없어 거부된 행동. 문구가 아니라 **필드**다. */
      denied_actions?: Array<{ action?: string; display_name?: string }>;
      /**
       * ★런타임이 왜 못 했는지 **직접 말해 주는 칸** (실측 2026-09-07, agy 1.1.27):
       *   {"event":"result","status":"ERROR","response":"",
       *    "error":"Individual quota reached. Please upgrade your subscription… Resets in 25m37s."}
       * 이 칸을 안 읽어서 사용자는 `Antigravity CLI exit 1` 만 봤다 — 언제 풀리는지도,
       * 무엇이 문제인지도 없이. 런타임이 이유를 말했는데 우리가 버린 자리다.
       */
      error?: string | {
        message?: unknown;
        code?: unknown;
        error_code?: unknown;
        errorCode?: unknown;
        retry_after?: unknown;
        retryAfter?: unknown;
      };
      /** Optional provider-owned machine fields. Unknown or malformed values are ignored. */
      error_code?: unknown;
      errorCode?: unknown;
      retry_after?: unknown;
      retryAfter?: unknown;
    };
    step_update?: {
      conversation_id?: string;
      step_type?: string; text_delta?: string; state?: string;
      tool_name?: string;
      tool_info?: {
        name?: string;
        parameters?: unknown;
        output?: unknown;
        error?: { type?: string; message?: string };
      };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
  };
  try {
    ev = JSON.parse(line);
  } catch {
    return {}; // 비-JSON 잡음(경고 등)은 본문이 아니다 — 평문 모드로 오인해 섞으면 산출물이 오염된다.
  }
  // 대화 ID 는 세 자리 중 어디로든 온다(실측 agy 1.1.14). 처음 본 값을 붙든다.
  state.conversationId ??=
    ev.conversation_id ?? ev.result?.conversation_id ?? ev.step_update?.conversation_id;
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
    if (typeof ev.result.status === "string") state.resultStatus = ev.result.status;
    const structuredError = ev.result.error && typeof ev.result.error === "object" && !Array.isArray(ev.result.error)
      ? ev.result.error
      : undefined;
    // 런타임이 말한 사유를 그대로 들고 간다 — 이것이 있으면 그것이 곧 실패 표식이다.
    const errorMessage = typeof ev.result.error === "string" ? ev.result.error : structuredError?.message;
    if (typeof errorMessage === "string" && errorMessage.trim()) state.resultError = errorMessage.trim();
    const errorCode = normalizeAntigravityFailureCode(
      ev.result.error_code ?? ev.result.errorCode
      ?? structuredError?.code ?? structuredError?.error_code ?? structuredError?.errorCode,
    );
    const retryAfterHint = normalizeAntigravityRetryAfter(
      ev.result.retry_after ?? ev.result.retryAfter
      ?? structuredError?.retry_after ?? structuredError?.retryAfter,
    );
    if (errorCode) state.resultErrorCode = errorCode;
    if (retryAfterHint) state.resultRetryAfterHint = retryAfterHint;
    /*
     * ★거부는 문구가 아니라 **필드**로 잡는다 (실측 2026-09-07, agy 1.1.27).
     *
     * 아래 tool 스텝 판별은 `tool_info.error.message` 안의 "denied permission" 같은
     * 문장 모양에 걸려 있다. 그 문장은 벤더가 판을 올릴 때마다 바뀌는 것이고, 바뀌는
     * 순간 이 실행은 다시 "성공했는데 답이 없다"로 조용히 지나간다 — 정확히 우리가
     * 반복해 온 손해다. agy 는 같은 사실을 result 이벤트에 구조로 실어 준다:
     *   {"event":"result","status":"SUCCESS","response":"",
     *    "denied_actions":[{"action":"command","display_name":"RunCommand"}]}
     * 이 필드는 문구와 무관하므로 이쪽을 정본으로 삼고, 문장 판별은 보조로 남긴다.
     * 같은 도구가 양쪽에 잡혀도 아래에서 이름으로 합치므로 중복 보고되지 않는다.
     */
    for (const denied of ev.result.denied_actions ?? []) {
      const tool = String(denied?.display_name || denied?.action || "").trim();
      if (!tool) continue;
      const already = (state.deniedTools ??= []);
      if (already.some((d) => d.tool === tool)) continue;
      already.push({
        tool,
        detail: `Antigravity auto-denied "${tool}" because headless mode has nobody to approve it.`,
      });
    }
    return { activity: "result" };
  }
  // step_update가 아닌 이벤트(init·checkpoint 등)도 프로세스가 살아 진행 중이라는 신호다.
  if (ev.event !== "step_update" || !ev.step_update) {
    return ev.event ? { activity: String(ev.event) } : {};
  }
  const step = ev.step_update;

  /*
   * ★승인이 없어 거부된 도구 호출 — 실측(agy 1.1.13, 플래그 없이 파일 쓰기 요청):
   *   step_type:"tool", state:"ERROR", tool_name:"write_to_file",
   *   tool_info.error.message: "User denied permission for write_file(<path>)."
   *   ...이어서 event:"result", status:"SUCCESS", response:"" 로 **성공 종료**한다.
   *
   * 사용자는 아무것도 거절한 적이 없다 — 헤드리스에는 물어볼 상대가 없어서 CLI가
   * 자동으로 거부한 것이다. 그런데 최종 결과가 SUCCESS + 빈 응답이라, 이 실행은
   * "성공했는데 답이 없다"로 처리되어 화면에 아무 표시도 남지 않았다.
   *
   * 문구가 아니라 **구조**(tool 스텝 + ERROR 상태 + 도구 이름)로 잡는다. 메시지는
   * 사용자에게 무엇이 막혔는지 보여주기 위해서만 들고 간다.
   */
  if (step.step_type === "tool" && step.state === "ERROR") {
    const message = step.tool_info?.error?.message ?? "";
    if (/\bdenied permission\b|\bpermission denied\b|\brequires? approval\b/i.test(message)) {
      const denial = {
        tool: step.tool_name || step.tool_info?.name || "tool",
        detail: message,
      };
      (state.deniedTools ??= []).push(denial);
      return { activity: `denied:${denial.tool}`, approvalDenied: denial };
    }
  }

  if (step.step_type === "tool") {
    const name = step.tool_name || step.tool_info?.name || "";
    if (name) {
      /*
       * ★인자와 출력을 버리지 않는다(2026-08-15 실측). 예전엔 이름만 올려서 화면 행이
       * "list_dir"뿐이었다 — 어느 폴더를 봤는지, 무엇이 나왔는지 없이. agy 스트림은
       * ACTIVE에 parameters, DONE에 parameters+output을 준다. 같은 도구 호출의 ACTIVE→DONE은
       * step_index로 이어진다(같은 id로 갱신되게 index를 id에 넣는다).
       */
      let params = step.tool_info?.parameters;
      let displayName = name;
      let envelope: unknown = params;
      if (name === "call_mcp_tool" && typeof params === "string") {
        try { envelope = JSON.parse(params); } catch { /* Preserve malformed provider data verbatim. */ }
      }
      if (name === "call_mcp_tool" && envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
        const call = envelope as { ServerName?: unknown; ToolName?: unknown; Arguments?: unknown };
        if (typeof call.ServerName === "string" && /^[a-zA-Z0-9_-]+$/u.test(call.ServerName)
          && typeof call.ToolName === "string" && /^[a-zA-Z0-9_-]+$/u.test(call.ToolName)
          && call.Arguments && typeof call.Arguments === "object" && !Array.isArray(call.Arguments)) {
          displayName = `mcp__${call.ServerName}__${call.ToolName}`;
          params = call.Arguments;
        }
      }
      const output = step.tool_info?.output;
      let structuredOutput: unknown = output;
      if (typeof output === "string") {
        try { structuredOutput = JSON.parse(output); } catch { /* Plain MCP result text remains display-only. */ }
      }
      const outputRecord = (name === "call_mcp_tool" || name.startsWith("mcp__"))
        && structuredOutput && typeof structuredOutput === "object" && !Array.isArray(structuredOutput)
        ? structuredOutput as Record<string, unknown> : null;
      const failed = step.state === "ERROR" || step.tool_info?.error != null
        || outputRecord?.isError === true || outputRecord?.is_error === true
        || (outputRecord?.error != null && outputRecord.error !== false);
      const validErrorFlags = !outputRecord || ["isError", "is_error"].every((key) =>
        !(key in outputRecord) || typeof outputRecord[key] === "boolean");
      // A completed screenshot writes its exact filename. Do not promote read,
      // shell, unknown-server, or arbitrary result-link paths into output evidence.
      const filename = params && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>).filename : undefined;
      const artifactPaths = step.state === "DONE" && !failed && validErrorFlags
        && displayName === "mcp__agentlas-browser__browser_take_screenshot"
        && typeof filename === "string" && path.isAbsolute(filename)
        && !/[\u0000\r\n]/u.test(filename) && /\.(?:png|jpe?g)$/iu.test(filename)
        ? [filename] : [];
      const stringify = (value: unknown): string | undefined => {
        if (value === undefined || value === null) return undefined;
        if (typeof value === "string") return value;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      };
      const stepIndex = (ev.step_update as { step_index?: unknown } | undefined)?.step_index;
      const done = step.state === "DONE" || step.state === "ERROR";
      return {
        activity: `tool:${name}`,
        tool: {
          name: displayName,
          id: `agy-tool:${name}:${typeof stepIndex === "number" ? stepIndex : (step.state ?? "")}`,
          failed,
          args: stringify(params),
          result: done ? (stringify(output) ?? (step.state === "ERROR" ? (step.tool_info?.error?.message ?? "error") : "")) : undefined,
          done,
          ...(artifactPaths.length > 0 ? { artifactPaths } : {}),
        },
      };
    }
  }

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


/**
 * agy 의 구조화된 provider code를 실패 종류로 옮긴다 — **순수 함수**.
 * `result.error`는 사용자가 읽을 사유로만 보존하며 분류 근거로 쓰지 않는다.
 */
const AGY_MACHINE_CODE_RE = /^(?:[A-Z][A-Z0-9_.:-]{0,63}|[1-9][0-9]{2})$/u;

/** Preserve only bounded provider-owned codes; never promote an error sentence into a code. */
export function normalizeAntigravityFailureCode(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const code = String(value).trim().toUpperCase();
  return AGY_MACHINE_CODE_RE.test(code) ? code : undefined;
}

/** Keep an ISO or compact relative retry hint only when it arrived in its own provider field. */
export function normalizeAntigravityRetryAfter(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 86_400) {
    return `in ${value}s`;
  }
  if (typeof value !== "string") return undefined;
  const hint = value.trim();
  if (!hint || hint.length > 80 || /[\r\n\u0000]/u.test(hint)) return undefined;
  if (/^(?:in\s+)?(?:(?:\d{1,2})h)?(?:(?:\d{1,3})m)?(?:(?:\d{1,5})s)?$/iu.test(hint)
    && /\d/u.test(hint)) {
    return hint.startsWith("in ") ? hint : `in ${hint}`;
  }
  const parsed = Date.parse(hint);
  return Number.isFinite(parsed) && /T/u.test(hint) ? new Date(parsed).toISOString() : undefined;
}

/** Classify only exact machine codes. A provider error field without one remains refused. */
export function antigravityFailureKind(_error: string, providerCode?: string): RunnerFailureKind {
  switch (normalizeAntigravityFailureCode(providerCode)) {
    case "429":
    case "RESOURCE_EXHAUSTED":
    case "QUOTA_EXCEEDED":
    case "RATE_LIMITED":
    case "RATE_LIMIT_EXCEEDED":
      return "quota";
    case "401":
    case "UNAUTHENTICATED":
    case "AUTHENTICATION_REQUIRED":
    case "INVALID_CREDENTIALS":
      return "auth";
    case "408":
    case "DEADLINE_EXCEEDED":
    case "TIMEOUT":
    case "TIMED_OUT":
      return "timeout";
    case "UNIMPLEMENTED":
    case "UNSUPPORTED_CLIENT":
      return "unsupported";
    default:
      return "refused";
  }
}

/** Antigravity exit 0 완주의 실패 판별 — 순수 함수(게이트가 픽스처 주입). */
export function antigravityExitFailure(
  stdout: string,
  stderr: string,
  runtime: typeof ANTIGRAVITY_KIND = ANTIGRAVITY_KIND,
): RunnerFailure | undefined {
  const combined = [stdout, stderr].map((value) => value.trim()).filter(Boolean).join("\n");
  if (/\bUNSUPPORTED_CLIENT\b/i.test(combined)) {
    return {
      kind: "unsupported",
      message: combined.slice(0, 400),
      runtime,
      source: "marker",
    };
  }
  const refusal = detectRuntimeRefusal(combined);
  return refusal ? { kind: refusal.kind, message: refusal.message, runtime, source: "heuristic" } : undefined;
}

/**
 * ★agy MCP 설정 실물 경로 — 실측 2026-08-18 (agy 1.1.14).
 *
 * 오랫동안 이 러너에는 MCP 배선이 없었고, shared/runtime-mcp.ts 는 "antigravity 는
 * MCP 표면이 없다"고 적어 두었다. 그 근거가 반증됐다: `~/.gemini/config/mcp_config.json`
 * 에 등록한 프로브 서버가 실행 시작 시 initialize → notifications/initialized →
 * server/discover → tools/list 를 받았다(프로브 서버의 수신 로그로 확인). agy 의 내장
 * 도구 목록에도 call_mcp_tool · list_resources · read_resource 가 실재한다.
 */
/**
 * 우리가 전역 설정에 넣은 MCP 서버 키 → 지금 그 정확한 transport를 쓰는 실행 수.
 *
 * agy 는 설정 파일이 하나뿐이라 동시 실행이 같은 파일을 공유한다. 계수 없이 정리하면
 * 먼저 끝난 실행이 아직 도는 실행의 도구를 지운다 — 그래프에서 노드 둘이 병렬로 도는
 * 흔한 경우가 정확히 그 모양이다. 모든 실행이 같은 메인 프로세스 안에 있으므로
 * 프로세스 안 계수는 동일 Main 공유만 담당하고, 별도 lifetime lease가 설치 간 충돌을 막는다.
 */
const AGY_MCP_REFCOUNT = new Map<string, number>();
const AGY_MCP_ACTIVE_ENTRIES = new Map<string, AgyMcpServerEntry>();
let agyMcpMutationTail: Promise<void> = Promise.resolve();

async function withAgyMcpMutationLock<T>(action: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = agyMcpMutationTail;
  agyMcpMutationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

export function agyMcpConfigPath(home = os.homedir()): string {
  return path.join(home, ".gemini", "config", "mcp_config.json");
}

interface AgyMcpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** agy 의 URL 형 필드명 — 실물 설정의 lazyweb 항목이 이 모양이다. */
  serverUrl?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

interface AgyMcpReplacement {
  previous: AgyMcpServerEntry;
  staged: AgyMcpServerEntry;
}

// The global agy config is shared by installed and source Desktop instances.
// Keep the previous Agentlas-owned browser entry while a newer instance is
// using the canonical key, then restore it when the last local reference ends.
const AGY_MCP_REPLACEMENTS = new Map<string, AgyMcpReplacement>();

function isAgyMcpEntryEqual(left: AgyMcpServerEntry | undefined, right: AgyMcpServerEntry | undefined): boolean {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}

function requestedAgyMcpEntry(server: {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}): AgyMcpServerEntry | null {
  return server.command
    ? {
      command: server.command,
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
    }
    : server.url
      ? {
        serverUrl: server.url,
        ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}),
      }
      : null;
}

/**
 * Recognise an Agentlas-owned browser proxy left by another Desktop instance.
 *
 * agy has one process-wide mcp_config.json, so a source/dev Desktop otherwise
 * reuses the installed app's approval channel and gets denied by the wrong
 * run. User MCP entries are left untouched: all four proxy markers plus the
 * canonical Agentlas Browser launcher must be present before this returns true.
 */
export function isAgentlasOwnedBrowserMcpEntry(
  entry: AgyMcpServerEntry,
): boolean {
  if (
    !entry.command
    || !Array.isArray(entry.args)
    || entry.args.length !== 1
    || path.basename(entry.args[0] ?? "") !== "proxy-child.cjs"
  ) return false;
  const env = entry.env;
  if (
    !env
    || env.ELECTRON_RUN_AS_NODE !== "1"
    || typeof env[MCP_PROXY_CONTROL_FILE_ENV] !== "string"
    || typeof env[MCP_PROXY_SERVER_KEY_ENV] !== "string"
    || typeof env[MCP_PROXY_SESSION_ENV] !== "string"
    || typeof env[MCP_PROXY_TARGET_ENV] !== "string"
  ) return false;
  let target: { command?: unknown; args?: unknown; env?: unknown };
  try {
    target = JSON.parse(env[MCP_PROXY_TARGET_ENV]);
  } catch {
    return false;
  }
  if (!target || typeof target !== "object" || !Array.isArray(target.args)) return false;
  const targetArgs = target.args.filter((arg): arg is string => typeof arg === "string");
  return targetArgs.length === target.args.length
    && targetArgs.some((arg) => path.basename(arg) === BROWSER_CDP_LAUNCHER_BASENAME);
}

/**
 * A previous Desktop process can leave its Agentlas-owned entry in agy's
 * process-wide config after the run itself has settled. In particular, the old
 * keyless Playwright duplicate then keeps an empty-profile Chromium alive even
 * though the next Graph run selected the authenticated Agentlas Browser.
 *
 * Only recognise the exact Agentlas proxy envelope and inspect its value-free
 * launch shape. A user-owned Playwright entry, a server with credentials, or an
 * explicit profile is never classified as ours and is never pruned.
 */
export function isStaleAgentlasPlaywrightProxyEntry(entry: AgyMcpServerEntry): boolean {
  if (!entry.command || path.resolve(entry.command) !== path.resolve(process.execPath)) return false;
  if (!Array.isArray(entry.args) || entry.args.length !== 1 || path.basename(entry.args[0] ?? "") !== "proxy-child.cjs") {
    return false;
  }
  const env = entry.env;
  if (!env || env.ELECTRON_RUN_AS_NODE !== "1") return false;
  if (
    typeof env[MCP_PROXY_CONTROL_FILE_ENV] !== "string" ||
    typeof env[MCP_PROXY_SERVER_KEY_ENV] !== "string" ||
    typeof env[MCP_PROXY_SESSION_ENV] !== "string" ||
    typeof env[MCP_PROXY_TARGET_ENV] !== "string"
  ) return false;

  let target: { command?: unknown; args?: unknown; env?: unknown };
  try {
    target = JSON.parse(env[MCP_PROXY_TARGET_ENV]);
  } catch {
    return false;
  }
  if (typeof target.command !== "string" || !Array.isArray(target.args)) return false;
  let command = path.basename(target.command).toLowerCase();
  let args = target.args.filter((arg): arg is string => typeof arg === "string");
  if (args.length !== target.args.length) return false;
  let targetEnv = target.env;
  // mcp-config runs external stdio servers through the least-privilege child
  // wrapper before the approval proxy. Unwrap only that exact value-free
  // envelope; a non-empty vault mapping means the server has credentials and
  // therefore is not the disposable duplicate handled here.
  if (
    path.resolve(target.command) === path.resolve(process.execPath) &&
    args.length >= 5 &&
    path.basename(args[0] ?? "") === "mcp-child-env-wrapper.cjs"
  ) {
    let mapping: unknown;
    try {
      mapping = JSON.parse(args[2] ?? "");
    } catch {
      return false;
    }
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || Object.keys(mapping).length > 0) return false;
    if (!targetEnv || typeof targetEnv !== "object" || Array.isArray(targetEnv)) return false;
    if (Object.keys(targetEnv).some((key) => key !== "ELECTRON_RUN_AS_NODE")) return false;
    if ((targetEnv as Record<string, unknown>).ELECTRON_RUN_AS_NODE !== "1") return false;
    command = path.basename(args[3] ?? "").toLowerCase();
    args = args.slice(4);
    targetEnv = {};
  }
  if (targetEnv && (typeof targetEnv !== "object" || Array.isArray(targetEnv) || Object.keys(targetEnv).length > 0)) return false;
  if (command !== "npx" && command !== "npx.cmd" && command !== "node" && command !== "node.exe") return false;
  if (args.some((arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir="))) return false;
  const packageToken = /^@playwright\/mcp(?:@[^\s]+)?$/i;
  return command === "npx" || command === "npx.cmd"
    ? args.some((arg) => packageToken.test(arg.trim()))
    : args.some((arg) => /(?:^|[\\/])@playwright[\\/]mcp(?:[\\/]|$)/i.test(arg));
}

/**
 * 이 실행이 승인받은 MCP 서버들을 agy 전역 설정에 **더하고**, 실행이 끝나면 우리가
 * 더한 키만 되돌린다 — grok 러너의 `grok mcp add/remove` 리컨실과 같은 계약이다.
 *
 * 규칙:
 * - 이미 있는 사용자 키는 절대 건드리지 않는다. 단, 다른 Agentlas Desktop 인스턴스가
 *   남긴 **우리 소유의 canonical browser proxy**는 현재 실행의 proxy로 잠시 교체하고,
 *   마지막 실행이 끝나면 원래 항목을 복원한다. source/dev와 설치 앱이 같은 agy 전역
 *   키를 공유하기 때문에 이 예외가 없으면 dev가 production 승인 채널을 재사용한다.
 *   cleanup은 우리가 넣거나 교체한 값이 아직 그대로일 때만 수행한다.
 * - 전역 파일이 깨진 JSON 이면 **덮어쓰지 않는다** — 사용자 설정을 지키는 쪽이
 *   이 실행에 도구를 주는 것보다 우선이고, 그 사실을 상태줄로 말한다(정직한 강등).
 * - 동시 실행은 exact transport entry만 공유한다. 같은 키에 다른 승인 채널을 요청하면
 *   뒤 실행을 모델 spawn 전에 typed conflict로 끝낸다.
 */
/** AGY does not expand shell-style aliases in MCP env overrides. Keep vault
 * values in the child process environment, never in its shared config file. */
export function inheritAgyMcpSecretAliases(
  env: Record<string, string> | undefined,
  runtimeEnv: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!env) return env;
  const result = { ...env };
  for (const [key, value] of Object.entries(result)) {
    if (!/^AGENTLAS_MCP_SECRET_[A-F0-9]{32}$/.test(key)) continue;
    if (value !== `\${${key}}` || !runtimeEnv[key] || runtimeEnv[key] === value) {
      throw new Error("agy_mcp_secret_binding_unavailable");
    }
    delete result[key];
  }
  if (result.AGENTLAS_MCP_PROXY_TARGET) {
    const target = JSON.parse(result.AGENTLAS_MCP_PROXY_TARGET);
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error("agy_mcp_proxy_target_invalid");
    }
    result.AGENTLAS_MCP_PROXY_TARGET = JSON.stringify({ ...target,
      env: inheritAgyMcpSecretAliases(target.env, runtimeEnv) });
  }
  return result;
}

async function reconcileAgyMcpServers(
  mcpConfigPath: string | undefined,
  onStatus: (message: string) => void,
  runtimeEnv: NodeJS.ProcessEnv = {},
): Promise<{ cleanup: () => Promise<void>; assertReady?: () => Promise<void>; failure?: RunnerFailure }> {
  const noop = { cleanup: async () => {} };
  let lease: Awaited<ReturnType<typeof acquireAgyMcpLease>>;
  try { lease = await acquireAgyMcpLease(agyMcpConfigPath()); }
  catch { return { ...noop, failure: { kind: "refused", source: "marker", runtime: "antigravity",
    providerCode: "agy_mcp_scope_conflict", message: "Antigravity MCP configuration is leased by another run or its owner could not be verified." } }; }
  try {
    const global = JSON.parse(await fs.readFile(agyMcpConfigPath(), "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}";
      throw error;
    }));
    const requested = mcpConfigPath ? JSON.parse(await fs.readFile(mcpConfigPath, "utf8")) : {};
    const browser = global.mcpServers?.["agentlas-browser"];
    if (browser && isAgentlasOwnedBrowserMcpEntry(browser)) {
      if (!requested.mcpServers?.["agentlas-browser"]) throw new Error("agy_mcp_browser_binding_missing");
      const previousControl = browser.env?.[MCP_PROXY_CONTROL_FILE_ENV];
      const nextControl = requested.mcpServers["agentlas-browser"].env?.[MCP_PROXY_CONTROL_FILE_ENV];
      // A foreign extant channel is not proven stale. Old Desktop versions do
      // not know about this lease, so never overwrite their live/unknown grant.
      if (previousControl !== nextControl && typeof previousControl === "string") {
        try { await fs.stat(previousControl); throw new Error("agy_mcp_foreign_owner_unverified"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    const bound = await reconcileAgyMcpServersUnderLease(mcpConfigPath, onStatus, runtimeEnv, lease.generation);
    if (bound.failure) { await lease.release(); return bound; }
    const stagedConfig = JSON.parse(await fs.readFile(agyMcpConfigPath(), "utf8").catch(() => "{}"));
    const guardedKeys = Object.keys(stagedConfig.mcpServers ?? {}).filter((key) => stagedConfig.mcpServers[key]?.env?.AGENTLAS_AGY_MCP_GENERATION === lease.generation);
    const assertReady = async () => {
      await lease.assertOwned();
      const current = JSON.parse(await fs.readFile(agyMcpConfigPath(), "utf8").catch(() => "{}"));
      for (const key of guardedKeys) {
        const entry = current.mcpServers?.[key];
        if (!isAgyMcpEntryEqual(entry, stagedConfig.mcpServers[key])) {
          throw new Error("agy_mcp_configuration_drift");
        }
      }
      onStatus(`[agy-mcp-scope] phase=load generation=${lease.generation}`);
    };
    onStatus(`[agy-mcp-scope] phase=staged generation=${lease.generation}`);
    return { assertReady, cleanup: async () => { try { await bound.cleanup(); } finally { await lease.release(); } } };
  } catch (error) {
    await lease.release().catch(() => {});
    const code = error instanceof Error && /^agy_mcp_[a-z_]+$/.test(error.message) ? error.message : "agy_mcp_config_unavailable";
    return { ...noop, failure: { kind: "refused", source: "marker", runtime: "antigravity",
      providerCode: code, message: "Antigravity MCP configuration could not be bound to this authorized run." } };
  }
}

async function reconcileAgyMcpServersUnderLease(
  mcpConfigPath: string | undefined,
  onStatus: (message: string) => void,
  runtimeEnv: NodeJS.ProcessEnv = {},
  generation?: string,
): Promise<{ cleanup: () => Promise<void>; failure?: RunnerFailure }> {
  const noop = { cleanup: async () => {} };
  if (!mcpConfigPath) return noop;
  let requested: { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }> };
  try {
    if (runtimeEnv.AGENTLAS_NATIVE_BROWSER_SCOPE === "task") {
      const rows = preparedMcpBindings(mcpConfigPath);
      if (!rows.some((row) => row.configKey === "agentlas-browser" && row.server.catalogId === "agentlas-browser")) {
        throw new Error("native_browser_mcp_binding_required");
      }
      for (const row of rows) preparedMcpTransport(row, row.server);
    }
    requested = JSON.parse(await fs.readFile(mcpConfigPath, "utf8"));
    for (const server of Object.values(requested.mcpServers ?? {})) {
      const aliases = Object.keys(server.env ?? {}).filter((key) => /^AGENTLAS_MCP_SECRET_[A-F0-9]{32}$/.test(key)).sort();
      server.env = inheritAgyMcpSecretAliases(server.env, runtimeEnv);
      if (generation) server.env = { ...server.env, AGENTLAS_AGY_MCP_CONFIG: agyMcpConfigPath(),
        AGENTLAS_AGY_MCP_GENERATION: generation, AGENTLAS_AGY_MCP_SERVER_KEY: Object.entries(requested.mcpServers ?? {}).find(([, value]) => value === server)?.[0] ?? "" };
      if (aliases.length) {
        // Removing overlays must not make different live grants appear equal
        // to the global-config concurrency guard. Only a digest is persisted.
        server.env = { ...server.env, AGENTLAS_MCP_RUN_BINDING: createHash("sha256")
          .update(JSON.stringify(aliases.map((key) => [key, runtimeEnv[key]]))).digest("hex") };
      }
      if (generation) {
        const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
          : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
        server.env = { ...server.env, AGENTLAS_AGY_MCP_ENTRY_INTEGRITY: createHash("sha256")
          .update(JSON.stringify(canonical(requestedAgyMcpEntry(server)))).digest("hex") };
      }
    }
  } catch {
    return {
      cleanup: async () => {},
      failure: {
        kind: "refused",
        message: "Antigravity MCP transport could not read its authorized run configuration.",
        runtime: "antigravity",
        source: "marker",
        providerCode: "agy_mcp_config_unavailable",
      },
    };
  }
  const entries = Object.entries(requested.mcpServers ?? {});
  if (entries.length === 0) return noop;

  return withAgyMcpMutationLock(async () => {

    const globalPath = agyMcpConfigPath();
    let parsed: { mcpServers?: Record<string, AgyMcpServerEntry>; [key: string]: unknown };
    try {
      parsed = JSON.parse(await fs.readFile(globalPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        parsed = { mcpServers: {} };
      } else {
        onStatus("antigravity: existing mcp_config.json is unreadable — run stopped before model execution");
        return {
          cleanup: async () => {},
          failure: {
            kind: "refused",
            message: "Antigravity MCP transport could not safely reconcile its global configuration.",
            runtime: "antigravity",
            source: "marker",
            providerCode: "agy_mcp_global_config_unavailable",
          },
        };
      }
    }
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") parsed.mcpServers = {};

  // An agy process reads one global MCP file. Sharing is safe only when the
  // exact transport entry is already active; a matching key alone can point
  // at another chat's approval proxy. Refuse the later run before spawning
  // instead of lending it the first run's authority.
    for (const [key, server] of entries) {
    const live = AGY_MCP_REFCOUNT.get(key);
    const requestedEntry = requestedAgyMcpEntry(server);
    if (live === undefined) {
      if (key === "agentlas-browser" && isAgentlasOwnedBrowserMcpEntry(parsed.mcpServers[key] ?? {})) continue;
      if (!parsed.mcpServers[key] || isAgyMcpEntryEqual(parsed.mcpServers[key], requestedEntry ?? undefined)) continue;
      // Preserve user entries without borrowing their different scope. This
      // preflight must precede any process refcount or global-file mutation.
      return { cleanup: async () => {}, failure: { kind: "refused", source: "marker", runtime: "antigravity",
        providerCode: "agy_mcp_scope_conflict", message: "An existing MCP key belongs to a different transport scope." } };
    }
    const activeEntry = AGY_MCP_ACTIVE_ENTRIES.get(key);
    if (requestedEntry && isAgyMcpEntryEqual(activeEntry, requestedEntry)
      && isAgyMcpEntryEqual(parsed.mcpServers[key], activeEntry)) continue;
    return {
      cleanup: async () => {},
      failure: {
        kind: "refused",
        message: "Antigravity MCP transport is already in use by a different authorized run.",
        runtime: "antigravity",
        source: "marker",
        providerCode: "agy_mcp_scope_conflict",
      },
    };
    }

  const writeGlobal = async (value: typeof parsed): Promise<void> => {
    // 임시 파일 + rename — 시작 중인 다른 agy 가 반쯤 쓰인 파일을 읽지 않게 한다.
    const tmp = `${globalPath}.agentlas-${process.pid}-${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(tmp, globalPath);
  };

  const requestedKeys = new Set(entries.map(([key]) => key));
  const canonicalBrowserRequested = requestedKeys.has("agentlas-browser");
  let globalDirty = false;
  if (canonicalBrowserRequested) {
    for (const [key, server] of Object.entries(parsed.mcpServers)) {
      if (requestedKeys.has(key) || AGY_MCP_REFCOUNT.has(key)) continue;
      if (!isStaleAgentlasPlaywrightProxyEntry(server)) continue;
      delete parsed.mcpServers[key];
      globalDirty = true;
    }
  }

  const added: string[] = [];
  const stagedEntries = new Map<string, AgyMcpServerEntry>();
  const previousRefcounts = new Map<string, number | undefined>();
  const previousActiveEntries = new Map<string, AgyMcpServerEntry | undefined>();
  const previousReplacements = new Map<string, AgyMcpReplacement | undefined>();
  const rememberProcessState = (key: string) => {
    if (previousRefcounts.has(key)) return;
    previousRefcounts.set(key, AGY_MCP_REFCOUNT.get(key));
    previousActiveEntries.set(key, AGY_MCP_ACTIVE_ENTRIES.get(key));
    previousReplacements.set(key, AGY_MCP_REPLACEMENTS.get(key));
  };
  for (const [key, server] of entries) {
    if (parsed.mcpServers[key]) {
      /*
       * ★이미 있는 키 — 두 경우가 섞여 있다.
       *
       * (a) 사용자가 직접 등록한 서버: 우리 것이 아니므로 소유하지 않는다.
       * (b) **동시에 도는 다른 실행이 방금 넣은 서버**: 이걸 그냥 건너뛰면, 먼저 넣은
       *     실행이 끝나면서 지워 버려 이 실행은 도중에 도구를 잃는다. 실행 하나가
       *     끝났다고 다른 실행의 도구가 사라지면 안 된다.
       * (c) 다른 Agentlas Desktop 설치/소스 인스턴스가 남긴 browser proxy: 같은
       *     canonical 키를 써야 하는 agy 특성상 이번 실행의 proxy로 잠시 교체한다.
       *
       * 그래서 우리가 넣은 키는 참조 계수로 센다. 계수가 0이 될 때만 걷어낸다.
       */
      if (
        key === "agentlas-browser"
        && !AGY_MCP_REFCOUNT.has(key)
        && isAgentlasOwnedBrowserMcpEntry(parsed.mcpServers[key])
      ) {
        rememberProcessState(key);
        const staged: AgyMcpServerEntry = {
          command: server.command,
          ...(server.args?.length ? { args: server.args } : {}),
          ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
          ...(server.url ? { serverUrl: server.url } : {}),
          ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}),
        };
        const previous = parsed.mcpServers[key];
        parsed.mcpServers[key] = staged;
        AGY_MCP_REPLACEMENTS.set(key, { previous, staged });
        stagedEntries.set(key, staged);
        added.push(key);
        AGY_MCP_REFCOUNT.set(key, 1);
        AGY_MCP_ACTIVE_ENTRIES.set(key, staged);
        globalDirty = true;
        continue;
      }
      const live = AGY_MCP_REFCOUNT.get(key);
      if (live !== undefined) {
        rememberProcessState(key);
        AGY_MCP_REFCOUNT.set(key, live + 1);
        AGY_MCP_ACTIVE_ENTRIES.set(key, parsed.mcpServers[key]);
        stagedEntries.set(key, parsed.mcpServers[key]);
        added.push(key);
      }
      continue;
    }
    const staged = requestedAgyMcpEntry(server);
    if (!staged) {
      continue;
    }
    rememberProcessState(key);
    parsed.mcpServers[key] = staged;
    stagedEntries.set(key, staged);
    added.push(key);
    AGY_MCP_REFCOUNT.set(key, (AGY_MCP_REFCOUNT.get(key) ?? 0) + 1);
    AGY_MCP_ACTIVE_ENTRIES.set(key, staged);
  }
  if (added.length === 0 && !globalDirty) return noop;
  try {
    await writeGlobal(parsed);
  } catch (error) {
    for (const key of previousRefcounts.keys()) {
      const previousRefcount = previousRefcounts.get(key);
      const previousActive = previousActiveEntries.get(key);
      const previousReplacement = previousReplacements.get(key);
      if (previousRefcount === undefined) AGY_MCP_REFCOUNT.delete(key);
      else AGY_MCP_REFCOUNT.set(key, previousRefcount);
      if (previousActive === undefined) AGY_MCP_ACTIVE_ENTRIES.delete(key);
      else AGY_MCP_ACTIVE_ENTRIES.set(key, previousActive);
      if (previousReplacement === undefined) AGY_MCP_REPLACEMENTS.delete(key);
      else AGY_MCP_REPLACEMENTS.set(key, previousReplacement);
    }
    onStatus(`antigravity: could not stage MCP servers (${error instanceof Error ? error.message : String(error)}) — run stopped before model execution`);
    return {
      cleanup: async () => {},
      failure: {
        kind: "refused",
        message: "Antigravity MCP transport could not stage its authorized run configuration.",
        runtime: "antigravity",
        source: "marker",
        providerCode: "agy_mcp_stage_failed",
      },
    };
  }
  if (added.length === 0) return noop;
  let cleaned = false;
  return {
    cleanup: async () => withAgyMcpMutationLock(async () => {
      if (cleaned) return;
      cleaned = true;
      let current: typeof parsed | null = null;
      try {
        // 실행 중 남이 고쳤을 수 있으니 다시 읽고, 우리가 더한 키만 걷어낸다.
        current = JSON.parse(await fs.readFile(globalPath, "utf8")) as typeof parsed;
        if (!current.mcpServers || typeof current.mcpServers !== "object") current = null;
      } catch (error) {
        console.error("[antigravity] mcp cleanup read failed:", error);
      }
      try {
        let dirty = false;
        for (const key of added) {
          const live = (AGY_MCP_REFCOUNT.get(key) ?? 1) - 1;
          if (live > 0) {
            // 다른 실행이 아직 이 서버를 쓰고 있다 — 계수만 내리고 남겨 둔다.
            AGY_MCP_REFCOUNT.set(key, live);
            continue;
          }
          AGY_MCP_REFCOUNT.delete(key);
          AGY_MCP_ACTIVE_ENTRIES.delete(key);
          const staged = stagedEntries.get(key);
          const replacement = AGY_MCP_REPLACEMENTS.get(key);
          if (!current || !isAgyMcpEntryEqual(current.mcpServers![key], staged)) {
            // Another Desktop instance changed the key after us. Never remove
            // or restore a value that this run can no longer identify.
            if (replacement) AGY_MCP_REPLACEMENTS.delete(key);
            continue;
          }
          if (replacement) {
            current.mcpServers![key] = replacement.previous;
            AGY_MCP_REPLACEMENTS.delete(key);
            dirty = true;
          } else if (current.mcpServers![key]) {
            delete current.mcpServers![key];
            dirty = true;
          }
        }
        if (dirty && current) await writeGlobal(current);
      } catch (error) {
        console.error("[antigravity] mcp cleanup failed:", error);
      }
    }),
  };
  });
}

/**
 * A persisted Antigravity conversation belongs to the exact filesystem-observed
 * executable that produced it. This is not a semantic version claim.
 */
export function antigravitySessionFingerprint(
  req: Pick<RunnerRequest, "chatId" | "sessionFingerprintSeed" | "systemPrompt" | "model">,
  executableFingerprint: string,
): string | null {
  if (!req.chatId) return null;
  return createHash("sha256")
    .update("agy-session-v2\0")
    .update(req.sessionFingerprintSeed ?? req.systemPrompt ?? "")
    .update("\0")
    .update("\0executable\0")
    .update(executableFingerprint)
    .digest("hex");
}

async function runPreparedAntigravity(
  req: RunnerRequest,
  events: RunnerEvents,
  bin: string,
  executableFingerprint: string,
  agyAdditionalDirs: string[] = [],
): Promise<RunnerResult> {
  // 매 호출 full prompt를 Antigravity에 전달한다. 대화 연속성은 Agentlas가
  // history/turnContext를 prompt에 넣어 관리하고, agy 세션 ID에는 의존하지 않는다.
  const runReq = req;
  const runtimeSessionOwnerId = runReq.runtimeSessionOwnerId ?? runReq.agentId;
  const isolateRuntimeSessionOwner = runReq.runtimeSessionOwnerId != null;
  events.onStatus(tStatus(runReq.locale, "callingBackend", { backend: runReq.backendLabel }));
  /*
   * ★세션 재개 — agy 는 `--conversation <id>` 를 갖고 있었는데 우리가 안 썼다.
   *
   * 그동안 이 러너는 매 턴 시스템 프롬프트 + 전체 히스토리를 다시 보냈다. 대화가
   * 길어질수록 느려지고 컨텍스트 한도에 먼저 부딪히는 이유가 그것이다. 지문이 바뀌면
   * (시스템 프롬프트·모델이 달라지면) 이어가지 않는다 — 다른 계약의 대화를 물려받는
   * 것은 히스토리를 다시 보내는 비용보다 나쁘다.
   */
  const agyFingerprint = antigravitySessionFingerprint(runReq, executableFingerprint);
  const agySaved = runReq.chatId
    ? getRuntimeSession(runReq.chatId, ANTIGRAVITY_KIND, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner })
    : null;
  const agyResumeId =
    agySaved && agyFingerprint && agySaved.fingerprint === agyFingerprint ? agySaved.sessionId : null;
  const prompt = agyResumeId
    ? [runReq.turnContext?.trim(), runReq.userPrompt].filter(Boolean).join("\n\n")
    : buildPrompt(runReq);

  /*
   * ★이 실행이 실제로 도구를 쓸 수 있는가 — 권한 플래그와 세션 규칙이 같은 답을 써야 한다.
   * 두 곳이 어긋나면(플래그는 열고 프롬프트는 금지, 또는 그 반대) 모델은 자기가 무엇을
   * 할 수 있는지 모르게 된다. 무도구 격리 실행은 러너 진입에서 이미 거부되므로
   * (untrustedNoTools·restrictedReadBoundary), 여기서는 권한 칩만 보면 된다.
   */
  const agyToolsAllowed = runReq.browserOnly
    || runReq.permission === "write"
    || runReq.permission === "full";
  const browserProject = runReq.browserOnly
    ? await ensureAntigravityBrowserProjectPolicy()
    : null;

  // agy에는 stdin/prompt-file 입력이 없다. 전체 시스템·히스토리를 argv에 넣으면 로컬
  // process listing에 노출되고 Windows 길이 제한도 넘는다. 0600 파일에는 본문을,
  // argv에는 그 파일을 읽으라는 짧은 bootstrap만 전달한다.
  let agyPromptDirectory: string | null = null;
  let agyPromptFile: string | null = null;
  let spawnPrompt = prompt;
  /*
   * ★작업 폴더를 워크스페이스로 **등록**한다 — cwd로 스폰하는 것만으로는 부족하다.
   *
   * 실측(1.1.13): 같은 플래그·같은 cwd라도 `--add-dir <작업폴더>`가 있으면 파일이
   * 생성되고, 없으면 모델이 DONE이라고 답하는데 파일은 하나도 만들어지지 않는다.
   * agy는 등록된 워크스페이스 밖의 쓰기를 조용히 버린다 — 실패 표식조차 없어서
   * "했다고 말하는데 아무것도 없는" 상태가 된다.
   */
  /*
   * ★스폰 cwd 와 등록 폴더는 **같은 값**이어야 한다 — 그래서 변수 하나로 둔다.
   *
   * 예전에는 둘이 따로 계산됐고 기본값이 달랐다. cwd 는 `req.cwd ?? agentRunCwd()` 로
   * 폴백했는데 등록 목록은 `req.cwd` 가 없으면 **빈 채로** 남았다. 프로젝트를 고르지
   * 않은 실행(일반 대화가 파일을 만드는 흔한 경우)에서는 `--add-dir` 가 인자에서 통째로
   * 사라졌고, agy 는 등록된 워크스페이스가 없으니 쓰기를 자기 스크래치
   * (~/.gemini/antigravity-cli/scratch)로 돌렸다. 모델은 "만들었다"고 답하고 사용자가
   * 연 폴더는 비어 있다. 실행 중 프로세스의 인자와 cwd 를 직접 떠서 확인했다.
   */
  const agyWorkDir = browserProject?.workspace ?? runReq.cwd ?? agentRunCwd();
  let agyReadDirs = [agyWorkDir, ...agyAdditionalDirs];
  /*
   * ★agy 프롬프트는 **argv 한계에 걸릴 때만** 파일로 우회한다.
   *
   * 파일 부트스트랩은 argv 길이 제한 회피용이었는데, 무조건 쓰면 agy가 파일을 읽기 위해
   * 도구 호출(view_file)을 해야 하고, 헤드리스 승인 모드(request-review)에서 그 승인을
   * 기다리다 갇힌다 — 실측 2026-08-06: 그래프 노드가 40초 만에 NODE_NO_RESULT(본문 0)로
   * 죽거나 재현 프롬프트가 10분+ 행. 프롬프트를 argv로 직접 주면 도구가 아예 필요 없다.
   * macOS ARG_MAX ~1MB — 100KB 이하는 직접, 그 이상만 파일.
   */
  /*
   * ★세션 규칙은 이 실행이 실제로 도구를 쓸 수 있는지에 맞춰 말한다.
   *
   * 예전에는 권한과 무관하게 "도구를 시도하지 말고 파일로 저장하지 마라"를 항상 보냈다.
   * 쓰기 권한 실행에서 그 문장은 **거짓이자 금지령**이 된다 — 모델은 지시받은 대로
   * 코드를 화면에 그려주고 끝냈고, 프로젝트에는 파일 하나 생기지 않았다.
   * 권한 칩이 "읽기 + 쓰기"인데 아무것도 쓰이지 않는 상태가 여기서 만들어졌다.
   *
   * 도구가 열린 실행에서는 반대로 **실제로 만들라**고 말해야 한다. 코드를 답변에
   * 옮겨 적는 것으로 대신하는 것이 이 런타임의 기본 습관이기 때문이다.
   *
   * ★그리고 "끝나지 않는 명령"을 반드시 말해 준다. 도구를 열어 준 첫날 실측:
   * 모델이 요청대로 dev 서버를 띄웠고 Vite는 실제로 :5173에서 200을 응답했는데,
   * `npm run dev`를 **foreground로** 실행하는 바람에 그 명령이 끝나기를 기다리며
   * 실행이 8분+ 멈췄다. 화면에는 "작업 경로를 준비하는 중"만 남아 사용자에게는
   * 실패로 보인다 — 정작 결과물은 이미 떠 있는데도. 도구를 열어 주는 것과
   * **되돌아오게 하는 것**은 다른 일이다.
   */
  spawnPrompt = [
    "Non-interactive session rules:",
    ...(runReq.browserOnly
      ? [
          "- Only the Agentlas Browser MCP is available and pre-approved. Use it directly.",
          "- Never use run_command, file tools, provider-native browser tools, or another Playwright runtime.",
          "- Never print, serialize, or pass cookies, auth headers, or session tokens in arguments or output.",
          "- Complete browser work through the declared Agentlas Browser tools and report only observed results.",
        ]
      : agyToolsAllowed
      ? [
          "- Tools ARE available and pre-approved. Use them to do the work for real.",
          "- NEVER run a long-lived process in the foreground (dev servers, watchers, `npm run dev`,",
          "  `vite`, `next dev`, `tail -f`, anything that does not exit on its own). This session waits",
          "  for the command to finish, so a foreground dev server hangs the whole run until timeout.",
          "  Start it detached instead (for example `npm run dev >/tmp/dev.log 2>&1 &`), then poll the",
          "  URL until it answers, and report that URL. If a task only needs the site reachable, a",
          "  server that is already listening is done — do not restart it in the foreground.",
          "- Apply changes to the actual files in the workspace: create, edit, and run what the",
          "  request needs. Printing code in your reply is NOT doing the work.",
          "- Your final text is a report of what you actually changed, not a substitute for it.",
        ]
      : [
        "- Tool calls cannot be approved here — do not attempt them.",
        "- Do NOT save your work to a file. Your final text response IS the deliverable;",
        "  the next automation step reads only that text. If the request asks for a file's",
        "  contents (HTML, code, a document), put the COMPLETE contents in your response.",
      ]),
    "",
    spawnPrompt,
  ].join("\n");
  if (runReq.browserOnly && spawnPrompt.length > AGY_ARGV_PROMPT_LIMIT) {
    throw new Error(
      `BROWSER_ONLY_PROMPT_TOO_LARGE: ${spawnPrompt.length} characters exceed the ${AGY_ARGV_PROMPT_LIMIT}-character private argv boundary`,
    );
  }
  if (spawnPrompt.length <= AGY_ARGV_PROMPT_LIMIT) {
    // 직접 전달 — 부트스트랩 없음.
  } else {
    agyPromptDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agentlas-antigravity-prompt-"));
    try {
      try {
        await fs.chmod(agyPromptDirectory, 0o700);
      } catch {
        // Windows 등 chmod 미지원 환경
      }
      agyPromptFile = path.join(agyPromptDirectory, "request.txt");
      await fs.writeFile(agyPromptFile, prompt, { encoding: "utf8", mode: 0o600 });
      spawnPrompt = buildAgyPromptBootstrap(agyPromptFile);
      /*
       * ★프롬프트 폴더를 **더한다**. 갈아치우지 않는다.
       *
       * 여기서 목록을 통째로 교체하면 바로 위에서 넣은 작업 폴더가 사라진다. 그러면
       * agy 는 사용자의 폴더를 워크스페이스로 받지 못하고, 쓰기를 자기 스크래치
       * (~/.gemini/antigravity-cli/scratch)로 돌린다 — 모델은 "만들었다"고 답하는데
       * 사용자가 연 폴더에는 아무것도 없다. 실측으로 정확히 그 모습을 봤다.
       *
       * 그리고 이 갈래는 예외가 아니라 평소다. 짧은 질문이라도 시스템 프롬프트와 세션
       * 규칙이 붙으면 argv 한도를 넘으므로, 실사용은 대부분 이 경로로 온다.
       */
      agyReadDirs = [agyPromptDirectory, agyWorkDir, ...agyAdditionalDirs];
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

  /*
   * ★MCP 서버 전달 — 승인된 서버를 agy 전역 설정에 리컨실한다(위 reconcileAgyMcpServers).
   * 도구가 닫힌 읽기 실행에는 붙이지 않는다: agy 헤드리스는 권한 플래그 없이 모든 도구
   * 호출을 자동 거부하므로, 서버를 붙여 봐야 "가진 척"만 된다(거짓 표시 금지).
   */
  const mcpReconcile = agyToolsAllowed
    ? await reconcileAgyMcpServers(req.mcpConfigPath, events.onStatus, req.env ?? process.env)
    : { cleanup: async () => {} };
  if (mcpReconcile.failure) return { text: "", failure: mcpReconcile.failure };
  try {
    if (req.env?.AGENTLAS_NATIVE_BROWSER_SCOPE === "task") {
      if (!req.mcpConfigPath) throw new Error("native_browser_mcp_config_required");
      for (const row of preparedMcpBindings(req.mcpConfigPath)) preparedMcpTransport(row, row.server);
    }
    if ("assertReady" in mcpReconcile) {
      try { await mcpReconcile.assertReady?.(); }
      catch { return { text: "", failure: { kind: "refused", source: "marker", runtime: "antigravity",
        providerCode: "agy_mcp_configuration_drift", message: "Antigravity MCP scope changed before model execution." } }; }
    }
    return await runAgyProcess();
  } finally {
    await mcpReconcile.cleanup();
  }

  function runAgyProcess(): Promise<RunnerResult> {
  return new Promise<RunnerResult>((resolve, reject) => {
    const invocationStartedAtMs = Date.now();
    // Antigravity는 빈 prompt를 거부하므로 긴 요청만 private 파일 bootstrap으로 우회한다.
    const env: NodeJS.ProcessEnv = { ...(req.env ?? process.env), GEMINI_CLI_TRUST_WORKSPACE: "true" };
    if (!env.TERM || env.TERM === "dumb") env.TERM = "xterm-256color";
    if (!env.COLORTERM) env.COLORTERM = "truecolor";

    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(
        bin,
        buildAntigravitySpawnArgs(
          req.model,
          spawnPrompt,
          agyReadDirs,
          agyToolsAllowed ? req.permission : undefined,
          req.outputSchema?.schema,
          agyResumeId ?? undefined,
          browserProject?.projectId,
        ),
        {
          stdio: ["ignore", "pipe", "pipe"],
          env,
          // 등록 폴더와 반드시 같은 값 — 위 agyWorkDir 주석 참고.
          cwd: agyWorkDir,
          ...detachedSpawnOpts(),
        },
      );
    } catch (error) {
      cleanupAgyPrompt();
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    trackRunChild(child);
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
    const agyState: {
      text: string;
      finalResponse?: string;
      inputTokens: number;
      outputTokens: number;
      deniedTools?: { tool: string; detail: string }[];
      conversationId?: string;
      resultStatus?: string;
      resultError?: string;
      resultErrorCode?: string;
      resultRetryAfterHint?: string;
    } = { text: "", inputTokens: 0, outputTokens: 0 };
    const announcedDenials = new Set<string>();
    const reportedAgyTools = new Set<string>();
    let agyLineBuf = "";

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const clearAgyHeartbeat = startCliHeartbeat(child, events.onStatus, "agy");
    // ★죽은 자식이 close를 안 보내면 이 실행은 영영 안 끝난다 — runner.ts 주석 참고.
    ensureChildCloseAfterExit(child, () => {
      events.onStatus("agy: process exited without closing its output — settling the run");
    });
    const consumeAgyLine = (line: string): void => {
      const trimmedLine = line.trim();
      if (!trimmedLine) return;
      const step = reduceAgyLine(trimmedLine, agyState);
      // 도구 호출을 화면으로 올린다 — 같은 도구가 진행(ACTIVE)/완료(DONE)로 두 번 오면 같은
      // id 로 갱신된다(ACTIVE 1회 + DONE 1회만 올린다; 반복 ACTIVE는 무시).
      if (step.tool) {
        const key = `${step.tool.id}:${step.tool.done ? "done" : "active"}`;
        if (!reportedAgyTools.has(key)) {
          reportedAgyTools.add(key);
          const artifactPaths = freshAgyArtifactPaths(step.tool.artifactPaths ?? [], invocationStartedAtMs);
          events.onTool?.(step.tool.name, step.tool.args, step.tool.result, step.tool.id, step.tool.failed, artifactPaths);
        }
      }
      /*
       * ★막힌 도구는 **즉시** 말한다. 이 실행은 뒤에서 SUCCESS + 빈 응답으로 끝나기 때문에,
       * 여기서 알리지 않으면 사용자는 아무 일도 일어나지 않은 화면만 보게 된다.
       */
      if (step.approvalDenied && !announcedDenials.has(step.approvalDenied.tool)) {
        announcedDenials.add(step.approvalDenied.tool);
        const tool = step.approvalDenied.tool;
        // 시트로도 올린다 — onNotice 는 대화에 남는 사실이고, 이건 지금 결정할 자리다.
        announceToolDenied({
          runtime: "antigravity",
          sessionKey: `antigravity:${runReq.chatId ?? runReq.cwd ?? "default"}`,
          tool,
          detail: step.approvalDenied.detail,
          cwd: runReq.cwd,
          deniedBy: "runtime-headless",
        });
        const ko = `승인이 필요한 도구 호출이 자동 거부됐습니다: ${tool}. 이 실행에는 승인할 사람이 붙어 있지 않아 런타임이 스스로 거부한 것이며, 사용자가 거절한 것이 아닙니다. 권한을 올리면 이어서 진행됩니다.`;
        const en = `A tool call needing approval was auto-denied: ${tool}. This run has nobody to approve it, so the runtime denied it itself — you did not reject it. Raising the permission lets it continue.`;
        events.onNotice?.({
          level: "warning",
          code: "approval-required",
          message: runReq.locale === "ko" ? ko : en,
          i18n: { ko, en },
        });
      }
      const now = Date.now();
      if (step.delta && now - lastEmit > 80 && agyState.text) {
        events.onPartial(agyState.text);
        lastEmit = now;
      } else if (step.activity && now - lastEmit > 5000) {
        // 델타 없는 활동(도구 스텝·생각) — 워치독 시계용. 5초 한도로 소음 억제.
        events.onStatus(`agy: ${step.activity}`);
        lastEmit = now;
      }
    };
    const consumeAgyText = (text: string): void => {
      // stream-json 라인 파싱 — 델타가 생존 신호이자 본문이다.
      agyLineBuf += text;
      let nl = agyLineBuf.indexOf("\n");
      while (nl >= 0) {
        const line = agyLineBuf.slice(0, nl);
        agyLineBuf = agyLineBuf.slice(nl + 1);
        consumeAgyLine(line);
        nl = agyLineBuf.indexOf("\n");
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => consumeAgyText(stdoutDecoder.write(chunk)));
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
      // A child may end on a UTF-8 code-point boundary or without a trailing
      // newline. Flush both decoder tails before deciding which result arrived.
      consumeAgyText(stdoutDecoder.end());
      stderr += stderrDecoder.end();
      if (agyLineBuf.trim()) {
        consumeAgyLine(agyLineBuf);
        agyLineBuf = "";
      }
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
        // If the final event itself is malformed, prefer a clean accumulated
        // response. If every candidate contains U+FFFD, fail closed instead of
        // persisting a visibly corrupted answer.
        const responseCandidates = [agyState.finalResponse, agyState.text]
          .filter((value): value is string => typeof value === "string" && value.length > 0);
        const agyBody = responseCandidates.find((value) => !value.includes("\uFFFD"));
        if (responseCandidates.length > 0 && !agyBody) {
          reject(new Error("Antigravity returned malformed UTF-8 output"));
          return;
        }
        const body = agyBody ?? "";
        const trimmed = body.trim();
        /*
         * ★승인 거부로 답이 비었으면 성공이 아니다.
         *
         * 실측(agy 1.1.13): 도구가 승인 없이 auto-deny되면 그 스텝만 ERROR로 지나가고,
         * 최종 이벤트는 `status:"SUCCESS", response:""` 로 온다. 그대로 두면 이 실행은
         * "성공했는데 답이 없다"가 되어 화면에 아무것도 남지 않는다 — 사용자에게는
         * 그냥 멈춘 것처럼 보인다.
         *
         * 답이 없고 막힌 도구가 있으면 그 사실을 실패 표식으로 싣는다. 소비자는
         * `failure` 칸으로 판정하므로(runtime-failure 계약) 조용히 지나갈 수 없다.
         */
        const denied = agyState.deniedTools ?? [];
        /*
         * ★read 권한의 빈 실행은 사고가 아니라 **구조**다 — 그렇게 말해야 한다.
         *
         * read 는 agy 에 권한 플래그를 주지 않고(위 antigravityPermissionArgs 주석의 실측),
         * 헤드리스에는 승인할 사람이 없으므로 agy 가 *모든* 도구를 자동 거부한다.
         * `pwd` 조차 막힌다. "승인이 없어 거부됐다"는 문장은 맞지만, 사용자에게는
         * 우연한 사고처럼 들려서 같은 실행을 다시 시키게 만든다. 다시 시켜도 결과는 같다.
         * 이 런타임에서 읽기 권한으로 도구 작업을 시킬 방법은 없으므로, 그 사실과
         * 푸는 길(권한을 올리거나 다른 런타임을 고르기)을 한 문장으로 말한다.
         */
        // 판정 근거는 새로 만들지 않는다 — 도구를 열었는지는 이미 agyToolsAllowed 가 안다.
        const structural = !agyToolsAllowed;
        /*
         * ★런타임이 오류 필드를 보냈으면 실패다. 종류는 별도 machine code로만 고른다.
         *
         * 실측 2026-09-07 (agy 1.1.27, 할당량 소진):
         *   {"event":"result","status":"ERROR","response":"",
         *    "error":"Individual quota reached. … Resets in 25m37s."}
         * 그리고 프로세스는 exit 1 로 끝나고 stderr 는 **비어 있다.** 이 칸을 안 읽던
         * 동안 사용자가 본 것은 `Antigravity CLI exit 1` 한 줄뿐이었다 — 무엇이
         * 문제인지도, 25분 뒤면 풀린다는 것도 없이. 다시 눌러도 같은 줄만 나온다.
         * 오류 필드 자체는 marker다. code가 없으면 사유 문구를 추측하지 않고 refused로 남긴다.
         */
        const hasRuntimeFailureMarker = Boolean(
          agyState.resultError
          || agyState.resultErrorCode
          || (agyState.resultRetryAfterHint && agyState.resultStatus?.toUpperCase() === "ERROR"),
        );
        const runtimeSaidWhy = hasRuntimeFailureMarker
          ? {
            kind: antigravityFailureKind(agyState.resultError ?? "", agyState.resultErrorCode),
            message: agyState.resultError ?? "Antigravity reported a structured provider failure.",
            runtime: "antigravity" as const,
            source: "marker" as const,
            ...(agyState.resultErrorCode ? { providerCode: agyState.resultErrorCode } : {}),
            ...(agyState.resultRetryAfterHint ? { retryAfterHint: agyState.resultRetryAfterHint } : {}),
            exitCode: 0,
          }
          : undefined;
        const failure = runtimeSaidWhy ?? (!trimmed && denied.length > 0
          ? {
            kind: "refused" as const,
            message: structural
              ? `Antigravity cannot use tools under read permission: this CLI has no way to allow read-only tools headlessly, so every call (${denied.map((d) => d.tool).join(", ")}) is auto-denied and the run returns nothing. Raise the permission to write, or pick another runtime for read-only work.`
              : `Antigravity produced no answer because ${denied.length === 1 ? "a tool call was" : `${denied.length} tool calls were`} auto-denied for missing approval: ${denied.map((d) => d.tool).join(", ")}. ${denied[0]?.detail ?? ""}`.trim(),
            runtime: "antigravity",
            source: "marker" as const,
          }
          : antigravityExitFailure(body, stderr)
          /*
           * ★답이 없는 성공은 성공이 아니다.
           *
           * agy 는 exit 0 + `status:"SUCCESS"` 로 끝나면서 응답이 비어 있을 수 있다(도구가
           * 조용히 막혔거나 모델이 아무것도 내지 않은 경우). 그동안 이 자리는 실패를 만들지
           * 않았고, 그래서 세 가지가 한꺼번에 일어났다: 화면에 아무 일도 일어나지 않고,
           * 사유가 어디에도 안 남고, **빈 대화가 세션으로 저장됐다.** 다음 턴은 그 세션을
           * 이어받아 히스토리 없이 새 한 줄만 보내므로, 사용자가 "d" 라고 치면 모델은 앞의
           * 2,000자를 본 적 없는 채로 "무엇을 할까요" 라고 되묻는다(실측 보고 2026-09-07).
           *
           * 빈 답은 `empty` 로 표식을 단다: 실패한 턴은 저장되지 않고, 연속 실행은 이 종류를
           * 일시적 실패로 보고 같은 턴을 다시 시도한다.
           */
          ?? (!trimmed && reportedAgyTools.size === 0
            ? {
              kind: "empty" as const,
              message: runReq.locale === "ko"
                ? "Antigravity 가 아무 답도 내지 않고 실행을 끝냈습니다. 이 턴은 결과로 인정하지 않습니다."
                : "Antigravity ended the run without producing any answer. This turn is not counted as a result.",
              runtime: "antigravity" as const,
              source: "exit" as const,
            }
            : undefined));
        /*
         * ★대화 ID 를 저장해야 재개가 다음 턴에 실제로 걸린다. 이 한 줄이 없으면
         * `--conversation` 배선은 영원히 죽은 코드다 — 저장 없이는 되돌릴 ID 가 없다.
         * 실패한 턴은 저장하지 않는다: 답이 없는 대화를 이어가면 다음 턴이 그 실패를
         * 문맥으로 물려받는다.
         */
        if (runReq.chatId && agyFingerprint && agyState.conversationId && !failure) {
          saveRuntimeSession(runReq.chatId, ANTIGRAVITY_KIND, agyState.conversationId, agyFingerprint, { agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner });
        }
        resolve({
          text: trimmed,
          ...(failure ? { failure } : {}),
          ...((agyState.inputTokens || agyState.outputTokens)
            ? {
              tokens: agyState.outputTokens,
              observedUsage: { inputTokens: agyState.inputTokens, outputTokens: agyState.outputTokens },
            }
            : {}),
        });
      } else if (agyState.resultError || agyState.resultErrorCode
        || (agyState.resultRetryAfterHint && agyState.resultStatus?.toUpperCase() === "ERROR")) {
        /*
         * ★exit != 0 이어도 런타임이 이유를 말했으면 그 이유가 결과다.
         *
         * 실측(할당량 소진): exit 1 · stderr 비어 있음 · result.error 에만 사유.
         * 예전에는 여기서 `Antigravity CLI exit 1` 로 던져 사유가 통째로 사라졌다.
         * 실패 표식으로 돌려주되, 재시도 종류는 별도 provider code가 있을 때만 구체화한다.
         */
        resolve({
          text: "",
          failure: {
            kind: antigravityFailureKind(agyState.resultError ?? "", agyState.resultErrorCode),
            message: agyState.resultError ?? "Antigravity reported a structured provider failure.",
            runtime: "antigravity",
            source: "marker",
            ...(agyState.resultErrorCode ? { providerCode: agyState.resultErrorCode } : {}),
            ...(agyState.resultRetryAfterHint ? { retryAfterHint: agyState.resultRetryAfterHint } : {}),
            ...(typeof code === "number" ? { exitCode: code } : {}),
          },
        });
      } else {
        resolve({
          text: "",
          failure: {
            kind: "exit",
            message: "Antigravity exited without a structured provider failure.",
            runtime: "antigravity",
            source: "exit",
            ...(typeof code === "number" ? { exitCode: code } : {}),
          },
        });
      }
    });
  });
  }
};

/** A configured tool surface must not silently become an answer-only read run. */
export function antigravityReadToolFailure(req: RunnerRequest): RunnerFailure | undefined {
  if (req.permission !== "read" || req.browserOnly
    || (!req.mcpConfigPath && !req.mcpAllowedTools?.length)) return undefined;
  return {
    kind: "refused", runtime: "antigravity", source: "marker",
    providerCode: "agy_read_tools_unsupported",
    message: req.locale === "ko"
      ? "Antigravity의 현재 헤드리스 실행은 읽기 권한을 유지하며 선택된 도구를 사용할 수 없습니다. 같은 읽기 권한을 지원하는 허용된 런타임이 필요합니다."
      : "Antigravity cannot use the configured tools while preserving read permission in this headless runtime. Use an allowed runtime supporting the same read scope.",
  };
}

export const runAntigravity: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  // agy 1.1.26 exposes terminal sandboxing and slash-command suppression,
  // but neither removes built-in tools or inherited global MCP servers. A
  // read permission without auto-approval is not a verified no-tools envelope.
  // Refuse before discovery, attachment staging, MCP reconciliation or spawn;
  // trusted invocations retain their existing permission and session contracts.
  if (req.untrustedNoTools) {
    throw new RuntimeJudgmentRefusal(
      "antigravity",
      req.locale === "ko"
        ? "현재 Antigravity CLI에서 기본 도구와 기존 MCP 서버를 모두 차단하는 격리가 검증되지 않아 비신뢰 실행을 시작할 수 없습니다. 격리 실행을 지원하는 런타임이 필요합니다."
        : "Antigravity CLI has no verified isolation that disables all built-in tools and inherited MCP servers. This untrusted run cannot start; use a runtime with verified isolation.",
    );
  }
  if (req.restrictedReadBoundary) {
    throw new Error(
      "Antigravity is not enabled for restricted read-only execution because its host filesystem boundary is not release-verified.",
    );
  }
  const readToolFailure = antigravityReadToolFailure(req);
  if (readToolFailure) return { text: "", failure: readToolFailure };
  const bin = await getBin({ source: req.runtimeSource });
  if (!bin) throw new Error(tStatus(req.locale, "errCliMissingAntigravity"));
  const executableIdentity = observeCliExecutableIdentity({
    bin,
    cwd: req.cwd ?? agentRunCwd(),
    env: req.env ?? process.env,
  });
  if (!executableIdentity) throw new Error(tStatus(req.locale, "errCliMissingAntigravity"));
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
  return runPreparedAntigravity(
    runReq,
    events,
    executableIdentity.executable,
    executableIdentity.fingerprint,
    stagedImages.directory ? [stagedImages.directory] : [],
  );
};
