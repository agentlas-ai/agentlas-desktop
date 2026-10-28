import type { DeclaredPromptPart } from "./prompt-order";
import { registerNativeApprovalChildSignal } from "./native-approval-provenance";
// Codex CLI — 감지 + 실호출.
// 사용자의 ChatGPT Plus/Pro 구독으로 돌아간다 (PRD §3.1 6-A).
//
// 호출 형식: codex exec "<prompt>"  (—— Codex CLI의 exec 모드)
// V0는 single-turn; 이전 대화를 user 입력에 inline.
import { prepareRotationHandoff } from "./handoff-facts";
import { reportModelPayload, ledgerFromCliSent, type LedgerHostTurn } from "./model-call-ledger";
import { codexExecFallbackLedgerValue, codexExecFallbackStatus, codexExecTypedFailure, codexTurnErrorFailure,
  codexTurnStartRefusalFailure, codexTurnStartRefusalIsBusy, isCodexContextOverflowFailure, isCodexOutputLimitFailure,
  type CodexExecFallback } from "./codex-turn-failure";
import { OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS, outputLimitContinuationTurn } from "./output-limit-continuation";
import { UNSETTLED_CONTINUATION_PROMPT } from "./unsettled-continuation";
import { recordNativeCompaction } from "./native-compaction-event";
import { createRuntimePlanEmitter, planFromCodexTodoList, planFromCodexTurnPlan } from "./runtime-plan";
import path from "node:path";
import { assertScienceRecoveryRequest } from "../science-host/recovery-authority";
import { RuntimeJudgmentRefusal } from "./judgment-refusal";
import { runCodexNoTools, runCodexAliveNoTools, composeCodexHostInstructions, codexNoToolsModel } from "./codex-no-tools";
import { runCodexAliveResidentTurn, closeCodexAliveResidentOwner,
  codexAliveResidentGeneration, consumeCodexAliveResidentResult } from "./codex-alive-session";
import { aliveDecisionProfileForRequest } from "./alive-decision-context";
import { resolveEffectiveContextWindow } from "../../shared/models";
import { accountCodexHome, adoptCodexThreadIntoProductStore, isIsolatedCodexProductHome, withCodexProductHome } from "./codex-product-home";
import { linkMirrorEntry, reconcileMirrorLinks, reportIsolationUnavailable } from "./mirror-link";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { ToolRequestReplayGuard } from "../../shared/tool-request-replay";
import { createCodexNativeTurnController, probeCodexNativeSteering } from "./codex-native-steering";
import type { ObservedTokenUsage } from "../../shared/observed-usage";
import { StringDecoder } from "node:string_decoder";
import { codexOutputSchemaFallbackBlock, openAiStrictSchemaOrNull } from "./strict-output-schema";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult , RunnerFailure } from "./runner";
import { WORK_PROJECT_RESIDENCY_BUSY_CODE } from "./project-residency";
import { codexShellEnvironmentArgs } from "./env-key-reach";
import { ensureSandboxNpmCacheDir, sandboxNpmCacheDir } from "./sandbox-tool-cache";
import { imageOutputContract } from "./prompt-sections";
import { cumulativeSurfaceGateText, ensureChildCloseAfterExit, startCliHeartbeat, startCliSilenceGuard, runtimeSilentTimeoutFailure, cliSilenceWindowMs, cliToolSilenceWindowMs, type CliSilenceGuard, childExitReason, RUNTIME_SILENT_TIMEOUT_CODE, runtimeProtocolUnrecognizedFailure, wrapSystemPrompt, workforceObservedHostAuthorityEnforcement, RuntimeTurnUnsettledError, markRefusedBeforeDispatch, preDispatchRefusal, spawnStartFailureRefusal } from "./runner";
import { decideTurnSettlement, normalEndToolEvidence, settleNormalEnd, trackReportedToolCalls } from "../../shared/turn-settlement";
import { detectRuntimeRefusal } from "./runtime-refusal";
import { abortReasonError } from "./abort-reason";
import { containsMcpStartupTransportFatal } from "./mcp-startup-fatal";
import {
  cliHistoryContextTokens,
  composeResumeTurnPrompt,
  renderConversationContext,
  renderGapContext,
  unseenHistoryGap, dedupeStableTurnContext, acknowledgeStableTurnContext, invalidateStableTurnContext,
  type StableTurnContextDelivery } from "./continuity";
import { agentContextBootstrapForRequest, agentContextColdBootstrapForRequest, agentContextSessionKey } from "./agent-context";
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
  readThreadHealth, recordThreadTurn,
} from "./session-rotation";
import { decideGeneration, nativeCompactionLimit, recordObservedContextWindow, runtimeContextWindow } from "./session-generation";
import { AcpRpcError, AcpTimeoutError, classifyAcpFailure, createNativeRuntimeDiagnostic, NativeProtocolDiagnostics, NativeTransportDiagnostics, nativeProcessErrorCode } from "./acp-protocol";
import type { NativeEvictionReason, NativeFailureEvidence, NativeProtocolCounters, NativeRuntimeDiagnostic, NativeTurnStartFailure } from "./native-runtime-diagnostics";
import {
  CODEX_APP_SERVER_ARGS,
  CodexModelSelectionError,
  CodexSessionContinuityError,
  acknowledgeCodexThreadModel,
  answerCodexApproval,
  codexApprovalCapability,
  codexAppServerSupported,
  codexMcpThreadConfig,
  codexPoolKey,
  codexProtocolReceipt,
  codexResidentSessionAlive,
  codexResidentThreadState,
  codexSessionPool,
  codexThreadMcpRebindSupported,
  markCodexThreadMcpRebindUnsupported,
  releaseCodexResidentThread,
  isCodexApprovalRequest,
  isCodexMcpElicitationRequest,
  looksLikeMissingAppServer,
  markCodexAppServerUnsupported,
  openCodexResidentSession,
  codexInitializationFailure,
  prepareCodexThreadResume,
  prepareCodexExecThreadResume,
  type CodexResidentSession,
  type CodexTurnSink,
} from "./codex-session";
import { CodexWorkforceObservation, inspectCodexWorkforceGrant, readCodexWorkforceInventory, waitForCodexWorkforceInventory } from "./codex-workforce";
import { answerCodexMcpElicitation } from "./codex-elicitation";
import { residencyDisabledFor } from "./claude-session";
import { codexDesktopSurfaceArgs } from "./codex-desktop-surface";
import { codexPersonalContextArgs, codexPersonalHomeOptions } from "./codex-personal-context";
import { codexBuiltinEgressConfigArgs } from "./runtime-builtin-egress-policy";
import { selectionFor } from "../capabilities/one-capabilities";
import {
  attendedTurnStartsFresh,
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
import { bindScienceNativeToolObserver, bindScienceNativeFailureObserver, bindNativeRuntimeDiagnosticObserver, createAdapterEffectLedger } from "../invocation/adapter-effect-context";
import {
  defaultRuntimeToolPermission,
  getRuntimeToolPermissionArbiter,
  type RuntimeToolPermissionAsk,
} from "./tool-approval";

const KIND = "codex";
/** Longest wait for the compaction turn a context overflow starts (it calls the model to summarize the thread). */
const CODEX_COMPACTION_WAIT_MS = 10 * 60_000;
/** Wait before the one retry of a turn/start refused because another non-steerable turn holds the thread. */
const CODEX_TURN_START_BUSY_RETRY_MS = 2_000;

/**
 * A typed cut (output limit) or overflow of a turn this thread ACCEPTED: the shared decider (docs 31 W1) answers
 * whether it continues in the same session without its request; `budget` is what this runner may still spend.
 */
function continuesSameSession(failure: RunnerFailure, budget: number, unattended: boolean): boolean {
  const decision = decideTurnSettlement({ outcome: "unsettled", delivery: "accepted", kind: failure.kind,
    providerCode: failure.providerCode, unattended, attempt: 0, resumeBudget: Math.max(0, budget), resumable: true });
  return decision.action === "continue-same-session" && !decision.resendOriginal;
}
const CODEX_IMAGE_TOOL_NAME = "generate_image";
const CODEX_IMAGE_TOOL_VERSION = "agentlas.generate-image.v1";

type NativeFileProofObserver = ReturnType<typeof bindNativeFileProofObserver>;
type NativeFileProofInput = Parameters<NativeFileProofObserver>[0];
type NativeFileProofTicket = Exclude<ReturnType<NativeFileProofObserver>, null>;

type CodexDiagnosticInput = Omit<NativeRuntimeDiagnostic, "schemaVersion" | "runtime" | "driver" | "observedAt" | "diagnosticAttemptId" | "sequence">;
/** Observations capture the Main run before initialization, independently of
 * model attempt admission. No payload or optional journal error controls flow. */
function bindCodexRuntimeDiagnostics(req: RunnerRequest, driver: NativeRuntimeDiagnostic["driver"]): (input: CodexDiagnosticInput) => void {
  let observe: (item: unknown) => void = () => {};
  try { observe = bindNativeRuntimeDiagnosticObserver(req); } catch { /* Optional host observer. */ }
  const diagnosticAttemptId = crypto.randomUUID();
  let sequence = 0;
  return input => {
    try {
      if (sequence >= 32) return;
      const diagnostic = createNativeRuntimeDiagnostic({ ...input, driver, diagnosticAttemptId, sequence: ++sequence });
      if (diagnostic) observe(diagnostic);
    } catch { /* Diagnostics are optional and cannot authorize retry or completion. */ }
  };
}
function codexProtocolDelta(current: NativeProtocolCounters, baseline: NativeProtocolCounters): NativeProtocolCounters {
  return Object.freeze(Object.fromEntries(Object.entries(current).map(([key, value]) =>
    [key, Math.max(0, value - baseline[key as keyof NativeProtocolCounters])])) as unknown as NativeProtocolCounters);
}
function codexProcessErrorCode(error: unknown): string | null {
  try { return nativeProcessErrorCode(error); } catch { return null; }
}
/** A busy admission names the reason its first closing blocker is retiring (project-residency.ts), else null. */
function busyAdmissionEvictionReason(error: unknown): NativeEvictionReason | null {
  const blockers = error && typeof error === "object" && "blockers" in error && Array.isArray(error.blockers) ? error.blockers : [];
  const closing = blockers.find((blocker: unknown) => !!blocker && typeof blocker === "object"
    && (blocker as { state?: unknown }).state === "closing") as { closeReason?: unknown } | undefined;
  return codexEvictionReason(closing?.closeReason);
}
function codexEvictionReason(value: unknown): NativeEvictionReason | null {
  return value === "transport-closed" || value === "process-exit" || value === "reaped" || value === "shutdown"
    || value === "evicted" || value === "error" ? value : null;
}
function codexTurnStartFailureCode(failure: NativeFailureEvidence | null): NativeTurnStartFailure["code"] {
  switch (failure?.category) {
    case "rpc-error": return "turn_start_rpc_error";
    case "rpc-timeout": return "turn_start_timeout";
    case "transport-ended": case "child-process-error": return "turn_start_transport_closed";
    default: return "turn_start_unknown";
  }
}
function codexDiagnosticFailure(error: unknown): NativeFailureEvidence {
  try {
    const failure = classifyAcpFailure(error);
    if (failure) return failure;
  } catch { /* Optional host evidence; retain the primary runtime failure. */ }
  return Object.freeze({ category: "unknown", rpcCode: null, timeoutMs: null, requestMethod: null });
}

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
  description: "Generate the requested image. Required for image requests; claim an image only after success=true with inputImage.",
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
  return imageOutputContract(enabled ? CODEX_IMAGE_TOOL_NAME : undefined);
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

/** The `[OUTPUT CONTRACT]` fallback block (empty when the schema rides a strict native channel). It is request-scoped,
 * so it follows the wrapped system sections instead of sitting inside the agent-definition slot. */
function codexSchemaFallbackBlock(req: RunnerRequest): string {
  return codexOutputSchemaFallbackBlock(req);
}

/**
 * A fresh session after a refused resume. A turn that resumed the agent-context layer's native handle carries no
 * history (that session held it), and the layer takes the fresh session as its new handle, so the session starts from
 * the journal with the host facts ahead of it, the same packet a cold ACP or Antigravity session gets
 * (agentContextColdBootstrapForRequest). Any other turn already carries the chat's history.
 */
async function withAgentContextJournalSeed(req: RunnerRequest): Promise<RunnerRequest> {
  const bootstrap = await agentContextColdBootstrapForRequest(req);
  return bootstrap ? { ...req, history: [...bootstrap.history], turnContext: bootstrap.turnContext } : req;
}

function buildPrompt(req: RunnerRequest): string {
  // Composition order: fixed → variable (docs/PROMPT-COMPOSITION-POLICY.md, ledger desktop.main.codex.exec-create.seed).
  const sys = wrapSystemPrompt(
    req.systemPrompt,
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
    codexSchemaFallbackBlock(req) ? [{ id: "transport.codex.output-schema", revision: 1, stability: "task-context", changeTriggers: ["release", "task", "plan-revision"], order: 90, text: codexSchemaFallbackBlock(req) }] : undefined,
      req.systemPromptComposition,
      req.unattendedNoAsk,
  );
  // 새 세션 시드: 턴 컨텍스트는 시스템 섹션 뒤에, 히스토리는 연속성 프레이밍+압축과 함께.
  const turnContext = req.turnContext?.trim();
  const parts: string[] = [`[SYSTEM]\n${sys}${turnContext ? `\n\n${turnContext}` : ""}`, ""];
  if (req.history.length > 0) {
    const { block } = renderConversationContext(req.history, req.locale, cliHistoryContextTokens(KIND, req.model));
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
function buildDeveloperInstructions(req: RunnerRequest, imageContractLine?: string): string {
  // Composition order: fixed → variable (docs/PROMPT-COMPOSITION-POLICY.md, ledger desktop.main.codex.app-server.developer-instructions).
  return wrapSystemPrompt(
    req.systemPrompt,
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
    [
      ...(imageContractLine ? [{ id: "transport.codex.image-contract", revision: 1, stability: "configuration", changeTriggers: ["runtime", "attachments"], text: imageContractLine } as DeclaredPromptPart] : []),
      ...(codexSchemaFallbackBlock(req) ? [{ id: "transport.codex.output-schema", revision: 1, stability: "task-context", changeTriggers: ["release", "task", "plan-revision"], order: 90, text: codexSchemaFallbackBlock(req) } as DeclaredPromptPart] : []),
    ],
      req.systemPromptComposition,
      req.unattendedNoAsk,
  );
}

function buildResidentInitialTurnPrompt(req: RunnerRequest): string {
  const parts: string[] = [];
  if (req.history.length > 0) {
    const { block } = renderConversationContext(req.history, req.locale, cliHistoryContextTokens(KIND, req.model));
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
  // The working folder is always writable; this adds only the product's sandbox npm cache (sandbox-tool-cache.ts).
  "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([sandboxNpmCacheDir()])}`,
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
    // The system `ask:` module is left out for RunnerRequest.unattendedNoAsk (team workers): a thread seeded with it is another conversation.
    .update(req.unattendedNoAsk ? "\0unattended-no-ask" : "")
    .digest("hex");
}

/** Context delivery is narrower than native conversation continuity (which survives model changes). */
function stableContextFingerprint(req: RunnerRequest, fingerprint: string | null, configuration: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify([fingerprint, req.runtimeSessionOwnerId ?? req.agentId ?? null,
    req.runtimeSessionOwnerId != null, req.systemPrompt, req.locale, req.permission, req.approvalsReviewer,
    req.model, req.effort, req.forceSurface, req.browserOnly, req.isolatedMcpConfig,
    // Per-invocation materialized files (agentlas-mcp-invocation-<id>.json, broker settings) are left out: their
    // names change every turn, which made every stable block look new and resent it on all 62 measured turns.
    // The servers the thread actually runs are identified by the Codex MCP args inside `configuration`.
    req.mcpAllowedTools, req.env?.CODEX_HOME, configuration])).digest("hex");
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
  /** Distinct tool calls this exec turn reported (settleNormalEnd evidence, R-065). */
  toolCalls: number;
}

/**
 * An exec run that exited non-zero without emitting a single event (no thread.started, no turn event, no text): codex
 * stopped before it created or resumed the session, so the turn never reached the model. That is a refusal before
 * dispatch (RuntimeTurnDelivery "not-dispatched", runner.ts) with the CLI's own words, never an unsettled turn: no
 * continuation re-sends it and a graph step fails typed instead of being held as a possible side effect (docs 31 W1;
 * W7 acceptance S-graph-two-steps, 2026-10-16: a refused turn/start, then a refused exec, ended MUTATION_UNVERIFIED).
 */
/**
 * The settlement of an exec turn that exited 0 with a completed turn and no failure: the shared normal-end rule (R-065,
 * shared/turn-settlement.ts). With text or a tool call it completed (a tool-only turn carries its tool count); with
 * neither it is the typed "empty" failure. Any other exec end stays uncertain with its own failure.
 */
function codexExecSettlement(run: CodexRunResult): Pick<RunnerResult, "ownerControlTerminal" | "failure" | "toolCalls"> {
  if (run.code !== 0 || !run.turnCompleted || run.failure) {
    return { ownerControlTerminal: "uncertain", ...(run.failure ? { failure: run.failure } : {}) };
  }
  const end = settleNormalEnd({ text: run.text, toolCalls: run.toolCalls });
  if (end.outcome === "empty") {
    return { ownerControlTerminal: "uncertain",
      failure: { kind: "empty", message: run.stderr.slice(-500) || "codex exec returned no message", runtime: KIND, source: "marker" } };
  }
  return { ownerControlTerminal: "completed", ...normalEndToolEvidence(end) };
}

function codexExecRefusedBeforeTurn(run: CodexRunResult): RunnerResult | null {
  if (run.terminalObserved || run.turnStarted || run.threadId !== null || run.text.trim()
    || typeof run.code !== "number" || run.code === 0) return null;
  return { text: "", turnDelivery: "not-dispatched", failure: run.failure ?? { kind: "exit", runtime: KIND, source: "exit",
    providerCode: "codex_exec_refused_before_turn", exitCode: run.code,
    message: childExitReason(run.code, run.stderr) ?? `codex CLI exit ${run.code}` } };
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
    return codexExecTypedFailure(message) ?? { kind: "exit", message, runtime: "codex", source: "marker" };
  }
  if (ev.type === "turn.failed") {
    const message = typeof ev.error?.message === "string" && ev.error.message.trim()
      ? ev.error.message.trim().slice(0, 2000) : "codex turn failed";
    // exec carries no codexErrorInfo: only the output cap and the context window are typed here (codex-turn-failure.ts).
    return codexExecTypedFailure(message) ?? { kind: "exit", message, runtime: "codex", source: "marker" };
  }
  return null;
}

/**
 * True when a `codex exec --json` line has a protocol shape this adapter understands: thread.started with a string id,
 * turn.started/failed, turn.completed with absent-or-object usage, item.started/completed with a typed item object,
 * or a rollout-style event_msg/response_item carrying a typed payload. Wrong-shape JSON is not an event.
 */
export function codexExecEventRecognized(ev: unknown): boolean {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return false;
  const e = ev as { type?: unknown; thread_id?: unknown; usage?: unknown; item?: unknown; payload?: unknown };
  const typed = (v: unknown): boolean => Boolean(v) && typeof v === "object" && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string";
  switch (e.type) {
    case "thread.started": return typeof e.thread_id === "string";
    case "turn.started":
    case "turn.failed": return true;
    case "turn.completed": return e.usage === undefined || (Boolean(e.usage) && typeof e.usage === "object");
    case "item.started":
    case "item.completed": return typed(e.item);
    case "event_msg":
    case "response_item": return typed(e.payload);
    default: return false;
  }
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
  /** Tool calls this turn reported: a completed tool-only turn is a completed answer too (R-065). */
  toolCalls?: number;
}): RunnerFailure | null {
  if (input.terminalFailure) return input.terminalFailure;
  if (input.code === 0 && input.turnCompleted && input.text.trim()) return null;
  // The text is empty here. A completed turn that worked through its tools is complete (shared settleNormalEnd, R-065): a
  // recoverable item diagnostic is not its failure. A typed item cause (codexExecTypedFailure: the output cap, the context
  // window, an incomplete response) is never swallowed. Self-contained: gates extract this function on its own.
  if (input.code === 0 && input.turnCompleted && (input.toolCalls ?? 0) > 0 && !input.itemFailure?.providerCode) return null;
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
  // Every CodexErrorInfo of the installed schema has a kind and a providerCode (codex-turn-failure.ts, audit A1 C8.1).
  return codexTurnErrorFailure(turn.error);
}

/** True when the host itself ended this exec attempt for total silence (single close-based settlement). */
function isSilentTimeoutRun(run: { failure?: RunnerFailure }): boolean {
  return run.failure?.providerCode === RUNTIME_SILENT_TIMEOUT_CODE;
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
  /** Typed ledger facts of this attempt: a host continuation turn, or why it runs on exec instead of the app-server. */
  ledgerFacts: { hostTurn?: LedgerHostTurn; transportFallback?: string } = {},
): Promise<CodexRunResult> {
  const diagnose = bindCodexRuntimeDiagnostics(req, "exec");
  const effects = createAdapterEffectLedger({ adapterKind: KIND, chatId: req.chatId, agentId: req.agentId }, events);
  // Tool-call evidence of this exec turn for the shared normal-end rule (R-065).
  const toolEvidence = trackReportedToolCalls(effects.events);
  events = toolEvidence.events;
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
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: req.env ?? process.env,
        // 사용자가 지정한 프로젝트 폴더에서 실행 — 미지정이면 전용 폴더.
        cwd: req.cwd ?? agentRunCwd(),
        ...detachedSpawnOpts(),
      });
    } catch (error) {
      diagnose({ phase: "process-error", runtimeAttemptId: null, transport: null, protocol: null, protocolScope: null,
        terminal: { accepted: false, threadMismatch: 0, turnMismatch: 0, earlyOverflow: 0 },
        failure: { category: "child-process-error", rpcCode: null, timeoutMs: null, requestMethod: null } });
      // spawn() throws the errnos it does not report as an event (ENOTDIR, EPERM...): no process, nothing ran.
      throw spawnStartFailureRefusal(null, error, { runtimeKind: KIND, cwd: req.cwd ?? agentRunCwd(), locale: req.locale }) ?? error;
    }
    let transportDiagnostics: NativeTransportDiagnostics | null = null;
    let protocolDiagnostics: NativeProtocolDiagnostics | null = null;
    try {
      transportDiagnostics = new NativeTransportDiagnostics();
      protocolDiagnostics = new NativeProtocolDiagnostics();
    } catch { /* Optional collectors cannot prevent admitted child control. */ }
    const incrementDiagnosticCounter = (key: keyof NativeProtocolCounters): void => {
      try { protocolDiagnostics?.increment(key); } catch { /* Optional observation. */ }
    };
    trackRunChild(child);
    // ★호스트 소유 생존 신호 — 러너 공통 규칙(runner.ts startCliHeartbeat 주석 참고).
    const stopHeartbeatOnly = startCliHeartbeat(child, events.onStatus, "codex");
    // ★호스트 소유 침묵 한도(runner.ts startCliSilenceGuard 참고): 자식이 낸 바이트/이벤트만 센다.
    // 가드는 트리만 죽이고, 아래 close 핸들러가 유일한 정산 경로로 timeout 실패를 만든다.
    const silenceWindowMs = cliSilenceWindowMs(req.env ?? process.env);
    const silence = startCliSilenceGuard(child, {
      label: "codex", onStatus: events.onStatus, windowMs: silenceWindowMs, kill: () => killCliTree(child),
    });
    const stopHeartbeat = (): void => { stopHeartbeatOnly(); silence.stop(); };
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
    // Context-reduction C01: exec resume sends only a delta; a fresh exec seeds [SYSTEM]+history+context+owner text.
    const execResume = args.includes("resume");
    reportModelPayload(() => ledgerFacts.hostTurn
      ? ledgerFromCliSent({ mode: "resume", sentText: stdinPayload, req: { ...req, userPrompt: "", images: undefined }, ...ledgerFacts })
      : ledgerFromCliSent({ mode: execResume ? "resume" : "fresh", sentText: stdinPayload, req,
        instructionsInSentText: !execResume && stdinPayload.startsWith("[SYSTEM]"), historyInSentText: !execResume && stdinPayload.startsWith("[SYSTEM]"),
        ...ledgerFacts }));
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
    /** `codex exec --json` lines of a shape this adapter understands; zero + exit 0 = runtime_protocol_unrecognized. */
    let recognizedExecEvents = 0;
    let terminalObservationFailed = false;
    let terminalObservationError: unknown;
    const observeTerminalCallback = (observe: () => void): void => {
      try { observe(); }
      catch (error) {
        if (!terminalObservationFailed) terminalObservationError = error;
        terminalObservationFailed = true;
        incrementDiagnosticCounter("handlerErrors");
        effects.uncertain("native-terminal-observation-failed");
      }
    };
    const emitProcessDiagnostic = (phase: NativeRuntimeDiagnostic["phase"], failure: NativeFailureEvidence | null = null): void => {
      try {
        const protocol = protocolDiagnostics?.snapshot() ?? null;
        diagnose({ phase, runtimeAttemptId, transport: transportDiagnostics?.snapshot() ?? null, protocol, protocolScope: protocol ? "attempt" : null,
          terminal: { accepted: terminalObserved, threadMismatch: 0, turnMismatch: 0, earlyOverflow: 0 }, failure });
      } catch { /* Optional content-free observation. */ }
    };
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
      silence.toolEnd(id);
      events.onTool?.(pending.name, pending.args, result, id, isError, artifactPaths);
    };
    const latestUnsettledResponseTool = (name?: string): string | null => {
      const candidates = [...responseTools.entries()].reverse();
      for (const [id, pending] of candidates) {
        if (!settledResponseToolIds.has(id) && (!name || pending.name === name)) return id;
      }
      return null;
    };
    const emitExecPlan = createRuntimePlanEmitter(events.onPlan);
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
      if (codexExecEventRecognized(ev)) recognizedExecEvents += 1;
      if (typeof ev.type === "string" && ev.type !== "thread.started") turnStarted = true;
      const payload = record(ev.payload);
      const execCompactionSeen = ev.type === "compacted" || ev.type === "thread.compacted"
        || payload?.type === "context_compaction" || payload?.type === "context_compacted" || payload?.type === "compacted"
        || ["contextCompaction", "context_compaction", "compaction"].includes(String(ev.item?.type ?? ""));
      if (execCompactionSeen) {
        const retainedIdentity = stableContextDelivery?.identity ?? (threadId ? {
          chatId: req.agentContext ? agentContextSessionKey(req.agentContext) : req.chatId, runtimeKind: KIND, sessionId: threadId,
        } : null);
        if (retainedIdentity) invalidateStableTurnContext(retainedIdentity, true);
      }
      // G17: exec path records the occurrence too (item completion or the bare notice; item.started is not one).
      if (execCompactionSeen && ev.type !== "item.started") recordNativeCompaction({
        runtime: "codex", chatId: req.chatId, model: req.model, signal: String(payload?.type ?? ev.type ?? "unknown"),
        nativeRef: ev.item?.id != null ? String(ev.item.id) : null,
        configuredWindowLimit: nativeCompactionLimit(KIND, req.model) ?? null });
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
          silence.toolStart(id);
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
      } else if ((ev.type === "item.started" || ev.type === "item.updated" || ev.type === "item.completed")
        && ev.item?.type === "todo_list") {
        // The model's own checklist (exec serializes update_plan as a todo_list item); structured fields only.
        emitExecPlan(planFromCodexTodoList(ev.item));
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
        // A failed command keeps its exit code after the output, in Claude Code's form, so the code is a fact the host
        // (sandbox-death.ts) and the model can read: a Blender that crashed with 139 inside the workspace-write sandbox
        // printed output, and the output alone hid the exit status.
        const failedExit = typeof item.exit_code === "number" && item.exit_code !== 0 ? `\n[exited with code ${item.exit_code}]` : "";
        const resultText =
          ev.type === "item.completed"
            ? resultPayload != null
              ? `${truncateUi(stringifyPayload(resultPayload))}${failedExit}`
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
        // 시작만 보고된 도구는 침묵이 아니다(긴 렌더·빌드) — 완료 때까지 침묵 한도 정지.
        if (ev.type === "item.started") silence.toolStart(item.id); else silence.toolEnd(item.id);
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
        // Native facts and measured counters survive a host callback failure.
        // Those callbacks may enforce authority/accounting; reject after cleanup.
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
        const turnCached = deltaFromBaseline(reportedCachedInputTokens, usageBaseline.cachedInput);
        observeTerminalCallback(closeThinking);
        if (tokens != null) observeTerminalCallback(() => events.onUsage?.(tokens!));
        if (observedUsage) observeTerminalCallback(() => events.onTerminalObservedUsage?.(observedUsage!, runtimeAttemptId));
        if (turnInput != null && turnInput > 0 && turnCached != null) {
          // Cached input is a measured subset of input and is retained in the receipt.
          observeTerminalCallback(() => events.onStatus(`[cache] read=${turnCached} fresh=${turnInput - turnCached} hit=${Math.round((turnCached / turnInput) * 100)}%`));
        }
      }
    };

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const consumeStdout = (textChunk: string, flushFinalFrame = false) => {
      buffer += textChunk;
      let nl: number;
      // A physical close ends the final JSONL record even when the CLI omitted
      // its last LF. Feed that existing record through the same parser and
      // terminal guards; ordinary data chunks must still wait for a delimiter.
      while ((nl = buffer.indexOf("\n")) >= 0 || (flushFinalFrame && buffer.trim().length > 0)) {
        incrementDiagnosticCounter("lines");
        const end = nl >= 0 ? nl : buffer.length;
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + (nl >= 0 ? 1 : 0));
        if (!line) continue;
        let frame: unknown;
        try { frame = JSON.parse(line); }
        catch {
          incrementDiagnosticCounter("invalidJson");
          effects.uncertain("native-json-frame-invalid");
          continue;
        }
        incrementDiagnosticCounter("parsed");
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) incrementDiagnosticCounter("invalidShape");
        else if (typeof (frame as { type?: unknown }).type === "string") incrementDiagnosticCounter("notifications");
        try {
          handle(frame as Parameters<typeof handle>[0]);
        } catch {
          incrementDiagnosticCounter("handlerErrors");
          // 비-JSON 라인(헤더 등) 무시
          effects.uncertain("native-json-frame-invalid");
        }
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => { silence.touch(); consumeStdout(stdoutDecoder.write(chunk)); });
    child.stdout?.on("end", () => {
      try { transportDiagnostics?.transportEnded("stdout-end"); } catch { /* Optional observation. */ }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      silence.touch();
      try { transportDiagnostics?.addStderr(chunk); } catch { /* Preserve the existing decoder. */ }
      stderr += stderrDecoder.write(chunk);
    });

    child.on("error", (err) => {
      try { transportDiagnostics?.childError(codexProcessErrorCode(err)); } catch { /* Mandatory rejection follows. */ }
      emitProcessDiagnostic("process-error", { category: "child-process-error", rpcCode: null, timeoutMs: null, requestMethod: null });
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      stopHeartbeat();
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      req.signal?.removeEventListener("abort", onAbort);
      if (stableContextDelivery) invalidateStableTurnContext(stableContextDelivery.identity);
      // A child that never got a pid never started (ENOENT, EACCES, EMFILE, a deleted working folder): nothing was sent.
      const notStarted = req.signal?.aborted || terminalObservationFailed ? null
        : spawnStartFailureRefusal(child, err, { runtimeKind: KIND, cwd: req.cwd ?? agentRunCwd(), locale: req.locale });
      try { effects.complete(notStarted ? "not_dispatched" : "process_error", notStarted !== null); }
      catch (error) {
        reject(req.signal?.aborted ? abortReasonError(req) : terminalObservationFailed ? terminalObservationError : error);
        return;
      }
      reject(req.signal?.aborted ? abortReasonError(req) : terminalObservationFailed ? terminalObservationError : notStarted ?? new RuntimeTurnUnsettledError(KIND, req.locale));
    });
    child.on("close", (code, signal) => {
      // Pipe chunks can split a Korean UTF-8 code point. Decoding them
      // independently turns the split bytes into permanent U+FFFD in One.
      consumeStdout(stdoutDecoder.end(), true);
      stderr += stderrDecoder.end();
      try { transportDiagnostics?.childClosed(code, signal); } catch { /* Mandatory cleanup follows. */ }
      emitProcessDiagnostic("process-closed", terminalObservationFailed ? codexDiagnosticFailure(terminalObservationError) : null);
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      stopHeartbeat();
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      req.signal?.removeEventListener("abort", onAbort);
      if (buffer.trim()) effects.uncertain("native-trailing-frame-unparsed");
      try { effects.complete("process_closed", terminalObserved && code !== null && !req.signal?.aborted); }
      catch (error) {
        if (stableContextDelivery) invalidateStableTurnContext(stableContextDelivery.identity);
        reject(req.signal?.aborted ? abortReasonError(req) : terminalObservationFailed ? terminalObservationError : error);
        return;
      }
      if (terminalObservationFailed) {
        if (stableContextDelivery) invalidateStableTurnContext(stableContextDelivery.identity);
        reject(req.signal?.aborted ? abortReasonError(req) : terminalObservationError);
        return;
      }
      let runnerFailure = resolveCodexRunFailure({
        code,
        text,
        turnCompleted,
        terminalFailure,
        itemFailure,
        toolCalls: toolEvidence.count(),
      });
      /*
       * ★표식 없이 완주(exit 0)했는데 산출물이 거절 고지문인 경우 — 실측: codex 한도는
       * 거절문이 agent_message로 오고 turn.completed(표식 0). 이 한 자리에서만 텍스트
       * 판별을 허용하고 출처를 heuristic으로 남긴다(규칙은 runtime-refusal.ts 한 곳).
       */
      // ★침묵 한도로 호스트가 끝낸 시도 — 이 close가 유일한 정산이다. 사용자 취소는 건드리지 않는다.
      if (silence.tripped && !req.signal?.aborted && !terminalObserved) {
        runnerFailure = runtimeSilentTimeoutFailure("codex", silence.trippedWith?.limitMs ?? silenceWindowMs, { toolInFlight: silence.trippedWith?.toolInFlight === true });
      }
      if (code === 0 && !runnerFailure && recognizedExecEvents === 0 && !text.trim()) {
        runnerFailure = runtimeProtocolUnrecognizedFailure("codex", stderr);
      }
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
        toolCalls: toolEvidence.count(),
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
        // Plus the product's sandbox npm cache, so `npm install` works in the project (sandbox-tool-cache.ts).
        writableRoots: [writableRoot, sandboxNpmCacheDir()],
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
          ? (asText(item.aggregatedOutput) !== undefined
            ? `${asText(item.aggregatedOutput)}${typeof item.exitCode === "number" && item.exitCode !== 0 ? `\n[exited with code ${item.exitCode}]` : ""}`
            : (typeof item.exitCode === "number" ? `exit ${item.exitCode}` : String(item.status ?? "completed")))
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

/**
 * Native turns and child threads that earlier runner turns of one resident app-server owned (flow audit 2026-10-18 AD-10).
 * A reused process can still stream an earlier turn's late frames (its background terminal's output, a sub-agent thread it
 * spawned); they used to make the next turn's effect boundary uncertain (native-child-or-other-turn-uncovered with
 * native-frame-uncovered, about 75 boundaries 10-02..10-10). Such a frame belongs to the earlier turn, whose boundary has
 * already closed. Only a frame proven to be that residue is set aside; an unknown thread or turn stays uncovered.
 */
export interface CodexPriorTurnOwnership { turnIds: Set<string>; threadIds: Set<string>; }
const codexPriorTurnOwnership = new WeakMap<object, CodexPriorTurnOwnership>();
const CODEX_PRIOR_OWNERSHIP_LIMIT = 256;
function rememberCodexOwnership(set: Set<string>, id: string): void {
  if (!id || id.length > 256) return;
  set.delete(id);
  set.add(id);
  while (set.size > CODEX_PRIOR_OWNERSHIP_LIMIT) set.delete(set.values().next().value!);
}
/** Child thread ids an item names: codex 0.163 collabAgentToolCall.receiverThreadIds (spawn: the new agent) and subAgentActivity.agentThreadId. */
export function codexChildThreadIds(item: any): string[] {
  if (!item || typeof item !== "object") return [];
  const valid = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 256;
  if (item.type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds)) return item.receiverThreadIds.filter(valid).slice(0, 64);
  if (item.type === "subAgentActivity" && valid(item.agentThreadId)) return [item.agentThreadId];
  return [];
}
/**
 * A frame an earlier runner turn on this reused process owns: on this turn's thread, a turn id an earlier runner turn
 * owned; on another thread, a child (or former) thread an earlier turn owned that this turn has not itself addressed.
 */
export function codexPriorTurnResidue(params: any, threadId: string | null | undefined, prior: CodexPriorTurnOwnership | undefined,
  currentChildren: ReadonlySet<string>): boolean {
  // Without this turn's own thread there is nothing to attribute against: every frame keeps its present handling.
  if (!prior || !threadId || typeof params?.threadId !== "string" || !params.threadId) return false;
  if (params.threadId === threadId) return typeof params.turnId === "string" && prior.turnIds.has(params.turnId);
  return prior.threadIds.has(params.threadId) && !currentChildren.has(params.threadId);
}

interface ResidentTurnOutcome {
  /** 완주했다 — 이 결과를 그대로 돌려준다(성공이든 표식 실패든). */
  result?: RunnerResult;
  /**
   * 화면에 아무것도 나가지 않았다 — 이 턴을 1회성 exec 경로로 **한 번** 다시 시도한다. Typed (R-070): the caller records the
   * downgrade as a receipt and in the exec attempt's ledger row, so it is never silent.
   */
  retryOneShot?: CodexExecFallback;
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
  /** The turn's grant dies with it: the app-server process is this turn's alone and is closed at its end. */
  turnScopedProcess?: boolean;
}): Promise<ResidentTurnOutcome> {
  const { bin, req, chatId, fingerprint, resumeThreadId, gapContext, mcpArgs, appliedEffort, observeNativeFile } = input;
  const turnScoped = input.turnScopedProcess === true;
  const diagnose = bindCodexRuntimeDiagnostics(req, "app-server");
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
  // Native compaction at 80% of the model's own window (session-generation.ts), Science included; unknown window keeps Codex's default.
  const compactLimit = nativeCompactionLimit(KIND, req.model);
  const pool = codexSessionPool();
  /*
   * Process identity. The invocation's MCP servers ride thread config on a resident keyed by the grant (the server
   * names; codex-session.ts codexMcpThreadConfig), so an owner's follow-up reuses the warm process and rebinds its own
   * servers before turn/start. Spawn arguments used to carry them, and every invocation mints new launch handles and
   * capability files, so every turn got a new key (production 10-13..16: 374 spawns, 4 reuses). A turn-scoped process
   * (its grant dies with it) and a Workforce observation (which proves its exact argv) keep the spawn-argument form, as
   * does an executable that refused thread/unsubscribe.
   */
  const residentIdentity = () => {
    const mcpThread = !turnScoped && !req.workforceRuntimeToolGrant && codexThreadMcpRebindSupported()
      ? codexMcpThreadConfig(mcpArgs, env) : null;
    const args = [...CODEX_APP_SERVER_ARGS, "-c", "model_reasoning_summary=auto", ...(compactLimit ? ["-c", `model_auto_compact_token_limit=${compactLimit}`] : []),
      ...surfaceArgs,
      // ChatGPT apps where this thread's approvals reach the Agentlas arbiter or under full access (runtime-builtin-egress-policy.ts).
      ...codexBuiltinEgressConfigArgs({ approvalsReachArbiter: policy.approvalPolicy === "on-request" && approvalsReviewer === "user", fullAccess: req.permission === "full" }),
      ...(mcpThread ? [] : mcpArgs)];
    const poolKey = codexPoolKey({
      // A turn-scoped process is never checked out by another turn.
      chatId: `${canonicalContextKey ?? req.approvalChatId ?? chatId}${turnScoped ? `#turn:${crypto.randomUUID()}` : ""}`,
      fingerprint,
      sessionOwnerId: runtimeSessionOwnerId ?? null,
      isolateOwner: isolateRuntimeSessionOwner,
      cwd,
      bin,
      ...(mcpThread ? { mcpGrant: mcpThread.grant, omitEnv: mcpThread.inlinedEnvNames }
        : req.mcpConfigPath ? { mcpConfigPath: req.mcpConfigPath } : {}),
      ...(req.toolBrokerSettingsPath ? { toolBrokerSettingsPath: req.toolBrokerSettingsPath } : {}),
      args,
      env,
    });
    return { mcpThread, args, poolKey };
  };
  let identity = residentIdentity();

  const acquireResident = async (): Promise<AcpSessionLease<CodexResidentSession> | ResidentTurnOutcome> => {
    const { args, poolKey } = identity;
    try {
      return await pool.acquire(
        poolKey,
        {
          agentId: req.agentId ?? null,
          nodeId: req.orchestrationAgentId ?? req.agentId ?? null,
          chatId,
          // The same journal key the pool key above holds: the registry releases a shared session by it (agent-residency.ts).
          ...(canonicalContextKey && !turnScoped ? { sessionScopeKey: canonicalContextKey } : {}),
          projectId: req.workProjectId ?? null,
          runtimeKind: KIND,
          source: resolveAgentResidencySource(req.agentId),
          reaperExempt: isResidencyExemptAgent(req.agentId),
          ...(req.signal ? { signal: req.signal } : {}),
        },
        () => openCodexResidentSession({ bin, args, cwd, env, label: req.backendLabel || "codex" }),
      );
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === WORK_PROJECT_RESIDENCY_BUSY_CODE) {
        // Attributable refusal: the turn never started and no session was leased (no prose, no paths).
        diagnose({ phase: "turn-start-failed", runtimeAttemptId: null, transport: null, protocol: null, protocolScope: null,
          terminal: { accepted: false, threadMismatch: 0, turnMismatch: 0, earlyOverflow: 0 }, failure: null,
          turnStart: { code: WORK_PROJECT_RESIDENCY_BUSY_CODE, transportState: "not-opened", evictionReason: busyAdmissionEvictionReason(err) } });
        throw err;
      }
      const initialization = codexInitializationFailure(err);
      if (initialization) diagnose({ phase: "initialize-failed", runtimeAttemptId: null,
        transport: initialization.transport, protocol: initialization.protocol, protocolScope: initialization.protocol ? "attempt" : null,
        terminal: { accepted: false, threadMismatch: 0, turnMismatch: 0, earlyOverflow: 0 }, failure: initialization.failure });
      // 구형 CLI 는 `app-server` 하위 명령 자체가 없다 — 프로세스 수명 동안 1회 학습해 영구 강등.
      if (looksLikeMissingAppServer("", err)) {
        markCodexAppServerUnsupported(err instanceof Error ? err.message : String(err));
        events.onStatus(`[residency] disabled kind=${KIND} reason=app-server-unsupported`);
      }
      if (req.workforceRuntimeToolGrant) throw err;
      return { retryOneShot: { reason: "app_server_start_failed" } };
    }
  };

  const acquired = await acquireResident();
  if (!("session" in acquired)) return acquired;
  let lease: AcpSessionLease<CodexResidentSession> = acquired;
  /*
   * Reuse preflight, before anything of this turn reaches the process. Paseo checks thread/loaded/list before reusing a
   * thread and drops a dead handle itself; here a handle that cannot answer (dead, wedged, malformed) is discarded and
   * this turn opens a fresh process. A thread Codex no longer has loaded is resumed instead of sent a turn/start. When
   * the thread runs another invocation's MCP table (its launch handles and capability files were revoked when that
   * invocation ended), the subscription is released so the thread/resume below reloads it with this turn's table; a
   * model change forks instead, and the fork carries the table. A process whose rebind cannot be confirmed never takes
   * the turn.
   */
  let rebindThread = false;
  /** The thread this process held, still subscribed, that a model-change fork leaves behind (released after the fork). */
  let forkSourceToRelease: string | null = null;
  if (!lease.fresh && lease.session.threadId) {
    const held = lease.session;
    const heldThreadId = held.threadId!;
    const heldModelChanged = Boolean(req.model && held.modelAcknowledgement?.requestedModel !== req.model);
    const tableChanged = Boolean(identity.mcpThread && held.mcpConfigDigest !== identity.mcpThread.digest);
    let dropReason: string | null = null;
    try {
      if (!codexResidentSessionAlive(held)) throw new Error("codex_resident_dead");
      const state = await codexResidentThreadState(held, heldThreadId, { ...(req.signal ? { signal: req.signal } : {}) });
      if (state === "not-loaded") {
        rebindThread = true;
      } else if (tableChanged) {
        const forks = heldModelChanged && !req.runtimeSessionId;
        const resumesOther = Boolean(req.runtimeSessionId && req.runtimeSessionId !== heldThreadId);
        if (forks) {
          forkSourceToRelease = heldThreadId;
        } else if (resumesOther) {
          // The named thread loads with this turn's table; the one this process held is released for Codex to unload.
          forkSourceToRelease = heldThreadId;
        } else {
          const released = await releaseCodexResidentThread(held, heldThreadId, { ...(req.signal ? { signal: req.signal } : {}) });
          if (released === "unsupported") {
            markCodexThreadMcpRebindUnsupported();
            dropReason = "rebind_unsupported";
          } else {
            // No longer subscribed: only a thread/resume (which re-subscribes) may follow, never a bare turn/start.
            held.mcpConfigDigest = null;
            rebindThread = true;
          }
        }
      }
    } catch {
      dropReason = "unverified";
    }
    if (req.signal?.aborted) {
      // A Stop during the preflight: nothing of this turn was sent; a process that answered is returned intact.
      if (dropReason) pool.discard(lease, "shutdown"); else pool.release(lease);
      throw abortReasonError(req);
    }
    if (dropReason) {
      pool.discard(lease, "error");
      events.onStatus(`[residency] resident_dropped kind=${KIND} reason=${dropReason}`);
      rebindThread = false;
      forkSourceToRelease = null;
      if (dropReason === "rebind_unsupported") identity = residentIdentity();
      const reopened = await acquireResident();
      if (!("session" in reopened)) return reopened;
      lease = reopened;
    }
  }
  const mcpThread = identity.mcpThread;

  const session = lease.session;
  // Parsing counters belong to the pooled connection. Subtract this checkout's
  // baseline; stderr/child-close facts retain explicit connection lifetime.
  let protocolBaseline: NativeProtocolCounters | null = null;
  try { protocolBaseline = session.conn.diagnosticSnapshot().protocol; } catch { /* Optional observation. */ }
  const effects = createAdapterEffectLedger({ adapterKind: KIND, chatId: req.chatId, agentId: req.agentId }, events);
  events = effects.events;
  const observeScienceTool = bindScienceNativeToolObserver(req, effects.qualify);
  const observeScienceFailure = bindScienceNativeFailureObserver(req, effects.qualify);
  // AD-10: what earlier runner turns on this process owned, and what this turn owns (recorded for the next one in finally).
  const priorOwnership = codexPriorTurnOwnership.get(session);
  const turnChildThreads = new Set<string>();
  const ownedTurnIds = new Set<string>();
  let priorTurnFrames = 0;
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
  /** The client user message id this turn was sent with (schema-proven), and whether the session echoed it back. */
  let sentClientUserMessageId: string | null = null;
  let requestEchoed = false;
  let terminalObserved = false;
  let terminalSucceeded = false;
  let terminalObservationFailed = false;
  let terminalObservationError: unknown;
  let primaryError: { error: unknown } | null = null;
  const observeTerminalCallback = (observe: () => void): void => {
    try { observe(); }
    catch (error) {
      if (!terminalObservationFailed) terminalObservationError = error;
      terminalObservationFailed = true;
      broken = true;
      effects.uncertain("native-terminal-observation-failed");
    }
  };
  /** One host-minted id per native turn: a host continuation turn (output limit, context overflow) is its own attempt. */
  let runtimeAttemptId = crypto.randomUUID();
  let diagnosticRuntimeAttemptId: string | null = null;
  let diagnosticFailure: NativeFailureEvidence | null = null;
  const terminalDiagnostics = { threadMismatch: 0, turnMismatch: 0, earlyOverflow: 0 };
  const emitResidentDiagnostic = (phase: NativeRuntimeDiagnostic["phase"], failure: NativeFailureEvidence | null = diagnosticFailure,
    turnStart?: (transport: NativeRuntimeDiagnostic["transport"]) => NativeTurnStartFailure): void => {
    try {
      const snapshot = session.conn.diagnosticSnapshot();
      diagnose({ phase, runtimeAttemptId: diagnosticRuntimeAttemptId, transport: snapshot.transport,
        protocol: protocolBaseline ? codexProtocolDelta(snapshot.protocol, protocolBaseline) : null,
        protocolScope: protocolBaseline ? "connection-delta" : null,
        terminal: { accepted: terminalObserved, ...terminalDiagnostics }, failure,
        ...(turnStart ? { turnStart: turnStart(snapshot.transport) } : {}) });
    } catch { /* Optional content-free observation. */ }
  };
  let transportDiagnosticObserved = false;
  let nativeThreadCreated = false;
  let turnUsageBaseline: CodexUsageBaseline = { input: null, output: null, cachedInput: null };
  /** Baseline of the current native turn: a continuation turn's ledger attempt carries only its own usage. */
  let attemptUsageBaseline: CodexUsageBaseline = turnUsageBaseline;
  /** A `thread/compact/start` this runner sent after a context overflow: settled by that compaction turn's terminal. */
  let compactionWaiter: ((ok: boolean) => void) | null = null;
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
  const health: { lastInputTokens: number | null; lastCachedInputTokens: number | null; contextWindowTokens: number | null; compactionItems: Set<string>; compactedNotices: number } =
    { lastInputTokens: null, lastCachedInputTokens: null, contextWindowTokens: null, compactionItems: new Set(), compactedNotices: 0 };
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
  /*
   * A prose reply cut by the output cap continues in the next host turn (same thread): that turn's first message is the
   * same reply, joined without a separator (a JSON string cut mid-value stays one value). A schema-bound reply's
   * continuation is its whole typed answer instead (answerFrom), as in team-step-settlement.
   */
  const joinedMessageIds = new Set<string>();
  let joinNextMessage = false;
  let answerFrom = 0;
  const noteMessageId = (id: string): void => {
    if (messages.has(id)) return;
    messages.set(id, "");
    messageOrder.push(id);
    if (joinNextMessage) { joinedMessageIds.add(id); joinNextMessage = false; }
  };
  const bodyText = (): string => {
    let out = "";
    for (const id of messageOrder.slice(answerFrom)) {
      const piece = messages.get(id) ?? "";
      if (!piece) continue;
      out += out && !joinedMessageIds.has(id) ? `\n${piece}` : piece;
    }
    return out;
  };
  const emitPartial = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastEmit <= 60) return;
    lastEmit = now;
    emitted = true;
    events.onPartial(bodyText());
  };
  // The model's own checklist (update_plan → turn/plan/updated), forwarded only when it changes.
  const emitPlan = createRuntimePlanEmitter(events.onPlan);

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

  /**
   * ★호스트 소유 침묵 한도(resident app-server). exec 경로(runCodexProcess)에만 있던 가드를 상주 턴에도 세운다: 살아 있지만
   * 완전히 조용한 app-server 는 `turn/completed` 를 영영 보내지 않아 이 턴(`await settled`)을 무기한 붙든다. 자식이 낸
   * 알림·서버 요청만 센다(하트비트 아님). 도구 아이템이 열려 있거나 승인/입력 요청에 답을 기다리는 동안은 도구 한도.
   */
  let silence: CliSilenceGuard | null = null;
  const silenceWindowMs = cliSilenceWindowMs(env);
  const NON_TOOL_ITEM_TYPES = new Set(["agentMessage", "reasoning", "userMessage", "plan", "hookPrompt", "contextCompaction", "context_compaction", "compaction"]);
  let serverRequestSeq = 0;

  const onNotification = (method: string, params: any): void => {
    silence?.touch();
    // TurnStartParams.clientUserMessageId comes back as this turn's user item clientId: a typed acknowledgement of the
    // request that survives a lost turn/start receipt (RuntimeTurnDelivery "accepted").
    if ((method === "item/started" || method === "item/completed") && sentClientUserMessageId && params?.threadId === session.threadId
      && params?.item?.type === "userMessage" && params.item.clientId === sentClientUserMessageId) requestEchoed = true;
    if ((method === "item/started" || method === "item/completed") && typeof params?.item?.id === "string"
      && !NON_TOOL_ITEM_TYPES.has(String(params?.item?.type ?? ""))) {
      // A started tool suspends the plain window until it completes (long builds/renders are silent).
      if (method === "item/started") silence?.toolStart(params.item.id); else silence?.toolEnd(params.item.id);
    }
    if (params?.threadId === session.threadId && (method === "thread/compacted"
      || ["thread/closed", "thread/deleted", "thread/archived"].includes(method)
      || ((method === "item/started" || method === "item/completed")
        && ["contextCompaction", "context_compaction", "compaction"].includes(String(params?.item?.type ?? ""))))) {
      invalidateStableTurnContext({ chatId: contextChatId, runtimeKind: KIND, sessionId: session.threadId ?? "" }, true);
      let observedCompaction = false;
      if (method === "thread/compacted") { health.compactedNotices += 1; observedCompaction = true; }
      else if (method === "item/completed") { health.compactionItems.add(String(params?.item?.id ?? health.compactionItems.size)); observedCompaction = true; }
      // G17: per-occurrence record next to the aggregate above (the aggregate still feeds rotation, unchanged).
      if (observedCompaction) recordNativeCompaction({
        runtime: "codex", chatId: req.chatId, model: req.model, signal: method,
        nativeRef: method === "item/completed" && params?.item?.id != null ? String(params.item.id) : null,
        sessionRef: session.threadId, turnRef: typeof params?.turnId === "string" ? params.turnId : null,
        tokensBefore: health.lastInputTokens, tokensBeforeSource: "last_observed_input",
        configuredWindowLimit: compactLimit,
        compactionsThisTurn: Math.max(health.compactionItems.size, health.compactedNotices) });
    }
    // AD-10: child threads join the turn that addressed them (its collab item or sub-agent activity, or the child's own
    // thread/started naming its parent); a child of an earlier turn's child stays with that earlier turn.
    const priorResidue = codexPriorTurnResidue(params, session.threadId, priorOwnership, turnChildThreads);
    if (method === "thread/started" && typeof params?.thread?.id === "string" && typeof params.thread.parentThreadId === "string") {
      const parent = params.thread.parentThreadId;
      if (parent === session.threadId || turnChildThreads.has(parent)) rememberCodexOwnership(turnChildThreads, params.thread.id);
      else if (priorOwnership?.threadIds.has(parent)) rememberCodexOwnership(priorOwnership.threadIds, params.thread.id);
    }
    if ((method === "item/started" || method === "item/completed") && typeof params?.threadId === "string") {
      const children = codexChildThreadIds(params.item);
      const lineage = !priorResidue && (params.threadId === session.threadId || turnChildThreads.has(params.threadId)) ? turnChildThreads
        : priorResidue ? priorOwnership?.threadIds : undefined;
      if (lineage) for (const child of children) rememberCodexOwnership(lineage, child);
    }
    if (priorResidue && method.startsWith("item/")) {
      // An earlier runner turn's late frame on this reused process: counted (prior_turn_frames), never this turn's effect.
      priorTurnFrames = Math.min(Number.MAX_SAFE_INTEGER, priorTurnFrames + 1);
      return;
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
      case "turn/plan/updated":
        // A sub-agent's thread or another turn has its own plan; only this turn's checklist is drawn.
        if (params?.threadId === session.threadId && confirmedTurnId && params?.turnId === confirmedTurnId) {
          emitPlan(planFromCodexTurnPlan(params));
        }
        break;
      case "thread/started":
        // The thread/start and resume responses own session.threadId. A sub-agent's
        // thread also announces itself here and must not take over this session.
        if (typeof params?.thread?.id === "string" && !session.threadId) session.threadId = params.thread.id;
        break;
      case "turn/started":
        // 이 자리는 exec 경로와 같은 의미다 — 모델이 생각을 시작했다는 가장 이른 신호.
        // An earlier runner turn's id (AD-10) is never this turn's, however late its turn/started arrives.
        if (typeof params?.turn?.id === "string" && params?.threadId === session.threadId && !priorOwnership?.turnIds.has(params.turn.id)
          && ((confirmedTurnId && params.turn.id === confirmedTurnId) || (!confirmedTurnId && turnRequestInFlight))) {
          turnId = params.turn.id;
          confirmedTurnId = params.turn.id;
          rememberCodexOwnership(ownedTurnIds, params.turn.id);
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
        noteMessageId(id);
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
            noteMessageId(id);
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
        // The window Codex itself reports for this model: the next spawn derives its compaction limit from it when the
        // product's table does not know the model (session-generation.ts, native-harness NH14).
        recordObservedContextWindow(KIND, req.model, params?.tokenUsage?.modelContextWindow);
        const reportedWindow = params?.tokenUsage?.modelContextWindow;
        if (typeof reportedWindow === "number" && Number.isSafeInteger(reportedWindow) && reportedWindow > 0) health.contextWindowTokens = reportedWindow;
        if (total && Number.isSafeInteger(total.outputTokens) && total.outputTokens >= 0) {
          usage.total = {
            outputTokens: total.outputTokens,
            ...(Number.isSafeInteger(total.inputTokens) && total.inputTokens >= 0 ? { inputTokens: total.inputTokens } : {}),
            ...(Number.isSafeInteger(total.cachedInputTokens) && total.cachedInputTokens >= 0 ? { cachedInputTokens: total.cachedInputTokens } : {}),
          };
          usage.observed = codexObservedTurnUsage(usage.total, turnUsageBaseline);
          if (usage.observed) events.onUsage?.(usage.observed.outputTokens);
        }
        if (last && Number.isSafeInteger(last.inputTokens) && last.inputTokens > 0) {
          // `last` is ONE response (the newest of the turn's tool loop): the window the next request starts from. The cached
          // part belongs to the same response, so it moves with it and is dropped when this one does not report it.
          health.lastInputTokens = last.inputTokens;
          health.lastCachedInputTokens = Number.isSafeInteger(last.cachedInputTokens) && last.cachedInputTokens >= 0 && last.cachedInputTokens <= last.inputTokens
            ? last.cachedInputTokens : null;
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
      case "mcpServer/startupStatus/updated": {
        // An MCP server Codex could not start leaves this turn without its tools. Say which one and the typed reason (no
        // provider prose): before, the turn only failed later as a run failure (production audit 2026-10-18, M2).
        if (fromOtherThread(params)) break;
        const name = typeof params?.name === "string" && /^[A-Za-z0-9_.@-]{1,80}$/.test(params.name) ? params.name : "";
        if (name && (params?.status === "failed" || params?.status === "cancelled")) {
          const reason = params?.failureReason === "reauthenticationRequired" ? "reauthentication_required" : params.status;
          events.onStatus(`[codex-mcp] ${name} ${reason}`);
        }
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
        if (typeof params?.threadId === "string" && typeof session.threadId === "string" && session.threadId
          && params.threadId !== session.threadId) terminalDiagnostics.threadMismatch = Math.min(Number.MAX_SAFE_INTEGER, terminalDiagnostics.threadMismatch + 1);
        if (!turn || params?.threadId !== session.threadId || typeof turn.id !== "string" || !turn.id) break;
        if (compactionWaiter && !acknowledgedTurnId && !turnRequestInFlight) {
          // The compaction turn this runner started after a context overflow (thread/compact/start runs as a turn).
          const settle = compactionWaiter;
          compactionWaiter = null;
          settle(turn.status === "completed");
          break;
        }
        // Notifications may precede the turn/start response. Only its exact
        // acknowledged ID can bind a terminal result to this submitted prompt.
        if (!acknowledgedTurnId) {
          if (turnRequestInFlight && pendingTurnCompletions.size < 64) pendingTurnCompletions.set(turn.id, params);
          else if (turnRequestInFlight) terminalDiagnostics.earlyOverflow = Math.min(Number.MAX_SAFE_INTEGER, terminalDiagnostics.earlyOverflow + 1);
          break;
        }
        if (turn.id !== acknowledgedTurnId) {
          terminalDiagnostics.turnMismatch = Math.min(Number.MAX_SAFE_INTEGER, terminalDiagnostics.turnMismatch + 1);
          break;
        }
        terminalObserved = true;
        terminalSucceeded = turn.status === "completed";
        if (turn.status === "interrupted") interrupted = true;
        {
          // This turn's `error` notification may carry the typed code its terminal error lacks: a terminal without its
          // own codexErrorInfo never replaces it (audit A1 C8.1: the code must survive to the ledger and the room).
          const terminalFailure = codexFailureFromTurn(turn);
          failure = terminalFailure && (turn.error?.codexErrorInfo != null || !failure) ? terminalFailure : failure ?? terminalFailure;
        }
        // CodexSession catches sink exceptions. Always settle this exact native
        // terminal, then propagate authority/accounting errors in the caller.
        try {
          observeTerminalCallback(withdrawNativeTurnController);
          const attemptUsage = usage.total ? codexObservedTurnUsage(usage.total, attemptUsageBaseline) : undefined;
          if (attemptUsage) observeTerminalCallback(() => events.onTerminalObservedUsage?.(attemptUsage, runtimeAttemptId));
          observeTerminalCallback(() => workforceObservation?.completeTurn(params));
        } finally { settleTurn?.("completed"); }
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
      // The child asked and now waits for an answer (approval, input, tool): its silence is not a stall.
      const silenceRequestKey = `server-request:${++serverRequestSeq}`;
      silence?.toolStart(silenceRequestKey);
      try {
      // Experimental server request: the host's clock, whole Unix seconds (CurrentTimeReadResponse). Not an approval.
      if (method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
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
            contentItems: [{ type: "inputText", text: "image: failed (tool unavailable or prompt invalid); no image exists." }],
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
            contentItems: [{ type: "inputText", text: "image: not approved; no image exists." }],
          };
        }
        events.onStatus(`[tool-approval] runtime=${KIND} capability=other tool=${CODEX_IMAGE_TOOL_NAME} decision=${decision}`);
        // The room's permission reaches the image route's own CLI (multimodal/image.ts ImageAdmission, R-078).
        const generated = await generateImage(imageToolSlot.model, prompt, { permission: req.permission });
        if (!generated.ok || !generated.src || !generated.artifactPath) {
          return {
            success: false,
            contentItems: [{ type: "inputText", text: `image: failed (${generated.reason ?? "none produced"}); no image exists.` }],
          };
        }
        dynamicToolArtifactPaths.set(callId, [generated.artifactPath]);
        const workspaceCopy = copyGeneratedImageIntoWorkspace({ cwd, permission: req.permission,
          sourcePath: generated.artifactPath, label: "image" });
        return {
          success: true,
          contentItems: [
            { type: "inputText", text: `image: ok (${generated.engine ?? imageToolSlot.runtimeKind}), attached${workspaceCopy ? `; copy: ${workspaceCopy} (use for uploads)` : ""}` },
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
      } finally { silence?.toolEnd(silenceRequestKey); }
    },
    onStatus: (status) => events.onStatus(status),
    onTransportClosed: (reason) => {
      if (!transportDiagnosticObserved) {
        transportDiagnosticObserved = true;
        try {
          emitResidentDiagnostic("transport-ended", { category: "transport-ended", rpcCode: null, timeoutMs: null, requestMethod: null });
          if (session.conn.diagnosticSnapshot().transport.childCloseObserved) emitResidentDiagnostic("child-closed", null);
          else {
            // stdout end can precede the real OS close. This one captured owner
            // survives checkout release; it never reads session.active or ALS.
            session.child.once("close", () => emitResidentDiagnostic("child-closed", null));
          }
        } catch { /* Stop and terminal withdrawal remain unconditional. */ }
      }
      withdrawNativeTurnController();
      closedReason = reason;
      elicitationAbort.abort(new Error(reason));
      compactionWaiter?.(false);
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
    compactionWaiter?.(false);
    if (session.threadId && turnId && codexResidentSessionAlive(session)) {
      interruptAck = session.conn
        .request("turn/interrupt", { threadId: session.threadId, turnId }, { timeoutMs: 5_000 })
        .catch(() => { /* 이미 끝났거나 죽었다 */ });
    }
    settleTurn?.("closed");
  };

  /* ── host continuation turns (output limit, context overflow) ── */
  /** The typed failure of the last turn a host continuation followed, restored when that continuation cannot begin. */
  let cutResult: { failure: RunnerFailure; answerFrom: number; messageCount: number } | null = null;
  /** The turn carries a strict output schema (its continuation is then a whole typed answer, not a spliced tail). */
  let schemaBoundTurn = false;
  /** A busy turn/start refusal (another non-steerable turn holds the thread) already had its one retry. */
  let turnStartBusyRetried = false;
  /** turn/start retries of this turn (no turn began), counted for the shared decider's bound. */
  let turnStartRetries = 0;
  const restoreCutResult = (cut: NonNullable<typeof cutResult>): void => {
    failure = cut.failure;
    terminalObserved = true;
    terminalSucceeded = false;
    answerFrom = cut.answerFrom;
  };
  /** Per-turn state back to "no turn yet"; the thread, its messages and the run's usage baseline stay. */
  const beginHostTurn = (kind: LedgerHostTurn): void => {
    failure = null;
    terminalObserved = false;
    terminalSucceeded = false;
    turnId = "";
    confirmedTurnId = "";
    acknowledgedTurnId = "";
    pendingTurnCompletions.clear();
    pendingModelReroutes.clear();
    requestEchoed = false;
    sentClientUserMessageId = null;
    runtimeAttemptId = crypto.randomUUID();
    if (usage.total) attemptUsageBaseline = { output: usage.total.outputTokens, input: usage.total.inputTokens ?? null,
      cachedInput: usage.total.cachedInputTokens ?? null };
    silence?.stop();
    silence = null;
    if (kind === "output_limit_continuation") {
      // Prose: the next reply continues this one. Schema-bound: the next reply is the whole typed answer.
      if (schemaBoundTurn) answerFrom = messageOrder.length; else joinNextMessage = true;
    }
  };
  /** Codex runs thread/compact/start as a turn; its terminal settles the wait. Bounded; false when it cannot be proven. */
  const compactResidentThread = async (): Promise<boolean> => {
    if (!session.threadId || !codexResidentSessionAlive(session) || req.signal?.aborted) return false;
    const done = new Promise<boolean>((resolve) => { compactionWaiter = resolve; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await session.conn.request("thread/compact/start", { threadId: session.threadId }, { timeoutMs: 30_000, signal: req.signal });
      return await Promise.race([done, new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), CODEX_COMPACTION_WAIT_MS);
        timer.unref?.();
      })]);
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
      compactionWaiter = null;
    }
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
    // Context-reduction C01: the developer instructions this turn actually sent with thread/start|resume|fork (null = live thread kept its own).
    let developerInstructionsSent: string | null = null;
    // Model selection belongs to the thread protocol, not the resident process
    // identity. A live Codex thread/resume can acknowledge its previous model
    // even when given a new one. Fork that thread in the same app-server instead:
    // the fork inherits its history and acknowledges the requested model before
    // any prompt is sent. A model change must not create another CLI process.
    // A reused thread runs another invocation's MCP table only until the preflight above rebinds it (rebindThread), forks
    // it (modelChanged) or resumes another named thread (explicitResume); anything else never reaches turn/start.
    if (reusing && mcpThread && session.mcpConfigDigest !== mcpThread.digest && !rebindThread && !modelChanged && !explicitResume) {
      throw new Error("codex_resident_mcp_table_unbound");
    }
    if (!reusing || rebindThread || workforceObservation || explicitResume || modelChanged) {
      // Thread config: the Workforce policy proof, or this invocation's MCP table (codexMcpThreadConfig). The two never
      // meet: a Workforce observation keeps its servers in the spawn arguments.
      const threadConfig: Record<string, unknown> = {
        // Thread start/resume acknowledges effective policy. Request the same
        // workspace-write values that turn/start will use before admitting a
        // Workforce model turn; a requested turn override alone is no proof.
        ...(workforceObservation && req.permission === "write" ? {
          "sandbox_workspace_write.writable_roots": [path.resolve(cwd), sandboxNpmCacheDir()],
          "sandbox_workspace_write.network_access": true,
          "sandbox_workspace_write.exclude_tmpdir_env_var": true,
          "sandbox_workspace_write.exclude_slash_tmp": true,
        } : {}),
        ...(mcpThread && Object.keys(mcpThread.servers).length > 0 ? { mcp_servers: mcpThread.servers } : {}),
      };
      const commonThreadParams: Record<string, unknown> = {
        cwd,
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer,
        sandbox: policy.sandbox,
        ...(Object.keys(threadConfig).length > 0 ? { config: threadConfig } : {}),
        // The one-line image contract rides every ordinary thread (no media-intent word list, owner 2026-10-13).
        developerInstructions: codexImageToolCapability(req) !== "disabled" && req.sciencePromptProfile !== true
          ? buildDeveloperInstructions(req, codexImageToolInstructions(Boolean(imageToolSlot)))
          : buildDeveloperInstructions(req),
        ...(imageToolSlot ? { dynamicTools: [CODEX_IMAGE_DYNAMIC_TOOL] } : {}),
      };
      developerInstructionsSent = String(commonThreadParams.developerInstructions ?? "");
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
            // Before turn/start: nothing of this turn was sent (RuntimeTurnDelivery "not-dispatched", its own code kept).
            throw markRefusedBeforeDispatch(new CodexModelSelectionError("resolution_unverified", "Codex model fork returned the previous thread instead of a new one."));
          }
          workforceObservation?.acknowledgeThread(response, modelAcknowledgement, policy, cwd, approvalsReviewer, threadToResume);
          session.threadId = forkHeldThreadForModel ? response.thread.id : threadToResume;
          session.modelAcknowledgement = modelAcknowledgement;
          session.mcpConfigDigest = mcpThread?.digest ?? null;
          // A fork's source keeps its own thread-config servers loaded; it is not this process's thread any more.
          if (forkHeldThreadForModel && mcpThread && Object.keys(mcpThread.servers).length > 0) forkSourceToRelease ??= threadToResume;
          resumed = true;
        } catch (err) {
          if (req.signal?.aborted) throw abortReasonError(req);
          events.onStatus(`[runtime-session] resume_failed kind=${KIND}`);
          if (err instanceof CodexModelSelectionError) throw markRefusedBeforeDispatch(err);
          // The request's own typed timeout (not its words): the stored thread did not open within the bound, before any
          // turn/start (YouTube room 2026-10-28: a 1.7 GB rollout timed out on every resume, model fallback included).
          const resumeTimedOut = err instanceof AcpTimeoutError
            && (err.method === "thread/resume" || err.method === "thread/fork");
          throw markRefusedBeforeDispatch(err instanceof CodexSessionContinuityError ? err : new CodexSessionContinuityError(
            "resume_failed", `Codex thread resume failed: ${err instanceof Error ? err.message : String(err)}`,
            resumeTimedOut ? "resume_timed_out" : undefined,
          ));
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
        session.mcpConfigDigest = mcpThread?.digest ?? null;
        await nameNewCodexThread(session, id, req, events);
      }
      // The thread this process held before a model-change fork (or before resuming another named thread) still runs
      // the previous invocation's revoked MCP table: release it so Codex unloads it (best effort, never this turn's).
      if (forkSourceToRelease && forkSourceToRelease !== session.threadId) {
        await releaseCodexResidentThread(session, forkSourceToRelease, { timeoutMs: 2_000 }).catch(() => undefined);
      }
      // 버전 스큐 관측 — 이 세션이 어떤 app-server 였는지 영수증에 남긴다.
      events.onStatus(codexProtocolReceipt(session.init));
    }
    if (!session.threadId) throw new Error("codex app-server session has no thread");
    if (req.model && session.modelAcknowledgement?.requestedModel !== req.model) {
      throw markRefusedBeforeDispatch(new CodexModelSelectionError("resolution_unverified", "The resident Codex thread has no acknowledgement for the requested model."));
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
    attemptUsageBaseline = turnUsageBaseline;

    /* ── 턴 ── */
    // 새 스레드면 시스템+히스토리 시드, 이어가는 스레드면 사용자 턴만(+gap/turn 컨텍스트).
    const continuing = reusing || Boolean(resumeThreadId && session.threadId === resumeThreadId);
    // Prepare the exact dispatched seed too. Only the bound turn/start receipt
    // commits it; typed compaction/replacement and unsettled turns invalidate it.
    // A resumed thread keeps its whole history, so only a thread that is not being continued starts empty.
    if (!continuing) invalidateStableTurnContext({ chatId: contextChatId, runtimeKind: KIND, sessionId: session.threadId });
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
    /*
     * Host continuation turns in the SAME thread (owner rule 2026-10-13: never end a turn on the output cap; production
     * 1.3.49 run 5d37e4cc: a teammate cut at 128,000 output tokens after 62 minutes failed the whole owner turn).
     *   output limit      one host turn with the registered continuation module (output-limit-continuation.ts), at most
     *                     OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS in a row, exactly as the API lanes do;
     *   context overflow  one thread/compact/start, then one host turn with the run-recovery line (plan R-007).
     * Both keep the thread's history (the cut reply is in it); the owner's request is never sent again. A Workforce turn
     * keeps its single-turn observation contract and surfaces the typed failure instead.
     */
    let hostTurn: { kind: LedgerHostTurn; text: string } | null = null;
    let outputLimitRounds = 0;
    let contextOverflowRecovered = false;
    schemaBoundTurn = Boolean(req.outputSchema && openAiStrictSchemaOrNull(req.outputSchema.schema));
    for (;;) {
    const turnPrompt = hostTurn ? hostTurn.text : promptText;
    const turnParams: Record<string, unknown> = {
      threadId: session.threadId,
      input: [{ type: "text", text: turnPrompt }],
      cwd,
      // Reassert sticky policy on every turn. A resident thread can survive a
      // permission/reviewer change, and inheriting its previous values would
      // either over-grant the next role or strand an internal tool worker on a
      // user approval surface it cannot render.
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer,
      sandboxPolicy: policy.sandboxPolicy,
      ...(appliedEffort ? { effort: appliedEffort } : {}),
      // Idempotency and correlation key for this attempt, sent only where the executable's own schema has it.
      ...(nativeSteeringCapability?.turnStartClientUserMessageId ? { clientUserMessageId: runtimeAttemptId } : {}),
      // ★출력 형태 계약 — app-server 는 스키마를 **인라인**으로 받는다(exec 은 파일 경로만).
      ...(req.outputSchema && openAiStrictSchemaOrNull(req.outputSchema.schema) ? { outputSchema: req.outputSchema.schema } : {}),
    };
    const settled = new Promise<"completed" | "closed">((resolve) => {
      settleTurn = (reason) => { settleTurn = null; resolve(reason); };
    });
    let started: any;
    if (turnParams.clientUserMessageId) sentClientUserMessageId = runtimeAttemptId;
    turnDispatchAttempted = true;
    diagnosticRuntimeAttemptId = runtimeAttemptId;
    const sentHostTurn = hostTurn;
    reportModelPayload(() => sentHostTurn
      // A host continuation turn: no owner text, no history, no attachments; its line is host context.
      ? ledgerFromCliSent({ mode: "resume", sentText: sentHostTurn.text, req: { ...req, userPrompt: "", images: undefined },
        systemText: null, hostTurn: sentHostTurn.kind })
      : ledgerFromCliSent({
      // nativeThreadCreated = new thread (full seed); a thread/resume or fork on a cold process = reopen; a live resident thread = resume.
      mode: nativeThreadCreated ? "fresh" : developerInstructionsSent !== null ? "reopen" : "resume",
      sentText: promptText, req, systemText: developerInstructionsSent,
      historyInSentText: !continuing, hostContextText: resumeContext?.text }));
    events.onRuntimeAttemptStarted?.(runtimeAttemptId);
    turnRequestInFlight = true;
    try {
      started = await session.conn.request("turn/start", turnParams, { timeoutMs: 120_000, signal: req.signal });
    } catch (error) {
      diagnosticFailure = codexDiagnosticFailure(error);
      // Typed attribution: failure class, the transport at that moment, and the host's own close reason when the host
      // closed this process (eviction, shutdown) while the turn was starting.
      emitResidentDiagnostic("turn-start-failed", diagnosticFailure, (transport) => ({
        code: codexTurnStartFailureCode(diagnosticFailure),
        transportState: transport && (transport.transportEndReason !== null || transport.childCloseObserved) ? "ended" : "open",
        evictionReason: codexEvictionReason(pool.closeReasonOf(lease!)),
      }));
      // A JSON-RPC error response is the server refusing the request: no turn began, so nothing may
      // have acted. Only a closed transport or a timeout leaves the dispatch genuinely uncertain.
      if (error instanceof AcpRpcError && sentHostTurn && cutResult) {
        // The continuation never began: the cut turn's typed result stands (its reply is kept, its turn was accepted).
        events.onStatus(`[${sentHostTurn.kind === "output_limit_continuation" ? "output-limit" : "context-overflow"}] kind=${KIND} continuation=refused rpc=${error.code}`);
        restoreCutResult(cutResult);
        break;
      }
      if (error instanceof AcpRpcError && !sentHostTurn) {
        // No turn began. Never re-run it as one-shot exec (that silently drops live approvals and steering, and repeated
        // the refusal 3x in W7 S-graph-two-steps): a busy thread gets ONE bounded retry here, anything else is returned
        // as the typed refusal, "not-dispatched", for the caller's settlement (audit A1 C2.2, plan R-070).
        turnDispatchAttempted = false;
        const refusal = codexTurnStartRefusalFailure(error);
        // The shared decider (shared/turn-settlement.ts) owns retries of work that did not run (rate_limit backoff); a
        // busy thread (another non-steerable turn) adds one short app-server retry of its own.
        const settlement = decideTurnSettlement({ outcome: "failed", delivery: "not-dispatched", kind: refusal.kind,
          providerCode: refusal.providerCode, unattended: req.unattended === true, attempt: turnStartRetries, resumeBudget: 0,
          fallbackAvailable: false });
        const busyRetry = codexTurnStartRefusalIsBusy(error) && !turnStartBusyRetried;
        if ((settlement.action === "retry" || busyRetry) && !req.signal?.aborted) {
          if (busyRetry && settlement.action !== "retry") turnStartBusyRetried = true;
          turnStartRetries += 1;
          const delayMs = settlement.action === "retry" ? settlement.delayMs : CODEX_TURN_START_BUSY_RETRY_MS;
          events.onStatus(`[turn-start] kind=${KIND} refused=${refusal.providerCode} retry=${settlement.action === "retry" ? turnStartRetries : "1/1"}`);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, delayMs);
            function done(): void { clearTimeout(timer); req.signal?.removeEventListener("abort", done); resolve(); }
            req.signal?.addEventListener("abort", done, { once: true });
          });
          if (req.signal?.aborted) throw abortReasonError(req);
          runtimeAttemptId = crypto.randomUUID();
          continue;
        }
        events.onStatus(`[turn-start] kind=${KIND} refused=${refusal.providerCode}${Number.isInteger(error.code) ? ` rpc=${error.code}` : ""}`);
        return { result: { text: "", ownerControlTerminal: "uncertain", failure: refusal, sessionId: session.threadId,
          appliedEffort, turnDelivery: "not-dispatched" } };
      }
      throw error;
    } finally {
      turnRequestInFlight = false;
    }
    workforceObservation?.startTurn(started);
    if (typeof started?.turn?.id === "string" && started.turn.id.trim()) {
      turnId = started.turn.id;
      confirmedTurnId = started.turn.id;
      acknowledgedTurnId = started.turn.id;
      rememberCodexOwnership(ownedTurnIds, started.turn.id);
      if (!req.signal?.aborted) acknowledgeStableTurnContext(stableContextDelivery,
        { sessionId: session.threadId, acknowledgementId: started.turn.id });
    } else {
      throw new RuntimeTurnUnsettledError(KIND, req.locale, session.threadId);
    }
    // Dispatch is acknowledged: from here a child that stops emitting is the host's to end (single settlement below).
    {
      const guardedChild = session.child;
      silence?.stop();
      silence = startCliSilenceGuard(guardedChild, {
        label: "codex", onStatus: events.onStatus, windowMs: silenceWindowMs, toolWindowMs: cliToolSilenceWindowMs(env),
        kill: () => { try { killCliTree(guardedChild); } catch { /* the transport-closed settlement still runs */ } settleTurn?.("closed"); },
      });
    }
    const earlyCompletion = pendingTurnCompletions.get(acknowledgedTurnId);
    for (const bufferedTurnId of pendingTurnCompletions.keys()) if (bufferedTurnId !== acknowledgedTurnId)
      terminalDiagnostics.turnMismatch = Math.min(Number.MAX_SAFE_INTEGER, terminalDiagnostics.turnMismatch + 1);
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
    if (!sentHostTurn) events.onStatus(`[runtime-session] ${continuing ? "resumed" : "created"} kind=${KIND}`);
    if (modelSelectionError) throw modelSelectionError;
    const reason = await settled;
    if (req.signal?.aborted || interrupted) {
      // Keep Stop's authority ahead of callback failures, while retaining the
      // native terminal and measured counters for failure accounting.
      if (req.signal?.aborted) persistTurnCounters();
      broken = true;
      throw abortReasonError(req);
    }
    if (silence?.tripped && !terminalObserved) {
      // The host ended a silent app-server: a typed timeout (single settlement), never a guessed exit.
      broken = true;
      persistTurnCounters();
      closeThinking();
      return { result: { text: bodyText().trim(), ownerControlTerminal: "uncertain",
        failure: runtimeSilentTimeoutFailure(KIND, silence.trippedWith?.limitMs ?? silenceWindowMs, { toolInFlight: silence.trippedWith?.toolInFlight === true }),
        sessionId: session.threadId, appliedEffort } };
    }
    if (terminalObservationFailed) throw terminalObservationError;
    closeThinking();
    if (req.signal?.aborted) throw abortReasonError(req);

    if (modelSelectionError) throw modelSelectionError;

    if (reason === "closed") {
      // A closed transport cannot prove that a dispatched tool-only turn did nothing.
      broken = true;
      if (looksLikeMissingAppServer(session.conn.lastStderr, new Error(closedReason))) {
        markCodexAppServerUnsupported(closedReason || session.conn.lastStderr);
        events.onStatus(`[residency] disabled kind=${KIND} reason=app-server-unsupported`);
      }
      // The exact turn/start receipt was received above: the session holds this turn's request.
      throw new RuntimeTurnUnsettledError(KIND, req.locale, session.threadId, null, "accepted");
    }
    const recoverable = Boolean(failure) && terminalObserved && !broken && !interrupted && !workforceObservation
      && !modelSelectionError && !req.signal?.aborted && codexResidentSessionAlive(session);
    if (recoverable && isCodexOutputLimitFailure(failure)
      && continuesSameSession(failure!, OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS - outputLimitRounds, req.unattended === true)) {
      outputLimitRounds += 1;
      // Typed receipt; the next attempt's ledger row carries hostTurn=output_limit_continuation.
      events.onStatus(`[output-limit] kind=${KIND} continuation=${outputLimitRounds}/${OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS} cut=text`);
      cutResult = { failure: failure!, answerFrom, messageCount: messageOrder.length };
      // codex never names whether the cap fell inside text, reasoning or a tool call: the "text" variant (continue where
      // it stopped) is the one that is true for all three; a cut tool call never reached item/started, so it was not run.
      hostTurn = { kind: "output_limit_continuation", text: outputLimitContinuationTurn("text") };
      beginHostTurn("output_limit_continuation");
      continue;
    }
    if (recoverable && isCodexContextOverflowFailure(failure)
      && continuesSameSession(failure!, contextOverflowRecovered ? 0 : 1, req.unattended === true)) {
      contextOverflowRecovered = true;
      cutResult = { failure: failure!, answerFrom, messageCount: messageOrder.length };
      beginHostTurn("context_overflow_continuation");
      const compacted = await compactResidentThread();
      events.onStatus(`[context-overflow] kind=${KIND} compacted=${compacted ? "yes" : "no"}${compacted ? " continuation=1/1" : ""}`);
      if (compacted && !req.signal?.aborted && !broken) {
        hostTurn = { kind: "context_overflow_continuation", text: UNSETTLED_CONTINUATION_PROMPT };
        continue;
      }
      if (req.signal?.aborted) throw abortReasonError(req);
      restoreCutResult(cutResult);
    }
    break;
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
    // A turn Codex itself completed is settled by the shared rule (R-065): a tool-only turn is complete with an empty
    // text; only one that left neither text nor a tool call is the typed "empty" failure. Any other end keeps its own.
    const normalEnd = terminalSucceeded && !failure && !interrupted && !req.signal?.aborted
      ? settleNormalEnd({ text, toolCalls: startedTools.size }) : null;
    if (!text && !failure && (!normalEnd || normalEnd.outcome === "empty")) {
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
        ...(health.lastInputTokens ? { contextInputTokens: health.lastInputTokens } : {}),
        ...(health.lastInputTokens && health.lastCachedInputTokens !== null ? { contextCachedInputTokens: health.lastCachedInputTokens } : {}),
        // The window Codex reported for this session: the 80% rule reads it before any catalog number (NH14).
        ...(health.contextWindowTokens ? { contextWindowTokens: health.contextWindowTokens } : {}),
        ...(workforcePermissionEnforcement ? { workforcePermissionEnforcement } : {}),
        ...(normalEnd ? normalEndToolEvidence(normalEnd) : {}),
        appliedEffort,
        // Reached only after the turn/start receipt: an uncertain result here is a turn the session holds.
        turnDelivery: "accepted",
      },
    };
  } catch (err) {
    diagnosticFailure = codexDiagnosticFailure(err);
    broken = true;
    try {
      if (turnDispatchAttempted) persistTurnCounters();
      if (req.signal?.aborted) throw abortReasonError(req);
      if (turnDispatchAttempted && !terminalObserved) throw new RuntimeTurnUnsettledError(KIND, req.locale, session.threadId, failure?.message ?? childExitReason(session.child?.exitCode, session.conn?.lastStderr),
        // Protocol fact: the turn/start receipt or this turn's turn/started notification is the session's acknowledgement.
        // A host continuation that never reached its own receipt still follows a turn this session accepted (cutResult).
        acknowledgedTurnId || confirmedTurnId || requestEchoed || cutResult ? "accepted" : "not-accepted");
      if (req.workforceRuntimeToolGrant) throw err;
      if (err instanceof CodexModelSelectionError) throw err;
      if (err instanceof CodexSessionContinuityError) throw err;
      if (looksLikeMissingAppServer(session.conn?.lastStderr ?? "", err)) {
        markCodexAppServerUnsupported(err instanceof Error ? err.message : String(err));
        events.onStatus(`[residency] disabled kind=${KIND} reason=app-server-unsupported`);
      }
      // Empty visible text is not evidence of no dispatch or no external action.
      if (turnDispatchAttempted) throw err;
      if (!emitted && !bodyText()) return { retryOneShot: { reason: "app_server_pre_dispatch_failed" } };
      throw err;
    } catch (error) {
      // Preserve the chosen outgoing failure, including uncertainty/Stop
      // transformations, if a later cleanup callback or ledger also fails.
      primaryError = { error };
      throw error;
    }
  } finally {
    silence?.stop();
    withdrawNativeTurnController();
    req.signal?.removeEventListener("abort", onAbort);
    elicitationAbort.abort(new Error("Codex turn settled"));
    // A final thinking callback can contain a host fence. Retain its error,
    // but do not let it skip interrupt drain, sink removal or pool disposal.
    observeTerminalCallback(closeThinking);
    // 취소가 프로토콜에 도달한 뒤에 죽인다(상한 2초 — 응답이 없어도 폐기는 반드시 일어난다).
    if (interruptAck) {
      await Promise.race([
        interruptAck,
        new Promise((resolve) => { setTimeout(resolve, 2_000).unref?.(); }),
      ]).catch(() => { /* 폐기를 막지 않는다 */ });
    }
    // 수신자를 먼저 뗀다 — 유휴 세션이 지난 턴의 events 로 상태를 흘리면 안 된다.
    session.active = null;
    try {
      // AD-10: hand this turn's turns, child threads and thread to the next runner turn on this process as earlier-turn residue.
      const ownership = priorOwnership ?? { turnIds: new Set<string>(), threadIds: new Set<string>() };
      for (const id of ownedTurnIds) rememberCodexOwnership(ownership.turnIds, id);
      for (const id of turnChildThreads) rememberCodexOwnership(ownership.threadIds, id);
      if (session.threadId) rememberCodexOwnership(ownership.threadIds, session.threadId);
      codexPriorTurnOwnership.set(session, ownership);
      if (priorTurnFrames > 0) events.onStatus(`[runtime-session] prior_turn_frames kind=${KIND} count=${priorTurnFrames}`);
    } catch { /* a diagnostic receipt never blocks the pool disposition below */ }
    if (terminalObservationFailed && !diagnosticFailure) diagnosticFailure = codexDiagnosticFailure(terminalObservationError);
    emitResidentDiagnostic("turn-terminal");
    if (broken || req.signal?.aborted || failure || interrupted || (turnDispatchAttempted && !terminalObserved)) {
      invalidateStableTurnContext({ chatId: contextChatId, runtimeKind: KIND, sessionId: session.threadId ?? "" });
    }
    try {
      effects.complete(turnDispatchAttempted ? "resident_turn_closed" : "not_dispatched", (!turnDispatchAttempted || terminalObserved) && !req.signal?.aborted && (!turnDispatchAttempted || !broken));
    } finally {
      try {
        // Typed close reasons: a Stop is "shutdown", a broken process "error", and a healthy turn-scoped process after its
        // turn "turn-complete" (it used to be logged as an error: audit A1, 174 `closed reason=error`).
        if (req.signal?.aborted) pool.discard(lease, "shutdown");
        else if (broken) pool.discard(lease, "error");
        else if (turnScoped) pool.discard(lease, "turn-complete");
        else pool.release(lease);
      } finally {
        if (req.signal?.aborted) throw abortReasonError(req);
        if (primaryError) throw primaryError.error;
        if (terminalObservationFailed) throw terminalObservationError;
      }
    }
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
  const realAuth = path.join(realHome, "auth.json");
  try {
    // A symlink; on Windows without the symlink right a hard link or copy (mirror-link.ts). Nothing made: the look runs
    // signed out, as before, but no longer silently.
    try { if (linkMirrorEntry(realAuth, path.join(home, "auth.json")) === null) reportIsolationUnavailable("codex-observation", "sign-in-not-linked"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") reportIsolationUnavailable("codex-observation", error); }
    const instructions = path.join(home, "observation-instructions.md");
    await fs.writeFile(instructions, composeCodexHostInstructions(req), { encoding: "utf8", mode: 0o600 });
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
    if (!run.terminalObserved && isSilentTimeoutRun(run)) {
      return { text: run.text.trim(), ownerControlTerminal: "uncertain", failure: run.failure! };
    }
    if (!run.terminalObserved) throw new RuntimeTurnUnsettledError(KIND, req.locale, undefined, childExitReason(run.code, run.stderr));
    if (run.code !== 0 && !run.text.trim()) throw new Error(`codex CLI exit ${run.code}${run.stderr ? `\n${run.stderr.slice(0, 500)}` : ""}`);
    return { text: run.text.trim(), tokens: run.tokens, ...codexExecSettlement(run),
      ...(run.observedUsage ? { observedUsage: run.observedUsage } : {}) };
  } finally {
    // A token Codex refreshed in a Windows copy / broken hard link reaches the account's auth.json before the look is removed.
    try { reconcileMirrorLinks(home, new Map([["auth.json", realAuth]])); } catch { /* reported inside */ }
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
  // Judgment's gateway replaces all model input and runs with --ignore-user-config. It runs from the isolated product
  // mirror (sign-in linked, empty config) so its one-off threads land in the product store, not in the person's Codex
  // app (owner 2026-10-12: about 100 AGI judgments a day were listed there). A home that cannot be mirrored (keyring
  // sign-in) keeps the account home, as before.
  const requestEnv = req.env ?? process.env;
  req = { ...req, env: req.untrustedNoTools && req.judgmentOnly
    ? withCodexProductHome({ ...requestEnv, CODEX_HOME: accountCodexHome(requestEnv.CODEX_HOME) }, { isolated: true })
    : req.isolatedMcpConfig
      ? withCodexProductHome(requestEnv, { isolated: true })
      : withCodexProductHome(requestEnv, { personal: codexPersonalHomeOptions(selectionFor(req.agentId, undefined, req.chatId)) }) };
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
  // A read-only automation (restrictedReadBoundary) runs under its configured read permission: exec `--sandbox read-only`,
  // app-server codexThreadPolicy(read) (readOnly sandbox, network off, approvals answered by the host arbiter).
  // A Workforce receipt exists only on the acknowledged app-server path.
  // Ordinary Codex exec fallback is not an equivalent evidence producer.
  if (req.workforceRuntimeToolGrant && (!codexAppServerSupported()
    || residencyDisabledFor(KIND, req.env ?? process.env) || req.isolatedMcpConfig || !req.chatId)) {
    throw new Error("workforce_codex_observation_app_server_required");
  }
  const bin = await getBin(req.runtimeSource, req.cwd ?? agentRunCwd(), req.env ?? process.env);
  if (!bin) {
    // No executable: nothing can have been sent. A typed pre-dispatch refusal, not an unsettled turn (docs 31 W1).
    throw preDispatchRefusal(new Error(tStatus(req.locale, "errCliMissingCodex")), "cli-discovery", "codex_cli_missing");
  }
  if (req.untrustedNoTools && req.judgmentOnly) {
    const noToolsModel = codexNoToolsModel(req.model);
    const noToolsReq = noToolsModel && noToolsModel !== req.model ? { ...req, model: noToolsModel } : req;
    const inventory = await readCodexModelInventory(accountCodexHome(req.env?.CODEX_HOME));
    const effort = req.effort ? resolveCodexModelEffort(inventory, noToolsReq.model, req.effort)
      : defaultCodexModelEffort(inventory, noToolsReq.model);
    const capacities = [inventory.find(model => model.id === noToolsReq.model)?.contextWindow,
      resolveEffectiveContextWindow("codex", noToolsReq.model, req.longContext === true).contextWindow]
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
    if (!aliveAdmission) return runCodexNoTools({ ...noToolsReq, effort: effort ?? undefined }, events, executeNoTools, dependencies);
    const aliveRequest = { ...aliveAdmission, ...(aliveAdmission.model?.trim() || !noToolsModel ? {} : { model: noToolsModel }),
      effort: effort ?? undefined };
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
  // must not be widened by provider-global config. The run's home is the
  // isolated mirror (empty config.toml, codex-product-home.ts), which also
  // isolates the app-server; exec keeps the flag as well.
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
  // Personal Codex memories, skills, plugins, hooks and MCP servers stay out of every product run; One alone gets
  // the items the person switched on (capabilities/one-capabilities.ts).
  const personalContext = codexPersonalContextArgs({
    selection: selectionFor(runReq.agentId, undefined, runReq.chatId),
    desktopControlGrant: runReq.desktopControlGrant === true,
    userConfigIgnored: runReq.isolatedMcpConfig === true,
    hostServerNames,
    env: runReq.env ?? process.env,
    cwd: runReq.cwd ?? agentRunCwd(),
  });
  events.onStatus(personalContext.receipt);
  // Shell commands (never MCP servers) write npm's cache where the write sandbox allows it (sandbox-tool-cache.ts).
  const sandboxNpmCache = ensureSandboxNpmCacheDir();
  const browserOnlyConfigArgs: string[] = [...desktopSurface.args, ...personalContext.args, ...codexShellEnvironmentArgs(),
    ...(sandboxNpmCache ? ["-c", `shell_environment_policy.set.NPM_CONFIG_CACHE=${JSON.stringify(sandboxNpmCache)}`] : [])];
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
  const execCompactLimit = nativeCompactionLimit(KIND, runReq.model);
  modelArgs.push("-c", "model_reasoning_summary=auto", ...(execCompactLimit ? ["-c", `model_auto_compact_token_limit=${execCompactLimit}`] : []));
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
   * A chat-level thread (one the agent-context layer does not manage; that layer rotates its own through
   * session-generation.ts) gives way to a new one at a TURN BOUNDARY when the prior turn's last request reached 80% of
   * the model's own window (owner 2026-10-13: no fixed thresholds, nothing added to the prompt, nothing on screen).
   * The next turn starts fresh with a bounded text-only tail of the conversation. Caller-managed sessions never rotate.
   */
  const rotation = matchedSessionId && existing && !runReq.runtimeSessionId && !runReq.singleUse
    ? decideGeneration({ kind: KIND, contextWindowTokens: runtimeContextWindow(KIND, runReq.model),
      lastInputTokens: readThreadHealth(matchedSessionId)?.lastInputTokens ?? null })
    : null;
  const storedSessionId = rotation?.action === "new_generation" ? null : matchedSessionId;
  if (rotation?.action === "new_generation" && matchedSessionId && runReq.chatId) {
    // The new thread gets the bounded tail with host-built facts ahead of it, and the same rotation receipt as before
    // (docs native-harness 07 G07, G11: uncertain effects stay uncertain, grants as ids, goal refs, host-replay label).
    const handoff = await prepareRotationHandoff({ chatId: runReq.chatId, runtime: KIND, previousThreadId: matchedSessionId,
      reason: rotation.reason, history: runReq.history, health: readThreadHealth(matchedSessionId),
      reportedInputTokens: existing?.reportedInputTokens ?? null, agentId: runReq.agentId ?? null });
    runReq = { ...runReq, history: handoff.history };
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
  /** Whether a replacement session can be handed this conversation (unattended-session-turns.ts rule 4). */
  const conversationCarried = (): boolean => {
    if (!runReq.runtimeSessionId) return true;
    try { return agentContextBootstrapForRequest(runReq) !== null; } catch { return false; }
  };
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
  // Product sessions live in the product store; a thread an older install wrote into the person's home is copied there
  // first, so it resumes instead of starting over (codex-product-home.ts).
  if (resumeSessionId) adoptCodexThreadIntoProductStore(runReq.env?.CODEX_HOME, resumeSessionId);
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
  /*
   * A per-turn grant (an isolated MCP config such as a browser turn, or an ephemeral tool grant) must not outlive its
   * turn in a resident process. It still resumes the thread through app-server, in a process of its own that is closed
   * when the turn ends: measured 2026-10-12 on codex-cli 0.162.1, a new app-server process boots and resumes a thread
   * in 0.9 s with 99% of the input cached, where `codex exec resume` sent 2.3x the input with 43% cached. Room turns
   * with the browser took the exec path on every turn (production procmon, 6 exec spawns in 15 minutes).
   */
  const turnScopedProcess = runReq.isolatedMcpConfig === true || runReq.ephemeralToolGrant === true;
  // app-server has no --ignore-user-config: an isolated run may use it only from the isolated mirror. A home Main did
  // not mirror (a custom CODEX_HOME, keyring sign-in) keeps the one-shot exec, which passes the flag.
  const isolationHeld = !runReq.isolatedMcpConfig || isIsolatedCodexProductHome(runReq.env?.CODEX_HOME);
  /** Why this turn runs on exec although the app-server path took it first (typed, R-070); null = exec by design. */
  let execFallback: CodexExecFallback | null = null;
  if (
    isolationHeld &&
    !freshReason &&
    codexAppServerSupported() &&
    !residencyDisabledFor(KIND, runReq.env ?? process.env) &&
    !runReq.untrustedNoTools &&
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
        turnScopedProcess,
      });
    } catch (err) {
      // thread/resume is refused before any turn starts. An unattended run
      // continues in a fresh one-shot session instead of stopping for a human.
      // An owner's turn does too when another writer holds the thread: Desktop and
      // the background service each keep a resident Codex, and one cannot retire
      // the other's (production 1.2.93, 2026-10-11 03:54Z, "already has an active writer"),
      // and when the thread's rollout is gone (rule 4: refusing repeated the error on every later turn).
      if (runReq.signal?.aborted || !(err instanceof CodexSessionContinuityError)) throw err;
      const refusal = err.code === "resume_failed" ? err.resumeRefusal ?? classifyCodexResumeFailure(err.message) : "writer_busy";
      if (!runReq.unattended && refusal !== "writer_busy" && !attendedTurnStartsFresh(refusal, conversationCarried())) throw err;
      freshReason = refusal;
      events.onStatus(unattendedFreshSessionStatus(KIND, freshReason));
      execFallback = { reason: "resume_refused", detail: refusal };
      if (freshSessionReplacesStored(freshReason)) {
        clearRuntimeSession(runReq.chatId, KIND, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner });
      }
      runReq = await withAgentContextJournalSeed(runReq);
    }
    if (attempt.result) return attempt.result;
    if (attempt.retryOneShot) execFallback = attempt.retryOneShot;
    // R-070: the downgrade (no live approvals, no steering) is a typed receipt and rides the exec attempt's ledger row.
    if (execFallback) events.onStatus(codexExecFallbackStatus(execFallback));
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
  const execLedgerFacts = execFallback ? { transportFallback: codexExecFallbackLedgerValue(execFallback) } : {};
  const execResumeArgsFor = (threadId: string): string[] => [
    "exec",
    ...approvalArgs,
    "resume",
    ...isolatedConfigArgs,
    ...browserOnlyConfigArgs,
    // `codex exec` has no approval loop: ChatGPT apps only under full access (runtime-builtin-egress-policy.ts).
    ...codexBuiltinEgressConfigArgs({ approvalsReachArbiter: false, fullAccess: runReq.permission === "full" }),
    "--json",
    "--skip-git-repo-check",
    ...resumePermissionArgs(runReq.permission, runReq.approvalsReviewer),
    ...mcpArgs,
    ...modelArgs,
    ...schemaArgs,
    threadId,
    "-",
  ];
  /*
   * exec twin of the resident host continuations (same bound, same registered modules; owner rule 2026-10-13): a turn cut
   * by the output cap, or one whose context ran out, continues in the thread it ran in with `codex exec resume`. exec has
   * no thread/compact/start; Codex compacts a thread over its configured auto-compact limit before the next turn
   * (model_auto_compact_token_limit, set above), so the overflow retry is that one resume. The owner's request is not sent
   * again: it is in that thread.
   */
  const continueExecCut = async (first: CodexRunResult): Promise<CodexRunResult> => {
    let merged = first;
    let last = first;
    let rounds = 0;
    let overflowRetried = false;
    while (!runReq.signal?.aborted && last.terminalObserved && last.threadId && !runReq.workforceRuntimeToolGrant) {
      const outputLimit = isCodexOutputLimitFailure(last.failure)
        && continuesSameSession(last.failure!, OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS - rounds, runReq.unattended === true);
      const overflow = !outputLimit && isCodexContextOverflowFailure(last.failure)
        && continuesSameSession(last.failure!, overflowRetried ? 0 : 1, runReq.unattended === true);
      if (!outputLimit && !overflow) break;
      const hostTurn: LedgerHostTurn = outputLimit ? "output_limit_continuation" : "context_overflow_continuation";
      if (outputLimit) rounds += 1; else overflowRetried = true;
      events.onStatus(outputLimit
        ? `[output-limit] kind=${KIND} continuation=${rounds}/${OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS} cut=text`
        : `[context-overflow] kind=${KIND} compacted=native continuation=1/1`);
      const threadId = last.threadId;
      let next: CodexRunResult;
      let releaseWriter: (() => void) | undefined;
      try {
        releaseWriter = await prepareCodexExecThreadResume(path.resolve(runReq.cwd ?? agentRunCwd(),
          runReq.env?.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex")), threadId, runReq.signal);
        next = await runCodexProcess(bin, execResumeArgsFor(threadId),
          outputLimit ? outputLimitContinuationTurn("text") : UNSETTLED_CONTINUATION_PROMPT, runReq, events,
          { output: last.reportedOutputTokens ?? null, input: last.reportedInputTokens ?? null, cachedInput: last.reportedCachedInputTokens ?? null },
          observeNativeFile, undefined, { hostTurn, ...execLedgerFacts });
      } finally {
        releaseWriter?.();
      }
      // A prose cut joins the next reply without a separator; a schema-bound reply's continuation is its whole answer.
      const text = outputLimit && strictOutputSchema ? next.text
        : outputLimit ? `${merged.text}${next.text}` : [merged.text, next.text].filter((part) => part.trim()).join("\n");
      const usage = merged.observedUsage && next.observedUsage ? {
        inputTokens: merged.observedUsage.inputTokens + next.observedUsage.inputTokens,
        outputTokens: merged.observedUsage.outputTokens + next.observedUsage.outputTokens,
        ...(merged.observedUsage.cachedInputTokens != null || next.observedUsage.cachedInputTokens != null
          ? { cachedInputTokens: (merged.observedUsage.cachedInputTokens ?? 0) + (next.observedUsage.cachedInputTokens ?? 0) } : {}),
      } : undefined;
      const { observedUsage: _dropped, ...rest } = next;
      merged = { ...rest, text, threadId: next.threadId ?? threadId, toolCalls: merged.toolCalls + next.toolCalls,
        tokens: (merged.tokens ?? 0) + (next.tokens ?? 0) || undefined, ...(usage ? { observedUsage: usage } : {}) };
      last = next;
    }
    return merged;
  };
  /** A typed cut or overflow that outlived its continuations was a turn the thread accepted (turn events were observed). */
  const execCutDelivery = (run: CodexRunResult): { turnDelivery?: "accepted" } =>
    run.terminalObserved && run.threadId && (isCodexOutputLimitFailure(run.failure) || isCodexContextOverflowFailure(run.failure))
      ? { turnDelivery: "accepted" } : {};
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
  execResume: if (canResume && !freshReason) {
    const args = execResumeArgsFor(resumeSessionId!);
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
      execLedgerFacts,
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
    r = await continueExecCut(r);
    // `codex exec resume` refused before any turn: exit 1, no event, and Codex's thread/resume protocol phrase on stderr
    // (codex-cli 0.163.0, measured 2026-10-16 for a gone rollout: "thread/resume failed: no rollout found for thread id …";
    // a held writer is the same shape). Only those typed refusals qualify, as on the thread/resume path above; any other
    // failed exec may already have acted. Nothing started, so the turn continues fresh (CREATE below).
    const execRefusal = !runReq.signal?.aborted && r.code !== 0 && !r.turnStarted && !r.terminalObserved && !r.threadId && !r.text.trim()
      ? classifyCodexResumeFailure(r.stderr) : null;
    if (execRefusal && execRefusal !== "resume_failed_before_turn"
      && (runReq.unattended || execRefusal === "writer_busy" || attendedTurnStartsFresh(execRefusal, conversationCarried()))) {
      freshReason = execRefusal;
      events.onStatus(unattendedFreshSessionStatus(KIND, freshReason));
      if (freshSessionReplacesStored(freshReason) && runReq.chatId) {
        clearRuntimeSession(runReq.chatId, KIND, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner });
      }
      runReq = await withAgentContextJournalSeed(runReq);
      break execResume;
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
      if (isSilentTimeoutRun(r)) {
        return { text: r.text.trim(), ownerControlTerminal: "uncertain", failure: r.failure!,
          sessionId: r.threadId ?? resumeSessionId, tokens: r.tokens, appliedEffort };
      }
      const refused = codexExecRefusedBeforeTurn(r);
      if (refused) return { ...refused, ...(resumeSessionId ? { sessionId: resumeSessionId } : {}), appliedEffort };
      throw new RuntimeTurnUnsettledError(KIND, runReq.locale, r.threadId ?? resumeSessionId, childExitReason(r.code, r.stderr));
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
        ...codexExecSettlement(r),
        sessionId: r.threadId ?? resumeSessionId,
        tokens: r.tokens,
        ...(r.observedUsage ? { observedUsage: r.observedUsage } : {}),
        appliedEffort,
        ...execCutDelivery(r),
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
    // Say why the child exited: without this a resume that died after minutes of silence (Yotube room, 2026-10-12 16:16)
    // left only "exit=1" and the cause could not be told from a writer lock, a bad config or a network error.
    const stderrLast = String(r.stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";
    const stderrReason = stderrLast.replace(/[A-Za-z0-9_\-]{32,}/g, "<redacted>").slice(0, 200);
    events.onStatus(`[runtime-session] resume_failed kind=${KIND} exit=${r.code}${stderrReason ? ` reason=${JSON.stringify(stderrReason)}` : ""}`);
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
      ...execCutDelivery(r),
    };
  }

  // CREATE: 시스템 프롬프트 + 히스토리 + user를 stdin으로 보내 새 세션을 시드한다.
  const createArgs = [
    "exec",
    ...approvalArgs,
    ...isolatedConfigArgs,
    ...browserOnlyConfigArgs,
    // `codex exec` has no approval loop: ChatGPT apps only under full access (runtime-builtin-egress-policy.ts).
    ...codexBuiltinEgressConfigArgs({ approvalsReachArbiter: false, fullAccess: runReq.permission === "full" }),
    "--json",
    "--skip-git-repo-check",
    ...permArgs,
    ...mcpArgs,
    ...modelArgs,
    ...schemaArgs,
    "-",
  ];
  const created = await continueExecCut(await runCodexProcess(bin, createArgs, buildPrompt(runReq), runReq, events,
    { output: 0, input: 0, cachedInput: 0 }, observeNativeFile, undefined, execLedgerFacts));
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
    if (isSilentTimeoutRun(created)) {
      return { text: created.text.trim(), ownerControlTerminal: "uncertain", failure: created.failure!,
        sessionId: created.threadId ?? undefined, tokens: created.tokens, appliedEffort };
    }
    const refused = codexExecRefusedBeforeTurn(created);
    if (refused) return { ...refused, appliedEffort };
    throw new RuntimeTurnUnsettledError(KIND, runReq.locale, created.threadId, childExitReason(created.code, created.stderr));
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
      ...codexExecSettlement(created),
      sessionId: created.threadId ?? undefined,
      tokens: created.tokens,
      ...(created.observedUsage ? { observedUsage: created.observedUsage } : {}),
      appliedEffort,
      ...execCutDelivery(created),
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
      ...execCutDelivery(created),
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
export function codexInlineCapturePaths(toolName: string, output: unknown): string[] {
  // A harness call's image is a host capture the host already saved and named (turn-tools/control-server.ts
  // harnessResultWithImages): an observation for the model, never a second copy bound as a run output.
  if (/^(?:mcp__)?agentlas[-_]turn(?:\.|__)/u.test(toolName)) return [];
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
