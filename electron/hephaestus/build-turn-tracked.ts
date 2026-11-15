// One Build turn, tracked: the part of `hephaestus:build` that makes a turn a turn of the Build list (Agentlas 2.0 PB-D, contracts/phone-build2.md section 2-1).
//
// It was the body of the IPC handler in ipc.ts. It is one function now so the Build window (IPC) and the phone (mobile-bridge/build-turns.ts) run a turn the same way:
// one Build at a time (`activeBuilds`, `BUILD_ALREADY_ACTIVE`), the progress record the list reads ("Building n/6", `isRunning`), the saved conversation row (written as
// "unknown" at the start, "completed" / "waiting-user" / "stopped" at the end), the refusal while the agent of an Edit runs, and the file signal.
//
// No Electron import and no module state of ipc.ts: what the app owns arrives through `TrackedBuildDeps`, so a gate can run the function with a fake runner and a temp
// database. The window is only an object with `isDestroyed()` and `webContents.send`.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { HephaestusBuildEvent, HephaestusBuildRequest } from "../../shared/types";
import { isCompletedBuildTurn } from "../../shared/build-turn";
import { readLatestBuilderConversation, writeBuilderConversation, type StoredBuilderConversation } from "./builder-conversation-store";

export interface BuildTranscript {
  runId: string;
  request: string;
  workspace: string;
  startedAt: string;
  running: boolean;
  events: HephaestusBuildEvent[];
  /** Validated turn input, kept in Main and returned only to a trusted app frame. */
  recoveryRequest?: HephaestusBuildRequest;
  /** Events dropped from the front by the window below: events[i] is event number firstSeq + i of this build. */
  firstSeq: number;
}

// Hephaestus 빌더(hep-build) 진행 중 실행 — 취소용 AbortController 레지스트리.
export const activeBuilds = new Map<string, AbortController>();
/**
 * 실행 중(또는 마지막) 빌드의 전사(轉寫).
 *
 * 빌드는 main에서 돌지만 진행 상태는 렌더러 모듈 변수에만 있었다. 그래서 빌드 중에
 * 다른 메뉴를 한 번 누르면 요청·로그·단계가 통째로 사라졌다(실측:
 * rows 10→0, request 소실, 화면상 "멈춤" — 실제로는 main에서 계속 돌고 있었다).
 * 터미널 hep-build는 프로세스가 살아 있는 한 화면을 잃지 않으므로, 이건 GUI가
 * 만들어 낸 차이다. 여기 전사를 남겨 두면 화면이 돌아왔을 때 그대로 복원된다.
 */
export const buildTranscripts = new Map<string, BuildTranscript>();
/** 한 빌드가 남기는 이벤트 상한 — 긴 빌드가 메모리를 무한히 쓰지 않게. */
export const BUILD_TRANSCRIPT_MAX_EVENTS = 4_000;
// runId → "렌더러 구독 완료" 신호. 구독 전 발생한 이벤트를 버퍼링하다 이 신호로 flush 한다.
export const buildReadySignals = new Map<string, () => void>();
// 조기 실패가 렌더러의 invoke 응답보다 먼저 끝나도 terminal event를 잃지 않는다.
// 렌더러가 사라진 비정상 경로만 유한 시간 뒤 정리한다.
export const BUILD_READY_GRACE_MS = 30_000;

export interface TrackedBuildOwner { userId: string; workspaceId: string; sessionId: string; scope: "account" | "local" }
export interface TrackedBuildWindow { isDestroyed(): boolean; webContents: { send(channel: string, event: unknown): void } }
type ResolvedRequest = {
  workspace: string;
  mcpAttachment?: { receipt?: unknown };
  runtime?: unknown;
} & Record<string, unknown>;

/** What the app owns that a turn needs. ipc.ts passes the real ones; a gate passes fakes. */
export interface TrackedBuildDeps {
  ownerBinding(): TrackedBuildOwner;
  getDb(): Database.Database;
  workspaceIdentity(workspace: string): StoredBuilderConversation["workspaceIdentity"];
  /** Paths from the grant, no MCP application (hephaestus/build-access.ts). */
  resolveRequest(req: HephaestusBuildRequest): ResolvedRequest;
  /** Paths and the MCP consent, re-resolved in Main. */
  resolveRequestForRun(req: HephaestusBuildRequest, signal: AbortSignal): Promise<ResolvedRequest>;
  /** "agent_running" / "root_move_active" while the agent of an Edit is busy; null = free. */
  turnRefusal(workspace: string): Promise<string | null>;
  startFilesSignal(input: { runId: string; folder: string; window: TrackedBuildWindow | null }): { poke(): void; stop(): void };
  runBuild(
    runId: string,
    resolved: ResolvedRequest,
    emit: (event: HephaestusBuildEvent) => void,
    signal: AbortSignal,
    locale: "ko" | "en",
    onRuntimeResolved: (runtime: unknown) => void,
  ): Promise<void>;
  locale(req: HephaestusBuildRequest): "ko" | "en";
}

export interface TrackedBuildOptions {
  /** The window that started the turn (its events and file signal go there). null = a turn started by something else (the phone). */
  window: TrackedBuildWindow | null;
  /**
   * The caller has no renderer to wait for (no `buildReady`): events are delivered at once and the turn keeps no buffer for it. A turn started with a window waits for that
   * window's `buildReady` and flushes what happened before it.
   */
  immediate?: boolean;
  /** Every event of the turn, in order, as it is published (the phone's sink). The terminal event comes last, after the turn released its reservation. */
  deliver?: (event: HephaestusBuildEvent) => void;
  /** The caller's own cancel: aborting it stops this turn. */
  signal?: AbortSignal;
  /** A turn that carries a runtime session does not apply the MCP consent again (the phone's rule: the first turn of a session did). */
  skipMcpApply?: boolean;
  /**
   * Keep the validated request for the window to recover after a reload (`hephaestus:recoverBuildTurn`; default yes). A phone's turn passes false: its request carries folder grants
   * Main made for the phone, and they must not reach a renderer (contracts/phone-build2.md section 8).
   */
  recoverable?: boolean;
}

export interface TrackedBuildStarted {
  runId: string;
  mcpReceipt: unknown;
  /** Settles when the turn is over and its terminal event has been published; never rejects. */
  done: Promise<void>;
}

const RUN_ID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sameOwner = (a: TrackedBuildOwner, b: TrackedBuildOwner): boolean => a.scope === b.scope && a.userId === b.userId && a.workspaceId === b.workspaceId && a.sessionId === b.sessionId;

/**
 * The turn, from the reservation (`BUILD_ALREADY_ACTIVE` before anything is written) to the running builder. Throws the same machine words the IPC handler always threw
 * (BUILD_ALREADY_ACTIVE, BUILD_OWNER_CHANGED, BUILD_WORKSPACE_CHANGED, BUILD_SESSION_RECEIPT_REQUIRED, BUILD_AGENT_RUNNING, ...) and leaves nothing running when it throws.
 */
export async function runTrackedBuildTurn(deps: TrackedBuildDeps, req: HephaestusBuildRequest, options: TrackedBuildOptions): Promise<TrackedBuildStarted> {
  const initialBinding = deps.ownerBinding();
  // Reserve before the first async boundary. A second renderer must not start
  // another build or replace the transcript while authorization is pending.
  // New renderers provide an opaque id so Stop can reach this reservation
  // before invoke() returns; older renderers continue to use a Main id.
  const requestedId = (req as HephaestusBuildRequest & { clientRunId?: unknown }).clientRunId;
  if (requestedId !== undefined && (typeof requestedId !== "string" || !RUN_ID_V4.test(requestedId))) {
    throw new Error("Invalid build request identifier.");
  }
  if (activeBuilds.size > 0) throw new Error("BUILD_ALREADY_ACTIVE");
  const runId = typeof requestedId === "string" ? requestedId : randomUUID();
  if (buildTranscripts.has(runId)) throw new Error("Build request identifier was already used.");
  const channel = `hephaestus:build:${runId}`;
  const win = options.window;
  const immediate = options.immediate === true;
  const controller = new AbortController();
  activeBuilds.set(runId, controller);
  const callerSignal = options.signal;
  const abortWithCaller = (): void => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", abortWithCaller, { once: true });
  }
  const releaseCaller = (): void => callerSignal?.removeEventListener("abort", abortWithCaller);
  buildTranscripts.set(runId, {
    runId,
    request: String(req.request ?? ""),
    workspace: "",
    startedAt: new Date().toISOString(),
    running: true,
    events: [],
    firstSeq: 0,
  });
  // Keep a few finished records; never clear a live record to admit a new one.
  while (buildTranscripts.size > 10) {
    const oldestFinished = [...buildTranscripts].find(([, item]) => !item.running)?.[0];
    if (!oldestFinished) break;
    buildTranscripts.delete(oldestFinished);
  }
  let resolvedRequest: ResolvedRequest;
  // The file-level progress of this turn for the Build window's right pane (signals from the folder and from the turn's own events).
  let filesSignal: { poke(): void; stop(): void } | null = null;
  let savedConversation: StoredBuilderConversation | null = null;
  let previousConversation: StoredBuilderConversation | null = null;
  try {
    const preliminary = deps.resolveRequest(req);
    if (req.runtimeSessionId) {
      if (!initialBinding) throw new Error("BUILD_SESSION_OWNER_REQUIRED");
      previousConversation = readLatestBuilderConversation(deps.getDb(), initialBinding);
      const workspace = preliminary.workspace;
      if (!previousConversation || previousConversation.runtimeSessionId !== req.runtimeSessionId
        || previousConversation.workspace !== workspace || !previousConversation.runtime
        || JSON.stringify(previousConversation.workspaceIdentity) !== JSON.stringify(deps.workspaceIdentity(workspace))
        || req.runtimePinned !== true || JSON.stringify(previousConversation.runtime) !== JSON.stringify(req.runtime)
        || !["waiting-user", "completed"].includes(previousConversation.status)) throw new Error("BUILD_SESSION_RECEIPT_REQUIRED");
    }
    if (initialBinding) {
      const current = deps.ownerBinding();
      if (!sameOwner(current, initialBinding)) throw new Error("BUILD_OWNER_CHANGED");
      savedConversation = {
        schema: 1, revision: 0, buildId: runId, workspace: preliminary.workspace,
        workspaceIdentity: deps.workspaceIdentity(preliminary.workspace),
        request: String(req.request ?? ""), history: structuredClone(req.history ?? []),
        runtimeSessionId: req.runtimeSessionId ?? null, hostAuthoredContinuation: req.hostAuthoredContinuation === true,
        conversationTurn: req.conversationTurn ?? null,
        terminalText: null, supplementalQuestion: null, mode: req.mode ?? null,
        runtime: null, runtimePinned: false,
        status: "unknown", updatedAt: new Date().toISOString(),
      };
      writeBuilderConversation(deps.getDb(), initialBinding, savedConversation, null);
    }
    // Record the pending input before consent application can have effects.
    resolvedRequest = options.skipMcpApply
      ? (controller.signal.throwIfAborted(), deps.resolveRequest(req))
      : await deps.resolveRequestForRun(req, controller.signal);
    controller.signal.throwIfAborted();
    const current = deps.ownerBinding();
    if (!sameOwner(current, initialBinding)) throw new Error("BUILD_OWNER_CHANGED");
    if (savedConversation && (resolvedRequest.workspace !== savedConversation.workspace
      || JSON.stringify(deps.workspaceIdentity(resolvedRequest.workspace)) !== JSON.stringify(savedConversation.workspaceIdentity))) throw new Error("BUILD_WORKSPACE_CHANGED");
    const transcript = buildTranscripts.get(runId);
    if (transcript) {
      transcript.workspace = resolvedRequest.workspace;
      if (options.recoverable !== false) transcript.recoveryRequest = structuredClone(req);
    }
    // An Edit of an installed agent must not run while that agent runs a turn or its folder is being moved (machine code, nothing started).
    const agentBusy = await deps.turnRefusal(resolvedRequest.workspace);
    if (agentBusy) throw new Error(`BUILD_${agentBusy.toUpperCase()}`);
    filesSignal = deps.startFilesSignal({ runId, folder: resolvedRequest.workspace, window: win });
  } catch (error) {
    filesSignal?.stop();
    if (savedConversation && controller.signal.aborted) {
      try { writeBuilderConversation(deps.getDb(), initialBinding, { ...savedConversation, revision: 1, status: "stopped", updatedAt: new Date().toISOString() }, 0); } catch { /* unknown remains */ }
    }
    activeBuilds.delete(runId);
    releaseCaller();
    const transcript = buildTranscripts.get(runId);
    if (transcript) {
      transcript.running = false;
      transcript.events.push({ runId, kind: "error", text: controller.signal.aborted ? "Build cancelled" : "Build preparation failed" });
    }
    throw error;
  }
  // 렌더러는 build() 응답을 await 한 뒤에야 채널을 구독하므로, 그 사이에 발생한 첫 이벤트
  // (예: 'build' stage 틱)가 유실될 수 있다. 렌더러가 buildReady 로 구독 완료를 알릴 때까지
  // 이벤트를 버퍼링했다가 한 번에 flush 한다(첫 stage 틱 손실 방지).
  const pending: HephaestusBuildEvent[] = [];
  const terminalEvents: HephaestusBuildEvent[] = [];
  let ready = immediate;
  let readyExpiry: NodeJS.Timeout | null = null;
  let finishDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { finishDone = resolve; });
  // 창이 닫힌 뒤 send는 throw하므로 destroyed 가드(빌드 종료와 닫기가 겹치는 경우).
  const sendToWin = (ev: HephaestusBuildEvent) => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(channel, ev); } catch {}
    }
  };
  const publish = (ev: HephaestusBuildEvent) => {
    const current = deps.ownerBinding();
    if (!sameOwner(current, initialBinding)) return;
    const transcript = buildTranscripts.get(runId);
    if (transcript) {
      transcript.events.push(ev);
      if (transcript.events.length > BUILD_TRANSCRIPT_MAX_EVENTS) {
        const dropped = transcript.events.length - BUILD_TRANSCRIPT_MAX_EVENTS;
        transcript.events.splice(0, dropped);
        transcript.firstSeq += dropped;
      }
    }
    if (ev.kind === "stage" || ev.kind === "log") filesSignal?.poke();
    if (options.deliver) {
      try { options.deliver(ev); } catch { /* a failing consumer does not stop the turn */ }
    }
    if (ready) {
      sendToWin(ev);
    } else {
      pending.push(ev);
    }
  };
  // A continuation can start as soon as it receives done/error. Deliver those
  // events only after the preceding runner has released its reservation.
  const emit = (ev: HephaestusBuildEvent) => {
    if (ev.kind === "done" || ev.kind === "error") terminalEvents.push(ev);
    else publish(ev);
  };
  if (!immediate) {
    buildReadySignals.set(runId, () => {
      if (ready) return;
      ready = true;
      if (readyExpiry) clearTimeout(readyExpiry);
      for (const ev of pending) sendToWin(ev);
      pending.length = 0;
      buildReadySignals.delete(runId);
    });
  }
  void deps.runBuild(runId, resolvedRequest, emit, controller.signal, deps.locale(req), (runtime) => {
    controller.signal.throwIfAborted();
    const current = deps.ownerBinding();
    if (!sameOwner(current, initialBinding)) throw new Error("BUILD_OWNER_CHANGED");
    if (savedConversation && JSON.stringify(deps.workspaceIdentity(resolvedRequest.workspace)) !== JSON.stringify(savedConversation.workspaceIdentity)) throw new Error("BUILD_WORKSPACE_CHANGED");
    if (previousConversation && JSON.stringify(previousConversation.runtime) !== JSON.stringify(runtime)) throw new Error("BUILD_SESSION_RUNTIME_MISMATCH");
    if (savedConversation && initialBinding) {
      savedConversation = { ...savedConversation, revision: 1, runtime: runtime as StoredBuilderConversation["runtime"], runtimePinned: true, updatedAt: new Date().toISOString() };
      writeBuilderConversation(deps.getDb(), initialBinding, savedConversation, 0);
    }
  }).catch(() => {
    emit({ runId, kind: "error", text: controller.signal.aborted ? "Build cancelled" : "Build failed" });
  }).finally(() => {
    activeBuilds.delete(runId);
    releaseCaller();
    const finished = buildTranscripts.get(runId);
    if (finished) finished.running = false;
    // A cleanup failure after an apparent done must win over that earlier
    // success; consumers detach after the first terminal event.
    const terminal = terminalEvents.at(-1) ?? {
      runId,
      kind: "error" as const,
      text: controller.signal.aborted ? "Build cancelled" : "Build ended without a completion receipt",
    };
    let conversationSaveFailed = false;
    if (savedConversation && initialBinding) {
      const done = [...terminalEvents].reverse().find((item) => item.kind === "done");
      const result = done?.result as { supplementalQuestion?: unknown } | undefined;
      const status = controller.signal.aborted ? "stopped" : terminal.kind === "done"
        ? (isCompletedBuildTurn(terminal.text ?? "") ? "completed" : "waiting-user") : "unknown";
      try {
        writeBuilderConversation(deps.getDb(), initialBinding, {
          ...savedConversation, revision: savedConversation.revision + 1, status,
          terminalText: done?.text ?? null,
          supplementalQuestion: result?.supplementalQuestion ?? null,
          runtimeSessionId: done?.sessionId ?? savedConversation.runtimeSessionId,
          updatedAt: new Date().toISOString(),
        }, savedConversation.revision);
      } catch {
        // Preserve the earlier unknown record; a failed checkpoint is not completion.
        conversationSaveFailed = true;
      }
    }
    filesSignal?.stop();
    if (conversationSaveFailed) publish({ runId, kind: "log", text: deps.locale(req) === "ko"
      ? "대화 복원 기록을 저장하지 못했습니다. 앱을 다시 시작하기 전에 현재 결과를 확인해 주세요."
      : "The conversation recovery record could not be saved. Review this result before restarting the app." });
    publish(terminal);
    // If buildReady already fired, its callback removed the signal. Otherwise
    // retain the buffered terminal event long enough for invoke() to resolve,
    // the renderer to subscribe, and buildReady() to flush it.
    if (!ready) {
      readyExpiry = setTimeout(() => {
        buildReadySignals.delete(runId);
        pending.length = 0;
      }, BUILD_READY_GRACE_MS);
      readyExpiry.unref?.();
    }
    finishDone();
  });
  return { runId, mcpReceipt: options.skipMcpApply ? undefined : resolvedRequest.mcpAttachment!.receipt, done };
}

// Which saved turn is a phone's run (contracts/phone-build2.md `build2.forRun`). The phone's run id is its own string (`mobile-build-<session>-<n>`); a saved turn is keyed by a
// version-4 UUID, and one phone run can be several turns (the interview answers). So the Desktop keeps the newest turn of each phone run it started, in memory only: a restart
// ends every phone run anyway (`build.status` says so), and the saved Build is then found by the list. At most MAX entries, the oldest forgotten first; no timer.
const EXTERNAL_RUN_MAX = 64;
const externalRuns = new Map<string, string>();
export function noteExternalRun(externalRunId: string, buildId: string): void {
  externalRuns.delete(externalRunId);
  externalRuns.set(externalRunId, buildId);
  while (externalRuns.size > EXTERNAL_RUN_MAX) externalRuns.delete(externalRuns.keys().next().value as string);
}
export function buildIdOfExternalRun(externalRunId: string): string | null { return externalRuns.get(externalRunId) ?? null; }
/** Only for gates. */
export function forgetExternalRuns(): void { externalRuns.clear(); }

// The deps the app registered (ipc.ts, with the window's `hephaestus:build`): the phone's Build turn runs with the same ones. null in a process that did not register them (the background service).
let registeredDeps: TrackedBuildDeps | null = null;
export function registerTrackedBuildDeps(deps: TrackedBuildDeps): void { registeredDeps = deps; }
export function trackedBuildDepsOrNull(): TrackedBuildDeps | null { return registeredDeps; }
