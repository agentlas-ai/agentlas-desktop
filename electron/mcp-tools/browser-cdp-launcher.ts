// Agentlas Browser (CDP) 플러그인 런처 소스.
//
// 범용 브라우저 MCP 플러그인 — 특정 사이트/계정과 무관하다. 사용자가 직접 로그인한 Agentlas
// 전용 Chrome 프로필을 원격 디버깅 포트로 띄우고, @playwright/mcp 를 그 인스턴스에 CDP 로 붙여
// 표준 브라우저 도구(navigate/click/type/snapshot/evaluate…)를 제공한다.
//
// 왜: Playwright 기본(신선/빈 프로필)은 많은 사이트의 봇/네트워크 보안에 하드 차단된다.
// 전용 프로필의 실제 Chrome 로그인 세션을 CDP로 재사용하면 신선한 임시 프로필보다 안정적이다.
//
// 개인정보는 플러그인 패키지에 절대 들어가지 않는다. 평소 쓰는 Chrome 프로필을 복사하지 않으며,
// 사용자가 전용 창에서 직접 로그인한 세션만 ~/.agentlas/chrome-cdp-profile 안에 남는다.
//
// 이 파일은 문자열 소스를 ~/.agentlas/agentlas-browser-cdp.mjs 로 물질화(materialize)한다.
// catalog 엔트리가 `node ~/.agentlas/agentlas-browser-cdp.mjs` 로 실행한다(의존성 0, 순수 node).
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { BROWSER_APPROVAL_FILE_ENV } from "../browser/approval-channel";
import {
  legacySystemBrowserExecutableCandidates,
  resolveAgentlasBrowserRuntime,
  resolveAgentlasBrowserRuntimeExecutable,
} from "../browser/runtime";

export const BROWSER_CDP_LAUNCHER_BASENAME = "agentlas-browser-cdp.mjs";

/** Exact bundled Playwright MCP entrypoint; never resolve or download at run time. */
export function playwrightMcpCliPath(): string {
  return path.join(path.dirname(require.resolve("@playwright/mcp")), "cli.js");
}

/** ~/.agentlas/agentlas-browser-cdp.mjs 절대 경로. */
export function browserCdpLauncherPath(): string {
  return path.join(os.homedir(), ".agentlas", BROWSER_CDP_LAUNCHER_BASENAME);
}

/** 전용 CDP 크롬 프로필 경로(MCP 런처와 로그인 창이 공유). */
export function browserCdpProfilePath(): string {
  return process.env.AGENTLAS_CDP_PROFILE || path.join(os.homedir(), ".agentlas", "chrome-cdp-profile");
}

/** Agentlas 전용 CDP Chrome 소유 표식. 임의의 기존 9222 프로세스에 붙지 않기 위한 로컬 증거. */
export function browserCdpOwnerPath(): string {
  return path.join(browserCdpProfilePath(), ".agentlas-cdp-owner.json");
}

export const BROWSER_CDP_LEASE_DIRNAME = ".agentlas-cdp-leases";
export const BROWSER_CDP_SHUTDOWN_LOCK_BASENAME = ".agentlas-cdp-shutdown-lock";
export const BROWSER_CDP_LAUNCH_LOCK_BASENAME = ".agentlas-cdp-launch-lock";
export const BROWSER_CDP_BACKOFF_BASENAME = ".agentlas-cdp-backoff.json";
export const BROWSER_CDP_RESOURCE_LIMITS = Object.freeze({
  activeTasks: 8,
  pages: 24,
  renderers: 32,
  rssBytes: 4 * 1024 * 1024 * 1024,
  backoffMs: 30_000,
});

export interface BrowserCdpLease {
  file: string;
  kind: string;
  pid: number;
}

/** Cross-process leases keep a shared browser alive only while a real consumer needs it. */
export function browserCdpLeaseDirectory(): string {
  return path.join(browserCdpProfilePath(), BROWSER_CDP_LEASE_DIRNAME);
}

export function browserCdpShutdownLockPath(): string {
  return path.join(browserCdpProfilePath(), BROWSER_CDP_SHUTDOWN_LOCK_BASENAME);
}

export function browserCdpBackoffPath(): string {
  return path.join(browserCdpProfilePath(), BROWSER_CDP_BACKOFF_BASENAME);
}

export function ensureBrowserCdpProfilePrivate(): string {
  const profile = browserCdpProfilePath();
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(profile, 0o700); } catch { /* best-effort on non-POSIX filesystems */ }
  return profile;
}

export interface BrowserCdpOwnerRecord {
  pid: number;
  port: number;
  profile: string;
}

export interface BrowserCdpProcessSnapshot {
  pid: number;
  executable: string;
  commandLine: string;
  loopbackOnly: boolean;
}

export type BrowserCdpOwnershipState = "absent" | "owned" | "adoptable" | "foreign" | "unverifiable";

export interface BrowserCdpOwnership {
  state: BrowserCdpOwnershipState;
  pid: number | null;
  reason: string;
  adopted?: boolean;
}

export interface BrowserCdpOwnershipRetryOptions {
  attempts?: number;
  delayMs?: number;
  reconcile?: () => Promise<BrowserCdpOwnership>;
  sleep?: (delayMs: number) => Promise<void>;
}

function canonicalProfilePath(value: string, platform = process.platform): string {
  if (platform === "win32") {
    return path.win32.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
  }
  return path.resolve(value).replace(/\/+$/, "");
}

/** Extract an equals-form browser switch without splitting profile paths that contain spaces. */
export function browserCdpCommandFlag(commandLine: string, flag: string): string | null {
  const marker = `--${flag}=`;
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const switchMatches = [...commandLine.matchAll(new RegExp(`(?:^|\\s)--${escapedFlag}=`, "g"))];
  if (switchMatches.length !== 1) return null;
  const switchMatch = switchMatches[0];
  const markerOffset = switchMatch[0].lastIndexOf(marker);
  const valueStart = switchMatch.index + markerOffset + marker.length;
  const rest = commandLine.slice(valueStart);
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    return end >= 0 ? rest.slice(1, end) : null;
  }
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    return end >= 0 ? rest.slice(1, end) : null;
  }
  const nextSwitch = rest.search(/\s+--[a-z0-9][a-z0-9-]*(?:=|\s|$)/i);
  const value = (nextSwitch >= 0 ? rest.slice(0, nextSwitch) : rest.split(/\s+/u, 1)[0]).trim();
  return value || null;
}

export function browserCdpExecutableCandidates(
  platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dedicated = platform === process.platform ? resolveAgentlasBrowserRuntimeExecutable() : null;
  return [
    ...(dedicated ? [dedicated] : []),
    // Legacy paths are identification-only so an old Agentlas process can be
    // migrated safely. resolveChromeExe() never chooses one for a new launch.
    ...legacySystemBrowserExecutableCandidates(platform, home, env),
  ];
}

export function browserCdpExecutableAllowed(
  executable: string,
  platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const actual = canonicalProfilePath(executable, platform);
  const allowed = new Set<string>();
  for (const candidate of browserCdpExecutableCandidates(platform, home, env)) {
    allowed.add(canonicalProfilePath(candidate, platform));
    try { allowed.add(canonicalProfilePath(fs.realpathSync(candidate), platform)); } catch { /* not installed here */ }
  }
  if (allowed.has(actual)) return true;
  return platform === "linux" && /^\/snap\/chromium\/(?:current|\d+)\/usr\/lib\/chromium(?:-browser)?\/(?:chrome|chromium)$/u.test(actual);
}

export function browserCdpProcessMatches(
  snapshot: BrowserCdpProcessSnapshot,
  profile = browserCdpProfilePath(),
  port = browserCdpPort(),
  platform = process.platform,
): boolean {
  if (!Number.isInteger(snapshot.pid) || snapshot.pid <= 0) return false;
  if (snapshot.loopbackOnly !== true) return false;
  if (!browserCdpExecutableAllowed(snapshot.executable, platform)) return false;
  const commandProfile = browserCdpCommandFlag(snapshot.commandLine, "user-data-dir");
  const commandPort = browserCdpCommandFlag(snapshot.commandLine, "remote-debugging-port");
  if (!commandProfile || !commandPort || !/^\d+$/u.test(commandPort)) return false;
  return (
    canonicalProfilePath(commandProfile, platform) === canonicalProfilePath(profile, platform) &&
    Number(commandPort) === port
  );
}

export function classifyBrowserCdpOwnership(input: {
  processes: BrowserCdpProcessSnapshot[];
  marker: BrowserCdpOwnerRecord | null;
  profile: string;
  port: number;
  platform?: NodeJS.Platform;
}): BrowserCdpOwnership {
  if (input.processes.length === 0) {
    return { state: "absent", pid: null, reason: "no-listener" };
  }
  if (input.processes.length !== 1) {
    return { state: "foreign", pid: null, reason: "ambiguous-listeners" };
  }
  const listener = input.processes[0];
  if (!browserCdpProcessMatches(listener, input.profile, input.port, input.platform ?? process.platform)) {
    return { state: "foreign", pid: listener.pid, reason: "listener-command-mismatch" };
  }
  const marker = input.marker;
  const markerMatches = Boolean(
    marker &&
      marker.pid === listener.pid &&
      marker.port === input.port &&
      canonicalProfilePath(marker.profile, input.platform ?? process.platform) ===
        canonicalProfilePath(input.profile, input.platform ?? process.platform),
  );
  return markerMatches
    ? { state: "owned", pid: listener.pid, reason: "listener-and-marker-match" }
    : { state: "adoptable", pid: listener.pid, reason: "verified-dedicated-listener" };
}

export function writeBrowserCdpOwner(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  ensureBrowserCdpProfilePrivate();
  const file = browserCdpOwnerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(
      temp,
      JSON.stringify({ pid, port: browserCdpPort(), profile: path.resolve(browserCdpProfilePath()) }),
      { encoding: "utf8", mode: 0o600 },
    );
    try { fs.chmodSync(temp, 0o600); } catch { /* best-effort */ }
    fs.renameSync(temp, file);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best-effort */ }
  }
}

export function clearBrowserCdpOwner(pid: number): void {
  const file = browserCdpOwnerPath();
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number };
    if (owner.pid === pid) fs.rmSync(file, { force: true });
  } catch {
    // A missing/corrupt marker is not ownership proof. Do not unlink here: an
    // atomic concurrent writer may have just replaced it after this read failed.
  }
}

function browserCdpProcessIsLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function clearStaleBrowserCdpShutdownLock(): boolean {
  const lock = browserCdpShutdownLockPath();
  if (!fs.existsSync(lock)) return true;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")) as { pid?: number };
    if (browserCdpProcessIsLive(Number(record.pid))) return false;
  } catch {
    // mkdir and owner.json creation are two operations. Do not steal a lock
    // during that tiny initialization window; only an older unreadable lock is stale.
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < 5_000) return false;
    } catch { /* continue with stale cleanup */ }
  }
  try { fs.rmSync(path.join(lock, "owner.json"), { force: true }); } catch { /* best-effort */ }
  try { fs.rmdirSync(lock); } catch { return !fs.existsSync(lock); }
  return true;
}

async function waitForBrowserCdpShutdownLock(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(browserCdpShutdownLockPath()) && Date.now() < deadline) {
    if (clearStaleBrowserCdpShutdownLock()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  if (fs.existsSync(browserCdpShutdownLockPath()) && !clearStaleBrowserCdpShutdownLock()) {
    throw new Error("Agentlas dedicated browser shutdown is still in progress.");
  }
}

async function acquireBrowserCdpShutdownLock(timeoutMs = 15_000): Promise<boolean> {
  ensureBrowserCdpProfilePrivate();
  const lock = browserCdpShutdownLockPath();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try {
        fs.writeFileSync(
          path.join(lock, "owner.json"),
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
          { encoding: "utf8", mode: 0o600 },
        );
      } catch (error) {
        try { fs.rmdirSync(lock); } catch { /* best-effort */ }
        throw error;
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      if (clearStaleBrowserCdpShutdownLock()) continue;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  return false;
}

function releaseBrowserCdpShutdownLock(): void {
  const lock = browserCdpShutdownLockPath();
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")) as { pid?: number };
    if (Number(owner.pid) !== process.pid) return;
  } catch {
    return;
  }
  try { fs.rmSync(path.join(lock, "owner.json"), { force: true }); } catch { /* best-effort */ }
  try { fs.rmdirSync(lock); } catch { /* best-effort */ }
}

/** Remove dead/invalid lease rows and return the live consumer count. */
export function pruneBrowserCdpLeases(): number {
  const dir = browserCdpLeaseDirectory();
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return 0; }
  let live = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(dir, entry);
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number };
      if (browserCdpProcessIsLive(Number(record.pid))) {
        live += 1;
        continue;
      }
    } catch {
      // Invalid lease rows are stale by definition.
    }
    try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
  }
  return live;
}

/** Acquire before touching CDP so an idle reaper cannot close the browser mid-start. */
export async function acquireBrowserCdpLease(kind: string): Promise<BrowserCdpLease> {
  ensureBrowserCdpProfilePrivate();
  const dir = browserCdpLeaseDirectory();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best-effort */ }
  const safeKind = kind.replace(/[^a-z0-9._-]/giu, "-").slice(0, 48) || "consumer";
  let file = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    file = path.join(dir, `${safeKind}-${token}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, kind: safeKind, createdAt: Date.now() }), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 7) throw error;
    }
  }
  try {
    await waitForBrowserCdpShutdownLock();
  } catch (error) {
    try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
    throw error;
  }
  return { file, kind: safeKind, pid: process.pid };
}

export function scheduleBrowserCdpIdleShutdown(): boolean {
  if (process.env.AGENTLAS_CDP_DISABLE_REAPER === "1") return false;
  const launcher = browserCdpLauncherPath();
  if (!fs.existsSync(launcher)) return false;
  try {
    const child = spawn(process.execPath, [launcher, "--agentlas-cdp-reap"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, AGENTLAS_CDP_AUTO_STOP: "1", ELECTRON_RUN_AS_NODE: "1" },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Detached watcher closes the exact-profile browser if its owning host is force-killed. */
export function scheduleBrowserCdpGuardian(browserPid: number, ownerPid = process.pid): boolean {
  if (!Number.isInteger(browserPid) || browserPid <= 0 || !Number.isInteger(ownerPid) || ownerPid <= 0) return false;
  const launcher = browserCdpLauncherPath();
  if (!fs.existsSync(launcher)) return false;
  try {
    const child = spawn(
      process.execPath,
      [launcher, "--agentlas-cdp-guard", String(browserPid), String(ownerPid)],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Release is idempotent and only removes a lease inside the dedicated lease directory. */
export function releaseBrowserCdpLease(
  lease: BrowserCdpLease | null | undefined,
  options: { scheduleShutdown?: boolean } = {},
): void {
  if (!lease) return;
  const leaseDir = path.resolve(browserCdpLeaseDirectory());
  const file = path.resolve(lease.file);
  if (path.dirname(file) !== leaseDir || lease.pid !== process.pid) return;
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number };
    if (Number(record.pid) === lease.pid) fs.rmSync(file, { force: true });
  } catch {
    // Already released or replaced; never remove a path without matching ownership.
  }
  if (options.scheduleShutdown !== false) scheduleBrowserCdpIdleShutdown();
}

function readBrowserCdpOwner(): BrowserCdpOwnerRecord | null {
  try {
    const owner = JSON.parse(fs.readFileSync(browserCdpOwnerPath(), "utf8")) as Partial<BrowserCdpOwnerRecord>;
    if (
      !Number.isInteger(owner.pid) ||
      Number(owner.pid) <= 0 ||
      !Number.isInteger(owner.port) ||
      typeof owner.profile !== "string"
    ) return null;
    return { pid: Number(owner.pid), port: Number(owner.port), profile: owner.profile };
  } catch {
    return null;
  }
}

function execFileText(executable: string, args: string[], allowedExitCodes: number[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { encoding: "utf8", timeout: 3_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || (error as { killed?: boolean }).killed) return reject(error);
          if (!allowedExitCodes.includes(Number(code))) return reject(error);
        }
        resolve(stdout);
      },
    );
  });
}

function uniquePositivePids(values: number[]): number[] {
  return [...new Set(values.filter((pid) => Number.isInteger(pid) && pid > 0))];
}

async function inspectDarwinCdpProcesses(port: number): Promise<BrowserCdpProcessSnapshot[]> {
  const listenerOutput = await execFileText("/usr/sbin/lsof", [
    "-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn",
  ], [1]);
  const addressesByPid = new Map<number, string[]>();
  let currentPid: number | null = null;
  for (const line of listenerOutput.split(/\r?\n/u)) {
    if (/^p\d+$/u.test(line)) {
      currentPid = Number(line.slice(1));
      if (!addressesByPid.has(currentPid)) addressesByPid.set(currentPid, []);
    } else if (currentPid && line.startsWith("n")) {
      addressesByPid.get(currentPid)?.push(line.slice(1));
    }
  }
  const pids = uniquePositivePids([...addressesByPid.keys()]);
  const snapshots: BrowserCdpProcessSnapshot[] = [];
  for (const pid of pids) {
    const [commandLine, textFiles] = await Promise.all([
      execFileText("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="]),
      execFileText("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"]),
    ]);
    const executable = textFiles.split(/\r?\n/u).find((line) => line.startsWith("n"))?.slice(1) ?? "";
    const addresses = addressesByPid.get(pid) ?? [];
    const loopbackOnly = addresses.length > 0 && addresses.every((address) =>
      address === `127.0.0.1:${port}` || address === `[::1]:${port}` || address === `::1:${port}`,
    );
    snapshots.push({ pid, executable, commandLine: commandLine.trim(), loopbackOnly });
  }
  return snapshots;
}

function linuxListenerInodes(port: number): Map<string, boolean> {
  const wantedPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Map<string, boolean>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let source = "";
    try { source = fs.readFileSync(table, "utf8"); } catch { continue; }
    for (const line of source.split(/\r?\n/u).slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 10 || fields[3] !== "0A") continue;
      const localPort = fields[1]?.split(":").pop()?.toUpperCase();
      if (localPort === wantedPort && fields[9]) {
        const host = fields[1]?.split(":")[0]?.toUpperCase();
        const loopback = host === "0100007F" || host === "00000000000000000000000001000000";
        inodes.set(fields[9], loopback);
      }
    }
  }
  return inodes;
}

function linuxListenerPids(port: number): Array<{ pid: number; loopbackOnly: boolean }> {
  const inodes = linuxListenerInodes(port);
  if (inodes.size === 0) return [];
  const pids = new Map<number, boolean>();
  let entries: string[] = [];
  try { entries = fs.readdirSync("/proc"); } catch { return []; }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    try {
      if (typeof process.getuid === "function" && fs.statSync(`/proc/${pid}`).uid !== process.getuid()) continue;
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        const inode = target.match(/^socket:\[(\d+)\]$/u)?.[1];
        if (inode && inodes.has(inode)) {
          pids.set(pid, (pids.get(pid) ?? true) && inodes.get(inode) === true);
        }
      }
    } catch {
      // Process exited or a protected fd disappeared while inspecting it.
    }
  }
  return uniquePositivePids([...pids.keys()]).map((pid) => ({ pid, loopbackOnly: pids.get(pid) === true }));
}

async function inspectLinuxCdpProcesses(port: number): Promise<BrowserCdpProcessSnapshot[]> {
  const snapshots: BrowserCdpProcessSnapshot[] = [];
  for (const { pid, loopbackOnly } of linuxListenerPids(port)) {
    try {
      const executable = fs.readlinkSync(`/proc/${pid}/exe`);
      const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      snapshots.push({ pid, executable, commandLine, loopbackOnly });
    } catch {
      // Listener changed during inspection; the caller will retry/fail closed.
    }
  }
  return snapshots;
}

async function inspectWindowsCdpProcesses(port: number): Promise<BrowserCdpProcessSnapshot[]> {
  const script = [
    `$connections = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop)`,
    "$rows = @($connections | Group-Object OwningProcess | ForEach-Object { $pidValue = [int]$_.Name; $p = Get-CimInstance Win32_Process -Filter \"ProcessId = $pidValue\"; $addresses = @($_.Group | Select-Object -ExpandProperty LocalAddress -Unique); $nonLoopback = @($addresses | Where-Object { $_ -ne '127.0.0.1' -and $_ -ne '::1' }); if ($p) { [pscustomobject]@{ pid = [int]$p.ProcessId; executable = [string]$p.ExecutablePath; commandLine = [string]$p.CommandLine; loopbackOnly = [bool]($addresses.Count -gt 0 -and $nonLoopback.Count -eq 0) } } })",
    "$rows | ConvertTo-Json -Compress",
  ].join("; ");
  const stdout = await execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout) as BrowserCdpProcessSnapshot | BrowserCdpProcessSnapshot[];
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((row) => Number.isInteger(row.pid));
}

export async function inspectBrowserCdpProcesses(port = browserCdpPort()): Promise<BrowserCdpProcessSnapshot[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid CDP port.");
  if (process.platform === "darwin") return inspectDarwinCdpProcesses(port);
  if (process.platform === "win32") return inspectWindowsCdpProcesses(port);
  if (process.platform === "linux") return inspectLinuxCdpProcesses(port);
  throw new Error(`CDP listener ownership inspection is unsupported on ${process.platform}.`);
}

/**
 * Match a browser root by Agentlas' exact profile marker. Unlike listener
 * ownership this deliberately does not require a live CDP socket: crashed or
 * half-started browser roots can still hold SingletonLock and cookie SQLite.
 */
export function browserCdpProfileRootMatches(
  snapshot: Pick<BrowserCdpProcessSnapshot, "pid" | "executable" | "commandLine">,
  profile = browserCdpProfilePath(),
  port = browserCdpPort(),
  platform = process.platform,
): boolean {
  if (!Number.isInteger(snapshot.pid) || snapshot.pid <= 0) return false;
  if (!browserCdpExecutableAllowed(snapshot.executable, platform)) return false;
  const commandProfile = browserCdpCommandFlag(snapshot.commandLine, "user-data-dir");
  const commandPort = browserCdpCommandFlag(snapshot.commandLine, "remote-debugging-port");
  return Boolean(
    commandProfile
    && commandPort
    && /^\d+$/u.test(commandPort)
    && canonicalProfilePath(commandProfile, platform) === canonicalProfilePath(profile, platform)
    && Number(commandPort) === port,
  );
}

function executableAtCommandStart(commandLine: string): string {
  const candidates = browserCdpExecutableCandidates().sort((left, right) => right.length - left.length);
  for (const candidate of candidates) {
    if (commandLine === candidate || commandLine.startsWith(`${candidate} `)) return candidate;
    if (commandLine.startsWith(`"${candidate}" `)) return candidate;
  }
  return "";
}

/** Inspect every browser root carrying the exact Agentlas profile+port marker. */
export async function inspectBrowserCdpProfileRoots(): Promise<BrowserCdpProcessSnapshot[]> {
  const rows: BrowserCdpProcessSnapshot[] = [];
  if (process.platform === "darwin") {
    const output = await execFileText("/bin/ps", ["-axo", "pid=,command="]);
    for (const line of output.split(/\r?\n/u)) {
      const match = line.match(/^\s*(\d+)\s+([\s\S]+)$/u);
      if (!match) continue;
      const commandLine = match[2];
      const snapshot = {
        pid: Number(match[1]),
        executable: executableAtCommandStart(commandLine),
        commandLine,
        loopbackOnly: true,
      };
      if (browserCdpProfileRootMatches(snapshot)) rows.push(snapshot);
    }
    return rows;
  }
  if (process.platform === "win32") {
    const script = [
      "$rows = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir=') } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; executable = [string]$_.ExecutablePath; commandLine = [string]$_.CommandLine; loopbackOnly = $true } })",
      "$rows | ConvertTo-Json -Compress",
    ].join("; ");
    const output = await execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (!output.trim()) return [];
    const parsed = JSON.parse(output) as BrowserCdpProcessSnapshot | BrowserCdpProcessSnapshot[];
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((row) => browserCdpProfileRootMatches(row));
  }
  if (process.platform === "linux") {
    let entries: string[] = [];
    try { entries = fs.readdirSync("/proc"); } catch { return []; }
    for (const entry of entries) {
      if (!/^\d+$/u.test(entry)) continue;
      try {
        const pid = Number(entry);
        if (typeof process.getuid === "function" && fs.statSync(`/proc/${pid}`).uid !== process.getuid()) continue;
        const snapshot = {
          pid,
          executable: fs.readlinkSync(`/proc/${pid}/exe`),
          commandLine: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "),
          loopbackOnly: true,
        };
        if (browserCdpProfileRootMatches(snapshot)) rows.push(snapshot);
      } catch { /* process exited during inspection */ }
    }
    return rows;
  }
  return [];
}

export async function inspectBrowserCdpOwnership(): Promise<BrowserCdpOwnership> {
  try {
    return classifyBrowserCdpOwnership({
      processes: await inspectBrowserCdpProcesses(),
      marker: readBrowserCdpOwner(),
      profile: browserCdpProfilePath(),
      port: browserCdpPort(),
    });
  } catch (error) {
    return {
      state: "unverifiable",
      pid: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Safely adopt a pre-marker Agentlas Chrome only after the listener PID, browser executable,
 * canonical profile and exact CDP port all match. Any uncertainty remains fail-closed.
 */
export async function reconcileBrowserCdpOwner(): Promise<BrowserCdpOwnership> {
  const before = await inspectBrowserCdpOwnership();
  if (before.state !== "adoptable" || !before.pid) return before;
  writeBrowserCdpOwner(before.pid);
  const after = await inspectBrowserCdpOwnership();
  if (after.state === "owned" && after.pid === before.pid) return { ...after, adopted: true };
  return { ...after, reason: `adoption-race:${after.reason}` };
}

/**
 * OS listener inspection can briefly lose a process while Chrome is opening or
 * handing a URL to an existing profile process. Retry the attestation without
 * ever treating an uncertain/foreign result as owned. A persistent mismatch
 * still fails closed and is returned with its exact reason for diagnostics.
 */
let browserCdpOwnershipRetryFlight: Promise<BrowserCdpOwnership> | null = null;

async function runBrowserCdpOwnershipRetry(
  options: BrowserCdpOwnershipRetryOptions = {},
): Promise<BrowserCdpOwnership> {
  const attempts = Math.max(1, Math.min(8, Math.trunc(options.attempts ?? 4)));
  const delayMs = Math.max(0, Math.min(1_000, Math.trunc(options.delayMs ?? 90)));
  const reconcile = options.reconcile ?? reconcileBrowserCdpOwner;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let ownership: BrowserCdpOwnership = { state: "unverifiable", pid: null, reason: "not-inspected" };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    ownership = await reconcile();
    if (ownership.state === "owned") return ownership;
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  return ownership;
}

export function reconcileBrowserCdpOwnerWithRetry(
  options: BrowserCdpOwnershipRetryOptions = {},
): Promise<BrowserCdpOwnership> {
  // Injected collaborators are only used by deterministic tests and must not
  // join the live process-wide single-flight.
  if (options.reconcile || options.sleep) return runBrowserCdpOwnershipRetry(options);
  if (browserCdpOwnershipRetryFlight) return browserCdpOwnershipRetryFlight;
  const flight = runBrowserCdpOwnershipRetry(options);
  browserCdpOwnershipRetryFlight = flight;
  void flight.then(
    () => { if (browserCdpOwnershipRetryFlight === flight) browserCdpOwnershipRetryFlight = null; },
    () => { if (browserCdpOwnershipRetryFlight === flight) browserCdpOwnershipRetryFlight = null; },
  );
  return flight;
}

export async function browserCdpOwnerIsLive(): Promise<boolean> {
  return (await reconcileBrowserCdpOwnerWithRetry()).state === "owned";
}

export interface BrowserCdpIdleCloseResult {
  closed: boolean;
  reason: "closed" | "not-owned" | "active-leases" | "close-failed";
  pid: number | null;
}

export interface BrowserCdpMaintenanceResult {
  rootsClosed: number;
  leasesCancelled: number;
  staleLocksRemoved: number;
  sessionArtifactsRemoved: number;
  preferencesUpdated: boolean;
}

export interface BrowserCdpOrphanSweepResult {
  action: "idle" | "protected" | "observing" | "cleaned";
  rootsFound: number;
  maintenance: BrowserCdpMaintenanceResult | null;
}

async function waitForBrowserCdpProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (browserCdpProcessIsLive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return !browserCdpProcessIsLive(pid);
}

/**
 * Browser.close can drop the CDP listener while leaving the macOS browser root
 * alive indefinitely. Once the exact PID has already been ownership-attested
 * and the shutdown lock excludes new consumers, reap that root explicitly.
 */
async function terminateAttestedBrowserCdpRoot(pid: number): Promise<boolean> {
  if (!browserCdpProcessIsLive(pid)) return true;
  await terminateBrowserCdpProfileRoot(pid, false);
  if (await waitForBrowserCdpProcessExit(pid, 2_000)) return true;
  await terminateBrowserCdpProfileRoot(pid, true);
  return waitForBrowserCdpProcessExit(pid, 2_000);
}

function readBrowserCdpWebSocketUrl(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: browserCdpPort(), path: "/json/version", timeout: 1_200 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 1024 * 1024) body += String(chunk);
        });
        res.on("end", () => {
          try {
            const value = JSON.parse(body) as { webSocketDebuggerUrl?: unknown };
            const socketUrl = typeof value.webSocketDebuggerUrl === "string"
              ? new URL(value.webSocketDebuggerUrl)
              : null;
            const loopback = socketUrl?.hostname === "127.0.0.1"
              || socketUrl?.hostname === "localhost"
              || socketUrl?.hostname === "::1"
              || socketUrl?.hostname === "[::1]";
            resolve(
              socketUrl
              && socketUrl.protocol === "ws:"
              && loopback
              && Number(socketUrl.port) === browserCdpPort()
                ? socketUrl.toString()
                : null,
            );
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function requestBrowserCdpClose(socketUrl: string): Promise<boolean> {
  if (typeof WebSocket !== "function") return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = new WebSocket(socketUrl);
    let sent = false;
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* best-effort */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 3_000);
    socket.addEventListener("open", () => {
      sent = true;
      try {
        socket.send(JSON.stringify({ id: 1, method: "Browser.close", params: {} }));
      } catch {
        finish(false);
      }
    }, { once: true });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { id?: number; error?: unknown };
        if (message.id === 1) finish(!message.error);
      } catch { /* wait for close/timeout */ }
    });
    socket.addEventListener("close", () => finish(sent), { once: true });
    socket.addEventListener("error", () => finish(false), { once: true });
  });
}

async function waitForBrowserCdpPortClosed(timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await browserCdpPortReady())) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return !(await browserCdpPortReady());
}

function cancelAllBrowserCdpLeases(): number {
  let cancelled = 0;
  let entries: string[] = [];
  try { entries = fs.readdirSync(browserCdpLeaseDirectory()); } catch { return 0; }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      fs.rmSync(path.join(browserCdpLeaseDirectory(), entry), { force: true });
      cancelled += 1;
    } catch { /* best-effort; browser termination still invalidates the task */ }
  }
  return cancelled;
}

async function terminateBrowserCdpProfileRoot(pid: number, force = false): Promise<void> {
  try {
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        execFile(
          "taskkill.exe",
          ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
          { windowsHide: true, timeout: 5_000 },
          () => resolve(),
        );
      });
    } else {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    }
  } catch { /* process already exited */ }
}

async function waitForBrowserCdpProfileRootsClosed(timeoutMs: number): Promise<BrowserCdpProcessSnapshot[]> {
  const deadline = Date.now() + timeoutMs;
  let roots = await inspectBrowserCdpProfileRoots();
  while (roots.length > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    roots = await inspectBrowserCdpProfileRoots();
  }
  return roots;
}

function clearBrowserCdpSingletonArtifacts(): number {
  let removed = 0;
  for (const name of [
    "SingletonCookie",
    "SingletonLock",
    "SingletonSocket",
    "DevToolsActivePort",
    BROWSER_CDP_LAUNCH_LOCK_BASENAME,
  ]) {
    try {
      if (!fs.existsSync(path.join(browserCdpProfilePath(), name))) continue;
      fs.rmSync(path.join(browserCdpProfilePath(), name), { force: true, recursive: true });
      removed += 1;
    } catch { /* a later launch can retry */ }
  }
  return removed;
}

/**
 * Chrome's session switches are presence-only, so `--restore-last-session=false`
 * still enables restoration. Remove only tab/window session state while the
 * exact Agentlas profile is closed; cookies, local storage and logins remain.
 */
export function resetBrowserCdpSessionRestoreArtifacts(
  profile = browserCdpProfilePath(),
): { sessionArtifactsRemoved: number; preferencesUpdated: boolean } {
  let sessionArtifactsRemoved = 0;
  const defaultProfile = path.join(profile, "Default");
  for (const relative of [
    path.join("Default", "Sessions"),
    path.join("Default", "Current Session"),
    path.join("Default", "Current Tabs"),
    path.join("Default", "Last Session"),
    path.join("Default", "Last Tabs"),
  ]) {
    const candidate = path.join(profile, relative);
    try {
      if (!fs.existsSync(candidate)) continue;
      fs.rmSync(candidate, { recursive: true, force: true });
      sessionArtifactsRemoved += 1;
    } catch { /* a later maintenance sweep can retry */ }
  }

  let preferencesUpdated = false;
  const preferencesPath = path.join(defaultProfile, "Preferences");
  try {
    if (fs.existsSync(preferencesPath)) {
      const parsed = JSON.parse(fs.readFileSync(preferencesPath, "utf8")) as Record<string, unknown>;
      const profilePreferences = parsed.profile && typeof parsed.profile === "object"
        ? parsed.profile as Record<string, unknown>
        : {};
      const sessionPreferences = parsed.session && typeof parsed.session === "object"
        ? parsed.session as Record<string, unknown>
        : {};
      profilePreferences.exit_type = "Normal";
      profilePreferences.exited_cleanly = true;
      sessionPreferences.restore_on_startup = 5;
      sessionPreferences.startup_urls = [];
      parsed.profile = profilePreferences;
      parsed.session = sessionPreferences;
      fs.writeFileSync(preferencesPath, JSON.stringify(parsed), { encoding: "utf8", mode: 0o600 });
      try { fs.chmodSync(preferencesPath, 0o600); } catch { /* best-effort */ }
      preferencesUpdated = true;
    }
  } catch { /* never replace an unreadable Preferences file */ }
  return { sessionArtifactsRemoved, preferencesUpdated };
}

/**
 * Enter an exclusive maintenance window for credential import/login transition.
 * Every dedicated browser is automation-owned by product policy: active leases
 * are cancelled, exact-profile roots are closed, and profile locks are repaired
 * without ever touching an ordinary Chrome process.
 */
export async function withBrowserCdpMaintenance<T>(
  work: (result: BrowserCdpMaintenanceResult) => Promise<T> | T,
): Promise<T> {
  ensureBrowserCdpProfilePrivate();
  if (!(await acquireBrowserCdpShutdownLock())) {
    throw new Error("Agentlas browser maintenance lock could not be acquired.");
  }
  try {
    const leasesCancelled = cancelAllBrowserCdpLeases();
    const initialRoots = await inspectBrowserCdpProfileRoots();
    const ownership = await reconcileBrowserCdpOwnerWithRetry({ attempts: 2, delayMs: 50 });
    if (ownership.state === "owned" && ownership.pid) {
      const socketUrl = await readBrowserCdpWebSocketUrl();
      if (socketUrl) await requestBrowserCdpClose(socketUrl);
      await waitForBrowserCdpPortClosed(2_000);
    }
    for (const root of await inspectBrowserCdpProfileRoots()) {
      await terminateBrowserCdpProfileRoot(root.pid, false);
    }
    let remaining = await waitForBrowserCdpProfileRootsClosed(4_000);
    for (const root of remaining) await terminateBrowserCdpProfileRoot(root.pid, true);
    remaining = await waitForBrowserCdpProfileRootsClosed(2_000);
    if (remaining.length > 0) {
      throw new Error(`Agentlas browser process cleanup failed (${remaining.map((row) => row.pid).join(",")}).`);
    }
    try { fs.rmSync(browserCdpOwnerPath(), { force: true }); } catch { /* derived marker */ }
    try { fs.rmSync(browserCdpBackoffPath(), { force: true }); } catch { /* explicit maintenance resets recovery */ }
    const staleLocksRemoved = clearBrowserCdpSingletonArtifacts();
    const session = resetBrowserCdpSessionRestoreArtifacts();
    return await work({
      rootsClosed: initialRoots.length,
      leasesCancelled,
      staleLocksRemoved,
      ...session,
    });
  } finally {
    releaseBrowserCdpShutdownLock();
  }
}

/** Startup migration/recovery uses the same exact-profile boundary. */
export async function recoverAgentlasBrowserRuntimeAtStartup(): Promise<BrowserCdpMaintenanceResult> {
  // A launchd/headless wake can overlap a healthy GUI task. Live leases prove
  // the browser still has an owner; only dead/stale leases qualify as orphan
  // recovery. Interactive import/login deliberately uses the stronger
  // withBrowserCdpMaintenance policy and cancels active automation.
  if (pruneBrowserCdpLeases() > 0) {
    return {
      rootsClosed: 0,
      leasesCancelled: 0,
      staleLocksRemoved: 0,
      sessionArtifactsRemoved: 0,
      preferencesUpdated: false,
    };
  }
  let result: BrowserCdpMaintenanceResult = {
    rootsClosed: 0,
    leasesCancelled: 0,
    staleLocksRemoved: 0,
    sessionArtifactsRemoved: 0,
    preferencesUpdated: false,
  };
  await withBrowserCdpMaintenance((value) => { result = value; });
  return result;
}

let orphanCandidate: { key: string; firstSeenAt: number } | null = null;

/**
 * Desktop's always-on safety net. A browser with no live lease is observed for
 * a grace period before cleanup, so a just-spawned login/automation process is
 * not raced. Only exact Agentlas profile roots can ever enter this path.
 */
export async function sweepAgentlasBrowserOrphans(options: {
  now?: number;
  graceMs?: number;
} = {}): Promise<BrowserCdpOrphanSweepResult> {
  const now = options.now ?? Date.now();
  const graceMs = Math.max(0, options.graceMs ?? 45_000);
  if (pruneBrowserCdpLeases() > 0) {
    orphanCandidate = null;
    return { action: "protected", rootsFound: 0, maintenance: null };
  }
  const roots = await inspectBrowserCdpProfileRoots();
  if (roots.length === 0) {
    orphanCandidate = null;
    return { action: "idle", rootsFound: 0, maintenance: null };
  }
  const key = roots.map((root) => root.pid).sort((a, b) => a - b).join(",");
  if (graceMs > 0 && (!orphanCandidate || orphanCandidate.key !== key)) {
    orphanCandidate = { key, firstSeenAt: now };
    return { action: "observing", rootsFound: roots.length, maintenance: null };
  }
  if (graceMs > 0 && now - (orphanCandidate?.firstSeenAt ?? now) < graceMs) {
    return { action: "observing", rootsFound: roots.length, maintenance: null };
  }
  let maintenance: BrowserCdpMaintenanceResult | null = null;
  await withBrowserCdpMaintenance((value) => { maintenance = value; });
  orphanCandidate = null;
  return { action: "cleaned", rootsFound: roots.length, maintenance };
}

/** Close only an attested, idle Agentlas browser before a file import or a headful login launch. */
export async function closeBrowserCdpIfIdle(maxLiveLeases = 0): Promise<BrowserCdpIdleCloseResult> {
  const initial = await reconcileBrowserCdpOwnerWithRetry();
  if (initial.state !== "owned" || !initial.pid) {
    return { closed: false, reason: "not-owned", pid: initial.pid };
  }
  if (!(await acquireBrowserCdpShutdownLock())) {
    return { closed: false, reason: "close-failed", pid: initial.pid };
  }
  const pid = initial.pid;
  try {
    const ownership = await reconcileBrowserCdpOwnerWithRetry();
    if (ownership.state !== "owned" || ownership.pid !== pid) {
      return { closed: false, reason: "not-owned", pid: ownership.pid };
    }
    if (pruneBrowserCdpLeases() > maxLiveLeases) {
      return { closed: false, reason: "active-leases", pid };
    }

    const socketUrl = await readBrowserCdpWebSocketUrl();
    const requested = socketUrl ? await requestBrowserCdpClose(socketUrl) : false;
    let closed = requested && await waitForBrowserCdpPortClosed();
    if (!closed && pruneBrowserCdpLeases() <= maxLiveLeases) {
      const stillOwned = await reconcileBrowserCdpOwnerWithRetry({ attempts: 2, delayMs: 50 });
      if (stillOwned.state === "owned" && stillOwned.pid === pid) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already exiting */ }
        closed = await waitForBrowserCdpPortClosed();
      }
    }
    if (closed) closed = await terminateAttestedBrowserCdpRoot(pid);
    if (closed) clearBrowserCdpOwner(pid);
    return { closed, reason: closed ? "closed" : "close-failed", pid };
  } finally {
    releaseBrowserCdpShutdownLock();
  }
}

export function browserCdpPortReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: browserCdpPort(), path: "/json/version", timeout: 1200 },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

/** 기본 CDP 포트(MCP 런처와 동일 기본값). */
export function browserCdpPort(): number {
  return Number(process.env.AGENTLAS_CDP_PORT || 9222);
}

/** Agentlas에 번들된 Playwright Chrome for Testing 경로만 해석한다. */
export function resolveChromeExe(): string | null {
  return resolveAgentlasBrowserRuntimeExecutable();
}

/**
 * Materialized launcher and regression tests share one classifier source so
 * approval behavior cannot drift between the shipped script and its tests.
 */
export const BROWSER_APPROVAL_CLASSIFIER_SOURCE = String.raw`
const PAY_RE = /(checkout|\bpay(ment)?\b|purchase|\bbuy\b|\border\b|donate|subscrib|billing|credit\s*card|debit\s*card|card\s*number|cvv|cvc|결제|구매|주문|결재|카드)/i;
const SEND_RE = /(publish|\bpost\b|\bsend\b|submit|tweet|retweet|\bshare\b|reply|\bcomment\b|confirm|전송|게시|제출|답글|댓글|공유|보내|확인)/i;
const PUBLISH_RE = /(publish|\bpost\b|tweet|retweet|게시|공개)/i;
const DELETE_RE = /(delete|remove|destroy|unsubscribe|삭제|제거|탈퇴)/i;
const SUBMIT_KEY_RE = /(?:^|[+\s])(enter|return|numpadenter)(?:$|[+\s])/i;
// Opening a composer or selecting draft media is reversible. Treating labels
// such as "New post" as the final publish action stalls the file chooser behind
// an approval sheet before the user can even prepare the draft.
const DRAFT_STAGE_RE = /(?:\b(?:new|create|compose|start)\s+(?:a\s+)?(?:new\s+)?(?:post|reel|story)\b|\b(?:add|choose|select|upload)\s+(?:media|photo|video|file|from\s+computer)\b|(?:새로운?|새)\s*(?:게시물|릴스|스토리)|(?:게시물|릴스|스토리)\s*(?:만들기|작성|추가)|컴퓨터에서\s*선택|파일\s*(?:선택|첨부))/i;
const EXPLICIT_FINALIZE_RE = /(?:\bpublish\b|\bshare\b|\bpost\s+now\b|\bsend\b|\bsubmit\b|게시하기|공유하기|전송하기|제출하기)/i;

function actionFromIntent(text, fallback = null) {
  if (PAY_RE.test(text)) return 'payment';
  if (DELETE_RE.test(text)) return 'delete';
  if (PUBLISH_RE.test(text)) return 'publish';
  if (SEND_RE.test(text)) return 'send';
  return fallback;
}

function intentText(name, args, currentUrl = '') {
  const input = args && typeof args === 'object' ? args : {};
  const parts = [currentUrl, input.element, input.target, input.name, input.label, input.url];
  if (name === 'browser_fill_form' && Array.isArray(input.fields)) {
    for (const field of input.fields) parts.push(field && field.name, field && field.type);
  }
  return parts.filter((value) => typeof value === 'string').join(' ').toLowerCase();
}

function classifyAction(name, args, currentUrl = '') {
  const input = args && typeof args === 'object' ? args : {};
  const intent = intentText(name, input, currentUrl);
  const controlIntent = intentText(name, input, '');
  let allText = '';
  try { allText = JSON.stringify(input).toLowerCase(); } catch (e) { allText = ''; }

  // Playwright MCP exposes page-scoped JavaScript as browser_evaluate and
  // process-scoped JavaScript as browser_run_code_unsafe. Both execute
  // caller-supplied code and both must cross the same explicit checkpoint.
  // Keeping only the old browser_run_code alias here made the visible
  // approval sheet decorative for the current browser_evaluate tool.
  if (name === 'browser_evaluate' || name === 'browser_run_code' || name === 'browser_run_code_unsafe') return 'unsafe-code';

  const submitByType = name === 'browser_type' && input.submit === true;
  const submitByKey = name === 'browser_press_key' && SUBMIT_KEY_RE.test(String(input.key || ''));
  if (submitByType || submitByKey) return actionFromIntent(intent, 'send');

  if (name === 'browser_handle_dialog' && input.accept === true) {
    return actionFromIntent(intent, 'send');
  }

  // Filling payment credentials is gated before secrets are exposed to the page.
  // Ordinary text/form filling remains approval-free until an actual submit action.
  if (name === 'browser_type' || name === 'browser_fill' || name === 'browser_fill_form') {
    return PAY_RE.test(intent) ? 'payment' : null;
  }

  if (name === 'browser_navigate' || name === 'browser_navigate_back') {
    return PAY_RE.test(allText) ? 'payment' : null;
  }
  if (name === 'browser_file_upload') {
    // Playwright only stages the selected file in the page's draft flow. The
    // irreversible Share/Publish click remains independently approval-gated.
    // File names and parent directories may legitimately contain "post".
    return null;
  }
  if (name === 'browser_click') {
    // The page URL is trusted only for payment context. A Threads/Instagram URL
    // containing /post/ must not turn every harmless click into a publish.
    if (PAY_RE.test(intent)) return 'payment';
    if (DELETE_RE.test(controlIntent)) return 'delete';
    if (DRAFT_STAGE_RE.test(controlIntent) && !EXPLICIT_FINALIZE_RE.test(controlIntent)) return null;
    return actionFromIntent(controlIntent + ' ' + allText);
  }
  return null;
}
`;

/** CDP 현재 페이지와 명시적 navigate 목적지 중 승인 사이트로 쓸 권위 URL을 고르는 순수 헬퍼. */
export const BROWSER_APPROVAL_CONTEXT_SOURCE = String.raw`
function extractCdpPageUrl(pages) {
  if (!Array.isArray(pages)) return '';
  const candidates = pages.filter((page) => page && page.type === 'page' && typeof page.url === 'string');
  const active = candidates.find((page) => !/^(?:about:blank|chrome:\/\/newtab\/?|devtools:)/i.test(page.url));
  return String((active || candidates[0] || {}).url || '');
}

function approvalContextUrl(name, args, observedUrl) {
  const input = args && typeof args === 'object' ? args : {};
  if (name === 'browser_navigate' && typeof input.url === 'string' && input.url.trim()) return input.url.trim();
  return typeof observedUrl === 'string' ? observedUrl.trim() : '';
}
`;

/**
 * Request lifecycle shared by the materialized stdio proxy and regression
 * tests. MCP clients can cancel a tools/call while the approval sheet is open;
 * the original action must never be forwarded after that cancellation.
 */
export const BROWSER_GATE_LIFECYCLE_SOURCE = String.raw`
function createGateLifecycle() {
  const pending = new Map();
  return {
    begin(requestId) {
      const previous = pending.get(requestId);
      if (previous) previous.abort();
      const controller = new AbortController();
      pending.set(requestId, controller);
      return controller;
    },
    settle(requestId, controller) {
      if (pending.get(requestId) !== controller) return false;
      pending.delete(requestId);
      return !controller.signal.aborted;
    },
    cancel(requestId) {
      const controller = pending.get(requestId);
      if (!controller) return false;
      pending.delete(requestId);
      controller.abort();
      return true;
    },
    cancelAll() {
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    },
    size() { return pending.size; },
  };
}
function cancelledRequestId(message) {
  if (!message || message.method !== 'notifications/cancelled' || !message.params) return null;
  return message.params.requestId ?? null;
}
`;

/**
 * Dependency-free ownership attestation used by the materialized launcher.
 * Keep this behavior aligned with classifyBrowserCdpOwnership above: an exact
 * dedicated-profile listener may be adopted, while unknown listeners fail closed.
 */
export const BROWSER_CDP_OWNERSHIP_RUNTIME_SOURCE = String.raw`
function canonicalProfile(value) {
  if (process.platform === 'win32') return path.win32.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  return path.resolve(value).replace(/\/+$/, '');
}
function commandFlag(commandLine, flag) {
  const marker = '--' + flag + '=';
  const escapedFlag = flag.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
  const switchMatches = [...commandLine.matchAll(new RegExp('(?:^|\\s)--' + escapedFlag + '=', 'g'))];
  if (switchMatches.length !== 1) return null;
  const switchMatch = switchMatches[0];
  const markerOffset = switchMatch[0].lastIndexOf(marker);
  const rest = commandLine.slice(switchMatch.index + markerOffset + marker.length);
  if (rest.startsWith('"')) { const end = rest.indexOf('"', 1); return end >= 0 ? rest.slice(1, end) : null; }
  if (rest.startsWith("'")) { const end = rest.indexOf("'", 1); return end >= 0 ? rest.slice(1, end) : null; }
  const nextSwitch = rest.search(/\s+--[a-z0-9][a-z0-9-]*(?:=|\s|$)/i);
  const value = (nextSwitch >= 0 ? rest.slice(0, nextSwitch) : rest.split(/\s+/, 1)[0]).trim();
  return value || null;
}
function allowedExecutablePaths() {
  return [BROWSER_RUNTIME_EXE, ...LEGACY_BROWSER_EXES].filter(Boolean);
}
function processMatches(snapshot) {
  if (!snapshot || !Number.isInteger(snapshot.pid) || snapshot.pid <= 0) return false;
  if (snapshot.loopbackOnly !== true) return false;
  const actualExecutable = canonicalProfile(snapshot.executable || '');
  const allowedExecutables = new Set();
  for (const candidate of allowedExecutablePaths()) {
    allowedExecutables.add(canonicalProfile(candidate));
    try { allowedExecutables.add(canonicalProfile(fs.realpathSync(candidate))); } catch (e) {}
  }
  const snapChromium = process.platform === 'linux' && /^\/snap\/chromium\/(?:current|\d+)\/usr\/lib\/chromium(?:-browser)?\/(?:chrome|chromium)$/.test(actualExecutable);
  if (!allowedExecutables.has(actualExecutable) && !snapChromium) return false;
  const commandProfile = commandFlag(snapshot.commandLine || '', 'user-data-dir');
  const commandPort = commandFlag(snapshot.commandLine || '', 'remote-debugging-port');
  return Boolean(
    commandProfile && commandPort && /^\d+$/.test(commandPort) &&
    canonicalProfile(commandProfile) === canonicalProfile(CDP_PROFILE) && Number(commandPort) === PORT
  );
}
function readOwner() {
  try {
    const owner = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8'));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !Number.isInteger(owner.port) || typeof owner.profile !== 'string') return null;
    return owner;
  } catch (e) { return null; }
}
function writeOwner(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  fs.mkdirSync(path.dirname(OWNER_FILE), { recursive: true });
  const temp = OWNER_FILE + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2) + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify({ pid, port: PORT, profile: path.resolve(CDP_PROFILE) }), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(temp, 0o600); } catch (e) {}
    fs.renameSync(temp, OWNER_FILE);
  } finally { try { fs.rmSync(temp, { force: true }); } catch (e) {} }
}
function ensurePrivateProfile() {
  fs.mkdirSync(CDP_PROFILE, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CDP_PROFILE, 0o700); } catch (e) {}
}
function execFileText(executable, args, allowedExitCodes = []) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) {
        if (error.code === 'ENOENT' || error.killed) return reject(error);
        if (!allowedExitCodes.includes(Number(error.code))) return reject(error);
      }
      resolve(stdout || '');
    });
  });
}
function uniquePositivePids(values) {
  return [...new Set(values.filter((pid) => Number.isInteger(pid) && pid > 0))];
}
async function inspectDarwinProcesses() {
  const listenerOutput = await execFileText('/usr/sbin/lsof', ['-nP', '-a', '-iTCP:' + PORT, '-sTCP:LISTEN', '-Fpn'], [1]);
  const addressesByPid = new Map();
  let currentPid = null;
  for (const line of listenerOutput.split(/\r?\n/)) {
    if (/^p\d+$/.test(line)) { currentPid = Number(line.slice(1)); if (!addressesByPid.has(currentPid)) addressesByPid.set(currentPid, []); }
    else if (currentPid && line.startsWith('n')) addressesByPid.get(currentPid).push(line.slice(1));
  }
  const pids = uniquePositivePids([...addressesByPid.keys()]);
  const snapshots = [];
  for (const pid of pids) {
    const [commandLine, textFiles] = await Promise.all([
      execFileText('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command=']),
      execFileText('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn']),
    ]);
    const executableLine = textFiles.split(/\r?\n/).find((line) => line.startsWith('n'));
    const addresses = addressesByPid.get(pid) || [];
    const loopbackOnly = addresses.length > 0 && addresses.every((address) => address === '127.0.0.1:' + PORT || address === '[::1]:' + PORT || address === '::1:' + PORT);
    snapshots.push({ pid, executable: executableLine ? executableLine.slice(1) : '', commandLine: commandLine.trim(), loopbackOnly });
  }
  return snapshots;
}
function linuxListenerInodes() {
  const wantedPort = PORT.toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Map();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let source = ''; try { source = fs.readFileSync(table, 'utf8'); } catch (e) { continue; }
    for (const line of source.split(/\r?\n/).slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10 || fields[3] !== '0A') continue;
      const localPort = (fields[1] || '').split(':').pop().toUpperCase();
      if (localPort === wantedPort && fields[9]) {
        const host = (fields[1] || '').split(':')[0].toUpperCase();
        inodes.set(fields[9], host === '0100007F' || host === '00000000000000000000000001000000');
      }
    }
  }
  return inodes;
}
function linuxListenerPids() {
  const inodes = linuxListenerInodes();
  if (inodes.size === 0) return [];
  const pids = new Map();
  let entries = []; try { entries = fs.readdirSync('/proc'); } catch (e) { return []; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      if (typeof process.getuid === 'function' && fs.statSync('/proc/' + pid).uid !== process.getuid()) continue;
      for (const fd of fs.readdirSync('/proc/' + pid + '/fd')) {
        const target = fs.readlinkSync('/proc/' + pid + '/fd/' + fd);
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match && inodes.has(match[1])) pids.set(pid, (pids.get(pid) ?? true) && inodes.get(match[1]) === true);
      }
    } catch (e) {}
  }
  return uniquePositivePids([...pids.keys()]).map((pid) => ({ pid, loopbackOnly: pids.get(pid) === true }));
}
async function inspectLinuxProcesses() {
  const snapshots = [];
  for (const entry of linuxListenerPids()) {
    try {
      snapshots.push({
        pid: entry.pid,
        executable: fs.readlinkSync('/proc/' + entry.pid + '/exe'),
        commandLine: fs.readFileSync('/proc/' + entry.pid + '/cmdline', 'utf8').split('\0').filter(Boolean).join(' '),
        loopbackOnly: entry.loopbackOnly,
      });
    } catch (e) {}
  }
  return snapshots;
}
async function inspectWindowsProcesses() {
  const script = [
    '$connections = @(Get-NetTCPConnection -State Listen -LocalPort ' + PORT + ' -ErrorAction Stop)',
    '$rows = @($connections | Group-Object OwningProcess | ForEach-Object { $pidValue = [int]$_.Name; $p = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue"; $addresses = @($_.Group | Select-Object -ExpandProperty LocalAddress -Unique); $nonLoopback = @($addresses | Where-Object { $_ -ne "127.0.0.1" -and $_ -ne "::1" }); if ($p) { [pscustomobject]@{ pid = [int]$p.ProcessId; executable = [string]$p.ExecutablePath; commandLine = [string]$p.CommandLine; loopbackOnly = [bool]($addresses.Count -gt 0 -and $nonLoopback.Count -eq 0) } } })',
    '$rows | ConvertTo-Json -Compress',
  ].join('; ');
  const stdout = await execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((row) => Number.isInteger(row.pid));
}
async function inspectProcesses() {
  if (process.platform === 'darwin') return inspectDarwinProcesses();
  if (process.platform === 'linux') return inspectLinuxProcesses();
  if (process.platform === 'win32') return inspectWindowsProcesses();
  throw new Error('CDP listener ownership inspection is unsupported on ' + process.platform + '.');
}
function classifyOwnership(processes, marker) {
  if (processes.length === 0) return { state: 'absent', pid: null, reason: 'no-listener' };
  if (processes.length !== 1) return { state: 'foreign', pid: null, reason: 'ambiguous-listeners' };
  const listener = processes[0];
  if (!processMatches(listener)) return { state: 'foreign', pid: listener.pid, reason: 'listener-command-mismatch' };
  const markerMatches = Boolean(marker && marker.pid === listener.pid && marker.port === PORT && canonicalProfile(marker.profile) === canonicalProfile(CDP_PROFILE));
  return markerMatches
    ? { state: 'owned', pid: listener.pid, reason: 'listener-and-marker-match' }
    : { state: 'adoptable', pid: listener.pid, reason: 'verified-dedicated-listener' };
}
async function inspectOwnership() {
  try { return classifyOwnership(await inspectProcesses(), readOwner()); }
  catch (e) { return { state: 'unverifiable', pid: null, reason: e && e.message || String(e) }; }
}
async function reconcileOwner() {
  const before = await inspectOwnership();
  if (before.state !== 'adoptable' || !before.pid) return before;
  writeOwner(before.pid);
  const after = await inspectOwnership();
  if (after.state === 'owned' && after.pid === before.pid) return Object.assign({ adopted: true }, after);
  return Object.assign({}, after, { reason: 'adoption-race:' + after.reason });
}
let reconcileOwnerRetryFlight = null;
async function runReconcileOwnerWithRetry(attempts = 4, delayMs = 90) {
  let ownership = { state: 'unverifiable', pid: null, reason: 'not-inspected' };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    ownership = await reconcileOwner();
    if (ownership.state === 'owned') return ownership;
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return ownership;
}
function reconcileOwnerWithRetry(attempts = 4, delayMs = 90) {
  if (reconcileOwnerRetryFlight) return reconcileOwnerRetryFlight;
  const flight = runReconcileOwnerWithRetry(attempts, delayMs);
  reconcileOwnerRetryFlight = flight;
  flight.then(
    () => { if (reconcileOwnerRetryFlight === flight) reconcileOwnerRetryFlight = null; },
    () => { if (reconcileOwnerRetryFlight === flight) reconcileOwnerRetryFlight = null; },
  );
  return flight;
}
`;

/**
 * Cross-process lease + idle reaper protocol used by the materialized launcher.
 * A directory lock makes the final lease check and Browser.close mutually exclusive
 * with a new launch. The protocol uses only Node built-ins and works on macOS,
 * Windows, and Linux.
 */
export const BROWSER_CDP_LIFECYCLE_RUNTIME_SOURCE = String.raw`
function processIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}
function readActiveBackoff() {
  try {
    const record = JSON.parse(fs.readFileSync(BACKOFF_FILE, 'utf8'));
    const until = Number(record.until);
    if (Number.isFinite(until) && until > Date.now()) return { until, reason: String(record.reason || 'resource-limit') };
    fs.rmSync(BACKOFF_FILE, { force: true });
  } catch (e) {}
  return null;
}
function writeBackoff(reason) {
  const temp = BACKOFF_FILE + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify({ until: Date.now() + BACKOFF_MS, reason }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, BACKOFF_FILE);
  } finally { try { fs.rmSync(temp, { force: true }); } catch (e) {} }
}
function clearStaleShutdownLock() {
  if (!fs.existsSync(SHUTDOWN_LOCK)) return true;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(SHUTDOWN_LOCK, 'owner.json'), 'utf8'));
    if (processIsLive(Number(record.pid))) return false;
  } catch (e) {
    try { if (Date.now() - fs.statSync(SHUTDOWN_LOCK).mtimeMs < 5000) return false; }
    catch (statError) {}
  }
  try { fs.rmSync(path.join(SHUTDOWN_LOCK, 'owner.json'), { force: true }); } catch (e) {}
  try { fs.rmdirSync(SHUTDOWN_LOCK); } catch (e) { return !fs.existsSync(SHUTDOWN_LOCK); }
  return true;
}
async function waitForShutdownLock(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(SHUTDOWN_LOCK) && Date.now() < deadline) {
    if (clearStaleShutdownLock()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (fs.existsSync(SHUTDOWN_LOCK) && !clearStaleShutdownLock()) {
    throw new Error('Agentlas dedicated browser shutdown is still in progress.');
  }
}
function pruneLeases() {
  let entries = [];
  try { entries = fs.readdirSync(LEASE_DIR); } catch (e) { return 0; }
  let live = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(LEASE_DIR, entry);
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (processIsLive(Number(record.pid))) { live += 1; continue; }
    } catch (e) {}
    try { fs.rmSync(file, { force: true }); } catch (e) {}
  }
  return live;
}
async function acquireLease(kind) {
  const backoff = readActiveBackoff();
  if (backoff) throw new Error('Agentlas browser is recovering from ' + backoff.reason + '; retry after ' + new Date(backoff.until).toISOString() + '.');
  ensurePrivateProfile();
  fs.mkdirSync(LEASE_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(LEASE_DIR, 0o700); } catch (e) {}
  const safeKind = String(kind || 'consumer').replace(/[^a-z0-9._-]/gi, '-').slice(0, 48) || 'consumer';
  let file = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    file = path.join(LEASE_DIR, safeKind + '-' + token + '.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, kind: safeKind, createdAt: Date.now() }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      break;
    } catch (error) {
      if (!error || error.code !== 'EEXIST' || attempt === 7) throw error;
    }
  }
  try {
    await waitForShutdownLock();
  } catch (error) {
    try { fs.rmSync(file, { force: true }); } catch (e) {}
    throw error;
  }
  const liveCount = pruneLeases();
  if (liveCount > MAX_ACTIVE_TASKS) {
    try { fs.rmSync(file, { force: true }); } catch (e) {}
    throw new Error('Agentlas browser task limit reached (' + liveCount + '/' + MAX_ACTIVE_TASKS + ').');
  }
  return file;
}
function releaseLease(file) {
  if (!file || path.dirname(path.resolve(file)) !== path.resolve(LEASE_DIR)) return;
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number(record.pid) === process.pid) fs.rmSync(file, { force: true });
  } catch (e) {}
}
function scheduleIdleReaper() {
  if (process.env.AGENTLAS_CDP_AUTO_STOP !== '1' || process.env.AGENTLAS_CDP_DISABLE_REAPER === '1' || !process.argv[1]) return;
  try {
    const child = spawn(process.execPath, [process.argv[1], '--agentlas-cdp-reap'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    });
    child.unref();
  } catch (e) {}
}
function scheduleBrowserGuardian(browserPid) {
  if (!Number.isInteger(browserPid) || browserPid <= 0 || !process.argv[1]) return;
  try {
    const child = spawn(process.execPath, [process.argv[1], '--agentlas-cdp-guard', String(browserPid), String(process.pid)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    });
    child.unref();
  } catch (e) {}
}
function idleDelayMs() {
  const configured = Number(process.env.AGENTLAS_CDP_IDLE_MS);
  if (!Number.isFinite(configured)) return 15000;
  return Math.max(0, Math.min(300000, Math.trunc(configured)));
}
function tryAcquireShutdownLock() {
  ensurePrivateProfile();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(SHUTDOWN_LOCK, { mode: 0o700 });
      fs.writeFileSync(path.join(SHUTDOWN_LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST' || !clearStaleShutdownLock()) return false;
    }
  }
  return false;
}
function releaseShutdownLock() {
  try { fs.rmSync(path.join(SHUTDOWN_LOCK, 'owner.json'), { force: true }); } catch (e) {}
  try { fs.rmdirSync(SHUTDOWN_LOCK); } catch (e) {}
}
function clearStaleLaunchLock() {
  if (!fs.existsSync(LAUNCH_LOCK)) return true;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(LAUNCH_LOCK, 'owner.json'), 'utf8'));
    if (processIsLive(Number(record.pid))) return false;
  } catch (e) {
    try { if (Date.now() - fs.statSync(LAUNCH_LOCK).mtimeMs < 5000) return false; }
    catch (statError) {}
  }
  try { fs.rmSync(LAUNCH_LOCK, { recursive: true, force: true }); } catch (e) {}
  return !fs.existsSync(LAUNCH_LOCK);
}
async function acquireLaunchLock(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(LAUNCH_LOCK, { mode: 0o700 });
      fs.writeFileSync(path.join(LAUNCH_LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { encoding: 'utf8', mode: 0o600 });
      return;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      if (clearStaleLaunchLock()) continue;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('Agentlas dedicated browser launch is still in progress.');
}
function releaseLaunchLock() {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(LAUNCH_LOCK, 'owner.json'), 'utf8'));
    if (Number(record.pid) !== process.pid) return;
  } catch (e) { return; }
  try { fs.rmSync(LAUNCH_LOCK, { recursive: true, force: true }); } catch (e) {}
}
function clearOwner(pid) {
  try {
    const owner = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8'));
    if (Number(owner.pid) === pid) fs.rmSync(OWNER_FILE, { force: true });
  } catch (e) {}
}
function readBrowserWebSocketUrl() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version', timeout: 1200 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 1024 * 1024) body += chunk; });
      res.on('end', () => {
        try {
          const value = JSON.parse(body).webSocketDebuggerUrl;
          const url = new URL(value);
          const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
          resolve(url.protocol === 'ws:' && loopback && Number(url.port) === PORT ? value : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
async function requestBrowserClose() {
  if (typeof WebSocket !== 'function') return false;
  const socketUrl = await readBrowserWebSocketUrl();
  if (!socketUrl) return false;
  return new Promise((resolve) => {
    const socket = new WebSocket(socketUrl);
    let sent = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch (e) {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 3000);
    socket.addEventListener('open', () => {
      sent = true;
      try { socket.send(JSON.stringify({ id: 1, method: 'Browser.close', params: {} })); }
      catch (e) { finish(false); }
    }, { once: true });
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id === 1) finish(!message.error);
      } catch (e) {}
    });
    socket.addEventListener('close', () => finish(sent), { once: true });
    socket.addEventListener('error', () => finish(false), { once: true });
  });
}
async function waitForPortClosed(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portReady(PORT))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !(await portReady(PORT));
}
async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processIsLive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processIsLive(pid);
}
async function terminateAttestedBrowserRoot(pid) {
  if (!processIsLive(pid)) return true;
  try {
    if (process.platform === 'win32') {
      await new Promise((resolve) => execFile('taskkill.exe', ['/PID', String(pid), '/T'], { windowsHide: true, timeout: 3000 }, () => resolve()));
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch (e) {}
  if (await waitForProcessExit(pid, 2000)) return true;
  try {
    if (process.platform === 'win32') {
      await new Promise((resolve) => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => resolve()));
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch (e) {}
  return waitForProcessExit(pid, 2000);
}
function readCdpTargets() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 1200 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 4 * 1024 * 1024) body += chunk; });
      res.on('end', () => {
        try { const rows = JSON.parse(body); resolve(Array.isArray(rows) ? rows : []); }
        catch (e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}
function descendantResourceTotals(rows, rootPid) {
  const wanted = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (wanted.has(row.ppid) && !wanted.has(row.pid)) { wanted.add(row.pid); changed = true; }
    }
  }
  let rssBytes = 0;
  let renderers = 0;
  for (const row of rows) {
    if (!wanted.has(row.pid)) continue;
    rssBytes += Math.max(0, Number(row.rssBytes) || 0);
    if (/(?:^|\s)--type=renderer(?:\s|$)/.test(String(row.commandLine || ''))) renderers += 1;
  }
  return { rssBytes, renderers };
}
async function browserProcessResources(rootPid) {
  if (process.platform === 'darwin') {
    const output = await execFileText('/bin/ps', ['-axo', 'pid=,ppid=,rss=,command=']);
    const rows = [];
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\s\S]+)$/);
      if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, commandLine: match[4] });
    }
    return descendantResourceTotals(rows, rootPid);
  }
  if (process.platform === 'win32') {
    const script = [
      '$rows = @(Get-CimInstance Win32_Process | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; rssBytes = if ($p) { [double]$p.WorkingSet64 } else { 0 }; commandLine = [string]$_.CommandLine } })',
      '$rows | ConvertTo-Json -Compress',
    ].join('; ');
    const output = await execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const parsed = output.trim() ? JSON.parse(output) : [];
    return descendantResourceTotals(Array.isArray(parsed) ? parsed : [parsed], rootPid);
  }
  if (process.platform === 'linux') {
    const rows = [];
    let entries = []; try { entries = fs.readdirSync('/proc'); } catch (e) { return { rssBytes: 0, renderers: 0 }; }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const pid = Number(entry);
        const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        const close = stat.lastIndexOf(')');
        const fields = stat.slice(close + 2).split(/\s+/);
        const ppid = Number(fields[1]);
        const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
        const rssKb = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0);
        const commandLine = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean).join(' ');
        rows.push({ pid, ppid, rssBytes: rssKb * 1024, commandLine });
      } catch (e) {}
    }
    return descendantResourceTotals(rows, rootPid);
  }
  return { rssBytes: 0, renderers: 0 };
}
async function enforceBrowserResourceLimits() {
  const ownership = await reconcileOwnerWithRetry();
  if (ownership.state !== 'owned' || !ownership.pid) throw new Error('Agentlas browser resource ownership could not be verified.');
  const [targets, resources] = await Promise.all([readCdpTargets(), browserProcessResources(ownership.pid)]);
  const pages = targets.filter((target) => target && target.type === 'page').length;
  let reason = '';
  if (pages > MAX_PAGES) reason = 'page-limit:' + pages + '/' + MAX_PAGES;
  else if (resources.renderers > MAX_RENDERERS) reason = 'renderer-limit:' + resources.renderers + '/' + MAX_RENDERERS;
  else if (resources.rssBytes > MAX_RSS_BYTES) reason = 'memory-limit:' + Math.ceil(resources.rssBytes / 1024 / 1024) + 'MB/' + Math.ceil(MAX_RSS_BYTES / 1024 / 1024) + 'MB';
  if (!reason) return { pages, renderers: resources.renderers, rssBytes: resources.rssBytes };
  if (tryAcquireShutdownLock()) {
    try {
      writeBackoff(reason);
      let entries = []; try { entries = fs.readdirSync(LEASE_DIR); } catch (e) {}
      for (const entry of entries) { if (entry.endsWith('.json')) { try { fs.rmSync(path.join(LEASE_DIR, entry), { force: true }); } catch (e) {} } }
      const requested = await requestBrowserClose();
      let closed = requested && await waitForPortClosed(4000);
      if (closed) closed = await terminateAttestedBrowserRoot(ownership.pid);
      if (!closed) closed = await terminateOwnedBrowserGracefully(ownership.pid);
      if (closed) clearOwner(ownership.pid);
    } finally { releaseShutdownLock(); }
  }
  throw new Error('Agentlas browser exceeded ' + reason + '. The dedicated browser was reset; retry after the recovery backoff.');
}
async function terminateOwnedBrowserGracefully(pid) {
  const current = await reconcileOwnerWithRetry(2, 50);
  if (current.state !== 'owned' || current.pid !== pid || pruneLeases() > 0) return false;
  const rootClosed = await terminateAttestedBrowserRoot(pid);
  return rootClosed && await waitForPortClosed(3000);
}
async function reapIdleBrowser() {
  if (process.env.AGENTLAS_CDP_AUTO_STOP !== '1') return;
  await new Promise((resolve) => setTimeout(resolve, idleDelayMs()));
  if (!tryAcquireShutdownLock()) return;
  try {
    if (pruneLeases() > 0) return;
    const ownership = await reconcileOwnerWithRetry();
    if (ownership.state !== 'owned' || !ownership.pid) return;
    if (pruneLeases() > 0) return;
    const requested = await requestBrowserClose();
    let closed = requested && await waitForPortClosed(4000);
    if (closed) closed = await terminateAttestedBrowserRoot(ownership.pid);
    if (!closed && pruneLeases() === 0) closed = await terminateOwnedBrowserGracefully(ownership.pid);
    if (closed) {
      clearOwner(ownership.pid);
      log('closed idle dedicated Chrome', ownership.pid);
    } else {
      log('WARN idle dedicated Chrome did not close cleanly', ownership.pid);
    }
  } finally {
    releaseShutdownLock();
  }
}
async function guardOwnedBrowser(browserPid, ownerPid) {
  if (!Number.isInteger(browserPid) || browserPid <= 0 || !Number.isInteger(ownerPid) || ownerPid <= 0) return;
  while (processIsLive(browserPid) && processIsLive(ownerPid)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!processIsLive(browserPid)) return;
  // Give normal signal/exit handlers a short chance to release their lease.
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (!tryAcquireShutdownLock()) return;
  try {
    if (pruneLeases() > 0) return;
    const ownership = await reconcileOwnerWithRetry();
    if (ownership.state !== 'owned' || ownership.pid !== browserPid) return;
    const requested = await requestBrowserClose();
    let closed = requested && await waitForPortClosed(4000);
    if (closed) closed = await terminateAttestedBrowserRoot(browserPid);
    if (!closed && pruneLeases() === 0) closed = await terminateOwnedBrowserGracefully(browserPid);
    if (closed) clearOwner(browserPid);
  } finally {
    releaseShutdownLock();
  }
}
`;

/**
 * 이 런처 파일(~/.agentlas/agentlas-browser-cdp.mjs)은 **두 프로그램이 쓴다** — 데스크탑의
 * materializeBrowserCdpLauncher 와 Agentlas-OS 의 agentlas_browser.py:materialize_launcher.
 * 둘 다 "내용이 다르면 덮어쓴다"였기 때문에 나중에 실행된 쪽이 이겼고, 사용자 머신에서는
 * 자기도 모르게 동작이 오락가락했다(한쪽은 개인 Chrome 의 쿠키·저장된 비밀번호까지 시드한다).
 *
 * 그래서 파일이 자기 계약 번호와 writer를 들고 다닌다. 더 높은 계약과 같은 계약의 다른
 * writer는 보존한다. 같은 Desktop 계약은 현재 설치 앱의 런타임 경로로 다시 결합한다.
 */
export const BROWSER_CDP_LAUNCHER_CONTRACT = 14;
export const BROWSER_CDP_LAUNCHER_WRITER = "agentlas-desktop";

/** 설치된 런처 파일에서 계약 번호를 읽는다. 표식이 없으면 null(= 계약 이전 파일). */
export function readLauncherContractVersion(source: string): number | null {
  const match = source.match(/@agentlas-browser-cdp-contract\s+(\d+)/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 설치된 런처 파일의 writer 표식을 읽는다. */
export function readLauncherWriter(source: string): string | null {
  const match = source.match(/@agentlas-browser-cdp-writer\s+([a-z0-9._-]+)/i);
  return match?.[1]?.toLowerCase() || null;
}

/** Materialized Desktop launchers bind two absolute executables. */
export function readLauncherRuntimeBindings(source: string): {
  playwrightMcpCli: string;
  browserRuntimeExe: string;
} | null {
  const playwright = source.match(/const PLAYWRIGHT_MCP_CLI = ("(?:[^"\\]|\\.)*");/);
  const browser = source.match(/const BROWSER_RUNTIME_EXE = ("(?:[^"\\]|\\.)*");/);
  if (!playwright || !browser) return null;
  try {
    return {
      playwrightMcpCli: JSON.parse(playwright[1]) as string,
      browserRuntimeExe: JSON.parse(browser[1]) as string,
    };
  } catch {
    return null;
  }
}

/** A higher contract cannot be trusted when its bound runtime no longer exists. */
export function hasUsableLauncherRuntimeBindings(source: string): boolean {
  const bindings = readLauncherRuntimeBindings(source);
  return Boolean(
    bindings
    && path.isAbsolute(bindings.playwrightMcpCli)
    && path.isAbsolute(bindings.browserRuntimeExe)
    && fs.statSync(bindings.playwrightMcpCli, { throwIfNoEntry: false })?.isFile()
    && fs.statSync(bindings.browserRuntimeExe, { throwIfNoEntry: false })?.isFile(),
  );
}

function createLauncherSource(
  CURRENT_BROWSER_RUNTIME: ReturnType<typeof resolveAgentlasBrowserRuntime>,
): string {
  const LAUNCHER_SOURCE = String.raw`#!/usr/bin/env node
// @agentlas-browser-cdp-contract ${BROWSER_CDP_LAUNCHER_CONTRACT}
// @agentlas-browser-cdp-writer ${BROWSER_CDP_LAUNCHER_WRITER}
// Agentlas Browser (CDP) — 범용 엔진. Agentlas 전용 Chrome 프로필을 원격 디버깅 포트로 띄우고
// @playwright/mcp 를 CDP 로 붙여 MCP 브라우저 도구를 제공한다. 이 프로세스가 client ↔ @playwright/mcp
// 사이를 stdio 로 프록시하며 (1) 되돌릴 수 없는 행동 승인 게이트, (2) learn-and-replay 스킬 레이어를 얹는다.
// 의존성 0(순수 node). 개인 데이터는 로컬에서만 사용, 어디로도 전송하지 않는다.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const PORT = Number(process.env.AGENTLAS_CDP_PORT || 9222);
const CDP_PROFILE = process.env.AGENTLAS_CDP_PROFILE || path.join(os.homedir(), '.agentlas', 'chrome-cdp-profile');
const OWNER_FILE = path.join(CDP_PROFILE, '.agentlas-cdp-owner.json');
const LEASE_DIR = path.join(CDP_PROFILE, ${JSON.stringify(BROWSER_CDP_LEASE_DIRNAME)});
const SHUTDOWN_LOCK = path.join(CDP_PROFILE, ${JSON.stringify(BROWSER_CDP_SHUTDOWN_LOCK_BASENAME)});
const LAUNCH_LOCK = path.join(CDP_PROFILE, ${JSON.stringify(BROWSER_CDP_LAUNCH_LOCK_BASENAME)});
const BACKOFF_FILE = path.join(CDP_PROFILE, ${JSON.stringify(BROWSER_CDP_BACKOFF_BASENAME)});
const DEFAULT_LIMITS = ${JSON.stringify(BROWSER_CDP_RESOURCE_LIMITS)};
function boundedLimit(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(value))) : fallback;
}
const MAX_ACTIVE_TASKS = boundedLimit('AGENTLAS_CDP_MAX_TASKS', DEFAULT_LIMITS.activeTasks, 1, 32);
const MAX_PAGES = boundedLimit('AGENTLAS_CDP_MAX_PAGES', DEFAULT_LIMITS.pages, 4, 100);
const MAX_RENDERERS = boundedLimit('AGENTLAS_CDP_MAX_RENDERERS', DEFAULT_LIMITS.renderers, 4, 128);
const MAX_RSS_BYTES = boundedLimit('AGENTLAS_CDP_MAX_RSS_MB', DEFAULT_LIMITS.rssBytes / 1024 / 1024, 512, 16384) * 1024 * 1024;
const BACKOFF_MS = boundedLimit('AGENTLAS_CDP_BACKOFF_MS', DEFAULT_LIMITS.backoffMs, 1000, 300000);
// Agent-run browsing is presented in One's Browser rail, so the automation
// host is non-windowed by default even if a caller omits the env hint. The
// explicit Browser login action uses browserOpenLogin() and never this launch
// path, preserving the one intentional headful window for human sign-in.
const HEADLESS = String(process.env.AGENTLAS_CDP_HEADLESS || '1').toLowerCase() !== '0';
const SKILLS_DIR = process.env.AGENTLAS_BROWSER_SKILLS_DIR || path.join(os.homedir(), '.agentlas', 'browser-skills');
const APPROVAL_FILE = process.env.${BROWSER_APPROVAL_FILE_ENV} || '';
const PLAYWRIGHT_MCP_CLI = ${JSON.stringify(playwrightMcpCliPath())};
const BROWSER_RUNTIME_EXE = ${JSON.stringify(CURRENT_BROWSER_RUNTIME?.executable ?? "")};
const LEGACY_BROWSER_EXES = ${JSON.stringify(legacySystemBrowserExecutableCandidates())};
const log = (...a) => console.error('[agentlas-browser]', ...a);

function portReady(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1200 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

${BROWSER_CDP_OWNERSHIP_RUNTIME_SOURCE}
${BROWSER_CDP_LIFECYCLE_RUNTIME_SOURCE}

function resetSessionRestoreArtifacts() {
  for (const relative of [
    path.join('Default', 'Sessions'),
    path.join('Default', 'Current Session'),
    path.join('Default', 'Current Tabs'),
    path.join('Default', 'Last Session'),
    path.join('Default', 'Last Tabs'),
  ]) {
    try { fs.rmSync(path.join(CDP_PROFILE, relative), { recursive: true, force: true }); } catch (e) {}
  }
  const preferencesPath = path.join(CDP_PROFILE, 'Default', 'Preferences');
  try {
    if (!fs.existsSync(preferencesPath)) return;
    const parsed = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
    parsed.profile = parsed.profile && typeof parsed.profile === 'object' ? parsed.profile : {};
    parsed.session = parsed.session && typeof parsed.session === 'object' ? parsed.session : {};
    parsed.profile.exit_type = 'Normal';
    parsed.profile.exited_cleanly = true;
    parsed.session.restore_on_startup = 5;
    parsed.session.startup_urls = [];
    fs.writeFileSync(preferencesPath, JSON.stringify(parsed), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(preferencesPath, 0o600); } catch (e) {}
  } catch (e) {}
}

async function ensureChromeUnlocked() {
  ensurePrivateProfile();
  if (await portReady(PORT)) {
    const ownership = await reconcileOwnerWithRetry();
    if (ownership.state === 'owned') {
      scheduleBrowserGuardian(ownership.pid);
      log('owned CDP already up on', PORT, ownership.adopted ? '(adopted)' : '');
      return;
    }
    writeBackoff('foreign-port:' + PORT);
    throw new Error('CDP port ' + PORT + ' is occupied by a non-Agentlas or unverifiable listener (' + ownership.state + ':' + ownership.reason + '). Automatic relaunch is paused.');
  }
  const exe = BROWSER_RUNTIME_EXE;
  if (!exe || !fs.existsSync(exe)) throw new Error('Bundled Agentlas Chrome for Testing runtime is missing. Reinstall Agentlas.');
  // Never copy a live everyday-Chrome profile: SQLite/WAL files can be inconsistent while Chrome
  // is running, and copying cookies/password stores would violate the dedicated-profile boundary.
  // Users sign in directly in the Agentlas window; that dedicated profile is then reused as-is.
  log('using persistent Agentlas dedicated profile (no personal-profile import)');
  resetSessionRestoreArtifacts();
  const args = [
    '--user-data-dir=' + CDP_PROFILE, '--remote-debugging-port=' + PORT,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check',
    '--disable-session-crashed-bubble', '--disable-features=Translate',
    // Stability for a long-lived automation profile: stop Chrome from crashing
    // "unexpectedly" out from under the agent. Background component/self-updates
    // swap the binary under a running instance; occluded/backgrounded renderers
    // get throttled or reaped when the window is hidden during headless-ish runs.
    '--disable-component-update', '--disable-background-networking',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ];
  if (HEADLESS) args.push('--headless=new');
  // A CDP browser does not need a starter tab. Keeping the startup window
  // absent avoids both a visible about:blank window and a page target that
  // survives until the idle reaper. Playwright creates the first real page
  // when browser_navigate is forwarded.
  args.push('--no-startup-window');
  log('launching bundled Chrome for Testing on port', PORT, HEADLESS ? '(headless)' : '');
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  let launchError = null;
  child.once('error', (error) => { launchError = error; });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (launchError) break;
    if (await portReady(PORT)) {
      const ownership = await reconcileOwnerWithRetry(2, 50);
      if (ownership.state === 'owned') {
        scheduleBrowserGuardian(ownership.pid);
        log('CDP ready', ownership.pid);
        return;
      }
      try {
        if (process.platform === 'win32' && child.pid) {
          await new Promise((resolve) => execFile('taskkill.exe', ['/PID', String(child.pid), '/T'], { windowsHide: true, timeout: 3000 }, () => resolve()));
        } else if (child.pid) process.kill(child.pid, 'SIGTERM');
      } catch (e) {}
      throw new Error('Agentlas browser started but ownership verification failed (' + ownership.state + ':' + ownership.reason + ').');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Only a genuinely never-ready port reaches here — Chrome did not come up.
  writeBackoff('launch-failed');
  throw new Error('Agentlas Chrome for Testing failed to start' + (launchError ? ': ' + launchError.message : ' on CDP port ' + PORT + '.') + ' Automatic relaunch is paused.');
}

async function ensureChrome() {
  await acquireLaunchLock();
  try { return await ensureChromeUnlocked(); }
  finally { releaseLaunchLock(); }
}

// ── 승인 게이트 ──────────────────────────────────────────────────
${BROWSER_APPROVAL_CLASSIFIER_SOURCE}
${BROWSER_APPROVAL_CONTEXT_SOURCE}
function readCdpPageUrl() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 1200 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { if (body.length < 1024 * 1024) body += chunk; });
      res.on('end', () => { try { resolve(extractCdpPageUrl(JSON.parse(body))); } catch (e) { resolve(''); } });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}
function readApprovalInfo() {
  try { if (!APPROVAL_FILE || !path.isAbsolute(APPROVAL_FILE) || !fs.existsSync(APPROVAL_FILE)) return null; return JSON.parse(fs.readFileSync(APPROVAL_FILE, 'utf8')); } catch (e) { return null; }
}
function requestApproval(site, actionType, summary, signal) {
  return new Promise((resolve) => {
    const autonomy = process.env.AGENTLAS_BROWSER_AUTONOMY || 'gated';
    // trust는 일반 반복 작업만 무인 복구한다. 결제와 임의 코드는 환경값만으로
    // 승인할 수 없는 secure checkpoint이며 승인 UI/서버가 없으면 fail-closed다.
    const trustFallback = autonomy === 'trust' && actionType !== 'payment' && actionType !== 'unsafe-code';
    let req = null;
    let settled = false;
    const finish = (decision) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(decision);
    };
    const onAbort = () => {
      if (req && !req.destroyed) req.destroy();
      finish('cancelled');
    };
    if (signal && signal.aborted) return finish('cancelled');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const info = readApprovalInfo();
    if (!info || !info.port) { log('no approver (app not running); autonomy=' + autonomy + ' action=' + actionType); return finish(trustFallback ? 'approved' : 'denied'); }
    const payload = JSON.stringify({ site, actionType, summary });
    req = http.request({ host: '127.0.0.1', port: info.port, path: '/approve', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'authorization': 'Bearer ' + info.token }, timeout: 125000 }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { finish(JSON.parse(b).decision === 'approved' ? 'approved' : 'denied'); } catch (e) { finish('denied'); } });
    });
    req.on('error', () => finish(signal && signal.aborted ? 'cancelled' : (trustFallback ? 'approved' : 'denied')));
    req.on('timeout', () => { req.destroy(); finish('denied'); });
    req.write(payload); req.end();
  });
}

// ── learn-and-replay 스킬 레이어 ─────────────────────────────────
// 재생/기록 대상 액션 툴(읽기 전용 snapshot/screenshot 등은 제외).
const RECORDABLE = new Set(['browser_navigate', 'browser_navigate_back', 'browser_click', 'browser_type', 'browser_fill', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_hover', 'browser_file_upload', 'browser_drag']);
const SKILL_TOOLS = [
  { name: 'browser_skill_list', description: 'List saved Agentlas browser skills (learned action sequences).', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_skill_save', description: 'Save the actions performed so far in this session as a reusable skill. Use after successfully completing a task (e.g. an Instagram upload) so it can be replayed deterministically next time.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Skill name, e.g. "instagram-upload"' }, description: { type: 'string' } }, required: ['name'] } },
  { name: 'browser_skill_replay', description: 'Replay a previously saved skill by name — re-runs its recorded action sequence deterministically (no reasoning needed).', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
];
function skillPath(name) { return path.join(SKILLS_DIR, String(name).replace(/[^a-zA-Z0-9._-]/g, '_') + '.json'); }
function listSkills() { try { return fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch (e) { return []; } }
function saveSkill(name, steps, description) {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const doc = { name, description: description || '', steps, savedAt: new Date().toISOString() };
  fs.writeFileSync(skillPath(name), JSON.stringify(doc, null, 2));
  return doc;
}
function loadSkill(name) { const p = skillPath(name); if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, 'utf8')); }

async function main() {
  let leaseFile = null;
  let closing = false;
  let browserReadyPromise = null;
  const releaseLeaseOnce = () => {
    closing = true;
    if (!leaseFile) return;
    const currentLease = leaseFile;
    leaseFile = null;
    releaseLease(currentLease);
    scheduleIdleReaper();
  };
  if (!fs.existsSync(PLAYWRIGHT_MCP_CLI)) throw new Error('Bundled Playwright MCP runtime is missing: ' + PLAYWRIGHT_MCP_CLI);
  // MCP hosts frequently start a server only to initialize/list tools. Starting
  // Chrome here created about:blank and a browser root every health-check cycle.
  // Acquire a lease and launch the browser only for the first real browser call.
  const ensureBrowserForTool = () => {
    if (browserReadyPromise) return browserReadyPromise;
    const flight = (async () => {
      const acquiredLease = await acquireLease('mcp');
      if (closing) {
        releaseLease(acquiredLease);
        scheduleIdleReaper();
        throw new Error('Agentlas browser client closed before launch.');
      }
      leaseFile = acquiredLease;
      try {
        await ensureChrome();
        const usage = await enforceBrowserResourceLimits();
        log('resource snapshot', usage.pages + ' pages', usage.renderers + ' renderers', Math.ceil(usage.rssBytes / 1024 / 1024) + 'MB RSS');
        if (closing) throw new Error('Agentlas browser client closed during launch.');
      } catch (error) {
        releaseLeaseOnce();
        throw error;
      }
    })();
    browserReadyPromise = flight;
    return flight;
  };
  // 스크린샷 정본을 os.tmpdir() 기본 출력(리핑됨 + 앱이 서빙 불가) 대신
  // ~/.agentlas/captures/browser 에 남긴다 — 채팅 마크다운 이미지가 렌더되는 경로.
  const OUTPUT_DIR = path.join(os.homedir(), '.agentlas', 'captures', 'browser');
  const child = spawn(process.execPath, [
    PLAYWRIGHT_MCP_CLI,
    '--cdp-endpoint', 'http://127.0.0.1:' + PORT,
    '--output-dir', OUTPUT_DIR,
    '--output-max-size', '268435456',
  ], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.on('error', (e) => {
    releaseLeaseOnce();
    log('failed to start @playwright/mcp', String(e));
    process.exit(1);
  });
  child.on('exit', (code) => {
    releaseLeaseOnce();
    process.exit(code == null ? 0 : code);
  });

  const isClosedPipeError = (error) => {
    const code = error && error.code;
    return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END';
  };
  const observeWritable = (stream, label) => {
    if (!stream || typeof stream.on !== 'function') return;
    stream.on('error', (error) => {
      if (!isClosedPipeError(error)) log(label + ' stream failed', String(error));
    });
  };
  const safeWrite = (stream, value, label) => {
    if (!stream || stream.destroyed || stream.writableEnded || stream.writableFinished || stream.writable === false) return false;
    try {
      stream.write(value, (error) => {
        if (error && !isClosedPipeError(error)) log(label + ' write failed', String(error));
      });
      return true;
    } catch (error) {
      if (!isClosedPipeError(error)) log(label + ' write failed', String(error));
      return false;
    }
  };
  const safeEnd = (stream, label) => {
    if (!stream || stream.destroyed || stream.writableEnded || stream.writableFinished) return;
    try { stream.end(); } catch (error) { if (!isClosedPipeError(error)) log(label + ' end failed', String(error)); }
  };
  observeWritable(process.stdout, 'client stdout');
  observeWritable(child.stdin, 'playwright stdin');

  const recording = [];            // 이 세션에서 성공한 액션 시퀀스
  const pending = new Map();       // client 원본 tools/call: id -> {name, args}
  const waiters = new Map();       // 내부(replay) tools/call: id -> resolve
  ${BROWSER_GATE_LIFECYCLE_SOURCE}
  const gateLifecycle = createGateLifecycle();
  let currentUrl = '';
  let internalSeq = 0;
  const writeOutput = (line) => safeWrite(process.stdout, line + '\n', 'client stdout');
  const writeClient = (obj) => writeOutput(JSON.stringify(obj));
  const forwardRaw = (line) => safeWrite(child.stdin, line + '\n', 'playwright stdin');
  const writeBrowserStartFailure = (id, error) => writeClient({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: 'Agentlas Browser could not start safely: ' + String(error && error.message || error) }],
      isError: true,
    },
  });

  // The generic call_mcp_tool surface does not expose each nested MCP schema
  // to the agent. browser_tabs is naturally a list operation when the
  // action is omitted, while Playwright's raw schema requires action=list.
  // Normalize only that safe, read-only omission so a graph does not turn a
  // harmless tab inspection into a misleading permission failure.
  const normalizeToolArguments = (name, args) => {
    if (name !== 'browser_tabs' || !args || typeof args !== 'object' || Array.isArray(args)) return args || {};
    if (!Object.prototype.hasOwnProperty.call(args, 'action') || args.action == null || args.action === '') {
      return { ...args, action: 'list' };
    }
    return args;
  };

  // 승인 게이트 통과 여부 판정(공유). 통과=null, 거부=사유문자열.
  const gate = async (name, args, signal) => {
    const observedUrl = await readCdpPageUrl();
    const contextUrl = approvalContextUrl(name, args, observedUrl);
    const actionType = classifyAction(name, args, contextUrl);
    if (!actionType) return null;
    // 민감 행동에서 현재 페이지를 확인할 수 없으면 stale currentUrl/권한 캐시로 진행하지 않는다.
    if (!contextUrl) { log('blocked sensitive action: CDP current page unavailable', name); return 'unverified-site'; }
    currentUrl = contextUrl;
    let site = ''; try { site = new URL(contextUrl).host; } catch (e) { site = ''; }
    if (!site) { log('blocked sensitive action: invalid approval URL', contextUrl); return 'unverified-site'; }
    const detail = actionType === 'unsafe-code'
      ? String(args.function || args.code || args.filename || name).slice(0, 240)
      : (args.element || args.url || args.key || name);
    const decision = await requestApproval(site, actionType, actionType + ': ' + detail, signal);
    return decision === 'approved' ? null : (decision === 'cancelled' ? 'cancelled' : actionType);
  };

  // 내부에서 child 에 tools/call 을 보내고 응답을 받는다(replay 용).
  const callChild = (name, args) => new Promise((resolve) => {
    const id = 'agx-' + (++internalSeq);
    waiters.set(id, resolve);
    forwardRaw(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: normalizeToolArguments(name, args) } }));
  });

  const doReplay = async (name, replyId) => {
    const skill = loadSkill(name);
    if (!skill) { writeClient({ jsonrpc: '2.0', id: replyId, result: { content: [{ type: 'text', text: 'Skill not found: ' + name }], isError: true } }); return; }
    const results = [];
    for (const step of (skill.steps || [])) {
      const denied = await gate(step.name, step.arguments || {});
      if (denied) { results.push(step.name + ': BLOCKED(' + denied + ')'); writeClient({ jsonrpc: '2.0', id: replyId, result: { content: [{ type: 'text', text: 'Replay stopped — ' + denied + ' action needs approval. Trust mode may continue ordinary actions, but payment and arbitrary code always require explicit approval.' }], isError: true } }); return; }
      if (step.name === 'browser_navigate' && step.arguments && step.arguments.url) currentUrl = String(step.arguments.url);
      const resp = await callChild(step.name, step.arguments || {});
      const isErr = resp && resp.result && resp.result.isError;
      results.push(step.name + (isErr ? ': error' : ': ok'));
      if (isErr) { writeClient({ jsonrpc: '2.0', id: replyId, result: { content: [{ type: 'text', text: 'Replay failed at ' + step.name + '. The page may have changed — re-explore and re-save the skill.\n' + results.join('\n') }], isError: true } }); return; }
    }
    writeClient({ jsonrpc: '2.0', id: replyId, result: { content: [{ type: 'text', text: 'Replayed skill "' + name + '" (' + (skill.steps || []).length + ' steps):\n' + results.join('\n') }] } });
  };

  // client → child 방향
  const handleClientLine = (line) => {
    if (!line.trim()) { forwardRaw(line); return; }
    let msg; try { msg = JSON.parse(line); } catch (e) { forwardRaw(line); return; }
    const cancelledId = cancelledRequestId(msg);
    if (cancelledId != null && gateLifecycle.cancel(cancelledId)) {
      log('cancelled approval-gated browser action before forwarding', String(cancelledId));
      return;
    }
    if (msg && msg.method === 'tools/call' && msg.params) {
      const name = msg.params.name || '';
      const originalArgs = msg.params.arguments || {};
      const args = normalizeToolArguments(name, originalArgs);
      const forwardedLine = args === originalArgs
        ? line
        : JSON.stringify({ ...msg, params: { ...msg.params, arguments: args } });
      // 스킬 툴은 로컬 처리(child 로 안 보냄).
      if (name === 'browser_skill_list') { writeClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(listSkills()) }] } }); return; }
      if (name === 'browser_skill_save') {
        try { const doc = saveSkill(args.name, recording.slice(), args.description); writeClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Saved skill "' + doc.name + '" with ' + doc.steps.length + ' steps → ' + skillPath(doc.name) }] } }); }
        catch (e) { writeClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Save failed: ' + String(e) }], isError: true } }); }
        return;
      }
      void ensureBrowserForTool().then(() => {
        if (closing) return;
        if (name === 'browser_skill_replay') { void doReplay(args.name, msg.id); return; }
        // 일반 액션: CDP의 실제 현재 페이지를 다시 읽은 뒤 승인 게이트 + 기록.
        const gateable = RECORDABLE.has(name) || name === 'browser_handle_dialog' || name === 'browser_evaluate' || name === 'browser_run_code' || name === 'browser_run_code_unsafe';
        if (gateable) {
          const controller = gateLifecycle.begin(msg.id);
          gate(name, args, controller.signal).then((denied) => {
            if (!gateLifecycle.settle(msg.id, controller)) return;
            if (denied) { writeClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'DENIED: The user declined this ' + denied + ' browser action. The action was not executed. Do not say approval is still pending and do not retry it in this run.' }], isError: true } }); return; }
            if (name === 'browser_navigate' && args.url) currentUrl = String(args.url);
            if (RECORDABLE.has(name)) pending.set(msg.id, { name, arguments: args });
            forwardRaw(forwardedLine);
          }).catch((error) => {
            if (!gateLifecycle.settle(msg.id, controller)) return;
            writeClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Browser approval gate failed safely: ' + String(error) }], isError: true } });
          });
          return;
        }
        if (RECORDABLE.has(name)) pending.set(msg.id, { name, arguments: args });
        forwardRaw(forwardedLine);
      }).catch((error) => writeBrowserStartFailure(msg.id, error));
      return;
    }
    forwardRaw(line);
  };

  // child → client 방향 (응답 가로채기: replay waiter / 기록 / tools/list 주입)
  const handleChildLine = (line) => {
    if (!line.trim()) { writeOutput(line); return; }
    let msg; try { msg = JSON.parse(line); } catch (e) { writeOutput(line); return; }
    // 내부 replay 응답 → waiter 로, client 로는 안 보냄.
    if (msg && typeof msg.id === 'string' && waiters.has(msg.id)) { const r = waiters.get(msg.id); waiters.delete(msg.id); r(msg); return; }
    // client 원본 액션 응답 → 성공 시 기록.
    if (msg && msg.id != null && pending.has(msg.id)) {
      const call = pending.get(msg.id); pending.delete(msg.id);
      const isErr = msg.result && msg.result.isError;
      if (!isErr && !msg.error) recording.push(call);
    }
    // tools/list 응답 → 스킬 툴 주입.
    if (msg && msg.result && Array.isArray(msg.result.tools)) {
      const have = new Set(msg.result.tools.map((t) => t.name));
      for (const st of SKILL_TOOLS) if (!have.has(st.name)) msg.result.tools.push(st);
      writeClient(msg); return;
    }
    writeOutput(line);
  };

  let cbuf = '';
  child.stdout.on('data', (chunk) => {
    cbuf += chunk.toString('utf8'); let i;
    while ((i = cbuf.indexOf('\n')) >= 0) { const line = cbuf.slice(0, i); cbuf = cbuf.slice(i + 1); handleChildLine(line); }
  });
  let buf = '';
  process.stdin.on('data', (chunk) => {
    buf += chunk.toString('utf8'); let idx;
    while ((idx = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, idx); buf = buf.slice(idx + 1); handleClientLine(line); }
  });
  process.stdin.on('end', () => {
    gateLifecycle.cancelAll();
    closing = true;
    safeEnd(child.stdin, 'playwright stdin');
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (e) {} }, 1500);
    timer.unref();
  });
  const stopForSignal = (exitCode) => {
    gateLifecycle.cancelAll();
    safeEnd(child.stdin, 'playwright stdin');
    try { child.kill('SIGTERM'); } catch (e) {}
    releaseLeaseOnce();
    const timer = setTimeout(() => process.exit(exitCode), 100);
    timer.unref();
  };
  process.once('SIGINT', () => stopForSignal(130));
  process.once('SIGTERM', () => stopForSignal(143));
}
if (process.argv[2] === '--agentlas-cdp-reap') {
  reapIdleBrowser().then(
    () => process.exit(0),
    (e) => { console.error('[agentlas-browser] idle reaper failed', e && e.stack || e); process.exit(1); },
  );
} else if (process.argv[2] === '--agentlas-cdp-guard') {
  guardOwnedBrowser(Number(process.argv[3]), Number(process.argv[4])).then(
    () => process.exit(0),
    (e) => { console.error('[agentlas-browser] guardian failed', e && e.stack || e); process.exit(1); },
  );
} else {
  main().catch((e) => { console.error('[agentlas-browser] fatal', e && e.stack || e); process.exit(1); });
}
`;
  return LAUNCHER_SOURCE;
}

type LauncherRuntimeContext = {
  source: string;
  isPackaged: boolean;
};

function resolveLauncherContext(): LauncherRuntimeContext {
  const CURRENT_BROWSER_RUNTIME = resolveAgentlasBrowserRuntime();
  return {
    source: createLauncherSource(CURRENT_BROWSER_RUNTIME),
    isPackaged: CURRENT_BROWSER_RUNTIME?.source === "packaged",
  };
}

/** Regression-only source view; does not materialize or launch Chrome. */
export function browserCdpLauncherSourceForTest(): string {
  return resolveLauncherContext().source;
}

/**
 * Desktop이 비동일 공용 런처를 교체해도 되는지 판정한다.
 *
 * 같은 Desktop 계약도 갱신한다. 생성된 소스에는 현재 앱의 Playwright와 번들 Chromium
 * 경로가 결합되므로, 이전 설치나 개발 checkout이 만든 파일을 유지하면 소유권 검증이
 * 실패하고 마지막 lease 뒤 브라우저가 남는다. 같은 계약의 다른 writer와 더 높은 계약은
 * 덮지 않아 Desktop/Core 간 write oscillation을 막는다.
 */
function shouldReplaceBrowserCdpLauncherWithContext(
  existing: string | null,
  candidateIsPackaged: boolean,
  LAUNCHER_SOURCE: string,
): boolean {
  // Never publish a launcher that is already known to be unusable. This is
  // especially important in development, where a transient cross-arch build
  // resource used to overwrite the installed application's healthy launcher.
  if (!hasUsableLauncherRuntimeBindings(LAUNCHER_SOURCE)) return false;
  if (existing === null) return true;
  if (existing === LAUNCHER_SOURCE) return false;
  const installed = readLauncherContractVersion(existing);
  const installedWriter = readLauncherWriter(existing);

  // A same-writer file with dead absolute bindings is not a valid newer
  // contract. A packaged Desktop must always be able to repair it. A
  // development build may repair an already-broken file, but it may never
  // replace a healthy shared production launcher merely to test newer code.
  if (installedWriter === BROWSER_CDP_LAUNCHER_WRITER) {
    if (!hasUsableLauncherRuntimeBindings(existing)) return true;
    if (!candidateIsPackaged) return false;
  }
  if (installed === null || installed < BROWSER_CDP_LAUNCHER_CONTRACT) return true;
  if (installed > BROWSER_CDP_LAUNCHER_CONTRACT) return false;
  return installedWriter === BROWSER_CDP_LAUNCHER_WRITER;
}

export function shouldReplaceBrowserCdpLauncher(
  existing: string | null,
  candidateIsPackaged?: boolean,
): boolean {
  const context = resolveLauncherContext();
  return shouldReplaceBrowserCdpLauncherWithContext(
    existing,
    candidateIsPackaged ?? context.isPackaged,
    context.source,
  );
}

/**
 * 런처 소스를 ~/.agentlas/agentlas-browser-cdp.mjs 로 쓴다(멱등, 내용 바뀌면 갱신).
 * ensureDefaultMcpPluginsInstalled 에서 부팅 시 호출.
 */
export function materializeBrowserCdpLauncher(): string {
  const dest = browserCdpLauncherPath();
  try {
    const context = resolveLauncherContext();
    const LAUNCHER_SOURCE = context.source;
    const shouldReplaceBrowserCdpLauncher = (existing: string | null): boolean =>
      shouldReplaceBrowserCdpLauncherWithContext(existing, context.isPackaged, LAUNCHER_SOURCE);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const existing = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;
    if (existing === LAUNCHER_SOURCE) return dest;
    // 더 높은 계약과 같은 번호의 다른 writer는 보존한다. 같은 Desktop 계약은
    // 현재 설치 앱의 런타임 경로로 다시 결합해야 업그레이드 뒤 회수기가 동작한다.
    const installed = existing ? readLauncherContractVersion(existing) : null;
    if (!shouldReplaceBrowserCdpLauncher(existing)) {
      console.warn(
        `[agentlas-browser] keeping installed launcher (contract ${installed ?? "unmarked"}, writer ${existing ? readLauncherWriter(existing) ?? "unknown" : "none"})`,
      );
      return dest;
    }
    fs.writeFileSync(dest, LAUNCHER_SOURCE, "utf8");
  } catch (err) {
    console.error("[agentlas-browser] materialize failed:", err);
  }
  return dest;
}
