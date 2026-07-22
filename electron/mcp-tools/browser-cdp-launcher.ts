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
import { execFile } from "node:child_process";
import { BROWSER_APPROVAL_FILE_ENV } from "../browser/approval-channel";

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
  const pathApi = platform === "win32" ? path.win32 : path;
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      pathApi.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (platform === "win32") {
    const lad = env.LOCALAPPDATA || pathApi.join(home, "AppData", "Local");
    const pf = env.PROGRAMFILES || "C:\\Program Files";
    const pfx = env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    return [
      pathApi.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      pathApi.join(pfx, "Google", "Chrome", "Application", "chrome.exe"),
      pathApi.join(lad, "Google", "Chrome", "Application", "chrome.exe"),
      pathApi.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      pathApi.join(pfx, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  }
  if (platform === "linux") {
    return [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/usr/lib/chromium/chromium",
      "/usr/lib/chromium-browser/chromium-browser",
      "/opt/microsoft/msedge/msedge",
      "/usr/lib/microsoft-edge/msedge",
    ];
  }
  return [];
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

/** 플랫폼별 Chrome 실행 파일 경로 해석(없으면 null). Edge 폴백 포함. */
export function resolveChromeExe(): string | null {
  return browserCdpExecutableCandidates().find((candidate) => fs.existsSync(candidate)) || null;
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

  if (name === 'browser_run_code' || name === 'browser_run_code_unsafe') return 'unsafe-code';

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
  const home = os.homedir();
  if (process.platform === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  if (process.platform === 'win32') {
    const lad = process.env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
    const pfx = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    return [
      path.win32.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.win32.join(pfx, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.win32.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.win32.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.win32.join(pfx, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
  }
  if (process.platform === 'linux') return [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
    '/usr/lib/chromium/chromium', '/usr/lib/chromium-browser/chromium-browser',
    '/opt/microsoft/msedge/msedge', '/usr/lib/microsoft-edge/msedge',
  ];
  return [];
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

const LAUNCHER_SOURCE = String.raw`#!/usr/bin/env node
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
const HEADLESS = String(process.env.AGENTLAS_CDP_HEADLESS || '').toLowerCase() === '1';
const SKILLS_DIR = process.env.AGENTLAS_BROWSER_SKILLS_DIR || path.join(os.homedir(), '.agentlas', 'browser-skills');
const APPROVAL_FILE = process.env.${BROWSER_APPROVAL_FILE_ENV} || '';
const PLAYWRIGHT_MCP_CLI = ${JSON.stringify(playwrightMcpCliPath())};
const log = (...a) => console.error('[agentlas-browser]', ...a);

function chromeInfo() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const exes = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    return { exe: exes.find(fs.existsSync) || exes[0] };
  }
  if (process.platform === 'win32') {
    const lad = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const exes = [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    return { exe: exes.find(fs.existsSync) || exes[0] };
  }
  const exes = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return { exe: exes.find(fs.existsSync) || exes[0] };
}

function portReady(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1200 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

${BROWSER_CDP_OWNERSHIP_RUNTIME_SOURCE}

async function ensureChrome() {
  ensurePrivateProfile();
  if (await portReady(PORT)) {
    const ownership = await reconcileOwnerWithRetry();
    if (ownership.state === 'owned') { log('owned CDP already up on', PORT, ownership.adopted ? '(adopted)' : ''); return; }
    // The user drives this app; an in-app browser that refuses to open because
    // ownership could not be re-verified is a dead end, not safety. The port is
    // the dedicated Agentlas debugging port on loopback — use it and warn.
    log('WARN using existing CDP listener on', PORT, 'despite unverified ownership (' + ownership.state + ':' + ownership.reason + ')');
    return;
  }
  const { exe } = chromeInfo();
  if (!fs.existsSync(exe)) throw new Error('Google Chrome executable could not be found: ' + exe);
  // Never copy a live everyday-Chrome profile: SQLite/WAL files can be inconsistent while Chrome
  // is running, and copying cookies/password stores would violate the dedicated-profile boundary.
  // Users sign in directly in the Agentlas window; that dedicated profile is then reused as-is.
  log('using persistent Agentlas dedicated profile (no personal-profile import)');
  const args = [
    '--user-data-dir=' + CDP_PROFILE, '--remote-debugging-port=' + PORT,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--restore-last-session=false',
    '--disable-session-crashed-bubble', '--disable-features=Translate',
  ];
  if (HEADLESS) args.push('--headless=new');
  args.push('about:blank');
  log('launching Chrome on port', PORT, HEADLESS ? '(headless)' : '');
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await portReady(PORT)) {
      const ownership = await reconcileOwnerWithRetry(2, 50);
      if (ownership.state === 'owned') { log('CDP ready', ownership.pid); return; }
      // We just launched Chrome ourselves against the dedicated profile/port on
      // loopback. If ownership can't be re-verified, proceed anyway — blocking
      // here only breaks the browser the user asked to use.
      log('WARN CDP ready but ownership unverified (' + ownership.state + ':' + ownership.reason + '); proceeding');
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Only a genuinely never-ready port reaches here — Chrome did not come up.
  throw new Error('Chrome CDP port ' + PORT + ' never became ready.');
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
  await ensureChrome();
  if (!fs.existsSync(PLAYWRIGHT_MCP_CLI)) throw new Error('Bundled Playwright MCP runtime is missing: ' + PLAYWRIGHT_MCP_CLI);
  const child = spawn(process.execPath, [PLAYWRIGHT_MCP_CLI, '--cdp-endpoint', 'http://127.0.0.1:' + PORT], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.on('error', (e) => { log('failed to start @playwright/mcp', String(e)); process.exit(1); });
  child.on('exit', (code) => process.exit(code == null ? 0 : code));

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
      ? String(args.code || args.filename || name).slice(0, 240)
      : (args.element || args.url || args.key || name);
    const decision = await requestApproval(site, actionType, actionType + ': ' + detail, signal);
    return decision === 'approved' ? null : (decision === 'cancelled' ? 'cancelled' : actionType);
  };

  // 내부에서 child 에 tools/call 을 보내고 응답을 받는다(replay 용).
  const callChild = (name, args) => new Promise((resolve) => {
    const id = 'agx-' + (++internalSeq);
    waiters.set(id, resolve);
    forwardRaw(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
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
      const args = msg.params.arguments || {};
      // 스킬 툴은 로컬 처리(child 로 안 보냄).
      if (name === 'browser_skill_list') { writeClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(listSkills()) }] } }); return; }
      if (name === 'browser_skill_save') {
        try { const doc = saveSkill(args.name, recording.slice(), args.description); writeClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Saved skill "' + doc.name + '" with ' + doc.steps.length + ' steps → ' + skillPath(doc.name) }] } }); }
        catch (e) { writeClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Save failed: ' + String(e) }], isError: true } }); }
        return;
      }
      if (name === 'browser_skill_replay') { doReplay(args.name, msg.id); return; }
      // 일반 액션: CDP의 실제 현재 페이지를 다시 읽은 뒤 승인 게이트 + 기록.
      const gateable = RECORDABLE.has(name) || name === 'browser_handle_dialog' || name === 'browser_run_code' || name === 'browser_run_code_unsafe';
      if (gateable) {
        const controller = gateLifecycle.begin(msg.id);
        gate(name, args, controller.signal).then((denied) => {
          if (!gateLifecycle.settle(msg.id, controller)) return;
          if (denied) { writeClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'BLOCKED: The user did not approve this ' + denied + ' browser action.' }], isError: true } }); return; }
          if (name === 'browser_navigate' && args.url) currentUrl = String(args.url);
          if (RECORDABLE.has(name)) pending.set(msg.id, { name, arguments: args });
          forwardRaw(line);
        }).catch((error) => {
          if (!gateLifecycle.settle(msg.id, controller)) return;
          writeClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Browser approval gate failed safely: ' + String(error) }], isError: true } });
        });
        return;
      }
      if (RECORDABLE.has(name)) pending.set(msg.id, { name, arguments: args });
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
  process.stdin.on('end', () => { gateLifecycle.cancelAll(); safeEnd(child.stdin, 'playwright stdin'); });
}
main().catch((e) => { console.error('[agentlas-browser] fatal', e && e.stack || e); process.exit(1); });
`;

/** Regression-only source view; does not materialize or launch Chrome. */
export function browserCdpLauncherSourceForTest(): string {
  return LAUNCHER_SOURCE;
}

/**
 * 런처 소스를 ~/.agentlas/agentlas-browser-cdp.mjs 로 쓴다(멱등, 내용 바뀌면 갱신).
 * ensureDefaultMcpPluginsInstalled 에서 부팅 시 호출.
 */
export function materializeBrowserCdpLauncher(): string {
  const dest = browserCdpLauncherPath();
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const existing = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;
    if (existing !== LAUNCHER_SOURCE) fs.writeFileSync(dest, LAUNCHER_SOURCE, "utf8");
  } catch (err) {
    console.error("[agentlas-browser] materialize failed:", err);
  }
  return dest;
}
