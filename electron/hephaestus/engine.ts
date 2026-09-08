// Hephaestus 엔진 브리지 (코어).
//
// Hephaestus 는 Agentlas OS 오픈소스 레포(github.com/agentlas-ai/Agentlas-OS)의 엔진이다. 데스크탑은
// 이 엔진을 "범용 CLI/JSON 인터페이스"로만 호출한다 — 즉 Hephaestus 소스에는 데스크탑
// 흔적이 전혀 없고(엔진은 자기가 어디서 호출되는지 모른다), 데스크탑↔Hephaestus 연결
// 코드는 오직 electron/hephaestus/* 안에만 존재한다. 이것이 목표 종료 조건의 핵심이다.
//
// 호출 방식: bin/hephaestus(bash) 래퍼를 거치지 않고, 그 래퍼와 동일한 runpy 부트스트랩을
// python 인터프리터에 직접 주입한다. 덕분에 Windows(.cmd/bash 불필요)·macOS·Linux 에서
// 동일하게 동작하고, 엔진은 `agentlas_cloud`/`ontology`/`career_graph` 모듈로 실행된다.
import crossSpawn from "cross-spawn";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type ChildProcess } from "node:child_process";
import { detachedSpawnOpts, killCliTree, trackRunChild, withCliPath } from "../runtime/exec";
import { resolveManagedNodeRuntimeAsync } from "../runtime/managed-node";
import { withPythonCacheBoundary, withPythonRuntimeBoundary } from "../runtime/python-cache";
import { optionalElectronAppPath } from "../runtime-paths";
import { currentUiLocale } from "../ui-locale";
import { hephaestusRoot, hephaestusRootDetail, readHephaestusVersion, resetHephaestusRootCache } from "./root";
import type { HephaestusStatus, HephaestusUpdateJournal } from "../../shared/types";
import { classifyHephaestusUpdateJournal, parseHephaestusUpdateJournal } from "../../shared/hephaestus-update-contract";

export { hephaestusRoot, hephaestusRootDetail, readHephaestusVersion } from "./root";

// bin/hephaestus 의 `run_python_module` 과 바이트 동일한 부트스트랩.
// `python -c <BOOTSTRAP> <module> <args...>` 형태로 호출하면 sys.argv[0] 이 모듈명이 되고,
// runpy 가 해당 패키지의 __main__ 을 실행한다(= agentlas_cloud.cli.main / ontology.cli / career_graph.cli).
const PY_BOOTSTRAP =
  "import os, runpy, sys; " +
  'cwd=os.getcwd(); root=os.environ["HEPHAESTUS_RUNTIME_ROOT"]; ' +
  'sys.path=[p for p in sys.path if p not in ("", cwd, root)]; ' +
  "sys.path.insert(0, root); " +
  "sys.argv=sys.argv[1:]; " +
  'runpy.run_module(sys.argv[0], run_name="__main__", alter_sys=True)';

export type HephaestusModule = "agentlas_cloud" | "ontology" | "career_graph";

export interface HephaestusRunOptions {
  /** 엔진 실행 작업 디렉터리(보통 채팅 워크스페이스 폴더). 미지정 시 임시 안전 디렉터리. */
  cwd?: string;
  /** 추가/오버라이드 환경변수. */
  env?: NodeJS.ProcessEnv;
  /** 취소 시그널 — abort 시 자식 프로세스 kill. */
  signal?: AbortSignal;
  /** 타임아웃(ms). 초과 시 kill. 기본 900s(엔진 기본 타임아웃과 동일). */
  timeoutMs?: number;
  /** stderr 라인 스트림(진행 로그). */
  onStderr?: (line: string) => void;
  /** stdout 라인 스트림(라인 단위 출력 처리용). */
  onStdout?: (line: string) => void;
  /** UI 표시 언어 — 에러 문자열을 이 언어로 낸다. 미지정 시 currentUiLocale() 스냅샷. */
  locale?: "ko" | "en";
}

export interface HephaestusResult<T = unknown> {
  ok: boolean;
  exitCode: number | null;
  /** stdout 이 JSON 이면 파싱 결과, 아니면 null. */
  json: T | null;
  stdout: string;
  stderr: string;
  /** spawn 실패/타임아웃/엔진 부재 등 구조적 오류 메시지. */
  error?: string;
}

let cachedPython: { python: string; version: string } | null | undefined;

/**
 * 데스크탑 앱에 번들된 standalone Python 경로(있으면). 엔진 폴더가 아니라 데스크탑 리소스에
 * 둔다(엔진 레포를 더럽히지 않기 위해). scripts/fetch-python-runtime.mjs 로 채우면
 * extraResources(build-resources/python-runtime → python-runtime)로 같이 패키징된다.
 */
function bundledPythonPaths(): string[] {
  const rel = process.platform === "win32" ? ["python.exe"] : ["bin", "python3"];
  const out: string[] = [];
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, "python-runtime", ...rel));
  const appPath = optionalElectronAppPath();
  if (appPath) out.push(path.join(appPath, "build-resources", "python-runtime", ...rel));
  return out.filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

/** GUI 앱의 최소 PATH 환경에서도 python3.9+ 를 찾기 위한 후보 목록. */
function pythonCandidates(root: string | null): string[] {
  const home = os.homedir();
  const list: string[] = [];
  if (process.env.HEPHAESTUS_PYTHON) list.push(process.env.HEPHAESTUS_PYTHON);
  // 데스크탑에 번들된 standalone python 이 있으면 최우선(시스템 python 부재 머신 대응).
  list.push(...bundledPythonPaths());
  if (root) list.push(path.join(root, "bin", "python3")); // 엔진 자체 셰임(있으면)
  if (process.platform === "win32") {
    list.push("python", "python3", "py");
    list.push(path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", "Python312", "python.exe"));
    list.push(path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", "Python311", "python.exe"));
  } else {
    list.push("python3", "python");
    list.push(
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "/usr/bin/python3",
      path.join(home, ".pyenv", "shims", "python3"),
      // macOS python.org Framework 설치
      "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
    );
  }
  // 중복 제거(순서 유지)
  return [...new Set(list.filter(Boolean))];
}

/** 단일 python 후보가 3.9+ 인지 프로브하고 버전을 반환(아니면 null). */
function probePython(candidate: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (v: string | null) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(v);
      }
    };
    try {
      const probe = "import sys; sys.stdout.write('%d.%d.%d' % sys.version_info[:3]) if sys.version_info >= (3,9) else sys.exit(3)";
      const args = candidate === "py" ? ["-3", "-c", probe] : ["-c", probe];
      const child = crossSpawn(candidate, args, { env, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.on("error", () => done(null));
      child.on("close", (code) => done(code === 0 && out.trim() ? out.trim() : null));
      // Explicit runtimes are authoritative and may have a slow first launch
      // under Windows antivirus or a cold hosted-runner filesystem. Do not
      // misreport a valid configured Python as missing after only 2.5 seconds.
      const isBundledRuntime = path.isAbsolute(candidate) &&
        candidate.split(path.sep).includes("python-runtime");
      const timeoutMs = candidate === process.env.HEPHAESTUS_PYTHON || isBundledRuntime
        ? 10_000
        : 2_500;
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* noop */
        }
        done(null);
      }, timeoutMs);
    } catch {
      done(null);
    }
  });
}

/** python3.9+ 인터프리터를 해석(캐시). 못 찾으면 null.
 *  존재하지 않는 절대경로 후보는 프로브 없이 즉시 스킵해(no-python 머신의 누적 타임아웃 방지),
 *  bare 이름(python3/python/py)만 PATH 로 실제 프로브한다. */
export async function resolveHephaestusPython(): Promise<{ python: string; version: string } | null> {
  if (cachedPython !== undefined) return cachedPython;
  const root = hephaestusRoot();
  const env = withPythonCacheBoundary(withCliPath({ ...process.env }));
  for (const candidate of pythonCandidates(root)) {
    // 절대경로인데 파일이 없으면 프로브 자체를 건너뛴다(타임아웃 낭비 제거).
    if (path.isAbsolute(candidate)) {
      try {
        if (!fs.existsSync(candidate)) continue;
      } catch {
        continue;
      }
    }
    const version = await probePython(candidate, env);
    if (version) {
      cachedPython = { python: candidate, version };
      return cachedPython;
    }
  }
  cachedPython = null;
  return null;
}

/** 캐시 무효화(런타임 설치 후 재탐지용). */
export function resetHephaestusCache(): void {
  resetHephaestusRootCache();
  cachedPython = undefined;
}

export interface HephaestusStdioLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  runtimeRoot: string;
}

function pythonInvocation(candidate: string): { command: string; prefix: string[] } {
  const base = path.basename(candidate).toLowerCase();
  return {
    command: candidate,
    prefix: base === "py" || base === "py.exe" ? ["-3"] : [],
  };
}

/**
 * Resolve the same immutable Core root and cross-platform Python bridge without
 * yielding the Electron main loop. Project-context refresh is deliberately
 * synchronous so a map is never reported as ready merely because a background
 * process was started.
 */
export function resolveHephaestusSyncLaunch(
  module: string,
  args: string[],
  runtimeRootOverride?: string,
): HephaestusStdioLaunch | null {
  const selectedRoot = runtimeRootOverride?.trim() || hephaestusRoot();
  if (!selectedRoot) return null;
  let runtimeRoot: string;
  try {
    runtimeRoot = fs.realpathSync(selectedRoot);
    if (!fs.existsSync(path.join(runtimeRoot, "agentlas_cloud", "__main__.py"))) return null;
  } catch {
    return null;
  }

  const env = withPythonCacheBoundary(withCliPath({
    ...process.env,
    HEPHAESTUS_RUNTIME_ROOT: runtimeRoot,
    PYTHONPATH: runtimeRoot,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  }));
  const probe = "import sys; raise SystemExit(0 if sys.version_info >= (3,9) else 1)";
  for (const candidate of pythonCandidates(runtimeRoot)) {
    if (path.isAbsolute(candidate)) {
      try {
        if (!fs.existsSync(candidate)) continue;
      } catch {
        continue;
      }
    }
    const invocation = pythonInvocation(candidate);
    try {
      const checked = spawnSync(
        invocation.command,
        [...invocation.prefix, "-c", probe],
        {
          env,
          stdio: "ignore",
          timeout: path.isAbsolute(candidate) ? 10_000 : 2_500,
          windowsHide: true,
        },
      );
      if (checked.status !== 0) continue;
      return {
        command: invocation.command,
        args: [...invocation.prefix, "-c", PY_BOOTSTRAP, module, ...args],
        env,
        runtimeRoot,
      };
    } catch {
      // Continue to the next packaged or host Python candidate.
    }
  }
  return null;
}

/**
 * Build the same cross-platform Python launch contract used by the core bridge.
 * This keeps MCP off the mutable `~/.agentlas/.../bin/hephaestus` shell path and
 * lets packaged Windows/macOS/Linux apps use their bundled Python runtime.
 */
export async function resolveHephaestusStdioLaunch(
  module: string,
  args: string[],
  runtimeRootOverride?: string,
  /**
   * Only the Workforce preflight sets this. It skips engines that preflight
   * itself rejected, so its retry lands on a different one. Every other Core
   * feature ignores those rejections — see `hephaestusRootDetail`.
   */
  options?: {
    excludeRejected?: boolean;
    /**
     * OS task launches need the resident judge hint. Maintenance workers do
     * not, and probing every local model provider before spawning an updater
     * can delay Desktop startup by minutes.
     */
    includeJudgeRuntime?: boolean;
  },
): Promise<HephaestusStdioLaunch | null> {
  const selectedRoot = runtimeRootOverride?.trim()
    || hephaestusRootDetail({ excludeRejected: options?.excludeRejected })?.root
    || null;
  if (!selectedRoot) return null;
  let runtimeRoot: string;
  try {
    // A managed `current` path is mutable. Resolve it once so a multi-call
    // Workforce transaction can pin the immutable target directory.
    runtimeRoot = fs.realpathSync(selectedRoot);
    if (!fs.existsSync(path.join(runtimeRoot, "agentlas_cloud", "__main__.py"))) return null;
  } catch {
    return null;
  }
  const py = await resolveHephaestusPython();
  if (!py) return null;
  const pythonArgs = py.python === "py"
    ? ["-3", "-c", PY_BOOTSTRAP, module, ...args]
    : ["-c", PY_BOOTSTRAP, module, ...args];
  // Let the embedded OS runtime's resident judge use this desktop's connected
  // local model (Ollama / LM Studio / MLX). Absent for CLI / networked BYOK — the
  // OS side then reports the honest "connect a model" outcome, never a keyword.
  let judgeRuntime: string | undefined;
  if (options?.includeJudgeRuntime !== false) {
    try {
      const { pickActive } = await import("../runtime/selection");
      const { detectRuntimes } = await import("../runtime/detect");
      const { osJudgeRuntimeEnvValue } = await import("../runtime/os-judge-runtime");
      judgeRuntime = osJudgeRuntimeEnvValue(pickActive(await detectRuntimes()));
    } catch {
      judgeRuntime = undefined;
    }
  }
  return {
    command: py.python,
    args: pythonArgs,
    runtimeRoot,
    env: withPythonCacheBoundary({
      HEPHAESTUS_RUNTIME_ROOT: runtimeRoot,
      PYTHONPATH: runtimeRoot,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      ...(judgeRuntime ? { AGENTLAS_JUDGE_RUNTIME: judgeRuntime } : {}),
    }),
  };
}

/**
 * Start the Agentlas OS digest-verified updater without delaying Desktop.
 * The Python worker owns its lock, download verification, staged healthcheck,
 * and atomic `runtime/current` switch. The immutable bundled runtime remains
 * usable while this detached worker runs or when the machine is offline.
 */
export async function startHephaestusRuntimeAutoUpdate(): Promise<boolean> {
  // Prewarm the exact packaged Node receipt outside Electron Main even when
  // update checks are disabled. Later provider discovery and CLI launches use
  // the process cache instead of hashing the full runtime tree on first Work.
  await resolveManagedNodeRuntimeAsync();
  if (
    process.env.HEPHAESTUS_AUTO_UPDATE === "0" ||
    process.env.HEPHAESTUS_UPDATE_CHECK === "0"
  ) return false;
  const runtimeRoot = hephaestusRoot();
  if (!runtimeRoot) return false;
  const launch = await resolveHephaestusStdioLaunch(
    "agentlas_cloud.update",
    ["--auto-update-worker", runtimeRoot],
    undefined,
    { includeJudgeRuntime: false },
  );
  if (!launch) return false;
  try {
    const child = crossSpawn(launch.command, launch.args, {
      cwd: safeCwd(),
      env: withCliPath({ ...process.env, ...launch.env }),
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.once("error", (error) => {
      console.error("[hephaestus] Agentlas OS auto-update worker failed to start:", error.message);
    });
    child.unref();
    return true;
  } catch (error) {
    console.error(
      "[hephaestus] Agentlas OS auto-update worker failed to start:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/**
 * Read the engine updater's own journal.
 *
 * The launch-time auto-update worker runs detached with `stdio: "ignore"`, so
 * Desktop never learns what it did — a stuck engine looked identical to a
 * current one. Core already records every attempt to `runtime/auto-update.json`
 * (status, current, latest, when it last checked, when it last applied), so the
 * outcome was on disk the whole time with nothing reading it. Reading that file
 * needs no change to Agentlas OS, which is deliberate: the engine is a separate
 * open-source repo and Desktop must not grow a private contract inside it.
 *
 * `HEPHAESTUS_RUNTIME_BASE` is honoured because Core honours it — resolving the
 * journal anywhere else would report on a different installation than the one
 * that actually runs.
 */
export function readHephaestusUpdateJournal(): HephaestusUpdateJournal | null {
  const base = process.env.HEPHAESTUS_RUNTIME_BASE?.trim() || path.join(os.homedir(), ".agentlas", "runtime");
  try {
    const raw = fs.readFileSync(path.join(base, "auto-update.json"), "utf8");
    return parseHephaestusUpdateJournal(JSON.parse(raw));
  } catch {
    // No journal yet (fresh install, bundled-only, or an updater that never
    // got to run). Absent is a distinct answer from failed — return null and
    // let the caller say "not checked yet" rather than inventing a status.
    return null;
  }
}

function hephaestusRuntimeBase(): string {
  return process.env.HEPHAESTUS_RUNTIME_BASE?.trim() || path.join(os.homedir(), ".agentlas", "runtime");
}

/** Journal file mtime in ms, or null when it does not exist yet. */
function updateJournalStamp(): number | null {
  try {
    return fs.statSync(path.join(hephaestusRuntimeBase(), "auto-update.json")).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Is another updater holding Core's lock right now?
 *
 * Core takes `.update.lock` for the whole download and releases it on success,
 * and it records nothing to the journal when it cannot get the lock. Desktop
 * spawns a launch-time updater and one more on every Workforce preflight
 * rejection, so a user pressing the button during a download is not rare. Read
 * the lock (never write it) so that case can be named instead of being folded
 * into "no connection" — which was wrong precisely when an update did exist.
 */
function updaterLockHeld(): boolean {
  try {
    return fs.existsSync(path.join(hephaestusRuntimeBase(), ".update.lock"));
  } catch {
    return false;
  }
}

/**
 * Run the engine updater and report what it did.
 *
 * Written twice. The first version reported three failure modes cleanly, and two
 * of them were manufactured by this function rather than by anything going
 * wrong:
 *
 *   - It killed the worker at a fixed timeout. A large runtime download on a
 *     slow link is not a failure; killing it and saying "timeout" destroyed
 *     work that was about to succeed. The worker holds its own lock and can
 *     finish alone, so waiting stops here while the work continues — the result
 *     lands in the journal and is picked up on the next read.
 *   - It proved liveness with `last_checked_epoch`, which Core records in whole
 *     SECONDS. A run finishing inside the same second as the previous one (this
 *     takes ~1.2s when already current) produced an identical value and was
 *     reported as "nothing happened". The journal file's millisecond mtime is
 *     the same proof without the collision.
 *
 * What remains genuinely cannot be fixed here: the machine has no network. That
 * is not reported as a dead end either — the launch-time worker retries, so the
 * truthful and useful thing to say is that it will be picked up once there is a
 * connection. One short retry first, because the common case is a blip rather
 * than a real outage.
 *
 * Core swallows its own exceptions and always exits 0, so the exit code proves
 * nothing; the journal is the only evidence.
 */
export async function runHephaestusRuntimeUpdate(
  waitMs = 600_000,
): Promise<{
  ok: boolean;
  outcome: "applied" | "current" | "unknown" | "working" | "busy" | "offline" | "no_engine" | "no_python";
  error?: string;
  journal: HephaestusUpdateJournal | null;
}> {
  // Plain resolution: rejection no longer hides an engine from anything except
  // the Workforce preflight retry that recorded it. The updater in particular
  // must see the files it is meant to replace — an update is the cure for a
  // failed capability preflight, and reporting "reinstall the app" at that
  // moment would have sent the user to fetch the same rejected bundle again.
  const runtimeRoot = hephaestusRoot();
  if (!runtimeRoot) return { ok: false, outcome: "no_engine", error: "engine_not_attached", journal: null };
  // Pass the resolved root explicitly: the launcher would otherwise call
  // hephaestusRoot() again, hit the same rejection, and undo the repair path.
  const launch = await resolveHephaestusStdioLaunch(
    "agentlas_cloud.update",
    ["--auto-update-worker", runtimeRoot],
    runtimeRoot,
    { includeJudgeRuntime: false },
  );
  if (!launch) {
    // Reinstalling does not install a Python interpreter. Keep this distinct.
    return { ok: false, outcome: "no_python", error: "python_not_found", journal: readHephaestusUpdateJournal() };
  }

  // Waiting stops after `waitMs`; the worker is never killed. `finished` tells
  // the two apart so a long download is reported as in-progress, not as failure.
  const spawnOnce = () =>
    new Promise<{ finished: boolean; error?: string }>((resolve) => {
      let settled = false;
      const done = (value: { finished: boolean; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const child = crossSpawn(launch.command, launch.args, {
        cwd: safeCwd(),
        env: withCliPath({ ...process.env, ...launch.env }),
        stdio: "ignore",
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        child.unref();
        done({ finished: false });
      }, waitMs);
      child.once("error", (error) => done({ finished: true, error: error.message }));
      child.once("close", () => done({ finished: true }));
    });

  const verdict = (journal: HephaestusUpdateJournal | null) => {
    const disposition = classifyHephaestusUpdateJournal(journal);
    // "not applied" is not the same as "already newest". Core also reports
    // `skipped` (e.g. a non-SemVer RELEASE it cannot compare) and statuses this
    // build has never seen. Calling those "already up to date" told the user
    // the one thing that had not been established.
    if (disposition.state === "unknown" || disposition.state === "unobserved") {
      return { ok: true, outcome: "unknown" as const, journal };
    }
    const applied = disposition.state === "applied";
    // Deliberately NOT clearing the rejection set. Rejections are keyed by
    // realpath, so a genuine new release lands in a new directory and is not
    // rejected to begin with — the clear was a no-op there. Where it was not a
    // no-op it was harmful: `repaired_current` reinstalls the SAME tag into the
    // same directory, so clearing re-admitted the exact runtime a capability
    // preflight had just rejected, and clearing is global so it also released
    // unrelated targets. Verified 2026-07-28.
    if (applied) resetHephaestusCache();
    return { ok: true, outcome: applied ? ("applied" as const) : ("current" as const), journal };
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = updateJournalStamp();
    const run = await spawnOnce();
    if (!run.finished) {
      return { ok: true, outcome: "working", journal: readHephaestusUpdateJournal() };
    }
    const after = updateJournalStamp();
    if (after !== null && after !== before) return verdict(readHephaestusUpdateJournal());
    // Core writes the journal on every branch it completes, so an untouched
    // file means it threw before getting there. That has three causes and Core
    // reports none of them: lock contention, a failed install, or no network.
    // The lock is observable, so check it rather than guessing.
    if (updaterLockHeld()) return { ok: true, outcome: "busy", journal: readHephaestusUpdateJournal() };
    // Retry once: a transient blip is far more common than a real outage.
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return { ok: false, outcome: "offline", journal: readHephaestusUpdateJournal() };
}

function safeCwd(cwd?: string): string {
  if (cwd) {
    try {
      if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) return cwd;
    } catch {
      /* fallthrough */
    }
  }
  // 워크스페이스 미지정 시 엔진 데이터를 오염시키지 않는 안전 작업 디렉터리.
  const dir = path.join(os.tmpdir(), "agentlas-hephaestus-cwd");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return os.tmpdir();
  }
  return dir;
}

/** stdout 문자열에서 JSON 객체/배열을 최대한 견고하게 파싱. */
function parseEngineJson<T>(stdout: string): T | null {
  const text = stdout.trim();
  if (!text) return null;
  // 1) 전체가 JSON
  try {
    return JSON.parse(text) as T;
  } catch {
    /* 계속 */
  }
  // 2) 마지막 JSON 블록 추출(엔진이 사람용 프리앰블 후 JSON 을 낼 때)
  const firstObj = text.indexOf("{");
  const firstArr = text.indexOf("[");
  let start = -1;
  if (firstObj >= 0 && firstArr >= 0) start = Math.min(firstObj, firstArr);
  else start = Math.max(firstObj, firstArr);
  if (start >= 0) {
    const tail = text.slice(start);
    try {
      return JSON.parse(tail) as T;
    } catch {
      /* 계속 */
    }
    // 3) 마지막 줄이 JSON 인 경우
    const lines = text.split(/\r?\n/).reverse();
    for (const line of lines) {
      const t = line.trim();
      if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
        try {
          return JSON.parse(t) as T;
        } catch {
          /* 계속 */
        }
      }
    }
  }
  return null;
}

/**
 * Hephaestus 엔진 명령을 실행한다. (bash 우회, python 직접 호출)
 *
 * @param module  agentlas_cloud | ontology
 * @param args    엔진 서브커맨드 + 인자 (예: ["doctor"], ["route", query, "--auto-run"])
 */
export async function runHephaestus<T = unknown>(
  module: HephaestusModule,
  args: string[],
  opts: HephaestusRunOptions = {},
): Promise<HephaestusResult<T>> {
  const ko = (opts.locale ?? currentUiLocale()) === "ko";
  const root = hephaestusRoot();
  if (!root) {
    return {
      ok: false,
      exitCode: null,
      json: null,
      stdout: "",
      stderr: "",
      error: ko ? "Hephaestus 엔진을 찾을 수 없습니다(번들 누락)." : "Could not find the Hephaestus engine (bundle missing).",
    };
  }
  const py = await resolveHephaestusPython();
  if (!py) {
    return {
      ok: false,
      exitCode: null,
      json: null,
      stdout: "",
      stderr: "",
      error: ko
        ? "Python 3.9+ 를 찾을 수 없습니다. python.org 또는 Homebrew(python3)로 설치 후 다시 시도하세요."
        : "Could not find Python 3.9+. Install it from python.org or Homebrew (python3) and try again.",
    };
  }

  // Pin the engine for the lifetime of THIS call.
  //
  // `hephaestusRoot()` may return the mutable `~/.agentlas/runtime/current`
  // symlink. Python resolves imports lazily, so a long run (a build, a
  // Stormbreaker sweep, an ontology pass) that starts before an update and
  // continues after it would load some modules from the old release and some
  // from the new one — a mixture that was never tested and cannot be
  // reproduced from a version number. The two stdio launchers already realpath
  // for exactly this reason; this path did not (audit D3).
  //
  // Resolving here does not undo live version selection: the NEXT call resolves
  // again and gets the new release. Only mid-run substitution is removed.
  let pinnedRoot = root;
  try {
    pinnedRoot = fs.realpathSync(root);
  } catch {
    // An unreadable link is not a reason to refuse to run — fall back to the
    // path as given, which is what this code did before.
  }
  const env = withPythonRuntimeBoundary(py.python, withCliPath({
    ...process.env,
    ...opts.env,
    HEPHAESTUS_RUNTIME_ROOT: pinnedRoot,
    PYTHONPATH: pinnedRoot + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ""),
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  }));

  const fullArgs = py.python === "py" ? ["-3", "-c", PY_BOOTSTRAP, module, ...args] : ["-c", PY_BOOTSTRAP, module, ...args];

  return new Promise<HephaestusResult<T>>((resolve) => {
    let child: ChildProcess;
    try {
      child = crossSpawn(py.python, fullArgs, {
        cwd: safeCwd(opts.cwd),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        ...detachedSpawnOpts(),
      });
      trackRunChild(child);
    } catch (e) {
      resetHephaestusCache(); // 스폰 실패(경로/바이너리 문제) → 다음 호출에서 인터프리터/루트 재탐지
      resolve({ ok: false, exitCode: null, json: null, stdout: "", stderr: "", error: (e as Error).message });
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    let terminationReason: "cancelled" | "timeout" | null = null;

    const finish = (res: HephaestusResult<T>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(res);
    };

    const onAbort = () => {
      if (terminationReason) return;
      terminationReason = "cancelled";
      if (timer) clearTimeout(timer);
      // Resolve only from child close below. AbortController is a request, not
      // proof that the Python/Hub process tree has actually stopped.
      killCliTree(child, 1_500);
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };

    const timer = setTimeout(() => {
      if (terminationReason) return;
      terminationReason = "timeout";
      killCliTree(child, 1_500);
    }, opts.timeoutMs ?? 900_000);

    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      if (opts.onStdout) {
        stdoutBuf += s;
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) opts.onStdout(line);
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      if (opts.onStderr) {
        stderrBuf += s;
        const lines = stderrBuf.split(/\r?\n/);
        stderrBuf = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) opts.onStderr(line);
      }
    });
    child.on("error", (e) => {
      resetHephaestusCache(); // spawn-level 오류(ENOENT/ETXTBSY 등) → 죽은 인터프리터/루트 캐시 무효화
      finish({
        ok: false,
        exitCode: null,
        json: null,
        stdout,
        stderr,
        error:
          terminationReason === "cancelled"
            ? (ko ? "취소됨" : "Cancelled")
            : terminationReason === "timeout"
              ? (ko ? "타임아웃" : "Timed out")
              : e.message,
      });
    });
    child.on("close", (code) => {
      if (opts.onStdout && stdoutBuf.trim()) opts.onStdout(stdoutBuf);
      if (opts.onStderr && stderrBuf.trim()) opts.onStderr(stderrBuf);
      const json = parseEngineJson<T>(stdout);
      if (terminationReason) {
        finish({
          ok: false,
          exitCode: code,
          json,
          stdout,
          stderr,
          error:
            terminationReason === "cancelled"
              ? (ko ? "취소됨" : "Cancelled")
              : (ko ? "타임아웃" : "Timed out"),
        });
        return;
      }
      // 비정상 종료 + JSON 없음 + 모듈 누락 패턴이면 actionable 오류로 분류(그 외엔 raw stderr 유지).
      // close 경로에선 캐시를 비우지 않는다 — deps 문제는 경로 문제가 아니고, 재탐지 thrash를 막기 위함.
      const depError =
        code !== 0 && json === null && /ModuleNotFoundError|ImportError|No module named/.test(stderr)
          ? (ko ? "엔진 Python 의존성 누락 — 런타임 재설치 필요" : "Missing engine Python dependency — runtime needs reinstalling")
          : undefined;
      finish({
        ok: code === 0,
        exitCode: code,
        json,
        stdout,
        stderr,
        ...(depError ? { error: depError } : {}),
      });
    });
  });
}

/*
 * The IPC wire shape for `hephaestus:status`. This used to be a second,
 * hand-maintained copy of `HephaestusStatus` in shared/types.ts — adding one
 * field here broke the renderer at compile time because the two had silently
 * become the same contract in two places. Alias it instead, so the duplicate
 * cannot come back.
 */
export type HephaestusAvailability = HephaestusStatus;

/** 엔진 가용성(번들 존재 + python) 확인. UI 게이트/설정 표시에 사용. */
export async function hephaestusAvailable(locale: "ko" | "en" = "en"): Promise<HephaestusAvailability> {
  const ko = locale === "ko";
  const detail = hephaestusRootDetail();
  const root = detail?.root ?? null;
  const source = detail?.kind ?? null;
  if (!root) {
    return { available: false, reason: ko ? "Agentlas OS 엔진 없음" : "Agentlas OS engine not found", root: null, python: null, version: null, source: null, pythonVersion: null };
  }
  const version = readHephaestusVersion(root);
  const py = await resolveHephaestusPython();
  if (!py) {
    return { available: false, reason: ko ? "Python 3.9+ 없음" : "Python 3.9+ not found", root, python: null, version, source, pythonVersion: null };
  }
  return { available: true, root, python: py.python, version, source, pythonVersion: py.version };
}

/** `doctor` — 엔진 자가진단(JSON). warn 상태도 동작 가능으로 본다. */
export async function hephaestusDoctor(opts: HephaestusRunOptions = {}): Promise<HephaestusResult> {
  return runHephaestus("agentlas_cloud", ["doctor"], { timeoutMs: 30_000, ...opts });
}
