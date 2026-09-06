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
import { StringDecoder } from "node:string_decoder";
import { AcpSessionPool, type AcpSessionLease } from "./acp-session-pool";
import { detachedSpawnOpts, killCliTree, spawnCli, trackRunChild } from "./exec";
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
  /** 우리가 놓았다(풀 축출·리퍼·호스트 종료). */
  closed: boolean;
  /** 프로세스가 죽었다. */
  dead: boolean;
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
}): ClaudeResidentSession {
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
    closed: false,
    dead: false,
    completedTurns: 0,
    stderrTail: "",
  };
  trackRunChild(child);
  // 자식이 stdio 를 상속한 손자를 남기고 죽으면 close 가 영영 안 온다 — runner.ts 주석 참고.
  ensureChildCloseAfterExit(child);
  const readStdout = createNdjsonLineReader((ev) => {
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
    const sink = session.active;
    session.active = null;
    try {
      sink?.onDeath(code);
    } catch {
      /* 정산은 턴 쪽 책임 */
    }
  };
  child.once("close", (code) => die(typeof code === "number" ? code : null));
  child.once("error", () => die(null));
  // stdin 이 EPIPE 로 프로세스를 죽이지 않게 한다(자식이 먼저 닫는 경우).
  child.stdin?.on("error", () => {});
  return session;
}

/** 이 세션이 아직 다음 턴을 받을 수 있는가. */
export function claudeResidentSessionAlive(session: ClaudeResidentSession): boolean {
  if (session.closed || session.dead) return false;
  const child = session.child;
  if (child.killed || child.exitCode !== null || child.signalCode !== null) return false;
  return Boolean(child.stdin && child.stdin.writable);
}

/** 세션을 놓는다(프로세스 트리 종료). */
export function closeClaudeResidentSession(session: ClaudeResidentSession): void {
  session.closed = true;
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
}

/**
 * 한 턴의 사용자 메시지를 stdin 으로 보낸다(NDJSON 한 줄, stdin 은 열어 둔다).
 * 실측 형태 그대로 — 이 모양이 아니면 CLI 가 그 줄을 조용히 버린다.
 */
export function writeClaudeResidentTurn(session: ClaudeResidentSession, text: string): boolean {
  const stdin = session.child.stdin;
  if (!stdin || !stdin.writable) return false;
  const line = `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
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
 * 재사용 키. ACP 와 **같은 축**이다: 세션 지문(모델·시스템프롬프트·권한 — 기존 계약
 * 그대로) 위에 프로세스 정체성(cwd · MCP 설정 경로 · 실행 파일 · 도구 관문 · argv)을
 * 더하고, 마지막에 env 다이제스트를 얹는다.
 *
 * ★env 가 키에 들어가는 이유: 뜬 프로세스는 자기가 뜰 때의 env 를 **평생** 든다.
 * 자격증명이 갱신돼도 이미 떠 있는 CLI 는 옛 값을 쓴다. 그래서 env 가 바뀌면 이어 쓰지
 * 않는다(다이제스트만 쓰므로 값 자체는 어디에도 남지 않는다). env 에 매 실행 달라지는
 * 값이 있으면 재사용이 안 될 뿐 — 안전한 쪽으로 실패한다.
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
  toolBrokerSettingsPath?: string;
  /** 스폰 argv. `--resume <id>` 쌍은 빼고 정렬해서 넣는다(같은 프로세스 형상 = 같은 키). */
  args: string[];
  env?: NodeJS.ProcessEnv;
}): string {
  const envDigest = crypto.createHash("sha256");
  for (const name of Object.keys(input.env ?? {}).sort()) {
    envDigest.update(name).update("\0").update(String((input.env ?? {})[name] ?? "")).update("\0");
  }
  const argvDigest = crypto.createHash("sha256");
  for (const arg of stableSpawnArgs(input.args)) argvDigest.update(arg).update("\0");
  return crypto
    .createHash("sha256")
    .update("claude-pool-v1\0")
    .update(input.chatId).update("\0")
    .update(JSON.stringify([input.sessionOwnerId ?? null, input.isolateOwner ?? false])).update("\0")
    .update(input.fingerprint).update("\0")
    .update(input.executableGeneration).update("\0")
    .update(input.cwd).update("\0")
    .update(input.bin).update("\0")
    .update(input.mcpConfigPath ?? "").update("\0")
    .update(input.toolBrokerSettingsPath ?? "").update("\0")
    .update(argvDigest.digest("hex")).update("\0")
    .update(envDigest.digest("hex"))
    .digest("hex");
}

/**
 * 키에 쓸 argv 정규화. `--resume <id>` 는 뺀다 — 같은 대화의 세션이 리퍼에 거둬진 뒤
 * 다시 열릴 때 그 한 쌍 때문에 키가 갈리면, 재사용이 아니라 매번 새 항목이 쌓인다.
 * 순서는 정렬로 지운다(새 세션 형상과 재개 형상은 같은 플래그를 다른 순서로 싣는다).
 */
export function stableSpawnArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--resume" || args[i] === "-r") {
      i += 1; // 세션 id 도 함께 건너뛴다
      continue;
    }
    out.push(args[i]!);
  }
  return out.sort();
}
