// 빌드 세션 — 모듈 레벨 싱글톤 스토어 (대화형 딥인터뷰 지원).
// 빌드는 메인 프로세스(runId)에서 돌아가므로, 다른 메뉴로 이동해 컴포넌트가 언마운트돼도
// 진행 상태(로그·단계·결과·인터뷰)가 사라지면 안 된다. 상태를 모듈 스코프에 두고 IPC 구독도
// 여기서 관리한다. 화면은 useSyncExternalStore로 이 스토어를 구독만 한다.
//
// 딥인터뷰: 빌드는 멀티턴 대화다. 각 턴(=엔진 1회 실행)이 끝나면 어시스턴트 출력을 본다.
//   · 'BUILD_COMPLETE' 포함 → 진짜 빌드 완료 → 조직도 자동 등록.
//   · 아니면 → 인터뷰 질문/추가 입력 대기(awaitingReply). 사용자가 답하면 history에 쌓아 다음 턴 실행.
import { ipc, ipcEvents } from "@/lib/ipc";
import { currentLocale } from "@/lib/i18n";
import { extractQuestions } from "@/lib/ask-question";
import {
  buildScanDisposition,
  buildScanFindings,
  buildScanSeverityBucket,
} from "@/lib/build-scan";
import { announceAgentRosterChange } from "@/lib/agent-roster-events";
import { isCompletedBuildTurn } from "@shared/build-turn";
import type { ChatQuestion } from "@/components/ChatStream";
import type {
  FsPathGrant,
  FsReadScope,
  HephaestusBuildEvent,
  HephaestusBuildResult,
  HephaestusBuildSupplementalQuestion,
  McpBuildAttachmentReceipt,
  McpBuildPlan,
  BuildAllocationPreview,
  BuildAllocationRuntime,
  RuntimeSelection,
} from "@/lib/types";

export type Mode = "single" | "team" | "package";
export type Phase = "idle" | "running" | "mcp-review" | "runtime-approval" | "interview" | "done" | "error";
export type BuildErrorKind = "workspace-unavailable" | "runtime-unavailable" | "mcp-expired" | "build-failed";

export interface BuildError {
  kind: BuildErrorKind;
  message: string;
}

export interface BuildRegisteredEntity {
  id: string;
  kind: "agent" | "team";
  name: string;
}

export interface LogLine {
  kind: HephaestusBuildEvent["kind"];
  text: string;
  /** epoch ms — 로그 타임스탬프(세세한 진행 표시용). */
  at: number;
}

/**
 * Host-owned liveness for the current turn. This is a SINGLE live row that gets
 * replaced, never appended to `log` — a heartbeat every couple of seconds would
 * otherwise bury the real build output. It is the layer that proves "still
 * running" while the engine itself streams nothing at all.
 */
export interface BuildLiveness {
  /** Last thing the engine actually did, in the app's language. */
  activity: string;
  /** ms since the current runner turn started. */
  elapsedMs: number;
  /** ms since the engine last produced anything. */
  silentMs: number;
  /** epoch ms this heartbeat arrived — used to keep counting between ticks. */
  at: number;
}

export interface BuildResult {
  workspace: string;
  securityScan: unknown;
  readScope: FsReadScope;
  mcpReceipt: McpBuildAttachmentReceipt | null;
}

interface ChatMsg {
  role: "user" | "assistant";
  text: string;
}

export interface BuildAttachment {
  /** 절대 경로(파일 또는 폴더). */
  path: string;
  /** Native picker / trusted drop에서 발급된 main-process capability. */
  grant: FsPathGrant;
  /** 표시용 이름(basename). */
  name: string;
  /** 출처 힌트 — 폴더 피커면 dir 확정, 파일 인풋이면 file 확정, 드롭은 unknown(메인이 stat). */
  kind: "file" | "dir" | "unknown";
}

export type BuildCloudSaveChoiceStatus = "pending" | "presented" | "uploading" | "saved" | "local-only";

/**
 * A post-build delivery choice is tied to one completed Build generation and
 * its canonical, main-checked package root. Keeping the payload in the Build
 * session prevents a re-render/reset from publishing a newer workspace with an
 * older dialog (or vice versa).
 */
export interface BuildCloudSaveChoice {
  id: string;
  workspace: string;
  readScope: FsReadScope;
  status: BuildCloudSaveChoiceStatus;
}

export interface BuildState {
  request: string;
  /** 지시문 첨부(기존 에이전트 폴더·스킬·이미지·문서 등). 첫 턴에 워크스페이스로 스테이징된다. */
  attachments: BuildAttachment[];
  mode: Mode | "";
  workspace: string | null;
  /** Native-picker authority for disk inspection; persisted as an opaque token. */
  workspaceGrant: FsPathGrant | null;
  runtime: RuntimeSelection | null;
  phase: Phase;
  log: LogLine[];
  reached: number;
  errored: boolean;
  /** A stopped/failed run left its workspace intact and can continue in place. */
  recoverable: boolean;
  /** Renderer-safe, actionable failure copy. Raw IPC/runtime exceptions never become primary UI. */
  error: BuildError | null;
  result: BuildResult | null;
  runId: string | null;
  /** 빌드 결과가 조직도(라이브러리)에 자동 등록됐는지. */
  registered: boolean;
  /** Auto-registration receipt used to open the exact saved agent/team without importing twice. */
  registeredEntity: BuildRegisteredEntity | null;
  /** 인터뷰 중 어시스턴트가 던진 선택형 질문(있으면 옵션 버튼으로 렌더). */
  pendingQuestions: ChatQuestion[];
  /** Set only while phase === "runtime-approval": the escalation awaiting a decision. */
  pendingAllocation: BuildAllocationPreview | null;
  /** true면 사용자 답변 대기(인터뷰 일시정지). */
  awaitingReply: boolean;
  /** 진행된 인터뷰 턴 수(헤더 표시용). */
  turn: number;
  /** Main-authored, value-free preflight plan and its one-pass selection. */
  mcpPlan: McpBuildPlan | null;
  mcpSelectedCandidateIds: string[];
  mcpReceipt: McpBuildAttachmentReceipt | null;
  /** Explicit owner-private Agent Cloud vs local-only decision for this Build. */
  cloudSaveChoice: BuildCloudSaveChoice | null;
  /** Main-emitted liveness for the current turn. null when no turn is running. */
  liveness: BuildLiveness | null;
}

// 빌드 파이프라인 단계 수 — 화면의 STAGES 배열과 일치(모드분류·인터뷰/리서치·생성·검증·배포).
export const STAGE_COUNT = 6;

const WS_KEY = "agentlas.build.workspace";
const OPENCRAB_QUESTION_ID = "opencrab-ontology";

function mainOwnedOpenCrabQuestion(value: unknown): ChatQuestion | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<HephaestusBuildSupplementalQuestion>;
  if (
    candidate.kind !== OPENCRAB_QUESTION_ID ||
    typeof candidate.question !== "string" ||
    !candidate.question.trim() ||
    !Array.isArray(candidate.options) ||
    candidate.options.length !== 2
  ) return null;
  const options = candidate.options.map((option) => ({
    label: typeof option?.label === "string" ? option.label.trim() : "",
    description: typeof option?.description === "string" ? option.description.trim() : undefined,
  }));
  if (options.some((option) => !option.label)) return null;
  return {
    id: OPENCRAB_QUESTION_ID,
    question: candidate.question.trim(),
    header: "OpenCrab",
    multiSelect: false,
    options,
  };
}

function questionHistorySuffix(question: ChatQuestion | null): string {
  if (!question) return "";
  return `\n\n[Agentlas supplemental question]\n${question.question}\n${question.options
    .map((option, index) => `${index + 1}. ${option.label}`)
    .join("\n")}`;
}

function mainOwnedBuildBriefQuestions(mode: Mode | "", ko: boolean): ChatQuestion[] {
  const subject = mode === "team"
    ? (ko ? "이 팀" : "this team")
    : mode === "package"
      ? (ko ? "이 패키지" : "this package")
      : (ko ? "이 에이전트" : "this agent");
  return [
    {
      id: "build-brief-outcome",
      header: ko ? "완료 기준" : "Outcome",
      question: ko
        ? `${subject}가 어떤 결과를 만들면 “잘 만들었다”고 판단할까요?`
        : `What result would make ${subject} successful?`,
      multiSelect: false,
      options: [
        {
          label: ko ? "정확한 결과물" : "Accurate deliverable",
          description: ko ? "형식과 품질 기준을 지키는 결과물을 만듭니다." : "Produce an output that follows explicit format and quality criteria.",
        },
        {
          label: ko ? "반복 업무 완료" : "Repeatable workflow",
          description: ko ? "같은 유형의 일을 안정적으로 반복 완료합니다." : "Reliably complete the same kind of work again.",
        },
        {
          label: ko ? "판단과 추천" : "Decision support",
          description: ko ? "근거를 검토하고 다음 행동을 추천합니다." : "Review evidence and recommend a next action.",
        },
      ],
    },
    {
      id: "build-brief-input",
      header: ko ? "입력" : "Inputs",
      question: ko
        ? `${subject}가 주로 무엇을 받아서 일해야 하나요?`
        : `What should ${subject} usually receive as input?`,
      multiSelect: true,
      options: [
        { label: ko ? "사용자 메시지" : "User messages", description: ko ? "대화로 받은 요청과 조건" : "Requests and constraints from conversation" },
        { label: ko ? "파일·문서" : "Files and documents", description: ko ? "첨부하거나 지정한 로컬 자료" : "Attached or selected local material" },
        { label: ko ? "웹·연결 서비스" : "Web and connected services", description: ko ? "검색 결과나 승인된 연결 데이터" : "Search results or approved connected data" },
      ],
    },
    {
      id: "build-brief-operator",
      header: ko ? "사용 맥락" : "Operating context",
      question: ko
        ? `${subject}를 주로 누가, 어떤 상황에서 사용하나요?`
        : `Who will usually use ${subject}, and in what situation?`,
      multiSelect: false,
      options: [
        {
          label: ko ? "내가 필요할 때 직접" : "Me, on demand",
          description: ko ? "필요할 때 대화로 요청해 한 번씩 실행합니다." : "I will ask for each run in conversation.",
        },
        {
          label: ko ? "팀이 반복 사용" : "A team, repeatedly",
          description: ko ? "여러 사람이 같은 입력·출력 기준으로 반복 사용합니다." : "Several people reuse the same input and output contract.",
        },
        {
          label: ko ? "정기·자동 실행" : "Scheduled or automatic",
          description: ko ? "정해진 시각이나 이벤트에 맞춰 반복 실행합니다." : "It runs on a schedule or a defined event.",
        },
      ],
    },
    {
      id: "build-brief-authority",
      header: ko ? "권한" : "Authority",
      question: ko
        ? `${subject}가 사용자 확인 없이 할 수 있는 범위를 어디까지로 둘까요?`
        : `What may ${subject} do without asking for confirmation?`,
      multiSelect: false,
      options: [
        {
          label: ko ? "읽기·초안까지만" : "Read and draft only",
          description: ko ? "조회와 초안 작성만 하고 변경 전에는 확인합니다." : "Read and draft, then ask before making changes.",
        },
        {
          label: ko ? "로컬 저장까지" : "Allow local saves",
          description: ko ? "지정 폴더의 되돌릴 수 있는 저장까지 허용합니다." : "Allow reversible saves inside selected folders.",
        },
        {
          label: ko ? "행동마다 확인" : "Confirm every action",
          description: ko ? "외부 전송·설치·게시 등은 항상 먼저 확인합니다." : "Always ask before sending, installing, publishing, or other external actions.",
        },
      ],
    },
  ];
}

function restoreWorkspace(): FsPathGrant | null {
  try {
    const raw = window.localStorage.getItem(WS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FsPathGrant>;
    if (
      typeof parsed.path !== "string" ||
      parsed.kind !== "directory" ||
      parsed.durable !== true ||
      parsed.scope?.kind !== "capability" ||
      typeof parsed.scope.token !== "string"
    ) return null;
    return parsed as FsPathGrant;
  } catch {
    return null;
  }
}

const restoredWorkspace = typeof window !== "undefined" ? restoreWorkspace() : null;

const state: BuildState = {
  request: "",
  attachments: [],
  mode: "",
  workspace: restoredWorkspace?.path ?? null,
  workspaceGrant: restoredWorkspace,
  runtime: null,
  phase: "idle",
  log: [],
  reached: 0,
  errored: false,
  recoverable: false,
  error: null,
  result: null,
  runId: null,
  registered: false,
  registeredEntity: null,
  pendingQuestions: [],
  pendingAllocation: null,
  awaitingReply: false,
  turn: 0,
  mcpPlan: null,
  mcpSelectedCandidateIds: [],
  mcpReceipt: null,
  cloudSaveChoice: null,
  liveness: null,
};

let snapshot: BuildState = { ...state };
const listeners = new Set<() => void>();
let unsub: null | (() => void) = null;
// 러너(claude-code)는 partial 이벤트에 "누적 텍스트"를 보낸다. 직전 누적분을 기억해 두고
// 새로 늘어난 델타만 로그에 반영한다(안 그러면 텍스트가 중복 폭증한다). 턴마다 리셋.
let lastAcc = "";
// 대화 history(이번 턴 입력 이전까지).
let history: ChatMsg[] = [];
let runtimeSessionId: string | null = null;
let resolvedBuildRuntime: RuntimeSelection | null = null;
let resolvedBuildRuntimePinned = false;
let runtimeEscalationAccepted: boolean | undefined;
// The product-owned brief is collected before allocator/MCP work. Keep the
// answer locally until the user has also reviewed the exact runtime-bound MCP
// plan, then use it as the first real builder turn.
let pendingBuildBriefReply: string | null = null;
// 런타임이 sessionId를 반환하지 않는 BYOK/Ollama도 첨부는 한 빌드에서 정확히 한 번만 보낸다.
let attachmentsSentForBuild = false;
// Per-build, explicit OpenCrab consent. It is set only from the conditional
// interview question and is never inferred from a free-form answer.
let openCrabOntologyChoice: "use" | "skip" | undefined;
// Monotonic session token. Every async boundary and event callback checks it so
// cancel/reset cannot be followed by a stale disk check or build event that
// resurrects the previous run.
let buildGeneration = 0;
// A native directory read happens before a new build can claim its output
// folder. Ignore a double-click while that read is in flight.
let workspacePreflightInFlight = false;

function isCurrentBuild(generation: number): boolean {
  return generation === buildGeneration;
}

function commit() {
  snapshot = { ...state };
  for (const l of listeners) l();
}

/**
 * Reattach to a build that Main is still running (or just finished).
 *
 * The build lives in Main; this module only mirrors it. A full reload — app
 * restart, refresh, crash of the window — drops the mirror while the build keeps
 * going, and the user comes back to an empty page with no way to learn the
 * outcome (measured 2026-08-16: rows 12 → 0, request gone, "멈춤"으로 보임).
 * Main keeps a transcript for exactly this; replay it.
 *
 * Route changes do NOT need this — the module singleton already survives them.
 */
let reattachInFlight: Promise<boolean> | null = null;
/** How often a reattached view re-reads Main's transcript while the build runs. */
const REATTACH_POLL_MS = 4_000;

export async function reattachRunningBuild(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  // Never clobber a live in-memory session; the mirror is already correct there.
  if (state.runId || state.log.length > 0 || state.request.trim()) return false;
  // React runs mount effects twice in development. Both calls pass the guard above
  // before either commits, and the reattach line lands twice.
  if (reattachInFlight) return reattachInFlight;
  reattachInFlight = reattachOnce().finally(() => { reattachInFlight = null; });
  return reattachInFlight;
}

/** 끝난 빌드를 얼마나 오래 "돌아올 수 있는 것"으로 볼지. 그 뒤엔 새 화면이 이긴다. */
const REATTACH_FINISHED_GRACE_MS = 2 * 60_000;

async function reattachOnce(): Promise<boolean> {
  const api = ipc();
  const active = await api?.hephaestus?.activeBuild?.().catch(() => null);
  if (!active) return false;
  // 아직 돌고 있거나 방금 끝난 빌드만 복원한다. 이 조건이 없으면 한 시간 전에 끝난
  // 빌드가 새 빌드를 시작하려는 빈 화면을 점거하고, 옛 인터뷰 질문까지 되살려
  // 사용자가 새 요청을 넣을 수 없게 된다(2026-08-17 실측: 녹화 실행이 이것 때문에 멈췄다).
  const finishedAgoMs = Date.now() - Date.parse(active.startedAt || "");
  if (!active.running && !(Number.isFinite(finishedAgoMs) && finishedAgoMs < REATTACH_FINISHED_GRACE_MS)) {
    return false;
  }

  state.request = active.request;
  state.workspace = active.workspace;
  state.runId = active.runId;
  const ko = currentLocale() === "ko";
  pushLog(
    "stage",
    ko
      ? active.running
        ? "진행 중이던 빌드에 다시 연결했습니다."
        : "직전 빌드 상태를 복원했습니다."
      : active.running
        ? "Reattached to the build that was still running."
        : "Restored the record of the previous build.",
  );
  // Replay only what the user reads. Turn/phase machinery is not re-driven: a
  // half-restored state machine that thinks it owns a turn is worse than a
  // faithful log the user can act on.
  for (const ev of active.events) {
    if (ev.kind === "stage") {
      const visible = safeBuildProgressText(ev.text ?? ev.stage ?? "", ko);
      if (visible) pushLog("stage", visible);
    } else if (ev.kind === "log") {
      const visible = safeBuildProgressText(ev.text ?? "", ko);
      if (visible) pushLog("log", visible);
    } else if (ev.kind === "error") {
      pushLog("error", ev.text ?? "");
    }
  }
  // 인터뷰 질문을 낸 뒤 답을 기다리던 빌드는 "끝난 빌드"가 아니다. 마지막 done
  // 이벤트에서 질문을 되살리지 않으면, 리로드 한 번에 사용자는 자기가 답해야 할
  // 질문을 영영 잃는다(그리고 빌드는 영원히 답을 못 받는다).
  const lastDone = [...active.events].reverse().find((ev) => ev.kind === "done");
  const restored = lastDone ? extractQuestions(lastDone.text ?? "", "reattach") : null;
  if (restored && restored.questions.length > 0) {
    state.pendingQuestions = restored.questions;
    state.awaitingReply = true;
    state.phase = "interview";
    state.reached = Math.max(state.reached, 1);
    pushLog(
      "log",
      ko
        ? "답을 기다리던 인터뷰 질문을 복원했습니다."
        : "Restored the interview questions that were waiting for your answer.",
    );
  } else {
    state.phase = active.running ? "running" : "done";
  }
  commit();
  // 리로드된 화면에는 살아 있는 이벤트 채널이 없다(채널 구독은 빌드를 시작한
  // 렌더러 인스턴스에 묶여 있다). 전사를 주기적으로 다시 읽어 새 이벤트만 잇는다.
  if (active.running) pollReattached(active.events.length);
  return true;
}

function pollReattached(seen: number): void {
  let cursor = seen;
  const timer = window.setInterval(async () => {
    const api = ipc();
    const latest = await api?.hephaestus?.activeBuild?.().catch(() => null);
    if (!latest) { window.clearInterval(timer); return; }
    const ko = currentLocale() === "ko";
    for (const ev of latest.events.slice(cursor)) {
      if (ev.kind === "stage") {
        const visible = safeBuildProgressText(ev.text ?? ev.stage ?? "", ko);
        if (visible) pushLog("stage", visible);
      } else if (ev.kind === "log") {
        const visible = safeBuildProgressText(ev.text ?? "", ko);
        if (visible) pushLog("log", visible);
      } else if (ev.kind === "error") {
        pushLog("error", ev.text ?? "");
      }
    }
    cursor = latest.events.length;
    if (!latest.running) {
      state.phase = "done";
      window.clearInterval(timer);
    }
    commit();
  }, REATTACH_POLL_MS);
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getSnapshot(): BuildState {
  return snapshot;
}

export function setRequest(v: string) {
  state.request = v;
  commit();
}

/** 첨부 추가(중복 경로 제거). */
export function addAttachments(items: BuildAttachment[]): void {
  const seen = new Set(state.attachments.map((a) => a.path));
  const next = items.filter((a) => a.path && !seen.has(a.path));
  if (next.length === 0) return;
  state.attachments = [...state.attachments, ...next];
  commit();
}

export function removeAttachment(index: number): void {
  state.attachments = state.attachments.filter((_, i) => i !== index);
  commit();
}
export function setMode(v: Mode | "") {
  state.mode = v;
  commit();
}
export function setWorkspace(v: FsPathGrant | null) {
  state.workspace = v?.path ?? null;
  state.workspaceGrant = v;
  try {
    if (v) window.localStorage.setItem(WS_KEY, JSON.stringify(v));
    else window.localStorage.removeItem(WS_KEY);
  } catch {
    /* ignore */
  }
  commit();
}

/**
 * Site Studio처럼 별도 제작 표면이 Build 입력을 넘길 때 쓰는 원자적 renderer
 * 경계. 백그라운드 build/interview를 덮어쓰지 않고, 종료된 이전 결과·첨부·모드는
 * 새 디자인 요청에 섞이지 않게 초기화한다.
 */
export function prepareBuildHandoff(input: {
  workspace: FsPathGrant;
  request: string;
}): { ok: true } | { ok: false; phase: "running" | "mcp-review" | "runtime-approval" | "interview" } {
  if (
    state.phase === "running"
    || state.phase === "interview"
    || state.phase === "mcp-review"
    || state.phase === "runtime-approval"
  ) {
    return { ok: false, phase: state.phase };
  }

  resetBuild();
  state.request = input.request;
  state.attachments = [];
  state.mode = "";
  state.workspace = input.workspace.path;
  state.workspaceGrant = input.workspace;
  try {
    window.localStorage.setItem(WS_KEY, JSON.stringify(input.workspace));
  } catch {
    /* persistence failure does not invalidate the live native capability */
  }
  commit();
  return { ok: true };
}
export function setRuntime(v: RuntimeSelection | null) {
  state.runtime = v;
  commit();
}

export function setBuildMcpSelection(ids: string[]): void {
  if (state.phase !== "mcp-review" || !state.mcpPlan) return;
  const allowed = new Set(state.mcpPlan.candidates.map((candidate) => candidate.id));
  state.mcpSelectedCandidateIds = [...new Set(ids)].filter((id) => allowed.has(id));
  commit();
}

function pushLog(kind: HephaestusBuildEvent["kind"], text: string) {
  state.log = [...state.log, { kind, text, at: Date.now() }];
}

function safeBuildProgressText(raw: string, ko: boolean): string | null {
  const clean = raw
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (!clean) return null;
  const machineEnvelope = (
    /^[{[]/.test(clean)
    || /(?:^|\s)(?:tool_call|function_call|exec_command|write_stdin|apply_patch|mcp__|BUILD_COMPLETE:)(?:\s|$)/i.test(clean)
    || /<\|(?:system|assistant|tool|end)[^>]*\|>/i.test(clean)
    || /"(?:type|role|content|message|arguments|command|tool|schemaVersion|event|payload|status|delta)"\s*:/i.test(clean)
    || /^\s*(?:\$|>|#)\s*(?:bash|zsh|sh|python\d*|node|npm|npx|pnpm|yarn|git|mkdir|cp|mv|rm)\b/im
  );
  if (machineEnvelope) return null;
  const oneLine = clean.replace(/\s+/g, " ");
  if (oneLine.length > 360) {
    return ko
      ? "에이전트가 패키지 내용을 정리하고 있습니다. 원시 모델 출력은 사용자 진행 기록에 표시하지 않습니다."
      : "The agent is preparing the package. Raw model output is hidden from user-facing progress.";
  }
  return oneLine;
}

function classifyBuildError(raw: string, ko: boolean): BuildError {
  const lower = raw.toLowerCase();
  if (
    lower.includes("approved path is no longer available")
    || lower.includes("filesystem capability is unknown")
    || lower.includes("valid filesystem capability is required")
  ) {
    return {
      kind: "workspace-unavailable",
      message: ko
        ? "선택한 생성 폴더를 더 이상 사용할 수 없습니다. 폴더가 이동·삭제됐거나 권한이 만료됐습니다. 폴더를 다시 선택하면 요청과 설정을 유지한 채 재시도할 수 있습니다."
        : "The selected output folder is no longer available. It may have moved, been deleted, or lost permission. Choose the folder again to retry with the same request and settings.",
    };
  }
  if (
    lower.includes("quota")
    || lower.includes("usage limit")
    || lower.includes("balance exhausted")
    || lower.includes("payment required")
    || /\b402\b/.test(lower)
  ) {
    return {
      kind: "runtime-unavailable",
      message: ko
        ? "선택한 AI 엔진의 사용량이 소진되어 빌드를 시작하지 못했습니다. 사용 가능한 다른 엔진을 선택한 뒤 다시 시작하세요."
        : "The selected AI engine has no usage remaining. Choose another available engine and start again.",
    };
  }
  if (lower.includes("mcp build plan") && (lower.includes("expired") || lower.includes("missing") || lower.includes("no longer matches"))) {
    return {
      kind: "mcp-expired",
      message: ko
        ? "MCP 연결 검토가 만료되었거나 현재 설정과 달라졌습니다. 새 빌드를 눌러 연결 계획을 다시 확인하세요."
        : "The MCP review expired or no longer matches the current settings. Start a new build to review the connection plan again.",
    };
  }
  // Everything above recognises a specific cause and explains it. What is left
  // used to be reported as "the build could not continue" with the actual
  // engine error dropped on the floor — the user was told to "review the
  // detailed progress" for a reason that was never put there (measured
  // 2026-08-17 on a gemini build). Carry the raw message; it is the only
  // description of what happened that anyone has.
  const detail = raw.replace(/\s+/g, " ").trim().slice(0, 240);
  return {
    kind: "build-failed",
    message: ko
      ? `빌드를 계속하지 못했습니다${detail ? `: ${detail}` : ""}. 만든 파일은 그대로 보존했습니다. 같은 폴더에서 재시도할 수 있습니다.`
      : `The build could not continue${detail ? `: ${detail}` : ""}. Existing files were preserved. Retry in the same folder.`,
  };
}

// 워크스페이스 basename이 정크/공유 폴더면 부모 폴더 전체를 회사로 등록하면 안 된다(예: trash).
const JUNK_WS = /^(trash|tmp|temp|downloads|desktop|documents|untitled|new folder|cache)$/i;
function wsBasename(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
}
/** 마지막 partial 로그(어시스턴트 출력)의 raw ask-fence를 정리된 텍스트로 교체. */
function cleanLastPartial(cleanText: string) {
  for (let i = state.log.length - 1; i >= 0; i--) {
    if (state.log[i].kind === "partial") {
      const next = [...state.log];
      const trimmed = cleanText.trim();
      if (trimmed) next[i] = { ...next[i], text: trimmed };
      else next.splice(i, 1);
      state.log = next;
      return;
    }
  }
}

const WRITE_SIGNALS = /write|edit|create|touch|mkdir|apply_patch|str_replace|\.md|agentlas\.json|\.agentlas|파일|생성|scaffold/i;
function stageFromEvent(ev: HephaestusBuildEvent, current: number): number {
  if (ev.kind === "stage") {
    if (ev.stage === "security") return Math.max(current, 4);
    if (ev.stage === "build") return Math.max(current, 2);
    if (WRITE_SIGNALS.test(`${ev.stage ?? ""} ${ev.text ?? ""}`)) return Math.max(current, 3);
    return Math.max(current, 2);
  }
  if (ev.kind === "partial" || ev.kind === "log") return Math.max(current, 2);
  return current;
}

function detach() {
  unsub?.();
  unsub = null;
}

const registrationInFlight = new Map<string, Promise<void>>();

function isCurrentRegistration(generation: number, workspace: string): boolean {
  return isCurrentBuild(generation) && state.result?.workspace === workspace;
}

function queueBuildCloudSaveChoice(workspace: string, readScope: FsReadScope, generation: number): void {
  if (
    !isCurrentRegistration(generation, workspace) ||
    !state.registered ||
    state.cloudSaveChoice
  ) return;
  state.cloudSaveChoice = {
    id: `build-cloud-choice-${generation}`,
    workspace,
    readScope,
    status: "pending",
  };
}

/** 빌드 완료 시 결과 폴더를 라이브러리(조직도)에 자동 등록 — "조직도에 안 뜬다" 문제 해소. */
function autoRegister(workspace: string, readScope: FsReadScope, generation: number): Promise<void> {
  const key = `${generation}:${workspace}`;
  const existing = registrationInFlight.get(key);
  if (existing) return existing;

  const task = performAutoRegister(workspace, readScope, generation).finally(() => {
    if (registrationInFlight.get(key) === task) registrationInFlight.delete(key);
  });
  registrationInFlight.set(key, task);
  return task;
}

async function performAutoRegister(workspace: string, readScope: FsReadScope, generation: number): Promise<void> {
  const api = ipc();
  if (!api) return;
  const ko = currentLocale() === "ko";
  try {
    if (isCurrentRegistration(generation, workspace)) {
      pushLog("stage", ko ? "조직도에 등록 중 — 라이브러리에 추가" : "Registering to org chart — adding to library");
      commit();
    }
    const imported = await api.team.importLocalFolder({ path: workspace, scope: readScope });
    // The IPC only returns after SQLite/route/(for a team) firm+org persistence.
    // Always wake roster consumers, even if the user started another Build while
    // this import was finishing. The asset exists; only the stale Build card must
    // be prevented from mutating the new session.
    announceAgentRosterChange({ action: "upserted", agent: imported, source: "build" });
    if (!isCurrentRegistration(generation, workspace)) return;
    state.registered = true;
    state.registeredEntity = {
      id: imported.id,
      kind: imported.kind === "team" ? "team" : "agent",
      name: imported.name || imported.slug || (ko ? "에이전트" : "agent"),
    };
    queueBuildCloudSaveChoice(workspace, readScope, generation);
    const who = state.registeredEntity.name;
    pushLog("done", ko ? `조직도에 추가됨: ${who}` : `Added to org chart: ${who}`);
  } catch (e) {
    if (!isCurrentRegistration(generation, workspace)) return;
    pushLog(
      "error",
      ko
        ? `조직도 등록 실패: ${(e as Error).message} — '라이브러리에 설치'로 다시 시도하세요.`
        : `Failed to register to org chart: ${(e as Error).message} — retry with "Install to library".`,
    );
  }
  if (isCurrentRegistration(generation, workspace)) commit();
}

// ── 완료 신호 누락 자동 복구 ──────────────────────────────────────────────
// 인터뷰 1묶음 이후 BUILD_COMPLETE 없이 턴이 끝나면: (a) 디스크에 패키지 마커가 있으면 완료로
// 승격, (b) 없으면 "질문 금지·기본값으로 완성" 지시로 자동 계속(최대 3회), (c) 한도 초과 시
// 에러로 표면화. 어떤 경우에도 빈 질문 카드로 사용자를 붙잡지 않는다.
const AUTO_CONTINUE_MAX = 3;
/**
 * How many extra rounds a build may take while it is still visibly closing
 * blockers. Three rounds fit a strong model finishing a few leftovers; a local
 * 30B model that scaffolded 32 files and left 45 placeholders open needs more
 * than three passes, and cutting it off there throws away a package that was
 * getting closer every round (measured 2026-08-17).
 *
 * This is not "try harder for longer": the counter only stops advancing while
 * the blocker count keeps dropping, so a model that stalls still ends at
 * AUTO_CONTINUE_MAX.
 */
const AUTO_CONTINUE_MAX_WHILE_IMPROVING = 24;
let autoContinues = 0;
/** Blocker count at the previous hand-back, so a stalled build stops early. */
let lastBlockerCount = Number.POSITIVE_INFINITY;
/**
 * Consecutive rounds that closed nothing. One file per round means a round can
 * legitimately come back level — the model rewrote the file and still missed a
 * field — so a single flat round is not a stall. Two in a row is.
 */
let stalledRounds = 0;
const MAX_STALLED_ROUNDS = 2;
/** 이 빌드에서 호스트가 실제로 질문을 사용자에게 날랐는가. 모델의 주장이 아니라 관측값. */
let interviewObserved = false;

const PKG_MARKERS = new Set(["agentlas.json", "AGENTS.md", ".agentlas"]);

export function containsExistingAgentlasPackage(entries: Array<{ name: string }>): boolean {
  return entries.some((entry) => PKG_MARKERS.has(entry.name));
}

/** 워크스페이스(또는 1단계 하위 폴더)에서 생성된 패키지 루트를 찾는다. 없으면 null. */
async function findPackageRoot(workspace: string, readScope: FsReadScope, generation: number): Promise<string | null> {
  const api = ipc();
  if (!api || !isCurrentBuild(generation)) return null;
  try {
    const listing = await api.fs.listDirectory(workspace, readScope, true);
    if (!isCurrentBuild(generation)) return null;
    const entries = listing?.entries ?? [];
    if (entries.some((n) => PKG_MARKERS.has(n.name))) return workspace;
    const dirs = entries.filter((n) => n.kind === "dir" && !n.name.startsWith(".") && !n.name.startsWith("_")).slice(0, 20);
    for (const dir of dirs) {
      if (!isCurrentBuild(generation)) return null;
      const sub = await api.fs.listDirectory(dir.path, readScope, true);
      if (!isCurrentBuild(generation)) return null;
      if ((sub?.entries ?? []).some((n) => PKG_MARKERS.has(n.name))) return dir.path;
    }
  } catch {
    /* 디스크 확인 실패 — 자동 계속으로 폴백 */
  }
  return null;
}

async function scanGeneratedPackage(pkgRoot: string, readScope: FsReadScope): Promise<unknown> {
  const api = ipc();
  if (!api) return { status: "unverified", reason: "desktop security scanner unavailable" };
  try {
    const response = await api.hephaestus.securityScan({ folder: pkgRoot, scope: readScope, strict: true });
    return (response as { json?: unknown })?.json ?? response;
  } catch (error) {
    return {
      status: "unverified",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function packageContractBlockers(report: unknown): string[] | null {
  if (!report || typeof report !== "object") return null;
  const blockers = (report as { blockers?: unknown }).blockers;
  return Array.isArray(blockers) ? blockers.map(String) : null;
}

/**
 * Which file the next repair round should fix, first by what unlocks the most
 * downstream derivation, then by whatever is left.
 *
 * A blocker reads `<path>: <problem>`, so the path is everything before the
 * first colon.
 */
const BLOCKER_FOCUS_ORDER = [
  ".agentlas/agent-card.json",
  ".agentlas/routing-card.json",
  "agent.md",
  "AGENTS.md",
  ".agentlas/capability-eval-plan.json",
  "contracts/intake.schema.json",
  "contracts/output.schema.json",
  "contracts/output.example.json",
];

export function nextBlockerFocus(blockers: readonly string[]): string | null {
  const paths = blockers.map((blocker) => blocker.split(":")[0]?.trim() ?? "").filter(Boolean);
  if (paths.length === 0) return null;
  for (const preferred of BLOCKER_FOCUS_ORDER) {
    if (paths.includes(preferred)) return preferred;
  }
  return paths[0] ?? null;
}

/** main이 "파일을 하나도 안 썼다"고 표식을 남겼는지. 문장 파싱이 아니라 표식이다. */
function wroteNothing(report: unknown): boolean {
  return Boolean(report && typeof report === "object" && (report as { wroteNothing?: unknown }).wroteNothing === true);
}

function stopForPackageContract(
  pkgRoot: string,
  scan: unknown,
  readScope: FsReadScope,
  blockers: string[] | null,
  empty = false,
): void {
  const ko = currentLocale() === "ko";
  state.result = { workspace: pkgRoot, securityScan: scan, readScope, mcpReceipt: state.mcpReceipt };
  state.awaitingReply = false;
  state.pendingQuestions = [];
  state.errored = true;
  state.recoverable = true;
  state.phase = "error";
  // 보존할 파일이 없는데 "생성한 파일은 그대로 보존했습니다"라고 말하면, 사용자는
  // 있지도 않은 산출물을 찾으러 폴더를 열게 된다. 빈 결과는 빈 결과라고 말한다.
  state.error = {
    kind: "build-failed",
    message: empty
      ? (ko
        ? "선택한 모델이 완료를 선언했지만 파일을 하나도 만들지 않아 설치를 중지했습니다. 폴더는 비어 있습니다 — 더 큰 모델(예: Claude·Gemini)로 다시 시도하세요."
        : "The selected model declared completion but created no files, so installation was stopped. The folder is empty — try again with a larger model (Claude or Gemini, for example).")
      : (ko
        ? "패키지 무결성 검증을 통과하지 못해 설치와 등록을 중지했습니다. 생성한 파일은 그대로 보존했습니다. 같은 폴더에서 다시 준비하면 남은 항목만 복구할 수 있습니다."
        : "Package integrity verification did not pass, so install and registration were stopped. Generated files were preserved. Prepare again in the same folder to repair only the remaining items."),
  };
  pushLog(
    "error",
    empty
      ? (ko ? "생성된 파일 0개 — 검증할 패키지가 없습니다." : "Zero files generated — there is no package to verify.")
      : blockers === null
        ? (ko ? "패키지 무결성을 확인할 수 없습니다 — 통과로 간주하지 않습니다." : "Package integrity could not be verified — it was not treated as passing.")
        : (ko ? `패키지 무결성 미충족 ${blockers.length}건 — 자동 등록을 중지했습니다.` : `Package integrity: ${blockers.length} blocker(s) remain — automatic registration was stopped.`),
  );
  // 정본 /hep-build 10단계: "report `blocked` and list them verbatim".
  // 개수만 말하면 사용자는 무엇을 고쳐야 하는지 알 수 없다 — 실패 화면이 막다른 길이 된다.
  for (const blocker of blockers ?? []) pushLog("error", `· ${blocker}`);
  commit();
}

/** 빌드를 완료 상태로 전환하고 조직도 자동 등록까지 수행한다. */
function finalizeBuild(pkgRoot: string, scan: unknown, readScope: FsReadScope, note: string | null, generation: number): void {
  const ko = currentLocale() === "ko";
  const scanDisposition = buildScanDisposition(scan);
  const advisoryCount = (buildScanFindings(scan) ?? [])
    .filter((finding) => buildScanSeverityBucket(finding.severity) !== "passed")
    .length;
  state.reached = STAGE_COUNT;
  state.result = { workspace: pkgRoot, securityScan: scan, readScope, mcpReceipt: state.mcpReceipt };
  state.awaitingReply = false;
  state.pendingQuestions = [];
  if (note) pushLog("log", note);
  if (scanDisposition !== "passed") {
    pushLog(
      "log",
      ko
        ? `안전 점검 참고 ${advisoryCount}건 (${scanDisposition}) — 결과와 영수증은 표시하며 빌드·등록·저장은 계속합니다.`
        : `Safety advisory: ${advisoryCount} finding(s) (${scanDisposition}) — findings and receipts remain visible while build, registration, and save continue.`,
    );
  }
  pushLog("done", ko ? "빌드 완료 — 패키지 생성됨" : "Build complete — package created");
  state.phase = "done";
  commit();
  if (JUNK_WS.test(wsBasename(pkgRoot))) {
    pushLog(
      "log",
      ko
        ? "자동 등록 생략(공용 폴더) — '조직도에서 열기'로 생성된 패키지 폴더만 직접 추가하세요."
        : "Skipped auto-registration (shared folder) — add only the generated package folder via \"Open in org chart\".",
    );
    commit();
  } else {
    void autoRegister(pkgRoot, readScope, generation);
  }
}

/**
 * Hand the exact contract blockers back to the model for one more round.
 *
 * Both endings of a build land here — the model that stops without a completion
 * line and the model that prints one — so a package gets the same number of
 * chances either way.
 */
async function handBackBlockers(
  pkgRoot: string,
  open: string[],
  readScope: FsReadScope,
  generation: number,
): Promise<void> {
  const ko = currentLocale() === "ko";
  autoContinues += 1;
  const improving = open.length > 0 && open.length < lastBlockerCount;
  stalledRounds = improving ? 0 : stalledRounds + 1;
  if (autoContinues > AUTO_CONTINUE_MAX && stalledRounds >= MAX_STALLED_ROUNDS) {
    pushLog(
      "stage",
      ko
        ? `미충족 ${open.length}건에서 ${MAX_STALLED_ROUNDS}라운드 연속 진전이 없어 멈춥니다`
        : `Stopping: ${MAX_STALLED_ROUNDS} rounds in a row closed nothing, still ${open.length} blocker(s)`,
    );
    stopForPackageContract(
      pkgRoot,
      { status: "unverified", reason: "the build stopped before a security scan ran" },
      readScope,
      open,
    );
    commit();
    return;
  }
  lastBlockerCount = open.length > 0 ? open.length : lastBlockerCount;
  // Nineteen files at once is a list a strong model triages and a weak one
  // freezes on. Name one file per round and it has a task it can finish; the
  // order puts the cards `contract complete` derives from first.
  const focus = nextBlockerFocus(open);
  const listed = (focus ? open.filter((blocker) => blocker.startsWith(focus)) : open)
    .slice(0, 40)
    .map((blocker) => `- ${blocker}`)
    .join("\n");
  const others = focus ? open.filter((blocker) => !blocker.startsWith(focus)).length : 0;
  const withheld = others > 0
    ? `\n\n(${others} other item(s) in other files are deliberately not listed — fix this file only, this round.)`
    : "";
  pushLog(
    "stage",
    ko
      ? `패키지 계약 미충족 ${open.length}건 — ${focus ?? "다음 파일"} 수리 ${autoContinues}`
      : `Package contract: ${open.length} blocker(s) — repairing ${focus ?? "the next file"} (round ${autoContinues})`,
  );
  commit();
  await runTurn(
    ko
      ? `이번 라운드에는 **${focus ?? "아래 파일"} 하나만** 고치세요. 질문하지 말고, 기존 패키지 폴더 안의 그 파일을 열어 아래 항목을 해결하세요. {{...}} 자리표시자는 이 에이전트에 맞는 실제 값으로 바꿔야 합니다(자리표시자를 지우기만 하면 안 됩니다). 다른 파일은 건드리지 말고, 처음부터 다시 만들지 말고, 끝나면 마지막 줄에 'BUILD_COMPLETE: <패키지 폴더명>'을 출력하세요.\n\n${listed}${withheld}`
      : `Fix **only ${focus ?? "the file below"}** this round. Do not ask questions. Open that one file inside the existing package folder and resolve the items below — every {{PLACEHOLDER}} must become a real value for this agent, not be deleted. Leave every other file alone, do not rebuild from scratch, and end with 'BUILD_COMPLETE: <package folder name>'.\n\n${listed}${withheld}`,
    generation,
  );
}

async function verifyRepairOrFinalize(
  pkgRoot: string,
  scan: unknown,
  packageContract: unknown,
  readScope: FsReadScope,
  note: string | null,
  generation: number,
): Promise<void> {
  if (!isCurrentBuild(generation)) return;
  const contractBlockers = packageContractBlockers(packageContract);
  // A build had two different endings depending on whether the model happened
  // to print its completion line. Without it, blockers were handed back round
  // after round; with it, the very first non-empty list ended the build. So a
  // model that finished politely got less help than one that just stopped, and
  // a package three placeholders from done was thrown away (measured
  // 2026-08-17: 22 blockers handed back once, then BUILD_COMPLETE, then a hard
  // stop at 38 with no second chance). Both endings now feed the same loop.
  if (
    contractBlockers !== null
    && contractBlockers.length > 0
    && !wroteNothing(packageContract)
    && autoContinues < AUTO_CONTINUE_MAX_WHILE_IMPROVING
  ) {
    await handBackBlockers(pkgRoot, contractBlockers, readScope, generation);
    return;
  }
  if (contractBlockers === null || contractBlockers.length > 0) {
    stopForPackageContract(pkgRoot, scan, readScope, contractBlockers, wroteNothing(packageContract));
    return;
  }
  const verifiedScan = buildScanDisposition(scan) === "unverified"
    ? await scanGeneratedPackage(pkgRoot, readScope)
    : scan;
  if (!isCurrentBuild(generation)) return;

  finalizeBuild(pkgRoot, verifiedScan, readScope, note, generation);
}

async function resolveTurnWithoutSignal(
  workspace: string,
  readScope: FsReadScope,
  generation: number,
): Promise<void> {
  const ko = currentLocale() === "ko";
  const pkgRoot = await findPackageRoot(workspace, readScope, generation);
  if (!isCurrentBuild(generation)) return;
  if (pkgRoot) {
    // ★첫 턴에 질문 없이 파일부터 쓴 경우, 여기서 "추가 질문 없이 마무리하라"고
    // 이어붙이면 인터뷰는 영원히 오지 않는다. 실측 2026-08-17: 모든 런타임에서
    // 인터뷰를 본 적이 없다는 제보의 실제 경로가 이것이었다 — 정본 게이트가
    // 프롬프트에 실려 있어도, 그 다음 턴의 이 문장이 그것을 무효화했다.
    // 첫 턴이고 인터뷰가 아직 없었다면 되돌려서 인터뷰를 요구한다.
    if (state.turn <= 1 && !interviewObserved) {
      autoContinues += 1;
      pushLog(
        "stage",
        ko
          ? "인터뷰 없이 파일부터 만들었습니다 — 되돌려 인터뷰를 요구합니다"
          : "Files were written before any interview — sending it back to interview first",
      );
      commit();
      await runTurn(
        ko
          ? "STOP. 사용자에게 아무것도 묻지 않은 채 파일부터 만들었습니다. Builder Interview and Research Gate는 생성 전에 지나야 하는 계약입니다. 지금 인터뷰 배치만 답하세요: 이 요청이 아직 정하지 않은 것에 대해서만, 그 분야의 용어와 실제 산출물로 `<<agentlas-ask>>` 질문을 내세요. 이번 답변에서는 파일을 쓰지 말고 완료 신호도 출력하지 마세요."
          : "STOP. You wrote files without asking the user anything. The Builder Interview and Research Gate is a contract that runs before generation. Reply with the interview batch only: `<<agentlas-ask>>` questions about what THIS request has not settled, in the domain's own vocabulary and artifacts. Do not write files and do not print the completion line in this reply.",
        generation,
      );
      return;
    }
    if (autoContinues < AUTO_CONTINUE_MAX_WHILE_IMPROVING) {
      const midway = await ipc()?.hephaestus?.contractVerify?.({
        folder: pkgRoot,
        scope: readScope,
        mode: state.mode || undefined,
      }).catch(() => null) ?? null;
      if (!isCurrentBuild(generation)) return;
      const open = Array.isArray(midway?.blockers) ? midway.blockers.map(String) : [];
      if (open.length === 0) {
        autoContinues += 1;
        pushLog("stage", ko ? "패키지 파일 확인 — 최종 검증" : "Package files found — final verification");
        commit();
        await runTurn(
          ko
            ? "패키지 파일이 이미 있습니다. 추가 질문 없이 같은 패키지의 계약·무결성·보안 검증을 실행하고, 실패 항목만 고친 뒤 마지막 줄에 'BUILD_COMPLETE: <패키지 폴더명>'을 출력하세요. 검증을 건너뛰거나 통과로 가정하지 마세요."
            : "Package files already exist. Without asking more questions, run the package contract, integrity, and security verification for this same package; repair only failed items, then end with 'BUILD_COMPLETE: <package folder name>'. Do not skip verification or assume it passed.",
          generation,
        );
        return;
      }
      await handBackBlockers(pkgRoot, open, readScope, generation);
      return;
    }
    // ★모델의 완료 선언이 없더라도, 계약 게이트가 통과하면 그 패키지는 완성된 것이다.
    // 마지막 한 줄을 빠뜨렸다는 이유로 blockers 0인 패키지를 실패로 통보하면
    // 사용자는 멀쩡한 결과물을 버린다(2026-08-17 실측: 리조트 전략 에이전트가
    // blockers 0이었는데 "최종 검증 완료 신호 미확인"으로 실패 처리됐다).
    // 판정 권한은 모델의 문장이 아니라 계약 검증 결과에 있다.
    const verdict = await ipc()?.hephaestus?.contractVerify?.({
      folder: pkgRoot,
      scope: readScope,
      mode: state.mode || undefined,
    }).catch(() => null) ?? null;
    if (!isCurrentBuild(generation)) return;
    if (verdict?.blockers && verdict.blockers.length === 0) {
      pushLog(
        "stage",
        ko
          ? "완료 신호는 없었지만 패키지 계약이 통과했습니다 — 완료로 처리합니다."
          : "No completion line was printed, but the package contract passed — treating it as complete.",
      );
      finalizeBuild(pkgRoot, null, readScope, null, generation);
      return;
    }
    state.errored = true;
    state.recoverable = true;
    state.phase = "error";
    state.error = {
      kind: "build-failed",
      message: ko
        ? "패키지 파일은 생성됐지만 계약 검증을 통과하지 못했습니다. 파일은 보존했습니다. 같은 폴더에서 다시 준비해 남은 항목만 고치세요."
        : "Package files were created, but the package contract did not pass. Files were preserved. Prepare again in the same folder to fix the remaining items.",
    };
    pushLog("error", state.error.message);
    for (const blocker of verdict?.blockers ?? []) pushLog("error", `· ${blocker}`);
    commit();
    return;
  }
  if (state.turn === 1) {
    state.pendingQuestions = mainOwnedBuildBriefQuestions(state.mode, ko);
    state.awaitingReply = true;
    state.phase = "interview";
    state.reached = Math.max(state.reached, 1);
    pushLog(
      "log",
      ko
        ? "빌더의 질문이 누락되어 Agentlas가 완료 기준·입력·권한을 먼저 확인합니다."
        : "The builder omitted its interview, so Agentlas is confirming outcome, inputs, and authority first.",
    );
    commit();
    return;
  }
  if (autoContinues < AUTO_CONTINUE_MAX) {
    autoContinues += 1;
    pushLog("stage", ko ? `자동 진행 ${autoContinues}/${AUTO_CONTINUE_MAX} — 추가 질문 없이 빌드 계속` : `Auto-continue ${autoContinues}/${AUTO_CONTINUE_MAX} — building without further questions`);
    commit();
    await runTurn(
      ko
        ? "추가 질문 없이 계속 진행하세요. 남은 결정은 전부 합리적 기본값으로 정해 work-brief에 assumption으로 기록하고, 패키지를 끝까지 완성한 뒤 마지막 줄에 'BUILD_COMPLETE: <패키지 폴더명>'을 출력하세요."
        : "Continue WITHOUT asking any further questions. Decide every remaining choice with sensible defaults (record them as assumptions in the work-brief), finish the complete package, and end with 'BUILD_COMPLETE: <package folder name>'.",
      generation,
      true,
    );
    return;
  }
  state.errored = true;
  state.phase = "error";
  pushLog("error", ko ? "빌더가 완료 신호 없이 멈췄습니다 — '새 빌드'로 다시 시도하세요." : "The builder stopped without a completion signal — retry with 'New build'.");
  commit();
}

/** 한 번의 빌드/인터뷰 턴을 실행한다. input = 이번 턴 사용자 입력. */
async function runTurn(
  input: string,
  generation = buildGeneration,
  // 호스트가 스스로에게 보내는 진행 지시. 사람의 답이 아니므로 영수증·브리프에서
  // 사용자 답변으로 세면 안 된다.
  hostAuthoredContinuation = false,
): Promise<void> {
  const api = ipc();
  const ev = ipcEvents();
  if (!api || !ev || !state.workspace || !state.workspaceGrant || !state.mcpPlan || !isCurrentBuild(generation)) return;
  const ko = currentLocale() === "ko";

  detach();
  lastAcc = "";
  state.phase = "running";
  // A new turn owns its own liveness; a stale row from the previous turn would
  // assert that something is running when nothing is yet.
  state.liveness = null;
  state.errored = false;
  state.recoverable = false;
  state.error = null;
  state.awaitingReply = false;
  state.pendingQuestions = [];
  state.reached = Math.max(state.reached, 2);
  const workspace = state.workspace;
  const readScope = state.workspaceGrant.scope;
  commit();

  let runId: string;
  const openCrabOntologyForTurn = openCrabOntologyChoice;
  try {
    const started = await api.hephaestus.build({
      request: input,
      mode: state.mode || undefined,
      workspaceGrant: state.workspaceGrant,
      runtime: resolvedBuildRuntime || undefined,
      runtimePinned: resolvedBuildRuntimePinned,
      ...(runtimeEscalationAccepted !== undefined ? { runtimeEscalationAccepted } : {}),
      mcpConsent: {
        planId: state.mcpPlan.id,
        selectedCandidateIds: [...state.mcpSelectedCandidateIds],
        ...(state.mcpPlan.status === "unavailable"
          ? { fallbackReason: "recommendation_unavailable" as const }
          : {}),
      },
      runtimeSessionId: runtimeSessionId || undefined,
      // 첨부는 런타임 sessionId 유무와 무관하게 한 빌드에서 정확히 한 번만 스테이징한다.
      attachments: attachmentsSentForBuild
        ? undefined
        : state.attachments.map((a) => ({ grant: a.grant, name: a.name })),
      history: [...history],
      ...(hostAuthoredContinuation ? { hostAuthoredContinuation: true } : {}),
      openCrabOntology: openCrabOntologyForTurn,
      locale: currentLocale(),
    });
    if (!isCurrentBuild(generation)) return;
    if (!started?.runId) throw new Error(ko ? "빌드 실행 ID를 받지 못했습니다." : "Build did not return a run ID.");
    state.mcpReceipt = started.mcpReceipt;
    if (state.attachments.length > 0) attachmentsSentForBuild = true;
    if (openCrabOntologyChoice === openCrabOntologyForTurn) {
      openCrabOntologyChoice = undefined;
    }
    runId = started.runId;
  } catch (error) {
    if (!isCurrentBuild(generation)) return;
    const classified = classifyBuildError(error instanceof Error ? error.message : String(error), ko);
    state.errored = true;
    state.phase = "error";
    state.runId = null;
    state.recoverable = classified.kind === "workspace-unavailable";
    state.error = classified;
    pushLog("error", classified.message);
    commit();
    return;
  }
  state.runId = runId;
  commit();

  const channel = api.hephaestus.buildEventChannel(runId);
  unsub = ev.on(channel, (raw) => {
    if (!isCurrentBuild(generation) || state.runId !== runId) return;
    const e = raw as unknown as HephaestusBuildEvent;
    // A heartbeat is liveness, not build content: it must not advance a stage
    // and must not be appended to the log (one every 2s would bury the run).
    if (e.kind === "heartbeat") {
      state.liveness = {
        activity: safeBuildProgressText(e.text ?? "", ko)
          ?? (ko ? "에이전트가 패키지를 준비하고 있습니다." : "The agent is preparing the package."),
        elapsedMs: e.elapsedMs ?? 0,
        silentMs: e.silentMs ?? 0,
        at: Date.now(),
      };
      commit();
      return;
    }
    if (e.kind !== "done") state.reached = stageFromEvent(e, state.reached);

    if (e.kind === "partial") {
      const full = e.text ?? "";
      lastAcc = full;
      // Partial output is a model/runtime transport stream and frequently
      // contains JSON envelopes, shell fragments, or protocol markers. The
      // user gets host-owned stage/liveness copy here; the final structured
      // artifact and security receipt remain the source of truth.
      state.liveness = {
        activity: ko ? "에이전트가 결과물을 만들고 있습니다." : "The agent is creating the deliverable.",
        elapsedMs: state.liveness?.elapsedMs ?? 0,
        silentMs: 0,
        at: Date.now(),
      };
    } else if (e.kind === "stage") {
      const visible = safeBuildProgressText(e.text ?? e.stage ?? "", ko);
      if (visible) pushLog("stage", visible);
    } else if (e.kind === "log") {
      const visible = safeBuildProgressText(e.text ?? "", ko);
      if (visible) pushLog("log", visible);
    } else if (e.kind === "done") {
      state.liveness = null;
      const assistantText = e.text ?? "";
      const result = e.result as HephaestusBuildResult | undefined;
      state.mcpReceipt = result?.mcpReceipt ?? state.mcpReceipt;
      const supplementalQuestion = state.turn === 0
        ? mainOwnedOpenCrabQuestion(result?.supplementalQuestion)
        : null;
      if (e.sessionId) runtimeSessionId = e.sessionId;
      // 호스트가 자기에게 보낸 진행 지시는 대화 기록에 사람의 말로 남기지 않는다.
      // 남기면 다음 턴의 인터뷰 영수증이 그것을 답변 한 건으로 세고, work-brief의
      // assumptions에 Agentlas가 스스로 쓴 문장이 source:"user"로 실린다.
      // 모델은 이번 턴에 이미 그 지시를 받았고, 런타임 세션이 대화를 이어 간다.
      if (!hostAuthoredContinuation) history.push({ role: "user", text: input });
      history.push({ role: "assistant", text: assistantText + questionHistorySuffix(supplementalQuestion) });
      detach();

      const complete = isCompletedBuildTurn(assistantText);
      if (complete) {
        // Main has already canonicalized and scope-checked the model-authored
        // BUILD_COMPLETE target. Never reinterpret that path in the renderer.
        const packageRoot = result?.workspace ?? workspace;
        state.reached = Math.max(state.reached, 4);
        pushLog("stage", ko ? "안전 점검 확인 — 설치 전에 패키지를 검증하는 중" : "Checking safety — verifying the package before install");
        commit();
        void verifyRepairOrFinalize(
          packageRoot,
          result?.securityScan ?? null,
          result?.packageContract ?? null,
          readScope,
          null,
          generation,
        );
        return;
      }

      // 인터뷰는 정확히 1묶음 — 첫 턴의 구조화된 질문 묶음만 사용자에게 보여준다.
      // 그 외(2번째 이후 질문·질문 없는 마무리 멘트·완료 신호 누락)는 사용자를 붙잡지 않고
      // 디스크 검사→자동 계속으로 스스로 해결한다. "CLI와 대화하는" 빈 배치 카드 재발 방지.
      const parsed = extractQuestions(assistantText, `t${state.turn}`);
      cleanLastPartial(parsed.text);
      const questions = supplementalQuestion
        ? [...parsed.questions, supplementalQuestion]
        : parsed.questions;
      if (state.turn === 0 && questions.length > 0) {
        state.pendingQuestions = questions;
        state.awaitingReply = true;
        state.phase = "interview";
        // 호스트가 실제로 질문을 사용자에게 날랐다는 관측값. 모델의 주장이 아니다.
        interviewObserved = true;
        state.turn += 1;
        state.reached = Math.max(state.reached, 1);
        pushLog("log", ko ? "딥인터뷰 — 질문 묶음에 한 번에 답해 주세요." : "Deep interview — answer the batch of questions in one go.");
        commit();
        return;
      }
      state.turn += 1;
      void resolveTurnWithoutSignal(workspace, readScope, generation);
      return;
    } else if (e.kind === "error") {
      state.liveness = null;
      const classified = classifyBuildError(e.text ?? "", ko);
      state.errored = true;
      state.recoverable = true;
      state.error = classified;
      pushLog("error", classified.message);
      state.phase = "error";
      detach();
    }
    commit();
  });
  void api.hephaestus.buildReady(runId).catch((error) => {
    if (!isCurrentBuild(generation) || state.runId !== runId) return;
    state.errored = true;
    state.recoverable = true;
    state.phase = "error";
    state.error = {
      kind: "build-failed",
      message: ko
        ? "빌드 진행 상태 연결이 끊겼습니다. 생성된 파일은 보존했습니다. 같은 폴더에서 이어서 시도하세요."
        : "The build progress connection was lost. Generated files were preserved. Resume in the same folder.",
    };
    pushLog("error", state.error.message);
    detach();
    void api.hephaestus.cancelBuild(runId);
    commit();
  });
}

export async function startBuild(activeRuntime?: RuntimeSelection): Promise<void> {
  if (
    !state.request.trim()
    || !state.workspace
    || !state.workspaceGrant
    || workspacePreflightInFlight
    || ["running", "interview", "mcp-review", "runtime-approval"].includes(state.phase)
  ) return;
  // A new single/team build must never inherit and then silently reinstall an
  // older package from a persisted output folder. Package/repair mode is the
  // explicit opt-in for editing an existing package.
  if (state.mode !== "package") {
    const api = ipc();
    if (!api) return;
    const workspace = state.workspace;
    const workspaceGrant = state.workspaceGrant;
    const mode = state.mode;
    workspacePreflightInFlight = true;
    try {
      const listing = await api.fs.listDirectory(workspace, workspaceGrant.scope, true);
      if (
        state.workspace !== workspace
        || state.workspaceGrant !== workspaceGrant
        || state.mode !== mode
      ) return;
      if (containsExistingAgentlasPackage(listing?.entries ?? [])) {
        const ko = currentLocale() === "ko";
        state.phase = "error";
        state.errored = true;
        state.recoverable = false;
        state.error = {
          kind: "workspace-unavailable",
          message: ko
            ? "선택한 생성 폴더에 이미 다른 Agentlas 패키지가 있습니다. 새 에이전트/팀은 빈 폴더를 선택하세요. 기존 패키지를 고치려는 경우에만 '기존 에이전트 패키징'을 선택하세요."
            : "The selected output folder already contains another Agentlas package. Choose an empty folder for a new agent/team, or explicitly select “Package existing agent” to repair that package.",
        };
        state.log = [];
        pushLog("error", state.error.message);
        commit();
        return;
      }
    } catch {
      // The main process re-verifies the capability again when execution
      // starts. Let that authoritative boundary surface unavailable folders.
    } finally {
      workspacePreflightInFlight = false;
    }
  }
  // 새 빌드 — 대화/로그/단계 초기화.
  history = [];
  runtimeSessionId = null;
  resolvedBuildRuntime = state.runtime ?? activeRuntime ?? null;
  resolvedBuildRuntimePinned = state.runtime !== null;
  runtimeEscalationAccepted = undefined;
  pendingBuildBriefReply = null;
  state.pendingAllocation = null;
  attachmentsSentForBuild = false;
  openCrabOntologyChoice = undefined;
  autoContinues = 0;
  lastBlockerCount = Number.POSITIVE_INFINITY;
  stalledRounds = 0;
  interviewObserved = false;
  const generation = ++buildGeneration;
  // ★엔진의 첫 응답을 받기 전 턴 번호는 0이어야 한다.
  // 여기가 1이면 모델 질문 렌더 조건(`state.turn === 0`)이 구조적으로 절대 참이 되지
  // 않아 `<<agentlas-ask>>`가 파싱돼도 화면에 오르지 못한다. 2026-08-17 실측:
  // "수십 개 런타임에서 인터뷰 나오는 걸 본 적 없다"의 데스크탑 쪽 실체가 이 한 줄이다.
  // (엔진 앞 고정 4문항이 있던 시절엔 그게 turn 1을 소비해 가려져 있었다.)
  state.turn = 0;
  state.reached = 0;
  state.result = null;
  state.registered = false;
  state.registeredEntity = null;
  state.error = null;
  state.log = [];
  state.mcpPlan = null;
  state.mcpSelectedCandidateIds = [];
  state.mcpReceipt = null;
  state.cloudSaveChoice = null;
  const ko = currentLocale() === "ko";
  const reqLen = state.request.trim().length;
  const mode = state.mode || (ko ? "자동 분류" : "auto-classify");
  // 엔진보다 먼저 뜨던 고정 4문항(mainOwnedBuildBriefQuestions)을 제거했다.
  //
  // 그 배치는 요청 문자열을 인자로 받지도 않아서 "천안상록리조트 중장기 경영전략"이든
  // "이메일 정리"든 글자 하나 안 바뀌었고(2026-08-16 실측), 정본 `/hep-build`에는
  // 존재하지 않는 단계였다. 정본 4단계는 Builder Interview and Research Gate를 거쳐
  // **모델이** 도메인에 맞는 8-12문항을 만든다. 데스크탑이 그 앞에 상수 배열을 끼워
  // 넣는 순간 "터미널 hep-build + GUI"가 아니라 다른 절차가 된다.
  //
  // 이제 첫 턴은 사용자의 요청 그대로 엔진에 간다. 빌더가 인터뷰를 건너뛰면 Main이
  // 되돌려 보내고(builder.ts의 인터뷰 계약 게이트), 그래도 안 물으면 아래 turn===1
  // 폴백이 최후에만 뜬다.
  pendingBuildBriefReply = state.request.trim();
  state.phase = "running";
  state.reached = Math.max(state.reached, 1);
  history.push({ role: "user", text: state.request.trim() });
  pushLog("stage", ko ? "빌드 엔진과 연결 범위 준비" : "Preparing the build engine and connection scope");
  pushLog("log", ko ? `요청 길이 ${reqLen}자 · 모드 ${mode}` : `Request length ${reqLen} chars · mode ${mode}`);
  pushLog("log", ko ? `생성 폴더 ${state.workspace}` : `Output folder ${state.workspace}`);
  if (state.attachments.length > 0) pushLog("log", ko ? `첨부 ${state.attachments.length}개: ${state.attachments.map((a) => a.name).join(", ").slice(0, 200)}` : `Attachments ${state.attachments.length}: ${state.attachments.map((a) => a.name).join(", ").slice(0, 200)}`);
  if (resolvedBuildRuntime) pushLog("log", `${ko ? "엔진" : "Engine"} ${resolvedBuildRuntime.kind}${resolvedBuildRuntime.model ? ` · ${resolvedBuildRuntime.model}` : ""}`);
  pushLog("log", ko ? "빌더가 요청을 읽고 필요한 질문을 직접 만듭니다." : "The builder reads the request and composes its own questions.");
  commit();
  void prepareBuildRuntimeAndMcp(generation);
}

async function prepareBuildRuntimeAndMcp(generation: number): Promise<void> {
  const ko = currentLocale() === "ko";
  // The MCP plan is bound to the runtime it was built for, so the runtime has to
  // be FINAL before the plan exists. Resolving the allocator afterwards changed
  // the runtime under a plan that was already signed and made every escalated
  // build fail its own plan check — on both the accept and the decline path.
  if (!resolvedBuildRuntimePinned) {
    const preview = await previewBuildAllocation();
    if (!isCurrentBuild(generation)) return;
    if (preview?.escalated) {
      state.pendingAllocation = preview;
      state.phase = "runtime-approval";
      pushLog("log", ko
        ? `상위 AI가 ${describeAllocationRuntime(preview.allocated)} 사용을 제안했습니다 (내 선택: ${describeAllocationRuntime(preview.current)}).`
        : `The allocator proposes ${describeAllocationRuntime(preview.allocated)} (your choice: ${describeAllocationRuntime(preview.current)}).`);
      commit();
      return;
    }
  }
  await loadBuildMcpPlan(generation);
}

/**
 * Ask Main for the MCP attachment plan and park the build in `mcp-review`.
 * Only ever called once the runtime is final — the plan is hashed against it.
 */
async function loadBuildMcpPlan(generation: number): Promise<void> {
  const ko = currentLocale() === "ko";
  pushLog("stage", ko ? "MCP 연결 계획 확인 중" : "Checking the MCP attachment plan");
  commit();
  try {
    const bridge = ipc();
    if (!bridge) throw new Error("Desktop bridge unavailable");
    const plan = await bridge.mcpTools.recommendForBuild({
      request: state.request.trim(),
      mode: state.mode || undefined,
      runtime: resolvedBuildRuntime || undefined,
    });
    if (!plan) throw new Error("MCP recommendation returned no plan");
    if (!isCurrentBuild(generation)) return;
    state.mcpPlan = plan;
    state.mcpSelectedCandidateIds = plan.candidates.filter((candidate) => candidate.defaultSelected).map((candidate) => candidate.id);
    state.phase = "mcp-review";
    state.reached = 1;
    pushLog("log", ko ? "MCP 추천을 준비했습니다. 한 번 확인하면 확인한 요구사항으로 제작을 시작합니다." : "MCP recommendations are ready. One confirmation starts creation with the brief you already approved.");
    commit();
  } catch (error) {
    if (!isCurrentBuild(generation)) return;
    const createdAt = new Date();
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    state.mcpPlan = {
      id: `renderer-mcp-unavailable-${random}`,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 20 * 60 * 1000).toISOString(),
      runtimeKind: resolvedBuildRuntime?.kind ?? null,
      status: "unavailable",
      warningCode: "recommendation_unavailable",
      candidates: [],
    };
    state.mcpSelectedCandidateIds = [];
    state.phase = "mcp-review";
    state.reached = 1;
    state.errored = false;
    pushLog(
      "error",
      ko
        ? "MCP 추천 서비스를 사용할 수 없습니다. 한 번 확인한 뒤 MCP 없이 빌드를 계속할 수 있습니다."
        : "MCP recommendations are unavailable. Confirm once to continue the Build without MCP.",
    );
    commit();
  }
}

export async function approveBuildMcpPlan(selectedCandidateIds: string[]): Promise<void> {
  if (state.phase !== "mcp-review" || !state.mcpPlan) return;
  const allowed = new Set(state.mcpPlan.candidates.map((candidate) => candidate.id));
  state.mcpSelectedCandidateIds = [...new Set(selectedCandidateIds)].filter((id) => allowed.has(id));
  const ko = currentLocale() === "ko";
  // The runtime was already settled before this plan was created,
  // so nothing may move it between the plan and the run.
  const briefReply = pendingBuildBriefReply;
  if (!briefReply) {
    state.pendingQuestions = [];
    state.awaitingReply = false;
    state.phase = "error";
    state.errored = true;
    state.error = {
      kind: "build-failed",
      message: ko
        ? "확인한 빌드 요구사항을 불러오지 못했습니다. 요청은 유지되어 있으니 새 빌드로 다시 준비하세요."
        : "The confirmed build brief could not be restored. Your request is still here; prepare a new build to continue.",
    };
    pushLog("error", state.error.message);
    commit();
    return;
  }
  state.pendingQuestions = [];
  state.awaitingReply = false;
  state.phase = "running";
  state.reached = Math.max(state.reached, 2);
  pushLog("stage", ko ? "MCP 선택 승인 — 에이전트 제작 시작" : "MCP selection approved — starting agent creation");
  pushLog("log", ko ? "확인한 요구사항과 연결 범위로 실제 AI 엔진을 시작합니다." : "Starting the AI engine with the confirmed brief and connection scope.");
  commit();
  await runTurn(briefReply, buildGeneration);
  pendingBuildBriefReply = null;
}

async function previewBuildAllocation(): Promise<BuildAllocationPreview | null> {
  const bridge = ipc();
  if (!bridge?.hephaestus?.previewAllocation || !state.workspaceGrant) return null;
  try {
    return await bridge.hephaestus.previewAllocation({
      request: state.request.trim(),
      mode: state.mode || undefined,
      workspaceGrant: state.workspaceGrant,
      runtime: resolvedBuildRuntime || undefined,
      runtimePinned: resolvedBuildRuntimePinned,
      mcpConsent: { planId: state.mcpPlan?.id ?? "", selectedCandidateIds: state.mcpSelectedCandidateIds },
      locale: currentLocale(),
    });
  } catch {
    // Never block a build on the preview: the build resolves allocation itself.
    return null;
  }
}

export function describeAllocationRuntime(runtime: BuildAllocationRuntime): string {
  return [runtime.model ?? runtime.kind, runtime.effort].filter(Boolean).join(" · ");
}

/**
 * Decision on an allocator escalation. Either way the answer is pinned, so the
 * allocator cannot re-escalate behind the user on the same build.
 */
export async function resolveRuntimeEscalation(accept: boolean): Promise<void> {
  if (state.phase !== "runtime-approval" || !state.pendingAllocation) return;
  const preview = state.pendingAllocation;
  const ko = currentLocale() === "ko";
  const chosen = accept ? preview.allocated : preview.current;
  // Declining must leave the user's own runtime object untouched. Rebuilding it
  // from the preview drops fields the preview does not carry (longContext) and
  // fills in ones the user never set, which is a different runtime identity.
  if (accept) {
    resolvedBuildRuntime = {
      ...(resolvedBuildRuntime ?? {}),
      kind: chosen.kind as RuntimeSelection["kind"],
      ...(chosen.backend ? { backend: chosen.backend as RuntimeSelection["backend"] } : {}),
      ...(chosen.model ? { model: chosen.model } : {}),
      ...(chosen.effort ? { effort: chosen.effort } : {}),
      ...(chosen.source ? { source: chosen.source } : {}),
    } as RuntimeSelection;
  }
  resolvedBuildRuntimePinned = true;
  runtimeEscalationAccepted = accept;
  state.pendingAllocation = null;
  state.phase = "running";
  pushLog("log", accept
    ? (ko ? `승인 — ${describeAllocationRuntime(chosen)}(으)로 빌드합니다.` : `Approved — building on ${describeAllocationRuntime(chosen)}.`)
    : (ko ? `내 선택 유지 — ${describeAllocationRuntime(chosen)}(으)로 빌드합니다.` : `Keeping your choice — building on ${describeAllocationRuntime(chosen)}.`));
  commit();
  // The runtime is only final now, so the MCP plan is created against it here.
  await loadBuildMcpPlan(buildGeneration);
}

/** 인터뷰 답변 제출 — 다음 턴 실행. */
export async function answerBuild(
  reply: string,
  openCrabOntology?: "use" | "skip",
): Promise<void> {
  if (!state.awaitingReply || !reply.trim()) return;
  if (openCrabOntology) openCrabOntologyChoice = openCrabOntology;
  const ko = currentLocale() === "ko";
  const normalizedReply = reply.trim();
  pushLog("log", ko ? "인터뷰 답변을 확인했습니다." : "Interview answers confirmed.");
  if (!state.mcpPlan && state.turn <= 1 && pendingBuildBriefReply === null) {
    pendingBuildBriefReply = normalizedReply;
    state.awaitingReply = false;
    state.pendingQuestions = [];
    state.phase = "running";
    state.reached = Math.max(state.reached, 1);
    pushLog("stage", ko ? "요구사항 확인됨 — 빌드 엔진과 연결 범위 준비" : "Brief confirmed — preparing the engine and connection scope");
    commit();
    await prepareBuildRuntimeAndMcp(buildGeneration);
    return;
  }
  commit();
  await runTurn(normalizedReply, buildGeneration);
}

export function cancelBuild() {
  const cancelledRunId = state.runId;
  buildGeneration += 1;
  if (cancelledRunId) ipc()?.hephaestus.cancelBuild(cancelledRunId);
  if (cancelledRunId) {
    state.phase = "error";
    state.errored = true;
    state.recoverable = true;
    state.error = {
      kind: "build-failed",
      message: currentLocale() === "ko"
        ? "빌드를 중단했습니다. 지금까지 만든 파일은 그대로 보존했습니다."
        : "The build was stopped. Files created so far were preserved.",
    };
    pushLog(
      "error",
      currentLocale() === "ko"
        ? "빌드를 중단했습니다. 지금까지 만든 파일은 그대로 보존했습니다. 같은 폴더에서 이어서 빌드하거나 새 빌드를 시작할 수 있습니다."
        : "Build stopped. Files created so far were preserved. You can resume in the same folder or start a new build.",
    );
  } else {
    state.phase = "idle";
    state.reached = 0;
    state.errored = false;
    state.recoverable = false;
    state.error = null;
  }
  state.awaitingReply = false;
  state.pendingQuestions = [];
  state.pendingAllocation = null;
  state.runId = null;
  runtimeSessionId = null;
  pendingBuildBriefReply = null;
  if (!cancelledRunId) {
    resolvedBuildRuntime = null;
    resolvedBuildRuntimePinned = false;
    runtimeEscalationAccepted = undefined;
  }
  attachmentsSentForBuild = false;
  openCrabOntologyChoice = undefined;
  if (!cancelledRunId) {
    autoContinues = 0;
    lastBlockerCount = Number.POSITIVE_INFINITY;
    stalledRounds = 0;
  lastBlockerCount = Number.POSITIVE_INFINITY;
    state.mcpPlan = null;
    state.mcpSelectedCandidateIds = [];
    state.mcpReceipt = null;
    state.cloudSaveChoice = null;
  }
  state.liveness = null;
  detach();
  commit();
}

export async function resumeBuild(): Promise<void> {
  if (
    !state.recoverable
    || !state.workspace
    || !state.workspaceGrant
    || !state.mcpPlan
    || state.phase === "running"
  ) return;
  buildGeneration += 1;
  state.errored = false;
  state.recoverable = false;
  state.error = null;
  pushLog(
    "log",
    currentLocale() === "ko"
      ? "보존된 파일을 먼저 확인한 뒤, 완료되지 않은 단계부터 이어서 빌드합니다."
      : "Checking the preserved files first, then resuming from the unfinished step.",
  );
  commit();
  const neverStarted = history.length === 0;
  await runTurn(
    neverStarted
      ? state.request.trim()
      : currentLocale() === "ko"
        ? "이전 실행이 중단되었습니다. 현재 작업 폴더의 파일을 먼저 검사하고, 이미 완성된 작업은 덮어쓰지 말고 미완성 단계만 이어서 패키지를 완성하세요. 마지막 줄에 'BUILD_COMPLETE: <패키지 폴더명>'을 출력하세요."
        : "The previous run was stopped. Inspect the current workspace first, preserve completed work, resume only the unfinished steps, and finish the package. End with 'BUILD_COMPLETE: <package folder name>'.",
    buildGeneration,
  );
}

export function resetBuild() {
  buildGeneration += 1;
  state.phase = "idle";
  state.reached = 0;
  state.errored = false;
  state.recoverable = false;
  state.error = null;
  state.log = [];
  state.result = null;
  state.runId = null;
  state.registered = false;
  state.registeredEntity = null;
  state.awaitingReply = false;
  state.pendingQuestions = [];
  state.pendingAllocation = null;
  state.turn = 0;
  history = [];
  runtimeSessionId = null;
  resolvedBuildRuntime = null;
  resolvedBuildRuntimePinned = false;
  runtimeEscalationAccepted = undefined;
  pendingBuildBriefReply = null;
  attachmentsSentForBuild = false;
  openCrabOntologyChoice = undefined;
  autoContinues = 0;
  lastBlockerCount = Number.POSITIVE_INFINITY;
  stalledRounds = 0;
  state.mcpPlan = null;
  state.mcpSelectedCandidateIds = [];
  state.mcpReceipt = null;
  state.cloudSaveChoice = null;
  state.liveness = null;
  commit();
}

/**
 * Start a genuinely new package instead of carrying the previous request,
 * attachments, output capability, or model choice into the next agent.
 *
 * resetBuild() intentionally preserves those inputs for interview cancellation
 * and workspace re-authorization. Product entry points labelled "Create" or
 * "New build" need the stronger boundary below. An active build is never
 * detached or orphaned just because the user clicked another entry point.
 */
export function startFreshBuild(): boolean {
  if (
    state.phase === "running"
    || state.phase === "interview"
    || state.phase === "mcp-review"
    || state.phase === "runtime-approval"
  ) return false;

  resetBuild();
  state.request = "";
  state.attachments = [];
  state.mode = "";
  state.workspace = null;
  state.workspaceGrant = null;
  state.runtime = null;
  try {
    window.localStorage.removeItem(WS_KEY);
  } catch {
    /* persistence failure cannot keep the old native capability alive in memory */
  }
  commit();
  return true;
}

/** Mark the one-shot choice as visible. Re-renders cannot create another offer. */
export function presentBuildCloudSaveChoice(id: string): boolean {
  const choice = state.cloudSaveChoice;
  if (!choice || choice.id !== id || choice.status !== "pending") return false;
  choice.status = "presented";
  commit();
  return true;
}

/**
 * Atomically claim the exact verified package shown by the dialog. Callers
 * must use this returned payload rather than the current workspace/result.
 */
export function beginBuildCloudSave(id: string): { folder: string; scope: FsReadScope } | null {
  const choice = state.cloudSaveChoice;
  if (
    !choice ||
    choice.id !== id ||
    (choice.status !== "presented" && choice.status !== "pending") ||
    state.phase !== "done" ||
    !state.registered ||
    state.result?.workspace !== choice.workspace
  ) return null;
  choice.status = "uploading";
  commit();
  return { folder: choice.workspace, scope: choice.readScope };
}

/** A failed upload re-opens the same choice; success closes it permanently. */
export function finishBuildCloudSave(id: string, saved: boolean): boolean {
  const choice = state.cloudSaveChoice;
  if (!choice || choice.id !== id || choice.status !== "uploading") return false;
  choice.status = saved ? "saved" : "presented";
  commit();
  return true;
}

/** Local-only is a durable UI decision and performs no IPC/network action. */
export function chooseBuildLocalOnly(id: string): boolean {
  const choice = state.cloudSaveChoice;
  if (!choice || choice.id !== id || (choice.status !== "presented" && choice.status !== "pending")) return false;
  choice.status = "local-only";
  commit();
  return true;
}

/** 수동 재스캔 결과를 전역 build session에 반영해 모든 결과 표면이 같은 참고 영수증을 본다. */
export function updateBuildSecurityScan(scan: unknown): void {
  if (!state.result) return;
  state.result = { ...state.result, securityScan: scan };
  commit();
  if (
    !state.registered &&
    state.phase === "done" &&
    !JUNK_WS.test(wsBasename(state.result.workspace))
  ) {
    void autoRegister(state.result.workspace, state.result.readScope, buildGeneration);
  }
}
