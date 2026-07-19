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
import { resolveManagedNodeRuntime, type ManagedNodeRuntime } from "./managed-node";

export type InstallableCli = "claude-code" | "codex" | "gemini" | "grok";

/**
 * 고정 공급망 화이트리스트. Desktop 릴리스가 검증한 정확한 공식 패키지만 설치하고,
 * `@latest`나 Renderer 입력을 npm argv에 넣지 않는다.
 */
const CLI_PLAN: Record<InstallableCli, {
  pkg: string;
  version: string;
  loginArgs: string[];
  bin: string;
}> = {
  "claude-code": { pkg: "@anthropic-ai/claude-code", version: "2.1.214", loginArgs: [], bin: "claude" },
  codex: { pkg: "@openai/codex", version: "0.144.6", loginArgs: ["login"], bin: "codex" },
  // 공식 Gemini CLI가 Google OAuth + 전역 extension/skills/MCP를 모두 지원한다.
  // 기존 Antigravity(agy)는 이미 설치된 머신의 호환 폴백으로만 감지한다.
  gemini: { pkg: "@google/gemini-cli", version: "0.51.0", loginArgs: [], bin: "gemini" },
  // Official xAI Grok Build CLI. Primary auth is browser OAuth; API key remains a headless fallback.
  grok: { pkg: "@xai-official/grok", version: "0.2.103", loginArgs: ["login"], bin: "grok" },
};

const AGENTLAS_NPM_PREFIX = path.join(os.homedir(), ".agentlas", "npm");
const AGENTLAS_NPM_CACHE = path.join(os.homedir(), ".agentlas", "cache", "npm");
const AGENTLAS_NPM_CONFIG = path.join(os.homedir(), ".agentlas", "config", "managed-npmrc");
const AGENTLAS_NPM_GLOBAL_CONFIG = path.join(os.homedir(), ".agentlas", "config", "managed-global-npmrc");
const AGENTLAS_NPM_BOOTSTRAP_BIN = path.join(os.homedir(), ".agentlas", "runtime", "npm-bootstrap-bin");
const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";
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
  // Once Agentlas owns a verified install, always prefer it over stale user or
  // system shims. Otherwise installation can succeed and login immediately
  // reopen an older broken binary from PATH.
  return Array.from(new Set([managedBinDir(), ...fromPath, ...EXTRA_BIN_DIRS]));
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
  const merged = Array.from(new Set([managedBinDir(), ...(process.env.PATH || "").split(path.delimiter), ...EXTRA_BIN_DIRS]))
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

interface NpmRunner {
  command: string;
  argvPrefix: string[];
  managedRuntime?: ManagedNodeRuntime;
}

const installInFlight = new Map<string, Promise<CliActionResult>>();
let installTail: Promise<void> = Promise.resolve();

function packageSpec(kind: InstallableCli): string {
  const plan = CLI_PLAN[kind];
  return `${plan.pkg}@${plan.version}`;
}

function managedBinDir(): string {
  return process.platform === "win32" ? AGENTLAS_NPM_PREFIX : path.join(AGENTLAS_NPM_PREFIX, "bin");
}

function prependPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const current = (env[pathKey] ?? "").split(path.delimiter).filter(Boolean);
  return { ...env, [pathKey]: [dir, ...current.filter((entry) => entry !== dir)].join(path.delimiter) };
}

function writeNpmBootstrapNodeShim(runtime: ManagedNodeRuntime): void {
  const binDir = AGENTLAS_NPM_BOOTSTRAP_BIN;
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const shim = process.platform === "win32"
    ? path.join(binDir, "node.cmd")
    : path.join(binDir, "node");
  const content = process.platform === "win32"
    ? `@echo off\r\nsetlocal\r\nset "NODE_OPTIONS="\r\n"${runtime.node.replace(/%/g, "%%")}" %*\r\n`
    : `#!/bin/sh\nunset NODE_OPTIONS\nexec '${runtime.node.replace(/'/g, "'\\''")}' "$@"\n`;
  let current = "";
  try {
    current = fs.readFileSync(shim, "utf8");
  } catch {
    // create below
  }
  if (current !== content) fs.writeFileSync(shim, content, { encoding: "utf8", mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(shim, 0o700);
  // Remove the short-lived implementation used by older previews. Leaving a
  // `node.cmd` in the provider CLI prefix would override a project's own Node
  // whenever Agentlas launches an agent process.
  if (process.platform === "win32") {
    fs.rmSync(path.join(AGENTLAS_NPM_PREFIX, "node.cmd"), { force: true });
  }
}

function managedNpmEnv(runtime?: ManagedNodeRuntime): NodeJS.ProcessEnv {
  let env = augmentedEnv();
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (lower === "node_options" || lower.startsWith("npm_config_")) delete env[key];
  }
  fs.mkdirSync(path.dirname(AGENTLAS_NPM_CONFIG), { recursive: true, mode: 0o700 });
  fs.mkdirSync(AGENTLAS_NPM_CACHE, { recursive: true, mode: 0o700 });
  const npmrc = `registry=${OFFICIAL_NPM_REGISTRY}\naudit=false\nfund=false\nupdate-notifier=false\n`;
  if (!fs.existsSync(AGENTLAS_NPM_CONFIG) || fs.readFileSync(AGENTLAS_NPM_CONFIG, "utf8") !== npmrc) {
    fs.writeFileSync(AGENTLAS_NPM_CONFIG, npmrc, { encoding: "utf8", mode: 0o600 });
  }
  if (!fs.existsSync(AGENTLAS_NPM_GLOBAL_CONFIG) || fs.readFileSync(AGENTLAS_NPM_GLOBAL_CONFIG, "utf8") !== npmrc) {
    fs.writeFileSync(AGENTLAS_NPM_GLOBAL_CONFIG, npmrc, { encoding: "utf8", mode: 0o600 });
  }
  env = prependPath(env, managedBinDir());
  if (runtime) {
    writeNpmBootstrapNodeShim(runtime);
    // Only npm and its lifecycle children see the private Node shim. Normal
    // agent/tool processes never receive this bootstrap directory.
    env = prependPath(env, AGENTLAS_NPM_BOOTSTRAP_BIN);
  }
  return {
    ...env,
    NODE_OPTIONS: "",
    NPM_CONFIG_USERCONFIG: AGENTLAS_NPM_CONFIG,
    NPM_CONFIG_GLOBALCONFIG: AGENTLAS_NPM_GLOBAL_CONFIG,
    NPM_CONFIG_CACHE: AGENTLAS_NPM_CACHE,
    NPM_CONFIG_PREFIX: AGENTLAS_NPM_PREFIX,
    NPM_CONFIG_REGISTRY: OFFICIAL_NPM_REGISTRY,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  };
}

function managedPackageRoot(plan: (typeof CLI_PLAN)[InstallableCli]): string {
  return path.join(AGENTLAS_NPM_PREFIX, "node_modules", ...plan.pkg.split("/"));
}

/**
 * Replace npm's PATH-dependent Windows shim with a launcher that calls either
 * the verified native binary or the persistent private Node by absolute path.
 * This keeps provider CLI selection deterministic without changing the Node
 * seen by projects, MCP servers, or tools spawned by that CLI.
 */
function writeManagedWindowsCliLauncher(
  kind: InstallableCli,
  runtime: ManagedNodeRuntime,
): { ok: true; launcher: string } | { ok: false; reason: string } {
  if (process.platform !== "win32") {
    const launcher = managedBinary(CLI_PLAN[kind].bin);
    return launcher ? { ok: true, launcher } : { ok: false, reason: "managed CLI launcher is missing" };
  }
  const plan = CLI_PLAN[kind];
  const packageRoot = managedPackageRoot(plan);
  const packageJsonPath = path.join(packageRoot, "package.json");
  try {
    const prefixReal = fs.realpathSync(AGENTLAS_NPM_PREFIX);
    const packageRootReal = fs.realpathSync(packageRoot);
    const packageStat = fs.lstatSync(packageRoot);
    const packageJsonStat = fs.lstatSync(packageJsonPath);
    if (
      !packageStat.isDirectory() || packageStat.isSymbolicLink() ||
      !packageJsonStat.isFile() || packageJsonStat.isSymbolicLink() ||
      !isPathWithin(packageRootReal, prefixReal)
    ) {
      return { ok: false, reason: "managed CLI package escapes its private prefix" };
    }
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
      bin?: unknown;
    };
    if (pkg.name !== plan.pkg || pkg.version !== plan.version) {
      return { ok: false, reason: "managed CLI package identity does not match the release pin" };
    }
    const binRelative = typeof pkg.bin === "string"
      ? pkg.bin
      : pkg.bin && typeof pkg.bin === "object" && !Array.isArray(pkg.bin)
        ? (pkg.bin as Record<string, unknown>)[plan.bin]
        : null;
    if (typeof binRelative !== "string" || !binRelative || path.isAbsolute(binRelative)) {
      return { ok: false, reason: "managed CLI package has no valid launcher entry" };
    }
    const target = path.resolve(packageRoot, ...binRelative.replace(/\\/g, "/").split("/"));
    const targetStat = fs.lstatSync(target);
    const targetReal = fs.realpathSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || !isPathWithin(targetReal, packageRootReal)) {
      return { ok: false, reason: "managed CLI launcher entry escapes its package" };
    }
    const head = Buffer.alloc(256);
    const handle = fs.openSync(target, "r");
    let headLength = 0;
    try {
      headLength = fs.readSync(handle, head, 0, head.length, 0);
    } finally {
      fs.closeSync(handle);
    }
    const launcherHead = head.subarray(0, headLength);
    const nativeWindowsBinary = launcherHead.length >= 2 && launcherHead[0] === 0x4d && launcherHead[1] === 0x5a;
    if (!nativeWindowsBinary && !launcherHead.toString("utf8").startsWith("#!/usr/bin/env node")) {
      return { ok: false, reason: "managed CLI launcher is neither a Windows binary nor a Node entrypoint" };
    }
    const escapeCmdPath = (value: string) => value.replace(/%/g, "%%");
    const invocation = nativeWindowsBinary
      ? `"${escapeCmdPath(targetReal)}" %*`
      : `"${escapeCmdPath(runtime.node)}" "${escapeCmdPath(targetReal)}" %*`;
    const launcher = path.join(AGENTLAS_NPM_PREFIX, `${plan.bin}.cmd`);
    fs.writeFileSync(
      launcher,
      `@echo off\r\nsetlocal\r\nset "NODE_OPTIONS="\r\n${invocation}\r\n`,
      { encoding: "utf8", mode: 0o700 },
    );
    return { ok: true, launcher };
  } catch {
    return { ok: false, reason: "managed CLI launcher could not be verified and stabilized" };
  }
}

function resolveNpmRunner(): { ok: true; runner: NpmRunner } | { ok: false; reason: string } {
  // The Windows package always carries this verified private runtime. Prefer it
  // over a user/system npm so Connect is reproducible and never needs UAC.
  if (process.platform === "win32") {
    const bundled = resolveManagedNodeRuntime();
    if (bundled.ok) {
      return {
        ok: true,
        runner: {
          command: bundled.runtime.node,
          argvPrefix: [bundled.runtime.npmCli],
          managedRuntime: bundled.runtime,
        },
      };
    }
    const external = resolveBinary("npm");
    if (external) return { ok: true, runner: { command: external, argvPrefix: [] } };
    return {
      ok: false,
      reason: `Agentlas managed Node runtime is unavailable (${bundled.reason}). Reinstall or update Agentlas Desktop.`,
    };
  }
  const external = resolveBinary("npm");
  if (external) return { ok: true, runner: { command: external, argvPrefix: [] } };
  return { ok: false, reason: "npm was not found on this system" };
}

function managedBinary(name: string): string | null {
  const candidates = process.platform === "win32"
    ? [path.join(AGENTLAS_NPM_PREFIX, `${name}.cmd`), path.join(AGENTLAS_NPM_PREFIX, `${name}.exe`)]
    : [path.join(AGENTLAS_NPM_PREFIX, "bin", name)];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

function appendTail(current: string, chunk: Buffer, limit = 65_536): string {
  const next = current + chunk.toString("utf8");
  return next.length <= limit ? next : next.slice(-limit);
}

async function installCliUnlocked(
  kind: InstallableCli,
  opts?: { force?: boolean },
): Promise<CliActionResult> {
  const plan = CLI_PLAN[kind];
  const spec = packageSpec(kind);
  const command = `npm install -g ${spec} --prefix ${AGENTLAS_NPM_PREFIX}`;
  const fallbackCommand = process.platform === "win32" ? undefined : command;

  const existing = resolveBinary(plan.bin);
  if (existing && !opts?.force) {
    const verified = await runBinary(existing, ["--version"], 20_000);
    if (verified.ok) return { ok: true, message: `already installed: ${existing}` };
  }

  const npm = resolveNpmRunner();
  if (!npm.ok) return { ok: false, message: npm.reason, command: fallbackCommand };
  const env = managedNpmEnv(npm.runner.managedRuntime);
  fs.mkdirSync(AGENTLAS_NPM_PREFIX, { recursive: true, mode: 0o700 });
  const args = [
    ...npm.runner.argvPrefix,
    "install",
    "--global",
    spec,
    "--prefix",
    AGENTLAS_NPM_PREFIX,
    "--registry",
    OFFICIAL_NPM_REGISTRY,
    "--userconfig",
    AGENTLAS_NPM_CONFIG,
    "--globalconfig",
    AGENTLAS_NPM_GLOBAL_CONFIG,
    "--no-audit",
    "--no-fund",
  ];

  const installed = await new Promise<CliActionResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let outputTail = "";
    const done = (result: CliActionResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(npm.runner.command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        windowsHide: true,
      });
    } catch (error) {
      done({ ok: false, message: error instanceof Error ? error.message : String(error), command: fallbackCommand });
      return;
    }
    timer = setTimeout(() => {
      try {
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        } else {
          child.kill();
        }
      } catch {
        // Process already exited.
      }
      done({ ok: false, message: "CLI installation timed out after 5 minutes", command: fallbackCommand });
    }, 5 * 60 * 1_000);
    child.stdout?.on("data", (chunk: Buffer) => { outputTail = appendTail(outputTail, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { outputTail = appendTail(outputTail, chunk); });
    child.on("error", (error) => done({ ok: false, message: `CLI installer failed to start: ${error.message}`, command: fallbackCommand }));
    child.on("close", (code) => {
      // Do not expose raw npm output: proxy URLs and local paths can contain secrets.
      void outputTail;
      done(code === 0
        ? { ok: true, message: "CLI package installed" }
        : { ok: false, message: `CLI package installation failed (exit ${code ?? "unknown"})`, command: fallbackCommand });
    });
  });
  if (!installed.ok) return installed;

  let binary = managedBinary(plan.bin);
  if (process.platform === "win32" && npm.runner.managedRuntime) {
    const stabilized = writeManagedWindowsCliLauncher(kind, npm.runner.managedRuntime);
    if (!stabilized.ok) {
      return { ok: false, message: stabilized.reason, command: fallbackCommand };
    }
    binary = stabilized.launcher;
  }
  if (!binary) return { ok: false, message: "CLI installation finished but its launcher is missing", command: fallbackCommand };
  const verified = await runBinary(binary, ["--version"], 20_000, env);
  if (!verified.ok) {
    return { ok: false, message: "CLI launcher failed post-install verification", command: fallbackCommand };
  }
  return { ok: true, message: `installed and verified: ${binary}` };
}

/** Single-flight, no-admin install into Agentlas's private user prefix. */
export function installCli(
  kind: InstallableCli,
  opts?: { force?: boolean },
): Promise<CliActionResult> {
  const plan = CLI_PLAN[kind];
  if (!plan) return Promise.resolve({ ok: false, message: `Unknown CLI: ${kind}` });
  const key = `${kind}:${opts?.force ? "force" : "normal"}`;
  const running = installInFlight.get(key);
  if (running) return running;
  const task = installTail
    .then(() => installCliUnlocked(kind, opts))
    .catch((): CliActionResult => ({
      ok: false,
      message: "CLI installation failed before verification",
      command: process.platform === "win32"
        ? undefined
        : `npm install -g ${packageSpec(kind)} --prefix ${AGENTLAS_NPM_PREFIX}`,
    }));
  installTail = task.then(() => undefined, () => undefined);
  installInFlight.set(key, task);
  void task.then(
    () => { if (installInFlight.get(key) === task) installInFlight.delete(key); },
    () => { if (installInFlight.get(key) === task) installInFlight.delete(key); },
  );
  return task;
}

/** 바이너리를 헤드리스로 실행하고 결과를 모은다 (self-updater 실행용). */
function runBinary(
  bin: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = augmentedEnv(),
): Promise<CliActionResult> {
  const command = `${path.basename(bin)} ${args.join(" ")}`;
  return new Promise<CliActionResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (r: CliActionResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    let out = "";
    let err = "";
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
    } catch (e) {
      done({ ok: false, message: e instanceof Error ? e.message : String(e), command });
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      done({ ok: false, message: `timed out after ${Math.round(timeoutMs / 60000)} min`, command });
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => { out = appendTail(out, c); });
    child.stderr?.on("data", (c: Buffer) => { err = appendTail(err, c); });
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
  return installCli("gemini", { force: true });
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
 *   · grok → 공식 self-updater `grok update`
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
  if (kind === "grok") return runBinary(existing, ["update"], 2 * 60 * 1000);
  return Promise.resolve({ ok: true, message: `self-managed install: ${existing} — update skipped` });
}

/**
 * 시스템 터미널에서 CLI 로그인 명령을 연다 — 사용자는 거기서 브라우저 로그인만 하면 된다.
 * loginArgs는 고정값이라 Renderer 입력이 셸로 들어가지 않는다.
 *
 * 함정 2개를 여기서 막는다:
 *  · CLI가 정말 없으면(설치 실패) 터미널을 열지 않는다 — "command not found" 경험 금지.
 *  · 앱이 설치한 CLI(~/.agentlas/npm/bin 등)는 사용자 셸 PATH에 없을 수 있다 →
 *    bare 이름 대신 절대경로로 실행한다.
 */
export function openCliLogin(kind: InstallableCli): CliActionResult {
  const plan = CLI_PLAN[kind];
  if (!plan) return { ok: false, message: `Unknown CLI: ${kind}` };
  const loginArgs = plan.loginArgs;
  // 실제 실행 순서와 동일하게 공식 Gemini를 먼저 열고, 없는 기존 머신에서만 agy로 폴백한다.
  let abs =
    kind === "gemini" ? (resolveBinary("gemini") ?? resolveBinary("agy")) : resolveBinary(plan.bin);
  if (!abs) {
    // 설치가 안 된 상태로 터미널부터 여는 건 금지 — 렌더러가 이 메시지로 실패를 표면화한다.
    return {
      ok: false,
      message: `${plan.bin} is not installed`,
      command: process.platform === "win32"
        ? undefined
        : `npm install -g ${packageSpec(kind)} --prefix ${AGENTLAS_NPM_PREFIX}`,
    };
  }
  const selectedBase = path.basename(abs).replace(/\.(?:cmd|exe)$/i, "").toLowerCase();
  if (
    process.platform === "win32" &&
    isAgentlasManagedNpmBinary(abs) &&
    selectedBase === plan.bin.toLowerCase()
  ) {
    const managedNode = resolveManagedNodeRuntime();
    if (!managedNode.ok) {
      return { ok: false, message: managedNode.reason };
    }
    const stabilized = writeManagedWindowsCliLauncher(kind, managedNode.runtime);
    if (!stabilized.ok) return { ok: false, message: stabilized.reason };
    abs = stabilized.launcher;
  }
  // 절대경로 실행 — 셸 PATH 무관. 경로 공백/특수문자는 플랫폼별로 인용.
  // 터미널만 덜렁 뜨면 사용자가 뭘 해야 하는지 모른다 — 안내 한 줄을 먼저 찍는다.
  const guide =
    "== Agentlas: complete the login below (a browser window may open). When it says you are logged in, close this window. / 아래에서 로그인을 완료하세요(브라우저 창이 뜰 수 있습니다). 완료되면 이 창을 닫으면 됩니다. ==";
  const runCmd = [`'${abs.replace(/'/g, "'\\''")}'`, ...loginArgs].join(" ");
  const managedPath = managedBinDir().replace(/'/g, "'\\''");
  const posixPath = isAgentlasManagedNpmBinary(abs) ? `export PATH='${managedPath}':$PATH; ` : "";
  const posixCmd = `${posixPath}echo '${guide}'; ${runCmd}`;
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
      // PowerShell is built into supported Windows versions. Spawn it directly
      // (no shell:true/cmd string composition), keep the terminal visible, and
      // prepend only Agentlas's private launcher directory to this child PATH.
      const systemPowerShell = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const powershell = resolveBinary("pwsh") ?? resolveBinary("powershell")
        ?? (fs.existsSync(systemPowerShell) ? systemPowerShell : null);
      if (!powershell) {
        return { ok: false, message: "Windows PowerShell was not found", command: `${plan.bin} ${loginArgs.join(" ")}`.trim() };
      }
      const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
      const psCommand = [
        `Write-Host ${psQuote(guide)}`,
        `& ${psQuote(abs)} ${loginArgs.map(psQuote).join(" ")}`.trim(),
      ].join("; ");
      const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NoExit", "-Command", psCommand], {
        detached: true,
        env: prependPath(augmentedEnv(), managedBinDir()),
        stdio: "ignore",
        windowsHide: false,
      });
      child.unref();
    } else {
      // Linux best-effort — 대표 터미널 에뮬레이터.
      spawn("x-terminal-emulator", ["-e", [abs, ...loginArgs].join(" ")]);
    }
    return { ok: true, message: [abs, ...loginArgs].join(" ") };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      command: `${plan.bin} ${loginArgs.join(" ")}`.trim(),
    };
  }
}
