// 크로스플랫폼 CLI 실행 헬퍼.
//
// Windows에서 npm 전역 CLI(claude/codex/gemini)는 `claude.cmd` 같은 셸 심으로
// 설치된다. Node의 child_process.spawn/execFile은 `shell:true` 없이는 `.cmd`/`.bat`
// 를 실행하지 못해(ENOENT), 감지와 실행이 모두 실패했다. cross-spawn은 PATH+PATHEXT로
// 심을 찾아주고 인자를 cmd.exe에 안전하게 전달한다(수동 셸 인용 없이).
import crossSpawn from "cross-spawn";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import type { ChildProcess, SpawnOptions } from "node:child_process";

/**
 * 패키지된 GUI 앱(Finder/Dock 실행)은 로그인 셸의 PATH를 상속받지 못해 PATH가
 * 최소(`/usr/bin:/bin:/usr/sbin:/sbin`)다. 그 결과 (1) bare 커맨드(claude/codex/gemini)
 * 감지가 실패하고, (2) node 기반 CLI(codex.js/gemini.js)가 셰뱅의 `env node`로 node를
 * 못 찾아 죽는다. 흔한 CLI/런타임 bin 디렉터리를 PATH 뒤에 덧붙여 둘 다 해결한다.
 * 기존 PATH 항목이 우선순위를 유지하도록 append(prepend 아님).
 */
function cliSearchDirs(): string[] {
  if (process.platform === "win32") {
    return [
      path.join(process.env.APPDATA ?? "", "npm"),
      path.join(process.env.LOCALAPPDATA ?? "", "npm"),
    ].filter(Boolean);
  }
  const home = os.homedir();
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    path.join(home, ".local/bin"), // 네이티브 인스톨러: claude/codex/gemini
    path.join(home, ".codex/bin"),
    path.join(home, ".claude/local"),
    path.join(home, ".gemini/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".volta/bin"),
    path.join(home, ".nvm/current/bin"),
  ];
}

/** base 환경의 PATH 뒤에 흔한 CLI/node bin 디렉터리를 덧붙인 새 env 반환. */
export function withCliPath(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sep = path.delimiter;
  // Windows는 환경변수 키가 대소문자 무관 — 실제 키 이름을 찾아 그대로 갱신한다.
  const pathKey =
    Object.keys(base).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const existing = (base[pathKey] ?? "").split(sep).filter(Boolean);
  const have = new Set(existing);
  const extras = cliSearchDirs().filter((d) => d && !have.has(d));
  if (extras.length === 0) return base;
  return { ...base, [pathKey]: [...existing, ...extras].join(sep) };
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
  stdin.on("error", () => {});
  stdin.write(payload);
  stdin.end();
}

/**
 * CLI 러너가 실행될 안전한 작업 디렉터리.
 * 패키지된 앱은 cwd가 `/`(또는 앱 번들)이라 Claude는 권한 오류, Codex는
 * "not inside a trusted directory"로 실패한다. userData 아래 쓰기 가능한
 * 전용 폴더를 만들어 cwd로 사용한다.
 */
let _runCwd: string | null = null;
export function agentRunCwd(): string {
  if (_runCwd) return _runCwd;
  const dir = path.join(app.getPath("userData"), "agent-cwd");
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

function runProbeCliVersion(command: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

    const timer = setTimeout(() => {
      terminateProbeProcess(child);
      finish(null);
    }, timeoutMs);

    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code === 0) {
        finish(out.trim().split(/\s+/).pop() ?? "unknown");
      } else {
        finish(null);
      }
    });
  });
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
