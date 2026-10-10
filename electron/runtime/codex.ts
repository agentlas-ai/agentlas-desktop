import { registerNativeApprovalChildSignal } from "./native-approval-provenance";
// Codex CLI — 감지 + 실호출.
// 사용자의 ChatGPT Plus/Pro 구독으로 돌아간다 (PRD §3.1 6-A).
//
// 호출 형식: codex exec "<prompt>"  (—— Codex CLI의 exec 모드)
// V0는 single-turn; 이전 대화를 user 입력에 inline.
import path from "node:path";
import { assertScienceRecoveryRequest } from "../science-host/recovery-authority";
import { RuntimeJudgmentRefusal } from "./judgment-refusal";
import { runCodexNoTools, runCodexAliveNoTools } from "./codex-no-tools";
import { runCodexAliveResidentTurn, closeCodexAliveResidentOwner,
  codexAliveResidentGeneration, consumeCodexAliveResidentResult } from "./codex-alive-session";
import { aliveDecisionProfileForRequest } from "./alive-decision-context";
import { resolveEffectiveContextWindow } from "../../shared/models";
import { accountCodexHome, withCodexProductHome } from "./codex-product-home";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { ToolRequestReplayGuard } from "../../shared/tool-request-replay";
import { createCodexNativeTurnController, probeCodexNativeSteering } from "./codex-native-steering";
import type { ObservedTokenUsage } from "../../shared/observed-usage";
import { StringDecoder } from "node:string_decoder";
import { codexSystemPromptWithSchemaFallback, openAiStrictSchemaOrNull } from "./strict-output-schema";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult , RunnerFailure } from "./runner";
import { WORK_PROJECT_RESIDENCY_BUSY_CODE } from "./project-residency";
import { cumulativeSurfaceGateText, ensureChildCloseAfterExit, startCliHeartbeat, wrapSystemPrompt, workforceObservedHostAuthorityEnforcement, RuntimeTurnUnsettledError } from "./runner";
import { detectRuntimeRefusal } from "./runtime-refusal";
import { abortReasonError } from "./abort-reason";
import { containsMcpStartupTransportFatal } from "./mcp-startup-fatal";
import {
  CLI_HISTORY_CONTEXT_TOKENS,
  composeResumeTurnPrompt,
  renderConversationContext,
  renderGapContext,
  unseenHistoryGap, dedupeStableTurnContext, acknowledgeStableTurnContext, invalidateStableTurnContext,
  type StableTurnContextDelivery } from "./continuity";
import { agentContextSessionKey } from "./agent-context";
import { tStatus } from "./status-i18n";
import { agentRunCwd, detachedSpawnOpts, firstExistingCli, killCliTree, probeCliVersion, spawnCli, trackRunChild, writeStdin } from "./exec";
import { nativeCliCandidates } from "./native-cli";
import { observeCliExecutableIdentity } from "./cli-executable-identity";
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
import {
  ROOM_AUTO_COMPACT_TOKEN_LIMIT, boundHandoffHistory, decideSessionRotation, readThreadHealth,
  recordRotationReceipt, recordThreadTurn, renderRotationNotice,
} from "./session-rotation";
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
  prepareCodexExecThreadResume,
  type CodexResidentSession,
  type CodexTurnSink,
} from "./codex-session";
import { CodexWorkforceObservation, inspectCodexWorkforceGrant, readCodexWorkforceInventory, waitForCodexWorkforceInventory } from "./codex-workforce";
import { answerCodexMcpElicitation } from "./codex-elicitation";
import { residencyDisabledFor } from "./claude-session";
import { codexDesktopSurfaceArgs } from "./codex-desktop-surface";
import {
  claimRuntimeSessionTurn,
  classifyCodexResumeFailure,
  freshSessionReplacesStored,
  unattendedFreshSessionStatus,
  type UnattendedFreshSessionReason,
} from "./unattended-session-turns";
import { isResidencyExemptAgent, resolveAgentResidencySource } from "./agent-residency";
import type { AcpSessionLease } from "./acp-session-pool";
import { generateImage } from "../multimodal/image";
import { multimodalImageSlot, multimodalImageSlotDiagnosis } from "../multimodal/slot";
import { copyGeneratedImageIntoWorkspace } from "../multimodal/workspace-image-copy";
import { bindNativeFileProofObserver, mcpFileProofCandidate } from "../long-run/file-proof";
import { bindScienceNativeToolObserver, bindScienceNativeFailureObserver, createAdapterEffectLedger } from "../invocation/adapter-effect-context";
import {
  defaultRuntimeToolPermission,
  getRuntimeToolPermissionArbiter,
  type RuntimeToolPermissionAsk,
} from "./tool-approval";

const KIND = "codex";
const CODEX_IMAGE_TOOL_NAME = "generate_image";
const CODEX_IMAGE_TOOL_VERSION = "agentlas.generate-image.v1";

type NativeFileProofObserver = ReturnType<typeof bindNativeFileProofObserver>;
type NativeFileProofInput = Parameters<NativeFileProofObserver>[0];
type NativeFileProofTicket = Exclude<ReturnType<NativeFileProofObserver>, null>;

/** Admit only paths that Codex included in a structured FileChange start. */
export function codexNativeFileProofCandidates(
  toolId: string | undefined,
  rawItem: unknown,
  runReq: Pick<RunnerRequest, "chatId" | "cwd" | "permission">,
): NativeFileProofInput[] {
  if (!toolId || !rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return [];
  const item = rawItem as Record<string, unknown>;
  if (!["fileChange", "FileChange", "file_change"].includes(String(item.type ?? ""))) return [];
  const rows: Array<{ filePath: string; kind: string }> = [];
  if (Array.isArray(item.changes)) {
    for (const raw of item.changes) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const change = raw as Record<string, unknown>;
      if (typeof change.path === "string" && typeof change.kind === "string") {
        rows.push({ filePath: change.path, kind: change.kind });
      }
    }
  } else if (item.changes && typeof item.changes === "object") {
    for (const [filePath, raw] of Object.entries(item.changes as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const change = raw as Record<string, unknown>;
      const kind = typeof change.type === "string" ? change.type : change.kind;
      if (typeof kind === "string") rows.push({ filePath, kind });
    }
  }
  const candidates = new Map<string, NativeFileProofInput>();
  for (const row of rows) {
    const action = row.kind.toLowerCase() === "add" ? "write"
      : row.kind.toLowerCase() === "update" ? "edit" : null;
    if (!action) continue;
    const candidate: NativeFileProofInput = { runtimeKind: KIND, chatId: runReq.chatId,
      cwd: runReq.cwd, permission: runReq.permission, toolId, toolName: "apply_patch",
      filePath: row.filePath, action };
    candidates.set(`${action}\0${row.filePath}`, candidate);
  }
  return [...candidates.values()];
}

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

export function codexImageToolInstructions(enabled: boolean): string {
  // ★Codex's own image_gen is a native ability (feature `image_generation`, stable).
  // The old contract told the model generation was "unavailable" whenever the
  // host slot was empty, and forbade its own image workflow when the slot was
  // ready — contradicting the runtime. Both routes are now allowed; the host
  // copies every result into the working folder so later steps have a path.
  const copyRule = "The host copies every generated image into the working folder's `assets/` directory and reports that path. Use that path for later steps (browser uploads, documents, slides); do not look for images in the runtime's private image store.";
  const honesty = "Say an image was generated only after a tool or your image generation actually returned one; if it failed, say so and preserve the reason. Never claim an image is above, attached, or displayed without that result.";
  return enabled
    ? [
        "## Agentlas image output contract",
        `To create or edit an image, call the host tool \`${CODEX_IMAGE_TOOL_NAME}\` (the owner's configured image engine) or use your own built-in image generation.`,
        copyRule,
        honesty,
      ].join("\n")
    : [
        "## Agentlas image output contract",
        "No host image-generation tool is attached to this thread. Use your own built-in image generation when an image is needed.",
        copyRule,
        honesty,
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
  const found = await firstExistingCli([...nativeCliCandidates("codex"), ...CANDIDATES]);
  if (!found) return null;
  const version = (await probeCliVersion(found)) ?? "unknown";
  return { path: found, version };
}

let cachedBin: string | null | undefined;
/** Runtime updates may replace the executable or move it to another path. */
export function clearCodexBinCache(): void {
  cachedBin = undefined;
}

async function getBin(source?: string, cwd = agentRunCwd(), env = process.env): Promise<string | null> {
  // Use the same exact executable as the invocation's auth probe. A selected source must never fall
  // through to the app-wide cached sibling; this bin also participates in the resident session pool key.
  if (source) return observeCliExecutableIdentity({ bin: source, cwd, env })?.executable ?? null;
  if (cachedBin !== undefined) return cachedBin;
  const probe = await probeCodex();
  cachedBin = probe?.path ?? null;
  return cachedBin;
}

function buildPrompt(req: RunnerRequest): string {
  const sys = wrapSystemPrompt(
    codexSystemPromptWithSchemaFallback(req),
    req.locale,
    req.permission,
    cumulativeSurfaceGateText(req.history, req.userPrompt),
    req.forceSurface,
    req.restrictedReadBoundary,
    req.untrustedNoTools,
    undefined,
    undefined,
    undefined,
    req.surfaceGate,
    KIND,
    req.sciencePromptProfile,
    req.judgmentOnly === true ? "host-judgment" : undefined,
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
    codexSystemPromptWithSchemaFallback(req),
    req.locale,
    req.permission,
    cumulativeSurfaceGateText(req.history, req.userPrompt),
    req.forceSurface,
    req.restrictedReadBoundary,
    req.untrustedNoTools,
    undefined,
    undefined,
    undefined,
    req.surfaceGate,
    KIND,
    req.sciencePromptProfile,
    req.judgmentOnly === true ? "host-judgment" : undefined,
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

/** Name only a thread we just created; host context is not an owner task title. */
async function nameNewCodexThread(
  session: CodexResidentSession,
  threadId: string,
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<void> {
  if (req.signal?.aborted) return;
  const text = req.surfaceUserPrompt
    ?.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ").trim();
  // Other callers may supply an enriched provider prompt without original text.
  // Leave their naming alone instead of promoting host instructions to a title.
  if (!text) return;
  const name = [...`Agentlas · ${text}`].slice(0, 80).join("").trim();
  try {
    await session.conn.request("thread/name/set", { threadId, name },
      { timeoutMs: 1_000, signal: req.signal });
  } catch {
    // Metadata is optional on older CLIs. Never restart or replay the task over it.
    if (!req.signal?.aborted) events.onStatus(`[runtime-session] name_unavailable kind=${KIND}`);
  }
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
  // Science grants use a private CODEX_HOME whose rollout files are removed
  // when that host ends. A persisted thread id from the previous host cannot
  // be resumed in the new home even when the conversation seed is unchanged.
  // Bind only this isolated Science session to its home; ordinary Codex chats
  // keep their existing continuity fingerprint across model/config changes.
  const scienceHome = req.env?.AGENTLAS_SCIENCE_MCP_TOKEN && req.env.CODEX_HOME
    ? path.resolve(req.cwd ?? agentRunCwd(), req.env.CODEX_HOME)
    : null;
  // Model choice is deliberately absent from this fingerprint. A resident Codex
  // process can fork the held thread for a new model, retaining its history
  // without treating the old thread as if it had changed models. The seed keeps
  // unrelated settings from severing conversation continuity.
  if (req.sessionFingerprintSeed) {
    return crypto
      .createHash("sha256")
      .update("seed.v4\0")
      .update(req.sessionFingerprintSeed)
      .update("\0image-tool\0")
      .update(codexImageToolCapability(req))
      .update(scienceHome ? `\0science-codex-home.v1\0${scienceHome}` : "")
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
    .update(scienceHome ? `\0science-codex-home.v1\0${scienceHome}` : "")
    .digest("hex");
}

/** Context delivery is narrower than native conversation continuity (which survives model changes). */
function stableContextFingerprint(req: RunnerRequest, fingerprint: string | null, configuration: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify([fingerprint, req.runtimeSessionOwnerId ?? req.agentId ?? null,
    req.runtimeSessionOwnerId != null, req.systemPrompt, req.locale, req.permission, req.approvalsReviewer,
    req.model, req.effort, req.forceSurface, req.browserOnly, req.isolatedMcpConfig,
    req.mcpAllowedTools, req.mcpConfigPath, req.toolBrokerSettingsPath, req.env?.CODEX_HOME, configuration])).digest("hex");
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
  observedUsage?: ObservedTokenUsage;
  /** 스트림 표식(또는 exit0 휴리스틱)이 말한 실패 — 있으면 text는 답이 아니다. */
  failure?: RunnerFailure;
  /** Stream activity is diagnostic only; missing events do not prove no dispatch. */
  turnStarted: boolean;
  turnCompleted: boolean;
  terminalObserved: boolean;
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
 * 새 epoch의 typed proof 없이는 이번 턴으로 귀속하지 않고 null을 반환한다.
 */
export function deltaFromBaseline(reported: number | undefined, baseline: number | null): number | null {
  if (reported == null || !Number.isSafeInteger(reported) || reported < 0) return null;
  if (baseline == null || !Number.isSafeInteger(baseline) || baseline < 0) return null;
  return reported >= baseline ? reported - baseline : null;
}

/** Native `last` is one response, not the whole tool loop. Subtract only a
 * known baseline belonging to this exact thread; missing fields stay unknown. */
export function codexObservedTurnUsage(
  total: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | null,
  baseline: CodexUsageBaseline,
): ObservedTokenUsage | undefined {
  const inputTokens = deltaFromBaseline(total?.inputTokens, baseline.input);
  const outputTokens = deltaFromBaseline(total?.outputTokens, baseline.output);
  const cachedInputTokens = deltaFromBaseline(total?.cachedInputTokens, baseline.cachedInput);
  if (inputTokens === null || outputTokens === null) return undefined;
  return { inputTokens, outputTokens,
    ...(cachedInputTokens !== null && cachedInputTokens <= inputTokens ? { cachedInputTokens } : {}) };
}

/** Raw counters at this settled turn boundary. Missing fields invalidate the next baseline. */
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
  if (!input.itemFailure) return null;
  // The process ended before its turn completed: the item diagnostic is the last thing it
  // said, not why it stopped. Owner Threads automation 2026-09-28 13:12Z (app quit for an
  // update mid-node) was recorded as "codex runtime exit: clamping SessionEnd hook timeout
  // to 3s …" — a harmless hook warning read as the cause. Say that the turn never finished.
  if (!input.turnCompleted || input.code !== 0) {
    const how = input.code === null ? "was stopped" : `exited with code ${input.code}`;
    return {
      ...input.itemFailure,
      message: `codex ${how} before its turn finished (last diagnostic: ${input.itemFailure.message})`.slice(0, 2000),
    };
  }
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
  observeNativeFile: NativeFileProofObserver,
  stableContextDelivery?: StableTurnContextDelivery,
): Promise<CodexRunResult> {
  const effects = createAdapterEffectLedger({ adapterKind: KIND, chatId: req.chatId, agentId: req.agentId }, events);
  events = effects.events;
  const observeScienceTool = bindScienceNativeToolObserver(req, effects.qualify);
  const observeScienceFailure = bindScienceNativeFailureObserver(req, effects.qualify);
  const reportedOutputTokenBaseline = usageBaseline.output;
  return effects.withScope(() => new Promise((resolve, reject) => {
    let terminalFailure: RunnerFailure | null = null;
    let itemFailure: RunnerFailure | null = null;
    // Preparation can yield while the owner stops the request. Check again at
    // child creation so a cancelled one-shot cannot start or receive a prompt.
    if (req.signal?.aborted) {
      reject(abortReasonError(req));
      return;
    }
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
    const runtimeAttemptId = crypto.randomUUID();
    events.onRuntimeAttemptStarted?.(runtimeAttemptId);
    // The attempt callback can synchronously stop this admitted child.
    if (!req.signal?.aborted) writeStdin(child, stdinPayload);

    let buffer = "";
    let text = "";
    let threadId: string | null = null;
    let tokens: number | undefined;
    let reportedOutputTokens: number | undefined;
    let reportedInputTokens: number | undefined;
    let reportedCachedInputTokens: number | undefined;
    let observedUsage: ObservedTokenUsage | undefined;
    let stderr = "";
    let lastEmit = 0;
    let turnCompleted = false;
    let terminalObserved = false;
    let turnStarted = false;
    // Newer Codex runtimes send native tool calls as response items instead of
    // the older `item.started` / `item.completed` command events. Dropping that
    // envelope made a real file edit look like a two-event "thought + final"
    // run in One even though the tool had succeeded. Keep the provider call id
    // so the started and completed notifications update one Activity row.
    const responseTools = new Map<string, { name: string; args?: string }>();
    const toolRequestReplay = new ToolRequestReplayGuard();
    const settledResponseToolIds = new Set<string>();
    const itemCapturePaths = new Map<string, string[]>();
    const nativeFileProofById = new Map<string, NativeFileProofTicket[]>();
    const settleNativeFileProof = (toolId: string | undefined, isError: boolean): void => {
      if (!toolId) return;
      const tickets = nativeFileProofById.get(toolId) ?? [];
      try { if (!isError) for (const ticket of tickets) ticket.complete(); }
      finally { nativeFileProofById.delete(toolId); }
    };
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
      return ["fileChange", "FileChange", "file_change"].includes(type)
        || /tool|function|command|shell|exec|mcp|image_?generation/i.test(type);
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
        changes?: unknown;
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
      if (typeof ev.type === "string" && ev.type !== "thread.started") turnStarted = true;
      const payload = record(ev.payload);
      if (stableContextDelivery && (ev.type === "compacted" || ev.type === "thread.compacted"
      || payload?.type === "context_compaction" || payload?.type === "context_compacted" || payload?.type === "compacted"
        || ["contextCompaction", "context_compaction", "compaction"].includes(String(ev.item?.type ?? "")))) {
        invalidateStableTurnContext(stableContextDelivery.identity);
      }
      if ((ev.type === "item.started" || ev.type === "item.completed") && ev.item) {
        effects.frame(String(ev.item.type ?? "unknown"), codexNativeItemEffectCoverage(ev.item), codexNativeOperationalItemId(ev.item));
        if (ev.type === "item.completed" && codexNativeItemMayOutliveTurn(ev.item)) effects.uncertain("native-background-operation");
      }
      if (ev.type === "event_msg" && payload?.type === "item_completed") {
        const item = record(payload.item);
        if (item) effects.frame(String(item.type ?? "unknown"), codexNativeItemEffectCoverage(item), codexNativeOperationalItemId(item));
      }
      if (ev.type === "response_item" && payload?.type === "custom_tool_call") {
        const rawName = nonEmptyText(payload.name);
        const id = nonEmptyText(payload.call_id) ?? nonEmptyText(payload.id);
        effects.frame("custom_tool_call", Boolean(rawName && id), id ?? undefined);
        if (rawName && id) {
          closeThinking();
          const input = nonEmptyText(payload.input);
          const name = responseToolName(rawName, input ?? undefined);
          if (!toolRequestReplay.accept(id, name, JSON.stringify(payload))) return;
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
        if (stableContextDelivery && ev.thread_id !== stableContextDelivery.identity.sessionId) {
          invalidateStableTurnContext(stableContextDelivery.identity);
        }
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
        terminalObserved = true;
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
        observeScienceTool(item);
        if (ev.type === "item.completed") observeScienceFailure(item, "item.completed");
        const nativeFileChange = ["fileChange", "FileChange", "file_change"].includes(item.type ?? "");
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
          nativeFileChange ? "apply_patch" : exactMcpName ??
          item.name ??
          (item.command ? "bash" : undefined) ??
          item.type ??
          "tool";
        const argPayload =
          nativeFileChange
            ? item.changes
            : item.command != null
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
          item.status === "declined" ||
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
        // Native image generation: never echo the base64 result; copy the bytes
        // into the working folder and report only that path.
        let toolName = name;
        let toolResultText = resultText;
        if (/image_?generation/i.test(item.type ?? "")) {
          toolName = "image_gen";
          toolResultText = ev.type === "item.completed" ? (isError ? "failed" : "completed") : undefined;
          if (ev.type === "item.completed" && !isError) {
            const savedPath = typeof (item as any).saved_path === "string" ? (item as any).saved_path
              : typeof (item as any).savedPath === "string" ? (item as any).savedPath : null;
            const copied = copyGeneratedImageIntoWorkspace({ cwd: req.cwd ?? agentRunCwd(), permission: req.permission,
              label: "image", sourcePath: savedPath,
              base64: savedPath ? null : typeof item.result === "string" ? item.result : null });
            if (copied) {
              artifactPaths = [copied];
              toolResultText = `Image generated and copied to ${copied}`;
            }
          }
        }
        if (ev.type === "item.started" && !toolRequestReplay.accept(item.id, toolName, JSON.stringify(item))) return;
        // 도구 이벤트 전에 본문을 플러시 — 렌더러 인터리브 앵커가 최신 좌표를 본다.
        if (text) {
          events.onPartial(text);
          lastEmit = Date.now();
        }
        events.onTool?.(
          toolName,
          /image_?generation/i.test(item.type ?? "") ? undefined
            : argsText && argsText.length > 2000 ? `${argsText.slice(0, 2000)}…` : argsText,
          toolResultText,
          item.id,
          isError,
          artifactPaths,
        );
        if (ev.type === "item.started" && item.id) {
          const mcpCandidate = item.type === "mcp_tool_call" && item.server && item.tool
            ? mcpFileProofCandidate({ toolId: effects.qualify(item.id), toolName, serverToolName: item.tool,
              args: item.arguments ?? item.args ?? item.input, chatId: req.chatId, cwd: req.cwd,
              permission: req.permission, mcpConfigPath: req.mcpConfigPath, configKey: item.server })
            : null;
          const tickets = [...codexNativeFileProofCandidates(effects.qualify(item.id), item, req), ...(mcpCandidate ? [mcpCandidate] : [])]
            .map((candidate) => observeNativeFile(candidate))
            .filter((ticket): ticket is NativeFileProofTicket => Boolean(ticket));
          if (tickets.length > 0 && !nativeFileProofById.has(item.id)) nativeFileProofById.set(item.id, tickets);
        } else if (ev.type === "item.completed") {
          settleNativeFileProof(item.id, isError);
        }
      } else if (ev.type === "turn.completed") {
        closeThinking();
        turnCompleted = true;
        terminalObserved = true;
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
        observedUsage = codexObservedTurnUsage({ inputTokens: reportedInputTokens,
          outputTokens: reportedOutputTokens, cachedInputTokens: reportedCachedInputTokens }, usageBaseline);
        if (observedUsage) events.onTerminalObservedUsage?.(observedUsage, runtimeAttemptId);
        const turnCached = deltaFromBaseline(reportedCachedInputTokens, usageBaseline.cachedInput);
        if (turnInput != null && turnInput > 0 && turnCached != null) {
          // Cached input is a measured subset of input and is retained in the receipt.
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
          effects.uncertain("native-json-frame-invalid");
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
      if (stableContextDelivery) invalidateStableTurnContext(stableContextDelivery.identity);
      effects.complete("process_error", false);
      reject(req.signal?.aborted ? abortReasonError(req) : new RuntimeTurnUnsettledError(KIND, req.locale));
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
      if (buffer.trim()) effects.uncertain("native-trailing-frame-unparsed");
      effects.complete("process_closed", terminalObserved && code !== null && !req.signal?.aborted);
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
      // Exec owns one stdin request. Its completed native turn and exact thread
      // identity acknowledge that request; spawn/write/thread.started alone do not.
      if (code === 0 && !runnerFailure && turnCompleted && threadId && !req.signal?.aborted) {
        acknowledgeStableTurnContext(stableContextDelivery,
          { sessionId: threadId, acknowledgementId: `exec-turn-completed:${runtimeAttemptId}` });
      } else if (stableContextDelivery) {
        invalidateStableTurnContext(stableContextDelivery.identity);
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
        turnStarted,
        turnCompleted,
        terminalObserved,
      });
    });
  }));
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
    case "imageView":
    case "ImageView":
    case "image_view":
      return { name: "view_image", args: asText({ path: item.path }), result: completed ? "completed" : undefined,
        isError: completed && (item.status === "failed" || item.error != null) };
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
    case "imageGeneration":
    case "image_generation": {
      // Never echo `result` — it is the image itself (base64). The host copies
      // the bytes into the working folder and reports only that path.
      const failed = item.status === "failed" || item.failure != null;
      return {
        name: "image_gen",
        args: asText({ prompt: typeof item.revisedPrompt === "string" ? item.revisedPrompt.slice(0, 1200) : undefined }),
        result: completed ? (failed ? asText({ status: item.status ?? "failed", failure: item.failure ?? null }) : "completed") : undefined,
        isError: completed && failed,
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

/** Native protocol types, not display-name allowlists. New item types leave coverage open. */
export function codexNativeItemEffectCoverage(item: any): boolean {
  if (!item || typeof item.type !== "string") return false;
  if (["reasoning", "Reasoning", "agentMessage", "AgentMessage", "agent_message", "userMessage", "UserMessage", "plan", "contextCompaction", "error"].includes(item.type)) return true;
  return Boolean(codexNativeOperationalItemId(item)) && (codexToolEventFromItem(item, false) !== null
    || ["command_execution", "mcp_tool_call", "function_call", "file_change", "web_search"].includes(item.type));
}
export function codexNativeOperationalItemId(item: any): string | undefined {
  if (!item || ["reasoning", "Reasoning", "agentMessage", "AgentMessage", "agent_message", "userMessage", "UserMessage", "plan", "contextCompaction", "error"].includes(item.type)) return undefined;
  return typeof item.id === "string" && item.id.trim() ? item.id : undefined;
}
export function codexNativeOperationProgressCovered(params: any, threadId: string | null | undefined, turnId: string, operationStarted: (id: string) => boolean): boolean {
  return typeof params?.threadId === "string" && params.threadId === threadId
    && typeof params?.turnId === "string" && params.turnId === turnId && Boolean(turnId)
    && typeof params?.itemId === "string" && Boolean(params.itemId) && operationStarted(params.itemId);
}
export function codexNativeItemMayOutliveTurn(item: any): boolean {
  if (!item || !["commandExecution", "command_execution"].includes(item.type)) return false;
  return item.background === true || item.sessionId != null || item.terminalSessionId != null
    || item.status === "inProgress" || item.status === "in_progress"
    || (typeof item.command === "string" && /(^|[^&])&([^&]|$)/.test(item.command));
}

interface ResidentTurnOutcome {
  /** 완주했다 — 이 결과를 그대로 돌려준다(성공이든 표식 실패든). */
  result?: RunnerResult;
  /** 화면에 아무것도 나가지 않았다 — 이 턴을 1회성 exec 경로로 **한 번** 다시 시도한다. */
  retryOneShot?: true;
}

/**
 * A native turn may fall back to exec only before dispatch. A missing terminal
 * receipt after dispatch is held for reconciliation, including tool-only turns.
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
  /** Vendor-surface overrides; part of the spawn args, so part of the pool key. */
  surfaceArgs?: string[];
  appliedEffort: string | null;
  observeNativeFile: NativeFileProofObserver;
}): Promise<ResidentTurnOutcome> {
  const { bin, req, chatId, fingerprint, resumeThreadId, gapContext, mcpArgs, appliedEffort, observeNativeFile } = input;
  publishCodexNativeControlState(input.events, "app-server", "pending", "native_control_pending");
  // Host capability is internal continuity identity, never effect/approval chat authority.
  const canonicalContextKey = req.agentContext && !req.minimalObservation && !req.untrustedNoTools
    && !req.scienceRecoveryCapability && !req.restrictedReadBoundary && !req.judgmentOnly
    ? agentContextSessionKey(req.agentContext) : undefined;
  const contextChatId = canonicalContextKey ?? req.chatId;
  let events = input.events;
  const surfaceArgs = input.surfaceArgs ?? [];
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
  const args = [...CODEX_APP_SERVER_ARGS, "-c", "model_reasoning_summary=auto", "-c", `model_auto_compact_token_limit=${req.scienceController ? 150000 : ROOM_AUTO_COMPACT_TOKEN_LIMIT}`, ...surfaceArgs, ...mcpArgs];
  const pool = codexSessionPool();
  const poolKey = codexPoolKey({
    chatId: canonicalContextKey ?? req.approvalChatId ?? chatId,
    fingerprint,
    sessionOwnerId: runtimeSessionOwnerId ?? null,
    isolateOwner: isolateRuntimeSessionOwner,
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
        projectId: req.workProjectId ?? null,
        runtimeKind: KIND,
        source: resolveAgentResidencySource(req.agentId),
        reaperExempt: isResidencyExemptAgent(req.agentId),
      },
      () => openCodexResidentSession({ bin, args, cwd, env, label: req.backendLabel || "codex" }),
    );
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === WORK_PROJECT_RESIDENCY_BUSY_CODE) {
      throw err;
    }
    // 구형 CLI 는 `app-server` 하위 명령 자체가 없다 — 프로세스 수명 동안 1회 학습해 영구 강등.
    if (looksLikeMissingAppServer("", err)) {
      markCodexAppServerUnsupported(err instanceof Error ? err.message : String(err));
      events.onStatus(`[residency] disabled kind=${KIND} reason=app-server-unsupported`);
    }
    if (req.workforceRuntimeToolGrant) throw err;
    return { retryOneShot: true };
  }

  const session = lease.session;
  const effects = createAdapterEffectLedger({ adapterKind: KIND, chatId: req.chatId, agentId: req.agentId }, events);
  events = effects.events;
  const observeScienceTool = bindScienceNativeToolObserver(req, effects.qualify);
  const observeScienceFailure = bindScienceNativeFailureObserver(req, effects.qualify);
  const reusing = !lease.fresh && Boolean(session.threadId);
  const explicitResume = Boolean(req.runtimeSessionId);
  const modelChanged = Boolean(req.model && session.modelAcknowledgement?.requestedModel !== req.model);
  let broken = false;
  /** 이 턴에서 화면으로 나간 본문이 있는가 — 있으면 1회성 재시도는 답을 두 번 쓰는 짓이다. */
  let emitted = false;

  /* ── 이번 턴의 수신 상태 ── */
  const messageOrder: string[] = [];
  const messages = new Map<string, string>();
  const startedTools = new Set<string>();
  const toolRequestReplay = new ToolRequestReplayGuard();
  const nativeFileProofById = new Map<string, NativeFileProofTicket[]>();
  const settleNativeFileProof = (toolId: string, isError: boolean): void => {
    const tickets = nativeFileProofById.get(toolId) ?? [];
    try { if (!isError) for (const ticket of tickets) ticket.complete(); }
    finally { nativeFileProofById.delete(toolId); }
  };
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
  let acknowledgedTurnId = "";
  const pendingTurnCompletions = new Map<string, unknown>();
  let stableContextDelivery: StableTurnContextDelivery | undefined;
  let turnRequestInFlight = false;
  let turnDispatchAttempted = false;
  let terminalObserved = false;
  let terminalSucceeded = false;
  const runtimeAttemptId = crypto.randomUUID();
  let nativeThreadCreated = false;
  let turnUsageBaseline: CodexUsageBaseline = { input: null, output: null, cachedInput: null };
  const pendingModelReroutes = new Map<string, { fromModel: string; toModel: string }>();
  /*
   * 사용량은 알림 콜백에서 채워진다 — 홀더 객체에 담는다(let 변수는 TS 흐름 분석이
   * 콜백 대입을 못 봐서 항상 null 로 좁혀진다).
   */
  const usage: {
    observed: ObservedTokenUsage | undefined;
    total: { outputTokens: number; inputTokens?: number; cachedInputTokens?: number } | null;
  } = { observed: undefined, total: null };
  // Thread-health observations for rotation (session-rotation.ts): last model-call input of this turn and
  // native compactions seen. Recorded only for a turn that reached a terminal; a failed turn adds nothing.
  const health: { lastInputTokens: number | null; compactionItems: Set<string>; compactedNotices: number } =
    { lastInputTokens: null, compactionItems: new Set(), compactedNotices: 0 };
  const persistTurnCounters = (): void => {
    if (!session.threadId) return;
    if (terminalObserved) {
      recordThreadTurn(session.threadId, { lastInputTokens: health.lastInputTokens,
        compactions: Math.max(health.compactionItems.size, health.compactedNotices) });
    }
    const total = terminalObserved ? usage.total : null;
    if (!saveRuntimeSession(chatId, KIND, session.threadId, fingerprint, {
      agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner,
      reportedOutputTokens: total?.outputTokens ?? null,
      reportedInputTokens: total?.inputTokens ?? null,
      reportedCachedInputTokens: total?.cachedInputTokens ?? null,
    })) events.onStatus(`[runtime-session] store_failed kind=${KIND}`);
  };
  let failure: RunnerFailure | null = null;
  let interrupted = false;
  let settleTurn: ((reason: "completed" | "closed") => void) | null = null;
  let closedReason = "";
  let modelSelectionError: CodexModelSelectionError | null = null;
  let nativeTurnController: ReturnType<typeof createCodexNativeTurnController> | null = null;
  const withdrawNativeTurnController = (): void => {
    nativeTurnController?.revoke();
    nativeTurnController = null;
    publishCodexNativeControlState(events, "app-server", "withdrawn", "native_control_withdrawn");
  };
  // Every blocking MCP elicitation belongs to this one turn, even when the
  // underlying app-server process survives for later turns. Stop, transport
  // close, or checkout release must cancel the question before the session can
  // be reused by another chat/turn.
  const elicitationAbort = new AbortController();
  registerNativeApprovalChildSignal(req.signal, elicitationAbort.signal);

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
    withdrawNativeTurnController();
    const acknowledged = session.modelAcknowledgement;
    modelSelectionError = new CodexModelSelectionError(
      "rerouted",
      `Codex rerouted the explicitly requested model from ${String(fromModel ?? acknowledged?.model ?? req.model)} to ${String(toModel ?? "unknown")}.`,
    );
    broken = true;
    settleTurn?.("completed");
  };









  const fromOtherThread = (params: any): boolean =>
    typeof params?.threadId === "string" && typeof session.threadId === "string" && session.threadId !== ""
    && params.threadId !== session.threadId;

  const onNotification = (method: string, params: any): void => {
    if (params?.threadId === session.threadId && (method === "thread/compacted"
      || ["thread/closed", "thread/deleted", "thread/archived"].includes(method)
      || ((method === "item/started" || method === "item/completed")
        && ["contextCompaction", "context_compaction", "compaction"].includes(String(params?.item?.type ?? ""))))) {
      invalidateStableTurnContext({ chatId: contextChatId, runtimeKind: KIND, sessionId: session.threadId ?? "" });
      if (method === "thread/compacted") health.compactedNotices += 1;
      else if (method === "item/completed") health.compactionItems.add(String(params?.item?.id ?? health.compactionItems.size));
    }
    if (method === "item/started" || method === "item/completed") {
      if (fromOtherThread(params) || (confirmedTurnId && params?.turnId && params.turnId !== confirmedTurnId)) {
        effects.uncertain("native-child-or-other-turn-uncovered"); return;
      }
      effects.frame(String(params?.item?.type ?? "unknown"), codexNativeItemEffectCoverage(params?.item), codexNativeOperationalItemId(params?.item));
      if (method === "item/completed" && codexNativeItemMayOutliveTurn(params?.item)) effects.uncertain("native-background-operation");
    } else if (["item/commandExecution/outputDelta", "item/fileChange/outputDelta", "item/mcpToolCall/progress"].includes(method)) {
      const id = typeof params?.itemId === "string" ? params.itemId : undefined;
      effects.frame(method, codexNativeOperationProgressCovered(params, session.threadId, confirmedTurnId, effects.operationStarted), id);
    } else if (method.startsWith("item/") && !["item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta",
      "item/reasoning/summaryPartAdded", "item/plan/delta"].includes(method)) {
      effects.frame(method, false);
    }
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
        // The thread/start and resume responses own session.threadId. A sub-agent's
        // thread also announces itself here and must not take over this session.
        if (typeof params?.thread?.id === "string" && !session.threadId) session.threadId = params.thread.id;
        break;
      case "turn/started":
        // 이 자리는 exec 경로와 같은 의미다 — 모델이 생각을 시작했다는 가장 이른 신호.
        if (typeof params?.turn?.id === "string" && params?.threadId === session.threadId
          && ((confirmedTurnId && params.turn.id === confirmedTurnId) || (!confirmedTurnId && turnRequestInFlight))) {
          turnId = params.turn.id;
          confirmedTurnId = params.turn.id;
          openThinking();
        }
        break;
      case "item/started": {
        const item = params?.item;
        observeScienceTool(item);
        if (item?.type === "reasoning") { if (!fromOtherThread(params)) openThinking(); break; }
        const tool = codexToolEventFromItem(item, false);
        if (tool) {
          if (!toolRequestReplay.accept(String(item.id ?? ""), tool.name,
            JSON.stringify(item), JSON.stringify([params?.threadId ?? null, params?.turnId ?? confirmedTurnId ?? null]))) break;
          closeThinking();
          if (bodyText()) emitPartial(true);
          startedTools.add(String(item.id ?? ""));
          events.onTool?.(tool.name, tool.args, undefined, String(item.id ?? ""), false);
          const itemId = String(item.id ?? "");
          const tickets = codexNativeFileProofCandidates(effects.qualify(itemId), item, req)
            .map((candidate) => observeNativeFile(candidate))
            .filter((ticket): ticket is NativeFileProofTicket => Boolean(ticket));
          if (itemId && tickets.length > 0 && !nativeFileProofById.has(itemId)) nativeFileProofById.set(itemId, tickets);
        }
        break;
      }
      case "item/agentMessage/delta": {
        if (fromOtherThread(params)) break;
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
        observeScienceTool(item);
        observeScienceFailure(item, "item/completed");
        if (item?.type === "agentMessage") {
          if (fromOtherThread(params)) break;
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
          // A sub-agent's reasoning is not this turn's thinking row.
          if (fromOtherThread(params)) break;
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
          if ((item?.type === "imageGeneration" || item?.type === "image_generation") && !tool.isError) {
            const savedPath = typeof item.savedPath === "string" ? item.savedPath : typeof item.saved_path === "string" ? item.saved_path : null;
            const copied = copyGeneratedImageIntoWorkspace({ cwd, permission: req.permission, label: "image",
              sourcePath: savedPath, base64: savedPath ? null : typeof item.result === "string" ? item.result : null });
            if (copied) {
              artifactPaths = [copied];
              tool.result = `Image generated and copied to ${copied}`;
            }
          }
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
          settleNativeFileProof(itemId, tool.isError);
          if (item?.type === "dynamicToolCall") dynamicToolArtifactPaths.delete(itemId);
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        // The notification's total is thread cumulative. `last` is only the
        // latest response inside that turn, including its tool loop.
        if (fromOtherThread(params)) break;
        if (confirmedTurnId && typeof params?.turnId === "string" && params.turnId !== confirmedTurnId) break;
        const last = params?.tokenUsage?.last;
        const total = params?.tokenUsage?.total;
        if (total && Number.isSafeInteger(total.outputTokens) && total.outputTokens >= 0) {
          usage.total = {
            outputTokens: total.outputTokens,
            ...(Number.isSafeInteger(total.inputTokens) && total.inputTokens >= 0 ? { inputTokens: total.inputTokens } : {}),
            ...(Number.isSafeInteger(total.cachedInputTokens) && total.cachedInputTokens >= 0 ? { cachedInputTokens: total.cachedInputTokens } : {}),
          };
          usage.observed = codexObservedTurnUsage(usage.total, turnUsageBaseline);
          if (usage.observed) events.onUsage?.(usage.observed.outputTokens);
        }
        if (last && Number.isSafeInteger(last.inputTokens) && last.inputTokens > 0) health.lastInputTokens = last.inputTokens;
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
        // A sub-agent's non-retry error (its own turn failed or was interrupted)
        // is reported to the parent through the collab/subAgentActivity item, not
        // as this turn's failure. codex exec routes Error by exact thread+turn
        // (exec/src/lib.rs should_process_notification); so do we.
        if (fromOtherThread(params)) {
          const childMessage = typeof params?.error?.message === "string" ? params.error.message : "";
          if (childMessage) events.onStatus(`codex sub-agent: ${childMessage.slice(0, 200)}`);
          break;
        }
        // 턴이 재시도할 수 있는 오류는 실패가 아니다 — 서버가 willRetry 로 말해 준다.
        const message = typeof params?.error?.message === "string" ? params.error.message : "";
        if (message) events.onStatus(`codex: ${message.slice(0, 400)}`);
        if (params?.willRetry !== true && !failure) {
          withdrawNativeTurnController();
          failure = codexFailureFromTurn({ status: "failed", error: params?.error }) ?? failure;
        }
        break;
      }
      case "turn/completed": {
        const turn = params?.turn;
        if (!turn || params?.threadId !== session.threadId || typeof turn.id !== "string" || !turn.id) break;
        // Notifications may precede the turn/start response. Only its exact
        // acknowledged ID can bind a terminal result to this submitted prompt.
        if (!acknowledgedTurnId) {
          if (turnRequestInFlight && pendingTurnCompletions.size < 64) pendingTurnCompletions.set(turn.id, params);
          break;
        }
        if (turn.id !== acknowledgedTurnId) break;
        withdrawNativeTurnController();
        terminalObserved = true;
        terminalSucceeded = turn.status === "completed";
        if (usage.observed) events.onTerminalObservedUsage?.(usage.observed, runtimeAttemptId);
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
    ...(req.planMode ? { planMode: true as const } : {}),
    // Same lifetime as MCP elicitations: Stop, transport close and turn settle
    // withdraw a pending approval card (codex itself cancels the server request
    // on turn transition — openai/codex@44fe510c outgoing_message.rs:215-230).
    signal: elicitationAbort.signal,
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
          ...(req.planMode ? { planMode: true as const } : {}),
          signal: elicitationAbort.signal,
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
        const workspaceCopy = copyGeneratedImageIntoWorkspace({ cwd, permission: req.permission,
          sourcePath: generated.artifactPath, label: "image" });
        return {
          success: true,
          contentItems: [
            { type: "inputText", text: `Image generation succeeded with ${generated.engine ?? imageToolSlot.runtimeKind}. The image is attached to this tool result.${workspaceCopy ? ` A copy is saved in the working folder at ${workspaceCopy} — use this path for uploads and later steps.` : ""}` },
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
          // Codex's own MCP tool approvals are answered by the same arbiter as its bash approvals
          // (codex-elicitation.ts codexMcpToolApprovalFrom), not by an owner question sheet.
          decideToolApproval: async ({ serverName, toolName }) => {
            const ask: RuntimeToolPermissionAsk = {
              ...(req.planMode ? { planMode: true as const } : {}),
              signal: elicitationAbort.signal,
              runtime: KIND,
              sessionKey: `${KIND}:${req.sessionFingerprintSeed ?? chatId}`,
              tool: `mcp__${serverName}__${toolName}`,
              kind: "other",
              cwd,
              permission: req.permission,
              // Codex only asks for calls it judged not read-only (mcp_tool_call.rs:2466-2497).
              mutating: true,
              chatId: req.approvalChatId ?? chatId,
              ...(req.agentId ? { agentId: req.agentId } : {}),
              ...(req.unattended || req.noSynchronousAsk ? { unattended: true as const } : {}),
            };
            const arbiter = getRuntimeToolPermissionArbiter();
            let decision = defaultRuntimeToolPermission(ask);
            if (arbiter) {
              try { decision = await arbiter(ask); } catch { decision = "deny"; }
            }
            events.onStatus(`[tool-approval] runtime=${KIND} capability=other tool=${ask.tool} decision=${decision}`);
            return decision;
          },
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
      withdrawNativeTurnController();
      closedReason = reason;
      elicitationAbort.abort(new Error(reason));
      settleTurn?.("closed");
    },
  };

  /** 취소가 보낸 `turn/interrupt` 의 응답 — 세션을 죽이기 **전에** 이것을 기다린다. */
  let interruptAck: Promise<unknown> | null = null;
  const onAbort = (): void => {
    withdrawNativeTurnController();
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
  if (req.signal?.aborted) onAbort();

  return effects.withScope(async () => {
  try {
    session.active = sink;
    const nativeSteeringCapability = events.onNativeTurnController && !req.signal?.aborted
      ? await probeCodexNativeSteering({ bin, cwd, env }) : null;
    if (req.workforceRuntimeToolGrant) workforceObservation = new CodexWorkforceObservation(req, session.init, req.workforceRuntimeToolGrant.canonicalConfigSha256);
    /* ── 스레드: 살아 있는 세션이면 그대로, 새 프로세스면 resume 또는 start ── */
    // Model selection belongs to the thread protocol, not the resident process
    // identity. A live Codex thread/resume can acknowledge its previous model
    // even when given a new one. Fork that thread in the same app-server instead:
    // the fork inherits its history and acknowledges the requested model before
    // any prompt is sent. A model change must not create another CLI process.
    if (!reusing || workforceObservation || explicitResume || modelChanged) {
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
      const forkHeldThreadForModel = Boolean(reusing && modelChanged && !explicitResume && threadToResume);
      if (threadToResume) {
        let releaseResume: (() => void) | undefined;
        try {
          releaseResume = await prepareCodexThreadResume(session, threadToResume, req.signal);
          const response = await session.conn.request(
            forkHeldThreadForModel ? "thread/fork" : "thread/resume",
            {
              threadId: threadToResume,
              ...commonThreadParams,
              // Both resume and fork acknowledge the effective model. A fork
              // must retain the predecessor's completed history, not seed a
              // fresh thread from a partial UI transcript.
              ...(req.model ? { model: req.model } : {}),
            },
            { timeoutMs: 120_000, signal: req.signal },
          );
          const modelAcknowledgement = await acknowledgeCodexThreadModel({
            request: session.conn.request.bind(session.conn), response,
            requestedModel: req.model,
            ...(forkHeldThreadForModel ? {} : { expectedThreadId: threadToResume }),
            signal: req.signal,
          });
          if (forkHeldThreadForModel && response.thread.id === threadToResume) {
            throw new CodexModelSelectionError("resolution_unverified", "Codex model fork returned the previous thread instead of a new one.");
          }
          workforceObservation?.acknowledgeThread(response, modelAcknowledgement, policy, cwd, approvalsReviewer, threadToResume);
          session.threadId = forkHeldThreadForModel ? response.thread.id : threadToResume;
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
        nativeThreadCreated = true;
        session.modelAcknowledgement = modelAcknowledgement;
        await nameNewCodexThread(session, id, req, events);
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

    const storedUsageSession = getRuntimeSession(chatId, KIND, runtimeSessionOwnerId,
      { isolateOwner: isolateRuntimeSessionOwner });
    turnUsageBaseline = nativeThreadCreated ? { input: 0, output: 0, cachedInput: 0 }
      : storedUsageSession?.sessionId === session.threadId && storedUsageSession.fingerprint === fingerprint
        ? { input: storedUsageSession.reportedInputTokens, output: storedUsageSession.reportedOutputTokens,
            cachedInput: storedUsageSession.reportedCachedInputTokens }
        : { input: null, output: null, cachedInput: null };

    /* ── 턴 ── */
    // 새 스레드면 시스템+히스토리 시드, 이어가는 스레드면 사용자 턴만(+gap/turn 컨텍스트).
    const continuing = reusing || Boolean(resumeThreadId && session.threadId === resumeThreadId);
    // Prepare the exact dispatched seed too. Only the bound turn/start receipt
    // commits it; typed compaction/replacement and unsettled turns invalidate it.
    if (!reusing) invalidateStableTurnContext({ chatId: contextChatId, runtimeKind: KIND, sessionId: session.threadId });
    const resumeContext = dedupeStableTurnContext({ chatId: contextChatId, runtimeKind: KIND,
      sessionId: session.threadId, contextFingerprint: stableContextFingerprint(req, fingerprint, [bin, cwd, mcpArgs, surfaceArgs, appliedEffort]),
      turnContext: req.turnContext, stableBlocks: req.turnContextStable, retention: "native-compaction" });
    stableContextDelivery = resumeContext?.delivery;
    const promptText = continuing
      ? composeResumeTurnPrompt(
        req.userPrompt,
        [gapContext, resumeContext?.text].filter(Boolean).join("\n\n"),
        req.locale,
      )
      : buildResidentInitialTurnPrompt({ ...req, turnContext: resumeContext.text });
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
      ...(req.outputSchema && openAiStrictSchemaOrNull(req.outputSchema.schema) ? { outputSchema: req.outputSchema.schema } : {}),
    };
    const settled = new Promise<"completed" | "closed">((resolve) => {
      settleTurn = (reason) => { settleTurn = null; resolve(reason); };
    });
    let started: any;
    turnDispatchAttempted = true;
    events.onRuntimeAttemptStarted?.(runtimeAttemptId);
    turnRequestInFlight = true;
    try {
      started = await session.conn.request("turn/start", turnParams, { timeoutMs: 120_000, signal: req.signal });
    } finally {
      turnRequestInFlight = false;
    }
    workforceObservation?.startTurn(started);
    if (typeof started?.turn?.id === "string" && started.turn.id.trim()) {
      turnId = started.turn.id;
      confirmedTurnId = started.turn.id;
      acknowledgedTurnId = started.turn.id;
      if (!req.signal?.aborted) acknowledgeStableTurnContext(stableContextDelivery,
        { sessionId: session.threadId, acknowledgementId: started.turn.id });
    } else {
      throw new RuntimeTurnUnsettledError(KIND, req.locale);
    }
    const earlyCompletion = pendingTurnCompletions.get(acknowledgedTurnId);
    pendingTurnCompletions.clear();
    if (earlyCompletion) onNotification("turn/completed", earlyCompletion);
    const bufferedReroute = confirmedTurnId ? pendingModelReroutes.get(confirmedTurnId) : undefined;
    pendingModelReroutes.clear();
    if (bufferedReroute) {
      rejectModelReroute(bufferedReroute.fromModel, bufferedReroute.toModel);
    }
    // A notification alone cannot publish authority: the exact turn/start response
    // and the installed executable schema must both be confirmed first.
    if (nativeSteeringCapability && session.threadId && confirmedTurnId && !terminalObserved
      && !broken && !failure && !modelSelectionError && !req.signal?.aborted
      && /^[^\r\n\x00]{1,256}$/.test(confirmedTurnId)) {
      const nativeThreadId = session.threadId;
      const nativeTurnId = confirmedTurnId;
      nativeTurnController = createCodexNativeTurnController({
        binding: { runtime: KIND, chatId, runtimeSessionOwnerId: runtimeSessionOwnerId ?? null,
          threadId: nativeThreadId, turnId: nativeTurnId, model: session.modelAcknowledgement?.model ?? null,
          permission: req.permission ?? "read", cwd },
        capability: nativeSteeringCapability,
        isActive: () => session.active === sink && session.threadId === nativeThreadId
          && confirmedTurnId === nativeTurnId && !terminalObserved && !broken && !failure
          && !modelSelectionError && !req.signal?.aborted && codexResidentSessionAlive(session),
        request: session.conn.request.bind(session.conn),
      });
      try { events.onNativeTurnController?.(nativeTurnController.controller, { runtime: KIND, driver: "app-server", phase: "active", code: "native_control_active" }); }
      catch { withdrawNativeTurnController(); }
    }
    if (!nativeTurnController) publishCodexNativeControlState(events, "app-server", "unavailable", "native_control_unavailable");
    events.onStatus(`[runtime-session] ${continuing ? "resumed" : "created"} kind=${KIND}`);
    if (modelSelectionError) throw modelSelectionError;
    const reason = await settled;
    closeThinking();

    if (modelSelectionError) throw modelSelectionError;

    if (req.signal?.aborted) {
      // 취소여도 스레드가 생겼으면 저장 → 이어지는 steering 메시지가 문맥을 유지한다.
      persistTurnCounters();
      broken = true;
      throw abortReasonError(req);
    }
    if (reason === "closed") {
      // A closed transport cannot prove that a dispatched tool-only turn did nothing.
      broken = true;
      if (looksLikeMissingAppServer(session.conn.lastStderr, new Error(closedReason))) {
        markCodexAppServerUnsupported(closedReason || session.conn.lastStderr);
        events.onStatus(`[residency] disabled kind=${KIND} reason=app-server-unsupported`);
      }
      throw new RuntimeTurnUnsettledError(KIND, req.locale);
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
    persistTurnCounters();
    if (!text && !failure) {
      // 빈 답은 실패다 — 표식으로 말한다(텍스트 길이로 판정하는 소비자를 만들지 않는다).
      return {
        result: {
          text: "",
          ownerControlTerminal: "uncertain",
          failure: { kind: "empty", message: session.conn.lastStderr.slice(-500) || "codex app-server returned no message", runtime: KIND, source: "marker" },
          sessionId: session.threadId,
          appliedEffort,
        },
      };
    }
    return {
      result: {
        text,
        ownerControlTerminal: terminalSucceeded && !failure && !interrupted && !req.signal?.aborted
          ? "completed" : "uncertain",
        ...(failure ? { failure } : {}),
        sessionId: session.threadId,
        tokens: usage.observed?.outputTokens ?? Math.ceil(estChars / 4),
        ...(usage.observed ? { observedUsage: usage.observed } : {}),
        ...(workforcePermissionEnforcement ? { workforcePermissionEnforcement } : {}),
        appliedEffort,
      },
    };
  } catch (err) {
    broken = true;
    if (turnDispatchAttempted) persistTurnCounters();
    if (req.signal?.aborted) throw err;
    if (turnDispatchAttempted && !terminalObserved) throw new RuntimeTurnUnsettledError(KIND, req.locale);
    if (req.workforceRuntimeToolGrant) throw err;
    if (err instanceof CodexModelSelectionError) throw err;
    if (err instanceof CodexSessionContinuityError) throw err;
    if (looksLikeMissingAppServer(session.conn?.lastStderr ?? "", err)) {
      markCodexAppServerUnsupported(err instanceof Error ? err.message : String(err));
      events.onStatus(`[residency] disabled kind=${KIND} reason=app-server-unsupported`);
    }
    // Empty visible text is not evidence of no dispatch or no external action.
    if (turnDispatchAttempted) throw err;
    if (!emitted && !bodyText()) return { retryOneShot: true };
    throw err;
  } finally {
    withdrawNativeTurnController();
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
    if (broken || req.signal?.aborted || failure || interrupted || (turnDispatchAttempted && !terminalObserved)) {
      invalidateStableTurnContext({ chatId: contextChatId, runtimeKind: KIND, sessionId: session.threadId ?? "" });
    }
    effects.complete(turnDispatchAttempted ? "resident_turn_closed" : "not_dispatched", (!turnDispatchAttempted || terminalObserved) && !req.signal?.aborted && (!turnDispatchAttempted || !broken));
    if (broken || req.signal?.aborted) pool.discard(lease);
    else pool.release(lease);
  }
  });
}

/**
 * Codex features switched off for a Main-issued effect observation. `-c features.<name>=false` (not `--disable`) so a
 * name a newer/older CLI does not know is ignored instead of failing the run. Each removes tool schemas or context the
 * look does not need (measured 2026-09-25, codex 0.156.1).
 */
const OBSERVATION_DISABLED_CODEX_FEATURES = ["apps", "browser_use", "browser_use_external", "computer_use", "image_generation",
  "goals", "in_app_browser", "chronicle", "multi_agent", "memories", "plugins", "skill_search", "tool_suggest", "sleep_tool",
  "workspace_dependencies", "worktrees", "view_image", "realtime_conversation", "mentions_v2"] as const;

/**
 * One read-only look for a Main-issued effect observation on codex (routed 2026-09-25): production goals pinned to codex
 * paid ~1.17M input tokens per look (the One prompt, history and the resumed chat thread) — 28 looks ~33M tokens in 72h.
 * Here: a fresh ephemeral exec in a private CODEX_HOME that holds only a link to the account's auth (no user AGENTS.md,
 * config, plugins, memories or skills), the observation's own short instructions as the model instructions, the
 * project doc off, read-only sandbox, only Main's browser MCP server when the look needs it, and no session resume or
 * persistence. Measured: ~22k input tokens for a two-step file look (vs ~44k for a bare exec with the user's setup).
 */
async function runCodexMinimalObservation(bin: string, req: RunnerRequest, events: RunnerEvents,
  observeNativeFile: ReturnType<typeof bindNativeFileProofObserver>): Promise<RunnerResult> {
  const realHome = req.env?.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentlas-codex-observation-"));
  try {
    await fs.symlink(path.join(realHome, "auth.json"), path.join(home, "auth.json")).catch(() => {});
    const instructions = path.join(home, "observation-instructions.md");
    await fs.writeFile(instructions, codexSystemPromptWithSchemaFallback(req), { encoding: "utf8", mode: 0o600 });
    const schema = req.outputSchema ? openAiStrictSchemaOrNull(req.outputSchema.schema) : null;
    const schemaFile = path.join(home, "observation-output-schema.json");
    if (schema) await fs.writeFile(schemaFile, JSON.stringify(schema), { encoding: "utf8", mode: 0o600 });
    // Only Main's browser server survives (the client already drops MCP when the look needs no browser).
    const browserOnlyMcp: string[] = [];
    const source = req.mcpCodexConfigArgs ?? [];
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === "-c" && /^mcp_servers\.(?:"agentlas-browser"|agentlas-browser)\./.test(source[index + 1] ?? "")) {
        browserOnlyMcp.push("-c", source[index + 1]); index += 1;
      }
    }
    const args = [
      "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only",
      "-c", "project_doc_max_bytes=0", "-c", `model_instructions_file=${JSON.stringify(instructions)}`,
      "-c", 'web_search="disabled"', "-c", "include_apply_patch_tool=false",
      ...OBSERVATION_DISABLED_CODEX_FEATURES.flatMap((name) => ["-c", `features.${name}=false`]),
      ...browserOnlyMcp,
      ...(schema ? ["--output-schema", schemaFile] : []),
      ...(req.model ? ["--model", req.model] : []),
      "-",
    ];
    events.onStatus(`[runtime-session] observation kind=${KIND}`);
    const run = await runCodexProcess(bin, args, req.userPrompt, { ...req, env: { ...(req.env ?? process.env), CODEX_HOME: home } },
      events, { output: 0, input: 0, cachedInput: 0 }, observeNativeFile);
    if (req.signal?.aborted) throw abortReasonError(req);
    if (!run.terminalObserved) throw new RuntimeTurnUnsettledError(KIND, req.locale);
    if (run.code !== 0 && !run.text.trim()) throw new Error(`codex CLI exit ${run.code}${run.stderr ? `\n${run.stderr.slice(0, 500)}` : ""}`);
    return { text: run.text.trim(), ...(run.failure ? { failure: run.failure } : {}), tokens: run.tokens,
      ownerControlTerminal: run.code === 0 && run.turnCompleted && !run.failure && run.text.trim()
        ? "completed" : "uncertain",
      ...(run.observedUsage ? { observedUsage: run.observedUsage } : {}) };
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

function publishCodexNativeControlState(events: RunnerEvents,
  driver: import("./runner").RunnerNativeControlState["driver"],
  phase: import("./runner").RunnerNativeControlState["phase"],
  code: import("./runner").RunnerNativeControlState["code"]): void {
  try { events.onNativeTurnController?.(null, Object.freeze({ runtime: KIND, driver, phase, code })); }
  catch { /* Observation cannot change admission, Stop or settlement. */ }
}
export const runCodex: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  publishCodexNativeControlState(events, "unselected", "pending", "native_control_pending");
  assertScienceRecoveryRequest(req, "codex");
  // Validate before adding internal account/cwd transport fields. These fields
  // cannot turn a copied JSON request into the host's opaque Alive admission.
  const aliveAdmission = aliveDecisionProfileForRequest(req) ? req : null;
  // Judgment's gateway replaces all model input, so it can keep the actual
  // account home for keyring identity and CLI-owned refresh without a mirror.
  const requestEnv = req.env ?? process.env;
  req = { ...req, env: req.untrustedNoTools && req.judgmentOnly
    ? { ...requestEnv, CODEX_HOME: accountCodexHome(requestEnv.CODEX_HOME) }
    : withCodexProductHome(requestEnv) };
  const observeNativeFile = bindNativeFileProofObserver();
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
  const bin = await getBin(req.runtimeSource, req.cwd ?? agentRunCwd(), req.env ?? process.env);
  if (!bin) {
    throw new Error(tStatus(req.locale, "errCliMissingCodex"));
  }
  if (req.untrustedNoTools && req.judgmentOnly) {
    const inventory = await readCodexModelInventory(accountCodexHome(req.env?.CODEX_HOME));
    const effort = req.effort ? resolveCodexModelEffort(inventory, req.model, req.effort)
      : defaultCodexModelEffort(inventory, req.model);
    const capacities = [inventory.find(model => model.id === req.model)?.contextWindow,
      resolveEffectiveContextWindow("codex", req.model, req.longContext === true).contextWindow]
      .filter((value): value is number => typeof value === "number" && value > 0);
    const executeNoTools = async (args: string[], request: RunnerRequest): Promise<RunnerResult> => {
      const run = await runCodexProcess(bin, args, request.userPrompt, request, events,
        { output: 0, input: 0, cachedInput: 0 }, observeNativeFile);
      if (request.signal?.aborted) throw abortReasonError(request);
      if (!run.terminalObserved && !run.failure) {
        return { text: "", ownerControlTerminal: "uncertain", failure: { kind: "unavailable", runtime: KIND, source: "exit",
          providerCode: `codex_no_tools_cli_exit_${run.code ?? "unknown"}`, message: "codex_no_tools_cli_startup_unsettled" } };
      }
      return { text: run.text.trim(), ...(run.failure ? { failure: run.failure } : {}), tokens: run.tokens,
        ownerControlTerminal: run.code === 0 && run.turnCompleted && !run.failure && run.text.trim()
          ? "completed" : "uncertain",
        ...(aliveAdmission && run.code === 0 && run.turnCompleted && !run.failure && run.text.trim() && run.threadId
          ? { sessionId: run.threadId } : {}),
        ...(run.observedUsage ? { observedUsage: run.observedUsage } : {}), ...(request.effort ? { appliedEffort: request.effort } : {}) };
    };
    const dependencies = { ...(capacities.length ? { contextWindowTokens: Math.min(...capacities) } : {}) };
    if (!aliveAdmission) return runCodexNoTools({ ...req, effort: effort ?? undefined }, events, executeNoTools, dependencies);
    const aliveRequest = { ...aliveAdmission, effort: effort ?? undefined };
    const profile = aliveDecisionProfileForRequest(aliveRequest)!;
    // The daemon profile alone selects this lane. A native boundary failure
    // cannot retry through ordinary exec after input may have been delivered.
    let residentFingerprint: string;
    try { residentFingerprint = await codexAliveResidentGeneration(bin); }
    catch (error) {
      const code = error instanceof Error && /^codex_alive_[a-z_]+$/u.test(error.message)
        ? error.message : "codex_alive_native_failed";
      return { text: "", ownerControlTerminal: "uncertain", failure: {
        kind: code.endsWith("unsupported") ? "unsupported" : "unavailable", runtime: KIND,
        source: "marker", providerCode: code, message: code } };
    }
    return runCodexAliveNoTools(aliveRequest, events, executeNoTools, {
      ...dependencies, residentFingerprint,
      resident: input => runCodexAliveResidentTurn({ ...input, bin, originalRequest: aliveRequest,
        executionEnv: req.env ?? process.env }, events),
      closeResident: () => closeCodexAliveResidentOwner(profile.resourceOwnerKey),
      verifyResidentResult: (result, nonce, expectedNativeHandle) =>
        consumeCodexAliveResidentResult(result, aliveRequest, nonce, expectedNativeHandle),
    }, req.env);
  }
  if (req.minimalObservation && !req.untrustedNoTools) return runCodexMinimalObservation(bin, req, events, observeNativeFile);

  const stagedImages = await stageCliImageAttachments(req);
  let runReq = stagedImages.images.length > 0 ? { ...req, userPrompt: stagedImages.userPrompt } : req;
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
  // Ordinary turns preserve Codex's own settings and native tools. A
  // Main-authored isolated MCP grant is different: its exact per-run servers
  // must not be widened by provider-global config. This path uses one-shot
  // exec because app-server has no equivalent isolation flag.
  const isolatedConfigArgs = runReq.isolatedMcpConfig ? ["--ignore-user-config"] : [];
  // Unattended and browser-only runs never reach Codex's own desktop control
  // plugins, and no run reaches a browser other than the Agentlas one (bundled
  // chrome/browser plugins, user Playwright-style servers), unless Main granted
  // Computer Use (codex-desktop-surface.ts).
  const hostServerNames = [...new Set(mcpArgs.flatMap((arg) => {
    const m = /^mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)\./.exec(arg);
    return m ? [m[1].replace(/^"|"$/g, "")] : [];
  }))];
  const desktopSurface = codexDesktopSurfaceArgs({
    unattended: runReq.unattended === true,
    browserOnly: runReq.browserOnly === true,
    desktopControlGrant: runReq.desktopControlGrant === true,
    userConfigIgnored: runReq.isolatedMcpConfig === true,
    hostServerNames,
    env: runReq.env ?? process.env,
    cwd: runReq.cwd ?? agentRunCwd(),
  });
  if (desktopSurface.receipt) events.onStatus(desktopSurface.receipt);
  const browserOnlyConfigArgs: string[] = desktopSurface.args;
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
  modelArgs.push("-c", "model_reasoning_summary=auto", "-c", `model_auto_compact_token_limit=${runReq.scienceController ? 150000 : ROOM_AUTO_COMPACT_TOKEN_LIMIT}`);
  let appliedEffort: string | null = null;
  if (runReq.model) modelArgs.push("--model", runReq.model);
  // 모델 캐시의 exact profile을 실행 시점에도 다시 검증한다. 최신 Codex 모델은 max를
  // 지원하지만, 프로필이 없거나 손상된 경우에는 2026-07-12 사고 방지용 max->xhigh
  // legacy guard를 유지한다. 그 외 미지값은 넘기지 않아 기기 설정을 따른다.
  if (runReq.effort || runReq.model) {
    // Read the same account home the child process will use. Main's process env
    // may differ from a runtime-owned CODEX_HOME, and consulting another cache
    // can validate an effort for the wrong account/model catalog.
    // The product mirror links models_cache.json, and the cache reader refuses links: read the account's own file.
    const inventory = await readCodexModelInventory(accountCodexHome(runReq.env?.CODEX_HOME));
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
  const existing = !assertScienceRecoveryRequest(runReq, "codex") && runReq.chatId
    ? getRuntimeSession(runReq.chatId, KIND, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner })
    : null;
  const matchedSessionId =
    existing && fingerprint && existing.fingerprint === fingerprint
      ? existing.sessionId
      : null;
  /*
   * Long-lived room threads rotate at a TURN BOUNDARY (here, before dispatch; a prior turn's recorded health
   * decides, never the current turn). The next turn starts a fresh thread seeded with the goal contract
   * (turnContext) plus a bounded text-only tail of the room, so the old thread's screenshots and tool dumps
   * are not re-read on every call. Caller-managed sessions (Build etc.) are never rotated here.
   */
  const rotation = matchedSessionId && existing && !runReq.runtimeSessionId && !runReq.singleUse
    ? decideSessionRotation({ health: readThreadHealth(matchedSessionId),
      reportedInputTokens: existing.reportedInputTokens })
    : null;
  const storedSessionId = rotation?.rotate ? null : matchedSessionId;
  if (rotation?.rotate && matchedSessionId && runReq.chatId) {
    const rotatedAt = new Date().toISOString();
    const receiptStored = recordRotationReceipt({ schemaVersion: "agentlas.runtime-thread-rotation.v1",
      chatId: runReq.chatId, previousThreadId: matchedSessionId, reasons: rotation.reasons,
      health: readThreadHealth(matchedSessionId), reportedInputTokens: existing?.reportedInputTokens ?? null, rotatedAt });
    events.onStatus(`[runtime-session] rotated kind=${KIND} previous=${matchedSessionId} reasons=${rotation.reasons.join(",")} receipt=${receiptStored ? "stored" : "missing"}`);
    runReq = { ...runReq, history: boundHandoffHistory(runReq.history),
      turnContext: [renderRotationNotice({ previousThreadId: matchedSessionId, reasons: rotation.reasons, locale: runReq.locale }),
        runReq.turnContext].filter(Boolean).join("\n\n") };
  }
  /*
   * Unattended parallel branches share one ledger chat and therefore one stored
   * thread; codex admits one writer per thread. A sibling that finds the stored
   * thread held by another in-flight turn runs fresh instead of attempting the
   * resume that codex would refuse (unattended-session-turns.ts).
   */
  const sessionTurn = claimRuntimeSessionTurn({
    kind: KIND,
    sessionId: runReq.runtimeSessionId ? null : storedSessionId,
    unattended: runReq.unattended,
  });
  try {
  let freshReason: UnattendedFreshSessionReason | null = sessionTurn.contended ? "parallel_turn" : null;
  if (freshReason) events.onStatus(unattendedFreshSessionStatus(KIND, freshReason));
  const resumeSessionId = runReq.runtimeSessionId ?? (freshReason ? null : storedSessionId);
  /** Whether this turn's session may be written back as the chat's durable session. */
  const persistSession = (): boolean => !freshReason || freshSessionReplacesStored(freshReason);
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
   * A startup failure before dispatch may use exec. A dispatched turn without
   * a terminal receipt stays uncertain and must not be replayed automatically.
   */
  if (
    !freshReason &&
    codexAppServerSupported() &&
    !residencyDisabledFor(KIND, runReq.env ?? process.env) &&
    !runReq.untrustedNoTools &&
    !runReq.isolatedMcpConfig &&
    !runReq.ephemeralToolGrant &&
    !runReq.singleUse &&
    runReq.chatId &&
    fingerprint
  ) {
    // gap-replay — 이 스레드가 마지막으로 본 이후 다른 경로로 진행된 턴을 메운다(exec 과 같은 규칙).
    const gapContext = !runReq.runtimeSessionId && storedSessionId && existing
      ? renderGapContext(unseenHistoryGap(runReq.history, existing.updatedAt), runReq.locale)
      : "";
    let attempt: Awaited<ReturnType<typeof runCodexResidentTurn>> = {};
    try {
      attempt = await runCodexResidentTurn({
        bin,
        req: runReq,
        events,
        chatId: runReq.chatId,
        fingerprint,
        resumeThreadId: resumeSessionId ?? null,
        gapContext,
        mcpArgs,
        surfaceArgs: browserOnlyConfigArgs,
        appliedEffort,
        observeNativeFile,
      });
    } catch (err) {
      // thread/resume is refused before any turn starts. An unattended run
      // continues in a fresh one-shot session instead of stopping for a human.
      if (!runReq.unattended || runReq.signal?.aborted || !(err instanceof CodexSessionContinuityError)) throw err;
      freshReason = err.code === "resume_failed" ? classifyCodexResumeFailure(err.message) : "writer_busy";
      events.onStatus(unattendedFreshSessionStatus(KIND, freshReason));
      if (freshSessionReplacesStored(freshReason)) {
        clearRuntimeSession(runReq.chatId, KIND, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner });
      }
    }
    if (attempt.result) return attempt.result;
  }
  if (runReq.workforceRuntimeToolGrant) throw new Error("workforce_codex_observation_no_exec_fallback");
  publishCodexNativeControlState(events, "exec", "unavailable", "native_control_exec_boundary");

  /*
   * 출력 형태 계약 — codex 는 스키마를 **파일 경로**로만 받는다
   * (실측 codex-cli 0.147.0: `--output-schema <FILE>`). 0600 임시 파일에 쓰고
   * 실행이 끝나면 지운다; argv 에 스키마 본문이 남지 않는 부수 효과도 있다.
   */
  const strictOutputSchema = runReq.outputSchema ? openAiStrictSchemaOrNull(runReq.outputSchema.schema) : null;
  const schemaFile = strictOutputSchema
    ? path.join(os.tmpdir(), `agentlas-codex-schema-${process.pid}-${crypto.randomUUID()}.json`)
    : null;
  if (schemaFile && strictOutputSchema) {
    await fs.writeFile(schemaFile, JSON.stringify(strictOutputSchema), { encoding: "utf8", mode: 0o600 });
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
  if (canResume && !freshReason) {
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
    const resumeContext = dedupeStableTurnContext({ chatId: runReq.chatId, runtimeKind: KIND,
      sessionId: resumeSessionId!, contextFingerprint: stableContextFingerprint(runReq, fingerprint,
        [bin, runReq.cwd ?? agentRunCwd(), mcpArgs, browserOnlyConfigArgs, appliedEffort]),
      turnContext: runReq.turnContext, stableBlocks: runReq.turnContextStable });
    // resume 턴: 시스템 프롬프트가 재전송되지 않으므로 gap+턴 컨텍스트를 사용자 메시지에 싣는다.
    let r: CodexRunResult;
    let releaseWriter: (() => void) | undefined;
    try {
      // Codex allows one writer per thread: this process's idle resident session must let go of it first.
      releaseWriter = await prepareCodexExecThreadResume(path.resolve(runReq.cwd ?? agentRunCwd(),
        runReq.env?.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex")), resumeSessionId!, runReq.signal);
      r = await runCodexProcess(
      bin,
      args,
      composeResumeTurnPrompt(
        runReq.userPrompt,
        [gapContext, resumeContext.text].filter(Boolean).join("\n\n"),
        runReq.locale,
      ),
      runReq,
      events,
      usageBaseline,
      observeNativeFile,
      resumeContext.delivery,
      );
    } catch (error) {
      if (runReq.chatId && fingerprint && persistSession()) {
        saveRuntimeSession(runReq.chatId, KIND, resumeSessionId!, fingerprint, {
          agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner,
          reportedOutputTokens: null, reportedInputTokens: null, reportedCachedInputTokens: null,
        });
      }
      throw error;
    } finally {
      releaseWriter?.();
    }
    if (runReq.signal?.aborted) {
      // 취소여도 스레드가 생겼으면 저장 → steering 메시지가 이 세션을 resume해 문맥 유지.
      if (runReq.chatId && fingerprint && r.threadId && persistSession()) {
        saveRuntimeSession(runReq.chatId, KIND, r.threadId, fingerprint, { ...codexUsageCounters(r), agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner });
      }
      throw abortReasonError(runReq);
    }
    if (!r.terminalObserved) {
      if (runReq.chatId && fingerprint && persistSession()) {
        saveRuntimeSession(runReq.chatId, KIND, r.threadId ?? resumeSessionId!, fingerprint, {
          agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner,
          reportedOutputTokens: null, reportedInputTokens: null, reportedCachedInputTokens: null,
        });
      }
      throw new RuntimeTurnUnsettledError(KIND, runReq.locale);
    }
    if (r.code === 0) {
      if (runReq.chatId && fingerprint && r.threadId && persistSession()) {
        if (!saveRuntimeSession(runReq.chatId, KIND, r.threadId, fingerprint, { ...codexUsageCounters(r), agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner })) {
          events.onStatus(`[runtime-session] store_failed kind=${KIND}`);
        }
      }
      events.onStatus(`[runtime-session] resumed kind=${KIND}`);
      return {
        text: r.text.trim(),
        ownerControlTerminal: r.turnCompleted && !r.failure && r.text.trim()
          ? "completed" : "uncertain",
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
    // stdin was dispatched. Neither an empty answer nor a missing started event
    // proves that the failed process made no model/tool call. Preserve the
    // original session and let Main reconcile instead of replaying it fresh.
    return {
      text: r.text.trim(),
      ownerControlTerminal: "uncertain",
      failure: r.failure ?? { kind: "exit", message: `codex CLI exit ${r.code}`, runtime: KIND, source: "exit", ...(r.code != null ? { exitCode: r.code } : {}) },
      sessionId: r.threadId ?? resumeSessionId,
      tokens: r.tokens,
      ...(r.observedUsage ? { observedUsage: r.observedUsage } : {}),
      appliedEffort,
    };
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
  const created = await runCodexProcess(bin, createArgs, buildPrompt(runReq), runReq, events, { output: 0, input: 0, cachedInput: 0 }, observeNativeFile);
  if (runReq.signal?.aborted) {
    if (runReq.chatId && fingerprint && created.threadId && persistSession()) {
      saveRuntimeSession(runReq.chatId, KIND, created.threadId, fingerprint, { ...codexUsageCounters(created), agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner });
    }
    throw abortReasonError(runReq);
  }
  if (!created.terminalObserved) {
    if (runReq.chatId && fingerprint && created.threadId && persistSession()) {
      saveRuntimeSession(runReq.chatId, KIND, created.threadId, fingerprint, {
        agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner,
        reportedOutputTokens: null, reportedInputTokens: null, reportedCachedInputTokens: null,
      });
    }
    throw new RuntimeTurnUnsettledError(KIND, runReq.locale);
  }
  if (created.code === 0) {
    if (runReq.chatId && fingerprint && created.threadId && persistSession()) {
      if (!saveRuntimeSession(runReq.chatId, KIND, created.threadId, fingerprint, { ...codexUsageCounters(created), agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner })) {
        events.onStatus(`[runtime-session] store_failed kind=${KIND}`);
      }
    }
    events.onStatus(`[runtime-session] created kind=${KIND}`);
    return {
      text: created.text.trim(),
      ownerControlTerminal: created.turnCompleted && !created.failure && created.text.trim()
          ? "completed" : "uncertain",
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
      ownerControlTerminal: "uncertain",
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
  } finally {
    sessionTurn.release();
  }
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
