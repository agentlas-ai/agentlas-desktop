// 스폰 원장 — 우리가 띄운 LLM 실행 자식(CLI/MCP 트리)을 **프로세스 밖에** 기록한다.
//
// ★왜 있나. exec.ts 의 liveRunChildren 은 인메모리라, 호스트(앱/데몬)가 크래시하면
// 그 목록과 함께 사라진다 — 자식 CLI·손자 MCP 서버는 살아남아 고아가 된다. 정상 종료는
// host-lifecycle 훅이 정리하지만, SIGKILL·패닉·전원 차단은 훅이 돌 기회 자체가 없다.
// 그래서 스폰 사실을 userData 아래 파일로 남기고, 데몬 스위퍼가 주기적으로
// "호스트는 죽었는데 자식은 살아 있는" 항목을 수거한다.
//
// 형태: 레코드당 파일 하나(run-children/<pid>.json). JSONL 한 파일로 하면 여러 프로세스
// (앱+데몬)가 동시에 append/rewrite 하다 서로의 레코드를 지운다 — 파일 단위면 쓰기가
// 원자적이고(임시파일+rename 불필요, 내용이 한 JSON), 삭제 경합도 무해하다.
//
// 식별 방어: PID 는 재사용된다. POSIX는 스폰 직후 실제 실행 파일·생성 식별자·PGID를
// 기록하고 종료 직전에 재확인한다. 이전 원장/조회 실패는 종료 권한이 아니다.
// spawnCli 가 심는 AGENTLAS_SPAWN_MARKER env 는 사람이 ps 로 볼 때의 표식이고,
// 기계 판정은 OS 생성 정체로 한다(macOS ps 는 남의 env 를 안 보여 주므로 env 는
// 교차검증 수단이 못 된다 — 있다고 가정하고 안 보이면 죽이는 쪽이 더 위험하다).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { userDataPath } from "../runtime-paths";

/** spawnCli 가 자식 env 에 심는 표식 키. 값은 "agentlas:<호스트 PID>". */
export const AGENTLAS_SPAWN_MARKER_ENV = "AGENTLAS_SPAWN_MARKER";

export interface SpawnRecord {
  pid: number;
  hostPid: number;
  /** 스폰한 실행 파일 — 죽이기 전 PID 재사용 방어에 쓴다. */
  spawnfile: string;
  at: string;
  recordId?: string;
  posixIdentity?: PosixProcessIdentity;
  /** 스위퍼가 SIGTERM 을 이미 보냈다면 그 시각(ms epoch) — 다음 패스에 SIGKILL 승격. */
  termSignaledAt?: number;
}

function registryDir(): string {
  return userDataPath("run-children");
}

function recordPath(pid: number): string {
  return path.join(registryDir(), `${pid}.json`);
}

const intendedSpawnCommands = new WeakMap<ChildProcess, string>();

/** Preserve the requested executable without persisting prompts or other argv. */
export function rememberSpawnedRunChildCommand(child: ChildProcess, command: string): void {
  if (command.trim()) intendedSpawnCommands.set(child, command);
}

/**
 * 스폰 직후 원장에 적는다. 자식이 정상 종료하면 스스로 지운다 — 남는 파일은
 * (a) 아직 도는 자식이거나 (b) 호스트가 급사해 close 훅이 못 돈 흔적이다.
 * 원장 실패는 실행을 막지 않는다(원장은 안전망이지 게이트가 아니다).
 */
export function recordSpawnedRunChild(child: ChildProcess): void {
  const pid = child.pid;
  if (pid == null) return;
  let record: SpawnRecord;
  try {
    record = {
      pid,
      hostPid: process.pid,
      // Requested command differs from cmd.exe for Windows .cmd shims.
      spawnfile: intendedSpawnCommands.get(child) ?? child.spawnfile ?? "",
      at: new Date().toISOString(),
      recordId: randomUUID(),
    };
    fs.mkdirSync(registryDir(), { recursive: true });
    fs.writeFileSync(recordPath(pid), JSON.stringify(record), "utf8");
  } catch {
    // userDataDir 미주입(순수 단위 테스트) 또는 디스크 문제 — 안전망만 빠질 뿐이다.
    return;
  }
  let closed = false;
  const stillOwnsRecord = (): boolean => {
    try {
      return JSON.parse(fs.readFileSync(recordPath(pid), "utf8")).recordId === record.recordId;
    } catch { return false; }
  };
  const forget = (): void => {
    closed = true;
    try {
      if (stillOwnsRecord()) fs.rmSync(recordPath(pid), { force: true });
    } catch {
      /* best-effort */
    }
  };
  child.once("close", forget);
  child.once("error", forget);
  if (process.platform !== "win32") {
    // One bounded metadata lookup per spawn; never persist prompts or argv.
    void posixProcessIdentityOf(pid).then((identity) => {
      if (closed || !identity || identity.parentProcessId !== process.pid || !stillOwnsRecord()) return;
      try {
        fs.writeFileSync(recordPath(pid), JSON.stringify({ ...record, posixIdentity: identity }), "utf8");
      } catch { /* Missing attestation deliberately leaves a non-signallable record. */ }
    }).catch(() => { /* Fail closed; the run itself remains usable. */ });
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 살아 있으나 남의 프로세스(우리 자식은 같은 사용자라 나올 일이 없지만,
    // PID 재사용으로 root 프로세스가 그 자리를 차지했을 수 있다 → "살아 있음"으로 두고
    // 아래 커맨드 검증에서 걸러 절대 죽이지 않는다).
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface PosixProcessIdentity {
  processId: number;
  parentProcessId: number;
  processGroupId: number;
  executablePath: string;
  birthIdentity: string;
}

function validPosixIdentity(value: PosixProcessIdentity | undefined): value is PosixProcessIdentity {
  return Boolean(value && Number.isInteger(value.processId) && value.processId > 1
    && Number.isInteger(value.parentProcessId) && value.parentProcessId >= 0
    && Number.isInteger(value.processGroupId) && value.processGroupId > 1
    && typeof value.executablePath === "string" && path.isAbsolute(value.executablePath)
    && typeof value.birthIdentity === "string" && value.birthIdentity.length > 0);
}

function metadataPs(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", args, { timeout: 3_000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout) => resolve(error ? null : stdout));
  });
}

async function posixProcessIdentityOf(pid: number): Promise<PosixProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (process.platform === "linux") {
    try {
      // /proc start ticks plus boot UUID distinguish PID reuse across restarts.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (!/^[a-f0-9-]{36}$/i.test(bootId) || !/^\d+$/.test(fields[19] ?? "")) return null;
      const identity: PosixProcessIdentity = {
        processId: pid, parentProcessId: Number(fields[1]), processGroupId: Number(fields[2]),
        executablePath: fs.readlinkSync(`/proc/${pid}/exe`), birthIdentity: `linux:${bootId}:${fields[19]}`,
      };
      return validPosixIdentity(identity) ? identity : null;
    } catch { return null; }
  }
  if (process.platform !== "darwin") return null;
  // macOS comm is the executable path, not command/argv; lstart has second precision.
  const stdout = await metadataPs(["-ww", "-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart=,comm="]);
  const match = stdout?.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!match || Number(match[1]) !== pid) return null;
  const identity: PosixProcessIdentity = {
    processId: pid, parentProcessId: Number(match[2]), processGroupId: Number(match[3]),
    birthIdentity: `darwin:${match[4].replace(/\s+/g, " ")}`, executablePath: match[5],
  };
  return validPosixIdentity(identity) ? identity : null;
}

function posixIdentityMatches(record: SpawnRecord, identity: PosixProcessIdentity): boolean {
  const captured = record.posixIdentity;
  return validPosixIdentity(captured) && validPosixIdentity(identity)
    && captured.processId === record.pid && identity.processId === record.pid
    && captured.parentProcessId === record.hostPid
    && captured.executablePath === identity.executablePath
    && captured.birthIdentity === identity.birthIdentity
    && captured.processGroupId === record.pid && identity.processGroupId === record.pid;
}

async function protectedPosixProcesses(): Promise<{ pids: Set<number>; groups: Set<number> } | null> {
  // Query only numeric metadata, once per nonempty orphan sweep, never argv/env.
  const stdout = await metadataPs(["-axo", "pid=,ppid=,pgid="]);
  if (stdout == null) return null;
  const rows = new Map<number, { parent: number; group: number }>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (match) rows.set(Number(match[1]), { parent: Number(match[2]), group: Number(match[3]) });
  }
  const pids = new Set<number>(), groups = new Set<number>();
  let pid = process.pid;
  for (let depth = 0; pid > 0 && depth < 128; depth += 1) {
    if (pids.has(pid)) return null;
    pids.add(pid);
    const row = rows.get(pid);
    if (!row) return null;
    groups.add(row.group);
    if (pid === 1 || row.parent === 0) return { pids, groups };
    pid = row.parent;
  }
  return null;
}

export interface WindowsProcessIdentity {
  processId: number;
  executablePath: string;
  commandLine: string;
  creationTime: string;
}

function normalizeWindowsPath(value: string): string {
  return value.trim().replace(/^"|"$/g, "").replace(/\//g, "\\").toLowerCase();
}

function windowsTokenPresent(commandLine: string, expected: string): boolean {
  if (!expected) return false;
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A bare registered command (for example `claude.cmd`) can appear as the
  // basename of an absolute path in cmd.exe's command line.
  return new RegExp(`(^|[\\s"\\\\])${escaped}(?=$|[\\s"])`, "i").test(commandLine);
}

/**
 * PID 재사용 방어용 순수 판정. 실행 파일/커맨드라인뿐 아니라 프로세스 생성 시각이
 * 원장 기록 시각과 가까운지도 요구한다. 같은 이름의 프로세스가 나중에 같은 PID를
 * 재사용해도 죽이지 않기 위해서다.
 */
export function windowsProcessIdentityMatches(
  record: SpawnRecord,
  identity: WindowsProcessIdentity,
): boolean {
  if (identity.processId !== record.pid) return false;
  const recordedAt = Date.parse(record.at);
  const createdAt = Date.parse(identity.creationTime);
  if (!Number.isFinite(recordedAt) || !Number.isFinite(createdAt)) return false;
  if (Math.abs(createdAt - recordedAt) > 10_000) return false;

  const expected = normalizeWindowsPath(record.spawnfile || "");
  if (!expected) return false;
  const actualExecutable = normalizeWindowsPath(identity.executablePath || "");
  const commandLine = normalizeWindowsPath(identity.commandLine || "");
  if (path.win32.isAbsolute(expected)) {
    return actualExecutable === expected || windowsTokenPresent(commandLine, expected);
  }
  const expectedBase = path.win32.basename(expected);
  const actualBase = path.win32.basename(actualExecutable);
  const hasKnownExtension = /\.(?:exe|cmd|bat|com)$/i.test(expectedBase);
  const candidates = hasKnownExtension
    ? [expectedBase]
    : [expectedBase, `${expectedBase}.exe`, `${expectedBase}.cmd`, `${expectedBase}.bat`, `${expectedBase}.com`];
  return candidates.some((candidate) => actualBase === candidate || windowsTokenPresent(commandLine, candidate));
}

// Keep `powershell.exe -Command` comfortably below Windows' command-line
// ceiling even if a damaged/stale ledger contains thousands of records.
// 128 maximum-width decimal PIDs produce a script under 4 KiB.
export const WINDOWS_CIM_PID_CHUNK_SIZE = 128;

function normalizedWindowsProcessIds(pids: readonly number[]): number[] {
  return [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
}

function buildWindowsProcessIdentityScriptForChunk(pids: readonly number[]): string {
  const filter = pids.map((pid) => `ProcessId = ${pid}`).join(" OR ");
  return [
    `$items = @(Get-CimInstance Win32_Process -Filter \"${filter}\" | ForEach-Object {`,
    "  $created = $_.CreationDate.ToUniversalTime().ToString('o')",
    "  [pscustomobject]@{ processId = [int]$_.ProcessId; executablePath = [string]$_.ExecutablePath; commandLine = [string]$_.CommandLine; creationTime = $created }",
    "})",
    "ConvertTo-Json -InputObject @($items) -Compress",
  ].join("\n");
}

/** Build bounded numeric-only WQL queries for all orphan candidates. */
export function buildWindowsProcessIdentityScripts(pids: readonly number[]): string[] {
  const uniquePids = normalizedWindowsProcessIds(pids);
  const scripts: string[] = [];
  for (let offset = 0; offset < uniquePids.length; offset += WINDOWS_CIM_PID_CHUNK_SIZE) {
    scripts.push(buildWindowsProcessIdentityScriptForChunk(
      uniquePids.slice(offset, offset + WINDOWS_CIM_PID_CHUNK_SIZE),
    ));
  }
  return scripts;
}

/** ConvertTo-Json emits either an array or a single object depending on PowerShell version. */
export function parseWindowsProcessIdentities(stdout: string): Map<number, WindowsProcessIdentity> {
  return decodeWindowsProcessIdentities(stdout) ?? new Map();
}

function decodeWindowsProcessIdentities(stdout: string): Map<number, WindowsProcessIdentity> | null {
  const identities = new Map<number, WindowsProcessIdentity>();
  if (!stdout.trim()) return null;
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (!Array.isArray(parsed) && (!parsed || typeof parsed !== "object")) return null;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== "object") return null;
      const candidate = item as Partial<WindowsProcessIdentity>;
      if (
        !Number.isInteger(candidate.processId) || Number(candidate.processId) <= 0 ||
        typeof candidate.executablePath !== "string" ||
        typeof candidate.commandLine !== "string" ||
        typeof candidate.creationTime !== "string"
      ) return null;
      identities.set(Number(candidate.processId), candidate as WindowsProcessIdentity);
    }
  } catch {
    return null;
  }
  return identities;
}

export interface WindowsProcessIdentityLookupResult {
  identities: Map<number, WindowsProcessIdentity>;
  /** A failed/timed-out chunk is retryable; its ledger records must survive. */
  failedPids: Set<number>;
}

export type WindowsProcessIdentityLookupState =
  | { status: "found"; identity: WindowsProcessIdentity }
  | { status: "missing" }
  | { status: "failed" };

export function classifyWindowsProcessIdentityLookup(
  lookup: WindowsProcessIdentityLookupResult,
  pid: number,
): WindowsProcessIdentityLookupState {
  if (lookup.failedPids.has(pid)) return { status: "failed" };
  const identity = lookup.identities.get(pid);
  return identity ? { status: "found", identity } : { status: "missing" };
}

function executeWindowsProcessIdentityQuery(script: string): Promise<Map<number, WindowsProcessIdentity> | null> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 5_000, windowsHide: true, encoding: "utf8" },
      (error, stdout) => resolve(error ? null : decodeWindowsProcessIdentities(stdout)),
    );
  });
}

async function windowsProcessIdentitiesOf(pids: readonly number[]): Promise<WindowsProcessIdentityLookupResult> {
  const uniquePids = normalizedWindowsProcessIds(pids);
  const identities = new Map<number, WindowsProcessIdentity>();
  const failedPids = new Set<number>();
  for (let offset = 0; offset < uniquePids.length; offset += WINDOWS_CIM_PID_CHUNK_SIZE) {
    const chunkPids = uniquePids.slice(offset, offset + WINDOWS_CIM_PID_CHUNK_SIZE);
    const chunk = await executeWindowsProcessIdentityQuery(
      buildWindowsProcessIdentityScriptForChunk(chunkPids),
    );
    if (!chunk) {
      for (const pid of chunkPids) failedPids.add(pid);
      continue;
    }
    for (const [pid, identity] of chunk) identities.set(pid, identity);
  }
  return { identities, failedPids };
}

function taskkillWindowsTree(pid: number, force: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
      { timeout: 5_000, windowsHide: true },
      (error) => resolve(!error),
    );
  });
}

export interface OrphanSweepResult {
  scanned: number;
  /** 이번 패스에 SIGTERM/SIGKILL 을 보낸 고아 수. */
  signaled: number;
  /** 자식이 이미 죽어 있어 지운 레코드 수. */
  prunedDead: number;
  /** 호스트가 살아 있어 그대로 둔 수. */
  keptLive: number;
  /** PID 재사용 의심으로 죽이지 않고 지운 수. */
  prunedMismatched: number;
  /** 조회 실패/이전 POSIX 원장 등 종료 정체를 증명하지 못해 보존한 수. */
  identityLookupFailed: number;
}

/**
 * 고아 수거 한 패스. 데몬의 keepAlive 스위퍼가 주기적으로 부른다.
 *
 * 규칙:
 *  - 자식 PID 가 죽었으면 레코드만 지운다.
 *  - 호스트 PID 가 살아 있으면 손대지 않는다(그 호스트의 host-lifecycle 이 주인이다).
 *  - POSIX는 스폰 때 기록한 실행 파일·생성 식별자·독립 PGID를 종료 직전에 확인한다.
 *    self/조상 프로세스·그 그룹은 제외한다. 다음 패스에도 동일 정체면 SIGKILL 로 승격.
 *  - 판정 불가(ps 실패 등)면 죽이지 않는다 — 오폭보다 고아가 낫다.
 *
 * Windows 는 CIM으로 실행 파일·커맨드라인·생성 시각을 다시 증명한 뒤 taskkill /T,
 * 다음 패스에 /F로 승격한다. 정체를 증명할 수 없으면 POSIX와 마찬가지로 죽이지 않는다.
 */
export async function sweepOrphanedRunChildren(): Promise<OrphanSweepResult> {
  const result: OrphanSweepResult = {
    scanned: 0,
    signaled: 0,
    prunedDead: 0,
    keptLive: 0,
    prunedMismatched: 0,
    identityLookupFailed: 0,
  };
  const orphanCandidates: Array<{ file: string; record: SpawnRecord }> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(registryDir()).filter((name) => name.endsWith(".json"));
  } catch {
    return result; // 원장 디렉터리가 없다 = 수거할 것도 없다.
  }
  for (const name of entries) {
    const file = path.join(registryDir(), name);
    let record: SpawnRecord;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8")) as SpawnRecord;
    } catch {
      try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
      continue;
    }
    if (
      !Number.isInteger(record.pid) || record.pid <= 0 ||
      !Number.isInteger(record.hostPid) || record.hostPid <= 0
    ) {
      try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
      continue;
    }
    result.scanned += 1;
    if (record.pid === process.pid || record.pid === process.ppid || record.pid === record.hostPid) {
      result.keptLive += 1;
      continue;
    }
    if (!processAlive(record.pid)) {
      result.prunedDead += 1;
      try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
      continue;
    }
    if (record.hostPid === process.pid || processAlive(record.hostPid)) {
      result.keptLive += 1;
      continue;
    }
    orphanCandidates.push({ file, record });
  }

  // Windows process identity lookup starts PowerShell/WMI. Do it once per sweep,
  // rather than serially paying its startup and timeout cost for every orphan.
  const windowsIdentities = process.platform === "win32"
    ? await windowsProcessIdentitiesOf(orphanCandidates.map(({ record }) => record.pid))
    : { identities: new Map<number, WindowsProcessIdentity>(), failedPids: new Set<number>() };
  const protectedPosix = process.platform !== "win32" && orphanCandidates.length > 0
    ? await protectedPosixProcesses() : null;

  for (const { file, record } of orphanCandidates) {
    // 호스트는 죽었고 자식 PID 는 살아 있다 — 죽이기 전에 정체를 확인한다.
    const windowsLookup = process.platform === "win32"
      ? classifyWindowsProcessIdentityLookup(windowsIdentities, record.pid)
      : null;
    if (windowsLookup?.status === "failed") {
      // WMI/CIM 장애는 PID 부재가 아니다. 원장을 보존해 다음 sweep에서 재시도한다.
      result.identityLookupFailed += 1;
      continue;
    }
    if (windowsLookup?.status === "missing") {
      // 성공한 CIM 조회에서 사라졌다 = processAlive 이후 종료한 정상 race.
      result.prunedDead += 1;
      try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
      continue;
    }
    if (process.platform === "win32"
      && !(windowsLookup?.status === "found" && windowsProcessIdentityMatches(record, windowsLookup.identity))) {
      // 실행 정체 불일치(PID 재사용) — 절대 죽이지 않고 레코드만 정리.
      result.prunedMismatched += 1;
      try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
      continue;
    }
    const escalate = typeof record.termSignaledAt === "number";
    let signaled = false;
    if (process.platform === "win32") {
      signaled = await taskkillWindowsTree(record.pid, escalate);
    } else {
      if (!validPosixIdentity(record.posixIdentity) || !protectedPosix) {
        result.identityLookupFailed += 1;
        continue; // Legacy records cannot acquire kill authority after the host died.
      }
      if (protectedPosix.pids.has(record.pid) || protectedPosix.groups.has(record.pid)) {
        result.keptLive += 1;
        continue;
      }
      // Fresh OS identity for each TERM/KILL; do not reuse registration/sweep snapshots.
      const identity = await posixProcessIdentityOf(record.pid);
      if (!identity || !posixIdentityMatches(record, identity)) {
        result.identityLookupFailed += 1;
        continue;
      }
      if (record.pid === process.pid || record.pid === process.ppid || processAlive(record.hostPid)) {
        result.keptLive += 1;
        continue;
      }
      try {
        // Another host may have replaced this PID's ledger while metadata was awaited.
        const latest = JSON.parse(fs.readFileSync(file, "utf8")) as SpawnRecord;
        if (!record.recordId || JSON.stringify(latest) !== JSON.stringify(record)) {
          result.identityLookupFailed += 1;
          continue;
        }
      } catch {
        result.identityLookupFailed += 1;
        continue;
      }
      const signal: NodeJS.Signals = escalate ? "SIGKILL" : "SIGTERM";
      try {
        // Both snapshots attest pgid === pid; never fall back to a new/unverified PID.
        process.kill(-record.pid, signal);
        signaled = true;
      } catch { /* A failed group signal grants no authority for a second target. */ }
    }
    if (!signaled && processAlive(record.pid)) continue;
    result.signaled += signaled ? 1 : 0;
    if (escalate) {
      try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
    } else {
      try {
        fs.writeFileSync(file, JSON.stringify({ ...record, termSignaledAt: Date.now() }), "utf8");
      } catch { /* best-effort */ }
    }
  }
  return result;
}
