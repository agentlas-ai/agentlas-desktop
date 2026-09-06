// Codex 상주 세션 — 턴마다 스폰-종료하던 `codex exec` 를 `codex app-server` 로 붙든다.
//
// ★정정된 전제. "codex 는 구조적으로 상주 불가"는 틀린 결론이었다(`codex exec --help`만
// 읽고 내린 판정). 루트 `codex --help` 의 Commands 에는 `app-server` 가 있고, 그것은
// JSON-RPC(NDJSON) **양방향 상주 서버**다.
//
// ★실측(2026-08-20, 이 기계, codex-cli 0.148.0):
//   codex app-server --listen stdio://
//   · `initialize` → `thread/start` → `turn/start` 순서. `turn/start` 는 **즉시** 반환한다
//     (실측 11ms, `{turn:{id,status:"inProgress"}}`) — 턴의 끝은 `turn/completed` 알림이다.
//   · 한 프로세스·한 thread 에서 두 턴이 처리된다(연구 문서 pid 10613).
//   · 알림: `item/agentMessage/delta`(스트리밍) · `thread/tokenUsage/updated`(last=이번 턴,
//     total=스레드 누적) · `item/started`/`item/completed`(도구·추론) · `turn/started`/
//     `turn/completed`(status: completed|failed|interrupted, error: {message, codexErrorInfo})
//     · `warning` · `mcpServer/startupStatus/updated` · `account/rateLimits/updated`.
//   · 서버→클라이언트 **요청**: 6종의 승인/입력 요청(아래 CODEX_SERVER_REQUESTS).
//
// ★이게 상주보다 큰 수확이다. 지금까지 codex 는 헤드리스라 실행 **전에** 물어볼 길이 없어
// post-denial(이미 거부하고 지나감)만 가능했다. app-server 로 가면 codex 도 ACP 처럼
// 실행 전 live 승인 — 우리 승인 칩 — 에 참여한다.
//
// ★새로 만들지 않은 것들(같은 계약을 세 번째로 손코딩하면 언젠가 하나만 고쳐진다):
//   · 전송: acp-protocol.ts 의 AcpConnection. 의존성 0의 JSON-RPC ndjson 구현이고
//     codex app-server 도 정확히 그 프로토콜이다(요청/응답 + 알림 + 서버→클라 요청).
//     이름만 ACP 를 달고 있을 뿐 스펙 고유 로직은 이 클래스에 없다.
//   · 풀: acp-session-pool.ts 의 AcpSessionPool<S>(배타적 체크아웃·LRU·12h sweep·죽은
//     세션 폐기). claude-session.ts 에 이어 세 번째 사용자다.
//   · 스위치: claude-session.ts 의 residencyDisabledFor(`AGENTLAS_DISABLE_RESIDENCY`).
//   · 승인: tool-approval.ts 의 중재자 등록소(ACP answerPermission 과 같은 계약).
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpConnection, AcpRpcError } from "./acp-protocol";
import { AcpSessionPool, type AcpSessionLease } from "./acp-session-pool";
import { detachedSpawnOpts, killCliTree, spawnCli, trackRunChild } from "./exec";
import { ensureChildCloseAfterExit, startCliHeartbeat } from "./runner";
import {
  capabilityClassFor,
  defaultRuntimeToolPermission,
  getRuntimeToolPermissionArbiter,
  type RuntimeToolPermissionAsk,
  type RuntimeToolPermissionDecision,
} from "./tool-approval";
import { CODEX_MCP_ELICITATION_METHOD } from "./codex-elicitation";

export type { AcpSessionLease };

/** 스폰 형상 — `--listen stdio://` 는 기본값이지만 명시한다(계약을 argv 에 남긴다). */
export const CODEX_APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const;

/*
 * ── 버전 스큐 관측 ────────────────────────────────────────────────────────────
 * `app-server` 는 CLI 가 [experimental] 로 표시한다 — 버전에 따라 계약이 바뀔 수 있다.
 * 그래서 (a) 우리가 실제로 쓰는 메서드 이름을 상수로 못박고, (b) 같은 이름을 저장소
 * 픽스처(scripts/fixtures/codex-app-server-methods.json)에 고정한다. 게이트가 둘을
 * 대조하므로, 코드가 새 메서드를 쓰기 시작하면 픽스처도 함께 갱신돼야 통과한다.
 * 픽스처 재생성: `codex app-server generate-json-schema --out <DIR>`.
 */
export const CODEX_CLIENT_REQUESTS = [
  "initialize",
  "model/list",
  "thread/resume",
  "thread/start",
  "turn/interrupt",
  "turn/start",
] as const;

/** 실행 승인을 묻는 서버 요청. MCP form elicitation은 정보 입력이며 별도 경계다. */
export const CODEX_APPROVAL_REQUESTS = [
  "applyPatchApproval",
  "execCommandApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
] as const;

/** 서버가 우리에게 보내는 요청 — 승인, MCP elicitation, Main-owned dynamic tool call. */
export const CODEX_SERVER_REQUESTS = [
  ...CODEX_APPROVAL_REQUESTS,
  CODEX_MCP_ELICITATION_METHOD,
  "item/tool/call",
] as const;

/** 우리가 실제로 소비하는 알림. 여기 없는 알림은 무시된다(모르는 것을 지어내지 않는다). */
export const CODEX_SERVER_NOTIFICATIONS = [
  "error",
  "item/agentMessage/delta",
  "item/completed",
  "item/started",
  "model/rerouted",
  "thread/started",
  "thread/tokenUsage/updated",
  "turn/completed",
  "turn/started",
  "warning",
] as const;

/** 이번 턴의 수신자. 세션은 여러 턴을 살고, 받는 사람은 턴마다 다르다. */
export interface CodexTurnSink {
  onNotification: (method: string, params: any) => void;
  /** 서버→클라 요청(승인). 유휴 세션에는 답할 사람이 없다 — 그때는 꽂혀 있지 않다. */
  onServerRequest: (method: string, params: any) => Promise<unknown>;
  onStatus: (status: string) => void;
  /** 턴 도중 전송이 닫혔다 — 이 턴은 정산돼야 한다(영구 pending 금지). */
  onTransportClosed: (reason: string) => void;
}

export interface CodexResidentSession {
  child: ChildProcess;
  conn: AcpConnection;
  /** `initialize` 응답 — userAgent·codexHome·platform. 버전 스큐의 관측 지점. */
  init: any;
  active: CodexTurnSink | null;
  /** 우리가 놓았다(풀 축출·리퍼·호스트 종료). */
  closed: boolean;
  /** 이 프로세스가 들고 있는 thread — 다음 턴이 그대로 이어 쓴다. */
  threadId: string | null;
  /** thread/start 또는 thread/resume 이 실제로 확인한 모델 선택. */
  modelAcknowledgement: CodexModelAcknowledgement | null;
  /** `turn/completed` 까지 완주한 턴 수 — 구형 CLI(즉시 실패) 판별에 쓴다. */
  completedTurns: number;
  stopHeartbeat: () => void;
}

/**
 * `codex app-server` 를 띄우고 `initialize` 까지 마친다.
 * 실패하면 프로세스를 정리하고 그대로 던진다 — 강등 판단은 호출자(codex.ts)가 한다.
 */
export async function openCodexResidentSession(opts: {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  label?: string;
  timeoutMs?: number;
}): Promise<CodexResidentSession> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const child = spawnCli(opts.bin, opts.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: opts.cwd,
    env: opts.env,
    // POSIX 그룹킬 대상 — 취소/앱종료 시 codex 가 띄운 MCP 서버·손자까지 정리.
    ...detachedSpawnOpts(),
  });
  const session: CodexResidentSession = {
    child,
    conn: null as unknown as AcpConnection,
    init: null,
    active: null,
    closed: false,
    threadId: null,
    modelAcknowledgement: null,
    completedTurns: 0,
    stopHeartbeat: () => {},
  };
  trackRunChild(child);
  // 자식이 stdio 를 상속한 손자를 남기고 죽으면 close 가 영영 안 온다 — runner.ts 주석 참고.
  ensureChildCloseAfterExit(child, () => {
    session.active?.onStatus(`${opts.label ?? "codex"}: app-server exited without closing its output — settling the turn`);
  });
  // ★호스트 소유 생존 신호 — 러너 공통 규칙. 지금 활성인 턴으로 간다.
  session.stopHeartbeat = startCliHeartbeat(
    child,
    (status) => session.active?.onStatus(status),
    opts.label ?? "codex",
  );
  const markClosed = (reason: string): void => {
    session.closed = true;
    try { session.stopHeartbeat(); } catch { /* 이미 멈췄다 */ }
    const sink = session.active;
    session.active = null;
    try { sink?.onTransportClosed(reason); } catch { /* 정산은 턴 쪽 책임 */ }
  };
  child.on("close", (code) => markClosed(`app-server exited (${code ?? "?"})`));
  child.on("error", (err) => markClosed(err instanceof Error ? err.message : String(err)));
  session.conn = new AcpConnection(child, {
    onNotification: (method, params) => {
      try { session.active?.onNotification(method, params); } catch { /* 수신자 예외가 세션을 죽이지 않는다 */ }
    },
    onRequest: (method, params) => {
      const handler = session.active?.onServerRequest;
      // 유휴 세션에 승인 요청이 오면 답할 사람이 없다 — 조용히 삼키지 않고 규격 오류로 답한다.
      if (!handler) throw new AcpRpcError({ code: -32601, message: `Method not found: ${method}` });
      return handler(method, params);
    },
    onClose: (code) => markClosed(`app-server transport closed (${code ?? "?"})`),
  });
  try {
    session.init = await session.conn.request(
      "initialize",
      {
        clientInfo: { name: "agentlas-desktop", version: "1.0" },
        // Dynamic tools are currently behind app-server's negotiated
        // experimental API. The method list above pins the exact surface we
        // consume; unknown server requests still fail closed.
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      { timeoutMs },
    );
  } catch (err) {
    /*
     * ★사유를 들고 나간다. 구형 CLI 는 `app-server` 하위 명령 자체를 모르고, 그 사실은
     * stderr 에만 있다("error: unrecognized subcommand 'app-server'"). 여기서 붙이지
     * 않으면 호출자는 "연결이 닫혔다"만 보고 영구 강등을 판정할 근거를 잃는다.
     */
    const stderr = (session.conn?.lastStderr ?? "").trim();
    closeCodexResidentSession(session);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(stderr && !message.includes(stderr.slice(-80)) ? `${message}\n${stderr.slice(-500)}` : message);
  }
  return session;
}

/** 이 세션이 아직 다음 턴을 받을 수 있는가. */
export function codexResidentSessionAlive(session: CodexResidentSession): boolean {
  if (session.closed) return false;
  const child = session.child;
  if (child.killed || child.exitCode !== null || child.signalCode !== null) return false;
  return Boolean(child.stdin && child.stdin.writable);
}

/** 세션을 놓는 유일한 경로 — 생존 신호 정지 + 전송 close + 프로세스 트리 종료. */
export function closeCodexResidentSession(session: CodexResidentSession): void {
  if (session.threadId && !childExited(session.child)) {
    const key = codexThreadOwnerKey(session, session.threadId);
    const pending = pendingCodexWriterExits.get(key) ?? [];
    if (!pending.includes(session.child)) {
      pendingCodexWriterExits.set(key, [...pending, session.child]);
      session.child.once("exit", () => {
        if (pendingCodexWriterExits.get(key)?.every(childExited)) pendingCodexWriterExits.delete(key);
      });
    }
  }
  session.closed = true;
  session.active = null;
  try { session.stopHeartbeat(); } catch { /* 이미 멈췄다 */ }
  try { session.conn?.close(); } catch { /* 이미 죽었을 수 있다 */ }
  try { killCliTree(session.child); } catch { /* 이미 죽었을 수 있다 */ }
}

/** `initialize` 응답을 한 줄 영수증으로 — 버전 스큐를 나중에 읽을 수 있게 남긴다. */
export function codexProtocolReceipt(init: any): string {
  const userAgent = String(init?.userAgent ?? "unknown").slice(0, 200);
  const platform = `${String(init?.platformOs ?? "?")}/${String(init?.platformFamily ?? "?")}`;
  return `[runtime-protocol] codex-app-server userAgent=${userAgent} platform=${platform}`;
}

/* ──────────────────────── 모델 선택 확인 ───────────────────────── */

const CODEX_PROTOCOL_TOKEN = /^[^\x00-\x1f\x7f]{1,256}$/;

export type CodexModelAcknowledgement = {
  requestedModel: string | null;
  model: string;
  modelProvider: string;
  mode: "provider-default" | "direct" | "canonical";
};

export class CodexModelSelectionError extends Error {
  constructor(
    public readonly code: "response_invalid" | "resolution_unverified" | "rerouted",
    message: string,
  ) {
    super(message);
    this.name = "CodexModelSelectionError";
  }
}

type CodexProtocolRequest = (
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<any>;

function codexProtocolToken(value: unknown): value is string {
  return typeof value === "string" && CODEX_PROTOCOL_TOKEN.test(value);
}

/**
 * A thread response is the authority for the model the server selected. Exact
 * equality needs no catalog call. A differing acknowledgement is accepted only
 * when the server's complete, hidden-inclusive catalog explicitly maps the
 * requested id to the acknowledged canonical model. Catalog failure or an
 * incomplete/malformed page can prove nothing and therefore fails closed.
 */
export async function acknowledgeCodexThreadModel(input: {
  request: CodexProtocolRequest;
  response: any;
  requestedModel?: string | null;
  expectedThreadId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CodexModelAcknowledgement> {
  const threadId = input.response?.thread?.id;
  const model = input.response?.model;
  const modelProvider = input.response?.modelProvider;
  if (!codexProtocolToken(threadId)
    || (input.expectedThreadId !== undefined && threadId !== input.expectedThreadId)
    || !codexProtocolToken(model)
    || !codexProtocolToken(modelProvider)) {
    throw new CodexModelSelectionError("response_invalid", "Codex thread response did not acknowledge a valid thread, model, and provider.");
  }
  const requestedModel = input.requestedModel == null || input.requestedModel === ""
    ? null
    : input.requestedModel;
  if (!requestedModel) return { requestedModel: null, model, modelProvider, mode: "provider-default" };
  if (!codexProtocolToken(requestedModel)) {
    throw new CodexModelSelectionError("response_invalid", "The requested Codex model is not a valid protocol value.");
  }
  if (requestedModel === model) return { requestedModel, model, modelProvider, mode: "direct" };

  const deadline = Date.now() + Math.min(30_000, Math.max(1, input.timeoutMs ?? 30_000));
  const cursors = new Set<string>();
  const mappings = new Map<string, string>();
  let cursor: string | undefined;
  let rowCount = 0;
  try {
    do {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("Codex model acknowledgement cancelled");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("model/list timed out");
      const page = await input.request(
        "model/list",
        { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) },
        { timeoutMs: remaining, signal: input.signal },
      );
      if (!page || typeof page !== "object" || Array.isArray(page)
        || !Array.isArray(page.data)
        || !(page.nextCursor == null || codexProtocolToken(page.nextCursor))) {
        throw new Error("model/list response is malformed");
      }
      for (const row of page.data) {
        if (!row || typeof row !== "object" || Array.isArray(row)
          || !codexProtocolToken(row.id) || !codexProtocolToken(row.model)
          || mappings.has(row.id)) {
          throw new Error("model/list row is malformed or duplicated");
        }
        mappings.set(row.id, row.model);
        rowCount += 1;
        if (rowCount > 512) throw new Error("model/list exceeded the supported bound");
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor !== undefined) {
        if (cursors.has(cursor) || cursors.size >= 32) throw new Error("model/list cursor is invalid");
        cursors.add(cursor);
      }
    } while (cursor);
  } catch (error) {
    if (error instanceof CodexModelSelectionError) throw error;
    throw new CodexModelSelectionError(
      "resolution_unverified",
      `Codex acknowledged model ${model}, but the requested model ${requestedModel} could not be resolved from the complete server catalog: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (mappings.get(requestedModel) !== model) {
    throw new CodexModelSelectionError(
      "resolution_unverified",
      `Codex acknowledged model ${model}, which was not an observed canonical mapping for requested model ${requestedModel}.`,
    );
  }
  return { requestedModel, model, modelProvider, mode: "canonical" };
}

/* ────────────────────────────── 풀 ────────────────────────────── */

let sessionPool: AcpSessionPool<CodexResidentSession> | null = null;
// A missing app-server is learned per process so one old CLI does not retry it
// on every turn. A runtime replacement is a new executable generation, so the
// learned downgrade must be forgotten with the resident pool.
let appServerSupported = true;

export function codexSessionPool(): AcpSessionPool<CodexResidentSession> {
  if (!sessionPool) {
    sessionPool = new AcpSessionPool<CodexResidentSession>({
      alive: codexResidentSessionAlive,
      close: closeCodexResidentSession,
      /*
       * ★유휴 상주가 호스트의 종료를 막으면 안 된다. 붙든 자식의 stdio 파이프는 부모의
       * 이벤트 루프를 잡으므로, unref 하지 않으면 일을 끝낸 터미널·게이트 스크립트가
       * 영영 안 끝난다(ACP·claude 구현에서 실제로 나온 함정 — 같은 처방을 그대로).
       */
      unref: (session) => {
        session.child.unref?.();
        for (const pipe of [session.child.stdin, session.child.stdout, session.child.stderr]) {
          (pipe as unknown as { unref?: () => void } | null)?.unref?.();
        }
      },
      ref: (session) => {
        session.child.ref?.();
        for (const pipe of [session.child.stdin, session.child.stdout, session.child.stderr]) {
          (pipe as unknown as { ref?: () => void } | null)?.ref?.();
        }
      },
    });
    /*
     * ★나갈 때는 붙든 자식을 데려간다. unref 만 하고 여기를 비우면 종료가 곧 고아 생성이다.
     * 'exit' 은 동기 구간이라 SIGTERM 만 나간다 — app-server 는 그거면 내려간다.
     */
    process.once("exit", () => {
      try { sessionPool?.disposeAll(); } catch { /* 종료 중이다 */ }
    });
  }
  return sessionPool;
}

/** 테스트/런타임 교체(자동 업데이트)용 — 붙든 세션을 전부 놓는다. */
export function disposeCodexSessionPool(): void {
  sessionPool?.disposeAll();
  sessionPool = null;
  appServerSupported = true;
}

export class CodexSessionContinuityError extends Error {
  constructor(readonly code: "writer_busy" | "writer_close_timeout" | "resume_failed", message: string) {
    super(message);
    this.name = "CodexSessionContinuityError";
  }
}

const codexResumeClaims = new Set<string>();
const pendingCodexWriterExits = new Map<string, ChildProcess[]>();
const childExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;
const codexThreadOwnerKey = (session: CodexResidentSession, threadId: string): string =>
  `${String(session.init?.codexHome ?? "")}\0${threadId}`;

/** Transfer one persisted thread only after its previous idle writer has exited. */
export async function prepareCodexThreadResume(
  session: CodexResidentSession,
  threadId: string,
  signal?: AbortSignal,
): Promise<() => void> {
  const key = codexThreadOwnerKey(session, threadId);
  if (codexResumeClaims.has(key)) {
    throw new CodexSessionContinuityError("writer_busy", "Codex thread resume is already in progress.");
  }
  codexResumeClaims.add(key);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    codexResumeClaims.delete(key);
  };
  try {
    if (signal?.aborted) throw signal.reason ?? new Error("Codex thread resume cancelled");
    const ownership = codexSessionPool().retireIdleMatching((candidate) =>
      candidate !== session && candidate.threadId === threadId
      && candidate.init?.codexHome === session.init?.codexHome,
    );
    if (ownership.busy) {
      throw new CodexSessionContinuityError("writer_busy", "Codex thread still belongs to an active turn.");
    }
    const children = [...new Set([...(pendingCodexWriterExits.get(key) ?? []), ...ownership.retired.map((item) => item.child)])]
      .filter((child) => !childExited(child));
    // Keep unfinished exits across cancellation/timeouts; a retry must not
    // mistake removal from the pool for release of the CLI's writer lock.
    if (children.length) pendingCodexWriterExits.set(key, children);
    await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        child.removeListener("exit", onExit);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve();
      };
      const onExit = (): void => finish();
      const onAbort = (): void => finish(signal?.reason instanceof Error ? signal.reason : new Error("Codex thread resume cancelled"));
      const timer = setTimeout(() => finish(new CodexSessionContinuityError(
        "writer_close_timeout", "Codex's previous thread writer did not exit; resume was stopped.",
      )), 2_000);
      child.once("exit", onExit);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (childExited(child)) finish();
      else if (signal?.aborted) onAbort();
    })));
    pendingCodexWriterExits.delete(key);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

/* ──────────────────────────── 강등(구형 CLI) ──────────────────────────── */

/*
 * 이 CLI 에는 `app-server` 가 없다(구버전) — 프로세스 수명 동안 1회 학습해 영구히
 * 기존 `codex exec` 1회성 경로로 강등한다. claude 상주의 `--input-format` 학습과 같은 모양.
 */
export function codexAppServerSupported(): boolean {
  return appServerSupported;
}

export function markCodexAppServerUnsupported(why: string): void {
  if (!appServerSupported) return;
  appServerSupported = false;
  console.warn(`[residency] codex degraded to one-shot exec: ${why.trim().slice(0, 200)}`);
}

/** 테스트 전용 — 같은 프로세스에서 여러 시나리오를 재려면 학습을 되돌려야 한다. */
export function __resetCodexAppServerSupportForTests(): void {
  appServerSupported = true;
}

/**
 * 스폰/`initialize` 실패가 "이 CLI 에 app-server 가 없다"인가.
 * 구형 CLI 는 하위 명령 자체를 모르므로 clap 이 그 문장을 낸다(exit 2).
 */
export function looksLikeMissingAppServer(stderr: string, err?: unknown): boolean {
  const text = `${stderr ?? ""}\n${err instanceof Error ? err.message : String(err ?? "")}`;
  return /unrecognized subcommand|unknown subcommand|invalid subcommand|no such subcommand|error: unexpected argument 'app-server'/i.test(text);
}

/* ──────────────────────────── 재사용 키 ──────────────────────────── */

const codexLaunchGenerations = new Map<string, { state: string; generation: string }>();

/** Local launch inputs can change without a path/argv change (CLI updates,
 * config edits). Hash config bytes, never log them. This is conservative source
 * invalidation, not a reimplementation of Codex's effective TOML/MDM policy.
 * Auth refresh files are deliberately excluded: credential lifecycle is separate.
 */
function localLaunchState(input: {
  cwd: string; bin: string; args: string[]; env?: NodeJS.ProcessEnv;
  mcpConfigPath?: string; toolBrokerSettingsPath?: string;
}): string {
  const digest = crypto.createHash("sha256");
  const childEnv = input.env ?? process.env;
  const cwd = path.resolve(input.cwd);
  const home = path.resolve(cwd, childEnv.HOME || os.homedir());
  const codexHome = path.resolve(cwd, childEnv.CODEX_HOME || path.join(home, ".codex"));
  const files = new Set([
    path.join(codexHome, "config.toml"),
    path.join(codexHome, "managed_config.toml"),
    "/etc/codex/config.toml",
    "/etc/codex/requirements.toml",
  ]);
  for (let dir = path.resolve(input.cwd); ; dir = path.dirname(dir)) {
    files.add(path.join(dir, ".codex", "config.toml"));
    if (path.dirname(dir) === dir) break;
  }
  for (let i = 0; i < input.args.length; i += 1) {
    const arg = input.args[i];
    const profile = arg === "--profile" || arg === "-p"
      ? input.args[++i]
      : arg.startsWith("--profile=") ? arg.slice("--profile=".length) : undefined;
    if (profile) files.add(path.join(codexHome, `${profile}.config.toml`));
  }
  if (input.mcpConfigPath) files.add(path.resolve(cwd, input.mcpConfigPath));
  if (input.toolBrokerSettingsPath) files.add(path.resolve(cwd, input.toolBrokerSettingsPath));
  for (const file of [...files].sort()) {
    digest.update(file).update("\0");
    try {
      const bytes = fs.readFileSync(file);
      digest.update("file\0").update(bytes);
    } catch (error) {
      // An unreadable source must not accidentally reuse an older readable
      // generation. Let the new CLI report its own configuration error.
      const code = (error as NodeJS.ErrnoException).code;
      digest.update(code === "ENOENT" || code === "ENOTDIR" ? "missing" : crypto.randomUUID());
    }
    digest.update("\0");
  }
  try {
    const executable = input.bin.includes(path.sep)
      ? path.resolve(cwd, input.bin)
      : (childEnv.PATH ?? "/usr/bin:/bin").split(path.delimiter)
        .map((dir) => path.resolve(cwd, dir, input.bin))
        .find((file) => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
    const resolved = fs.realpathSync(executable ?? path.resolve(cwd, input.bin));
    const stat = fs.statSync(resolved, { bigint: true });
    // Include the symlink target and replacement metadata without rereading a
    // large executable on every turn. This detects normal in-place/atomic CLI
    // updates; it is not an executable integrity or same-UID tamper guarantee.
    digest.update(resolved).update("\0");
    for (const value of [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]) {
      digest.update(String(value)).update("\0");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    digest.update(code === "ENOENT" || code === "ENOTDIR" ? "missing-executable" : crypto.randomUUID());
  }
  const state = digest.digest("hex");
  const scope = crypto.createHash("sha256").update(JSON.stringify([
    cwd, input.bin, input.args, input.mcpConfigPath, input.toolBrokerSettingsPath,
    Object.entries(childEnv).sort(([a], [b]) => a.localeCompare(b)),
  ])).digest("hex");
  const previous = codexLaunchGenerations.get(scope);
  const generation = previous?.state === state ? previous.generation : crypto.randomUUID();
  codexLaunchGenerations.delete(scope);
  codexLaunchGenerations.set(scope, { state, generation });
  if (codexLaunchGenerations.size > 128) codexLaunchGenerations.delete(codexLaunchGenerations.keys().next().value!);
  // A -> B -> A is a new launch generation too. Old idle processes remain under
  // the pool's existing eviction policy, but cannot regain reuse after rollback.
  return generation;
}

/**
 * 재사용 키 — claude·ACP 와 **같은 축**이다: 세션 지문(모델·시스템프롬프트·권한 —
 * 기존 계약 그대로) 위에 프로세스 정체성(cwd · MCP 설정 · 실행 파일 · 도구 관문 · argv)을
 * 더하고, 마지막에 env 다이제스트를 얹는다.
 *
 * ★env 가 키에 들어가는 이유: 뜬 프로세스는 자기가 뜰 때의 env 를 **평생** 든다.
 * 자격증명이 갱신돼도 이미 떠 있는 CLI 는 옛 값을 쓴다. 그래서 env 가 바뀌면 이어 쓰지
 * 않는다(다이제스트만 쓰므로 값 자체는 어디에도 남지 않는다).
 *
 * ★MCP 가 argv 에 실린다: codex 의 MCP 설정은 `-c mcp_servers…` 오버라이드라 스폰 인자다.
 * argv 다이제스트가 그것을 덮지만, 축을 이름으로도 남겨 둔다 — 나중에 파일 경로로 바뀌어도
 * 키가 조용히 같아지지 않게.
 */
export function codexPoolKey(input: {
  chatId: string;
  fingerprint: string;
  cwd: string;
  bin: string;
  mcpConfigPath?: string;
  toolBrokerSettingsPath?: string;
  /** 스폰 argv 그대로: 반복된 옵션은 순서에 따라 적용 값이 달라진다. */
  args: string[];
  env?: NodeJS.ProcessEnv;
}): string {
  const envDigest = crypto.createHash("sha256");
  for (const name of Object.keys(input.env ?? {}).sort()) {
    envDigest.update(name).update("\0").update(String((input.env ?? {})[name] ?? "")).update("\0");
  }
  const argvDigest = crypto.createHash("sha256");
  for (const arg of input.args) argvDigest.update(arg).update("\0");
  return crypto
    .createHash("sha256")
    .update("codex-pool-v2\0")
    .update(input.chatId).update("\0")
    .update(input.fingerprint).update("\0")
    .update(input.cwd).update("\0")
    .update(input.bin).update("\0")
    .update(input.mcpConfigPath ?? "").update("\0")
    .update(input.toolBrokerSettingsPath ?? "").update("\0")
    .update(argvDigest.digest("hex")).update("\0")
    .update(envDigest.digest("hex"))
    .update("\0").update(localLaunchState(input))
    .digest("hex");
}

/* ──────────────────────── 실행 전 승인 (이번 작업의 핵심) ──────────────────────── */

export interface CodexApprovalContext {
  runtime: string;
  sessionKey: string;
  cwd?: string;
  chatId?: string;
  agentId?: string;
  permission: RuntimeToolPermissionAsk["permission"];
  unattended?: boolean;
}

/** 이 요청이 승인 대상인가(우리가 답을 아는 6종). */
export function isCodexApprovalRequest(method: string): boolean {
  return (CODEX_APPROVAL_REQUESTS as readonly string[]).includes(method);
}

export function isCodexMcpElicitationRequest(method: string): boolean {
  return method === CODEX_MCP_ELICITATION_METHOD;
}

const text = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
  if (Array.isArray(value)) {
    const joined = value.filter((v) => typeof v === "string").join(" ").trim();
    return joined ? joined.slice(0, 500) : undefined;
  }
  return undefined;
};

/**
 * 승인 요청 → 우리 중재자 질문(RuntimeToolPermissionAsk)으로 번역 — 순수 함수(게이트가
 * 픽스처를 직접 주입한다). `kind` 는 능력 규칙(capability_grants)의 입력이므로
 * **아는 것만** 싣는다: 명령 실행은 execute, 파일 변경/패치는 edit, 권한 확대는 요청된
 * 내용에서, 나머지는 other.
 */
export function codexApprovalAsk(
  method: string,
  params: any,
  ctx: CodexApprovalContext,
): RuntimeToolPermissionAsk {
  let kind = "other";
  let tool = method;
  let detail: string | undefined;
  /**
   * 이 요청이 **바깥을 바꾸거나 경계를 넓히는가**. 대개는 kind 로 정해지지만 두 곳은 다르다:
   *  · 권한 확대(permissions)는 읽기만 넓혀도 샌드박스 경계를 넓히는 일이라 항상 mutating 이다
   *    (그래야 read 실행에서 조용히 허용되지 않는다 — 중재자는 !mutating 을 자동 허용한다).
   *  · requestUserInput 은 **정보를 묻는 것**이지 권한이 아니다. 우리는 사용자의 답을 절대
   *    지어내지 않으므로(항상 빈 답) 어떤 결정이든 새로 얻는 권한이 없다 — 승인 카드를
   *    띄울 이유도 없다.
   */
  let mutating: boolean | null = null;
  switch (method) {
    case "item/commandExecution/requestApproval":
      kind = "execute";
      tool = "bash";
      detail = text(params?.command) ?? text(params?.reason);
      break;
    case "execCommandApproval":
      // 레거시 표면 — `command` 가 토큰 배열이다(실측 스키마: items:string).
      kind = "execute";
      tool = "bash";
      detail = text(params?.command) ?? text(params?.reason);
      break;
    case "item/fileChange/requestApproval":
      kind = "edit";
      tool = "apply_patch";
      detail = text(params?.grantRoot) ?? text(params?.reason);
      break;
    case "applyPatchApproval": {
      kind = "edit";
      tool = "apply_patch";
      const changes = params?.fileChanges;
      const paths = changes && typeof changes === "object" && !Array.isArray(changes)
        ? Object.keys(changes as Record<string, unknown>)
        : Array.isArray(changes)
          ? changes.map((c: any) => String(c?.path ?? "")).filter(Boolean)
          : [];
      detail = paths.length > 0 ? paths.join(" ").slice(0, 500) : text(params?.reason);
      break;
    }
    case "item/permissions/requestApproval": {
      // 샌드박스 밖으로 나가려는 **권한 확대** 요청이다. 무엇을 넓히려는지가 곧 능력 클래스다.
      const wanted = params?.permissions ?? {};
      const wantsNetwork = wanted?.network?.enabled === true;
      const fsEntries: any[] = Array.isArray(wanted?.fileSystem?.entries) ? wanted.fileSystem.entries : [];
      const wantsWrite = fsEntries.some((e) => e?.access === "write")
        || (Array.isArray(wanted?.fileSystem?.write) && wanted.fileSystem.write.length > 0);
      kind = wantsNetwork ? "network" : wantsWrite ? "edit" : "read";
      tool = "permissions";
      detail = text(params?.reason) ?? JSON.stringify(wanted).slice(0, 500);
      mutating = true;
      break;
    }
    case "item/tool/requestUserInput":
      kind = "other";
      tool = "request_user_input";
      mutating = false;
      detail = text(
        (Array.isArray(params?.questions) ? params.questions : [])
          .map((q: any) => String(q?.prompt ?? q?.question ?? q?.text ?? ""))
          .filter(Boolean),
      );
      break;
    default:
      break;
  }
  return {
    runtime: ctx.runtime,
    sessionKey: ctx.sessionKey,
    tool,
    kind,
    ...(detail ? { detail } : {}),
    ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
    permission: ctx.permission,
    // 기본 규칙: read 외의 모든 요청은 바깥을 바꾸거나 경계를 넓힌다(위 두 예외는 명시).
    mutating: mutating ?? kind !== "read",
    ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.unattended ? { unattended: true as const } : {}),
  };
}

/**
 * 결정 → 그 메서드가 받는 응답 모양 — 순수 함수(실측 스키마 그대로).
 *
 *  · item/*  RequestApproval : `{ decision: "accept" | "acceptForSession" | "decline" }`
 *  · exec/applyPatch(레거시) : ReviewDecision — `"approved" | "approved_for_session" |
 *                              { denied: { rejection } }`
 *  · permissions             : 승인은 요청받은 프로필을 그대로 부여, 거부는 **빈 프로필**
 *                              (아무것도 넓히지 않는다). scope 는 결정에 따라 turn/session.
 *  · requestUserInput        : 우리는 사용자의 답을 **지어내지 않는다** — 항상 빈 답이다.
 *                              (허용/거부는 화면 기록의 문제이지, 답을 만들어 낼 권한이 아니다.)
 */
export function codexApprovalReply(
  method: string,
  params: any,
  decision: RuntimeToolPermissionDecision,
): Record<string, unknown> {
  const allow = decision !== "deny";
  const forSession = decision === "allow_session";
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: allow ? (forSession ? "acceptForSession" : "accept") : "decline" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return {
        decision: allow
          ? (forSession ? "approved_for_session" : "approved")
          : { denied: { rejection: "Agentlas: not approved for this run." } },
      };
    case "item/permissions/requestApproval":
      return allow
        ? { permissions: params?.permissions ?? {}, scope: forSession ? "session" : "turn" }
        : { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    default:
      return { decision: "decline" };
  }
}

/**
 * 승인 한 건 — ACP `answerPermission` 과 **같은 계약**이다:
 *   · 중재자가 없으면 보수적 기본값(read 실행에서 바깥을 바꾸는 호출은 거부).
 *   · 중재자가 던지면 거부(fail-closed) — 실패가 허용으로 바뀌면 관문이 아니다.
 *   · capabilityClassFor/detail 을 실어 보내 능력 규칙(capability_grants)이 적용되게 한다.
 */
export async function answerCodexApproval(
  method: string,
  params: any,
  ctx: CodexApprovalContext,
): Promise<{ reply: Record<string, unknown>; decision: RuntimeToolPermissionDecision; ask: RuntimeToolPermissionAsk }> {
  const ask = codexApprovalAsk(method, params, ctx);
  const arbiter = getRuntimeToolPermissionArbiter();
  let decision: RuntimeToolPermissionDecision;
  if (!arbiter) {
    decision = defaultRuntimeToolPermission(ask);
  } else {
    try {
      decision = await arbiter(ask);
    } catch {
      decision = "deny";
    }
  }
  return { reply: codexApprovalReply(method, params, decision), decision, ask };
}

/** 능력 클래스 — 승인 기록·상태줄이 같은 어휘를 쓰게 한다(tool-approval 규칙 그대로). */
export function codexApprovalCapability(ask: RuntimeToolPermissionAsk): string {
  return capabilityClassFor(ask.kind, ask.tool);
}
