// 빌드 세션 — 모듈 레벨 싱글톤 스토어 (대화형 딥인터뷰 지원).
// 빌드는 메인 프로세스(runId)에서 돌아가므로, 다른 메뉴로 이동해 컴포넌트가 언마운트돼도
// 진행 상태(로그·단계·결과·인터뷰)가 사라지면 안 된다. 상태를 모듈 스코프에 두고 IPC 구독도
// 여기서 관리한다. 화면은 useSyncExternalStore로 이 스토어를 구독만 한다.
//
// 딥인터뷰: 빌드는 멀티턴 대화다. 각 턴(=엔진 1회 실행)이 끝나면 어시스턴트 출력을 본다.
//   · 'BUILD_COMPLETE' 포함 → 진짜 빌드 완료 → 조직도 자동 등록.
//   · 아니면 → 인터뷰 질문/추가 입력 대기(awaitingReply). 사용자가 답하면 history에 쌓아 다음 턴 실행.
import { ipc, ipcEvents } from "@/lib/ipc";
import { extractQuestions } from "@/lib/ask-question";
import type { ChatQuestion } from "@/components/ChatStream";
import type { HephaestusBuildEvent, RuntimeSelection } from "@/lib/types";

export type Mode = "single" | "team" | "package";
export type Phase = "idle" | "running" | "interview" | "done" | "error";

export interface LogLine {
  kind: HephaestusBuildEvent["kind"];
  text: string;
  /** epoch ms — 로그 타임스탬프(세세한 진행 표시용). */
  at: number;
}

export interface BuildResult {
  workspace: string;
  securityScan: unknown;
}

interface ChatMsg {
  role: "user" | "assistant";
  text: string;
}

export interface BuildState {
  request: string;
  mode: Mode | "";
  workspace: string | null;
  runtime: RuntimeSelection | null;
  phase: Phase;
  log: LogLine[];
  reached: number;
  errored: boolean;
  result: BuildResult | null;
  runId: string | null;
  /** 빌드 결과가 조직도(라이브러리)에 자동 등록됐는지. */
  registered: boolean;
  /** 인터뷰 중 어시스턴트가 던진 선택형 질문(있으면 옵션 버튼으로 렌더). */
  pendingQuestions: ChatQuestion[];
  /** true면 사용자 답변 대기(인터뷰 일시정지). */
  awaitingReply: boolean;
  /** 진행된 인터뷰 턴 수(헤더 표시용). */
  turn: number;
  /** 이전 인터뷰 답변 상태로 되돌릴 수 있는지. */
  canRewindInterview: boolean;
}

interface InterviewCheckpoint {
  turn: number;
  pendingQuestions: ChatQuestion[];
  log: LogLine[];
  reached: number;
  history: ChatMsg[];
}

// 빌드 파이프라인 단계 수 — 화면의 STAGES 배열과 일치(모드분류·인터뷰/리서치·생성·검증·배포).
export const STAGE_COUNT = 5;

const WS_KEY = "agentlas.build.workspace";

function restoreWorkspace(): string | null {
  try {
    return window.localStorage.getItem(WS_KEY);
  } catch {
    return null;
  }
}

const state: BuildState = {
  request: "",
  mode: "",
  workspace: typeof window !== "undefined" ? restoreWorkspace() : null,
  runtime: null,
  phase: "idle",
  log: [],
  reached: 0,
  errored: false,
  result: null,
  runId: null,
  registered: false,
  pendingQuestions: [],
  awaitingReply: false,
  turn: 0,
  canRewindInterview: false,
};

let snapshot: BuildState = { ...state };
const listeners = new Set<() => void>();
let unsub: null | (() => void) = null;
// 러너(claude-code)는 partial 이벤트에 "누적 텍스트"를 보낸다. 직전 누적분을 기억해 두고
// 새로 늘어난 델타만 로그에 반영한다(안 그러면 텍스트가 중복 폭증한다). 턴마다 리셋.
let lastAcc = "";
// 대화 history(이번 턴 입력 이전까지) + 이번 턴 사용자 입력.
let history: ChatMsg[] = [];
let currentInput = "";
let interviewCheckpoints: InterviewCheckpoint[] = [];

function commit() {
  state.canRewindInterview = state.phase === "interview" && interviewCheckpoints.length > 1;
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
export function setMode(v: Mode | "") {
  state.mode = v;
  commit();
}
export function setWorkspace(v: string | null) {
  state.workspace = v;
  try {
    if (v) window.localStorage.setItem(WS_KEY, v);
  } catch {
    /* ignore */
  }
  commit();
}
export function setRuntime(v: RuntimeSelection | null) {
  state.runtime = v;
  commit();
}

function pushLog(kind: HephaestusBuildEvent["kind"], text: string) {
  state.log = [...state.log, { kind, text, at: Date.now() }];
}

// 워크스페이스 basename이 정크/공유 폴더면 부모 폴더 전체를 회사로 등록하면 안 된다(예: trash).
const JUNK_WS = /^(trash|tmp|temp|downloads|desktop|documents|untitled|new folder|cache)$/i;
function wsBasename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? p;
}
/** 'BUILD_COMPLETE: <folder>' 에서 생성된 패키지 하위 폴더 절대경로를 뽑는다. 없으면 null. */
function packagePathFromText(workspace: string, assistantText: string): string | null {
  const m = assistantText.match(/BUILD_COMPLETE:\s*(.+)/i);
  if (!m) return null;
  let name = m[1].trim().replace(/[`"']/g, "");
  name = name.split(/\s/)[0]; // 폴더명 토큰만
  if (!name || name === "." || name === "/" || name.includes("..")) return null;
  if (name.startsWith("/")) return name; // 절대경로
  name = name.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!name || wsBasename(workspace) === name) return null;
  return `${workspace.replace(/\/+$/, "")}/${name}`;
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
    if (ev.stage === "security") return Math.max(current, 3);
    if (ev.stage === "build") return Math.max(current, 1);
    if (WRITE_SIGNALS.test(`${ev.stage ?? ""} ${ev.text ?? ""}`)) return Math.max(current, 2);
    return Math.max(current, 1);
  }
  if (ev.kind === "partial" || ev.kind === "log") return Math.max(current, 1);
  return current;
}

function detach() {
  unsub?.();
  unsub = null;
}

function cloneQuestions(questions: ChatQuestion[]): ChatQuestion[] {
  return questions.map((q) => ({
    ...q,
    options: q.options.map((option) => ({ ...option })),
    answer: q.answer ? [...q.answer] : undefined,
  }));
}

function cloneLog(log: LogLine[]): LogLine[] {
  return log.map((line) => ({ ...line }));
}

function cloneHistory(items: ChatMsg[]): ChatMsg[] {
  return items.map((item) => ({ ...item }));
}

function rememberInterviewCheckpoint(): void {
  const checkpoint: InterviewCheckpoint = {
    turn: state.turn,
    pendingQuestions: cloneQuestions(state.pendingQuestions),
    log: cloneLog(state.log),
    reached: state.reached,
    history: cloneHistory(history),
  };
  interviewCheckpoints = [
    ...interviewCheckpoints.filter((item) => item.turn !== checkpoint.turn),
    checkpoint,
  ];
}

/** 빌드 완료 시 결과 폴더를 라이브러리(조직도)에 자동 등록 — "조직도에 안 뜬다" 문제 해소. */
async function autoRegister(workspace: string) {
  const api = ipc();
  if (!api) return;
  try {
    pushLog("stage", "조직도에 등록 중 — 라이브러리에 추가");
    const imported = await api.team.importLocalFolder(workspace);
    state.registered = true;
    pushLog("done", `조직도에 추가됨: ${imported?.name || imported?.slug || "에이전트"}`);
  } catch (e) {
    pushLog("error", `조직도 등록 실패: ${(e as Error).message} — '라이브러리에 설치'로 다시 시도하세요.`);
  }
  commit();
}

/** 한 번의 빌드/인터뷰 턴을 실행한다. input = 이번 턴 사용자 입력. */
async function runTurn(input: string): Promise<void> {
  const api = ipc();
  const ev = ipcEvents();
  if (!api || !ev || !state.workspace) return;

  detach();
  lastAcc = "";
  currentInput = input;
  state.phase = "running";
  state.errored = false;
  state.awaitingReply = false;
  state.pendingQuestions = [];
  const workspace = state.workspace;
  commit();

  const { runId } = await api.hephaestus.build({
    request: input,
    mode: state.mode || undefined,
    workspace,
    runtime: state.runtime || undefined,
    history: [...history],
  });
  state.runId = runId;
  commit();

  const channel = api.hephaestus.buildEventChannel(runId);
  unsub = ev.on(channel, (raw) => {
    const e = raw as unknown as HephaestusBuildEvent;
    if (e.kind !== "done") state.reached = stageFromEvent(e, state.reached);

    if (e.kind === "partial") {
      const full = e.text ?? "";
      const delta = full.startsWith(lastAcc) ? full.slice(lastAcc.length) : full;
      lastAcc = full;
      if (delta) {
        const last = state.log[state.log.length - 1];
        if (last && last.kind === "partial") {
          state.log = [
            ...state.log.slice(0, -1),
            { kind: "partial", text: (last.text + delta).slice(-4000), at: last.at },
          ];
        } else {
          pushLog("partial", delta);
        }
      }
    } else if (e.kind === "stage") {
      pushLog("stage", e.text ?? e.stage ?? "");
    } else if (e.kind === "log") {
      pushLog("log", e.text ?? "");
    } else if (e.kind === "done") {
      const assistantText = e.text ?? "";
      history.push({ role: "user", text: input });
      history.push({ role: "assistant", text: assistantText });
      detach();

      const complete = /BUILD_COMPLETE/i.test(assistantText);
      if (complete) {
        state.reached = STAGE_COUNT;
        const r = e.result as { workspace?: string; securityScan?: unknown } | undefined;
        const baseWs = r?.workspace ?? workspace;
        // 등록 대상: BUILD_COMPLETE가 만든 하위 패키지 폴더(있으면 그것만). 없으면 워크스페이스 —
        // 단 워크스페이스가 정크 폴더(trash/tmp 등)면 부모 전체가 회사로 잡히는 걸 막으려 자동등록 생략.
        const pkgPath = packagePathFromText(baseWs, assistantText);
        const registerPath = pkgPath ?? (JUNK_WS.test(wsBasename(baseWs)) ? null : baseWs);
        state.result = { workspace: pkgPath ?? baseWs, securityScan: r?.securityScan ?? null };
        pushLog("done", "빌드 완료 — 패키지 생성됨");
        state.phase = "done";
        commit();
        if (registerPath) {
          void autoRegister(registerPath);
        } else {
          pushLog("log", "자동 등록 생략(공용 폴더) — '조직도에서 열기'로 생성된 패키지 폴더만 직접 추가하세요.");
          commit();
        }
        return;
      }

      // 인터뷰 일시정지 — 질문 파싱 후 사용자 답변 대기.
      const parsed = extractQuestions(assistantText, `t${state.turn}`);
      cleanLastPartial(parsed.text);
      state.pendingQuestions = parsed.questions;
      state.awaitingReply = true;
      state.phase = "interview";
      state.turn += 1;
      state.reached = Math.max(state.reached, 1);
      pushLog(
        "log",
        parsed.questions.length
          ? "딥인터뷰 — 아래에서 답해 주세요."
          : "어시스턴트가 추가 정보를 기다립니다 — 아래에 답해 주세요.",
      );
      rememberInterviewCheckpoint();
      commit();
      return;
    } else if (e.kind === "error") {
      state.errored = true;
      pushLog("error", e.text ?? "오류");
      state.phase = "error";
      detach();
    }
    commit();
  });
  void api.hephaestus.buildReady(runId);
}

export async function startBuild(): Promise<void> {
  if (!state.request.trim() || !state.workspace || state.phase === "running") return;
  // 새 빌드 — 대화/로그/단계 초기화.
  history = [];
  interviewCheckpoints = [];
  state.turn = 0;
  state.reached = 0;
  state.result = null;
  state.registered = false;
  state.log = [];
  pushLog("stage", "딥인터뷰 시작 — Hephaestus 빌더 에이전트 가동");
  pushLog("log", `요청 길이 ${state.request.trim().length}자 · 모드 ${state.mode || "자동 분류"}`);
  pushLog("log", `생성 폴더 ${state.workspace}`);
  if (state.runtime) pushLog("log", `엔진 ${state.runtime.kind}${state.runtime.model ? ` · ${state.runtime.model}` : ""}`);
  commit();
  await runTurn(state.request.trim());
}

/** 인터뷰 답변 제출 — 다음 턴 실행. */
export async function answerBuild(reply: string): Promise<void> {
  if (!state.awaitingReply || !reply.trim()) return;
  pushLog("log", `↳ 답변: ${reply.trim().slice(0, 240)}`);
  commit();
  await runTurn(reply.trim());
}

/** 현재 딥인터뷰 대기 상태에서 바로 이전 답변 단계로 되돌린다. */
export function rewindBuildInterview(): void {
  if (state.phase !== "interview" || interviewCheckpoints.length < 2) return;
  detach();
  const target = interviewCheckpoints[interviewCheckpoints.length - 2];
  interviewCheckpoints = interviewCheckpoints.slice(0, -1);
  history = cloneHistory(target.history);
  currentInput = "";
  state.phase = "interview";
  state.errored = false;
  state.awaitingReply = true;
  state.pendingQuestions = cloneQuestions(target.pendingQuestions);
  state.turn = target.turn;
  state.reached = target.reached;
  state.log = cloneLog(target.log);
  state.result = null;
  state.runId = null;
  state.registered = false;
  pushLog("log", `${target.turn}번째 답변으로 돌아갔습니다 — 다시 선택해 주세요.`);
  commit();
}

export function cancelBuild() {
  if (state.runId) ipc()?.hephaestus.cancelBuild(state.runId);
  state.phase = "idle";
  state.reached = 0;
  state.awaitingReply = false;
  state.pendingQuestions = [];
  interviewCheckpoints = [];
  detach();
  commit();
}

export function resetBuild() {
  state.phase = "idle";
  state.reached = 0;
  state.errored = false;
  state.log = [];
  state.result = null;
  state.runId = null;
  state.registered = false;
  state.awaitingReply = false;
  state.pendingQuestions = [];
  state.turn = 0;
  state.canRewindInterview = false;
  history = [];
  interviewCheckpoints = [];
  commit();
}
