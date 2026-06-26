// Hephaestus 엔진 브리지 (코어).
//
// Hephaestus 는 별도 오픈소스 레포(github.com/agentlas-ai/Hephaestus)다. 데스크탑은
// 이 엔진을 "범용 CLI/JSON 인터페이스"로만 호출한다 — 즉 Hephaestus 소스에는 데스크탑
// 흔적이 전혀 없고(엔진은 자기가 어디서 호출되는지 모른다), 데스크탑↔Hephaestus 연결
// 코드는 오직 electron/hephaestus/* 안에만 존재한다. 이것이 목표 종료 조건의 핵심이다.
//
// 호출 방식: bin/hephaestus(bash) 래퍼를 거치지 않고, 그 래퍼와 동일한 runpy 부트스트랩을
// python 인터프리터에 직접 주입한다. 덕분에 Windows(.cmd/bash 불필요)·macOS·Linux 에서
// 동일하게 동작하고, 엔진은 `agentlas_cloud`/`ontology` 모듈로 실행된다.
import crossSpawn from "cross-spawn";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import type { ChildProcess } from "node:child_process";
import { withCliPath } from "../runtime/exec";

// bin/hephaestus 의 `run_python_module` 과 바이트 동일한 부트스트랩.
// `python -c <BOOTSTRAP> <module> <args...>` 형태로 호출하면 sys.argv[0] 이 모듈명이 되고,
// runpy 가 해당 패키지의 __main__ 을 실행한다(= agentlas_cloud.cli.main / ontology.cli).
const PY_BOOTSTRAP =
  "import os, runpy, sys; " +
  'cwd=os.getcwd(); root=os.environ["HEPHAESTUS_RUNTIME_ROOT"]; ' +
  'sys.path=[p for p in sys.path if p not in ("", cwd, root)]; ' +
  "sys.path.insert(0, root); " +
  "sys.argv=sys.argv[1:]; " +
  'runpy.run_module(sys.argv[0], run_name="__main__", alter_sys=True)';

export type HephaestusModule = "agentlas_cloud" | "ontology";

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

let cachedRoot: string | null | undefined;
let cachedPython: { python: string; version: string } | null | undefined;

/**
 * 임베딩된 Hephaestus 루트 경로를 해석한다.
 * - dev:       <repo>/Hephaestus            (app.getAppPath() == repo)
 * - packaged:  <app>/Contents/Resources/Hephaestus  (extraResources 대상)
 * 둘 다 없으면 환경변수(HEPHAESTUS_RUNTIME_ROOT) 폴백 후 null.
 */
export function hephaestusRoot(): string | null {
  if (cachedRoot !== undefined) return cachedRoot;
  const candidates: string[] = [];
  // 패키지 빌드: process.resourcesPath/Hephaestus
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "Hephaestus"));
  }
  // dev: 레포 루트/Hephaestus
  try {
    candidates.push(path.join(app.getAppPath(), "Hephaestus"));
  } catch {
    // app 미가용(테스트) — __dirname 기반 폴백
    candidates.push(path.join(__dirname, "..", "..", "..", "Hephaestus"));
  }
  // 명시적 오버라이드
  if (process.env.HEPHAESTUS_RUNTIME_ROOT) {
    candidates.push(process.env.HEPHAESTUS_RUNTIME_ROOT);
  }
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(path.join(c, "agentlas_cloud", "__main__.py"))) {
        cachedRoot = path.resolve(c);
        return cachedRoot;
      }
    } catch {
      // 다음 후보
    }
  }
  cachedRoot = null;
  return null;
}

/**
 * 데스크탑 앱에 번들된 standalone Python 경로(있으면). 엔진 폴더가 아니라 데스크탑 리소스에
 * 둔다(엔진 레포를 더럽히지 않기 위해). scripts/fetch-python-runtime.mjs 로 채우면
 * extraResources(build-resources/python-runtime → python-runtime)로 같이 패키징된다.
 */
function bundledPythonPaths(): string[] {
  const rel = process.platform === "win32" ? ["python.exe"] : ["bin", "python3"];
  const out: string[] = [];
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, "python-runtime", ...rel));
  try {
    // dev: <repo>/build-resources/python-runtime/...
    out.push(path.join(app.getAppPath(), "build-resources", "python-runtime", ...rel));
  } catch {
    /* app 미가용 */
  }
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
    const done = (v: string | null) => {
      if (!settled) {
        settled = true;
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
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* noop */
        }
        done(null);
      }, 2500);
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
  const env = withCliPath({ ...process.env });
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
  cachedRoot = undefined;
  cachedPython = undefined;
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
  const root = hephaestusRoot();
  if (!root) {
    return {
      ok: false,
      exitCode: null,
      json: null,
      stdout: "",
      stderr: "",
      error: "Hephaestus 엔진을 찾을 수 없습니다(번들 누락).",
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
      error: "Python 3.9+ 를 찾을 수 없습니다. python.org 또는 Homebrew(python3)로 설치 후 다시 시도하세요.",
    };
  }

  const env = withCliPath({
    ...process.env,
    ...opts.env,
    HEPHAESTUS_RUNTIME_ROOT: root,
    PYTHONPATH: root + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ""),
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  });

  const fullArgs = py.python === "py" ? ["-3", "-c", PY_BOOTSTRAP, module, ...args] : ["-c", PY_BOOTSTRAP, module, ...args];

  return new Promise<HephaestusResult<T>>((resolve) => {
    let child: ChildProcess;
    try {
      child = crossSpawn(py.python, fullArgs, {
        cwd: safeCwd(opts.cwd),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ ok: false, exitCode: null, json: null, stdout: "", stderr: "", error: (e as Error).message });
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;

    const finish = (res: HephaestusResult<T>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(res);
    };

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* noop */
      }
      finish({ ok: false, exitCode: null, json: null, stdout, stderr, error: "취소됨" });
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* noop */
      }
      finish({ ok: false, exitCode: null, json: parseEngineJson<T>(stdout), stdout, stderr, error: "타임아웃" });
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
      finish({ ok: false, exitCode: null, json: null, stdout, stderr, error: e.message });
    });
    child.on("close", (code) => {
      if (opts.onStdout && stdoutBuf.trim()) opts.onStdout(stdoutBuf);
      if (opts.onStderr && stderrBuf.trim()) opts.onStderr(stderrBuf);
      finish({
        ok: code === 0,
        exitCode: code,
        json: parseEngineJson<T>(stdout),
        stdout,
        stderr,
      });
    });
  });
}

export interface HephaestusAvailability {
  available: boolean;
  reason?: string;
  root: string | null;
  python: string | null;
  version: string | null;
}

/** 엔진 가용성(번들 존재 + python) 확인. UI 게이트/설정 표시에 사용. */
export async function hephaestusAvailable(): Promise<HephaestusAvailability> {
  const root = hephaestusRoot();
  if (!root) {
    return { available: false, reason: "엔진 번들 없음", root: null, python: null, version: null };
  }
  const py = await resolveHephaestusPython();
  if (!py) {
    return { available: false, reason: "Python 3.9+ 없음", root, python: null, version: null };
  }
  return { available: true, root, python: py.python, version: py.version };
}

/** `doctor` — 엔진 자가진단(JSON). warn 상태도 동작 가능으로 본다. */
export async function hephaestusDoctor(opts: HephaestusRunOptions = {}): Promise<HephaestusResult> {
  return runHephaestus("agentlas_cloud", ["doctor"], { timeoutMs: 30_000, ...opts });
}
