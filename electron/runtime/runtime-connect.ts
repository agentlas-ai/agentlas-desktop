// 런타임 한 개 연결 — 확인 → 설치 → 로그인 → 확인 → 완료 (오너 2026-09-29).
//
// "연결됨"·설치됨 초록불은 **살아 있는 확인** 뒤에만 켠다: 런타임 자체의 인증 상태 명령
// (codex login status · claude auth status) 또는 로그인해야만 답하는 서버 호출
// (grok models · agy models). 파일이 있다는 것만으로는 초록이 아니다.
//
// 로그인은 터미널 창 없이 CLI 자체 로그인 명령을 직접 띄운다 — 그 명령이 기본 브라우저를
// 공식 로그인 페이지로 연다. 완료는 타이머가 아니라 인증 상태 폴링으로 판단하고, 확인되면
// 로그인 프로세스를 정리한다. 모든 실패는 기계 사유 코드(reasonCode)를 싣는다.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentRunCwd, killCliTree, spawnCli, withCliPath } from "./exec";
import { observeCliExecutableIdentity } from "./cli-executable-identity";
import { probeKimiAuth } from "./kimi-auth";
import {
  augmentedEnv,
  installCli,
  openCliLogin,
  resolveCliActionSource,
  resolveCliBinary,
  type InstallableCli,
} from "./install-cli";
import type {
  ConnectableRuntime,
  RuntimeAuthProbe,
  RuntimeConnectReasonCode,
  RuntimeConnectSnapshot,
} from "../../shared/runtime-connect";
import { CONNECTABLE_RUNTIMES, maskAccount } from "../../shared/runtime-connect";
import { parseAgyModels } from "../../shared/model-discovery";

interface RuntimeConnectPlan {
  /** 우리가 설치할 수 있나(install-cli 고정 목록). */
  installable: boolean;
  /** 인증 상태를 묻는 argv. null = 인증 상태 명령이 없다(정직하게 unknown). */
  probeArgs: string[] | null;
  /** 헤드리스 로그인 argv. null = 터미널 로그인(openCliLogin)으로 대신한다. */
  loginArgs: string[] | null;
  /** CLI 가 브라우저를 스스로 열지 않고 URL 만 찍는 경우 앱이 연다. */
  openUrlFromOutput: boolean;
  /** 우리가 설치하지 않는 런타임의 공식 설치 안내(명령 또는 주소). */
  manualInstall?: string;
}

const PLANS: Record<ConnectableRuntime, RuntimeConnectPlan> = {
  codex: { installable: true, probeArgs: ["login", "status"], loginArgs: ["login"], openUrlFromOutput: false },
  "claude-code": { installable: true, probeArgs: ["auth", "status"], loginArgs: ["auth", "login"], openUrlFromOutput: false },
  // Official Grok v0.2.103 opens its OAuth URL itself; opening it again creates duplicate tabs.
  grok: { installable: true, probeArgs: ["models"], loginArgs: ["login", "--oauth"], openUrlFromOutput: false },
  // kimi login 은 브라우저를 스스로 연다(2026-09-29 실측: 앱도 열면 탭이 두 개).
  kimi: { installable: true, probeArgs: null, loginArgs: ["login"], openUrlFromOutput: false },
  // Antigravity 로그인은 인자 없이 띄운 TUI 안에서만 된다 → 터미널 로그인. 확인은 agy models.
  antigravity: { installable: false, probeArgs: ["models"], loginArgs: null, openUrlFromOutput: false, manualInstall: "https://antigravity.google" },
  cursor: { installable: false, probeArgs: ["status"], loginArgs: ["login"], openUrlFromOutput: false, manualInstall: "curl https://cursor.com/install -fsS | bash" },
};

const PROBE_TIMEOUT_MS = 20_000;
const POLL_MS = 2_500;
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000;
const LOG_LINES = 40;

function loginTimeoutMs(): number {
  const raw = Number(process.env.AGENTLAS_CONNECT_LOGIN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 5_000 ? raw : DEFAULT_LOGIN_TIMEOUT_MS;
}

function binaryFor(kind: ConnectableRuntime): string | null {
  if (kind === "cursor") return resolveCliBinary("cursor-agent");
  return resolveCliActionSource(kind);
}

function stripAnsi(text: string): string {
  // OSC 8 하이퍼링크(ESC ] 8 ;; url BEL/ST)와 CSI 색 코드를 지운다.
  return text
    .replace(/\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

interface AuthProbeContext {
  runtimeSource?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
}

function run(binary: string, args: string[], timeoutMs: number, context: AuthProbeContext = {}): Promise<{ code: number | null; out: string; ms: number; error?: string }> {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: "aborted" | "timeout") => {
      if (settled) return;
      finish(null, reason);
      if (child) killCliTree(child, 250);
    };
    const onAbort = () => stop("aborted");
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);
      resolve({ code, out: stripAnsi(out), ms: Date.now() - started, error });
    };
    if (context.signal?.aborted) { finish(null, "aborted"); return; }
    try {
      child = spawnCli(binary, args, { env: context.env ?? augmentedEnv(), ...(context.cwd ? { cwd: context.cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    } catch {
      finish(null, "spawn-failed");
      return;
    }
    child.stdout?.on("data", (c: Buffer) => { if (out.length < 64_000) out += c.toString("utf8"); });
    child.stderr?.on("data", (c: Buffer) => { if (out.length < 64_000) out += c.toString("utf8"); });
    child.on("error", () => finish(null, "spawn-failed"));
    child.on("close", (code) => finish(code));
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    context.signal?.addEventListener("abort", onAbort, { once: true });
    if (context.signal?.aborted) onAbort();
  });
}

/** codex 는 이메일을 말하지 않는다 — 자기 auth.json 의 id_token 에서 email 클레임만 읽는다(토큰은 쓰지 않음). */
function codexAccountEmail(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const home = env.CODEX_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".codex");
    const parsed = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")) as { tokens?: { id_token?: string } };
    const payload = parsed.tokens?.id_token?.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

/** 순수 해석 — 명령 출력만 보고 상태를 정한다(계약 테스트가 직접 부른다). */
export function interpretProbe(
  kind: ConnectableRuntime,
  result: { code: number | null; out: string; error?: string },
): Pick<RuntimeAuthProbe, "state" | "account" | "method"> {
  const out = result.out;
  if (result.error && result.code === null) return { state: "unknown", account: null, method: null };
  switch (kind) {
    case "codex":
      if (/not logged in/i.test(out)) return { state: "signed-out", account: null, method: null };
      if (result.code === 0 && /logged in/i.test(out)) {
        const method = /using\s+(.+)/i.exec(out)?.[1]?.trim() ?? null;
        return { state: "signed-in", account: null, method };
      }
      return { state: "unknown", account: null, method: null };
    case "claude-code": {
      try {
        const start = out.indexOf("{");
        const json = JSON.parse(out.slice(start, out.lastIndexOf("}") + 1)) as { loggedIn?: boolean; email?: string; subscriptionType?: string; authMethod?: string };
        if (json.loggedIn === true) return { state: "signed-in", account: maskAccount(json.email ?? null), method: json.subscriptionType ?? json.authMethod ?? null };
        if (json.loggedIn === false) return { state: "signed-out", account: null, method: null };
      } catch { /* 아래 */ }
      return { state: "unknown", account: null, method: null };
    }
    case "grok": {
      const who = /logged in with\s+([^\s.]+(?:\.[^\s.]+)*)/i.exec(out);
      if (who) return { state: "signed-in", account: null, method: who[1] };
      if (/not authenticated|not logged in|sign in/i.test(out)) return { state: "signed-out", account: null, method: null };
      return { state: "unknown", account: null, method: null };
    }
    case "antigravity":
      if (/sign in/i.test(out)) return { state: "signed-out", account: null, method: null };
      if (result.code === 0 && parseAgyModels(out).length > 0) return { state: "signed-in", account: null, method: "Google" };
      return { state: "unknown", account: null, method: null };
    case "cursor": {
      if (/not logged in|not authenticated/i.test(out)) return { state: "signed-out", account: null, method: null };
      const who = /logged in as\s+(\S+)/i.exec(out);
      if (result.code === 0 && who) return { state: "signed-in", account: maskAccount(who[1]), method: null };
      return { state: "unknown", account: null, method: null };
    }
    case "kimi":
      return { state: "unknown", account: null, method: null };
  }
}

export async function probeRuntimeAuth(kind: ConnectableRuntime, context: AuthProbeContext = {}): Promise<RuntimeAuthProbe> {
  const checkedAt = new Date().toISOString();
  const plan = PLANS[kind];
  // Invocation probes carry the selected executable and account environment. Never substitute a sibling
  // executable found in the app's default PATH when that exact source is unavailable.
  const binary = context.runtimeSource
    ? observeCliExecutableIdentity({ bin: context.runtimeSource, cwd: context.cwd ?? process.cwd(), env: context.env ?? augmentedEnv() })?.executable ?? null
    : binaryFor(kind);
  if (!binary) return { kind, state: "not-installed", account: null, method: null, latencyMs: null, checkedAt, evidence: "binary not found", reason: "not-installed" };
  const name = kind === "claude-code" ? "claude" : kind === "antigravity" ? "agy" : kind === "cursor" ? "cursor-agent" : kind;
  if (kind === "kimi") {
    const started = Date.now();
    const result = await probeKimiAuth({ env: context.env ?? augmentedEnv(), signal: context.signal });
    return {
      kind, state: result.state, account: null, method: result.state === "signed-in" ? "Kimi" : null,
      latencyMs: Date.now() - started, checkedAt,
      evidence: result.evidence.join(" · ") + (result.reason ? ` → ${result.reason}` : " → verified"),
      ...(result.state === "unknown" ? { reason: result.reason === "aborted" ? "aborted" as const
        : result.reason === "timeout" ? "timeout" as const : "unrecognized" as const } : {}),
    };
  }
  if (!plan.probeArgs) {
    return { kind, state: "unknown", account: null, method: null, latencyMs: null, checkedAt, evidence: `${name}: no auth-status command`, reason: "probe-unavailable" };
  }
  const result = await run(binary, plan.probeArgs, PROBE_TIMEOUT_MS, context);
  const read = interpretProbe(kind, result);
  let account = read.account;
  if (kind === "codex" && read.state === "signed-in") account = maskAccount(codexAccountEmail(context.env));
  return {
    kind,
    ...read,
    account,
    latencyMs: result.ms,
    checkedAt,
    evidence: `${name} ${plan.probeArgs.join(" ")} → ${result.error ?? `exit ${result.code}`}`,
    ...(result.error ? { reason: result.error as "timeout" | "aborted" | "spawn-failed" }
      : read.state === "unknown" ? { reason: "unrecognized" as const } : {}),
  };
}

/* ── 시작할 때·실행 전에 쓰는 캐시 ─────────────────────── */

const probeCache = new Map<ConnectableRuntime, RuntimeAuthProbe>();
const probeInFlight = new Map<ConnectableRuntime, Promise<RuntimeAuthProbe>>();
const PROBE_CACHE_MS = 60_000;

export function probeRuntimeAuthCached(kind: ConnectableRuntime, force = false): Promise<RuntimeAuthProbe> {
  const cached = probeCache.get(kind);
  if (!force && cached && Date.now() - Date.parse(cached.checkedAt) < PROBE_CACHE_MS) return Promise.resolve(cached);
  const running = probeInFlight.get(kind);
  if (running) return running;
  const task = probeRuntimeAuth(kind)
    .then((probe) => { probeCache.set(kind, probe); return probe; })
    .finally(() => probeInFlight.delete(kind));
  probeInFlight.set(kind, task);
  return task;
}

export async function probeAllRuntimeAuth(force = false): Promise<RuntimeAuthProbe[]> {
  return Promise.all(CONNECTABLE_RUNTIMES.map((kind) => probeRuntimeAuthCached(kind, force)));
}

/** Fresh on every invocation, including pooled turns. Auxiliary measurement never replaces provider errors. */
export async function probeRuntimeAuthForRun(kind: ConnectableRuntime, context: AuthProbeContext): Promise<RuntimeAuthProbe> {
  const env = withCliPath(context.env ?? process.env);
  const cwd = context.cwd ?? agentRunCwd();
  const defaultBinary = binaryFor(kind);
  const runtimeSource = context.runtimeSource ?? defaultBinary ?? undefined;
  const probe = await probeRuntimeAuth(kind, { ...context, runtimeSource, env, cwd });
  // A different project cwd can change project-local credential configuration even under the same HOME.
  // Keep alternate accounts/sources out of the default chips' cache; no secret or identity digest is emitted.
  const defaultEnv = augmentedEnv();
  const sameEnv = [...new Set([...Object.keys(env), ...Object.keys(defaultEnv)])].every((key) => env[key] === defaultEnv[key]);
  const selected = runtimeSource ? observeCliExecutableIdentity({ bin: runtimeSource, cwd, env }) : null;
  const expected = defaultBinary ? observeCliExecutableIdentity({ bin: defaultBinary, cwd: process.cwd(), env: defaultEnv }) : null;
  if (!context.signal?.aborted && sameEnv && path.resolve(cwd) === path.resolve(process.cwd())
    && selected && expected && selected.generation === expected.generation) probeCache.set(kind, probe);
  return probe;
}

/* ── 연결 세션 ─────────────────────── */

export interface RuntimeConnectDeps {
  probe: (kind: ConnectableRuntime) => Promise<RuntimeAuthProbe>;
  install: (kind: InstallableCli, opts: { onOutput: (line: string) => void; signal: AbortSignal }) => Promise<{ ok: boolean; message: string; reasonCode?: string; command?: string }>;
  spawnLogin: (kind: ConnectableRuntime, args: string[]) => ChildProcess | null;
  terminalLogin: (kind: ConnectableRuntime) => Promise<{ ok: boolean; message: string }>;
  openExternal: (url: string) => void;
  loginTimeoutMs: () => number;
  pollMs: number;
  emit: (snapshot: RuntimeConnectSnapshot) => void;
  /** 로그인 프로세스 정리(기본: 프로세스 그룹째). 계약 테스트가 가짜로 바꾼다. */
  killLogin?: (child: ChildProcess | null) => void;
}

function killProcessTree(child: ChildProcess | null): void {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill(); } catch { /* gone */ }
  }
}

export function createRuntimeConnector(deps: RuntimeConnectDeps) {
  const killTree = deps.killLogin ?? killProcessTree;
  const sessions = new Map<ConnectableRuntime, { snap: RuntimeConnectSnapshot; abort: AbortController; login: ChildProcess | null }>();
  let seq = 0;

  function publish(kind: ConnectableRuntime, patch: Partial<RuntimeConnectSnapshot>): void {
    const s = sessions.get(kind);
    if (!s) return;
    s.snap = { ...s.snap, ...patch, log: patch.log ?? s.snap.log };
    deps.emit(s.snap);
  }
  function log(kind: ConnectableRuntime, line: string): void {
    const s = sessions.get(kind);
    if (!s) return;
    publish(kind, { log: [...s.snap.log, line].slice(-LOG_LINES) });
  }
  function fail(kind: ConnectableRuntime, reasonCode: RuntimeConnectReasonCode, message: string, extra?: Partial<RuntimeConnectSnapshot>): void {
    const s = sessions.get(kind);
    if (!s || s.snap.phase !== "running") return;
    killTree(s.login);
    s.login = null;
    publish(kind, { phase: "failed", reasonCode, message, endedAt: new Date().toISOString(), ...extra });
  }

  async function drive(kind: ConnectableRuntime, sessionId: string): Promise<void> {
    const plan = PLANS[kind];
    const alive = () => sessions.get(kind)?.snap.sessionId === sessionId && sessions.get(kind)?.snap.phase === "running";
    const s = () => sessions.get(kind)!;

    // ① 확인 중
    let probe = await deps.probe(kind);
    if (!alive()) return;
    publish(kind, { probe });
    log(kind, `check: ${probe.evidence}`);
    if (probe.state === "signed-in") {
      publish(kind, { step: "done", phase: "done", endedAt: new Date().toISOString() });
      return;
    }

    // ② 설치 중
    if (probe.state === "not-installed") {
      if (!plan.installable) {
        publish(kind, { step: "installing" });
        fail(kind, "install_manual_only", plan.manualInstall ?? "", { manualInstall: plan.manualInstall ?? null });
        return;
      }
      publish(kind, { step: "installing" });
      const result = await deps.install(kind as InstallableCli, { onOutput: (line) => log(kind, line), signal: s().abort.signal });
      if (!alive()) return;
      if (!result.ok) {
        fail(kind, (result.reasonCode as RuntimeConnectReasonCode | undefined) ?? "install_failed", result.message, { manualInstall: result.command ?? null });
        return;
      }
      log(kind, result.message.replace(os.homedir(), "~"));
      probe = await deps.probe(kind);
      if (!alive()) return;
      publish(kind, { probe });
      log(kind, `check: ${probe.evidence}`);
      if (probe.state === "signed-in") {
        publish(kind, { step: "done", phase: "done", endedAt: new Date().toISOString() });
        return;
      }
      if (probe.state === "not-installed") {
        fail(kind, "install_verify_failed", "installed binary not found after install");
        return;
      }
    }

    // ③ 로그인 — 브라우저가 공식 로그인 페이지로 열린다.
    publish(kind, { step: "login" });
    let exited: number | null | undefined;
    if (plan.loginArgs) {
      const child = deps.spawnLogin(kind, plan.loginArgs);
      if (!child) {
        fail(kind, "login_spawn_failed", "login command did not start");
        return;
      }
      s().login = child;
      let opened = false;
      const onData = (chunk: Buffer) => {
        const text = stripAnsi(chunk.toString("utf8"));
        for (const line of text.split(/\r?\n/)) {
          const clean = line.trim();
          if (!clean) continue;
          const url = /https:\/\/[^\s"'<>\u0007]+/.exec(clean)?.[0] ?? null;
          if (url && !s().snap.loginUrl) {
            publish(kind, { loginUrl: url });
            if (plan.openUrlFromOutput && !opened) {
              opened = true;
              deps.openExternal(url);
            }
          }
          log(kind, url ? clean.replace(url, new URL(url).origin + "/…") : clean.slice(0, 300));
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", (e) => fail(kind, "login_spawn_failed", e.message));
      child.on("exit", (code) => { exited = code; });
    } else {
      const opened = await deps.terminalLogin(kind);
      if (!alive()) return;
      if (!opened.ok) {
        fail(kind, "login_spawn_failed", opened.message);
        return;
      }
      log(kind, "login: opened in Terminal");
    }

    // ④ 확인 중 — 인증 상태 폴링. 타이머로 성공을 선언하지 않는다.
    const deadline = Date.now() + deps.loginTimeoutMs();
    while (alive()) {
      await new Promise((resolve) => setTimeout(resolve, deps.pollMs));
      if (!alive()) return;
      probe = await deps.probe(kind);
      if (!alive()) return;
      if (probe.state === "signed-in") {
        publish(kind, { step: "verifying", probe });
        log(kind, `check: ${probe.evidence}`);
        killTree(s().login);
        s().login = null;
        publish(kind, { step: "done", phase: "done", endedAt: new Date().toISOString() });
        return;
      }
      if (exited === 0 && !plan.probeArgs && kind !== "kimi") {
        // 로그인 명령은 끝났지만 이 런타임엔 인증 상태를 물을 명령이 없다 — 초록으로 올리지 않는다.
        fail(kind, "probe_unavailable", "login finished; this runtime has no auth-status command to confirm it", { probe });
        return;
      }
      if (exited !== undefined && exited !== 0) {
        fail(kind, "login_exited", `login exited (${exited ?? "signal"})`, { probe });
        return;
      }
      if (Date.now() > deadline) {
        fail(kind, "login_timeout", `sign-in not confirmed within ${Math.round(deps.loginTimeoutMs() / 1000)}s`, { probe });
        return;
      }
    }
  }

  return {
    start(kind: ConnectableRuntime): RuntimeConnectSnapshot {
      const current = sessions.get(kind);
      if (current && current.snap.phase === "running") return current.snap;
      const sessionId = `${kind}-${Date.now()}-${++seq}`;
      const snap: RuntimeConnectSnapshot = {
        kind, sessionId, step: "checking", phase: "running", startedAt: new Date().toISOString(),
        endedAt: null, log: [], reasonCode: null, message: null, loginUrl: null, probe: null,
        partialInstall: false, manualInstall: null,
      };
      sessions.set(kind, { snap, abort: new AbortController(), login: null });
      deps.emit(snap);
      void drive(kind, sessionId).catch((error) => fail(kind, "probe_failed", error instanceof Error ? error.message : String(error)));
      return snap;
    },
    cancel(kind: ConnectableRuntime): RuntimeConnectSnapshot | null {
      const s = sessions.get(kind);
      if (!s) return null;
      if (s.snap.phase !== "running") return s.snap;
      const wasInstalling = s.snap.step === "installing";
      s.abort.abort();
      killTree(s.login);
      s.login = null;
      publish(kind, { phase: "cancelled", reasonCode: "cancelled", partialInstall: wasInstalling, endedAt: new Date().toISOString() });
      return s.snap;
    },
    get(kind: ConnectableRuntime): RuntimeConnectSnapshot | null {
      return sessions.get(kind)?.snap ?? null;
    },
    disposeAll(): void {
      for (const kind of sessions.keys()) this.cancel(kind);
    },
  };
}

/* ── 앱 기본 인스턴스 ─────────────────────── */

let emitter: (snapshot: RuntimeConnectSnapshot) => void = () => undefined;
export function setRuntimeConnectEmitter(fn: (snapshot: RuntimeConnectSnapshot) => void): void {
  emitter = fn;
}

export function defaultRuntimeConnector(openExternal: (url: string) => void, onDone: (kind: ConnectableRuntime) => void) {
  return createRuntimeConnector({
    probe: (kind) => probeRuntimeAuthCached(kind, true),
    install: (kind, opts) => installCli(kind, opts),
    spawnLogin: (kind, args) => {
      const binary = binaryFor(kind);
      if (!binary) return null;
      try {
        // 터미널 없이 — stdin 은 열어 둔다(닫히면 일부 CLI 가 곧바로 끝난다). detached = 프로세스 그룹째 정리.
        return spawnCli(binary, args, { env: augmentedEnv(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
      } catch {
        return null;
      }
    },
    terminalLogin: (kind) => openCliLogin(kind as Parameters<typeof openCliLogin>[0]),
    openExternal,
    loginTimeoutMs,
    pollMs: POLL_MS,
    emit: (snapshot) => {
      if (snapshot.phase === "done") onDone(snapshot.kind);
      emitter(snapshot);
    },
  });
}
