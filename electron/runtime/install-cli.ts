// CLI 설치 + 웹 로그인 헬퍼 (요청 ⑤).
//
// CLI가 없는 사용자를 위해: 미리 저장된 고정 명령만 실행한다(사용자 입력 X → 인젝션 불가).
//   1) installCli(kind)   — `npm i -g <고정 패키지>` 실행 (헤드리스)
//   2) openCliLogin(kind) — 시스템 터미널을 열어 CLI 자체 로그인 실행 → 브라우저 OAuth
//      (사용자는 "웹 로그인"만 하면 됨)
//   3) 이후 detectRuntimes()가 자동 인식
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnCli } from "./exec";

export type InstallableCli = "claude-code" | "codex" | "gemini" | "grok";

/** 고정 명령 화이트리스트 — 절대 사용자 입력을 끼우지 않는다. bin은 설치 후 PATH에 생기는 실행파일명. */
const CLI_PLAN: Record<InstallableCli, { pkg: string; loginCmd: string; bin: string }> = {
  "claude-code": { pkg: "@anthropic-ai/claude-code", loginCmd: "claude", bin: "claude" },
  codex: { pkg: "@openai/codex", loginCmd: "codex login", bin: "codex" },
  // 공식 Gemini CLI가 Google OAuth + 전역 extension/skills/MCP를 모두 지원한다.
  // 기존 Antigravity(agy)는 이미 설치된 머신의 호환 폴백으로만 감지한다.
  gemini: { pkg: "@google/gemini-cli", loginCmd: "gemini", bin: "gemini" },
  // Official xAI Grok Build CLI. Primary auth is browser OAuth; API key remains a headless fallback.
  grok: { pkg: "@xai-official/grok", loginCmd: "grok login", bin: "grok" },
};

const AGENTLAS_NPM_PREFIX = path.join(os.homedir(), ".agentlas", "npm");
const GEMINI_NPM_PACKAGE = "@google/gemini-cli";

// GUI Electron은 Finder/dock에서 뜨면 로그인 셸 PATH(/opt/homebrew/bin 등)를 못 받는다 →
// bare `npm`/`claude` spawn이 ENOENT로 실패. CLI 탐지/설치 모두에서 PATH를 보강한다.
const EXTRA_BIN_DIRS = [
  // 기존 process.env.PATH는 searchDirs()/augmentedEnv()에서 항상 먼저 유지한다.
  // 그 PATH에 없는 보충 후보끼리는 최신 사용자 standalone/Agentlas 관리본을
  // 오래된 Homebrew/npm 전역 심보다 먼저 찾는다.
  path.join(os.homedir(), ".local", "bin"),
  path.join(AGENTLAS_NPM_PREFIX, "bin"),
  AGENTLAS_NPM_PREFIX, // Windows npm prefix는 bin 하위가 아니라 prefix 루트에 .cmd를 둔다.
  path.join(os.homedir(), ".npm-global", "bin"),
  path.join(os.homedir(), "node_modules", ".bin"),
  path.join(os.homedir(), ".claude", "local"),
  path.join(os.homedir(), ".codex", "bin"),
  path.join(os.homedir(), ".gemini", "bin"),
  path.join(os.homedir(), ".grok", "bin"),
  path.join(os.homedir(), ".bun", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

function searchDirs(): string[] {
  const fromPath = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return [...fromPath, ...EXTRA_BIN_DIRS];
}

/** 실행 가능한 바이너리의 절대경로를 보강된 PATH에서 찾는다(없으면 null). */
function resolveBinary(name: string): string | null {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const dir of searchDirs()) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // next
      }
    }
  }
  return null;
}

/** 보강된 PATH를 가진 env (GUI spawn용). */
function augmentedEnv(): NodeJS.ProcessEnv {
  const merged = Array.from(new Set([...(process.env.PATH || "").split(path.delimiter), ...EXTRA_BIN_DIRS]))
    .filter(Boolean)
    .join(path.delimiter);
  return { ...process.env, PATH: merged };
}

export interface CliActionResult {
  ok: boolean;
  message: string;
  /** 실패 시 사용자가 직접 칠 수 있는 명령 */
  command?: string;
}

/** Official xAI Grok Build install.sh (curl | bash). Installs under ~/.grok/bin without sudo. */
function installGrokViaScript(): Promise<CliActionResult> {
  const url = "https://x.ai/cli/install.sh";
  const command = `curl -fsSL ${url} | bash`;
  return new Promise<CliActionResult>((resolve) => {
    let settled = false;
    const done = (r: CliActionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let out = "";
    let err = "";
    let child: ReturnType<typeof spawnCli>;
    try {
      // curl|bash 파이프는 셸이 필요 → bash -c. 고정 URL이라 인젝션 위험 없음.
      child = spawnCli("bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"], env: augmentedEnv() });
    } catch (e) {
      done({ ok: false, message: e instanceof Error ? e.message : String(e), command });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      done({ ok: false, message: "timed out after 3 min", command });
    }, 3 * 60 * 1000);
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("error", (e) => done({ ok: false, message: e.message, command }));
    child.on("close", (code) => {
      if (code === 0) done({ ok: true, message: out.slice(-400).trim() || "installed" });
      else done({ ok: false, message: (err || out).slice(-800).trim(), command });
    });
  });
}

/** `npm i -g <pkg>` 실행. node/npm이 없거나 권한 문제면 ok:false + 직접 실행할 명령 안내. */
export function installCli(
  kind: InstallableCli,
  opts?: { force?: boolean },
): Promise<CliActionResult> {
  const plan = CLI_PLAN[kind];
  if (!plan) return Promise.resolve({ ok: false, message: `Unknown CLI: ${kind}` });
  // sudo 없이 항상 성공하도록 유저 prefix(~/.agentlas/npm)로 설치한다 — 시스템 전역 prefix(/opt/homebrew 등)는
  // 쓰기에 root가 필요해 `npm i -g`가 EACCES로 실패하는 머신이 많다. 유저 prefix는 항상 쓰기 가능.
  const userPrefix = AGENTLAS_NPM_PREFIX;
  const command = `npm install -g ${plan.pkg} --prefix ${userPrefix}`;

  // 이미 설치돼 있으면 npm을 건드리지 않는다 — 네이티브 설치본(~/.local/bin/claude 등)도 인정.
  // force = 우리 prefix 관리본을 최신으로 재설치(updateCli 경로).
  const existing = resolveBinary(plan.bin);
  if (existing && !opts?.force) {
    return Promise.resolve({ ok: true, message: `already installed: ${existing}` });
  }

  // grok-cli는 공식 install.sh(~/.grok/bin, sudo 불필요)로 설치 — npm 전역 prefix가 sudo를 요구하는
  // 머신(homebrew 등)에서 `npm i -g`가 실패하는 문제를 피한다. (Windows는 아래 npm 폴백.)
  if (kind === "grok" && process.platform !== "win32") {
    return installGrokViaScript();
  }

  // GUI에서도 npm을 찾도록 절대경로로 resolve(+PATH 보강). 못 찾으면 직접 실행 명령 안내.
  const npmBin = resolveBinary("npm");
  if (!npmBin) {
    return Promise.resolve({
      ok: false,
      message: "npm not found on PATH. Install Node.js, then run the command below in a terminal.",
      command,
    });
  }

  return new Promise<CliActionResult>((resolve) => {
    let settled = false;
    const done = (r: CliActionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let out = "";
    let err = "";
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(npmBin, ["install", "-g", plan.pkg, "--prefix", userPrefix], {
        stdio: ["ignore", "pipe", "pipe"],
        env: augmentedEnv(),
      });
    } catch (e) {
      done({ ok: false, message: e instanceof Error ? e.message : String(e), command });
      return;
    }

    // npm cold install은 1~2분 — 5분 상한.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      done({ ok: false, message: "timed out after 5 min", command });
    }, 5 * 60 * 1000);

    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("error", (e) =>
      done({ ok: false, message: e.message, command }),
    );
    child.on("close", (code) => {
      if (code === 0) done({ ok: true, message: out.slice(-400).trim() || "installed" });
      else done({ ok: false, message: (err || out).slice(-800).trim(), command });
    });
  });
}

/** 바이너리를 헤드리스로 실행하고 결과를 모은다 (self-updater 실행용). */
function runBinary(bin: string, args: string[], timeoutMs: number): Promise<CliActionResult> {
  const command = `${path.basename(bin)} ${args.join(" ")}`;
  return new Promise<CliActionResult>((resolve) => {
    let settled = false;
    const done = (r: CliActionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let out = "";
    let err = "";
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: augmentedEnv() });
    } catch (e) {
      done({ ok: false, message: e instanceof Error ? e.message : String(e), command });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      done({ ok: false, message: `timed out after ${Math.round(timeoutMs / 60000)} min`, command });
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("error", (e) => done({ ok: false, message: e.message, command }));
    child.on("close", (code) => {
      if (code === 0) done({ ok: true, message: out.slice(-400).trim() || "updated" });
      else done({ ok: false, message: (err || out).slice(-800).trim(), command });
    });
  });
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** 심의 위치와 실제 대상을 함께 확인해 Agentlas가 소유한 npm 설치만 자동 변경한다. */
function isAgentlasManagedNpmBinary(binary: string): boolean {
  if (isPathWithin(binary, AGENTLAS_NPM_PREFIX)) return true;
  try {
    return isPathWithin(fs.realpathSync(binary), AGENTLAS_NPM_PREFIX);
  } catch {
    return false;
  }
}

function updateAgentlasManagedGemini(): Promise<CliActionResult> {
  const npmBin = resolveBinary("npm");
  const command = `npm install -g ${GEMINI_NPM_PACKAGE}@latest --prefix ${AGENTLAS_NPM_PREFIX}`;
  if (!npmBin) {
    return Promise.resolve({
      ok: false,
      message: "npm not found on PATH. Install Node.js, then run the command below in a terminal.",
      command,
    });
  }
  return runBinary(
    npmBin,
    ["install", "-g", `${GEMINI_NPM_PACKAGE}@latest`, "--prefix", AGENTLAS_NPM_PREFIX],
    5 * 60 * 1000,
  );
}

export type GeminiInstallOwner =
  | { kind: "npm"; prefix: string }
  | { kind: "homebrew" }
  | { kind: "unknown" };

/** 실제 바이너리 경로로 설치 소유자를 판별한다. npm 설치는 원래 global prefix까지 보존한다. */
export function classifyGeminiInstallOwner(
  binary: string,
  resolvedOverride?: string,
): GeminiInstallOwner {
  let resolved = binary;
  if (resolvedOverride) {
    resolved = resolvedOverride;
  } else {
    try {
      resolved = fs.realpathSync(binary);
    } catch {
      // 끊어진 심 등은 표시 경로만 사용한다.
    }
  }
  const normalized = resolved.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  // npm -g가 /opt/homebrew/lib/node_modules 아래 설치되는 경우도 있으므로 node_modules를
  // Homebrew formula보다 먼저 구분해야 패키지 관리자를 잘못 안내하지 않는다.
  const unixMarker = "/lib/node_modules/";
  const unixMarkerAt = lower.indexOf(unixMarker);
  if (unixMarkerAt > 0) {
    return { kind: "npm", prefix: normalized.slice(0, unixMarkerAt) };
  }
  const windowsMarker = "/node_modules/";
  const windowsMarkerAt = lower.indexOf(windowsMarker);
  if (windowsMarkerAt > 0 && lower.slice(0, windowsMarkerAt).endsWith("/npm")) {
    return { kind: "npm", prefix: normalized.slice(0, windowsMarkerAt) };
  }
  if (lower.includes("/cellar/") || lower.includes("/homebrew/opt/gemini-cli/")) {
    return { kind: "homebrew" };
  }
  return { kind: "unknown" };
}

/** 외부 설치도 고정된 원래 패키지 관리자만 사용해 최신화한다. 권한 실패는 수동 명령과 함께 표면화한다. */
function updateSelfManagedGemini(binary: string): Promise<CliActionResult> {
  const owner = classifyGeminiInstallOwner(binary);
  if (owner.kind === "npm") {
    const npmBin = resolveBinary("npm");
    const command = `npm install -g ${GEMINI_NPM_PACKAGE}@latest --prefix ${owner.prefix}`;
    if (!npmBin) {
      return Promise.resolve({ ok: false, message: "npm not found on PATH", command });
    }
    return runBinary(
      npmBin,
      ["install", "-g", `${GEMINI_NPM_PACKAGE}@latest`, "--prefix", owner.prefix],
      5 * 60 * 1000,
    );
  }
  if (owner.kind === "homebrew") {
    const brew = resolveBinary("brew");
    const command = "brew upgrade gemini-cli";
    if (!brew) return Promise.resolve({ ok: false, message: "Homebrew not found on PATH", command });
    return runBinary(brew, ["upgrade", "gemini-cli"], 10 * 60 * 1000);
  }
  return Promise.resolve({
    ok: false,
    message: `Gemini CLI install owner could not be verified: ${binary}`,
    command: `npm install -g ${GEMINI_NPM_PACKAGE}@latest`,
  });
}

/**
 * CLI를 최신으로 — 재로그인/연결 시 버전 불일치를 자동 해소한다.
 *   · 미설치 → installCli(설치가 곧 최신)
 *   · 우리 npm prefix(~/.agentlas/npm) 관리본 → npm 재설치(force)
 *   · claude-code 네이티브 설치본 → 공식 self-updater `claude update`
 *   · Codex standalone/네이티브 설치본 → 공식 self-updater `codex update`
 *   · Antigravity(agy) → 자체 updater `agy update`
 *   · Gemini CLI → Agentlas 관리 npm 또는 감지한 원래 npm/Homebrew로 최신화
 *   · grok → 공식 install.sh 재실행(멱등, 최신 설치)
 *   · 그 외(사용자 자체 관리본) → 건드리지 않는다
 */
export function updateCli(kind: InstallableCli): Promise<CliActionResult> {
  const plan = CLI_PLAN[kind];
  if (!plan) return Promise.resolve({ ok: false, message: `Unknown CLI: ${kind}` });

  // Gemini 런타임 선택과 같은 순서(공식 gemini 우선, agy 호환 폴백)로 실제 실행
  // 바이너리를 판별한다. 업데이트/로그인 UI가 실제 실행 바이너리와 달라지면 안 된다.
  if (kind === "gemini") {
    const gemini = resolveBinary("gemini");
    if (gemini) {
      if (isAgentlasManagedNpmBinary(gemini)) return updateAgentlasManagedGemini();
      return updateSelfManagedGemini(gemini);
    }

    const antigravity = resolveBinary("agy");
    if (antigravity) return runBinary(antigravity, ["update"], 5 * 60 * 1000);
    return installCli(kind);
  }

  const existing = resolveBinary(plan.bin);
  if (!existing) return installCli(kind);
  if (isAgentlasManagedNpmBinary(existing)) {
    return installCli(kind, { force: true });
  }
  if (kind === "claude-code") return runBinary(existing, ["update"], 2 * 60 * 1000);
  if (kind === "codex") return runBinary(existing, ["update"], 2 * 60 * 1000);
  if (kind === "grok" && process.platform !== "win32") return installGrokViaScript();
  return Promise.resolve({ ok: true, message: `self-managed install: ${existing} — update skipped` });
}

/**
 * 시스템 터미널에서 CLI 로그인 명령을 연다 — 사용자는 거기서 브라우저 로그인만 하면 된다.
 * loginCmd는 고정값이라 셸 인젝션 위험 없음.
 *
 * 함정 2개를 여기서 막는다:
 *  · CLI가 정말 없으면(설치 실패) 터미널을 열지 않는다 — "command not found" 경험 금지.
 *  · 앱이 설치한 CLI(~/.agentlas/npm/bin 등)는 사용자 셸 PATH에 없을 수 있다 →
 *    bare 이름 대신 절대경로로 실행한다.
 */
export function openCliLogin(kind: InstallableCli): CliActionResult {
  const plan = CLI_PLAN[kind];
  if (!plan) return { ok: false, message: `Unknown CLI: ${kind}` };
  const [, ...loginArgs] = plan.loginCmd.split(" ");
  // 실제 실행 순서와 동일하게 공식 Gemini를 먼저 열고, 없는 기존 머신에서만 agy로 폴백한다.
  const abs =
    kind === "gemini" ? (resolveBinary("gemini") ?? resolveBinary("agy")) : resolveBinary(plan.bin);
  if (!abs) {
    // 설치가 안 된 상태로 터미널부터 여는 건 금지 — 렌더러가 이 메시지로 실패를 표면화한다.
    return {
      ok: false,
      message: `${plan.bin} is not installed`,
      command: `npm install -g ${plan.pkg} --prefix ${AGENTLAS_NPM_PREFIX}`,
    };
  }
  // 절대경로 실행 — 셸 PATH 무관. 경로 공백/특수문자는 플랫폼별로 인용.
  // 터미널만 덜렁 뜨면 사용자가 뭘 해야 하는지 모른다 — 안내 한 줄을 먼저 찍는다.
  const guide =
    "== Agentlas: complete the login below (a browser window may open). When it says you are logged in, close this window. / 아래에서 로그인을 완료하세요(브라우저 창이 뜰 수 있습니다). 완료되면 이 창을 닫으면 됩니다. ==";
  const runCmd = [`'${abs.replace(/'/g, "'\\''")}'`, ...loginArgs].join(" ");
  const posixCmd = `echo '${guide}'; ${runCmd}`;
  const winCmd = [`"${abs}"`, ...loginArgs].join(" ");
  try {
    if (process.platform === "darwin") {
      // Terminal.app에서 실행 + 활성화. 경로는 위에서 단일인용으로 고정.
      spawn("osascript", [
        "-e",
        `tell application "Terminal" to do script "${posixCmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
        "-e",
        `tell application "Terminal" to activate`,
      ]);
    } else if (process.platform === "win32") {
      // 새 cmd 창에서 실행 후 유지(/k). start의 첫 따옴표 인자는 창 제목으로 먹히므로 "" 선행.
      spawn("cmd", ["/c", "start", '""', "cmd", "/k", winCmd], { shell: true });
    } else {
      // Linux best-effort — 대표 터미널 에뮬레이터.
      spawn("x-terminal-emulator", ["-e", [abs, ...loginArgs].join(" ")]);
    }
    return { ok: true, message: [abs, ...loginArgs].join(" ") };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e), command: plan.loginCmd };
  }
}
