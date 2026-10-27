import { claimAttemptChild, releaseAttemptChild } from "./attempt-children";
// Claude Code 상주 세션 — 턴마다 스폰-종료하던 `-p` 호출을 붙들어 여러 턴이 이어 쓴다.
//
// ★왜 claude 가 남아 있었나. ACP 런타임(cursor·grok·kimi·github-copilot-cli)은
// 2026-08-19 에 상주가 착지했는데(acp-session-pool.ts), claude-code 는 여전히 턴마다
// `-p` 로 새 프로세스를 띄우고 `--resume <sessionId>` 로 문맥만 이어 붙였다. 출력은
// stream-json 인데 **입력이 단발**이라, 프로세스가 한 턴 뒤에 반드시 끝났다.
//
// ★실측(2026-08-20, 이 기계):
//   claude -p --input-format stream-json --output-format stream-json --verbose
//   · stdin 에 NDJSON 한 줄:  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
//   · 턴마다 stdout 에 {"type":"result","session_id":"…","result":"…"} 가 나온다.
//   · 두 턴이 **같은 pid·같은 session_id** 로 처리됐다 — 프로세스를 붙들면 이어진다.
//   · `claude --help`: `--input-format <text|stream-json>` 은 `--print` 와 함께만 동작.
//
// ★풀은 새로 만들지 않는다. acp-session-pool.ts 의 AcpSessionPool<S> 는 이미 제네릭이고
// (alive/close/ref/unref/budget/now 주입), 배타적 체크아웃·LRU 축출·12h sweepIdle·죽은
// 세션 폐기 계약을 들고 있다. 같은 계약을 세 번째로 손코딩하면 언젠가 하나만 고쳐진다.
// 이름만 ACP 를 달고 있을 뿐, 이 파일이 두 번째 사용자다.
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { AcpSessionPool, type AcpSessionLease } from "./acp-session-pool";
import { detachedSpawnOpts, killCliTree, spawnCli, markRunChildResident, trackRunChild, waitForCliTreeTermination } from "./exec";
import { ensureChildCloseAfterExit } from "./runner";

export type { AcpSessionLease };

/** stream-json 이벤트 한 개(러너가 실제로 읽는 칸만 느슨하게). */
export type ClaudeStreamEvent = Record<string, unknown> & { type?: string };

/**
 * 이번 턴의 수신자. 세션은 여러 턴을 살고 받는 사람은 턴마다 다르다 — ACP 러너의
 * `session.state.active` 와 같은 계약이다(유휴 세션이 지난 턴의 events 로 흘리면 안 된다).
 */
export interface ClaudeTurnSink {
  onEvent: (ev: ClaudeStreamEvent) => void;
  onStderr: (chunk: string) => void;
  /** 턴 도중 프로세스가 죽었다 — 이 턴은 정산돼야 한다(영구 pending 금지). */
  onDeath: (code: number | null) => void;
}

export interface ClaudeResidentSession {
  executableOwner: { chatId: string; sessionOwnerId: string | null; isolateOwner: boolean; generation: string };
  child: ChildProcess;
  active: ClaudeTurnSink | null;
  /** Provider-owned session id last observed on this resident process. */
  nativeSessionId: string | null;
  /** Model selected in this process; updated only after an acknowledged set_model. */
  model: string;
  pendingModelSwitch: { requestId: string; resolve: (accepted: boolean) => void; timer: NodeJS.Timeout } | null;
  /** Other control requests awaiting their control_response (mcp_set_servers, interrupt); null on death or close. */
  pendingControls: Map<string, (response: Record<string, unknown> | null) => void>;
  /** `capabilities` of the latest system/init on this process (interrupt_cancel_queued_v1, msg_lifecycle_v1, ...). */
  capabilities: ReadonlySet<string> | null;
  /** sha256 of the MCP config bytes this process runs (from spawn, or the last acknowledged mcp_set_servers). */
  mcpConfigDigest: string | null;
  /** Pool identity captured at spawn; changes in cwd/MCP/env must not reuse this process. */
  poolKey: string | null;
  /** 우리가 놓았다(풀 축출·리퍼·호스트 종료). */
  closed: boolean;
  /** 프로세스가 죽었다. */
  dead: boolean;
  /** The `error` event that ended this process (a failed spawn, which has no pid); the turn reads its errno from it. */
  spawnError?: Error;
  /** 이 세션이 `result` 까지 완주한 턴 수 — 구형 CLI(스폰 즉시 실패) 판별에 쓴다. */
  completedTurns: number;
  /** 마지막 stderr 꼬리(진단용, 상한 있음). */
  stderrTail: string;
}

/**
 * NDJSON 줄 파서 — stream-json 은 줄 단위 JSON 이다. 일회성 경로와 상주 경로가
 * 같은 파서를 쓴다(두 벌이 되면 한쪽만 고쳐진다).
 */
export function createNdjsonLineReader(onEvent: (ev: ClaudeStreamEvent) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as ClaudeStreamEvent);
      } catch {
        // 비-JSON 라인은 무시(일회성 경로와 같은 계약)
      }
    }
  };
}

const STDERR_TAIL_MAX = 8 * 1024;

/** `--input-format stream-json` 을 붙여 프로세스를 띄운다. stdin 은 **닫지 않는다**. */
export function openClaudeResidentSession(opts: {
  executableOwner: ClaudeResidentSession["executableOwner"];
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  model?: string | null;
  poolKey?: string | null;
  mcpConfigDigest?: string | null;
}): ClaudeResidentSession | Promise<never> {
  const child = spawnCli(opts.bin, opts.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: opts.env,
    cwd: opts.cwd,
    // POSIX 그룹킬 대상 — 취소/앱종료 시 CLI 가 띄운 MCP 서버·빌드 손자까지 정리.
    ...detachedSpawnOpts(),
  });
  const session: ClaudeResidentSession = {
    executableOwner: { ...opts.executableOwner },
    child,
    active: null,
    nativeSessionId: null,
    model: opts.model?.trim() ?? "",
    pendingModelSwitch: null,
    pendingControls: new Map(),
    capabilities: null,
    mcpConfigDigest: opts.mcpConfigDigest ?? null,
    poolKey: opts.poolKey ?? null,
    closed: false,
    dead: false,
    completedTurns: 0,
    stderrTail: "",
  };
  try {
    trackRunChild(child);
    // Parked between turns, a resident is not work (see markRunChildResident).
    markRunChildResident(child, () => session.active === null && !session.closed);
    // 자식이 stdio 를 상속한 손자를 남기고 죽으면 close 가 영영 안 온다 — runner.ts 주석 참고.
    ensureChildCloseAfterExit(child);
    const readStdout = createNdjsonLineReader((ev) => {
      const response = ev.type === "control_response" && ev.response && typeof ev.response === "object"
        ? ev.response as Record<string, unknown> : null;
      const pending = session.pendingModelSwitch;
      if (response && pending && response.request_id === pending.requestId) {
        session.pendingModelSwitch = null;
        clearTimeout(pending.timer);
        pending.resolve(response.subtype === "success");
        return;
      }
      const control = response && typeof response.request_id === "string" ? session.pendingControls.get(response.request_id) : undefined;
      if (control) {
        session.pendingControls.delete(response!.request_id as string);
        control(response);
        return;
      }
      // Each turn's system/init repeats the process capabilities (2.1.301: one init per stream-json turn).
      if (ev.type === "system" && ev.subtype === "init" && Array.isArray(ev.capabilities)) {
        session.capabilities = new Set((ev.capabilities as unknown[]).filter((item): item is string => typeof item === "string"));
      }
      try {
        session.active?.onEvent(ev);
      } catch {
        /* 수신자의 예외가 세션을 죽이지는 않는다 — 턴 쪽에서 정산한다 */
      }
    });
    child.stdout?.on("data", readStdout);
    const stderrDecoder = new StringDecoder("utf8");
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      session.stderrTail = (session.stderrTail + text).slice(-STDERR_TAIL_MAX);
      try {
        session.active?.onStderr(text);
      } catch {
        /* 위와 같다 */
      }
    });
    const die = (code: number | null) => {
      if (session.dead) return;
      session.dead = true;
      const pending = session.pendingModelSwitch;
      if (pending) { session.pendingModelSwitch = null; clearTimeout(pending.timer); pending.resolve(false); }
      settlePendingControls(session);
      const sink = session.active;
      session.active = null;
      try {
        sink?.onDeath(code);
      } catch {
        /* 정산은 턴 쪽 책임 */
      }
    };
    child.once("close", (code) => die(typeof code === "number" ? code : null));
    child.once("error", (error) => { session.spawnError = error; die(null); });
    // stdin 이 EPIPE 로 프로세스를 죽이지 않게 한다(자식이 먼저 닫는 경우).
    child.stdin?.on("error", () => {});
    return session;
  } catch (error) {
    // The successful open remains synchronous. A failed setup keeps its pool
    // opening reservation until the owned process tree has actually stopped.
    return closeClaudeResidentSession(session).then(() => { throw error; });
  }
}

/** 이 세션이 아직 다음 턴을 받을 수 있는가. */
export function claudeResidentSessionAlive(session: ClaudeResidentSession): boolean {
  if (session.closed || session.dead) return false;
  const child = session.child;
  if (child.killed || child.exitCode !== null || child.signalCode !== null) return false;
  return Boolean(child.stdin && child.stdin.writable);
}

/** 세션을 놓는다(프로세스 트리 종료). */
const claudeSessionTerminations = new WeakMap<ClaudeResidentSession, Promise<void>>();
export function closeClaudeResidentSession(session: ClaudeResidentSession): Promise<void> {
  const existing = claudeSessionTerminations.get(session);
  if (existing) return existing;
  const termination = waitForCliTreeTermination(session.child);
  claudeSessionTerminations.set(session, termination);
  session.closed = true;
  const pending = session.pendingModelSwitch;
  if (pending) { session.pendingModelSwitch = null; clearTimeout(pending.timer); pending.resolve(false); }
  settlePendingControls(session);
  session.active = null;
  try {
    session.child.stdin?.end();
  } catch {
    /* 이미 죽었을 수 있다 */
  }
  try {
    killCliTree(session.child);
  } catch {
    /* 이미 죽었을 수 있다 */
  }
  return termination;
}

/** Installed Claude Code 2.1.278: control_request(set_model) is acknowledged on stdout before the next user turn. */
export async function setClaudeResidentModel(session: ClaudeResidentSession, model: string | null | undefined, signal?: AbortSignal): Promise<boolean> {
  const target = model?.trim() ?? "";
  if (session.model === target) return true;
  if (!claudeResidentSessionAlive(session) || session.active || session.pendingModelSwitch || signal?.aborted) return false;
  const requestId = crypto.randomUUID();
  const accepted = await new Promise<boolean>((resolve) => {
    const finish = (ok: boolean) => {
      const pending = session.pendingModelSwitch;
      if (!pending || pending.requestId !== requestId) return;
      session.pendingModelSwitch = null;
      clearTimeout(pending.timer);
      signal?.removeEventListener("abort", abort);
      resolve(ok);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), 15_000);
    session.pendingModelSwitch = { requestId, resolve: (ok) => { signal?.removeEventListener("abort", abort); resolve(ok); }, timer };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      session.child.stdin!.write(`${JSON.stringify({ type: "control_request", request_id: requestId,
        request: { subtype: "set_model", model: target || "default" } })}\n`);
    } catch { finish(false); }
  });
  if (accepted) session.model = target;
  return accepted;
}

/**
 * Stop = end the turn through the protocol, then (bounded) stop the process.
 *
 * SIGTERM "leaves the turn that was in progress unfinished and records no result
 * for it. To end the turn instead, send SIGINT, or call the Agent SDK's
 * interrupt(), before you stop the process" (code.claude.com/docs headless).
 * The SDK's interrupt() is exactly this control_request
 * (anthropics/claude-agent-sdk-python@36f9548 _internal/query.py:792-794), and
 * Paseo sends it before tearing a session down (getpaseo/paseo@da48803
 * providers/claude/agent.ts:2257-2275). Our steering flow resumes the stored
 * session right after a Stop, so the interrupted turn must be on disk.
 */
export function interruptClaudeResidentTurn(session: ClaudeResidentSession, opts: {
  /** Also withdraw queued user messages (init capability interrupt_cancel_queued_v1); older CLIs ignore the field. */
  cancelQueued?: boolean;
  /** The interrupt receipt (interrupt_receipt_v1): uuids that survive (still_queued) and that were withdrawn (cancelled). */
  onReceipt?: (receipt: ClaudeInterruptReceipt | null) => void;
  receiptTimeoutMs?: number;
} = {}): boolean {
  if (!claudeResidentSessionAlive(session)) return false;
  const requestId = crypto.randomUUID();
  if (opts.onReceipt) {
    const onReceipt = opts.onReceipt;
    const timer = setTimeout(() => {
      if (session.pendingControls.delete(requestId)) onReceipt(null);
    }, opts.receiptTimeoutMs ?? 3_000);
    timer.unref?.();
    session.pendingControls.set(requestId, (response) => { clearTimeout(timer); onReceipt(claudeInterruptReceipt(response)); });
  }
  try {
    session.child.stdin!.write(`${JSON.stringify({ type: "control_request", request_id: requestId,
      request: { subtype: "interrupt", ...(opts.cancelQueued ? { cancel_queued: true } : {}) } })}\n`);
    return true;
  } catch {
    session.pendingControls.get(requestId)?.(null);
    session.pendingControls.delete(requestId);
    return false;
  }
}

export interface ClaudeInterruptReceipt {
  /** Messages that survive the interrupt and will still run in this session (never re-sent by the host). */
  stillQueued: string[];
  /** Messages the interrupt withdrew (cancel_queued): they never reached the model. */
  cancelled: string[];
}

/** Parse a control_response to an interrupt: a receipt only when it is a success carrying still_queued (interrupt_receipt_v1). */
export function claudeInterruptReceipt(response: Record<string, unknown> | null): ClaudeInterruptReceipt | null {
  if (!response || response.subtype !== "success") return null;
  const body = response.response && typeof response.response === "object" ? response.response as Record<string, unknown> : null;
  const ids = (value: unknown): string[] | null => Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] as string[] : null;
  const stillQueued = ids(body?.still_queued);
  if (!stillQueued) return null;
  return { stillQueued, cancelled: ids(body?.cancelled) ?? [] };
}

/**
 * One control request to a live resident and its control_response (`{subtype, request_id, response?|error?}`); null on
 * timeout, abort, death or a failed write. Used for requests whose acknowledgement gates the next step (mcp_set_servers).
 */
export function sendClaudeResidentControl(session: ClaudeResidentSession, request: Record<string, unknown>,
  opts: { timeoutMs: number; signal?: AbortSignal }): Promise<Record<string, unknown> | null> {
  if (!claudeResidentSessionAlive(session) || opts.signal?.aborted) return Promise.resolve(null);
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    let done = false;
    const finish = (response: Record<string, unknown> | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      session.pendingControls.delete(requestId);
      resolve(response);
    };
    const abort = () => finish(null);
    const timer = setTimeout(() => finish(null), opts.timeoutMs);
    timer.unref?.();
    opts.signal?.addEventListener("abort", abort, { once: true });
    session.pendingControls.set(requestId, finish);
    try {
      session.child.stdin!.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`);
    } catch { finish(null); }
  });
}

function settlePendingControls(session: ClaudeResidentSession): void {
  const pending = [...session.pendingControls.values()];
  session.pendingControls.clear();
  for (const resolve of pending) {
    try { resolve(null); } catch { /* the waiter settles its own turn */ }
  }
}

/** Provenance and queue placement of a stream-json user message (Agent SDK SDKUserMessage). */
export interface ClaudeResidentMessageOptions {
  /** Client uuid: echoed as command_lifecycle.command_uuid and user_message_uuid(s) on this turn's frames. */
  uuid?: string;
  /** "next": read in the running turn after its current tool calls; "now": interrupt or background them. */
  priority?: "now" | "next" | "later";
  /** A person's typed input is stamped human; absent origin is unattributed (CLI docs). */
  origin?: { kind: "human" };
}

/**
 * 한 턴의 사용자 메시지를 stdin 으로 보낸다(NDJSON 한 줄, stdin 은 열어 둔다).
 * 실측 형태 그대로 — 이 모양이 아니면 CLI 가 그 줄을 조용히 버린다.
 * `uuid`/`priority`/`origin` are optional SDKUserMessage fields (measured offline on 2.1.301: the uuid comes back as
 * command_lifecycle queued/started and as user_message_uuid on the turn's init, assistant and result frames).
 */
export function writeClaudeResidentTurn(session: ClaudeResidentSession, text: string, opts: ClaudeResidentMessageOptions = {}): boolean {
  const stdin = session.child.stdin;
  if (!stdin || !stdin.writable) return false;
  const line = `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    ...(opts.uuid ? { parent_tool_use_id: null, uuid: opts.uuid } : {}),
    ...(opts.priority ? { priority: opts.priority } : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
  })}\n`;
  try {
    stdin.write(line);
    return true;
  } catch {
    return false;
  }
}

/* ────────────────────────────── 풀 ────────────────────────────── */

let sessionPool: AcpSessionPool<ClaudeResidentSession> | null = null;

const executableOwners = new Map<string, { generation: string; current: boolean }>();

/** Capture before asynchronous preparation so an older turn cannot supersede a newer owner. */
export function captureClaudeExecutableOwner(owner: ClaudeResidentSession["executableOwner"]): () => boolean {
  const key = JSON.stringify([owner.chatId, owner.sessionOwnerId, owner.isolateOwner]);
  let token = executableOwners.get(key);
  if (!token || token.generation !== owner.generation) {
    if (token) token.current = false;
    token = { generation: owner.generation, current: true };
  }
  executableOwners.delete(key);
  executableOwners.set(key, token);
  if (executableOwners.size > 128) {
    const oldest = executableOwners.keys().next().value!;
    executableOwners.get(oldest)!.current = false;
    executableOwners.delete(oldest);
  }
  return () => token.current;
}

/** Scope retirement to the same conversation and session owner, including relocated executables. */
export function retireSupersededClaudeSessions(
  pool: AcpSessionPool<ClaudeResidentSession>,
  owner: ClaudeResidentSession["executableOwner"],
): void {
  pool.retireMatching((session) => session.executableOwner.chatId === owner.chatId
    && session.executableOwner.sessionOwnerId === owner.sessionOwnerId
    && session.executableOwner.isolateOwner === owner.isolateOwner
    && session.executableOwner.generation !== owner.generation);
}

/**
 * A Claude native session is provider state, not a per-process transcript. If a model switch
 * resumes that native id in a new resident process, a cwd/MCP/env pool key changes, or a one-shot
 * turn updates it out of process, an older process with the same id can keep a stale local
 * transcript. Retire those siblings before the new turn is admitted so a later resident turn
 * cannot silently reuse stale state.
 * The pool never interrupts an active turn here: a sibling holding this native session that is running a turn (checked
 * out, or its sink attached, including a same-key resident the pool would otherwise open a second writer beside) makes
 * the whole handoff busy and retires nothing. Otherwise the matching idle and closing siblings are retired and returned,
 * so the caller waits for each to exit before the session is resumed (the codex/ACP contract; flow audit AD-5).
 */
export function retireClaudeModelSiblings(
  pool: AcpSessionPool<ClaudeResidentSession>,
  input: {
    owner: ClaudeResidentSession["executableOwner"];
    nativeSessionId: string;
    model?: string | null;
    poolKey?: string | null;
    /** A matching resident can change model in-process before receiving the next turn. */
    allowModelSwitch?: boolean;
    /** One-shot turns must retire even same-model siblings because they update native state out-of-process. */
    retireSameModel?: boolean;
  },
): { busy: boolean; retired: ClaudeResidentSession[] } {
  const targetModel = input.model?.trim() ?? "";
  return pool.retireIdleMatching((session) => (
    session.executableOwner.chatId === input.owner.chatId &&
    session.executableOwner.sessionOwnerId === input.owner.sessionOwnerId &&
    session.executableOwner.isolateOwner === input.owner.isolateOwner &&
    session.nativeSessionId === input.nativeSessionId &&
    (session.active !== null || input.retireSameModel === true || session.poolKey !== (input.poolKey ?? null)
      || (!input.allowModelSwitch && session.model !== targetModel))
  ));
}

export function claudeSessionPool(): AcpSessionPool<ClaudeResidentSession> {
  if (!sessionPool) {
    sessionPool = new AcpSessionPool<ClaudeResidentSession>({
      alive: claudeResidentSessionAlive,
      close: closeClaudeResidentSession,
      /*
       * ★유휴 상주가 호스트의 종료를 막으면 안 된다. 붙든 자식의 stdio 파이프는 부모의
       * 이벤트 루프를 잡으므로, unref 하지 않으면 일을 끝낸 터미널·게이트 스크립트가
       * 영영 안 끝난다(ACP 구현에서 실제로 나온 함정 — 같은 처방을 그대로 쓴다).
       */
      unref: (session) => {
        releaseAttemptChild(session.child);
        session.child.unref?.();
        for (const pipe of [session.child.stdin, session.child.stdout, session.child.stderr]) {
          (pipe as unknown as { unref?: () => void } | null)?.unref?.();
        }
      },
      ref: (session) => {
        claimAttemptChild(session.child);
        session.child.ref?.();
        for (const pipe of [session.child.stdin, session.child.stdout, session.child.stderr]) {
          (pipe as unknown as { ref?: () => void } | null)?.ref?.();
        }
      },
    });
    /*
     * ★나갈 때는 붙든 자식을 데려간다. unref 만 하고 여기를 비우면 종료가 곧 고아 생성이다.
     * 'exit' 은 동기 구간이라 SIGTERM 만 나간다 — claude 는 그거면 내려간다.
     */
    process.once("exit", () => {
      try {
        sessionPool?.disposeAll();
      } catch {
        /* 종료 중이다 */
      }
    });
  }
  return sessionPool;
}

/** 테스트/런타임 교체(자동 업데이트)용 — 붙든 세션을 전부 놓는다. */
export function disposeClaudeSessionPool(): void {
  sessionPool?.disposeAll();
  sessionPool = null;
}

/* ──────────────────────────── 스위치/키 ──────────────────────────── */

/**
 * `AGENTLAS_DISABLE_RESIDENCY=1`(또는 `=claude-code`)로 1회성 경로 복귀.
 * ACP 의 `AGENTLAS_DISABLE_ACP` 관례와 같은 문법이다.
 */
export function residencyDisabledFor(kind: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.AGENTLAS_DISABLE_RESIDENCY ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (raw === "1" || raw === "true" || raw === "all") return true;
  return raw.split(/[,\s]+/).includes(kind);
}

/**
 * 재사용 키. ACP 와 **같은 축**이다: 세션 지문(시스템프롬프트·권한 — 기존 계약
 * 그대로) 위에 프로세스 정체성(cwd · MCP 권한 · 실행 파일 · 도구 관문 · argv)을
 * 더하고, 마지막에 env 다이제스트를 얹는다.
 *
 * ★env 가 키에 들어가는 이유: 뜬 프로세스는 자기가 뜰 때의 env 를 **평생** 든다.
 * 자격증명이 갱신돼도 이미 떠 있는 CLI 는 옛 값을 쓴다. 그래서 env 가 바뀌면 이어 쓰지
 * 않는다(다이제스트만 쓰므로 값 자체는 어디에도 남지 않는다). env 에 매 실행 달라지는
 * 값이 있으면 재사용이 안 될 뿐 — 안전한 쪽으로 실패한다.
 *
 * ★MCP: Main writes a new config file for every invocation (mcp/client.ts configKey `invocation-<uuid>`), and its
 * entries carry that invocation's proxy launch handles and capability files, all revoked when the invocation ends.
 * Keying on that path made every owner follow-up spawn a new CLI (production: 1 resident reuse in 38 main calls). With
 * `mcpGrant` the key holds the grant's identity instead (the server names; the allowed tools, permission and env are in
 * argv and env), and the runner swaps the new invocation's servers into a reused process with an acknowledged
 * mcp_set_servers before the turn (claudeMcpSwapPayload). `mcpConfigPath` keeps the old per-path identity for an
 * executable that cannot swap.
 *
 * ★Runtime secret aliases under a grant (claudeEnvDigestOmissions): Main merges every invocation's MCP runtime env
 * into the runner env (mcp/client.ts), and some of it is minted per invocation (the native browser token, the OS
 * execution capability, guest computer use, the memory-curator bridge). Hashing those values defeated the grant: a
 * One Team member or writable-Goal chat that carried the Agentlas Browser spawned a new CLI on every follow-up
 * (measured through runMcpInvocation: 6 turns, 6 spawns). An alias the `--mcp-config` file never references is not read
 * by this process: those servers run behind Main's proxy (mcp-config.ts mcpProxySpec), which launches them with the
 * env Main registered for the new invocation's launch handle, and the swap hands the reused process that handle. So
 * its value leaves the key (its name stays). An alias the file references (`${ALIAS}`) is expanded once, at spawn,
 * into a process the swap might not touch, so its value stays in the key exactly as before.
 */
export function claudePoolKey(input: {
  chatId: string;
  fingerprint: string;
  sessionOwnerId?: string | null;
  isolateOwner?: boolean;
  executableGeneration: string;
  cwd: string;
  bin: string;
  mcpConfigPath?: string;
  /** claudeMcpGrantDigest of the invocation's MCP servers; the `--mcp-config` value then leaves the argv identity. */
  mcpGrant?: string;
  toolBrokerSettingsPath?: string;
  /** 스폰 argv. `--resume <id>` 와 `--model <name>` 쌍은 빼고 정렬한다(모델은 제어 요청으로 바뀐다). */
  args: string[];
  env?: NodeJS.ProcessEnv;
}): string {
  const omitted = input.mcpGrant !== undefined ? claudeEnvDigestOmissions(input.env ?? {}, input.args) : new Set<string>();
  const envDigest = crypto.createHash("sha256");
  for (const name of Object.keys(input.env ?? {}).sort()) {
    envDigest.update(name).update("\0");
    if (omitted.has(name)) envDigest.update("\u0001proxied-alias");
    else envDigest.update(String((input.env ?? {})[name] ?? ""));
    envDigest.update("\0");
  }
  const argvDigest = crypto.createHash("sha256");
  for (const arg of stableSpawnArgs(input.args, { mcpConfigByGrant: input.mcpGrant !== undefined })) argvDigest.update(arg).update("\0");
  return crypto
    .createHash("sha256")
    .update("claude-pool-v2\0")
    .update(input.chatId).update("\0")
    .update(JSON.stringify([input.sessionOwnerId ?? null, input.isolateOwner ?? false])).update("\0")
    .update(input.fingerprint).update("\0")
    .update(input.executableGeneration).update("\0")
    .update(input.cwd).update("\0")
    .update(input.bin).update("\0")
    .update(input.mcpGrant !== undefined ? `grant:${input.mcpGrant}` : `path:${input.mcpConfigPath ?? ""}`).update("\0")
    .update(input.toolBrokerSettingsPath ?? "").update("\0")
    .update(argvDigest.digest("hex")).update("\0")
    .update(envDigest.digest("hex"))
    .digest("hex");
}

/**
 * 키에 쓸 argv 정규화. `--resume <id>` 와 `--model <name>` 은 뺀다 — 세션은 모델을
 * set_model 로 바꿀 수 있고, 리퍼에 거둬진 뒤 재개할 때는 새 argv 로 시작한다.
 * 다시 열릴 때 그 한 쌍 때문에 키가 갈리면, 재사용이 아니라 매번 새 항목이 쌓인다.
 * 순서는 정렬로 지운다(새 세션 형상과 재개 형상은 같은 플래그를 다른 순서로 싣는다).
 * With `mcpConfigByGrant` the per-invocation `--mcp-config` path is replaced by a fixed token (the grant is keyed apart).
 */
export function stableSpawnArgs(args: string[], opts: { mcpConfigByGrant?: boolean } = {}): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--resume" || args[i] === "-r" || args[i] === "--model") {
      i += 1; // 세션 id 도 함께 건너뛴다
      continue;
    }
    if (opts.mcpConfigByGrant && args[i] === "--mcp-config") {
      out.push("--mcp-config", "<grant>");
      i += 1;
      continue;
    }
    out.push(args[i]!);
  }
  return out.sort();
}

/** mcp-config.ts mcpRuntimeSecretAlias: an opaque per-server name whose value is a vault secret or a per-run capability. */
const MCP_RUNTIME_SECRET_ALIAS_RE = /^AGENTLAS_MCP_SECRET_[A-F0-9]{32}$/;

/**
 * The names of the runtime secret aliases in `env` whose values do not identify the process: the ones the process's
 * `--mcp-config` never references (`${NAME}` / `${NAME:-default}` anywhere in it, a superset of the fields the CLI
 * expands). The config is that argument itself when it is inline JSON, else the file it names; when there is none or it
 * cannot be read, nothing is omitted and every value stays in the key. Only names are returned, never values.
 */
export function claudeEnvDigestOmissions(env: NodeJS.ProcessEnv, args: readonly string[]): Set<string> {
  const aliases = Object.keys(env).filter((name) => MCP_RUNTIME_SECRET_ALIAS_RE.test(name));
  if (aliases.length === 0) return new Set();
  const at = args.indexOf("--mcp-config");
  const config = at >= 0 ? args[at + 1] : undefined;
  if (!config) return new Set();
  let text: string;
  try { text = config.trimStart().startsWith("{") ? config : readFileSync(config, "utf8"); }
  catch { return new Set(); }
  const referenced = new Set([...text.matchAll(ENV_REFERENCE_RE)].map((match) => match[1]!));
  return new Set(aliases.filter((name) => !referenced.has(name)));
}

/** The MCP grant identity a resident may keep across invocations: the exact set of server names. */
export function claudeMcpGrantDigest(servers: Record<string, unknown>): string {
  return crypto.createHash("sha256").update("claude-mcp-grant-v1\0").update(JSON.stringify(Object.keys(servers).sort())).digest("hex");
}

const ENV_REFERENCE_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * The mcp_set_servers payload for a reused resident: this invocation's server entries with `${VAR}` / `${VAR:-default}`
 * resolved from the env the CLI was spawned with. Measured offline on 2.1.301: a --mcp-config entry gets that expansion,
 * a mcp_set_servers entry does not (the child saw the literal "${VAR}"). null when a reference has no value and no
 * default (the swap is then not attempted; a fresh process reads the file itself).
 */
export function claudeMcpSwapPayload(servers: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  let unresolved = false;
  const expand = (value: string): string => value.replace(ENV_REFERENCE_RE, (_match, name: string, fallback: string | undefined) => {
    const resolved = env[name];
    if (typeof resolved === "string") return resolved;
    if (fallback !== undefined) return fallback;
    unresolved = true;
    return "";
  });
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const entry: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    for (const field of ["command", "url"] as const) {
      if (typeof entry[field] === "string") entry[field] = expand(entry[field] as string);
    }
    if (Array.isArray(entry.args)) entry.args = entry.args.map((arg) => typeof arg === "string" ? expand(arg) : arg);
    for (const field of ["env", "headers"] as const) {
      const map = entry[field];
      if (map && typeof map === "object" && !Array.isArray(map)) {
        entry[field] = Object.fromEntries(Object.entries(map as Record<string, unknown>)
          .map(([key, value]) => [key, typeof value === "string" ? expand(value) : value]));
      }
    }
    out[name] = entry;
  }
  return unresolved ? null : out;
}

/** True when an mcp_set_servers control_response applied every server (success with an empty `errors` map). */
export function claudeMcpSwapApplied(response: Record<string, unknown> | null): boolean {
  if (!response || response.subtype !== "success") return false;
  const body = response.response && typeof response.response === "object" ? response.response as Record<string, unknown> : null;
  const errors = body?.errors;
  return Boolean(errors && typeof errors === "object" && !Array.isArray(errors) && Object.keys(errors).length === 0);
}
