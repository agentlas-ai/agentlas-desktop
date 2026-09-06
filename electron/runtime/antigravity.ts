// Antigravity CLI (agy) — 감지 + 실호출.
// Google 계정의 Antigravity 구독 런타임만 지원한다.
import path from "node:path";
import { RuntimeJudgmentRefusal } from "./judgment-refusal";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import os from "node:os";
import fs from "node:fs/promises";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult, RunnerFailure } from "./runner";
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
  };
} {
  let ev: {
    event?: string;
    conversation_id?: string;
    result?: { status?: string; response?: string; conversation_id?: string };
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
      const params = step.tool_info?.parameters;
      const output = step.tool_info?.output;
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
          name,
          id: `agy-tool:${name}:${typeof stepIndex === "number" ? stepIndex : (step.state ?? "")}`,
          failed: step.state === "ERROR",
          args: stringify(params),
          result: done ? (stringify(output) ?? (step.state === "ERROR" ? (step.tool_info?.error?.message ?? "error") : "")) : undefined,
          done,
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
 * 우리가 전역 설정에 넣은 MCP 서버 키 → 지금 그 서버를 쓰고 있는 실행 수.
 *
 * agy 는 설정 파일이 하나뿐이라 동시 실행이 같은 파일을 공유한다. 계수 없이 정리하면
 * 먼저 끝난 실행이 아직 도는 실행의 도구를 지운다 — 그래프에서 노드 둘이 병렬로 도는
 * 흔한 경우가 정확히 그 모양이다. 모든 실행이 같은 메인 프로세스 안에 있으므로
 * 프로세스 안 계수로 충분하다.
 */
const AGY_MCP_REFCOUNT = new Map<string, number>();

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
 * - 동시 agy 실행 둘이 같은 키를 원하는 짧은 경합은 grok 리컨실과 동일하게 남는다.
 */
async function reconcileAgyMcpServers(
  mcpConfigPath: string | undefined,
  onStatus: (message: string) => void,
): Promise<{ cleanup: () => Promise<void> }> {
  const noop = { cleanup: async () => {} };
  if (!mcpConfigPath) return noop;
  let requested: { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }> };
  try {
    requested = JSON.parse(await fs.readFile(mcpConfigPath, "utf8"));
  } catch {
    return noop;
  }
  const entries = Object.entries(requested.mcpServers ?? {});
  if (entries.length === 0) return noop;

  const globalPath = agyMcpConfigPath();
  let parsed: { mcpServers?: Record<string, AgyMcpServerEntry>; [key: string]: unknown };
  try {
    parsed = JSON.parse(await fs.readFile(globalPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      parsed = { mcpServers: {} };
    } else {
      onStatus("antigravity: existing mcp_config.json is unreadable — running without MCP tools to protect it");
      return noop;
    }
  }
  if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") parsed.mcpServers = {};

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
        globalDirty = true;
        continue;
      }
      const live = AGY_MCP_REFCOUNT.get(key);
      if (live !== undefined) {
        AGY_MCP_REFCOUNT.set(key, live + 1);
        stagedEntries.set(key, parsed.mcpServers[key]);
        added.push(key);
      }
      continue;
    }
    const staged: AgyMcpServerEntry | null = server.command
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
    if (!staged) {
      continue;
    }
    parsed.mcpServers[key] = staged;
    stagedEntries.set(key, staged);
    added.push(key);
    AGY_MCP_REFCOUNT.set(key, (AGY_MCP_REFCOUNT.get(key) ?? 0) + 1);
  }
  if (added.length === 0 && !globalDirty) return noop;
  try {
    await writeGlobal(parsed);
  } catch (error) {
    onStatus(`antigravity: could not stage MCP servers (${error instanceof Error ? error.message : String(error)}) — running without MCP tools`);
    return noop;
  }
  if (added.length === 0) return noop;
  return {
    cleanup: async () => {
      try {
        // 실행 중 남이 고쳤을 수 있으니 다시 읽고, 우리가 더한 키만 걷어낸다.
        const current = JSON.parse(await fs.readFile(globalPath, "utf8")) as typeof parsed;
        if (!current.mcpServers || typeof current.mcpServers !== "object") return;
        let dirty = false;
        for (const key of added) {
          const live = (AGY_MCP_REFCOUNT.get(key) ?? 1) - 1;
          if (live > 0) {
            // 다른 실행이 아직 이 서버를 쓰고 있다 — 계수만 내리고 남겨 둔다.
            AGY_MCP_REFCOUNT.set(key, live);
            continue;
          }
          AGY_MCP_REFCOUNT.delete(key);
          const staged = stagedEntries.get(key);
          const replacement = AGY_MCP_REPLACEMENTS.get(key);
          if (!isAgyMcpEntryEqual(current.mcpServers[key], staged)) {
            // Another Desktop instance changed the key after us. Never remove
            // or restore a value that this run can no longer identify.
            if (replacement) AGY_MCP_REPLACEMENTS.delete(key);
            continue;
          }
          if (replacement) {
            current.mcpServers[key] = replacement.previous;
            AGY_MCP_REPLACEMENTS.delete(key);
            dirty = true;
          } else if (current.mcpServers[key]) {
            delete current.mcpServers[key];
            dirty = true;
          }
        }
        if (dirty) await writeGlobal(current);
      } catch (error) {
        console.error("[antigravity] mcp cleanup failed:", error);
      }
    },
  };
}

async function runPreparedAntigravity(
  req: RunnerRequest,
  events: RunnerEvents,
  bin: string,
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
  const agyFingerprint = runReq.chatId
    ? createHash("sha256")
        .update("agy-session-v1\0")
        .update(runReq.sessionFingerprintSeed ?? runReq.systemPrompt ?? "")
        .update("\0")
        .update(runReq.model ?? "")
        .digest("hex")
    : null;
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
    ? await reconcileAgyMcpServers(req.mcpConfigPath, events.onStatus)
    : { cleanup: async () => {} };
  try {
    return await runAgyProcess();
  } finally {
    await mcpReconcile.cleanup();
  }

  function runAgyProcess(): Promise<RunnerResult> {
  return new Promise<RunnerResult>((resolve, reject) => {
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
          events.onTool?.(step.tool.name, step.tool.args, step.tool.result, step.tool.id, step.tool.failed);
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
        const failure = !trimmed && denied.length > 0
          ? {
            kind: "refused" as const,
            message: `Antigravity produced no answer because ${denied.length === 1 ? "a tool call was" : `${denied.length} tool calls were`} auto-denied for missing approval: ${denied.map((d) => d.tool).join(", ")}. ${denied[0]?.detail ?? ""}`.trim(),
            runtime: "antigravity",
            source: "marker" as const,
          }
          : antigravityExitFailure(body, stderr);
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
      } else {
        reject(
          new Error(
            `Antigravity CLI exit ${code}${stderr ? `\n${stderr.slice(0, 500)}` : ""}`,
          ),
        );
      }
    });
  });
  }
};

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
  const bin = await getBin({ source: req.runtimeSource });
  if (!bin) throw new Error(tStatus(req.locale, "errCliMissingAntigravity"));
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
    bin,
    stagedImages.directory ? [stagedImages.directory] : [],
  );
};
