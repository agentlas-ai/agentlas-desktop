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
import { isCompletedBuildTurn } from "@shared/build-turn";
import type { ChatQuestion } from "@/components/ChatStream";
import type { FsPathGrant, FsReadScope, HephaestusBuildEvent, RuntimeSelection } from "@/lib/types";

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
  readScope: FsReadScope;
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
}

// 빌드 파이프라인 단계 수 — 화면의 STAGES 배열과 일치(모드분류·인터뷰/리서치·생성·검증·배포).
export const STAGE_COUNT = 5;

const WS_KEY = "agentlas.build.workspace";

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
  result: null,
  runId: null,
  registered: false,
  pendingQuestions: [],
  awaitingReply: false,
  turn: 0,
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
// 런타임이 sessionId를 반환하지 않는 BYOK/Ollama도 첨부는 한 빌드에서 정확히 한 번만 보낸다.
let attachmentsSentForBuild = false;
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

/** 빌드 완료 시 결과 폴더를 라이브러리(조직도)에 자동 등록 — "조직도에 안 뜬다" 문제 해소. */
async function autoRegister(workspace: string, readScope: FsReadScope) {
  const api = ipc();
  if (!api) return;
  const ko = currentLocale() === "ko";
  try {
    pushLog("stage", ko ? "조직도에 등록 중 — 라이브러리에 추가" : "Registering to org chart — adding to library");
    const imported = await api.team.importLocalFolder({ path: workspace, scope: readScope });
    state.registered = true;
    const who = imported?.name || imported?.slug || (ko ? "에이전트" : "agent");
    pushLog("done", ko ? `조직도에 추가됨: ${who}` : `Added to org chart: ${who}`);
  } catch (e) {
    pushLog(
      "error",
      ko
        ? `조직도 등록 실패: ${(e as Error).message} — '라이브러리에 설치'로 다시 시도하세요.`
        : `Failed to register to org chart: ${(e as Error).message} — retry with "Install to library".`,
    );
  }
  commit();
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
function finalizeBuild(pkgRoot: string, scan: unknown, readScope: FsReadScope, note: string | null): void {
  const ko = currentLocale() === "ko";
  state.reached = STAGE_COUNT;
  state.result = { workspace: pkgRoot, securityScan: scan, readScope };
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
    void autoRegister(pkgRoot, readScope);
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
    );
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
  if (!api || !ev || !state.workspace || !state.workspaceGrant || !isCurrentBuild(generation)) return;
  const ko = currentLocale() === "ko";

  detach();
  lastAcc = "";
  state.phase = "running";
  state.errored = false;
  state.awaitingReply = false;
  state.pendingQuestions = [];
  const workspace = state.workspace;
  const readScope = state.workspaceGrant.scope;
  commit();

  let runId: string;
  try {
    const started = await api.hephaestus.build({
      request: input,
      mode: state.mode || undefined,
      workspaceGrant: state.workspaceGrant,
      runtime: state.runtime || undefined,
      runtimeSessionId: runtimeSessionId || undefined,
      // 첨부는 런타임 sessionId 유무와 무관하게 한 빌드에서 정확히 한 번만 스테이징한다.
      attachments: attachmentsSentForBuild
        ? undefined
        : state.attachments.map((a) => ({ grant: a.grant, name: a.name })),
      history: [...history],
      locale: currentLocale(),
    });
    if (!isCurrentBuild(generation)) return;
    if (!started?.runId) throw new Error(ko ? "빌드 실행 ID를 받지 못했습니다." : "Build did not return a run ID.");
    if (state.attachments.length > 0) attachmentsSentForBuild = true;
    runId = started.runId;
  } catch (error) {
    if (!isCurrentBuild(generation)) return;
    state.errored = true;
    state.phase = "error";
    state.runId = null;
    pushLog(
      "error",
      ko
        ? `빌드를 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`
        : `Could not start build: ${error instanceof Error ? error.message : String(error)}`,
    );
    commit();
    return;
  }
  state.runId = runId;
  commit();

  const channel = api.hephaestus.buildEventChannel(runId);
  unsub = ev.on(channel, (raw) => {
    if (!isCurrentBuild(generation) || state.runId !== runId) return;
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
      if (e.sessionId) runtimeSessionId = e.sessionId;
      history.push({ role: "user", text: input });
      history.push({ role: "assistant", text: assistantText });
      detach();

      const complete = isCompletedBuildTurn(assistantText);
      if (complete) {
        state.reached = STAGE_COUNT;
        const r = e.result as { workspace?: string; securityScan?: unknown } | undefined;
        // Main has already canonicalized and scope-checked the model-authored
        // BUILD_COMPLETE target. Never reinterpret that path in the renderer.
        const packageRoot = r?.workspace ?? workspace;
        const registerPath = JUNK_WS.test(wsBasename(packageRoot)) ? null : packageRoot;
        state.result = { workspace: packageRoot, securityScan: r?.securityScan ?? null, readScope };
        pushLog("done", ko ? "빌드 완료 — 패키지 생성됨" : "Build complete — package created");
        state.phase = "done";
        commit();
        if (registerPath && buildScanDisposition(r?.securityScan ?? null) === "passed") {
          void autoRegister(registerPath, readScope);
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
      if (state.turn === 0 && parsed.questions.length > 0) {
        state.pendingQuestions = parsed.questions;
        state.awaitingReply = true;
        state.phase = "interview";
        state.turn += 1;
        state.reached = Math.max(state.reached, 1);
        pushLog("log", ko ? "딥인터뷰 — 질문 묶음에 한 번에 답해 주세요." : "Deep interview — answer the batch of questions in one go.");
        commit();
        return;
      }
      state.turn += 1;
      const scanFromEvent = (e.result as { securityScan?: unknown } | undefined)?.securityScan ?? null;
      void resolveTurnWithoutSignal(workspace, scanFromEvent, readScope, generation);
      return;
    } else if (e.kind === "error") {
      state.errored = true;
      pushLog("error", e.text ?? (ko ? "오류" : "Error"));
      state.phase = "error";
      detach();
    }
    commit();
  });
  void api.hephaestus.buildReady(runId).catch((error) => {
    if (!isCurrentBuild(generation) || state.runId !== runId) return;
    state.errored = true;
    state.phase = "error";
    pushLog(
      "error",
      ko
        ? `빌드 이벤트 연결에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`
        : `Could not attach to build events: ${error instanceof Error ? error.message : String(error)}`,
    );
    detach();
    void api.hephaestus.cancelBuild(runId);
    commit();
  });
}

export async function startBuild(): Promise<void> {
  if (!state.request.trim() || !state.workspace || !state.workspaceGrant || state.phase === "running") return;
  // 새 빌드 — 대화/로그/단계 초기화.
  history = [];
  runtimeSessionId = null;
  attachmentsSentForBuild = false;
  autoContinues = 0;
  const generation = ++buildGeneration;
  state.turn = 0;
  state.reached = 0;
  state.result = null;
  state.registered = false;
  state.log = [];
  const ko = currentLocale() === "ko";
  const reqLen = state.request.trim().length;
  const mode = state.mode || (ko ? "자동 분류" : "auto-classify");
  pushLog("stage", ko ? "딥인터뷰 시작 — Hephaestus 빌더 에이전트 가동" : "Deep interview started — Hephaestus builder agent engaged");
  pushLog("log", ko ? `요청 길이 ${reqLen}자 · 모드 ${mode}` : `Request length ${reqLen} chars · mode ${mode}`);
  pushLog("log", ko ? `생성 폴더 ${state.workspace}` : `Output folder ${state.workspace}`);
  if (state.attachments.length > 0) pushLog("log", ko ? `첨부 ${state.attachments.length}개: ${state.attachments.map((a) => a.name).join(", ").slice(0, 200)}` : `Attachments ${state.attachments.length}: ${state.attachments.map((a) => a.name).join(", ").slice(0, 200)}`);
  if (state.runtime) pushLog("log", `${ko ? "엔진" : "Engine"} ${state.runtime.kind}${state.runtime.model ? ` · ${state.runtime.model}` : ""}`);
  commit();
  await runTurn(state.request.trim(), generation);
}

/** 인터뷰 답변 제출 — 다음 턴 실행. */
export async function answerBuild(reply: string): Promise<void> {
  if (!state.awaitingReply || !reply.trim()) return;
  const ko = currentLocale() === "ko";
  pushLog("log", `↳ ${ko ? "답변" : "Reply"}: ${reply.trim().slice(0, 240)}`);
  commit();
  await runTurn(reply.trim(), buildGeneration);
}

export function cancelBuild() {
  const cancelledRunId = state.runId;
  buildGeneration += 1;
  if (cancelledRunId) ipc()?.hephaestus.cancelBuild(cancelledRunId);
  state.phase = "idle";
  state.reached = 0;
  state.awaitingReply = false;
  state.pendingQuestions = [];
  state.runId = null;
  runtimeSessionId = null;
  attachmentsSentForBuild = false;
  autoContinues = 0;
  detach();
  commit();
}

export function resetBuild() {
  buildGeneration += 1;
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
  history = [];
  runtimeSessionId = null;
  attachmentsSentForBuild = false;
  autoContinues = 0;
  commit();
}

/** 수동 재스캔 결과를 전역 build session에 반영해 모든 결과/토스트 액션이 같은 게이트를 본다. */
export function updateBuildSecurityScan(scan: unknown): void {
  if (!state.result) return;
  state.result = { ...state.result, securityScan: scan };
  commit();
}
