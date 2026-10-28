import { carryRunnerTurnContext, deliverUnboundTurnContext, extendRunnerTurnContext } from "./runner-turn-context-binding";
import { composeTracedPrompt, restoreTracedPrompt, type PromptCompositionTrace } from "./prompt-composition-trace";
import { composeDeclaredPrompt, type DeclaredPromptPart } from "./prompt-order";
import type { HistoryRuntimeFence } from "../one/history-runtime-fences";
import type { AgentContextCapability } from "./agent-context";
import { assertScienceRecoveryRequest } from "../science-host/recovery-authority";
// 모든 런타임(CLI 3종 + BYOK 3종)이 구현해야 하는 통합 인터페이스.
// mcp/client.ts가 활성 런타임 → 적절한 러너로 라우팅한다.
import { runtimeNativeAbilitiesLine } from "./native-capabilities";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { featureIsNative } from "../harness/feature-registry";
import type { ChatHistoryEntry, ImageAttachment, McpInvocationEvent } from "../../shared/types";
import type { ToolInvocationOrigin } from "../../shared/tool-invocation-origin";
import type { RuntimeToolKind } from "../../shared/runtime-tool-kind";
import type { InvocationPlan } from "../../shared/invocation-plan";
import { tStatus, type RuntimeLocale } from "./status-i18n";
import { composePrompt, ASK_LINE_CHOICE, type PluginCatalog } from "./prompt-modules";
import { installedPluginCatalog, explicitPluginRouterPrompt } from "../plugins/router-prompt";
import { installedAgentlasCapabilityProviders } from "../plugins/plugin-candidates";
import { preferredProviderPairs } from "../../shared/capability-priority";
import { validSiteAgentAppMcpGrantTools } from "../site/agent-app-tool-policy";
import { isJudgmentRefusal } from "./judgment-refusal";
import {
  WORK_PROJECT_RESIDENCY_BUSY_CODE,
  runnerRefusedBeforeDispatch as preDispatchRunnerRefused,
  runnerResultRefusedBeforeDispatch as preDispatchRunnerResultRefused,
} from "./runner-pre-dispatch";
import { innermostTypedCode, isTypedCode } from "../../shared/turn-settlement";

/** Main-only delivery boundary; never serialized into a provider request. */
export type BeforeMcpToolResult = (input: {
  catalogId: string | null; toolName: string; isError: boolean;
}) => Promise<void>;

/** A Main-owned durable mailbox; text has user authority, never system authority. */
export type RunnerOwnerControlDeliveryPhase = "current-boundary" | "episode-terminal";
export interface RunnerOwnerControlInbox {
  /** Queue input is eligible only at a positively completed episode terminal. */
  take(phase?: RunnerOwnerControlDeliveryPhase): Array<{ intentId: string; text: string }>;
  settle(intentIds: string[], status: "applied" | "rejected" | "uncertain", code?: string): void;
}

export interface RunnerRequest {
  ownerControlInbox?: RunnerOwnerControlInbox;
  /** Private Host port; canonical task/checkpoint/action identities survive model changes. Main's MainWorkRecoveryContext, or the
   * relay port a receiving host minted for it (local-model-hub/work-recovery-relay.ts). */
  canonicalWorkRecovery?: import("../invocation/main-work-recovery").MainWorkRecoveryPort;
  /** Awaited before an MCP result can reach the next provider dispatch. */
  beforeMcpToolResult?: BeforeMcpToolResult;
  /** Native exact-run closure, never serialized into a provider/CLI request. */
  historyRuntimeFence?: HistoryRuntimeFence;
  /** Main-minted exact-run recovery authority; never accepted from renderer JSON. */
  scienceRecoveryCapability?: object;
  /** Main-minted object identity; JSON/renderer input cannot authorize collection. */
  scienceCollectionCapability?: object;
  /** Main-authored Plan ceiling; mutation cannot be approved within this run. */
  planMode?: true;
  /** Main-minted only for exact Science invocations; never copied from renderer input. */
  sciencePromptProfile?: true;
  systemPrompt: string;
  /** Host-authored Build/Main composition data; carries no permission or execution grant. */
  systemPromptComposition?: PromptCompositionTrace;
  history: ChatHistoryEntry[];
  userPrompt: string;
  /** Main-owned original user text for managed-local surface selection only. */
  surfaceUserPrompt?: string;
  /** 첨부 이미지 — BYOK/Ollama는 멀티모달, CLI는 로컬 파일로 스테이징 */
  images?: ImageAttachment[];
  /** 사용자에게 보일 라벨 — "Claude Code CLI" / "Anthropic API" / "Ollama · llama3.1" */
  backendLabel: string;
  /** Exact executable selected by runtime detection. Provider runners must not re-resolve a sibling CLI. */
  runtimeSource?: string;
  /** ollama·BYOK 등 모델 선택이 필요한 LLM의 활성 모델 이름. 그 외엔 미설정 */
  model?: string;
  /** BYOK 긴 컨텍스트(1M) opt-in. Agentlas-managed 러너(BYOK/Ollama)만 사용. */
  longContext?: boolean;
  /** 작업량(reasoning effort) — Claude Code `--effort`로 전달. 그 외 러너는 무시. */
  effort?: string;
  /** Host-owned generation ceiling for compact control envelopes. */
  maxOutputTokens?: number;
  /** Nested/control calls return data to their parent and never own a user Surface. */
  surfaceGate?: "auto" | "exclude";
  /**
   * 최종 답의 형태를 **계약으로** 못박는다. 지원 런타임은 CLI 플래그로 강제하고
   * (claude·grok·agy `--json-schema`, codex `--output-schema <FILE>`), OpenAI 호환
   * 로컬 런타임은 `response_format`(json_schema)로 제약 디코딩을 건다.
   *
   * ★왜 필요한가. 판정·화면생성·진화제안은 답 안에서 구조를 **파싱**해 왔고, 자유
   * 서술이라 형식이 깨지면 조용히 사라졌다 — 로컬 모델에서 "완료라는데 결과물이
   * 없음"의 정체가 이것이다(실측 2026-08-08 붕괴 기록). 제약 디코딩은 모델이 문법상
   * 틀린 토큰을 뱉을 수 없게 만들므로, 형식 붕괴는 능력 문제가 아니라 배선 문제가 된다.
   *
   * 지원하지 않는 런타임에서는 **조용히 무시하지 않는다** — 러너가 지시문 폴백을
   * 쓰고, 그 사실이 실행 상태줄에 남는다(정직한 강등).
   */
  outputSchema?: {
    /** 스키마 이름 — 일부 프로바이더가 요구한다(OpenAI response_format). */
    name: string;
    schema: Record<string, unknown>;
  };
  /** 실행 취소 신호 — abort 시 CLI 러너는 자식 프로세스 kill, API 러너는 fetch abort. */
  signal?: AbortSignal;
  /**
   * 실행 슬롯 우선순위 — interactive(사람이 기다리는 채팅 턴) > background(자동화·그래프·스웜).
   * 미설정이면 호출 문맥(runtime/run-priority.ts 의 withRunPriority)에서 읽고, 그마저 없으면
   * interactive 다. 자동화 스케줄러 같은 무인 진입점만 background 를 단다 — 렌더러/모델
   * 입력에서 파생하지 않는다(사람 턴을 스스로 강등하는 요청은 없어야 한다).
   */
  runPriority?: import("./run-priority").RunPriority;
  /** 도구 사용 권한 — read(읽기) / write(편집) / full(셸·외부). 런타임 권한 모드로 매핑. */
  permission?: "read" | "write" | "full";
  /** Main-authored graph dry-run marker. Runners may use a stricter isolated tool mode. */
  simulation?: true;
  /**
   * Main-authored browser-only execution boundary. The model may use only the
   * Agentlas-owned browser MCP; shell, arbitrary Playwright, filesystem and
   * provider-native browser tools must be denied before execution.
   */
  browserOnly?: true;
  /**
   * Main-authored: this run's owner explicitly selected Computer Use (tool mode
   * "computer-use"). Only then may an unattended or browser-only run reach a
   * runtime's own vendor desktop-control surfaces (codex-desktop-surface.ts).
   */
  desktopControlGrant?: true;
  /**
   * Main이 무인 read 자동화(다단계 오케스트레이션)에만 부여하는 실행 경계. renderer/wire 입력에서 받지 않는다.
   * Main 은 쓸 수 없는 실행(permission read)에만 단다. 각 실행기는 설정된 권한을 자기 read 수단으로 옮겨 돌고 거절하지
   * 않는다(shared/runtime-capabilities.ts readMechanism). 단계는 프로젝트 폴더(cwd)에서 돌아 read 도구로 파일을 읽는다.
   * 프롬프트는 restricted 프로필(읽기·검색 허용, 변경 금지 — prompt-modules.ts RESTRICTED_READ_LINE), 단계 출력의 기억 제어
   * 블록은 지운다. 진짜 무도구 실행은 untrustedNoTools 이고 그쪽이 우선한다(wrapSystemPrompt).
   */
  restrictedReadBoundary?: true;
  /** Main-authored marker for scheduled/background execution. Resume failure must fail closed
   * instead of silently creating a fresh CLI conversation. */
  unattended?: true;
  /** Interactive remote surface can show durable Decisions but cannot answer a blocking host tool call. */
  noSynchronousAsk?: true;
  /** Main-authored: nobody can answer a question in this run. Set by the same decision that adds
   * UNATTENDED_NO_ASK_DIRECTIVE and withholds ask_form (mcp/client.ts), never from renderer/model input.
   * The team orchestrators (borrowed-task-force, firm-orchestrator, swarm-run) set it on every worker turn too:
   * a worker's questions belong to its orchestrator (owner 2026-10-16), and withholdTurnAskForRun takes ask_form away.
   * wrapSystemPrompt then omits the system `ask:` module, so no channel offers an ask the run cannot use. */
  unattendedNoAsk?: true;
  /** Stable configuration identity for durable unattended sessions. Mutable routing/tool
   * overlays stay in the prompt but do not force a new CLI conversation every run. */
  sessionFingerprintSeed?: string;
  /**
   * 이번 턴에만 유효한 호스트 주입 컨텍스트(메모리 캡슐·온톨로지·MCP 자동선택·브리핑 게이트 등).
   * 시스템 프롬프트와 분리해 두어야 세션 지문이 턴마다 바뀌지 않는다. 세션 지원 러너는
   * 새 세션이면 시스템 프롬프트 뒤에 붙이고, resume 턴이면 사용자 메시지 앞에 싣는다
   * (resume에서는 시스템 프롬프트가 재전송되지 않는다).
   */
  turnContext?: string;
  /**
   * turnContext 안에서 세션 동안 바뀌지 않는 블록들(기억 이벤트 규약·목표 계약·대기 규약·프로젝트 지침 등).
   * 세션 지원 러너는 resume 턴에서 최근에 이미 보낸 같은 블록을 생략한다 — 대화 기록에 이미 있어 모델이 알고 있고,
   * 매 턴 다시 실으면 세션이 길어질수록 같은 규약 사본이 기록에 쌓인다(2026-09-14 실측: 턴당 3~4KB).
   */
  turnContextStable?: readonly string[];
  /**
   * Observability only: how the host split this request before placement folded the per-turn context into the
   * system tail or user message. hostContextText is transient custody evidence; the ledger verifies it against the
   * final body before retaining it. No runner may use these hints to build or change a prompt.
   */
  ledgerHints?: { hostContextTokens: number; hostContextPlacement: string; ownerTextTokens: number; hostContextText?: string };
  /**
   * 에이전트가 실제로 실행될 작업 디렉터리(= 사용자가 지정한 프로젝트/워킹 폴더).
   * 미설정이면 러너가 안전한 기본 폴더(agentRunCwd)를 쓴다. 파일 생성·빌드는 이 폴더에서 일어난다.
   */
  cwd?: string;
  /**
   * MCP config path, or a Main-validated inline JSON object for restricted
   * Agent Apps. The Claude runner snapshots that JSON to a private per-run
   * file only for Windows `.cmd` shims, whose argv ceiling cannot carry it.
   */
  mcpConfigPath?: string;
  /** Ignore provider-global MCP/plugins and admit only Main's per-run config. */
  isolatedMcpConfig?: true;
  /**
   * Main-authored: `mcpConfigPath` is an owner-issued grant (Science / Alive Science) whose
   * catalog is the whole tool surface. Host-loop runtimes must not add Desktop builtins beside
   * it — the grant already bridges the Desktop tools it admits. Ordinary One/Work MCP configs
   * leave this unset so the host loop gives the same builtins every in-process runtime gets.
   */
  mcpGrantCatalogOnly?: true;
  /**
   * Main-authored: this run's tool authority is a single-use, per-run grant (Science: a fresh token and config file per
   * invocation, revoked when the turn settles). Such a process can never serve the next turn, so it is never pooled.
   * Measured 2026-09-20: a Science loop left one resident CLI (~0.5 GB with its MCP child) per turn, each holding a dead token.
   * Continuity is unaffected: it comes from --resume / history, not from residency.
   * Since 2026-09-21 only plan-mode, criterion-review and pre-session Science grants are per-run; a normal Science turn
   * carries a session grant (same token/config across turns) and is pooled like any chat.
   */
  ephemeralToolGrant?: true;
  /** A root Science controller run: its Codex session compacts earlier (see scienceCompactionArgs in codex.ts). */
  scienceController?: true;
  /**
   * Main-authored: this run has no next turn (a throwaway chat id, e.g. the post-turn memory review). Pooling it parks a
   * CLI nobody can lease again until the 12h idle reap. Measured 2026-09-20: a Science loop left one resident claude
   * (~0.2 GB plus its plugin MCP children) per reviewed turn -- 6 after 40 minutes.
   */
  singleUse?: true;
  /** 위 구성의 MCP 툴 이름 prefix 목록(예: "mcp__playwright"). write/full 권한에서 자동 승인용. */
  mcpAllowedTools?: string[];
  /**
   * 커넥터 C38 — 도구 호출 **직전**에 도는 관문 설정 파일. Main이 노드별로 만들어 넘긴다.
   * 위 `mcpAllowedTools`는 허용만 하고 거절을 못 하므로, 선언되지 않은 호출과 시뮬레이션 중
   * 바깥을 바꾸는 호출을 실제로 막는 곳은 여기뿐이다. 모델도 렌더러도 이 값을 만들 수 없다.
   */
  toolBrokerSettingsPath?: string;
  /**
   * grok 의 도구 관문 — `--plugin-dir <DIR>` 로 넘길 디렉터리.
   * claude 의 `--settings` 와 같은 자리이고, 같은 훅 스크립트·같은 stdout 계약을 쓴다.
   */
  toolBrokerPluginDir?: string;
  /** Codex CLI `exec`에 붙이는 MCP config override args (`-c mcp_servers...`). */
  mcpCodexConfigArgs?: string[];
  /** Agentlas-resolved environment: agent .env first, then global multimodal fallback/vault. */
  env?: NodeJS.ProcessEnv;
  /**
   * Main-authored boundary for browser-originated Agent App requests. CLI
   * runners must disable every built-in/custom/MCP tool, ignore local rules and
   * memory, avoid session persistence, and fail closed if they cannot prove it.
   */
  untrustedNoTools?: boolean;
  /**
   * 이 무도구 실행이 **판정**인가(사용자가 이미 가진 텍스트를 라벨/채점표로 분류).
   *
   * untrustedNoTools 하나로는 두 가지가 구분되지 않아, 세션 영속을 이유로 Agent App 을
   * 거절하던 런타임(grok)이 판정까지 함께 막았다. 그 결과 그 런타임만 쓰는 사용자는 제품의
   * 모든 검증이 죽는다 — 자동화가 산출물을 정확히 만들어도 채점에서 EVAL_UNAVAILABLE 로
   * 떨어져 실행 전체가 error 가 된다(agy 에서 실측, 2026-08-19).
   *
   * 판정은 브라우저 입력을 대신 실행하는 것이 아니라 분류 한 번이라, 세션 기록이 남는
   * 런타임에도 허용된다. 도구 경계는 여전히 인자로 강제한다.
   */
  judgmentOnly?: boolean;
  /** Exact main-minted read-only MCP tools allowed despite the zero-builtins boundary. */
  untrustedAllowedMcpTools?: string[];
  /**
   * Main-minted, digest-bound Workforce authority. This is metadata for the
   * runtime to verify against the exact config/argv it actually admits; the
   * model and renderer can never author it.
   */
  workforceRuntimeToolGrant?: WorkforceRuntimeToolGrant;
  /** Internal one-shot marker preventing recursive Agent App MCP fallback. */
  agentAppMcpFallbackAttempted?: true;
  /** Main-only callback used to reconcile the browser-safe capability receipt. */
  onAgentAppMcpRuntimeUnavailable?: () => void;
  /**
   * 현재 chat 식별자 — 세션 resume를 지원하는 러너가 (chatId, kind)별 CLI 세션을
   * 재사용해 시스템 프롬프트/히스토리를 매 턴 재전송하지 않도록 한다. 미설정이면 매번 full-context.
   */
  chatId?: string;
  /** Main-authored Work project residency partition; never replaces chatId as a session key. */
  workProjectId?: string | null;
  /**
   * Live tool-approval cards belong to the visible parent conversation, which
   * may differ from an internal child session's `chatId`. Main alone authors
   * this routing hint; it changes no session, sandbox, or capability scope.
   */
  approvalChatId?: string;
  /**
   * Main-only Codex approval reviewer. Internal Taskforce workers have no
   * renderer of their own, so an explicitly tool-required packet may route
   * approval prompts through Codex's bounded automatic reviewer. Ordinary
   * interactive turns stay user-reviewed.
   */
  approvalsReviewer?: "user" | "auto_review";
  /**
   * 실행 중인 에이전트 — 도구 승인 요청(RuntimeToolPermissionAsk)에 실려
   * 에이전트 스코프 능력 규칙(capability_grants)의 대상이 된다.
   */
  agentId?: string;
  /**
   * Internal session-slot identity when several runtime conversations belong
   * to one visible chat and one agent (for example Taskforce planner, worker,
   * verifier, and synthesis turns). This changes only the runtime-session
   * storage key; capability, approval, and UI attribution continue to use
   * `agentId`.
   */
  runtimeSessionOwnerId?: string;
  /** Opaque host-authorized persistent context; never accepted from IPC/JSON. */
  agentContext?: AgentContextCapability;
  /**
   * Main-issued read-only effect observation (claude-code): one look, not a conversation turn. The
   * runner replaces the system prompt instead of appending to the user's CLI setup, loads no user or
   * project settings/plugins, keeps only the read built-ins, and does not persist a session.
   * Measured 2026-09-24: 150-500k input tokens per look with the full One/Work context.
   */
  minimalObservation?: boolean;
  /** Firm/resolved-org node identity used only to map runtime lifecycle events back to the UI tree. */
  orchestrationAgentId?: string;
  /**
   * 임시/비채팅 표면(Build 등)이 직접 넘기는 CLI 세션 id. 설정되면 러너는 가능한 경우 이 세션에서
   * 이어가고, 결과의 sessionId를 호출자가 다음 턴에 보관한다.
   */
  runtimeSessionId?: string;
  /** 2차 패스 플래그 — 모델이 surface-intent 마커를 emit해 dispatch가 재호출할 때 SURFACE_PROTOCOL 강제 로드. */
  forceSurface?: boolean;
  /** 상태/오류 메시지 i18n에 사용. renderer가 동봉, fallback "en" */
  locale: RuntimeLocale;
}

export interface WorkforceRuntimeToolGrant {
  schemaVersion: "agentlas.desktop-workforce-runtime-tool-grant.v1";
  permissionPolicyDigest: string;
  toolInventoryDigest: string;
  grantedToolIds: string[];
  expectedServerConfigKeys: string[];
  canonicalConfigSha256: string | null;
  runtimeVersion: string | null;
}

export interface WorkforcePermissionEnforcementReceipt {
  permissionPolicyDigest: string;
  enforcementMode: "native-sandbox" | "no-authority-sandbox" | "zero-tools" | "host-native" | "host-broker";
  status: "enforced";
  approvalReceiptIds: string[];
  enforcementEvidence: {
    runtimeKind: string;
    runtimeVersion: string | null;
    sandboxMode: "read-only" | "no-filesystem" | "host-native" | "host-broker" | "not-applicable";
    toolInventory: "empty" | "non-authoritative" | "policy-filtered" | "host-observed" | "broker-observed";
    hostObservation?: WorkforceHostObservation;
    brokerObservation?: import("./workforce-broker").WorkforceBrokerObservation;
    disabledCapabilities: string[];
    ephemeral: boolean;
    ignoredUserConfig: boolean;
    ignoredRules: boolean;
    toolInventoryDigest: string;
    grantedToolIds: string[];
  };
}

/** Native protocol observations, collected by the runner rather than authored by a model.
 * toolIds cover inventoryScope only; they never imply unobserved built-in isolation.
 */
export interface WorkforceHostObservation {
  schemaVersion: "agentlas.workforce-host-observation.v1";
  permissionPolicyDigest: string;
  toolInventoryDigest: string;
  runtimeKind: string;
  runtimeVersion: string;
  sessionId: string;
  turnId: string;
  nativePolicy: Record<string, unknown>;
  toolIds: string[];
  connectedServers: string[];
  approvalEvents: Array<{ requestId: string; decision: string }>;
  completed: true;
  inventoryScope: "connected-mcp-tools" | "native-init-tools";
  nativeToolsEnumerated: boolean;
  requestedConfigDigest: string | null;
  inventoryEvidence?: WorkforceHostInventoryEvidence;
  observationDigest: string;
}

/** Descriptor fingerprints are native observations, not endpoint attestations.
 * Only connected tools count as available; cached descriptors remain fingerprints.
 */
export interface WorkforceHostInventorySnapshot {
  toolIds: string[];
  connectedServers: string[];
  serverStates: Array<{
    name: string;
    runtimeStatus: string;
    toolsDigest: string;
    serverInfoDigest: string;
    toolsError: boolean;
  }>;
  selectedBindings: Array<{ toolId: string; serverName: string; descriptorDigest: string }>;
  selectedServers: Array<{ name: string; serverInfoDigest: string }>;
  inventoryDigest: string;
  selectedBindingDigest: string;
}

export interface WorkforceHostInventoryEvidence {
  schemaVersion: "agentlas.workforce-host-inventory-observation.v1";
  stability: "selected-grant-bindings";
  before: WorkforceHostInventorySnapshot;
  after: WorkforceHostInventorySnapshot;
}

export function workforceHostObservationDigest(
  value: Omit<WorkforceHostObservation, "observationDigest">,
): string {
  return workforceObservationValueDigest(value);
}

function workforceObservationValueDigest(value: unknown): string {
  const canonical = (row: unknown): unknown => {
    if (Array.isArray(row)) return row.map(canonical);
    if (!row || typeof row !== "object") return row;
    return Object.fromEntries(Object.keys(row).sort().map((key) => [
      key, canonical((row as Record<string, unknown>)[key]),
    ]));
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex")}`;
}

const WORKFORCE_SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const WORKFORCE_TOOL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.$:/@+~-]{0,127}$/;

/** Check the measured inventory window separately from the native policy.
 * Host authority permits unrelated tools to connect; selected bindings must
 * be available with identical fingerprints at both observation boundaries.
 */
function validWorkforceInventoryEvidence(
  observation: WorkforceHostObservation,
  grant: WorkforceRuntimeToolGrant,
): boolean {
  const window = observation.inventoryEvidence;
  if (window === undefined) return true;
  const object = (value: unknown): value is Record<string, any> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const keys = (value: unknown, expected: string[]) => object(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
  const ordered = (values: unknown, max: number): values is string[] =>
    Array.isArray(values) && values.length <= max && values.every((value, index) =>
      typeof value === "string" && WORKFORCE_TOOL_ID_RE.test(value) &&
      (index === 0 || values[index - 1] < value));
  const same = (a: unknown, b: unknown) => workforceObservationValueDigest(a) === workforceObservationValueDigest(b);
  if (observation.runtimeKind !== "codex" || observation.inventoryScope !== "connected-mcp-tools" ||
    !keys(window, ["schemaVersion", "stability", "before", "after"]) ||
    window.schemaVersion !== "agentlas.workforce-host-inventory-observation.v1" ||
    window.stability !== "selected-grant-bindings") return false;
  for (const snapshot of [window.before, window.after]) {
    if (!keys(snapshot, ["toolIds", "connectedServers", "serverStates", "selectedBindings", "selectedServers", "inventoryDigest", "selectedBindingDigest"]) ||
      !ordered(snapshot.toolIds, 4096) || !ordered(snapshot.connectedServers, 256) ||
      !Array.isArray(snapshot.serverStates) || !Array.isArray(snapshot.selectedBindings) || !Array.isArray(snapshot.selectedServers) ||
      !ordered(snapshot.serverStates.map((row) => row?.name), 256) ||
      !ordered(snapshot.selectedBindings.map((row) => row?.toolId), 128) ||
      !ordered(snapshot.selectedServers.map((row) => row?.name), 64)) return false;
    const states = new Map<string, WorkforceHostInventorySnapshot["serverStates"][number]>();
    for (const state of snapshot.serverStates) {
      if (!keys(state, ["name", "runtimeStatus", "toolsDigest", "serverInfoDigest", "toolsError"]) ||
        !["notStarted", "starting", "connected", "authenticationRequired", "failed", "cancelled", "disabled"].includes(state.runtimeStatus) ||
        !WORKFORCE_SHA256_RE.test(state.toolsDigest) || !WORKFORCE_SHA256_RE.test(state.serverInfoDigest) ||
        typeof state.toolsError !== "boolean") return false;
      states.set(state.name, state);
    }
    const connected = snapshot.serverStates.filter((row) => row.runtimeStatus === "connected" && !row.toolsError).map((row) => row.name);
    if (!same(snapshot.connectedServers, connected)) return false;
    for (const toolId of snapshot.toolIds) {
      if (!snapshot.connectedServers.some((name) => toolId.startsWith(`mcp__${name}__`) && toolId.length > name.length + 7)) return false;
    }
    for (const binding of snapshot.selectedBindings) {
      if (!keys(binding, ["toolId", "serverName", "descriptorDigest"]) ||
        !WORKFORCE_SHA256_RE.test(binding.descriptorDigest) ||
        !snapshot.toolIds.includes(binding.toolId) || !snapshot.connectedServers.includes(binding.serverName) ||
        !binding.toolId.startsWith(`mcp__${binding.serverName}__`) ||
        binding.toolId.length <= binding.serverName.length + 7) return false;
    }
    if (!same(snapshot.selectedBindings.map((row) => row.toolId), [...grant.grantedToolIds].sort())) return false;
    const expectedServers = [...new Set([...grant.expectedServerConfigKeys, ...snapshot.selectedBindings.map((row) => row.serverName)])].sort();
    if (!same(snapshot.selectedServers.map((row) => row.name), expectedServers)) return false;
    for (const server of snapshot.selectedServers) {
      if (!keys(server, ["name", "serverInfoDigest"]) || !snapshot.connectedServers.includes(server.name) ||
        server.serverInfoDigest !== states.get(server.name)?.serverInfoDigest) return false;
    }
    if (snapshot.inventoryDigest !== workforceObservationValueDigest({
      toolIds: snapshot.toolIds, connectedServers: snapshot.connectedServers, serverStates: snapshot.serverStates,
    }) || snapshot.selectedBindingDigest !== workforceObservationValueDigest({
      selectedBindings: snapshot.selectedBindings, selectedServers: snapshot.selectedServers,
    })) return false;
  }
  return window.before.selectedBindingDigest === window.after.selectedBindingDigest &&
    same(observation.toolIds, window.after.toolIds) && same(observation.connectedServers, window.after.connectedServers);
}

function validatedWorkforceGrant(req: RunnerRequest): WorkforceRuntimeToolGrant | null {
  const grant = req.workforceRuntimeToolGrant;
  if (!grant) return null;
  if (
    grant.schemaVersion !== "agentlas.desktop-workforce-runtime-tool-grant.v1" ||
    !WORKFORCE_SHA256_RE.test(grant.permissionPolicyDigest) ||
    !WORKFORCE_SHA256_RE.test(grant.toolInventoryDigest) ||
    grant.grantedToolIds.length > 128 ||
    new Set(grant.grantedToolIds).size !== grant.grantedToolIds.length ||
    grant.grantedToolIds.some((toolId) => !WORKFORCE_TOOL_ID_RE.test(toolId)) ||
    grant.expectedServerConfigKeys.length > 64 ||
    new Set(grant.expectedServerConfigKeys).size !== grant.expectedServerConfigKeys.length ||
    grant.expectedServerConfigKeys.some((key) => !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(key)) ||
    (grant.canonicalConfigSha256 !== null && !WORKFORCE_SHA256_RE.test(grant.canonicalConfigSha256))
  ) {
    throw new Error("workforce_runtime_tool_grant_invalid");
  }
  return grant;
}

/** Runtime-owned receipt for a verified stateless API/CLI with no tool surface. */
export function workforceZeroToolsEnforcement(
  req: RunnerRequest,
  runtimeKind: string,
  disabledCapabilities: string[],
): WorkforcePermissionEnforcementReceipt | undefined {
  const grant = validatedWorkforceGrant(req);
  if (!grant) return undefined;
  if (
    grant.grantedToolIds.length !== 0 ||
    grant.expectedServerConfigKeys.length !== 0 ||
    grant.canonicalConfigSha256 !== null
  ) {
    throw new Error("workforce_zero_tools_grant_not_empty");
  }
  return {
    permissionPolicyDigest: grant.permissionPolicyDigest,
    enforcementMode: "zero-tools",
    status: "enforced",
    approvalReceiptIds: [],
    enforcementEvidence: {
      runtimeKind,
      runtimeVersion: grant.runtimeVersion,
      sandboxMode: "no-filesystem",
      toolInventory: "empty",
      disabledCapabilities: [...new Set(disabledCapabilities)],
      ephemeral: true,
      ignoredUserConfig: true,
      ignoredRules: true,
      toolInventoryDigest: grant.toolInventoryDigest,
      grantedToolIds: [],
    },
  };
}

/**
 * Runtime-owned receipt for a host-authority row (policy `host`, 2026-09-05): the run
 * executed under the host's own permission mode and capability grants, not a sandbox.
 * Evidence is honest about that — nothing was made ephemeral or ignored.
 */
export function workforceHostAuthorityEnforcement(
  req: RunnerRequest,
  runtimeKind: string,
): WorkforcePermissionEnforcementReceipt | undefined {
  const grant = validatedWorkforceGrant(req);
  if (!grant) return undefined;
  return {
    permissionPolicyDigest: grant.permissionPolicyDigest,
    enforcementMode: "native-sandbox",
    status: "enforced",
    approvalReceiptIds: [],
    enforcementEvidence: {
      runtimeKind,
      runtimeVersion: grant.runtimeVersion,
      sandboxMode: "host-native",
      toolInventory: "policy-filtered",
      disabledCapabilities: [],
      ephemeral: false,
      ignoredUserConfig: false,
      ignoredRules: false,
      toolInventoryDigest: grant.toolInventoryDigest,
      grantedToolIds: [...grant.grantedToolIds],
    },
  };
}

/** Admit only an invocation-bound native observation. Runtime-specific adapters
 * must compare the acknowledged native policy with the requested host boundary.
 * This receipt describes observed host authority, never a package sandbox.
 */
export function workforceObservedHostAuthorityEnforcement(
  req: RunnerRequest,
  runtimeKind: string,
  observation: WorkforceHostObservation,
): WorkforcePermissionEnforcementReceipt | undefined {
  const grant = validatedWorkforceGrant(req);
  if (!grant) return undefined;
  const { observationDigest, ...payload } = observation;
  const validIds = (values: string[], max: number) => Array.isArray(values) &&
    values.length <= max && new Set(values).size === values.length &&
    values.every((value) => typeof value === "string" && WORKFORCE_TOOL_ID_RE.test(value));
  if (
    observation.schemaVersion !== "agentlas.workforce-host-observation.v1" ||
    observation.permissionPolicyDigest !== grant.permissionPolicyDigest ||
    observation.toolInventoryDigest !== grant.toolInventoryDigest ||
    observation.runtimeKind !== runtimeKind ||
    !observation.runtimeVersion?.trim() || observation.runtimeVersion.length > 256 ||
    !observation.sessionId?.trim() || observation.sessionId.length > 256 ||
    !observation.turnId?.trim() || observation.turnId.length > 256 ||
    observation.completed !== true || req.signal?.aborted ||
    !observation.nativePolicy || typeof observation.nativePolicy !== "object" ||
    Array.isArray(observation.nativePolicy) || Object.keys(observation.nativePolicy).length === 0 ||
    !validIds(observation.toolIds, 4096) || !validIds(observation.connectedServers, 256) ||
    !["connected-mcp-tools", "native-init-tools"].includes(observation.inventoryScope) ||
    observation.nativeToolsEnumerated !== (observation.inventoryScope === "native-init-tools") ||
    observation.requestedConfigDigest !== grant.canonicalConfigSha256 ||
    !Array.isArray(observation.approvalEvents) || observation.approvalEvents.length > 256 ||
    observation.approvalEvents.some((event) => !event.requestId?.trim() ||
      event.requestId.length > 256 || !event.decision?.trim() || event.decision.length > 128) ||
    grant.grantedToolIds.some((id) => !observation.toolIds.includes(id)) ||
    grant.expectedServerConfigKeys.some((name) => !observation.connectedServers.includes(name)) ||
    !validWorkforceInventoryEvidence(observation, grant) ||
    !WORKFORCE_SHA256_RE.test(observationDigest) ||
    observationDigest !== workforceHostObservationDigest(payload)
  ) throw new Error("workforce_host_observation_invalid");
  return {
    permissionPolicyDigest: grant.permissionPolicyDigest,
    enforcementMode: "host-native",
    status: "enforced",
    approvalReceiptIds: [],
    enforcementEvidence: {
      runtimeKind,
      runtimeVersion: observation.runtimeVersion,
      sandboxMode: "host-native",
      toolInventory: "host-observed",
      disabledCapabilities: [],
      ephemeral: false,
      ignoredUserConfig: false,
      ignoredRules: false,
      toolInventoryDigest: grant.toolInventoryDigest,
      grantedToolIds: [...grant.grantedToolIds],
      hostObservation: structuredClone(observation),
    },
  };
}

/** Runtime-owned receipt after exact config hash + connected-server/tool proof. */
export function workforceNativeToolEnforcement(
  req: RunnerRequest,
  runtimeKind: string,
  disabledCapabilities: string[],
): WorkforcePermissionEnforcementReceipt | undefined {
  const grant = validatedWorkforceGrant(req);
  if (!grant) return undefined;
  if (
    grant.grantedToolIds.length === 0 ||
    grant.expectedServerConfigKeys.length === 0 ||
    grant.canonicalConfigSha256 === null
  ) {
    throw new Error("workforce_native_tool_grant_empty");
  }
  return {
    permissionPolicyDigest: grant.permissionPolicyDigest,
    enforcementMode: "native-sandbox",
    status: "enforced",
    approvalReceiptIds: [],
    enforcementEvidence: {
      runtimeKind,
      runtimeVersion: grant.runtimeVersion,
      sandboxMode: "host-native",
      toolInventory: "policy-filtered",
      disabledCapabilities: [...new Set(disabledCapabilities)],
      ephemeral: true,
      ignoredUserConfig: true,
      ignoredRules: true,
      toolInventoryDigest: grant.toolInventoryDigest,
      grantedToolIds: [...grant.grantedToolIds],
    },
  };
}

/** Main-only handle for one confirmed provider turn; never accepted from IPC JSON. */
export interface RunnerNativeTurnBinding {
  readonly runtime: string;
  readonly chatId: string;
  readonly runtimeSessionOwnerId: string | null;
  readonly threadId: string;
  readonly turnId: string;
  readonly model: string | null;
  readonly permission: "read" | "write" | "full";
  readonly cwd: string;
}

export type RunnerNativeSteerResult =
  | { status: "accepted"; turnId: string }
  | { status: "rejected"; code: string; reason: string; rpcCode?: number }
  | { status: "uncertain"; code: string; reason: string; rpcCode?: number };

export interface RunnerNativeTurnController {
  readonly binding: Readonly<RunnerNativeTurnBinding>;
  steer(input: { requestId: string; text: string; expectedThreadId: string; expectedTurnId: string }): Promise<RunnerNativeSteerResult>;
}

/** Value-free driver observation; only the live controller object grants a send capability. */
export interface RunnerNativeControlState {
  readonly runtime: string;
  readonly driver: "unselected" | "app-server" | "exec";
  readonly phase: "pending" | "active" | "unavailable" | "withdrawn";
  readonly code: "native_control_pending" | "native_control_exec_boundary" | "native_control_unavailable" | "native_control_active" | "native_control_withdrawn";
}
/** Validate an observation before journaling. Getters, symbols/prototypes and
 * extra fields never enter value-free records; this still grants nothing. */
export function validatedRunnerNativeControlState(input: unknown): Readonly<RunnerNativeControlState> | null {
  try {
    if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return null;
    const keys = Reflect.ownKeys(input); if (keys.length !== 4 || keys.some(k => typeof k !== "string" || !["runtime", "driver", "phase", "code"].includes(k))) return null;
    const d = Object.getOwnPropertyDescriptors(input);
    if (keys.some(k => !d[k as string]?.enumerable || !("value" in d[k as string]))) return null;
    const runtime = d.runtime.value, driver = d.driver.value, phase = d.phase.value, code = d.code.value;
    // Only an executor whose registry connection for in-progress steering is native may mint a native-control observation.
    if (typeof runtime !== "string" || !featureIsNative("turn-steer", runtime)) return null;
    const allowed = phase === "pending" && ["unselected", "app-server"].includes(driver) && code === "native_control_pending"
      || phase === "active" && driver === "app-server" && code === "native_control_active"
      || phase === "unavailable" && (driver === "exec" && code === "native_control_exec_boundary" || driver === "app-server" && code === "native_control_unavailable")
      || phase === "withdrawn" && ["unselected", "app-server", "exec"].includes(driver) && code === "native_control_withdrawn";
    return allowed ? Object.freeze({ runtime, driver, phase, code }) : null;
  } catch { return null; }
}
export interface RunnerEvents {
  /** Published after exact native turn ACK; null synchronously withdraws this run's handle. */
  onNativeTurnController?: (controller: RunnerNativeTurnController | null, state?: Readonly<RunnerNativeControlState>) => void;
  /** 토큰 또는 줄 단위 partial 출력 */
  onPartial: (chunk: string) => void;
  /** 사용자에게 보일 상태 줄 — locale 적용된 완성 문자열 */
  onStatus: (status: string, activity?: McpInvocationEvent["activity"]) => void;
  /** 도구 호출/결과 — Claude Code식 tool-use/tool-result 블록 (이름 + 인자 JSON + 결과). 선택. */
  /**
   * `artifactPaths` is host-structured completion evidence, never parsed from
   * command/prose output. Main still opens and verifies every candidate before
   * it can reach One's Outputs rail.
   * `toolKind` is the typed kind when the runtime reports one (ACP `ToolCall.kind`, agy's native tool), so consumers never
   * classify a tool by its display name (shared/runtime-tool-kind.ts). Absent for runtimes with fixed native names.
   */
  onTool?: (name: string, args?: string, result?: string, id?: string, isError?: boolean, artifactPaths?: readonly string[], imageDataUrl?: string, origin?: ToolInvocationOrigin, toolKind?: RuntimeToolKind) => void;
  /** 라이브 누적 출력 토큰 — 스트리밍 중 "N tokens" 실시간 표시용. 단조 증가 값(usage 실측 + 추정). 선택. */
  onUsage?: (tokens: number) => void;
  /** One host-minted id per native turn dispatched inside this runner, including retries. */
  onRuntimeAttemptStarted?: (attemptId: string) => void;
  /** Provider usage detail the common receipt cannot carry (Anthropic cache creation, raw input). Observability only. */
  onModelUsageDetail?: (attemptId: string | undefined, detail: { cacheCreationInputTokens?: number; rawInputTokens?: number }) => void;
  /** Complete provider-reported pair for that native turn. Never estimated. */
  onTerminalObservedUsage?: (usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }, attemptId?: string) => void;
  /**
   * reasoning(thinking) 구간 신호 — 구간 시작/증분/종료. durationMs는 end에만(이번 구간 지속 ms).
   * `text`: delta면 이번 증분, end면 이 구간에서 러너가 이미 전문을 아는 경우(codex의
   * reasoning summary 아이템처럼 한 번에 오는 것) 그 전문. 없으면 생략 — 호스트가 delta를
   * 누적해 end에 전문을 붙인다. 선택.
   */
  onThinking?: (phase: "start" | "delta" | "end", durationMs?: number, text?: string) => void;
  /**
   * The runtime's own task checklist, from its structured protocol only (runtime-plan.ts). Each call is the complete
   * list and replaces the previous one. Runtimes without a native plan never call it. 선택.
   */
  onPlan?: (plan: InvocationPlan) => void;
  /**
   * ★호스트가 사용자에게 하는 말. 상태줄(onStatus)과 다르다 — 상태줄은 **지나가는** 값이고
   * 이건 대화에 **남아야 하는 사실**이다.
   *
   * 첫 소비자: 컨텍스트 압축. 예전에는 `onStatus("컨텍스트 압축 — …")` 한 줄로 지나가서
   * 사용자는 자기 대화가 잘렸다는 걸 알 수 없었다("왜 아까 말한 걸 잊었냐"의 절반).
   */
  onNotice?: (notice: {
    level: "info" | "success" | "warning" | "error";
    message: string;
    code?: string;
    /**
     * 같은 문장의 두 로케일 판본. `message` 는 이 실행의 로케일로 이미 렌더돼 있어
     * 다른 로케일 화면(모바일)이 붙어 보면 남의 언어가 그대로 뜬다. 만드는 자리에서
     * 두 벌을 내면 중계 지점이 고를 수 있다.
     */
    i18n?: { ko: string; en: string };
    /** divider면 좌우 선 사이의 라벨로 그린다(대화의 경계를 표시하는 사실). */
    display?: "row" | "divider";
  }) => void;
}

/**
 * ★런타임 실패의 종류 — 표식(marker) 기반. 텍스트 모양으로 성공을 판정하지 않기 위한 계약.
 *
 * 배경(2026-08-06 실측): claude CLI가 한도 소진을 스트림 표식(rate_limit_event →
 * is_error:true/429)으로 정확히 말했는데, 이 결과 계약에 실패 칸이 없어서 거절문
 * ("You've hit your weekly limit")이 text에 실려 정상 답 행세를 했다 — 판정 폴백이
 * 안 걸리고, 노드 산출물·챗 답변이 됐다. throw 아니면 텍스트, 두 상태뿐이었던 것이 뿌리다.
 */
/*
 * "quota" is an exhausted plan, credit balance or usage window (it lifts at a reset the provider names, or never without
 * the owner). "rate_limit" is transient request throttling (HTTP 429 without a plan verdict): it lifts by itself, the
 * same request may be retried after `retryAfterHint`, and shared/turn-settlement.ts bounds those retries (docs 31 W1;
 * audit A5 C8.1, opencode/pi split the two the same way).
 */
export type RunnerFailureKind = "quota" | "rate_limit" | "auth" | "refused" | "empty" | "exit" | "timeout" | "unavailable" | "unsupported";

export interface RunnerFailure {
  kind: RunnerFailureKind;
  /** 런타임 고지문 원문(잘라서). 지어내지 않는다 — 리셋 시각 같은 행동 단서가 들어 있다. */
  message: string;
  runtime: string;
  /**
   * 판정 출처. `heuristic`은 표식 없는 런타임(실측: codex 한도)용 최후 그물 —
   * 화면은 단정 대신 완곡하게 말하고, 원문은 저널에 보존해야 한다.
   */
  source: "marker" | "exit" | "heuristic";
  /** Provider-owned machine code, accepted only after a runner validates and bounds it. */
  providerCode?: string;
  /** Exact child exit status when the runner observed one; null/unknown is omitted. */
  exitCode?: number;
  /** 한도 리셋 시각 등 — 표식에 실려 오면 그대로. For "rate_limit", the provider's Retry-After (ISO time or "in 30s"). */
  retryAfterHint?: string;
}

export interface RunnerResult {
  /** Explicit missing terminal proof prevents the common harness from dispatching another episode. */
  ownerControlTerminal?: "completed" | "uncertain";
  /** Whether this turn reached the provider session (RuntimeTurnDelivery); absent = the runner cannot tell. A failure with
   * "not-dispatched" is a definite pre-dispatch refusal: hosts keep its provider code and never treat it as unsettled. */
  turnDelivery?: RuntimeTurnDelivery;
  text: string;
  /**
   * 실려 있으면 text는 답이 아니다(표시용 고지문일 수 있다). 소비자는 이 칸으로만
   * 실패를 판정한다 — 텍스트 길이·모양으로 판정하는 코드는 이 계약 위반이다.
   */
  failure?: RunnerFailure;
  /** Claude/Codex 같은 CLI 런타임이 반환한 재개 가능한 세션 id. */
  sessionId?: string;
  /** 생성 토큰 수 (가능한 런타임만) — 상태줄 표시용. */
  tokens?: number;
  /**
   * 이번 실행에 실제로 든 토큰. 모델 할당 영수증의 `usage` 칸을 채운다.
   *
   * 영수증 스키마는 non-null 일 때 입력·출력을 **둘 다** 요구한다. 그래서 출력만 아는
   * 런타임은 이 값을 아예 두지 않는다 — 입력을 0 으로 채우면 비용 판단이 망가진다.
   * 없는 것과 0 은 다르고, 없으면 `usage: null` 이 정직한 답이다(스키마도 허용한다).
   */
  observedUsage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  /** Input tokens of the turn's LAST model request (cached included): the context the next request starts from. */
  contextInputTokens?: number;
  /** The cached part of `contextInputTokens` (a subset of it, never added to it), when the runtime reports it. */
  contextCachedInputTokens?: number;
  /** The context window the runtime itself reported for this session (ACP usage_update size); the catalog's otherwise. */
  contextWindowTokens?: number;
  /** Exact effort explicitly applied by the runner; null means no explicit effort was sent. */
  appliedEffort?: string | null;
  /**
   * 이번 실행이 **실제로 쓴 모델 id**. 우리가 보낸 값이 벤더 별칭일 때만 의미가 있다
   * (claude-code 는 모델 목록 명령이 없어 `opus|sonnet|haiku` 별칭만 보낼 수 있다).
   * 값의 출처는 런타임이 돌려준 사실 하나뿐이라, 벤더가 세대를 올려도 저절로 따라간다.
   */
  observedModel?: string;
  /** Present only when a Workforce runtime has verified and enforced its main-minted grant. */
  workforcePermissionEnforcement?: WorkforcePermissionEnforcementReceipt;
  /**
   * The distinct tool calls this turn reported, set on a completed result whose final text is empty: the turn did its
   * work through its tools (shared/turn-settlement.ts settleNormalEnd, plan R-065). An empty `text` with
   * ownerControlTerminal "completed" and no failure is such a tool-only turn. Whether an empty final text is acceptable
   * is the caller's decision: a typed-output caller (handoff, planner, judgment, structured output, graph step result)
   * fails with its own typed reason; a chat or automation turn is complete.
   */
  toolCalls?: number;
}

/** No terminal receipt after dispatch is uncertainty, not permission to replay. */
export const RUNTIME_TURN_UNSETTLED_CODE = "runtime_turn_unsettled";
/**
 * The one shared typed fact "did this turn reach the provider session?", set by a runner from protocol/transport facts
 * only, never from prose (RunnerResult.turnDelivery; RuntimeTurnUnsettledError.turnDelivery; a thrown pre-dispatch
 * refusal may carry the same property).
 *  - "not-dispatched": refused before anything was sent (admission, preparation, a closed pre-send check). With a
 *    failure it is that failure: no model work happened, so it is never unsettled and its provider code is kept
 *    (runnerResultRefusedBeforeDispatch / runnerRefusedBeforeDispatch; observed-runner.ts and mcp/client.ts honor it).
 *  - "not-accepted": sent, but no acknowledgement of this turn was observed (the transport closed before the receipt).
 *  - "accepted": the session acknowledged this turn (receipt, its turn-started event, or its echoed client message id),
 *    so its request is in the transcript a continuation resumes (unsettled-continuation.ts does not re-send it).
 */
export type RuntimeTurnDelivery = "not-dispatched" | "not-accepted" | "accepted";
export class RuntimeTurnUnsettledError extends Error {
  readonly code = RUNTIME_TURN_UNSETTLED_CODE;
  /**
   * The native session/thread id the runner knew when the turn ended without its terminal event, when it knew one.
   * The host resumes this same conversation once (mcp/client.ts invokeCurrentRuntime); it is never read from prose.
   */
  readonly sessionId?: string;
  /** RuntimeTurnDelivery, when the runner observed it (an unsettled turn was dispatched, so never "not-dispatched"). */
  readonly turnDelivery?: Exclude<RuntimeTurnDelivery, "not-dispatched">;
  /**
   * `providerReason`: the provider's own final error for this turn when it sent one (e.g. "Selected model is at
   * capacity"). The owner saw only "no terminal receipt" while the real cause was a provider capacity refusal
   * (Yotube room, 2026-10-13 12:58Z), so the provider's words lead the message.
   */
  constructor(readonly runtimeKind: string, locale?: string, sessionId?: string | null, providerReason?: string | null,
    turnDelivery?: Exclude<RuntimeTurnDelivery, "not-dispatched">) {
    const reason = typeof providerReason === "string" ? providerReason.trim().slice(0, 300) : "";
    super(locale === "ko"
      ? `${reason ? `${runtimeKind}: ${reason} — ` : ""}${runtimeKind} 요청을 보낸 뒤 완료 영수증을 받지 못했습니다. 실행 여부가 불확실해 자동 재전송을 멈췄습니다. 작업 기록을 확인한 뒤 이어가세요.`
      : `${reason ? `${runtimeKind}: ${reason} — ` : ""}${runtimeKind} did not return a terminal receipt after dispatch. Automatic replay stopped because the request may have acted. Review the work history before continuing.`);
    this.name = "RuntimeTurnUnsettledError";
    if (typeof sessionId === "string" && sessionId.trim() && sessionId.length <= 256) this.sessionId = sessionId;
    if (turnDelivery === "accepted" || turnDelivery === "not-accepted") this.turnDelivery = turnDelivery;
  }
}

/**
 * A thrown runner rejection that is a typed refusal raised before anything was dispatched: the Work project's resident
 * owner is busy (its own code), or any error carrying turnDelivery "not-dispatched". It is that refusal, never an
 * unsettled turn: nothing reached a model, so there is nothing to continue, and the caller's handling (busy Goal sweep,
 * firm/swarm stop, provider fallback) must see the typed code.
 */
export const runnerRefusedBeforeDispatch = preDispatchRunnerRefused;

/** A returned failure the runner proved pre-dispatch (RuntimeTurnDelivery "not-dispatched"): keep it, never unsettled. */
export const runnerResultRefusedBeforeDispatch = preDispatchRunnerResultRefused;

/**
 * Puts RuntimeTurnDelivery "not-dispatched" on a refusal a runner or host wrapper throws before anything was sent (a
 * missing executable, a journal or admission refusal, a closed pre-send check) and returns it, so
 * runnerRefusedBeforeDispatch keeps its own code. Only for throws that precede every provider send.
 */
export function markRefusedBeforeDispatch<T>(error: T): T {
  if (error && typeof error === "object" && Object.isExtensible(error)) {
    try { Object.defineProperty(error, "turnDelivery", { value: "not-dispatched", enumerable: true, configurable: true, writable: true }); }
    catch { /* A sealed host error keeps its own code and the caller's previous handling. */ }
  }
  return error;
}

/**
 * A start or turn the host refused before anything reached a runtime, whose cause carries no machine code of its own
 * (a plain Error). Its `code` is the innermost machine code of the cause chain, the cause's own code-shaped message,
 * or `fallbackCode`; `turnDelivery` is "not-dispatched"; the original stays as the standard `cause`.
 */
export class PreDispatchRefusalError extends Error {
  readonly code: string;
  readonly turnDelivery = "not-dispatched" as const;
  constructor(code: string, message: string, cause: unknown, readonly stage?: string) {
    super(message);
    this.name = "PreDispatchRefusalError";
    this.code = code;
    Object.defineProperty(this, "cause", { value: cause, configurable: true, writable: true });
  }
}

/** The machine code a refusal reports outward: its innermost typed code, else a message that is itself a code. */
export function refusalCode(error: unknown): string | undefined {
  const typed = innermostTypedCode(error);
  if (typed) return typed;
  const message = error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  return isTypedCode(message) ? message : undefined;
}

/**
 * The outward code of a failure: an unknown-effect outcome (RuntimeTurnUnsettledError, RuntimeNoProgressError) keeps its
 * own protective code, which every replay guard reads; any other failure reports its innermost machine code.
 */
export function outwardFailureCode(error: unknown): string | undefined {
  if (error instanceof RuntimeTurnUnsettledError || error instanceof RuntimeNoProgressError) return error.code;
  return refusalCode(error);
}

/**
 * The one way a host wrapper reports a refusal before dispatch: the cause itself, marked "not-dispatched", when it
 * carries a machine code of its own; otherwise a PreDispatchRefusalError whose code is the cause's innermost code.
 * Never RuntimeTurnUnsettledError: nothing was sent, so nothing may have acted (docs 31 W1).
 */
export function preDispatchRefusal(cause: unknown, stage: string, fallbackCode = "pre_dispatch_refused"): Error {
  // A runner's own unsettled turn (a post-handoff custody failure) is never relabelled as not dispatched.
  if (cause instanceof RuntimeTurnUnsettledError) return cause;
  if (cause instanceof Error && isTypedCode((cause as { code?: unknown }).code) && Object.isExtensible(cause)) {
    return markRefusedBeforeDispatch(cause);
  }
  const message = cause instanceof Error ? cause.message : String(cause ?? fallbackCode);
  return new PreDispatchRefusalError(refusalCode(cause) ?? fallbackCode, message, cause, stage);
}

/** A process that could not be created for lack of a resource right now (descriptors, processes, memory): it clears by itself. */
export const RUNTIME_SPAWN_RESOURCE_BUSY_CODE = "runtime_spawn_resource_busy";
const SPAWN_RESOURCE_BUSY_ERRNOS: ReadonlySet<string> = new Set(["EMFILE", "ENFILE", "EAGAIN", "ENOMEM"]);

/**
 * A runner child that was never created: Node reports a failed spawn (ENOENT, EACCES, EMFILE, a deleted working folder...)
 * as an `error` event of a child with no pid, or throws it from `spawn()` itself (child null). Nothing of the turn reached
 * the CLI, so it is a refusal before dispatch, never RuntimeTurnUnsettledError ("the request may have acted"): the
 * send queue starts the message again, a borrowed worker session stays, and the cause is a code, not prose. Null when the
 * error is not a failed spawn (a live process's own error), so the caller keeps its previous handling.
 * Code: the working folder when that is what is gone (spawn reports ENOENT for it too), else the executable's state, a
 * transient resource shortage, or `<kind>_spawn_failed`. The raw errno error stays as the standard `cause`.
 */
export function spawnStartFailureRefusal(child: { pid?: number } | null | undefined, error: unknown,
  ctx: { runtimeKind: string; cwd?: string | null; locale?: string }): PreDispatchRefusalError | null {
  if (child && child.pid !== undefined) return null;
  if (!error || typeof error !== "object") return null;
  const errno = (error as { code?: unknown }).code;
  const syscall = (error as { syscall?: unknown }).syscall;
  if (typeof errno !== "string" || !/^E[A-Z0-9]+$/.test(errno) || typeof syscall !== "string" || !syscall.startsWith("spawn")) return null;
  const stage = `${ctx.runtimeKind}-spawn`;
  const cwd = typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : null;
  if (SPAWN_RESOURCE_BUSY_ERRNOS.has(errno)) {
    return new PreDispatchRefusalError(RUNTIME_SPAWN_RESOURCE_BUSY_CODE, error instanceof Error ? error.message : errno, error, stage);
  }
  if (cwd) {
    let folderCode: string | null = null;
    try {
      if (!statSync(cwd).isDirectory()) folderCode = "project_folder_not_directory";
      else accessSync(cwd, fsConstants.R_OK | fsConstants.X_OK);
    } catch (probe) {
      const probeErrno = (probe as { code?: unknown }).code;
      folderCode = probeErrno === "ENOENT" ? "project_folder_missing" : probeErrno === "ENOTDIR" ? "project_folder_not_directory" : "project_folder_unreadable";
    }
    if (folderCode) {
      const ko = ctx.locale === "ko";
      const message = folderCode === "project_folder_missing" ? (ko ? `작업 폴더를 찾을 수 없습니다: ${cwd}` : `The working folder was not found: ${cwd}`)
        : folderCode === "project_folder_not_directory" ? (ko ? `작업 폴더가 폴더가 아닙니다: ${cwd}` : `The working folder is not a folder: ${cwd}`)
        : (ko ? `작업 폴더를 열 수 없습니다: ${cwd}` : `The working folder cannot be opened: ${cwd}`);
      return new PreDispatchRefusalError(folderCode, message, error, stage);
    }
  }
  const code = errno === "ENOENT" ? "runtime_executable_missing" : errno === "EACCES" || errno === "EPERM" ? "runtime_executable_not_runnable"
    : `${ctx.runtimeKind.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_spawn_failed`;
  return new PreDispatchRefusalError(code, error instanceof Error ? error.message : errno, error, stage);
}

/** The typed runner failure a cause carries: the failure of a returned RunnerResult, or the RunnerFailure itself. */
function runnerFailureOfCause(cause: unknown): RunnerFailure | undefined {
  return (cause && typeof cause === "object" && "failure" in cause ? (cause as { failure?: RunnerFailure }).failure : undefined)
    ?? (cause && typeof cause === "object" && "kind" in cause && "message" in cause ? cause as RunnerFailure : undefined);
}

/**
 * The runner's own typed failure behind an unfinished turn (unsettledTurnError keeps the returned result as the standard
 * `cause`), when the error is one and its cause carries a failure. Facts only: nothing here reads a message.
 */
export function unsettledTurnCauseFailure(error: unknown): RunnerFailure | undefined {
  if (!(error instanceof RuntimeTurnUnsettledError)) return undefined;
  const failure = runnerFailureOfCause((error as { cause?: unknown }).cause);
  return failure && typeof failure.kind === "string" ? failure : undefined;
}

/**
 * The one way a host wrapper reports a dispatched turn that ended without its terminal receipt. Unlike a bare
 * `new RuntimeTurnUnsettledError(kind)`, it keeps what the runner proved: the typed cause (standard `cause`, so its
 * innermost code stays readable), the provider's own words, the session id and the RuntimeTurnDelivery it observed.
 */
export function unsettledTurnError(input: {
  runtimeKind: string;
  locale?: string;
  cause?: unknown;
  sessionId?: string | null;
  providerReason?: string | null;
  turnDelivery?: RuntimeTurnDelivery;
}): RuntimeTurnUnsettledError {
  const cause = input.cause;
  const failure = runnerFailureOfCause(cause);
  const causeDelivery = cause && typeof cause === "object" ? (cause as { turnDelivery?: unknown }).turnDelivery : undefined;
  const delivery = input.turnDelivery ?? (causeDelivery === "accepted" || causeDelivery === "not-accepted" ? causeDelivery : undefined);
  const sessionId = input.sessionId ?? (cause && typeof cause === "object" ? (cause as { sessionId?: unknown }).sessionId : undefined);
  const reason = input.providerReason ?? (failure && failure.providerCode !== RUNTIME_TURN_UNSETTLED_CODE ? failure.message : null);
  const error = new RuntimeTurnUnsettledError(input.runtimeKind, input.locale, typeof sessionId === "string" ? sessionId : null, reason,
    delivery === "accepted" || delivery === "not-accepted" ? delivery : undefined);
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause, configurable: true, writable: true });
  return error;
}

/**
 * The CLI's own words when it exited non-zero before any terminal event (argument-parser rejections such as
 * "unexpected argument '--x'" / "unknown option", bad config). Carried as RuntimeTurnUnsettledError's providerReason so a
 * renamed or removed flag reads as that, not as a bare "no terminal receipt" (G35). Null when the child exited cleanly or said nothing.
 */
export function childExitReason(code: number | null | undefined, stderr: string | null | undefined): string | null {
  if (typeof code !== "number" || code === 0) return null;
  const text = String(stderr ?? "").replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!text) return null;
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" ").slice(0, 300) || null;
}

/** Terminal HTTP status is machine evidence; prose/network errors do not grant replay. */
const runtimeHttpRefusals = new WeakMap<RunnerFailure, number>();
export function runtimeHttpFailure(status: number, runtime: string, provider: string, retryAfter?: string | null): RunnerFailure | null {
  // 429 is request throttling, not an exhausted plan: "rate_limit" (a plan verdict arrives as its own typed code).
  const kind = status === 401 ? "auth" : status === 429 ? "rate_limit" : status === 403 ? "refused" : null;
  if (!kind) return null;
  const hint = status === 429 ? httpRetryAfterHint(retryAfter) : undefined;
  const failure: RunnerFailure = { kind, runtime, source: "marker", providerCode: `http_${status}`,
    message: `${provider} API returned HTTP ${status}.`, ...(hint ? { retryAfterHint: hint } : {}) };
  runtimeHttpRefusals.set(failure, status);
  return failure;
}

/**
 * An HTTP Retry-After value as a RunnerFailure.retryAfterHint: seconds become an ISO time, an HTTP date is kept as ISO.
 * Anything else is dropped (the provider's header, never prose).
 */
export function httpRetryAfterHint(value: string | null | undefined, now = Date.now()): string | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  if (/^\d{1,7}$/.test(text)) return new Date(now + Number(text) * 1_000).toISOString();
  const at = Date.parse(text);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

/** Only this process's actual HTTP rejection factory can prove no model work. */
export function runtimeFailureIsClosedHttpRefusal(failure: RunnerFailure | null | undefined, evidence: {
  text: string; nativeActivity: boolean; aborted: boolean; observedUsage?: RunnerResult["observedUsage"];
}): boolean {
  if (!failure || evidence.nativeActivity !== false || evidence.aborted !== false || evidence.text !== "") return false;
  const status = runtimeHttpRefusals.get(failure);
  const kind = status === 401 ? "auth" : status === 403 ? "refused" : status === 429 ? "rate_limit" : null;
  if (!kind || failure.kind !== kind || failure.source !== "marker" || failure.providerCode !== `http_${status}`) return false;
  const usage = evidence.observedUsage;
  return usage === undefined || (usage !== null && usage.inputTokens === 0 && usage.outputTokens === 0
    && (usage.cachedInputTokens === undefined || usage.cachedInputTokens === 0));
}

/** A Main-observed completed-tool loop stop cannot authorize provider replay. */
export class RuntimeNoProgressError extends Error {
  readonly code = "automation_no_progress_loop";
  constructor(readonly runtimeKind: string, locale?: string) {
    super(locale === "ko"
      ? "같은 작업 결과가 반복되어 실행을 멈췄습니다. 마지막 작업 기록을 확인한 뒤 이어가세요."
      : "Execution stopped because the same tool outcomes kept repeating. Review the last work history before continuing.");
    this.name = "RuntimeNoProgressError";
  }
}

/**
 * A runner may reject before it can return RunnerResult (missing executable,
 * transport failure, ACP startup error, or a provider refusal surfaced as an
 * exception). Normalize that boundary so ordinary interactive calls can walk
 * the same ordered role pool as marker-based quota failures. Strict/unattended
 * callers still decide whether this typed failure is recoverable.
 */
export function runnerFailureFromError(error: unknown, runtime: string): RunnerFailure {
  const message = (error instanceof Error ? error.message : String(error)).trim() || "runtime execution failed";
  if (error instanceof RuntimeTurnUnsettledError || error instanceof RuntimeNoProgressError) {
    return { kind: "refused", message, runtime: error.runtimeKind, source: "marker", providerCode: error.code };
  }
  if (error && typeof error === "object" && "code" in error && error.code === WORK_PROJECT_RESIDENCY_BUSY_CODE) {
    return {
      kind: "refused",
      message: message.slice(0, 2_000),
      runtime,
      source: "marker",
      providerCode: WORK_PROJECT_RESIDENCY_BUSY_CODE,
    };
  }
  if (isJudgmentRefusal(error)) {
    return {
      kind: "refused",
      message: message.slice(0, 2_000),
      runtime: error.runtimeKind || runtime,
      source: "marker",
      providerCode: error.code,
    };
  }
  // A thrown error's own machine code (its innermost typed code, or a message that is itself a code) is its cause, kept as
  // providerCode; prose is read only for an error that carries none (R-054, docs 31 W1).
  const typedCode = refusalCode(error);
  if (typedCode) return { kind: "exit", message: message.slice(0, 2_000), runtime, source: "exit", providerCode: typedCode };
  const kind: RunnerFailureKind = /quota|usage limit|weekly limit|credits?|resets?/i.test(message)
    ? "quota"
    : /\b429\b|rate.?limit/i.test(message)
    ? "rate_limit"
    : /unauthori[sz]ed|authentication|not logged in|please run \/login|\blogin\b|\bsign in\b|token.*(?:expired|invalid)|\bforbidden\b/i.test(message)
      ? "auth"
      : /timed? ?out|timeout/i.test(message)
        ? "timeout"
        : /unsupported|not supported|not installed|not found|missing .*\bcli\b/i.test(message)
          ? "unsupported"
          : "exit";
  return {
    kind,
    message: message.slice(0, 2_000),
    runtime,
    source: "exit",
  };
}

/** 소비자용 한 줄 판정 — if/else 흩어짐 방지. */
export function runnerOutcome(res: RunnerResult):
  | { ok: true; text: string }
  | { ok: false; failure: RunnerFailure } {
  if (res.failure) return { ok: false, failure: res.failure };
  return { ok: true, text: res.text };
}

/**
 * ★호스트 소유 생존 신호 — 모든 CLI 스폰 공통(이 제품의 기결정: liveness를 모델에
 * 맡기지 않는다). 어떤 런타임이든 생각/도구 구간에서 수 분 침묵할 수 있고, 그 침묵은
 * 무활동 워치독(480s)에게 사망과 구별되지 않는다.
 *
 * 실측(2026-08-06): 이 신호를 agy에만 달았더니, 같은 그래프의 다음 노드가 공식
 * Antigravity로 해석되어 8분 침묵 → 스톨 워치독이 정당하게 끊었다. 특례는 특례가
 * 안 붙은 형제를 지뢰로 남긴다 — 그래서 이 헬퍼는 러너 공통이다.
 *
 * 자식 생존을 **확인하고** 뛴다: 확인 없는 심장박동은 죽은 자식을 영원히 "살아
 * 있다"고 보고해, close 이벤트가 유실되면 실행이 좀비가 된다(agy 자체 30m 타임아웃
 * 사후 33분+ running 실측). 죽었으면 박동을 멈춰 워치독이 제 일을 하게 둔다.
 *
 * 반환된 함수를 스폰 종료 경로(close/error/정상 반환)에서 반드시 호출할 것.
 */
export function startCliHeartbeat(
  child: { killed: boolean; exitCode: number | null; signalCode: NodeJS.Signals | null },
  onStatus: RunnerEvents["onStatus"],
  label: string,
  intervalMs = 60_000,
): () => void {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (child.killed || child.exitCode !== null || child.signalCode !== null) {
      stop();
      return;
    }
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    onStatus(
      `${label}: session alive, waiting for output (${seconds}s)`,
      { code: "runtime_wait" },
    );
  }, intervalMs);
  timer.unref?.();
  const stop = (): void => {
    if (timer) { clearInterval(timer); timer = null; }
  };
  return stop;
}

/** Machine code carried in RunnerFailure.providerCode when the host ends a silent CLI child. */
export const RUNTIME_SILENT_TIMEOUT_CODE = "runtime_silent_timeout";

/**
 * Total-silence window for chat / Goal-room CLI children. 20 minutes without a single byte or
 * event (and no tool in flight) is far beyond legitimate model thinking. The one tunable;
 * `AGENTLAS_CLI_SILENCE_WINDOW_MS` is a test hook only.
 */
export const CLI_SILENCE_WINDOW_MS = 20 * 60_000;

export function cliSilenceWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AGENTLAS_CLI_SILENCE_WINDOW_MS);
  return Number.isFinite(raw) && raw >= 50 ? Math.floor(raw) : CLI_SILENCE_WINDOW_MS;
}

/**
 * A tool reported started suspends the 20-minute window (long renders and builds are silent), but not forever:
 * a tool call that never returns and emits nothing for this long is hung, not working. A byte or event from the
 * child resets it. `AGENTLAS_CLI_TOOL_SILENCE_WINDOW_MS` is a test hook only.
 */
export const CLI_TOOL_SILENCE_WINDOW_MS = 90 * 60_000;

export function cliToolSilenceWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AGENTLAS_CLI_TOOL_SILENCE_WINDOW_MS);
  return Number.isFinite(raw) && raw >= 50 ? Math.floor(raw) : CLI_TOOL_SILENCE_WINDOW_MS;
}

export interface CliSilenceGuard {
  /** Any byte/event from the child. */
  touch(): void;
  /** A tool the runtime reported started (id optional); silence is not counted while any is open. */
  toolStart(id?: string | null): void;
  toolEnd(id?: string | null): void;
  /** True once the host decided to end the attempt for silence. */
  readonly tripped: boolean;
  /** Which limit ended it: the plain window, or the longer ceiling that applies while a tool call is in flight. */
  readonly trippedWith: { limitMs: number; toolInFlight: boolean } | null;
  stop(): void;
}

/**
 * ★호스트 소유 침묵 한도 — 채팅·Goal 방 CLI 실행에는 무활동 워치독이 없어(automation 전용),
 * 살아 있지만 완전히 조용한 자식이 실행 전체를 무기한 붙들었다(Yotube Goal 방 61분, 2026-10-11).
 * 하트비트는 호스트가 내는 신호라 자식 침묵을 가리지 못한다 — 이 가드는 **자식이 낸** 것만 센다.
 *
 * 정산 경로는 늘 하나다: 가드는 자식 트리만 죽이고(`kill`), 러너의 close 핸들러가 `tripped`를
 * 보고 timeout 실패로 정산한다(ensureChildCloseAfterExit 주석의 단일 정산 설계).
 */
export function startCliSilenceGuard(
  child: { killed: boolean; exitCode: number | null; signalCode: NodeJS.Signals | null },
  opts: { label: string; onStatus: RunnerEvents["onStatus"]; kill: () => void; windowMs?: number; toolWindowMs?: number },
): CliSilenceGuard {
  const windowMs = opts.windowMs ?? cliSilenceWindowMs();
  const toolWindowMs = opts.toolWindowMs ?? cliToolSilenceWindowMs();
  let last = Date.now();
  let tripped = false;
  let trippedWith: { limitMs: number; toolInFlight: boolean } | null = null;
  const open = new Map<string, number>();
  const openCount = (): number => { let n = 0; for (const v of open.values()) n += v; return n; };
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (child.exitCode !== null || child.signalCode !== null) { stop(); return; }
    if (tripped) return;
    const limitMs = openCount() > 0 ? Math.max(windowMs, toolWindowMs) : windowMs;
    if (Date.now() - last < limitMs) return;
    tripped = true;
    trippedWith = { limitMs, toolInFlight: openCount() > 0 };
    stop();
    opts.onStatus(
      `${opts.label}: no output for ${Math.round(limitMs / 1000)}s${openCount() > 0 ? " with a tool call in flight" : ""} — ending the stalled attempt (${RUNTIME_SILENT_TIMEOUT_CODE})`,
    );
    try { opts.kill(); } catch { /* the close handler still settles */ }
  }, Math.max(20, Math.min(30_000, Math.floor(windowMs / 4))));
  timer.unref?.();
  const stop = (): void => { if (timer) { clearInterval(timer); timer = null; } };
  const key = (id?: string | null): string => id ?? "\u0000anonymous";
  return {
    touch: () => { last = Date.now(); },
    toolStart: (id) => { last = Date.now(); open.set(key(id), (open.get(key(id)) ?? 0) + 1); },
    toolEnd: (id) => {
      last = Date.now();
      const k = key(id);
      const n = (open.get(k) ?? 0) - 1;
      if (n > 0) open.set(k, n); else open.delete(k);
    },
    get tripped() { return tripped; },
    get trippedWith() { return trippedWith; },
    stop,
  };
}

/** Typed failure for a host-ended silent attempt. */
export function runtimeSilentTimeoutFailure(
  runtime: string,
  windowMs = cliSilenceWindowMs(),
  detail: { toolInFlight?: boolean } = {},
): RunnerFailure {
  return {
    kind: "timeout",
    message: `${runtime} produced no output for ${Math.round(windowMs / 1000)}s${detail.toolInFlight ? " while a tool call was in flight" : ""}; the host ended the attempt`.slice(0, 2_000),
    runtime,
    source: "marker",
    providerCode: RUNTIME_SILENT_TIMEOUT_CODE,
  };
}

/** Machine code for "exit 0, but not one line of stdout was a protocol event this adapter recognizes". */
export const RUNTIME_PROTOCOL_UNRECOGNIZED_CODE = "runtime_protocol_unrecognized";

/**
 * Typed failure for a CLI that printed (well-formed, wrong-shape) output and exited 0 with ZERO recognized protocol
 * events: no assistant text, no tool/item event, no result/terminal event. A tool-only turn that ends with no text has
 * recognized events and never reaches this. Carries the CLI's stderr (cleaned, first lines) when it printed any.
 */
export function runtimeProtocolUnrecognizedFailure(runtime: string, stderr?: string | null): RunnerFailure {
  // childExitReason() only speaks for non-zero exits; the stderr cleaning/trimming is what we want here.
  const reason = childExitReason(1, stderr);
  return {
    kind: "unsupported",
    message: `${runtime} exited 0 without emitting any recognized protocol event (output shape not understood)${reason ? `: ${reason}` : ""}`.slice(0, 2_000),
    runtime,
    source: "exit",
    providerCode: RUNTIME_PROTOCOL_UNRECOGNIZED_CODE,
    exitCode: 0,
  };
}

/**
 * ★자식이 죽었는데 `close`가 오지 않는 경우를 끝낸다 — CLI 스폰 공통.
 *
 * Node 계약에서 `close`는 자식의 **stdio가 전부 닫혀야** 온다. `exit`은 프로세스가
 * 죽으면 즉시 오지만, CLI가 stdout/stderr를 상속한 손자(MCP 서버·language server 등)를
 * 남기고 죽으면 그 손자가 파이프를 붙들어 **`close`는 영영 오지 않는다.**
 * 세 러너(agy·claude·codex)가 전부 `close`에서만 정산하므로, 그 순간 실행 Promise는
 * 영구 pending이 되고 실행은 좀비가 된다.
 *
 * 실측 재현: `bash -c "sleep 30 & echo hi; exit 0"` → exit 2ms, close 없음(무한).
 * 같은 자식에서 exit 후 stdout/stderr를 destroy하면 close가 정상 발사된다(503ms).
 *
 * 이 결함의 증상은 "실패"가 아니라 "끝나지 않음"이다 — 채팅 실행이 한 시간 넘게
 * "진행 중"에 머무르고 사람이 손으로 중지할 때까지 정산되지 않는다. 심장박동은 자식
 * 사망을 알고 있지만(`exitCode !== null` → 박동 정지) 아무에게도 말하지 않고,
 * 채팅 실행 경로에는 그 침묵을 받는 워치독이 없다(무활동 워치독은 automation 전용).
 * 침묵이 아니라 **정산**이 있어야 한다.
 *
 * 그래서 `exit`을 함께 듣고, 유예 안에 `close`가 오지 않으면 남은 파이프를 끊어
 * **진짜 `close`를 발사시킨다.** 러너의 close 핸들러가 유일한 정산 경로로 남는다 —
 * 두 번째 정산 경로를 만들면 "어느 이벤트로 끝났는지"가 결과를 바꾸는 새 지뢰가 된다.
 */
export function ensureChildCloseAfterExit(
  child: {
    stdout?: { destroy(): void } | null;
    stderr?: { destroy(): void } | null;
    on(event: "close" | "exit", listener: (code: number | null) => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
  },
  onOrphanedStdio?: () => void,
  graceMs = 10_000,
): void {
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    ended = true;
    if (timer) { clearTimeout(timer); timer = null; }
  };
  child.on("close", disarm);
  child.on("error", disarm);
  child.on("exit", () => {
    // close가 곧바로 따라오는 정상 종료가 절대다수다 — 유예를 두고, 오면 타이머를 버린다.
    if (ended || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (ended) return;
      onOrphanedStdio?.();
      // 남은 파이프를 끊는다 → Node가 close를 발사하고, 러너의 close 핸들러가 정산한다.
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, graceMs);
    timer.unref?.();
  });
}

export type Runner = (
  req: RunnerRequest,
  events: RunnerEvents,
) => Promise<RunnerResult>;

/**
 * The runtime kind selection.ts pickRunner chose for this exact runner function. A caller that inherits a runner (the
 * memory curator inherits the turn runner) reads it to skip a runtime whose declared request limits refuse the request
 * it is about to send (shared/runtime-capabilities.ts runtimeRequestRefusal). undefined for any other runner.
 */
const PICKED_RUNNER_KINDS = new WeakMap<Runner, string>();
export function tagPickedRunnerKind<T extends Runner>(runner: T, kind: string): T {
  PICKED_RUNNER_KINDS.set(runner, kind);
  return runner;
}
export function pickedRunnerKind(runner: Runner | undefined): string | undefined {
  return runner ? PICKED_RUNNER_KINDS.get(runner) : undefined;
}

/**
 * MCP-less orchestration turns must not inherit transport-only environment.
 *
 * A parent run can own the native Agentlas Browser while its planner or
 * synthesizer intentionally runs without tools. Passing the browser scope (or
 * secret aliases) without the matching per-run config creates an impossible
 * request: adapters correctly refuse it before the model starts. Keep ordinary
 * provider/runtime environment intact and remove only values whose authority is
 * carried by the omitted MCP config.
 */
export function withoutMcpTransportEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (!env) return env;
  const next = { ...env };
  delete next.AGENTLAS_NATIVE_BROWSER_SCOPE;
  for (const key of Object.keys(next)) {
    if (/^AGENTLAS_MCP_SECRET_[A-F0-9]{32}$/.test(key)
      || /^AGENTLAS_MCP_PROXY_/.test(key)
      || key === "AGENTLAS_MCP_RUN_BINDING"
      || /^AGENTLAS_AGY_MCP_(?:CONFIG|ENTRY_INTEGRITY|GENERATION|SERVER_KEY)$/.test(key)) delete next[key];
  }
  return next;
}

function carrySurfaceMemoryRequest<T extends object>(original: object, next: T): T {
  // Load the original reader binding only at request dispatch. Loading its
  // memory/judgment dependencies while a CLI adapter initializes cycles back
  // into selection before the adapter's runtime inventory is initialized.
  const memory = require("../memory/surface-recall") as typeof import("../memory/surface-recall");
  return memory.carrySurfaceMemoryRequest(original, next);
}

/** Display guidance only: this marker never grants tools, credentials or authority. `runtimeKind` is the selected
 * adapter kind: a stateless API/local host loop never reads req.turnContext, so an unbound request's turn context (and
 * any addition here) is framed into its current user message instead (runner-turn-context-binding.ts). */
export function withNativeBrowserGuidance(runner: Runner, runtimeKind?: string): Runner {
  return (req, events) => {
    if (assertScienceRecoveryRequest(req)) return runner(req, events);
    const additions: DeclaredPromptPart[] = [];
    const stable: string[] = [];
    if (!req.untrustedNoTools && !req.restrictedReadBoundary && !req.sciencePromptProfile
      && !req.judgmentOnly && !req.minimalObservation) {
      let invoked = "";
      try { invoked = explicitPluginRouterPrompt(req.surfaceUserPrompt ?? req.userPrompt); } catch { /* optional inventory */ }
      if (invoked) {
        additions.push({ id: "native.plugin-router.pointer", revision: 1, stability: "turn-context",
          changeTriggers: ["owner-input", "plugin-inventory"], text: invoked });
        stable.push(invoked);
      }
    }
    if (req.untrustedNoTools && req.env?.AGENTLAS_NATIVE_BROWSER_SCOPE === "task" && !req.mcpConfigPath) {
      const next = carryRunnerTurnContext(req, { ...req, env: withoutMcpTransportEnv(req.env) });
      return runner(carrySurfaceMemoryRequest(req, next), events);
    }
    if (req.env?.AGENTLAS_NATIVE_BROWSER_SCOPE === "task" && req.mcpConfigPath) {
      const guidance = "[Host browser target] browser: agentlas-browser owns this task's tabs and login (a provider's own browser is another session, not evidence); hand off the verified page URL and keep the app server up through verification; act on a snapshot ref (e123) as \"target\" of browser_click/hover/type [/Host browser target]";
      additions.push({ id: "native.browser.target-guidance", revision: 1, stability: "configuration",
        changeTriggers: ["release", "permission", "tool-grant", "runtime"], text: guidance });
      stable.push(guidance);
    }
    if (!additions.length) {
      const delivered = deliverUnboundTurnContext(req, runtimeKind);
      return runner(delivered === req ? req : carrySurfaceMemoryRequest(req, delivered), events);
    }
    return runner(carrySurfaceMemoryRequest(req, extendRunnerTurnContext(req, additions, stable, runtimeKind)), events);
  };
}

/* Ask counts are never stated in prose (they used to contradict each other: "multiple blocks" / "exactly one" / "one batch of 3-5").
 * The host parser decides: extractAskFences (shared/ask-fence-flatten.ts) keeps at most 64 questions per reply, each with 2-8 options,
 * and drops unfilled template placeholders (isUnfilledQuestionTemplate). Same for the Briefing gate. */
/** 에이전트가 사용자에게 옵션 질문을 emit할 수 있는 프로토콜 — renderer/lib/ask-question.ts의 파서와 짝.
 *  로케일 무관, 영어로 — 모델은 항상 영어 docstring을 잘 따른다.
 *  토큰을 아끼기 위해 짧게.
 *  Build keeps the choice-only form (ASK_LINE_CHOICE, the r2 text): the 2026-10-21 card-form ask line was measured on the ordinary
 *  prompt only, and a Build prompt carries its own interview question contract. */
const ASK_PROTOCOL = ASK_LINE_CHOICE;

/** 무인 실행(스케줄 자동화·백그라운드 생성) 최종 지침. 같은 실행의 시스템 `ask:` 모듈은 렌더하지 않는다
 *  (RunnerRequest.unattendedNoAsk) — 2026-10-15 실측: 개발자 채널의 ask 줄이 남아 있으면 Codex가 이 사용자 채널
 *  경계보다 그 줄을 따라 질문 fence를 냈다(old/new 2/2 FAIL). 쓸 수 없는 질문 수단은 아예 주지 않는다.
 *  Main이 executionContext로만 붙인다(렌더러/모델 입력에서 파생 금지).
 *  automation-result.ts의 분류기가 이 계약(<<agentlas-ask>> 금지, "NEEDS-INPUT:" 접두)을 짝으로 감지해,
 *  무인 런의 질문이 조용한 가짜 성공으로 끝나는 것을 막는다. */
export const UNATTENDED_NO_ASK_DIRECTIVE = "unattended (final): nobody can answer; never emit <<agentlas-ask>> or call ask_form; a safe default → take it and state it; none → reply one line starting \"NEEDS-INPUT:\" naming exactly what is missing; never guess.";

/**
 * 사람이 보고 있는 Work 실행에서 **묻는 방법**을 알려 준다.
 *
 * 배경(2026-09-04 실측): Work 에는 질문 시트 UI 가 있고 렌더러는 `<<agentlas-ask>>` 를
 * 읽어 그 시트를 그린다. 그런데 **그 형식을 알려 주는 곳이 태스크포스 합성 프롬프트뿐**이었다.
 * 내장 `ask_user` 도구는 로컬 런타임(local-tool-loop·byok)에만 실리고 CLI 런타임
 * (claude-code·codex)에는 없다. 그래서 기본 경로인 CLI 실행은 구조화해서 물을 수단이
 * 하나도 없었고, 모델은 산문으로 되물었다("…새로 만들까요, 아니면 수정할까요?").
 * 그 물음은 시트로 뜨지 않으니 사용자는 고를 것이 없고 답을 타이핑해야 했다.
 *
 * 남용을 막기 위해 조건을 좁게 적는다 — 진짜로 막힌 갈림길에서 한 번만.
 */
export const MOBILE_DURABLE_ASK_DIRECTIVE = "ask (mobile, final): ask_user and ask_form are unavailable; a required answer → the <<agentlas-ask>> block, then stop; it is answered from Mobile next turn; never guess.";

const BUILD_PROMPT_SENTINEL = "<!-- agentlas-build-system-prompt/v1 -->";
// Budget for the Build system prompt.
//
// Raised 2026-08-16 from 48,000. Owner rule: Desktop Build ships the canonical
// /hep-build procedure, the interview gate, AGENTS.md and the active builder
// VERBATIM — that bundle alone is ~73k characters. The old ceiling made the
// canonical literally unshippable: `wrapBuildSystemPrompt` threw, the rejection
// was never caught, and the build sat at "Starting the AI engine" forever with
// no error shown (measured: 74,807 > 47,232, silent death).
//
// Raised again 2026-08-17, from 120,000. That number was mine and it was
// arbitrary: it happened to clear the bundle of the day by ~45k, and once the
// canonical bodies were merged from every runtime's copy the margin fell to
// ~16k. At that point the ceiling had quietly turned back into a ration — the
// next person adding a canonical rule would have been deciding between the
// contract and a constant nobody had measured anything against.
//
// So size it against the only real limit. 400,000 chars is roughly 100k tokens;
// the runtimes we dispatch to carry 200k (Claude, Codex) to 1M (Gemini). This
// is a runaway guard — an attachment summary looping, a repair prompt appending
// to itself — and nothing here should ever approach it. If a build legitimately
// needs more than 100k tokens of contract, the contract is the thing to look
// at, and the failure will say so instead of dying at "Starting the AI engine".
export const MAX_BUILD_SYSTEM_PROMPT_CHARS = 400_000;
export const BUILD_MCP_DEGRADED_GUARD_RESERVE_CHARS = 768;

/**
 * Build is a package-authoring surface, not ordinary chat. This wrapper keeps
 * language, tool authority, and the one-batch question wire contract while
 * deliberately excluding the general connection skill and surface protocol.
 */
const BUILD_AUTHORITY_LINE = "allowlist: full file, shell, research, verification and approved MCP tools for this Build, within the Build request's authority; never show hidden reasoning";

export function composeBuildSystemPrompt(
  builderPrompt: string | readonly DeclaredPromptPart[],
  locale: RuntimeLocale,
): { text: string; composition: PromptCompositionTrace } {
  const parts: DeclaredPromptPart[] = [
    { id: "build.wrapper.frame", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], order: -10, text: BUILD_PROMPT_SENTINEL + "\nrole: Agentlas Desktop Build" },
    { id: "build.wrapper.ask", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], text: ASK_PROTOCOL },
    { id: "build.wrapper.locale", revision: 1, stability: "configuration", changeTriggers: ["locale"], text: `locale: user = ${locale === "ko" ? "Korean" : "English"} (questions, progress, final summary; generated runtime files follow the builder's canonical language)` },
    { id: "build.wrapper.separator", revision: 1, stability: "configuration", changeTriggers: ["locale"], order: 10, text: tStatus(locale, "sysAgentDef") },
    ...(typeof builderPrompt === "string"
      ? [{ id: "build.wrapper.payload", revision: 1, stability: "task-context", changeTriggers: ["release", "skill-package", "profile", "task", "owner-input", "tool-grant"], text: builderPrompt } as DeclaredPromptPart]
      : builderPrompt),
    { id: "build.wrapper.authority", revision: 1, stability: "final-boundary", changeTriggers: ["release", "permission", "tool-grant", "task"], text: BUILD_AUTHORITY_LINE },
  ];
  const composed = composeTracedPrompt(parts);
  const prompt = composed.text;
  if (prompt.length > MAX_BUILD_SYSTEM_PROMPT_CHARS - BUILD_MCP_DEGRADED_GUARD_RESERVE_CHARS) {
    throw new Error(
      `Build system prompt exceeds the ${MAX_BUILD_SYSTEM_PROMPT_CHARS - BUILD_MCP_DEGRADED_GUARD_RESERVE_CHARS}-character base budget (${prompt.length}).`,
    );
  }
  return composed;
}
export function wrapBuildSystemPrompt(builderPrompt: string, locale: RuntimeLocale): string {
  return composeBuildSystemPrompt(builderPrompt, locale).text;
}

export function measureBuildSystemPrompt(prompt: string): { chars: number; approxTokens: number } {
  return { chars: prompt.length, approxTokens: Math.ceil(prompt.length / 4) };
}

/** Legacy surface-intent marker: no prompt asks for it any more; client.ts only strips it from display. */
export const SURFACE_INTENT_MARKER = "<<surface-intent>>";


/**
 * 서피스 게이트 입력 — **대화 누적**으로 판정한다(2026-08-18 캐시 수리, 러너 공통 규칙).
 *
 * system을 매 호출 재전송하는 러너(BYOK·Ollama·LM Studio·MLX·로컬 OpenAI 호환)와
 * 히스토리를 프롬프트에 매번 재렌더하는 CLI 러너(Antigravity·Cursor)에서, 이 게이트를
 * **이번 턴 입력만** 보고 켜면 SURFACE_PROTOCOL(~8KB)이 턴마다 붙었다 떨어져 프리픽스
 * 바이트가 흔들린다 — 프롬프트 캐시는 그 지점부터 전부 무효가 된다.
 *
 * 누적 판정은 단조라(한 번 켜지면 그 대화에서 유지) 프리픽스가 안정된다. 한 런타임에서
 * 배운 수리는 러너 공통으로 둔다 — 특례는 특례가 안 붙은 형제를 지뢰로 남긴다.
 */
export function cumulativeSurfaceGateText(
  history: RunnerRequest["history"],
  userPrompt: string,
): string {
  return [
    ...history.filter((entry) => entry.role === "user").map((entry) => entry.text),
    userPrompt,
  ].filter(Boolean).join("\n");
}

/** Main-authored bounded judgment; affects prompt text only, never runtime authority. */
export type HostJudgmentPromptProfile = "host-judgment";

/** 표준 시스템 프롬프트 — 에이전트 프롬프트 앞에 붙는 안전 헤더.
 *  명시적으로 선택된 UI 언어를 모든 사용자 노출 텍스트의 기준으로 쓴다. */
export function wrapSystemPrompt(
  agentSystemPrompt: string,
  locale: RuntimeLocale,
  permission?: "read" | "write" | "full",
  /** 이번 턴의 사용자 입력 — 온디맨드 디스커버리(SURFACE 게이트)에 사용. 미제공 시 회귀 방지로 모두 포함. */
  userPrompt?: string,
  /** 2차 패스: 모델이 surface-intent 마커를 emit해서 dispatch가 풀 프로토콜을 강제 로드할 때 true. */
  forceSurface?: boolean,
  /** Main-authored Mobile/unattended boundary. Never derive this from model or renderer input. */
  restrictedReadBoundary?: true,
  /** Browser-originated stateless completion with runner-enforced zero tools. */
  untrustedNoTools?: boolean,
  /** Exact read-only MCP tools verified by Electron main for this one run. */
  untrustedAllowedMcpTools?: string[],
  /** Digest-bound Workforce grant, already validated again by the concrete runtime. */
  workforceRuntimeToolGrant?: WorkforceRuntimeToolGrant,
  /** Main-owned managed-local context profile; explicit agent/plugin/surface instructions remain intact. */
  contextProfile?: "managed-local",
  /** "exclude" builds the same prompt without the optional Surface protocol (capacity fallback); forceSurface still wins. */
  surfaceGate?: "auto" | "exclude",
  /** The concrete runtime running this prompt — names its own built-in abilities (native-capabilities.ts). */
  nativeRuntimeKind?: string,
  /** Trusted Main Science origin, forwarded unchanged by each adapter. */
  sciencePromptProfile?: true,
  /** Derived only from Main's existing judgmentOnly flag by the concrete adapter. */
  hostJudgmentProfile?: HostJudgmentPromptProfile,
  /** Adapter-owned output/image contracts; never supplied by model output. */
  supplements?: readonly DeclaredPromptPart[],
  /** Exact host Build parts; validated against the delivered string before composition. */
  systemPromptComposition?: PromptCompositionTrace,
  /** RunnerRequest.unattendedNoAsk, forwarded unchanged by each adapter: the run has no question channel. */
  unattendedNoAsk?: boolean,
): string {
  if (systemPromptComposition?.kind === "company-work") {
    return composeDeclaredPrompt([...restoreTracedPrompt(agentSystemPrompt, systemPromptComposition), ...(supplements ?? [])], "\n\n");
  }
  // Every line is a registered PromptModule (prompt-modules.ts): `key: value` one-liners, typed tools for anything
  // a tool can do, name lists for catalogs (owner 2026-10-13). Profiles keep their boundaries; only the bytes shrink.
  // Every runtime calls this function internally. A Main-authored Build prompt already passed the restricted Build
  // wrapper, so it is not wrapped again with unrelated chat/surface/connection lines.
  if (!untrustedNoTools && !restrictedReadBoundary && sciencePromptProfile !== true && systemPromptComposition?.kind !== "main-host" && agentSystemPrompt.startsWith(BUILD_PROMPT_SENTINEL)) {
    if (systemPromptComposition) {
      const systemPromptParts = restoreTracedPrompt(agentSystemPrompt, systemPromptComposition);
      if (!systemPromptParts.some(part => part.id === "build.wrapper.authority"
          && part.stability === "final-boundary" && part.text === BUILD_AUTHORITY_LINE)) {
        throw new Error("build_prompt_composition_mismatch");
      }
      return composeDeclaredPrompt([...systemPromptParts, ...(supplements ?? [])], "\n");
    }
    return supplements?.length ? composeDeclaredPrompt([
      { id: "build.wrapped-definition", revision: 2, stability: "task-context", changeTriggers: ["release", "agent-instructions", "skill-package", "locale", "task", "owner-input"], text: agentSystemPrompt },
      ...supplements,
      { id: "build.wrapper.authority", revision: 1, stability: "final-boundary", changeTriggers: ["release", "permission", "tool-grant", "task"], text: BUILD_AUTHORITY_LINE },
    ], "\n") : agentSystemPrompt;
  }
  void userPrompt; void forceSurface; void surfaceGate;
  const mainHostParts = systemPromptComposition?.kind === "main-host"
    ? restoreTracedPrompt(agentSystemPrompt, systemPromptComposition) : null;
  const mainAgentParts = mainHostParts?.filter(part => part.id === "main.system.host.agent-definition");
  if (mainAgentParts && mainAgentParts.length > 1) throw new Error("main_host_agent_definition_duplicate");
  const mainAgentPrompt = mainHostParts ? mainAgentParts?.[0]?.text ?? "" : agentSystemPrompt;
  const mainHostSupplements = mainHostParts?.filter(part => part.id !== "main.system.host.agent-definition");
  const base = { locale, permission, agentSeparator: tStatus(locale, "sysAgentDef"), agentPrompt: mainAgentPrompt,
    ...(unattendedNoAsk === true ? { unattendedNoAsk: true } : {}),
    supplements: mainHostSupplements ? [...mainHostSupplements.map(part => part.stability === "final-boundary"
      ? { ...part, order: -1 } : part), ...(supplements ?? [])] : supplements };
  if (untrustedNoTools) {
    const requested = untrustedAllowedMcpTools ?? [];
    const workforceGranted = workforceRuntimeToolGrant?.grantedToolIds ?? [];
    const allowed = workforceRuntimeToolGrant
      ? JSON.stringify(requested) === JSON.stringify(workforceGranted) &&
          requested.every((toolId) => WORKFORCE_TOOL_ID_RE.test(toolId))
        ? requested
        : []
      : validSiteAgentAppMcpGrantTools(requested) ? requested : [];
    return composePrompt({ ...base, profile: "untrusted", untrustedTools: allowed }).text;
  }
  if (restrictedReadBoundary) {
    const agentPrompt = mainAgentPrompt.startsWith(BUILD_PROMPT_SENTINEL)
      ? "The Build-only agent definition was excluded because this invocation has restricted read authority."
      : mainAgentPrompt;
    return composePrompt({ ...base, agentPrompt, profile: "restricted" }).text;
  }
  if (sciencePromptProfile === true) return composePrompt({ ...base, profile: "science" }).text;
  if (hostJudgmentProfile === "host-judgment") return composePrompt({ ...base, profile: "host-judgment" }).text;
  // Agentlas plugins first, outside equivalents only as the fallback (shared/capability-priority.ts, owner 2026-09-24).
  let preferredProviders: string[] = [];
  try { preferredProviders = preferredProviderPairs(installedAgentlasCapabilityProviders()); } catch { preferredProviders = []; }
  let plugins: PluginCatalog | null = null;
  try { plugins = installedPluginCatalog(userPrompt); } catch { plugins = null; }
  // Installed connectors as a list (owner 2026-10-13); the store is read lazily so a context without it lists none.
  let connectors: string[] = [];
  try {
    const registry = require("../mcp-tools/registry") as typeof import("../mcp-tools/registry");
    connectors = registry.listInstalledServers().filter((server) => server.enabled).map((server) => server.catalogId ?? server.id).sort();
  } catch { connectors = []; }
  return composePrompt({
    ...base,
    profile: "ordinary",
    runtimeKind: nativeRuntimeKind,
    nativeAbilities: runtimeNativeAbilitiesLine(nativeRuntimeKind),
    preferredProviders,
    plugins,
    connectors,
    managedLocal: contextProfile === "managed-local",
  }).text;
}
