// 크로스플랫폼 CLI 실행 헬퍼.
//
// Windows에서 npm 전역 CLI(claude/codex/kimi/grok)는 `claude.cmd` 같은 셸 심으로
// 설치된다. Node의 child_process.spawn/execFile은 `shell:true` 없이는 `.cmd`/`.bat`
// 를 실행하지 못해(ENOENT), 감지와 실행이 모두 실패했다. cross-spawn은 PATH+PATHEXT로
// 심을 찾아주고 인자를 cmd.exe에 안전하게 전달한다(수동 셸 인용 없이).
import crossSpawn from "cross-spawn";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { userDataPath } from "../runtime-paths";

/**
 * 패키지된 GUI 앱(Finder/Dock 실행)은 로그인 셸의 PATH를 상속받지 못해 PATH가
 * 최소(`/usr/bin:/bin:/usr/sbin:/sbin`)다. 그 결과 (1) bare 커맨드(claude/codex/agy)
 * 감지가 실패하고, (2) node 기반 CLI(codex.js 등)가 셰뱅의 `env node`로 node를
 * 못 찾아 죽는다. 흔한 CLI/런타임 bin 디렉터리를 보강해 둘 다 해결한다. Agentlas가 직접
 * 설치하고 검증한 prefix만 기존 PATH보다 먼저 두고, 그 밖의 사용자/시스템 후보는 원래
 * PATH 우선순위를 유지한다.
 */
function cliSearchDirs(): string[] {
  if (process.platform === "win32") {
    return [
      path.join(os.homedir(), ".local", "bin"),
      path.join(os.homedir(), ".agentlas", "npm"),
      path.join(process.env.APPDATA ?? "", "npm"),
      path.join(process.env.LOCALAPPDATA ?? "", "npm"),
    ].filter(Boolean);
  }
  const home = os.homedir();
  return [
    path.join(home, ".local/bin"), // 네이티브 인스톨러: claude/codex/agy
    path.join(home, ".agentlas/npm/bin"), // Agentlas가 관리하는 최신 npm prefix
    path.join(home, ".codex/bin"),
    path.join(home, ".claude/local"),
    path.join(home, ".bun/bin"),
    path.join(home, ".volta/bin"),
    path.join(home, ".nvm/current/bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
  ];
}

function managedCliDir(): string {
  return process.platform === "win32"
    ? path.join(os.homedir(), ".agentlas", "npm")
    : path.join(os.homedir(), ".agentlas", "npm", "bin");
}

function preferredManagedCliDir(): string | null {
  const managed = managedCliDir();
  // Preview builds briefly stored a generic node.cmd beside provider shims.
  // Never put that directory before a project's PATH until Connect migrates it
  // to the isolated npm-bootstrap directory and direct provider launchers.
  if (process.platform === "win32" && fs.existsSync(path.join(managed, "node.cmd"))) return null;
  return managed;
}

/** Agentlas 관리 CLI를 우선하고 그 뒤에 기존 PATH와 보충 경로를 둔 새 env 반환. */
export function withCliPath(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sep = path.delimiter;
  // Windows는 환경변수 키가 대소문자 무관 — 실제 키 이름을 찾아 그대로 갱신한다.
  const pathKey =
    Object.keys(base).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const existing = (base[pathKey] ?? "").split(sep).filter(Boolean);
  const managed = preferredManagedCliDir();
  const merged = Array.from(new Set([
    ...(managed ? [managed] : []),
    ...existing.filter((entry) => entry !== managed),
    ...cliSearchDirs(),
  ].filter(Boolean)));
  return { ...base, [pathKey]: merged.join(sep) };
}

/** child_process.spawn 대체 — Windows `.cmd`/`.bat` 심 해석 + GUI용 PATH 보강. */
export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  return crossSpawn(command, args, {
    ...options,
    env: withCliPath(options.env ?? process.env),
  });
}

/**
 * 큰 프롬프트를 커맨드라인 인자가 아니라 자식 stdin으로 전달한다.
 * Windows에서 CLI는 `.cmd` 심 → cmd.exe로 실행되는데, cmd.exe 커맨드라인은
 * ~8191자 한계 + 인자 내 개행 불가다. Agentlas 시스템 프롬프트만 ~24KB라
 * 큰 프롬프트를 argv로 넘기면 잘려서 CLI가 exit 1로 죽는다(= "Windows에서만 안 됨").
 * stdin은 이 한계를 받지 않는다(macOS/Linux도 동일하게 안전).
 * 자식이 stdin을 다 읽기 전에 종료하면 EPIPE가 나는데 무시한다.
 */
export function writeStdin(child: ChildProcess, payload: string): void {
  const stdin = child.stdin;
  if (!stdin) return;
  // try/catch alone cannot catch a later EPIPE event. Keep an error listener attached for the
  // whole stream lifetime, and avoid scheduling a write after the child already closed stdin.
  stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (
      error.code !== "EPIPE" &&
      error.code !== "ERR_STREAM_DESTROYED" &&
      error.code !== "ERR_STREAM_WRITE_AFTER_END"
    ) {
      console.error("[runtime] child stdin failed:", error.message);
    }
  });
  if (stdin.destroyed || stdin.writableEnded || stdin.writableFinished || !stdin.writable) return;
  try {
    // One end(payload) call leaves a smaller write-vs-exit race than write(payload) followed by end().
    stdin.end(payload);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPIPE" && code !== "ERR_STREAM_DESTROYED" && code !== "ERR_STREAM_WRITE_AFTER_END") {
      console.error("[runtime] child stdin write failed:", error);
    }
  }
}

/**
 * CLI 러너가 실행될 안전한 작업 디렉터리.
 * 패키지된 앱은 cwd가 `/`(또는 앱 번들)이라 Claude는 권한 오류, Codex는
 * "not inside a trusted directory"로 실패한다. userData 아래 쓰기 가능한
 * 전용 폴더를 만들어 cwd로 사용한다.
 */
let _runCwd: string | null = null;
/**
 * ★AI가 짠 JS 코드 스텝을 돌릴 node 실행 파일. Electron 안에서는 `ELECTRON_RUN_AS_NODE`가
 * 붙은 자기 자신이 아니라 순수 node가 필요하다 — 아니면 사용자 코드가 Electron API에 닿는다.
 * (tool-factory의 nodeExecPath와 같은 규칙 — 코드 실행기가 공유한다.)
 */
export function nodeExecPathForCode(): string {
  const versions = process.versions as NodeJS.ProcessVersions & { electron?: string };
  return process.env.npm_node_execpath || process.env.NODE || (versions.electron ? "node" : process.execPath);
}

export function agentRunCwd(): string {
  if (_runCwd) return _runCwd;
  const dir = userDataPath("agent-cwd");
  try {
    fs.mkdirSync(dir, { recursive: true });
    _runCwd = dir;
  } catch {
    _runCwd = app.getPath("home");
  }
  return _runCwd;
}

/**
 * `<command> --version` 베스트에포트 실행. CLI가 PATH(또는 절대경로)에 있고
 * 실행 가능하면 버전 문자열을, 아니면 null을 반환한다. Windows 심도 해석된다.
 */
/**
 * 후보 경로 중 실제로 쓸 수 있는 첫 항목. 러너 다섯이 같은 함수를 손으로 들고
 * 있다가 kimi 사본만 몰래 달라졌던 것(진리값 판정이라 빈 버전 문자열을 거절)을
 * 여기 한 벌로 통합했다.
 * - bare 커맨드명: PATH(+Windows PATHEXT)로 probeCliVersion 해석(.cmd 심 포함).
 * - 절대경로: 기본은 존재 확인만. probeAbsolute는 절대경로에도 버전 프로브를
 *   요구한다(존재하지만 실행이 죽는 바이너리를 거르는 kimi의 강한 판정).
 */
export async function firstExistingCli(
  paths: string[],
  options?: { probeTimeoutMs?: number; probeAbsolute?: boolean },
): Promise<string | null> {
  const timeout = options?.probeTimeoutMs ?? 2000;
  for (const candidate of paths) {
    if (!path.isAbsolute(candidate)) {
      // bare 커맨드명 — PATH(+Windows PATHEXT)로 해석. .cmd 심 포함.
      if ((await probeCliVersion(candidate, timeout)) !== null) return candidate;
      continue;
    }
    try {
      await fs.promises.access(candidate);
    } catch {
      continue;
    }
    if (options?.probeAbsolute) {
      if ((await probeCliVersion(candidate, timeout)) !== null) return candidate;
      continue;
    }
    return candidate;
  }
  return null;
}

export function probeCliVersion(command: string, timeoutMs = 3000): Promise<string | null> {
  const cacheMs = Number(process.env.AGENTLAS_RUNTIME_PROBE_CACHE_MS ?? 30_000);
  const key = `${command}\0${timeoutMs}`;
  const now = Date.now();
  const cached = versionProbeCache.get(key);
  if (cached && now - cached.at < cacheMs) return cached.promise;

  const promise = runProbeCliVersion(command, timeoutMs);
  versionProbeCache.set(key, { at: now, promise });
  return promise;
}

const versionProbeCache = new Map<string, { at: number; promise: Promise<string | null> }>();

/** 사용자가 명시적으로 전체 재확인을 요청했을 때 CLI 버전 증거도 새로 읽는다. */
export function clearCliVersionProbeCache(): void {
  versionProbeCache.clear();
}

/**
 * CLI마다 `--version` 형식이 다르다. 예를 들어 Claude는
 * `2.1.30 (Claude Code)`를 출력하므로 마지막 공백 토큰을 버전으로 취급하면
 * 대시보드에 `vCode)`가 노출된다. 첫 SemVer 토큰만 정규화하고, 버전 없는
 * 성공 출력은 호출 가능성 보존을 위해 `unknown`으로 구분한다.
 */
export function parseCliVersionOutput(output: string): string | null {
  // Some CLIs colorize version output even when stdout is piped.
  const text = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").trim();
  if (!text) return null;
  const match = text.match(/(?:^|[^0-9A-Za-z])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|[^0-9A-Za-z])/);
  return match?.[1] ?? null;
}

function runProbeCliVersion(command: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };

    let child: ChildProcess;
    try {
      child = crossSpawn(command, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: withCliPath(process.env),
        detached: process.platform !== "win32",
      });
    } catch {
      finish(null);
      return;
    }

    timer = setTimeout(() => {
      terminateProbeProcess(child);
      finish(null);
    }, timeoutMs);

    let out = "";
    let err = "";
    const appendBounded = (current: string, chunk: Buffer): string => {
      if (current.length >= 16_384) return current;
      return (current + chunk.toString("utf8")).slice(0, 16_384);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      out = appendBounded(out, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err = appendBounded(err, chunk);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code === 0) {
        const combined = [out, err].filter((value) => value.trim()).join("\n");
        finish(parseCliVersionOutput(combined) ?? (combined.trim() ? "unknown" : null));
      } else {
        finish(null);
      }
    });
  });
}

/** POSIX에서 프로세스 그룹 킬이 가능하도록 detached 스폰 옵션(런 자식용). Windows는 미지원. */
export function detachedSpawnOpts(): { detached?: boolean } {
  return process.platform !== "win32" ? { detached: true } : {};
}

/**
 * LLM 실행 자식 트리 종료 — POSIX는 프로세스 그룹 SIGTERM → graceMs 후 SIGKILL 승격.
 * 단일 child.kill()은 CLI가 띄운 손자(MCP 서버·빌드 프로세스)를 고아로 남기던 문제를 막는다.
 * Windows/그룹킬 실패 시 단일 kill 폴백. detachedSpawnOpts()와 짝으로 사용.
 */
export function killCliTree(child: ChildProcess, graceMs = 4000): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      const sigkill = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // already exited
        }
      }, graceMs);
      // Do not leave a delayed negative-PID kill armed after the original
      // process group exits. Apart from needless timers, a quickly reused PID
      // could otherwise target an unrelated later process group.
      child.once("close", () => clearTimeout(sigkill));
      child.once("error", () => clearTimeout(sigkill));
      sigkill.unref?.();
      return;
    } catch {
      // fall through to direct child kill
    }
  }
  try {
    child.kill();
  } catch {
    // already exited
  }
}

// 살아있는 LLM 실행 자식 추적 — 앱 종료 시 전부 트리킬해 고아 CLI/MCP 프로세스를 남기지 않는다.
const liveRunChildren = new Set<ChildProcess>();
let quitHookInstalled = false;

/**
 * LLM 실행 자식 등록: 종료 시 자동 해제 + 앱 will-quit 일괄 트리킬 + 낮은 우선순위(nice 5).
 * 우선순위는 손자(빌드/MCP)에도 상속돼 장시간 에이전트 작업 중에도 UI가 응답성을 유지한다.
 */
export function trackRunChild(child: ChildProcess): void {
  liveRunChildren.add(child);
  child.once("close", () => liveRunChildren.delete(child));
  child.once("error", () => liveRunChildren.delete(child));
  if (child.pid != null) {
    try {
      os.setPriority(child.pid, 5);
    } catch {
      // 이미 종료됐거나 권한 문제 — 무시
    }
  }
  if (!quitHookInstalled) {
    quitHookInstalled = true;
    try {
      app.once("will-quit", () => {
        for (const c of liveRunChildren) killCliTree(c, 500);
        liveRunChildren.clear();
      });
    } catch {
      // 테스트 등 app 부재 환경 — 무시
    }
  }
}

function terminateProbeProcess(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      const sigkill = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // already exited
        }
      }, 750);
      sigkill.unref?.();
      return;
    } catch {
      // fall through to direct child kill
    }
  }
  try {
    child.kill();
  } catch {
    // already exited
  }
}
