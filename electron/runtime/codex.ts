// Codex CLI — 감지 + 실호출.
// 사용자의 ChatGPT Plus/Pro 구독으로 돌아간다 (PRD §3.1 6-A).
//
// 호출 형식: codex exec "<prompt>"  (—— Codex CLI의 exec 모드)
// V0는 single-turn; 이전 대화를 user 입력에 inline.
import path from "node:path";
import { RuntimeJudgmentRefusal } from "./judgment-refusal";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult , RunnerFailure } from "./runner";
import { cumulativeSurfaceGateText, ensureChildCloseAfterExit, startCliHeartbeat, wrapSystemPrompt, workforceObservedHostAuthorityEnforcement } from "./runner";
import { detectRuntimeRefusal } from "./runtime-refusal";
import { abortReasonError } from "./abort-reason";
import { containsMcpStartupTransportFatal } from "./mcp-startup-fatal";
import {
  CLI_HISTORY_CONTEXT_TOKENS,
  composeResumeTurnPrompt,
  renderConversationContext,
  renderGapContext,
  unseenHistoryGap,
} from "./continuity";
import { tStatus } from "./status-i18n";
import { agentRunCwd, detachedSpawnOpts, firstExistingCli, killCliTree, probeCliVersion, spawnCli, trackRunChild, writeStdin } from "./exec";
import { stageCliImageAttachments } from "./image-attachments";
import { inferInlineImageMime, parseMcpResult } from "../../shared/mcp-result-rendering";
import { saveBrowserCaptureArtifact } from "../media/capture-artifacts";
import {
  defaultCodexModelEffort,
  readCodexModelInventory,
  resolveCodexModelEffort,
} from "./codex-models";
import {
  clearRuntimeSession,
  getRuntimeSession,
  saveRuntimeSession,
} from "../store/runtime-sessions";
import { AcpRpcError } from "./acp-protocol";
import {
  CODEX_APP_SERVER_ARGS,
  CodexModelSelectionError,
  CodexSessionContinuityError,
  acknowledgeCodexThreadModel,
  answerCodexApproval,
  codexApprovalCapability,
  codexAppServerSupported,
  codexPoolKey,
  codexProtocolReceipt,
  codexResidentSessionAlive,
  codexSessionPool,
  isCodexApprovalRequest,
  isCodexMcpElicitationRequest,
  looksLikeMissingAppServer,
  markCodexAppServerUnsupported,
  openCodexResidentSession,
  prepareCodexThreadResume,
  type CodexResidentSession,
  type CodexTurnSink,
} from "./codex-session";
import { CodexWorkforceObservation, inspectCodexWorkforceGrant, readCodexWorkforceInventory, waitForCodexWorkforceInventory } from "./codex-workforce";
import { answerCodexMcpElicitation } from "./codex-elicitation";
import { residencyDisabledFor } from "./claude-session";
import { isResidencyExemptAgent, resolveAgentResidencySource } from "./agent-residency";
import type { AcpSessionLease } from "./acp-session-pool";
import { generateImage } from "../multimodal/image";
import { multimodalImageSlot, multimodalImageSlotDiagnosis } from "../multimodal/slot";
import {
  defaultRuntimeToolPermission,
  getRuntimeToolPermissionArbiter,
  type RuntimeToolPermissionAsk,
} from "./tool-approval";

const KIND = "codex";
const CODEX_IMAGE_TOOL_NAME = "generate_image";
const CODEX_IMAGE_TOOL_VERSION = "agentlas.generate-image.v1";

const CODEX_IMAGE_DYNAMIC_TOOL = {
  type: "function",
  name: CODEX_IMAGE_TOOL_NAME,
  description: "Generate the image the user asked for with Agentlas's configured multimodal slot. You MUST call this tool for image-generation requests. Never claim that an image was generated or displayed unless this tool returns success=true and an inputImage result.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        minLength: 1,
        maxLength: 1200,
        description: "Concrete visual prompt describing subject, composition, palette, aspect ratio, and style.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
} as const;

function codexImageToolCapability(req: RunnerRequest): string {
  if (req.untrustedNoTools || req.restrictedReadBoundary || req.judgmentOnly) return "disabled";
  const slot = multimodalImageSlot();
  return slot ? `${CODEX_IMAGE_TOOL_VERSION}:${slot.runtimeKind}:${slot.model}` : "unavailable";
}

function codexImageToolInstructions(enabled: boolean): string {
  return enabled
    ? [
        "## Agentlas image output contract",
        `For any request to create or edit an image, call the host tool \`${CODEX_IMAGE_TOOL_NAME}\`.`,
        "Do not inspect image skill files, spawn another image workflow yourself, or claim success from prose.",
        "You may say an image was generated or displayed only after the tool returns success=true with inputImage content.",
        "If the tool returns success=false, say generation failed and preserve its reason; never say the image is above or attached.",
      ].join("\n")
    : [
        "## Agentlas image output contract",
        "No host image-generation tool is attached to this thread.",
        "Never claim that an image was generated, attached, shown above, or displayed. Report that generation is unavailable instead.",
      ].join("\n");
}

const CANDIDATES = [
  // Windows: `.cmd`/`.exe`를 bare `codex`보다 먼저(bare는 PATHEXT 해석 시 `.ps1`을 잡아
  // PowerShell 실행정책에 막힐 수 있음 — .cmd는 cmd.exe로 실행돼 무관).
  ...(process.platform === "win32"
    ? [
        "codex.cmd",
        "codex.exe",
        path.join(process.env.APPDATA ?? "", "npm", "codex.cmd"),
        path.join(process.env.LOCALAPPDATA ?? "", "npm", "codex.cmd"),
        path.join(os.homedir(), ".local", "bin", "codex.exe"),
      ]
    : []),
  "codex",
  path.join(os.homedir(), ".local/bin/codex"), // 네이티브 인스톨러 기본 위치
  path.join(os.homedir(), ".agentlas/npm/bin/codex"), // 앱이 설치한 유저 prefix (sudo 불필요)
  path.join(os.homedir(), ".codex/bin/codex"),
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
];

export interface CodexProbe {
  path: string;
  version: string;
}

export async function probeCodex(): Promise<CodexProbe | null> {
  const found = await firstExistingCli(CANDIDATES);
  if (!found) return null;
  const version = (await probeCliVersion(found)) ?? "unknown";
  return { path: found, version };
}

let cachedBin: string | null | undefined;
/** Runtime updates may replace the executable or move it to another path. */
export function clearCodexBinCache(): void {
  cachedBin = undefined;
}

async function getBin(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  const probe = await probeCodex();
  cachedBin = probe?.path ?? null;
  return cachedBin;
}

function buildPrompt(req: RunnerRequest): string {
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
    const { block } = renderConversationContext(req.history, req.locale, CLI_HISTORY_CONTEXT_TOKENS);
    parts.push(block, "");
  }
  parts.push(tStatus(req.locale, "histThisSection"), req.userPrompt);
  return parts.join("\n");
}

/**
 * app-server has a first-class developer-instruction channel. Putting this
 * envelope in turn/start.input records it as a user utterance, so One showed
 * the private `[SYSTEM]` block in the conversation when the Codex thread was
 * reopened. Keep the exec fallback above unchanged, but never seed a resident
 * app-server thread with a fake user message.
 */
function buildDeveloperInstructions(req: RunnerRequest): string {
  return wrapSystemPrompt(
    req.systemPrompt,
    req.locale,
    req.permission,
    cumulativeSurfaceGateText(req.history, req.userPrompt),
    req.forceSurface,
    req.restrictedReadBoundary,
    req.untrustedNoTools,
  );
}

function buildResidentInitialTurnPrompt(req: RunnerRequest): string {
  const parts: string[] = [];
  if (req.history.length > 0) {
    const { block } = renderConversationContext(req.history, req.locale, CLI_HISTORY_CONTEXT_TOKENS);
    parts.push(block, "");
  }
  const turnContext = req.turnContext?.trim();
  if (turnContext) parts.push(turnContext, "");
  parts.push(tStatus(req.locale, "histThisSection"), req.userPrompt);
  return parts.join("\n");
}

const CODEX_WORKSPACE_WRITE_CONFIG_ARGS = [
  "-c", "sandbox_workspace_write.network_access=true",
  "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
  "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
] as const;

/**
 * 권한 칩 → codex `exec` 샌드박스 플래그. **순수 함수이고 모듈 밖으로 나간다.**
 * 설치된 CLI 로 이 벡터가 아직 통하는지 재는 프로브가 사본이 아니라 이 함수를 부른다
 * (사본은 러너가 바뀌어도 안 바뀌어서, 프로브만 초록인 상태를 만든다).
 */
export function codexPermissionArgs(
  permission?: RunnerRequest["permission"],
  reviewer?: RunnerRequest["approvalsReviewer"],
): string[] {
  return permissionArgs(permission, reviewer);
}

/** Resume uses config overrides because `codex exec resume` has no sandbox flag. */
export function codexResumePermissionArgs(
  permission?: RunnerRequest["permission"],
  reviewer?: RunnerRequest["approvalsReviewer"],
): string[] {
  return resumePermissionArgs(permission, reviewer);
}

/**
 * The non-interactive CLI has a distinct automatic-review switch. An internal
 * worker may use it only with Main's explicit auto_review reviewer; ordinary
 * user-reviewed turns must continue to stop at the existing approval surface.
 * This is separate from the workspace sandbox: a writable worker still keeps
 * its exact project root and network policy while Codex can approve its
 * read-only browser navigation request.
 */
export function codexApprovalArgs(
  reviewer?: RunnerRequest["approvalsReviewer"],
  permission?: RunnerRequest["permission"],
): string[] {
  return reviewer === "auto_review" && permission === "write" ? ["--approve-for-me"] : [];
}

function permissionArgs(
  permission?: RunnerRequest["permission"],
  reviewer?: RunnerRequest["approvalsReviewer"],
): string[] {
  if (permission === "full") {
    if (reviewer === "auto_review") {
      // `--approve-for-me` is the CLI's workspace-write-only auto-review
      // switch. Full access must keep its sandbox while routing approvals to
      // the same reviewer through the validated config keys.
      return ["--sandbox", "danger-full-access", "-c", `approval_policy="on-request"`];
    }
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  if (permission === "write") {
    // Root cause of "the agent can never reach the browser": codex's
    // workspace-write Seatbelt sandbox DENIES ALL network by default, so a
    // write-mode run (every automation, every acting chat) cannot even curl
    // 127.0.0.1:9222 — the local browser it is supposed to drive. Empirically
    // confirmed: workspace-write curl to CDP exits 7, adding network_access=true
    // reaches Chrome. Keep the filesystem sandbox; open network. The user drives
    // their own machine — a network-blind agent is a dead automation, not safety.
    return ["--sandbox", "workspace-write", ...CODEX_WORKSPACE_WRITE_CONFIG_ARGS];
  }
  const args = ["--sandbox", "read-only"];
  if (reviewer === "auto_review") {
    // `--approve-for-me` is workspace-write-only. Read-only workers still
    // need Codex's on-request policy so MCP calls can reach the configured
    // automatic reviewer without changing the filesystem ceiling.
    args.push("-c", `approval_policy="on-request"`);
  }
  return args;
}

function resumePermissionArgs(
  permission?: RunnerRequest["permission"],
  reviewer?: RunnerRequest["approvalsReviewer"],
): string[] {
  if (permission === "full") {
    if (reviewer === "auto_review") {
      // `exec resume` accepts the same config key but no `--sandbox` option.
      return [
        "-c", `sandbox_mode="danger-full-access"`,
        "-c", `approval_policy="on-request"`,
      ];
    }
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  // `codex exec resume` has no `--sandbox` flag, but accepts the same validated
  // config override. Reassert the boundary — and, for write, keep network open so
  // a resumed automation can still reach the local browser and HTTP.
  if (permission === "write") {
    return ["-c", `sandbox_mode="workspace-write"`, ...CODEX_WORKSPACE_WRITE_CONFIG_ARGS];
  }
  const args = ["-c", `sandbox_mode="read-only"`];
  if (reviewer === "auto_review") args.push("-c", `approval_policy="on-request"`);
  return args;
}

/**
 * 세션 지문 — 안정 시드(sessionFingerprintSeed)가 있으면 시드만 해시한다. 시드가 곧
 * 세션 정체성의 전부다: 모델/effort/권한은 매 호출 CLI 인자로 다시 적용되므로 세션을
 * 가를 이유가 없고, 지문에 섞으면 설정 하나 바꿀 때마다 대화 연속성이 끊긴다
 * (2026-07-16 세션유지 사고). 시드가 없는 레거시 호출만 전체 해시로 폴백한다.
 */
/*
 * ★Owner decision 2026-09-07 — a conversation survives a model change.
 *
 * The model used to be part of session identity, on the reasoning that a session belongs to the
 * model that created it. The reasoning is sound and the result was not: a usage limit that moved
 * the run to another model, or the person simply picking a different one, threw the CLI session
 * away. A fresh session receives only the conversation text, so everything the CLI actually held
 * -- files it had read, what its tools returned, the plan it was working from -- was gone, while
 * the transcript on screen stayed continuous and hid it.
 *
 * These CLIs take the model as a per-call argument; the thread is not bound to it. So the model
 * leaves the identity. A different executable still starts a new session, because that genuinely
 * is a different conversation.
 */
function systemFingerprint(req: RunnerRequest): string {
  // The model is part of the session identity. A runtime session belongs to the
  // model that created it, so resuming it under a different model is a false
  // resume, not continuity. Leaving the model out made every BYOK model switch
  // reuse the previous model's session id.
  //
  // This does NOT reintroduce the 2026-07-16 세션유지 사고. That incident came
  // from hashing the whole system prompt and settings, so any unrelated setting
  // change severed the conversation; the seed exists to keep those out. The
  // model is different in kind — it genuinely cannot inherit another model's
  // session — and the user does not experience a cut, because the fresh-session
  // path reseeds the compacted conversation history with continuity framing
  // (renderConversationContext). The thread the user sees lives in Agentlas's
  // own store, not in the runtime session.
  if (req.sessionFingerprintSeed) {
    return crypto
      .createHash("sha256")
      .update("seed.v4\0")
      .update(req.sessionFingerprintSeed)
      .update("\0image-tool\0")
      .update(codexImageToolCapability(req))
      .digest("hex");
  }
  return crypto
    .createHash("sha256")
    .update(req.systemPrompt)
    .update("\0")
    .update(req.locale)
    .update("\0")
    .update(req.permission ?? "")
    .update("\0")
    .update(req.forceSurface ? "force-surface" : "normal")
    .update("\0")
    .update(req.effort ?? "")
    .update("\0")
    .update(codexImageToolCapability(req))
    .update("\0")
    .update(req.isolatedMcpConfig ? "isolated-mcp" : "provider-defaults")
    .update("\0")
    .update(JSON.stringify(req.mcpCodexConfigArgs ?? []))
    .digest("hex");
}

interface CodexRunResult {
  code: number | null;
  stderr: string;
  text: string;
  threadId: string | null;
  tokens?: number;
  /** Provider's raw session-cumulative counters; never render these directly for resume turns. */
  reportedOutputTokens?: number;
  reportedInputTokens?: number;
  reportedCachedInputTokens?: number;
  /** This turn's real usage (cumulative counters minus the session baseline). */
  observedUsage?: { inputTokens: number; outputTokens: number };
  /** 스트림 표식(또는 exit0 휴리스틱)이 말한 실패 — 있으면 text는 답이 아니다. */
  failure?: RunnerFailure;
}

/**
 * `turn.completed.usage` 는 스레드 누적치다(`codex exec resume` 실측: output 이
 * 대화 전체 합계로 온다. 세 칸이 한 구조체이므로 input/cached 도 같은 성질이다).
 * 이번 턴의 실제 사용량은 "지금 값 − 지난 턴 값"이고, 그 지난 값이 이 baseline 이다.
 * 새 세션은 전부 0. 옛 행처럼 baseline 을 모르면 null 이고, 그때는 usage 를 지어내지
 * 않고 비워 둔다 — 없는 것과 0 은 다르다.
 */
interface CodexUsageBaseline {
  output: number | null;
  input: number | null;
  cachedInput: number | null;
}

/**
 * 누적 카운터 한 칸에서 이번 턴 몫을 뽑는다 — 순수 함수(게이트가 직접 시험한다).
 * baseline 을 모르면 null(=usage 를 비운다). 카운터가 줄었으면 누적의 연속일 수 없으므로
 * (세션이 새로 시작됐다는 뜻) 보고값을 그대로 이번 턴 값으로 읽는다.
 */
export function deltaFromBaseline(reported: number | undefined, baseline: number | null): number | null {
  if (reported == null || !Number.isFinite(reported) || reported < 0) return null;
  if (baseline == null) return null;
  return reported >= baseline ? reported - baseline : reported;
}

/** 다음 턴의 기준선이 될 원시 누적치. 이번 실행이 말하지 않은 칸은 저장 측이 이전 값을 유지한다. */
function codexUsageCounters(run: CodexRunResult): {
  reportedOutputTokens: number | null;
  reportedInputTokens: number | null;
  reportedCachedInputTokens: number | null;
} {
  return {
    reportedOutputTokens: run.reportedOutputTokens ?? null,
    reportedInputTokens: run.reportedInputTokens ?? null,
    reportedCachedInputTokens: run.reportedCachedInputTokens ?? null,
  };
}

/**
 * codex `exec`(또는 `exec resume`)를 1회 실행. `--json`(JSONL 이벤트)으로 받아
 * 세션 id(thread.started)와 답변 텍스트(agent_message), 토큰 사용량을 뽑는다.
 * 프롬프트는 stdin으로(`-`) — Windows cmd.exe 인자 한계 회피.
 */

/**
 * codex exec --json 이벤트 하나에서 실패 표식을 읽는다 — 순수 함수(게이트가 픽스처 주입).
 * codex 한도는 표식이 없다(거절문이 agent_message + turn.completed) — 그 케이스는
 * 완주 시점의 detectRuntimeRefusal 휴리스틱이 맡는다(출처 heuristic).
 */
export function codexFailureFromEvent(
  ev: { type?: string; item?: { type?: string; message?: unknown }; error?: { message?: unknown } },
): RunnerFailure | null {
  if (ev.type === "item.completed" && ev.item?.type === "error") {
    const message = typeof ev.item.message === "string" && ev.item.message.trim()
      ? ev.item.message.trim().slice(0, 2000) : "codex error";
    return { kind: "exit", message, runtime: "codex", source: "marker" };
  }
  if (ev.type === "turn.failed") {
    const message = typeof ev.error?.message === "string" && ev.error.message.trim()
      ? ev.error.message.trim().slice(0, 2000) : "codex turn failed";
    return { kind: "exit", message, runtime: "codex", source: "marker" };
  }
  return null;
}

/**
 * `item.completed/error` is not a turn terminal. Codex also uses that item for
 * recoverable diagnostics (for example, clamping a plugin hook timeout) and
 * may subsequently emit a normal agent message followed by `turn.completed`.
 * Only a turn-level failure can override such a completed answer. When no
 * completed answer exists, retain the item error as the best failure evidence.
 */
export function resolveCodexRunFailure(input: {
  code: number | null;
  text: string;
  turnCompleted: boolean;
  terminalFailure: RunnerFailure | null;
  itemFailure: RunnerFailure | null;
}): RunnerFailure | null {
  if (input.terminalFailure) return input.terminalFailure;
  if (input.code === 0 && input.turnCompleted && input.text.trim()) return null;
  return input.itemFailure;
}

/**
 * app-server 의 턴 실패 표식 → RunnerFailure — 순수 함수(게이트가 픽스처 주입).
 *
 * `turn/completed` 는 `turn.status`(completed|failed|interrupted)와, 실패일 때
 * `turn.error{message, codexErrorInfo}` 를 싣는다(실측 스키마). `codexErrorInfo` 는
 * 기계 표식이므로 **문구가 아니라 그 코드로** 종류를 정한다 — 한도 소진이 "실패"로만
 * 보이던 자리를 여기서 되찾는다(exec 경로는 표식이 없어 휴리스틱에 기댔다).
 */
export function codexFailureFromTurn(turn: {
  status?: string;
  error?: { message?: unknown; additionalDetails?: unknown; codexErrorInfo?: unknown } | null;
} | null | undefined): RunnerFailure | null {
  if (!turn || turn.status !== "failed") return null;
  const raw = typeof turn.error?.message === "string" && turn.error.message.trim()
    ? turn.error.message.trim()
    : "codex turn failed";
  const detail = typeof turn.error?.additionalDetails === "string" && turn.error.additionalDetails.trim()
    ? ` — ${turn.error.additionalDetails.trim()}`
    : "";
  const info = turn.error?.codexErrorInfo;
  const code = typeof info === "string"
    ? info
    : info && typeof info === "object"
      ? Object.keys(info as Record<string, unknown>)[0] ?? ""
      : "";
  const kind: RunnerFailure["kind"] =
    code === "usageLimitExceeded" || code === "sessionBudgetExceeded" ? "quota"
      : code === "unauthorized" ? "auth"
      : code === "cyberPolicy" || code === "misalignmentPolicyViolation" ? "refused"
      : code === "contextWindowExceeded" ? "exit"
      : "exit";
  return {
    kind,
    message: `${raw}${detail}`.slice(0, 2000),
    runtime: "codex",
    source: "marker",
  };
}

function runCodexProcess(
  bin: string,
  args: string[],
  stdinPayload: string,
  req: RunnerRequest,
  events: RunnerEvents,
  usageBaseline: CodexUsageBaseline,
): Promise<CodexRunResult> {
  const reportedOutputTokenBaseline = usageBaseline.output;
  return new Promise((resolve, reject) => {
    let terminalFailure: RunnerFailure | null = null;
    let itemFailure: RunnerFailure | null = null;
    const child = spawnCli(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: req.env ?? process.env,
      // 사용자가 지정한 프로젝트 폴더에서 실행 — 미지정이면 전용 폴더.
      cwd: req.cwd ?? agentRunCwd(),
      ...detachedSpawnOpts(),
    });
    trackRunChild(child);
    // ★호스트 소유 생존 신호 — 러너 공통 규칙(runner.ts startCliHeartbeat 주석 참고).
    const stopHeartbeat = startCliHeartbeat(child, events.onStatus, "codex");
    // ★죽은 자식이 close를 안 보내면 이 실행은 영영 안 끝난다 — runner.ts 주석 참고.
    ensureChildCloseAfterExit(child, () => {
      events.onStatus("codex: process exited without closing its output — settling the run");
    });

    const onAbort = () => killCliTree(child);
    if (req.signal) {
      if (req.signal.aborted) killCliTree(child);
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }
    writeStdin(child, stdinPayload);

    let buffer = "";
    let text = "";
    let threadId: string | null = null;
    let tokens: number | undefined;
    let reportedOutputTokens: number | undefined;
    let reportedInputTokens: number | undefined;
    let reportedCachedInputTokens: number | undefined;
    let observedUsage: { inputTokens: number; outputTokens: number } | undefined;
    let stderr = "";
    let lastEmit = 0;
    let turnCompleted = false;
    // Newer Codex runtimes send native tool calls as response items instead of
    // the older `item.started` / `item.completed` command events. Dropping that
    // envelope made a real file edit look like a two-event "thought + final"
    // run in One even though the tool had succeeded. Keep the provider call id
    // so the started and completed notifications update one Activity row.
    const responseTools = new Map<string, { name: string; args?: string }>();
    const settledResponseToolIds = new Set<string>();
    const itemCapturePaths = new Map<string, string[]>();
    // reasoning 구간/라이브 토큰 추정 상태 — 상태줄 실시간 표시용.
    // 단일 open/close 플래그다(깊이 카운터가 아니다): 이 구간은 진짜 `reasoning`
    // 아이템으로도 열리고, reasoning 아이템을 전혀 내보내지 않는 codex 빌드에서는
    // `turn.started`로 합성 개시된다. 둘을 한 카운터에 섞으면 깊이가 0으로 못 내려와
    // 구간이 영구히 열린 채 남는다.
    let thinkingOpen = false;
    let reasoningStartedAt = 0;
    let estChars = 0;

    const openThinking = (): void => {
      if (thinkingOpen) return;
      thinkingOpen = true;
      reasoningStartedAt = Date.now();
      events.onThinking?.("start");
    };
    const closeThinking = (): void => {
      if (!thinkingOpen) return;
      thinkingOpen = false;
      events.onThinking?.("end", Date.now() - reasoningStartedAt);
    };

    const truncateUi = (s: string, max = 12000): string =>
      s.length > max ? `${s.slice(0, max)}…` : s;
    const stringifyPayload = (payload: unknown): string => {
      if (typeof payload === "string") return payload;
      try {
        return JSON.stringify(payload ?? "", null, 2);
      } catch {
        return String(payload ?? "");
      }
    };
    const isToolItem = (type: string | undefined): boolean => {
      if (!type || type === "agent_message" || type === "reasoning") return false;
      return /tool|function|command|shell|exec|mcp/i.test(type);
    };
    const record = (value: unknown): Record<string, unknown> | null => (
      value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
    );
    const nonEmptyText = (value: unknown): string | null => typeof value === "string" && value.trim()
      ? value.trim()
      : null;
    const responseToolName = (name: string, input: string | undefined): string => {
      // The Codex tool host uses a generic `exec` wrapper for the built-in
      // patch tool. The structured patch completion below is host evidence, so
      // preserving `apply_patch` lets One present it as a real file output
      // rather than a vague terminal row.
      if (name === "exec" && /tools\.apply_patch\s*\(/.test(input ?? "")) return "apply_patch";
      return name;
    };
    const outputText = (value: unknown): string | undefined => {
      const direct = nonEmptyText(value);
      if (direct) return truncateUi(direct);
      if (Array.isArray(value)) {
        const joined = value
          .map((entry) => record(entry))
          .map((entry) => entry && (nonEmptyText(entry.text) ?? nonEmptyText(entry.output)))
          .filter((entry): entry is string => Boolean(entry))
          .join("\n");
        if (joined) return truncateUi(joined);
      }
      return value == null ? undefined : truncateUi(stringifyPayload(value));
    };
    const settleResponseTool = (id: string, result: string | undefined, isError = false, artifactPaths?: readonly string[]): void => {
      if (settledResponseToolIds.has(id)) return;
      const pending = responseTools.get(id);
      if (!pending) return;
      settledResponseToolIds.add(id);
      events.onTool?.(pending.name, pending.args, result, id, isError, artifactPaths);
    };
    const latestUnsettledResponseTool = (name?: string): string | null => {
      const candidates = [...responseTools.entries()].reverse();
      for (const [id, pending] of candidates) {
        if (!settledResponseToolIds.has(id) && (!name || pending.name === name)) return id;
      }
      return null;
    };
    const handle = (ev: {
      type?: string;
      thread_id?: string;
      payload?: unknown;
      item?: {
        id?: string;
        type?: string;
        text?: string;
        name?: string;
        server?: string;
        tool?: string;
        command?: string;
        input?: unknown;
        args?: unknown;
        arguments?: unknown;
        output?: unknown;
        result?: unknown;
        error?: unknown;
        /** codex 0.144+ command_execution 직렬화 필드 — output/result가 없고 이것만 온다. */
        aggregated_output?: unknown;
        exit_code?: number;
        status?: string;
      };
      usage?: { output_tokens?: number; input_tokens?: number; cached_input_tokens?: number };
    }): void => {
      const payload = record(ev.payload);
      if (ev.type === "response_item" && payload?.type === "custom_tool_call") {
        const rawName = nonEmptyText(payload.name);
        const id = nonEmptyText(payload.call_id) ?? nonEmptyText(payload.id);
        if (rawName && id) {
          closeThinking();
          const input = nonEmptyText(payload.input);
          const name = responseToolName(rawName, input ?? undefined);
          responseTools.set(id, { name, ...(input ? { args: input } : {}) });
          events.onTool?.(name, input ?? undefined, undefined, id, false);
        }
        return;
      }
      if (ev.type === "response_item" && payload?.type === "custom_tool_call_output") {
        const id = nonEmptyText(payload.call_id) ?? nonEmptyText(payload.id);
        if (id) {
          // Avoid writing a second durable capture if the host replays an
          // already-settled response item.
          if (settledResponseToolIds.has(id)) return;
          const pending = responseTools.get(id);
          const artifactPaths = payload.status === "failed" || !pending
            ? []
            : codexInlineCapturePaths(pending.name, payload.output);
          settleResponseTool(id, outputText(payload.output), payload.status === "failed", artifactPaths);
        }
        return;
      }
      if (ev.type === "event_msg" && payload?.type === "patch_apply_end") {
        // This event is emitted by the host only after its patch operation has
        // completed. It carries a bounded, structured list of changed paths;
        // unlike model prose or command input, these paths are real output
        // evidence and may populate One's artifact rail.
        const id = latestUnsettledResponseTool("apply_patch");
        const changes = record(payload.changes);
        if (id && changes) {
          const paths = Object.keys(changes).filter((candidate) => path.isAbsolute(candidate));
          settleResponseTool(id, JSON.stringify({ changes: paths }), payload.success === false, paths);
        }
        return;
      }
      if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
        threadId = ev.thread_id;
      } else if (ev.type === "turn.started") {
        // codex 0.145 emits NO `reasoning` item events (verified against the
        // live CLI), so `item.started/reasoning` below never fires and nothing
        // marks the start of the model's think time. turn.started is the only
        // event that reliably precedes it — treat it as the opening of a
        // reasoning span so callers get a "thinking" signal instead of silence.
        openThinking();
      } else if (ev.type === "item.completed" && ev.item?.type === "error") {
        // Was dropped on the floor: `isToolItem("error")` is false, so codex's
        // own warnings/errors (hook trust, skill budget, tool failures) never
        // reached the user at all.
        const message = (ev.item as { message?: unknown }).message;
        if (typeof message === "string" && message.trim()) {
          events.onStatus(`codex: ${truncateUi(message, 400)}`);
          // Keep the marker as candidate evidence, but do not promote it to a
          // turn failure yet. Codex emits recoverable hook/config diagnostics
          // through this same item and can still complete a valid answer.
          itemFailure = itemFailure ?? codexFailureFromEvent(ev);
        }
      } else if (ev.type === "turn.failed") {
        // ★핸들러가 아예 없던 이벤트 — 프로토콜이 턴 실패를 선언하는 자리다.
        terminalFailure = codexFailureFromEvent(ev as { type?: string; error?: { message?: unknown } }) ?? terminalFailure;
      } else if (ev.type === "item.started" && ev.item?.type === "reasoning") {
        // reasoning 구간 신호 — 상태줄 "생각 중…" 회전의 근거 (Claude 경로와 동일 계약).
        openThinking();
      } else if (ev.type === "item.completed" && ev.item?.type === "reasoning") {
        // reasoning summary 아이템 — `-c model_reasoning_summary=auto`로 켠다(실측 0.147:
        // 켜지 않으면 이 아이템이 아예 안 온다). text는 모델이 낸 헤드라인
        // ("**Counting files in current directory**") — 화면의 진행 헤드라인이자
        // 펼쳤을 때의 생각 요약. 사고 원문이 아니라 요약이므로 그대로 흘린다.
        openThinking();
        const summary = nonEmptyText(ev.item.text);
        if (summary) events.onThinking?.("delta", undefined, summary.endsWith("\n") ? summary : `${summary}\n`);
        closeThinking();
      } else if (
        ev.type === "item.completed" &&
        ev.item?.type === "agent_message" &&
        typeof ev.item.text === "string"
      ) {
        closeThinking();
        text += (text ? "\n" : "") + ev.item.text;
        // 라이브 토큰 추정 — codex는 중간 usage가 없어 스트리밍 문자 수/4로 추정(단조 증가).
        estChars += ev.item.text.length;
        events.onUsage?.(Math.ceil(estChars / 4));
        const now = Date.now();
        if (now - lastEmit > 60) {
          events.onPartial(text);
          lastEmit = now;
        }
      } else if ((ev.type === "item.started" || ev.type === "item.completed") && isToolItem(ev.item?.type)) {
        closeThinking();
        const item = ev.item!;
        // `codex exec --json` serializes MCP calls as snake_case
        // `mcp_tool_call` items. Their executable identity lives in
        // `server` + `tool`; `item.type` is only the envelope name. Keeping
        // the envelope here made every browser action look like the same
        // generic tool, so One could not attribute a navigation to the
        // current Taskforce or present its page in the Browser rail.
        const exactMcpName =
          item.type === "mcp_tool_call" && item.tool
            ? item.server ? `${item.server}.${item.tool}` : item.tool
            : undefined;
        const name =
          exactMcpName ??
          item.name ??
          (item.command ? "bash" : undefined) ??
          item.type ??
          "tool";
        const argPayload =
          item.command != null
            ? { command: item.command }
            : (item.input ?? item.args ?? item.arguments);
        // codex 0.144+의 command_execution은 output/result 없이 aggregated_output/exit_code만
        // 직렬화한다 — completed에 result가 없으면 렌더러가 같은 도구를 2행으로 쌓으므로
        // 어떤 형태로든 result를 채워 completed임을 보장한다.
        const resultPayload = item.output ?? item.result ?? item.aggregated_output ?? item.error;
        const argsText = argPayload == null ? undefined : stringifyPayload(argPayload);
        const resultText =
          ev.type === "item.completed"
            ? resultPayload != null
              ? truncateUi(stringifyPayload(resultPayload))
              : typeof item.exit_code === "number"
                ? `exit ${item.exit_code}`
                : (item.status ?? "completed")
            : undefined;
        const isError =
          item.error != null ||
          item.status === "failed" ||
          (item.type === "mcp_tool_call" && codexMcpResultFailed(item.result)) ||
          (typeof item.exit_code === "number" && item.exit_code !== 0);
        // exec emits native MCP results through item.completed as well as
        // response_item. Persist images before the UI preview is truncated in
        // either transport; a replay must reuse the original capture receipt.
        let artifactPaths: string[] | undefined;
        if (ev.type === "item.completed" && item.type === "mcp_tool_call" && !isError) {
          artifactPaths = item.id ? itemCapturePaths.get(item.id) : undefined;
          if (!artifactPaths) {
            artifactPaths = codexInlineCapturePaths(name, resultPayload);
            if (item.id) itemCapturePaths.set(item.id, artifactPaths);
          }
        }
        // 도구 이벤트 전에 본문을 플러시 — 렌더러 인터리브 앵커가 최신 좌표를 본다.
        if (text) {
          events.onPartial(text);
          lastEmit = Date.now();
        }
        events.onTool?.(
          name,
          argsText && argsText.length > 2000 ? `${argsText.slice(0, 2000)}…` : argsText,
          resultText,
          item.id,
          isError,
          artifactPaths,
        );
      } else if (ev.type === "turn.completed") {
        closeThinking();
        turnCompleted = true;
        if (ev.usage?.input_tokens != null) reportedInputTokens = ev.usage.input_tokens;
        if (ev.usage?.cached_input_tokens != null) reportedCachedInputTokens = ev.usage.cached_input_tokens;
        if (ev.usage?.output_tokens != null) {
          reportedOutputTokens = ev.usage.output_tokens;
          // `codex exec resume` emits the lifetime total for its thread. Only
          // render a subtraction when we have the prior raw counter; old rows
          // begin with a visible-message estimate, then establish the baseline
          // for every later resume turn.
          tokens = reportedOutputTokenBaseline != null && reportedOutputTokens >= reportedOutputTokenBaseline
            ? reportedOutputTokens - reportedOutputTokenBaseline
            : Math.ceil(estChars / 4);
          events.onUsage?.(tokens);
        }
        /*
         * ★영수증의 usage — 예전에는 output_tokens 하나만 읽고 input/cached 를 버려서
         * observedUsage 가 아예 설정되지 않았고, #2 런타임의 모든 모델 할당 영수증이
         * `usage: null` 로 남았다. 영수증 스키마는 입력·출력을 둘 다 요구하므로,
         * 둘 다 이번 턴 값으로 확정될 때만 싣는다(추정치는 넣지 않는다).
         *
         * inputTokens 는 **모델이 실제로 본 문맥 전체**다. codex 의 input_tokens 는
         * 이미 캐시 읽기를 포함한 총량이고 cached_input_tokens 는 그 부분집합이라
         * 더하지 않는다(claude-code·byok 러너와 같은 규칙, 이중계상 금지).
         */
        const turnInput = deltaFromBaseline(reportedInputTokens, usageBaseline.input);
        const turnOutput = deltaFromBaseline(reportedOutputTokens, usageBaseline.output);
        if (turnInput != null && turnOutput != null) {
          observedUsage = { inputTokens: turnInput, outputTokens: turnOutput };
        }
        const turnCached = deltaFromBaseline(reportedCachedInputTokens, usageBaseline.cachedInput);
        if (turnInput != null && turnInput > 0 && turnCached != null) {
          // 캐시 히트율은 비용 판단의 절반이다 — 영수증 칸이 없으니 상태줄로 남긴다(byok 러너와 동일).
          events.onStatus(`[cache] read=${turnCached} fresh=${turnInput - turnCached} hit=${Math.round((turnCached / turnInput) * 100)}%`);
        }
      }
    };

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const consumeStdout = (textChunk: string) => {
      buffer += textChunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          handle(JSON.parse(line));
        } catch {
          // 비-JSON 라인(헤더 등) 무시
        }
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => consumeStdout(stdoutDecoder.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
    });

    child.on("error", (err) => {
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      stopHeartbeat();
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      req.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      // Pipe chunks can split a Korean UTF-8 code point. Decoding them
      // independently turns the split bytes into permanent U+FFFD in One.
      consumeStdout(stdoutDecoder.end());
      stderr += stderrDecoder.end();
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      stopHeartbeat();
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      req.signal?.removeEventListener("abort", onAbort);
      let runnerFailure = resolveCodexRunFailure({
        code,
        text,
        turnCompleted,
        terminalFailure,
        itemFailure,
      });
      /*
       * ★표식 없이 완주(exit 0)했는데 산출물이 거절 고지문인 경우 — 실측: codex 한도는
       * 거절문이 agent_message로 오고 turn.completed(표식 0). 이 한 자리에서만 텍스트
       * 판별을 허용하고 출처를 heuristic으로 남긴다(규칙은 runtime-refusal.ts 한 곳).
       */
      if (code === 0 && !runnerFailure) {
        const refusal = detectRuntimeRefusal(text);
        if (refusal) {
          runnerFailure = { kind: refusal.kind, message: refusal.message, runtime: "codex", source: "heuristic" };
        }
      }
      resolve({
        code,
        stderr,
        text,
        threadId,
        tokens,
        ...(reportedOutputTokens != null ? { reportedOutputTokens } : {}),
        ...(reportedInputTokens != null ? { reportedInputTokens } : {}),
        ...(reportedCachedInputTokens != null ? { reportedCachedInputTokens } : {}),
        ...(observedUsage ? { observedUsage } : {}),
        ...(runnerFailure ? { failure: runnerFailure } : {}),
      });
    });
  });
}

/* ───────────────────────── 상주 경로 (`codex app-server`) ───────────────────────── */

/**
 * 권한 → 스레드/턴 정책. exec 경로의 `permissionArgs` 와 **같은 경계**를 프로토콜의
 * 타입 있는 칸으로 옮긴 것이다(문자열 `-c` 오버라이드가 아니라 스키마가 검증한다).
 *
 * ★write 의 network_access=true 는 실측으로 얻은 것이다(exec 경로 주석 참고):
 * workspace-write Seatbelt 샌드박스는 기본적으로 네트워크를 전면 차단해, 자기 기계의
 * 127.0.0.1:9222(브라우저)조차 못 두드린다. 파일 경계는 유지하고 네트워크만 연다.
 *
 * ★approvalPolicy: read/write 는 `on-request` 다 — 이것이 이번 작업의 요지다. codex 는
 * 지금까지 헤드리스라 실행 **전에** 물어볼 수 없었고(post-denial 만 가능), 이제 서버가
 * 우리에게 물어본다. full 은 기본적으로 예전 `--dangerously-bypass-approvals-and-sandbox` 와
 * 같게 `never` 다. 단, Main이 명시한 `auto_review` reviewer는 MCP 승인 prompt를 Codex의
 * 내부 위험 검토 경로로 보내야 하므로 `on-request`를 사용한다.
 */
export function codexThreadPolicy(
  permission: RunnerRequest["permission"],
  cwd = agentRunCwd(),
  approvalsReviewer: RunnerRequest["approvalsReviewer"] = "user",
): {
  sandbox: string;
  approvalPolicy: string;
  sandboxPolicy: Record<string, unknown>;
} {
  if (permission === "full") {
    return {
      sandbox: "danger-full-access",
      approvalPolicy: approvalsReviewer === "auto_review" ? "on-request" : "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  if (permission === "write") {
    const writableRoot = path.resolve(cwd);
    return {
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [writableRoot],
        networkAccess: true,
        // A selected project may itself live below TMPDIR, but Codex's default
        // temp grants must stay disabled. `writableRoots` re-adds only this
        // exact project; leaving either temp grant enabled lets a worker write
        // siblings/parents outside the assigned project root.
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    };
  }
  return { sandbox: "read-only", approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } };
}

/** 아이템 하나 → 도구 이벤트. 아는 종류만 옮긴다(모르는 것을 도구라고 부르지 않는다). */
/** MCP transport completion can still carry an explicit tool-level failure. */
function codexMcpResultFailed(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const value = result as { isError?: unknown; is_error?: unknown };
  return value.isError === true || value.is_error === true;
}

export function codexToolEventFromItem(item: any, completed: boolean): {
  name: string;
  args?: string;
  result?: string;
  isError: boolean;
  artifactPaths?: string[];
} | null {
  if (!item || typeof item !== "object") return null;
  const cut = (s: string, max = 12000): string => (s.length > max ? `${s.slice(0, max)}…` : s);
  const asText = (value: unknown): string | undefined => {
    if (value == null) return undefined;
    if (typeof value === "string") return cut(value);
    try { return cut(JSON.stringify(value)); } catch { return cut(String(value)); }
  };
  const commandArtifactPaths = (): string[] => {
    if (!completed || item.status === "failed" || item.status === "declined") return [];
    if (typeof item.exitCode === "number" && item.exitCode !== 0) return [];
    const cwd = typeof item.cwd === "string" && path.isAbsolute(item.cwd) ? item.cwd : null;
    const command = typeof item.command === "string" ? item.command : "";
    const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.slice(0, 64_000) : "";
    if (!cwd || !command) return [];
    const paths = new Set<string>();
    if (output) {
      for (const line of output.split(/\r?\n/u)) {
        const match = line.match(/^(.+?\.(?:png|jpe?g|gif|webp|avif|svg)):\s*(?:PNG|JPEG|GIF|WebP|AVIF|SVG)\b.*(?:image|data)/iu);
        const raw = match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
        if (!raw || !command.includes(raw)) continue;
        const candidate = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
        paths.add(candidate);
        if (paths.size >= 8) break;
      }
    }
    // A dedicated successful copy/move/redirection is structured command
    // input, unlike a path mentioned in model prose or arbitrary stdout. Main
    // still re-opens every candidate under the invocation folder or an exact
    // user-requested standard output folder before One can display it.
    const collectDestination = (value: string | undefined): void => {
      if (!value || paths.size >= 8) return;
      const raw = value.trim().replace(/^['"]|['"]$/g, "");
      if (!path.isAbsolute(raw) || raw.startsWith("/dev/") || raw.startsWith("/proc/")) return;
      if (!/\.[A-Za-z0-9]{1,10}$/u.test(raw)) return;
      paths.add(path.normalize(raw));
    };
    for (const match of command.matchAll(/>{1,2}\s*("[^"]+"|'[^']+'|\S+)/gu)) collectDestination(match[1]);
    for (const match of command.matchAll(/\btee\s+(?:-a\s+)?("[^"]+"|'[^']+'|\S+)/gu)) collectDestination(match[1]);
    for (const match of command.matchAll(/\b(?:cp|mv)\s+(?:-\S+\s+)*(?:"[^"]+"|'[^']+'|\S+)\s+("[^"]+"|'[^']+'|\S+)/gu)) {
      collectDestination(match[1]);
    }
    for (const match of command.matchAll(/--filename(?:=|\s+)("[^"]+"|'[^']+'|\S+)/gu)) {
      const raw = match[1]?.trim().replace(/^["']|["']$/g, "");
      if (!raw) continue;
      collectDestination(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw));
    }
    return [...paths];
  };
  switch (item.type) {
    case "commandExecution": {
      const failed = item.status === "failed" || item.status === "declined"
        || (typeof item.exitCode === "number" && item.exitCode !== 0);
      const artifactPaths = failed ? [] : commandArtifactPaths();
      const browserUrl = typeof item.command === "string"
        ? item.command.match(/(?:playwright_cli\.sh|\$PWCLI|\$\{PWCLI\})[^\n]*?\bopen\s+(https?:\/\/[^\s'";]+)/iu)?.[1]
        : undefined;
      return {
        name: browserUrl ? "browser_navigate" : "bash",
        args: browserUrl ? asText({ url: browserUrl }) : asText({ command: item.command, cwd: item.cwd }),
        result: completed
          ? (asText(item.aggregatedOutput) ?? (typeof item.exitCode === "number" ? `exit ${item.exitCode}` : String(item.status ?? "completed")))
          : undefined,
        isError: completed && failed,
        ...(artifactPaths.length > 0 ? { artifactPaths } : {}),
      };
    }
    case "fileChange": {
      const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((c) => String(c?.path ?? "")).filter((p) => p && path.isAbsolute(p));
      return {
        name: "apply_patch",
        args: asText({ changes: changes.map((c) => ({ path: c?.path, kind: c?.kind })) }),
        result: completed ? asText({ status: item.status, changes: paths }) : undefined,
        isError: completed && (item.status === "failed" || item.status === "declined"),
        // 호스트가 구조화해 준 변경 경로만 산출물 레일로 — 모델 산문에서 뽑지 않는다.
        ...(completed && paths.length > 0 ? { artifactPaths: paths } : {}),
      };
    }
    case "mcpToolCall":
      return {
        name: item.server ? `${item.server}.${item.tool}` : String(item.tool ?? "mcp"),
        args: asText(item.arguments),
        result: completed ? (asText(item.error) ?? asText(item.result) ?? String(item.status ?? "completed")) : undefined,
        isError: completed && (item.status === "failed" || item.error != null || codexMcpResultFailed(item.result)),
      };
    case "dynamicToolCall":
      {
        const contentItems = Array.isArray(item.contentItems) ? item.contentItems : [];
        const summary = contentItems.map((content: any) => {
          if (content?.type === "inputText") return { type: "inputText", text: asText(content.text) ?? "" };
          if (content?.type === "inputImage") return { type: "inputImage", imageAvailable: typeof content.imageUrl === "string" };
          if (content?.type === "inputAudio") return { type: "inputAudio", audioAvailable: typeof content.audioUrl === "string" };
          return { type: "unknown" };
        });
      return {
        name: String(item.tool ?? "tool"),
        args: asText(item.arguments),
        // Never put a base64 media URL in the event ledger. Main binds the
        // verified artifact path separately and the renderer receives only an
        // opaque preview capability.
        result: completed ? (asText(summary) ?? String(item.status ?? "completed")) : undefined,
        isError: completed && (item.status === "failed" || item.success === false),
      };
      }
    case "webSearch":
      return {
        name: "web_search",
        args: asText(item.query ?? item.action),
        result: completed ? "completed" : undefined,
        isError: false,
      };
    default:
      return null;
  }
}

interface ResidentTurnOutcome {
  /** 완주했다 — 이 결과를 그대로 돌려준다(성공이든 표식 실패든). */
  result?: RunnerResult;
  /** 화면에 아무것도 나가지 않았다 — 이 턴을 1회성 exec 경로로 **한 번** 다시 시도한다. */
  retryOneShot?: true;
}

/**
 * 상주 턴 하나. 실패하면 세션을 버리고 `retryOneShot` 을 돌려준다 — 바깥은 기존 exec
 * 경로로 **한 번** 더 간다(그 경로는 상주를 쓰지 않으므로 무한 재시도가 불가능하다).
 *
 * ★사용자에게는 아무 차이도 없어야 한다: 상태줄 문구는 기존 `[runtime-session]` 영수증과
 * 기존 resume/created 문구 그대로다. 상주는 속도·비용 최적화이지 연속성의 근거가 아니다
 * (연속성은 threadId 와 대화 히스토리 재주입이 잇는다).
 */
async function runCodexResidentTurn(input: {
  bin: string;
  req: RunnerRequest;
  events: RunnerEvents;
  chatId: string;
  fingerprint: string;
  resumeThreadId: string | null;
  gapContext: string;
  mcpArgs: string[];
  appliedEffort: string | null;
}): Promise<ResidentTurnOutcome> {
  const { bin, req, events, chatId, fingerprint, resumeThreadId, gapContext, mcpArgs, appliedEffort } = input;
  const runtimeSessionOwnerId = req.runtimeSessionOwnerId ?? req.agentId;
  const isolateRuntimeSessionOwner = req.runtimeSessionOwnerId != null;
  const cwd = req.cwd ?? agentRunCwd();
  const env = req.env ?? process.env;
  const approvalsReviewer = req.approvalsReviewer ?? "user";
  const policy = codexThreadPolicy(req.permission, cwd, approvalsReviewer);
  const requestedConfigDigest = inspectCodexWorkforceGrant(req, mcpArgs);
  let workforceObservation: CodexWorkforceObservation | null = null;
  const imageDiagnosis = req.untrustedNoTools || req.restrictedReadBoundary || req.judgmentOnly
    ? null
    : await multimodalImageSlotDiagnosis();
  const imageToolSlot = imageDiagnosis?.state === "ready" ? imageDiagnosis.slot : null;
  /*
   * 스폰 형상 — `-c` 는 app-server 하위 명령의 옵션이다(실측 `codex app-server --help`).
   * reasoning summary 를 켜는 것은 exec 경로와 같은 이유다(끄면 요약 아이템이 비어 온다).
   */
  const args = [...CODEX_APP_SERVER_ARGS, "-c", "model_reasoning_summary=auto", ...mcpArgs];
  const pool = codexSessionPool();
  const poolKey = codexPoolKey({
    chatId: req.approvalChatId ?? chatId,
    fingerprint,
    cwd,
    bin,
    ...(req.mcpConfigPath ? { mcpConfigPath: req.mcpConfigPath } : {}),
    ...(req.toolBrokerSettingsPath ? { toolBrokerSettingsPath: req.toolBrokerSettingsPath } : {}),
    args,
    env,
  });

  let lease: AcpSessionLease<CodexResidentSession> | null = null;
  try {
    lease = await pool.acquire(
      poolKey,
      {
        agentId: req.agentId ?? null,
        nodeId: req.orchestrationAgentId ?? req.agentId ?? null,
        chatId,
        runtimeKind: KIND,
        source: resolveAgentResidencySource(req.agentId),
        reaperExempt: isResidencyExemptAgent(req.agentId),
      },
      () => openCodexResidentSession({ bin, args, cwd, env, label: req.backendLabel || "codex" }),
    );
  } catch (err) {
    // 구형 CLI 는 `app-server` 하위 명령 자체가 없다 — 프로세스 수명 동안 1회 학습해 영구 강등.
    if (looksLikeMissingAppServer("", err)) {
      markCodexAppServerUnsupported(err instanceof Error ? err.message : String(err));
      events.onStatus(`[residency] disabled kind=${KIND} reason=app-server-unsupported`);
    }
    if (req.workforceRuntimeToolGrant) throw err;
    return { retryOneShot: true };
  }

  const session = lease.session;
  const reusing = !lease.fresh && Boolean(session.threadId);
  const explicitResume = Boolean(req.runtimeSessionId);
  let broken = false;
  /** 이 턴에서 화면으로 나간 본문이 있는가 — 있으면 1회성 재시도는 답을 두 번 쓰는 짓이다. */
  let emitted = false;

  /* ── 이번 턴의 수신 상태 ── */
  const messageOrder: string[] = [];
  const messages = new Map<string, string>();
  const startedTools = new Set<string>();
  const dynamicToolArtifactPaths = new Map<string, string[]>();
  // Resident app-server MCP completions can be replayed by the session
  // transport. Keep the capture receipt keyed by the provider item id so the
  // same inline image is saved and bound at most once per turn.
  const mcpToolArtifactPaths = new Map<string, string[]>();
  let thinkingOpen = false;
  let thinkingStartedAt = 0;
  let estChars = 0;
  let lastEmit = 0;
  let turnId = "";
  let confirmedTurnId = "";
  let turnRequestInFlight = false;
  const pendingModelReroutes = new Map<string, { fromModel: string; toModel: string }>();
  /*
   * 사용량은 알림 콜백에서 채워진다 — 홀더 객체에 담는다(let 변수는 TS 흐름 분석이
   * 콜백 대입을 못 봐서 항상 null 로 좁혀진다).
   */
  const usage: {
    last: { inputTokens: number; outputTokens: number } | null;
    total: { outputTokens: number; inputTokens: number; cachedInputTokens: number } | null;
  } = { last: null, total: null };
  let failure: RunnerFailure | null = null;
  let interrupted = false;
  let settleTurn: ((reason: "completed" | "closed") => void) | null = null;
  let closedReason = "";
  let modelSelectionError: CodexModelSelectionError | null = null;
  // Every blocking MCP elicitation belongs to this one turn, even when the
  // underlying app-server process survives for later turns. Stop, transport
  // close, or checkout release must cancel the question before the session can
  // be reused by another chat/turn.
  const elicitationAbort = new AbortController();

  const openThinking = (): void => {
    if (thinkingOpen) return;
    thinkingOpen = true;
    thinkingStartedAt = Date.now();
    events.onThinking?.("start");
  };
  const closeThinking = (): void => {
    if (!thinkingOpen) return;
    thinkingOpen = false;
    events.onThinking?.("end", Date.now() - thinkingStartedAt);
  };
  const bodyText = (): string => messageOrder.map((id) => messages.get(id) ?? "").filter(Boolean).join("\n");
  const emitPartial = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastEmit <= 60) return;
    lastEmit = now;
    emitted = true;
    events.onPartial(bodyText());
  };

  const rejectModelReroute = (fromModel: unknown, toModel: unknown): void => {
    const acknowledged = session.modelAcknowledgement;
    modelSelectionError = new CodexModelSelectionError(
      "rerouted",
      `Codex rerouted the explicitly requested model from ${String(fromModel ?? acknowledged?.model ?? req.model)} to ${String(toModel ?? "unknown")}.`,
    );
    broken = true;
    settleTurn?.("completed");
  };

  const onNotification = (method: string, params: any): void => {
    switch (method) {
      case "model/rerouted": {
        const reroutedTurnId = params?.turnId;
        if (!req.model || params?.threadId !== session.threadId
          || typeof reroutedTurnId !== "string" || !reroutedTurnId
          || reroutedTurnId.length > 256 || /[\r\n\x00]/.test(reroutedTurnId)) break;
        if (confirmedTurnId) {
          if (reroutedTurnId === confirmedTurnId) rejectModelReroute(params?.fromModel, params?.toModel);
        } else if (turnRequestInFlight) {
          pendingModelReroutes.set(reroutedTurnId, {
            fromModel: String(params?.fromModel ?? req.model),
            toModel: String(params?.toModel ?? "unknown"),
          });
        }
        break;
      }
      case "thread/started":
        if (typeof params?.thread?.id === "string") session.threadId = params.thread.id;
        break;
      case "turn/started":
        // 이 자리는 exec 경로와 같은 의미다 — 모델이 생각을 시작했다는 가장 이른 신호.
        if (typeof params?.turn?.id === "string" && params?.threadId === session.threadId
          && ((confirmedTurnId && params.turn.id === confirmedTurnId) || (!confirmedTurnId && turnRequestInFlight))) {
          openThinking();
        }
        break;
      case "item/started": {
        const item = params?.item;
        if (item?.type === "reasoning") { openThinking(); break; }
        const tool = codexToolEventFromItem(item, false);
        if (tool) {
          closeThinking();
          if (bodyText()) emitPartial(true);
          startedTools.add(String(item.id ?? ""));
          events.onTool?.(tool.name, tool.args, undefined, String(item.id ?? ""), false);
        }
        break;
      }
      case "item/agentMessage/delta": {
        const id = String(params?.itemId ?? "");
        const delta = typeof params?.delta === "string" ? params.delta : "";
        if (!id || !delta) break;
        closeThinking();
        if (!messages.has(id)) { messages.set(id, ""); messageOrder.push(id); }
        messages.set(id, (messages.get(id) ?? "") + delta);
        estChars += delta.length;
        events.onUsage?.(Math.ceil(estChars / 4));
        emitPartial();
        break;
      }
      case "item/completed": {
        const item = params?.item;
        if (item?.type === "agentMessage") {
          closeThinking();
          const id = String(item.id ?? "");
          if (id) {
            // 완결 아이템의 text 가 권위다 — 델타 누락/중복이 있어도 여기서 자가 교정된다.
            if (!messages.has(id)) messageOrder.push(id);
            messages.set(id, typeof item.text === "string" ? item.text : messages.get(id) ?? "");
          }
          emitPartial(true);
          break;
        }
        if (item?.type === "reasoning") {
          openThinking();
          const summary = [
            ...(Array.isArray(item.summary) ? item.summary : []),
            ...(Array.isArray(item.content) ? item.content : []),
          ].filter((s) => typeof s === "string" && s.trim()).join("\n");
          if (summary) events.onThinking?.("delta", undefined, summary.endsWith("\n") ? summary : `${summary}\n`);
          closeThinking();
          break;
        }
        const tool = codexToolEventFromItem(item, true);
        if (tool) {
          closeThinking();
          if (bodyText()) emitPartial(true);
          const itemId = String(item.id ?? "");
          let artifactPaths = item?.type === "dynamicToolCall"
            ? dynamicToolArtifactPaths.get(itemId)
            : tool.artifactPaths;
          if (item?.type === "mcpToolCall" && !tool.isError) {
            artifactPaths = mcpToolArtifactPaths.get(itemId);
            if (!artifactPaths) {
              artifactPaths = codexInlineCapturePaths(tool.name, item.result);
              mcpToolArtifactPaths.set(itemId, artifactPaths);
            }
          }
          events.onTool?.(
            tool.name,
            tool.args,
            tool.result,
            itemId,
            tool.isError,
            artifactPaths,
          );
          if (item?.type === "dynamicToolCall") dynamicToolArtifactPaths.delete(itemId);
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        // `last` 는 **이번 턴**, `total` 은 스레드 누적이다(실측). exec 경로가 누적에서
        // 빼서 구하던 값을 프로토콜이 직접 준다 — baseline 산수가 필요 없다.
        const last = params?.tokenUsage?.last;
        const total = params?.tokenUsage?.total;
        if (last && typeof last.inputTokens === "number" && typeof last.outputTokens === "number") {
          usage.last = { inputTokens: last.inputTokens, outputTokens: last.outputTokens };
          events.onUsage?.(last.outputTokens);
        }
        if (total && typeof total.outputTokens === "number") {
          usage.total = {
            outputTokens: total.outputTokens,
            inputTokens: typeof total.inputTokens === "number" ? total.inputTokens : 0,
            cachedInputTokens: typeof total.cachedInputTokens === "number" ? total.cachedInputTokens : 0,
          };
        }
        if (last && typeof last.inputTokens === "number" && typeof last.cachedInputTokens === "number" && last.inputTokens > 0) {
          events.onStatus(`[cache] read=${last.cachedInputTokens} fresh=${last.inputTokens - last.cachedInputTokens} hit=${Math.round((last.cachedInputTokens / last.inputTokens) * 100)}%`);
        }
        break;
      }
      case "warning": {
        const message = typeof params?.message === "string" ? params.message : "";
        if (message) events.onStatus(`codex: ${message.slice(0, 400)}`);
        break;
      }
      case "error": {
        // 턴이 재시도할 수 있는 오류는 실패가 아니다 — 서버가 willRetry 로 말해 준다.
        const message = typeof params?.error?.message === "string" ? params.error.message : "";
        if (message) events.onStatus(`codex: ${message.slice(0, 400)}`);
        if (params?.willRetry !== true && !failure) {
          failure = codexFailureFromTurn({ status: "failed", error: params?.error }) ?? failure;
        }
        break;
      }
      case "turn/completed": {
        const turn = params?.turn;
        if (!turn || (turnId && String(turn.id ?? "") !== turnId)) break;
        workforceObservation?.completeTurn(params);
        if (turn.status === "interrupted") interrupted = true;
        failure = codexFailureFromTurn(turn) ?? failure;
        settleTurn?.("completed");
        break;
      }
      default:
        break;
    }
  };

  const approvalCtx = {
    runtime: KIND,
    sessionKey: `${KIND}:${req.sessionFingerprintSeed ?? chatId}`,
    cwd,
    chatId,
    ...(req.agentId ? { agentId: req.agentId } : {}),
    permission: req.permission,
    unattended: req.unattended === true,
  };
  const sink: CodexTurnSink = {
    onNotification,
    onServerRequest: async (method, params) => {
      if (method === "item/tool/call" || isCodexApprovalRequest(method)) {
        workforceObservation?.assertRequestContext(params, turnId);
      }
      if (method === "item/tool/call") {
        const callId = typeof params?.callId === "string" ? params.callId : "";
        const tool = typeof params?.tool === "string" ? params.tool : "";
        const namespace = params?.namespace == null ? null : String(params.namespace);
        const argsRecord = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? params.arguments as Record<string, unknown>
          : null;
        const prompt = typeof argsRecord?.prompt === "string" ? argsRecord.prompt.trim().slice(0, 1200) : "";
        if (!imageToolSlot || tool !== CODEX_IMAGE_TOOL_NAME || namespace !== null || !callId || !prompt) {
          return {
            success: false,
            contentItems: [{ type: "inputText", text: "Image generation failed: the host image tool is unavailable or the prompt is invalid. Do not claim an image was generated or displayed." }],
          };
        }
        const ask: RuntimeToolPermissionAsk = {
          runtime: KIND,
          sessionKey: `${KIND}:${req.sessionFingerprintSeed ?? chatId}`,
          tool: CODEX_IMAGE_TOOL_NAME,
          kind: "other",
          cwd,
          permission: req.permission,
          mutating: true,
          chatId: req.approvalChatId ?? chatId,
          ...(req.agentId ? { agentId: req.agentId } : {}),
          ...(req.unattended ? { unattended: true as const } : {}),
        };
        const arbiter = getRuntimeToolPermissionArbiter();
        let decision = defaultRuntimeToolPermission(ask);
        if (arbiter) {
          try { decision = await arbiter(ask); } catch { decision = "deny"; }
        }
        workforceObservation?.approval(method, params, decision);
        if (decision === "deny") {
          events.onStatus(`[tool-approval] runtime=${KIND} capability=other tool=${CODEX_IMAGE_TOOL_NAME} decision=deny`);
          return {
            success: false,
            contentItems: [{ type: "inputText", text: "Image generation was not approved. Do not claim an image was generated or displayed." }],
          };
        }
        events.onStatus(`[tool-approval] runtime=${KIND} capability=other tool=${CODEX_IMAGE_TOOL_NAME} decision=${decision}`);
        const generated = await generateImage(imageToolSlot.model, prompt);
        if (!generated.ok || !generated.src || !generated.artifactPath) {
          return {
            success: false,
            contentItems: [{ type: "inputText", text: `Image generation failed: ${generated.reason ?? "no image was produced"}. Do not claim an image was generated or displayed.` }],
          };
        }
        dynamicToolArtifactPaths.set(callId, [generated.artifactPath]);
        return {
          success: true,
          contentItems: [
            { type: "inputText", text: `Image generation succeeded with ${generated.engine ?? imageToolSlot.runtimeKind}. The image is attached to this tool result.` },
            { type: "inputImage", imageUrl: generated.src },
          ],
        };
      }
      if (isCodexMcpElicitationRequest(method)) {
        const expectedThreadId = session.threadId ?? "";
        const expectedTurnId = turnId;
        const isCurrent = () => (
          !session.closed
          && session.active === sink
          && session.threadId === expectedThreadId
          && turnId === expectedTurnId
          && !elicitationAbort.signal.aborted
        );
        const outcome = await answerCodexMcpElicitation(params, {
          chatId: req.approvalChatId ?? chatId,
          threadId: expectedThreadId,
          turnId: expectedTurnId,
          unattended: req.unattended === true || req.noSynchronousAsk === true,
          signal: elicitationAbort.signal,
          isCurrent,
        });
        // The helper rechecks immediately before accept. Check once more at the
        // transport boundary so a close/replacement between its return and this
        // callback cannot send collected form content into a stale app-server.
        const staleAccept = outcome.response.action === "accept" && !isCurrent();
        const response = staleAccept ? { action: "cancel" as const } : outcome.response;
        const receipt = staleAccept
          ? { ...outcome.receipt, action: "cancel" as const, reason: "stale" as const, fieldCount: 0 }
          : outcome.receipt;
        const safe = (value: string) => value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 96) || "unknown";
        events.onStatus(
          `[mcp-elicitation] runtime=${KIND} server=${safe(receipt.serverName)} chat=${safe(receipt.chatId)} thread=${safe(receipt.threadId)} turn=${safe(receipt.turnId)} action=${receipt.action} reason=${receipt.reason} fields=${receipt.fieldCount}`,
        );
        return response;
      }
      /*
       * ★실행 **전** 승인 — codex 가 처음으로 승인 칩에 참여하는 자리.
       * 계약은 ACP `answerPermission` 과 같다: 중재자가 없으면 보수적 기본값,
       * 중재자가 던지면 거부(fail-closed). 결정은 상태줄에 사실로 남긴다.
       */
      if (!isCodexApprovalRequest(method)) {
        throw new AcpRpcError({ code: -32601, message: `Method not found: ${method}` });
      }
      const { reply, decision, ask } = await answerCodexApproval(method, params, approvalCtx);
      workforceObservation?.approval(method, params, decision);
      events.onStatus(
        `[tool-approval] runtime=${KIND} capability=${codexApprovalCapability(ask)} tool=${ask.tool} decision=${decision}`,
      );
      return reply;
    },
    onStatus: (status) => events.onStatus(status),
    onTransportClosed: (reason) => {
      closedReason = reason;
      elicitationAbort.abort(new Error(reason));
      settleTurn?.("closed");
    },
  };

  /** 취소가 보낸 `turn/interrupt` 의 응답 — 세션을 죽이기 **전에** 이것을 기다린다. */
  let interruptAck: Promise<unknown> | null = null;
  const onAbort = (): void => {
    broken = true;
    interrupted = true;
    elicitationAbort.abort(req.signal?.reason);
    /*
     * 취소는 프로토콜 1급이다 — 먼저 `turn/interrupt` 로 이 턴을 멈추고, **그 다음** 세션을
     * 버린다(상태를 모르는 세션을 다음 턴에 물려주지 않는다).
     *
     * ★순서가 계약이다. 보내자마자 프로세스 그룹을 죽이면 자식이 그 줄을 읽기 전에 죽어
     * 취소가 프로토콜에 도달하지 못한다(게이트에서 실측한 경합). 그래서 응답을 기다리는
     * 약속을 남기고, 폐기하는 finally 가 그것을 (상한을 두고) 먼저 기다린다.
     */
    if (session.threadId && turnId && codexResidentSessionAlive(session)) {
      interruptAck = session.conn
        .request("turn/interrupt", { threadId: session.threadId, turnId }, { timeoutMs: 5_000 })
        .catch(() => { /* 이미 끝났거나 죽었다 */ });
    }
    settleTurn?.("closed");
  };
  req.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    session.active = sink;
    if (req.workforceRuntimeToolGrant) workforceObservation = new CodexWorkforceObservation(req, session.init, req.workforceRuntimeToolGrant.canonicalConfigSha256);
    /* ── 스레드: 살아 있는 세션이면 그대로, 새 프로세스면 resume 또는 start ── */
    if (!reusing || workforceObservation || explicitResume) {
      const commonThreadParams: Record<string, unknown> = {
        cwd,
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer,
        sandbox: policy.sandbox,
        // Thread start/resume acknowledges effective policy. Request the same
        // workspace-write values that turn/start will use before admitting a
        // Workforce model turn; a requested turn override alone is no proof.
        ...(workforceObservation && req.permission === "write" ? { config: {
          "sandbox_workspace_write.writable_roots": [path.resolve(cwd)],
          "sandbox_workspace_write.network_access": true,
          "sandbox_workspace_write.exclude_tmpdir_env_var": true,
          "sandbox_workspace_write.exclude_slash_tmp": true,
        } } : {}),
        developerInstructions: `${buildDeveloperInstructions(req)}\n\n${codexImageToolInstructions(Boolean(imageToolSlot))}`,
        ...(imageToolSlot ? { dynamicTools: [CODEX_IMAGE_DYNAMIC_TOOL] } : {}),
      };
      let resumed = false;
      // A caller-supplied runtimeSessionId names the thread to resume. A live
      // same-fingerprint pool entry is only an optimization and cannot replace
      // that explicit continuity target.
      const threadToResume = req.runtimeSessionId ?? (reusing ? session.threadId : resumeThreadId);
      if (threadToResume) {
        let releaseResume: (() => void) | undefined;
        try {
          releaseResume = await prepareCodexThreadResume(session, threadToResume, req.signal);
          const response = await session.conn.request(
            "thread/resume",
            {
              threadId: threadToResume,
              ...commonThreadParams,
              // Every explicit model selection must survive stored-thread
              // recovery too, including a new pool entry after a model switch.
              // The acknowledgement below still verifies the effective model.
              ...(req.model ? { model: req.model } : {}),
            },
            { timeoutMs: 120_000, signal: req.signal },
          );
          const modelAcknowledgement = await acknowledgeCodexThreadModel({
            request: session.conn.request.bind(session.conn), response,
            requestedModel: req.model, expectedThreadId: threadToResume,
            signal: req.signal,
          });
          workforceObservation?.acknowledgeThread(response, modelAcknowledgement, policy, cwd, approvalsReviewer, threadToResume);
          session.threadId = threadToResume;
          session.modelAcknowledgement = modelAcknowledgement;
          resumed = true;
        } catch (err) {
          if (req.signal?.aborted) throw abortReasonError(req);
          events.onStatus(`[runtime-session] resume_failed kind=${KIND}`);
          if (err instanceof CodexModelSelectionError) throw err;
          throw err instanceof CodexSessionContinuityError ? err : new CodexSessionContinuityError(
            "resume_failed", `Codex thread resume failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          releaseResume?.();
        }
      }
      if (!resumed) {
        const started = await session.conn.request("thread/start", {
          ...commonThreadParams,
          ...(req.model ? { model: req.model } : {}),
        }, { timeoutMs: 120_000, signal: req.signal });
        const modelAcknowledgement = await acknowledgeCodexThreadModel({
          request: session.conn.request.bind(session.conn), response: started,
          requestedModel: req.model, signal: req.signal,
        });
        const id = started.thread.id as string;
        workforceObservation?.acknowledgeThread(started, modelAcknowledgement, policy, cwd, approvalsReviewer);
        session.threadId = id;
        session.modelAcknowledgement = modelAcknowledgement;
      }
      // 버전 스큐 관측 — 이 세션이 어떤 app-server 였는지 영수증에 남긴다.
      events.onStatus(codexProtocolReceipt(session.init));
    }
    if (!session.threadId) throw new Error("codex app-server session has no thread");
    if (req.model && session.modelAcknowledgement?.requestedModel !== req.model) {
      throw new CodexModelSelectionError("resolution_unverified", "The resident Codex thread has no acknowledgement for the requested model.");
    }
    if (workforceObservation) {
      workforceObservation.observeInventory(await waitForCodexWorkforceInventory(
        session.conn.request.bind(session.conn), session.threadId, req.workforceRuntimeToolGrant!, req.signal,
      ));
    }
    if (modelSelectionError) throw modelSelectionError;

    /* ── 턴 ── */
    // 새 스레드면 시스템+히스토리 시드, 이어가는 스레드면 사용자 턴만(+gap/turn 컨텍스트).
    const continuing = reusing || Boolean(resumeThreadId && session.threadId === resumeThreadId);
    const promptText = continuing
      ? composeResumeTurnPrompt(
        req.userPrompt,
        [gapContext, req.turnContext ?? ""].filter(Boolean).join("\n\n"),
        req.locale,
      )
      : buildResidentInitialTurnPrompt(req);
    const turnParams: Record<string, unknown> = {
      threadId: session.threadId,
      input: [{ type: "text", text: promptText }],
      cwd,
      // Reassert sticky policy on every turn. A resident thread can survive a
      // permission/reviewer change, and inheriting its previous values would
      // either over-grant the next role or strand an internal tool worker on a
      // user approval surface it cannot render.
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer,
      sandboxPolicy: policy.sandboxPolicy,
      ...(appliedEffort ? { effort: appliedEffort } : {}),
      // ★출력 형태 계약 — app-server 는 스키마를 **인라인**으로 받는다(exec 은 파일 경로만).
      ...(req.outputSchema ? { outputSchema: req.outputSchema.schema } : {}),
    };
    const settled = new Promise<"completed" | "closed">((resolve) => {
      settleTurn = (reason) => { settleTurn = null; resolve(reason); };
    });
    let started: any;
    turnRequestInFlight = true;
    try {
      started = await session.conn.request("turn/start", turnParams, { timeoutMs: 120_000, signal: req.signal });
    } finally {
      turnRequestInFlight = false;
    }
    workforceObservation?.startTurn(started);
    if (typeof started?.turn?.id === "string") {
      turnId = started.turn.id;
      confirmedTurnId = started.turn.id;
    }
    const bufferedReroute = confirmedTurnId ? pendingModelReroutes.get(confirmedTurnId) : undefined;
    pendingModelReroutes.clear();
    if (bufferedReroute) {
      rejectModelReroute(bufferedReroute.fromModel, bufferedReroute.toModel);
    }
    events.onStatus(`[runtime-session] ${continuing ? "resumed" : "created"} kind=${KIND}`);
    if (modelSelectionError) throw modelSelectionError;
    const reason = await settled;
    closeThinking();

    if (modelSelectionError) throw modelSelectionError;

    if (req.signal?.aborted) {
      // 취소여도 스레드가 생겼으면 저장 → 이어지는 steering 메시지가 문맥을 유지한다.
      saveRuntimeSession(chatId, KIND, session.threadId, fingerprint, { agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner,
        ...(usage.total ? {
          reportedOutputTokens: usage.total.outputTokens,
          reportedInputTokens: usage.total.inputTokens,
          reportedCachedInputTokens: usage.total.cachedInputTokens,
        } : {}),
      });
      broken = true;
      throw abortReasonError(req);
    }
    if (reason === "closed") {
      // 전송이 죽었다 — 우리가 물려준 세션의 문제다. 조용히 버리고 1회성으로 한 번 더.
      broken = true;
      if (looksLikeMissingAppServer(session.conn.lastStderr, new Error(closedReason))) {
        markCodexAppServerUnsupported(closedReason || session.conn.lastStderr);
        events.onStatus(`[residency] disabled kind=${KIND} reason=app-server-unsupported`);
      }
      if (workforceObservation) throw new Error("workforce_codex_observation_transport_closed");
      if (!emitted && !bodyText()) return { retryOneShot: true };
      return {
        result: {
          text: bodyText().trim(),
          failure: failure ?? {
            kind: "empty",
            message: (closedReason || session.conn.lastStderr.slice(-500) || "codex app-server closed mid-turn"),
            runtime: KIND,
            source: "marker",
          },
          sessionId: session.threadId,
          appliedEffort,
        },
      };
    }
    if (interrupted) {
      broken = true;
      throw abortReasonError(req);
    }

    // Record both native inventories. Selected capability changes invalidate
    // the invocation; unrelated host changes are evidence, never a replay.
    if (workforceObservation) {
      if (inspectCodexWorkforceGrant(req, mcpArgs) !== requestedConfigDigest) throw new Error("workforce_codex_observation_config_drift");
      workforceObservation.observeInventory(await readCodexWorkforceInventory(
        session.conn.request.bind(session.conn), session.threadId!, req.signal,
      ));
    }
    const workforcePermissionEnforcement = workforceObservation
      ? workforceObservedHostAuthorityEnforcement(req, KIND, workforceObservation.finish()) : undefined;
    session.completedTurns += 1;
    const text = bodyText().trim();
    /*
     * ★표식 없이 완주했는데 산출물이 거절 고지문인 경우 — exec 경로와 같은 한 자리에서만
     * 텍스트 판별을 허용하고 출처를 heuristic 으로 남긴다(규칙은 runtime-refusal.ts 한 곳).
     * app-server 는 대부분의 한도 소진을 codexErrorInfo=usageLimitExceeded 로 말하지만,
     * 모델이 거절문을 답으로 내는 갈래는 exec 과 동일하게 남아 있다.
     */
    if (!failure) {
      const refusal = detectRuntimeRefusal(text);
      if (refusal) failure = { kind: refusal.kind, message: refusal.message, runtime: KIND, source: "heuristic" };
    }
    if (!saveRuntimeSession(chatId, KIND, session.threadId, fingerprint, { agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner,
      ...(usage.total ? {
        reportedOutputTokens: usage.total.outputTokens,
        reportedInputTokens: usage.total.inputTokens,
        reportedCachedInputTokens: usage.total.cachedInputTokens,
      } : {}),
    })) {
      events.onStatus(`[runtime-session] store_failed kind=${KIND}`);
    }
    if (!text && !failure) {
      // 빈 답은 실패다 — 표식으로 말한다(텍스트 길이로 판정하는 소비자를 만들지 않는다).
      return {
        result: {
          text: "",
          failure: { kind: "empty", message: session.conn.lastStderr.slice(-500) || "codex app-server returned no message", runtime: KIND, source: "marker" },
          sessionId: session.threadId,
          appliedEffort,
        },
      };
    }
    return {
      result: {
        text,
        ...(failure ? { failure } : {}),
        sessionId: session.threadId,
        ...(usage.last ? { tokens: usage.last.outputTokens, observedUsage: usage.last } : {}),
        ...(workforcePermissionEnforcement ? { workforcePermissionEnforcement } : {}),
        appliedEffort,
      },
    };
  } catch (err) {
    broken = true;
    if (req.signal?.aborted || req.workforceRuntimeToolGrant) throw err;
    if (err instanceof CodexModelSelectionError) throw err;
    if (err instanceof CodexSessionContinuityError) throw err;
    if (looksLikeMissingAppServer(session.conn?.lastStderr ?? "", err)) {
      markCodexAppServerUnsupported(err instanceof Error ? err.message : String(err));
      events.onStatus(`[residency] disabled kind=${KIND} reason=app-server-unsupported`);
    }
    // 프로토콜 이상 — 화면에 아무것도 안 나갔으면 1회성 경로로 한 번 더(사용자에겐 무차이).
    if (!emitted && !bodyText()) return { retryOneShot: true };
    throw err;
  } finally {
    req.signal?.removeEventListener("abort", onAbort);
    elicitationAbort.abort(new Error("Codex turn settled"));
    closeThinking();
    // 취소가 프로토콜에 도달한 뒤에 죽인다(상한 2초 — 응답이 없어도 폐기는 반드시 일어난다).
    if (interruptAck) {
      await Promise.race([
        interruptAck,
        new Promise((resolve) => { setTimeout(resolve, 2_000).unref?.(); }),
      ]).catch(() => { /* 폐기를 막지 않는다 */ });
    }
    // 수신자를 먼저 뗀다 — 유휴 세션이 지난 턴의 events 로 상태를 흘리면 안 된다.
    session.active = null;
    if (broken || req.signal?.aborted) pool.discard(lease);
    else pool.release(lease);
  }
}

export const runCodex: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  if (
    req.untrustedNoTools &&
    (Boolean(req.mcpConfigPath) ||
      Boolean(req.mcpAllowedTools?.length) ||
      Boolean(req.mcpCodexConfigArgs?.length) ||
      Boolean(req.untrustedAllowedMcpTools?.length))
  ) {
    throw new Error(
      req.locale === "ko"
        ? "Codex CLI의 격리 실행은 외부 도구가 전혀 없는 경우에만 검증되었습니다. 이 실행의 MCP 권한은 허용할 수 없습니다."
        : "Codex CLI isolation is verified only with no external tools. This run's MCP grant cannot be admitted.",
    );
  }
  // Codex CLI 0.144.4 still exposes collaboration/delegation authority, and
  // the same measured failure remained on 0.144.5 (2026-07-17): even with
  // `--disable multi_agent` and every other configurable tool feature disabled,
  // the runtime still emitted a collaboration tool call. Read-only filesystem
  // sandboxing does not revoke that delegation authority. Until Codex exposes a
  // release-verified switch that removes the collaboration surface, borrowed
  // packages, Agent Apps, and Workforce turns must stop before CLI discovery or
  // process spawn rather than minting a false no-authority receipt.
  // Resident judgment calls are Main-authored, tool-free classification turns.
  // They do not receive MCP/config grants or a workspace and must be allowed to
  // use the connected Codex model even though ordinary untrusted Agent App /
  // Workforce turns remain blocked by the collaboration surface.
  if (req.untrustedNoTools && !req.judgmentOnly) {
    // 표식을 단다 — 이 거절은 시간이 지나도 풀리지 않는다. codex 만 설치한 사용자는
    // 판정이 필요한 자동화를 하나도 끝낼 수 없으므로, 화면이 "다시 눌러 보세요" 대신
    // "판정할 수 있는 런타임을 하나 연결하세요"라고 말할 수 있어야 한다.
    throw new RuntimeJudgmentRefusal(
      "codex",
      req.locale === "ko"
        ? "현재 Codex CLI에서 서브에이전트 협업 권한을 완전히 제거할 수 없어 격리된 Agent App/Workforce 실행을 차단했습니다."
        : "The current Codex CLI still exposes collaboration/delegation authority after tool features are disabled. Isolated Agent App and Workforce execution is blocked before process spawn.",
    );
  }
  if (req.restrictedReadBoundary) {
    throw new Error(
      "Codex is not enabled for remote or unattended read-only execution because its host filesystem boundary is not release-verified.",
    );
  }
  // A Workforce receipt exists only on the acknowledged app-server path.
  // Ordinary Codex exec fallback is not an equivalent evidence producer.
  if (req.workforceRuntimeToolGrant && (!codexAppServerSupported()
    || residencyDisabledFor(KIND, req.env ?? process.env) || req.isolatedMcpConfig || !req.chatId)) {
    throw new Error("workforce_codex_observation_app_server_required");
  }
  const bin = await getBin();
  if (!bin) {
    throw new Error(tStatus(req.locale, "errCliMissingCodex"));
  }

  const stagedImages = await stageCliImageAttachments(req);
  const runReq = stagedImages.images.length > 0 ? { ...req, userPrompt: stagedImages.userPrompt } : req;
  const runtimeSessionOwnerId = runReq.runtimeSessionOwnerId ?? runReq.agentId;
  const isolateRuntimeSessionOwner = runReq.runtimeSessionOwnerId != null;

  if (stagedImages.images.length > 0) {
    events.onStatus(
      tStatus(runReq.locale, "cliImageReady", {
        backend: runReq.backendLabel,
        count: stagedImages.images.length,
      }),
    );
  } else {
    events.onStatus(tStatus(runReq.locale, "callingBackend", { backend: runReq.backendLabel }));
  }

  const approvalArgs = codexApprovalArgs(runReq.approvalsReviewer, runReq.permission);
  // --approve-for-me already selects workspace-write and conflicts with --sandbox.
  // Keep its network configuration while avoiding the mutually exclusive flag.
  const permArgs = approvalArgs.length > 0
    ? [...CODEX_WORKSPACE_WRITE_CONFIG_ARGS]
    : permissionArgs(runReq.permission, runReq.approvalsReviewer);
  const mcpArgs =
    runReq.mcpCodexConfigArgs && runReq.mcpCodexConfigArgs.length > 0
      ? runReq.mcpCodexConfigArgs
      : [];
  // Preserve Codex's own settings, plugins, and native tools while adding the
  // Agentlas MCP bridge. The CLI/runtime owns its native tool policy; browser
  // mode is an additional capability, not a reason to turn those tools off.
  const isolatedConfigArgs: string[] = [];
  const browserOnlyConfigArgs: string[] = [];
  // 모델/effort를 CLI에 명시 전달 — 예전엔 세션 지문에만 쓰고 인자로는 안 넘겨서, 앱이
  // 뭘 선택했든 기기의 ~/.codex/config.toml(또는 codex 업데이트가 바꾼 내장 기본값)이
  // 이겼다(2026-07-08: 다른 기기에서 지정한 적 없는 Spark 모델로 조용히 실행된 사고).
  // 앱이 모델을 갖고 있으면 그 모델이 반드시 이긴다. 없으면 기기 설정을 따른다(BYOM 존중).
  // `--model`/`-c`는 `exec`와 `exec resume` 둘 다 지원 확인됨(0.133+).
  const modelArgs: string[] = [];
  // `codex exec` has no interactive approval loop. Keep ordinary calls on the
  // user reviewer and opt only Main-authored internal tool workers into the
  // bounded auto reviewer; this mirrors app-server's typed turn override.
  modelArgs.push("-c", `approvals_reviewer="${runReq.approvalsReviewer ?? "user"}"`);
  // reasoning summary 아이템을 켠다 — 실측(codex 0.147): 이 설정 없이는 `--json`에
  // reasoning 아이템이 0건이라 화면이 "생각 중" 외에 아무것도 말할 수 없었다. 켜면
  // 모델이 낸 헤드라인("**Preparing file count command execution**")이 아이템으로 온다.
  modelArgs.push("-c", "model_reasoning_summary=auto");
  let appliedEffort: string | null = null;
  if (runReq.model) modelArgs.push("--model", runReq.model);
  // 모델 캐시의 exact profile을 실행 시점에도 다시 검증한다. 최신 Codex 모델은 max를
  // 지원하지만, 프로필이 없거나 손상된 경우에는 2026-07-12 사고 방지용 max->xhigh
  // legacy guard를 유지한다. 그 외 미지값은 넘기지 않아 기기 설정을 따른다.
  if (runReq.effort || runReq.model) {
    // Read the same account home the child process will use. Main's process env
    // may differ from a runtime-owned CODEX_HOME, and consulting another cache
    // can validate an effort for the wrong account/model catalog.
    const inventory = await readCodexModelInventory(runReq.env?.CODEX_HOME);
    const effort = runReq.effort
      ? resolveCodexModelEffort(inventory, runReq.model, runReq.effort)
      : defaultCodexModelEffort(inventory, runReq.model);
    if (effort) {
      appliedEffort = effort;
      modelArgs.push("-c", `model_reasoning_effort=${effort}`);
    }
  }

  // 세션 resume 가능 여부 — chatId 저장 세션 또는 Build 같은 호출자가 직접 넘긴 세션 id.
  const fingerprint = runReq.chatId ? systemFingerprint(runReq) : null;
  const existing = runReq.chatId
    ? getRuntimeSession(runReq.chatId, KIND, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner })
    : null;
  const storedSessionId =
    existing && fingerprint && existing.fingerprint === fingerprint
      ? existing.sessionId
      : null;
  const resumeSessionId = runReq.runtimeSessionId ?? storedSessionId;
  /*
   * 이 실행의 누적 카운터 기준선. 세 갈래다:
   *   새 세션        → 0 (이번 턴이 곧 전부)
   *   우리가 아는 재개 → 저장된 값(옛 행은 칸이 비어 null)
   *   호출자가 들고 온 세션(Build 등) → 모른다 = null. 예전엔 여기에도 0을 써서
   *     대화 전체 누적을 이번 턴 수치로 보고했다 — 모를 때는 비워 두는 쪽이 정직하다.
   */
  const usageBaseline: CodexUsageBaseline = !resumeSessionId
    ? { output: 0, input: 0, cachedInput: 0 }
    : existing?.sessionId === resumeSessionId
      ? {
        output: existing.reportedOutputTokens,
        input: existing.reportedInputTokens,
        cachedInput: existing.reportedCachedInputTokens,
      }
      : { output: null, input: null, cachedInput: null };
  const canResume = !!resumeSessionId;
  if (existing && fingerprint && existing.fingerprint !== fingerprint) {
    events.onStatus(`[runtime-session] fingerprint_changed kind=${KIND}`);
  }

  /*
   * ★상주 — 이 턴이 끝나도 프로세스를 죽이지 않는다(`codex app-server`, 오너 규칙 2026-08-20).
   *
   * 대화에 속한(= chatId·지문이 있는) 실행만 풀에서 빌린다. chatId 없는 일회성 실행
   * (Build 등)은 이어 쓸 다음 턴이 정의상 없으므로 예전 그대로 `codex exec` 로 간다.
   * 상주 경로가 열리지 않거나 프로토콜 이상으로 실패하면 **조용히** 아래 exec 경로가
   * 이 턴을 한 번 처리한다 — 사용자 화면에는 아무 차이도 남지 않아야 한다.
   */
  if (
    codexAppServerSupported() &&
    !residencyDisabledFor(KIND, runReq.env ?? process.env) &&
    !runReq.untrustedNoTools &&
    !runReq.isolatedMcpConfig &&
    runReq.chatId &&
    fingerprint
  ) {
    // gap-replay — 이 스레드가 마지막으로 본 이후 다른 경로로 진행된 턴을 메운다(exec 과 같은 규칙).
    const gapContext = !runReq.runtimeSessionId && storedSessionId && existing
      ? renderGapContext(unseenHistoryGap(runReq.history, existing.updatedAt), runReq.locale)
      : "";
    const attempt = await runCodexResidentTurn({
      bin,
      req: runReq,
      events,
      chatId: runReq.chatId,
      fingerprint,
      resumeThreadId: resumeSessionId ?? null,
      gapContext,
      mcpArgs,
      appliedEffort,
    });
    if (attempt.result) return attempt.result;
  }
  if (runReq.workforceRuntimeToolGrant) throw new Error("workforce_codex_observation_no_exec_fallback");

  /*
   * 출력 형태 계약 — codex 는 스키마를 **파일 경로**로만 받는다
   * (실측 codex-cli 0.147.0: `--output-schema <FILE>`). 0600 임시 파일에 쓰고
   * 실행이 끝나면 지운다; argv 에 스키마 본문이 남지 않는 부수 효과도 있다.
   */
  const schemaFile = runReq.outputSchema
    ? path.join(os.tmpdir(), `agentlas-codex-schema-${process.pid}-${crypto.randomUUID()}.json`)
    : null;
  if (schemaFile && runReq.outputSchema) {
    await fs.writeFile(schemaFile, JSON.stringify(runReq.outputSchema.schema), { encoding: "utf8", mode: 0o600 });
  }
  const schemaArgs = schemaFile ? ["--output-schema", schemaFile] : [];
  /*
   * 정리는 실행 경로에 맡기지 않는다 — 이 함수에는 return 지점이 여러 개고(resume 성공,
   * resume 실패, create 성공, abort throw), 그중 하나만 빠뜨려도 0600 파일이 남는다.
   * abort 신호와 프로세스 종료 양쪽에 걸어 두면 어느 갈래로 끝나도 지워진다.
   */
  if (schemaFile) {
    const removeSchemaFile = (): void => {
      void fs.rm(schemaFile, { force: true }).catch(() => {});
    };
    runReq.signal?.addEventListener("abort", removeSchemaFile, { once: true });
    // codex 자식이 파일을 읽는 시점은 spawn 직후다. 넉넉히 지난 뒤 지운다.
    setTimeout(removeSchemaFile, 10 * 60_000).unref?.();
  }

  // RESUME: 새 user 턴만 stdin으로 — 시스템 프롬프트/히스토리는 세션이 이미 갖고 있다.
  // Resume reasserts the same permission boundary as the first turn.
  if (canResume) {
    const resumePerm = resumePermissionArgs(runReq.permission, runReq.approvalsReviewer);
    const args = [
      "exec",
      ...approvalArgs,
      "resume",
      ...isolatedConfigArgs,
      ...browserOnlyConfigArgs,
      "--json",
      "--skip-git-repo-check",
      ...resumePerm,
      ...mcpArgs,
      ...modelArgs,
      ...schemaArgs,
      resumeSessionId!,
      "-",
    ];
    // gap-replay — 이 세션이 마지막으로 본 이후 다른 경로(스웜/다른 러너)로 진행된 턴을 메운다.
    // 호출자가 세션 수명을 직접 관리하는 runtimeSessionId(Build 등)에는 적용하지 않는다.
    const gapContext = !runReq.runtimeSessionId && storedSessionId && existing
      ? renderGapContext(unseenHistoryGap(runReq.history, existing.updatedAt), runReq.locale)
      : "";
    // resume 턴: 시스템 프롬프트가 재전송되지 않으므로 gap+턴 컨텍스트를 사용자 메시지에 싣는다.
    const r = await runCodexProcess(
      bin,
      args,
      composeResumeTurnPrompt(
        runReq.userPrompt,
        [gapContext, runReq.turnContext ?? ""].filter(Boolean).join("\n\n"),
        runReq.locale,
      ),
      runReq,
      events,
      usageBaseline,
    );
    if (runReq.signal?.aborted) {
      // 취소여도 스레드가 생겼으면 저장 → steering 메시지가 이 세션을 resume해 문맥 유지.
      if (runReq.chatId && fingerprint && r.threadId) {
        saveRuntimeSession(runReq.chatId, KIND, r.threadId, fingerprint, { ...codexUsageCounters(r), agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner });
      }
      throw abortReasonError(runReq);
    }
    if (r.code === 0) {
      if (runReq.chatId && fingerprint && r.threadId) {
        if (!saveRuntimeSession(runReq.chatId, KIND, r.threadId, fingerprint, { ...codexUsageCounters(r), agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner })) {
          events.onStatus(`[runtime-session] store_failed kind=${KIND}`);
        }
      }
      events.onStatus(`[runtime-session] resumed kind=${KIND}`);
      return {
        text: r.text.trim(),
        ...(r.failure ? { failure: r.failure } : {}),
        sessionId: r.threadId ?? resumeSessionId,
        tokens: r.tokens,
        ...(r.observedUsage ? { observedUsage: r.observedUsage } : {}),
        appliedEffort,
      };
    }
    // Build continuation recovery is owned by Main, which can remove exactly
    // one attributed server and preserve approved peers. Replaying here with
    // the identical broken config would exceed that one-retry bound.
    if (
      !runReq.chatId &&
      mcpArgs.length > 0 &&
      containsMcpStartupTransportFatal(r.stderr)
    ) {
      throw new Error(`codex CLI exit ${r.code}${r.stderr ? `\n${r.stderr.slice(0, 500)}` : ""}`);
    }
    events.onStatus(`[runtime-session] resume_failed kind=${KIND} exit=${r.code}`);
    if (runReq.unattended) {
      throw new Error(`Automation runtime session resume failed for ${KIND}; refusing to create a fresh CLI session.`);
    }
    // Interactive chat may recover with the full durable history after an explicit receipt.
    if (runReq.chatId) clearRuntimeSession(runReq.chatId, KIND, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner });
  }

  // CREATE: 시스템 프롬프트 + 히스토리 + user를 stdin으로 보내 새 세션을 시드한다.
  const createArgs = [
    "exec",
    ...approvalArgs,
    ...isolatedConfigArgs,
    ...browserOnlyConfigArgs,
    "--json",
    "--skip-git-repo-check",
    ...permArgs,
    ...mcpArgs,
    ...modelArgs,
    ...schemaArgs,
    "-",
  ];
  const created = await runCodexProcess(bin, createArgs, buildPrompt(runReq), runReq, events, { output: 0, input: 0, cachedInput: 0 });
  if (runReq.signal?.aborted) {
    if (runReq.chatId && fingerprint && created.threadId) {
      saveRuntimeSession(runReq.chatId, KIND, created.threadId, fingerprint, { ...codexUsageCounters(created), agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner });
    }
    throw abortReasonError(runReq);
  }
  if (created.code === 0) {
    if (runReq.chatId && fingerprint && created.threadId) {
      if (!saveRuntimeSession(runReq.chatId, KIND, created.threadId, fingerprint, { ...codexUsageCounters(created), agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner })) {
        events.onStatus(`[runtime-session] store_failed kind=${KIND}`);
      }
    }
    events.onStatus(`[runtime-session] created kind=${KIND}`);
    return {
      text: created.text.trim(),
      ...(created.failure ? { failure: created.failure } : {}),
      sessionId: created.threadId ?? undefined,
      tokens: created.tokens,
      ...(created.observedUsage ? { observedUsage: created.observedUsage } : {}),
      appliedEffort,
    };
  }
  // The stream may already have said *why* (turn.failed: "You've hit your
  // usage limit…"). That typed marker is the failure; a generic "exit 1" that
  // drops it left the person a red "실패" with no reason (measured 2026-08-16).
  if (created.failure) {
    return {
      text: created.text.trim(),
      failure: created.failure,
      sessionId: created.threadId ?? undefined,
      tokens: created.tokens,
      ...(created.observedUsage ? { observedUsage: created.observedUsage } : {}),
      appliedEffort,
    };
  }
  throw new Error(
    `codex CLI exit ${created.code}${created.stderr ? `\n${created.stderr.slice(0, 500)}` : ""}`,
  );
};

/**
 * Preserve inline screenshots from Codex custom-tool results before the UI
 * preview is truncated. The shared parser validates the MCP envelope and
 * base64 bounds; this path validates the decoded image signature before using
 * the existing PNG/JPEG artifact store. Tool prose and paths are never
 * inspected for this purpose.
 */
function codexInlineCapturePaths(toolName: string, output: unknown): string[] {
  let raw: string;
  if (typeof output === "string") raw = output;
  else {
    try { raw = JSON.stringify(output ?? ""); } catch { return []; }
  }
  const images = parseMcpResult(raw, toolName).blocks.filter((block) =>
    block.kind === "image" && block.source === "inline" && (block.mimeType === "image/png" || block.mimeType === "image/jpeg"),
  );
  const paths: string[] = [];
  for (const image of images.slice(0, 4)) {
    if (image.kind !== "image") continue;
    const mimeType = image.mimeType === "image/png" || image.mimeType === "image/jpeg" ? image.mimeType : null;
    if (!mimeType) continue;
    const comma = image.src.indexOf(",");
    const encoded = comma >= 0 ? image.src.slice(comma + 1) : "";
    if (inferInlineImageMime(encoded) !== mimeType) continue;
    const filePath = saveBrowserCaptureArtifact(mimeType, encoded);
    if (filePath) paths.push(filePath);
  }
  return paths;
}
