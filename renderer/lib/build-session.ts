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
import { buildScanDisposition } from "@/lib/build-scan";
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
// 런타임이 sessionId를 반환하지 않는 BYOK/Ollama도 첨부는 한 빌드에서 정확히 한 번만 보낸다.
let attachmentsSentForBuild = false;
// Per-build, explicit OpenCrab consent. It is set only from the conditional
// interview question and is never inferred from a free-form answer.
let openCrabOntologyChoice: "use" | "skip" | undefined;
// Monotonic session token. Every async boundary and event callback checks it so
// cancel/reset cannot be followed by a stale disk check or build event that
// resurrects the previous run.
let buildGeneration = 0;

function isCurrentBuild(generation: number): boolean {
  return generation === buildGeneration;
}

function commit() {
  snapshot = { ...state };
  for (const l of listeners) l();
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
}): { ok: true } | { ok: false; phase: "running" | "mcp-review" | "interview" } {
  if (state.phase === "running" || state.phase === "interview" || state.phase === "mcp-review") {
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
  return {
    kind: "build-failed",
    message: ko
      ? "빌드를 계속하지 못했습니다. 만든 파일은 그대로 보존했습니다. 세부 진행 기록을 확인한 뒤 같은 폴더에서 재시도할 수 있습니다."
      : "The build could not continue. Existing files were preserved. Review the detailed progress, then retry in the same folder.",
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
    buildScanDisposition(state.result?.securityScan) !== "passed" ||
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
let autoContinues = 0;

const PKG_MARKERS = new Set(["agentlas.json", "AGENTS.md", ".agentlas"]);

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

/** 빌드를 완료 상태로 전환하고 조직도 자동 등록까지 수행한다. */
function finalizeBuild(pkgRoot: string, scan: unknown, readScope: FsReadScope, note: string | null, generation: number): void {
  const ko = currentLocale() === "ko";
  state.reached = STAGE_COUNT;
  state.result = { workspace: pkgRoot, securityScan: scan, readScope, mcpReceipt: state.mcpReceipt };
  state.awaitingReply = false;
  state.pendingQuestions = [];
  if (note) pushLog("log", note);
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
  } else if (buildScanDisposition(scan) === "passed") {
    void autoRegister(pkgRoot, readScope, generation);
  } else {
    pushLog(
      "log",
      ko
        ? "자동 등록 생략 — 보안 검증이 통과 상태가 아닙니다. 결과에서 재스캔 후 직접 설치하세요."
        : "Skipped auto-registration — security verification has not passed. Re-scan the result before installing.",
    );
    commit();
  }
}

async function resolveTurnWithoutSignal(
  workspace: string,
  scan: unknown,
  readScope: FsReadScope,
  generation: number,
): Promise<void> {
  const ko = currentLocale() === "ko";
  const pkgRoot = await findPackageRoot(workspace, readScope, generation);
  if (!isCurrentBuild(generation)) return;
  if (pkgRoot) {
    finalizeBuild(
      pkgRoot,
      scan,
      readScope,
      ko
        ? "완료 신호가 누락됐지만 디스크에서 패키지를 확인했습니다 — 완료로 처리합니다."
        : "Completion signal was missing but the package exists on disk — finalizing.",
      generation,
    );
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
    );
    return;
  }
  state.errored = true;
  state.phase = "error";
  pushLog("error", ko ? "빌더가 완료 신호 없이 멈췄습니다 — '새 빌드'로 다시 시도하세요." : "The builder stopped without a completion signal — retry with 'New build'.");
  commit();
}

/** 한 번의 빌드/인터뷰 턴을 실행한다. input = 이번 턴 사용자 입력. */
async function runTurn(input: string, generation = buildGeneration): Promise<void> {
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
      pushLog(
        "stage",
        safeBuildProgressText(e.text ?? e.stage ?? "", ko)
          ?? (ko ? "다음 빌드 단계를 진행합니다." : "Continuing to the next build stage."),
      );
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
      history.push({ role: "user", text: input });
      history.push({ role: "assistant", text: assistantText + questionHistorySuffix(supplementalQuestion) });
      detach();

      const complete = isCompletedBuildTurn(assistantText);
      if (complete) {
        state.reached = STAGE_COUNT;
        // Main has already canonicalized and scope-checked the model-authored
        // BUILD_COMPLETE target. Never reinterpret that path in the renderer.
        const packageRoot = result?.workspace ?? workspace;
        const registerPath = JUNK_WS.test(wsBasename(packageRoot)) ? null : packageRoot;
        state.result = { workspace: packageRoot, securityScan: result?.securityScan ?? null, readScope, mcpReceipt: state.mcpReceipt };
        pushLog("done", ko ? "빌드 완료 — 패키지 생성됨" : "Build complete — package created");
        state.phase = "done";
        state.recoverable = false;
        commit();
        if (registerPath && buildScanDisposition(result?.securityScan ?? null) === "passed") {
          void autoRegister(registerPath, readScope, generation);
        } else {
          pushLog(
            "log",
            !registerPath
              ? ko
                ? "자동 등록 생략(공용 폴더) — '조직도에서 열기'로 생성된 패키지 폴더만 직접 추가하세요."
                : "Skipped auto-registration (shared folder) — add only the generated package folder via \"Open in org chart\"."
              : ko
                ? "자동 등록 생략 — 보안 검증이 통과 상태가 아닙니다. 결과에서 재스캔 후 직접 설치하세요."
                : "Skipped auto-registration — security verification has not passed. Re-scan the result before installing.",
          );
          commit();
        }
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
        state.turn += 1;
        state.reached = Math.max(state.reached, 1);
        pushLog("log", ko ? "딥인터뷰 — 질문 묶음에 한 번에 답해 주세요." : "Deep interview — answer the batch of questions in one go.");
        commit();
        return;
      }
      state.turn += 1;
      const scanFromEvent = result?.securityScan ?? null;
      void resolveTurnWithoutSignal(workspace, scanFromEvent, readScope, generation);
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
  if (!state.request.trim() || !state.workspace || !state.workspaceGrant || state.phase === "running") return;
  // 새 빌드 — 대화/로그/단계 초기화.
  history = [];
  runtimeSessionId = null;
  resolvedBuildRuntime = state.runtime ?? activeRuntime ?? null;
  resolvedBuildRuntimePinned = state.runtime !== null;
  runtimeEscalationAccepted = undefined;
  state.pendingAllocation = null;
  attachmentsSentForBuild = false;
  openCrabOntologyChoice = undefined;
  autoContinues = 0;
  const generation = ++buildGeneration;
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
  state.phase = "running";
  pushLog("stage", ko ? "빌드 엔진 확인 중" : "Resolving the build engine");
  pushLog("log", ko ? `요청 길이 ${reqLen}자 · 모드 ${mode}` : `Request length ${reqLen} chars · mode ${mode}`);
  pushLog("log", ko ? `생성 폴더 ${state.workspace}` : `Output folder ${state.workspace}`);
  if (state.attachments.length > 0) pushLog("log", ko ? `첨부 ${state.attachments.length}개: ${state.attachments.map((a) => a.name).join(", ").slice(0, 200)}` : `Attachments ${state.attachments.length}: ${state.attachments.map((a) => a.name).join(", ").slice(0, 200)}`);
  if (resolvedBuildRuntime) pushLog("log", `${ko ? "엔진" : "Engine"} ${resolvedBuildRuntime.kind}${resolvedBuildRuntime.model ? ` · ${resolvedBuildRuntime.model}` : ""}`);
  commit();

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
    pushLog("log", ko ? "MCP 추천을 준비했습니다. 한 번 확인하면 딥인터뷰를 시작합니다." : "MCP recommendations are ready. One confirmation starts the deep interview.");
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
  // The runtime was already settled before this plan was created (startBuild),
  // so nothing may move it between the plan and the run.
  const questions = mainOwnedBuildBriefQuestions(state.mode, ko);
  state.pendingQuestions = questions;
  state.awaitingReply = true;
  state.phase = "interview";
  state.turn = 1;
  state.reached = Math.max(state.reached, 2);
  history.push({ role: "user", text: state.request.trim() });
  history.push({
    role: "assistant",
    text: ko
      ? "빌드 전 확인: 완료 기준, 입력, 사용 맥락, 권한 경계를 먼저 확인합니다."
      : "Pre-build check: confirm the outcome, inputs, operating context, and authority boundary first.",
  });
  pushLog("stage", ko ? "MCP 선택 승인 — 빌드 요구사항 확인" : "MCP selection approved — confirming the build brief");
  pushLog("log", ko ? "실제 AI 엔진을 호출하기 전에 질문 묶음에 한 번만 답해 주세요." : "Answer this one question batch before the AI engine is called.");
  commit();
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
  pushLog("log", `↳ ${ko ? "답변" : "Reply"}: ${reply.trim().slice(0, 240)}`);
  commit();
  await runTurn(reply.trim(), buildGeneration);
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
  state.runId = null;
  runtimeSessionId = null;
  if (!cancelledRunId) {
    resolvedBuildRuntime = null;
    resolvedBuildRuntimePinned = false;
  }
  attachmentsSentForBuild = false;
  openCrabOntologyChoice = undefined;
  if (!cancelledRunId) {
    autoContinues = 0;
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
  state.turn = 0;
  history = [];
  runtimeSessionId = null;
  resolvedBuildRuntime = null;
  resolvedBuildRuntimePinned = false;
  attachmentsSentForBuild = false;
  openCrabOntologyChoice = undefined;
  autoContinues = 0;
  state.mcpPlan = null;
  state.mcpSelectedCandidateIds = [];
  state.mcpReceipt = null;
  state.cloudSaveChoice = null;
  state.liveness = null;
  commit();
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
    state.result?.workspace !== choice.workspace ||
    buildScanDisposition(state.result.securityScan) !== "passed"
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

/** 수동 재스캔 결과를 전역 build session에 반영해 모든 결과/토스트 액션이 같은 게이트를 본다. */
export function updateBuildSecurityScan(scan: unknown): void {
  if (!state.result) return;
  const previousDisposition = buildScanDisposition(state.result.securityScan);
  state.result = { ...state.result, securityScan: scan };
  commit();
  if (
    previousDisposition !== "passed" &&
    buildScanDisposition(scan) === "passed" &&
    !state.registered &&
    !JUNK_WS.test(wsBasename(state.result.workspace))
  ) {
    void autoRegister(state.result.workspace, state.result.readScope, buildGeneration);
  }
}
