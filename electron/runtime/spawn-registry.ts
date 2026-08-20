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
// 식별 방어: PID 는 재사용된다. 죽이기 전에 (1) 호스트 PID 가 정말 죽었는지,
// (2) 그 PID 의 현재 커맨드라인에 우리가 기록한 실행 파일 이름이 들어 있는지 확인한다.
// spawnCli 가 심는 AGENTLAS_SPAWN_MARKER env 는 사람이 ps 로 볼 때의 표식이고,
// 기계 판정은 위 두 검사로 한다(macOS ps 는 남의 env 를 안 보여 주므로 env 는
// 교차검증 수단이 못 된다 — 있다고 가정하고 안 보이면 죽이는 쪽이 더 위험하다).
import { execFile } from "node:child_process";
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
  /** 스위퍼가 SIGTERM 을 이미 보냈다면 그 시각(ms epoch) — 다음 패스에 SIGKILL 승격. */
  termSignaledAt?: number;
}

function registryDir(): string {
  return userDataPath("run-children");
}

function recordPath(pid: number): string {
  return path.join(registryDir(), `${pid}.json`);
}

/**
 * 스폰 직후 원장에 적는다. 자식이 정상 종료하면 스스로 지운다 — 남는 파일은
 * (a) 아직 도는 자식이거나 (b) 호스트가 급사해 close 훅이 못 돈 흔적이다.
 * 원장 실패는 실행을 막지 않는다(원장은 안전망이지 게이트가 아니다).
 */
export function recordSpawnedRunChild(child: ChildProcess): void {
  const pid = child.pid;
  if (pid == null) return;
  try {
    fs.mkdirSync(registryDir(), { recursive: true });
    const record: SpawnRecord = {
      pid,
      hostPid: process.pid,
      spawnfile: child.spawnfile ?? "",
      at: new Date().toISOString(),
    };
    fs.writeFileSync(recordPath(pid), JSON.stringify(record), "utf8");
  } catch {
    // userDataDir 미주입(순수 단위 테스트) 또는 디스크 문제 — 안전망만 빠질 뿐이다.
    return;
  }
  const forget = (): void => {
    try {
      fs.rmSync(recordPath(pid), { force: true });
    } catch {
      /* best-effort */
    }
  };
  child.once("close", forget);
  child.once("error", forget);
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

function psCommandOf(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: 3_000 }, (error, stdout) => {
      if (error) return resolve(null);
      const line = stdout.trim();
      resolve(line || null);
    });
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
}

/**
 * 고아 수거 한 패스. 데몬의 keepAlive 스위퍼가 주기적으로 부른다.
 *
 * 규칙:
 *  - 자식 PID 가 죽었으면 레코드만 지운다.
 *  - 호스트 PID 가 살아 있으면 손대지 않는다(그 호스트의 host-lifecycle 이 주인이다).
 *  - 호스트가 죽었고 자식이 살아 있으면, 현재 커맨드라인이 기록된 실행 파일과 일치할
 *    때만 프로세스 그룹 SIGTERM. 다음 패스에도 남아 있으면 SIGKILL 로 승격.
 *  - 판정 불가(ps 실패 등)면 죽이지 않는다 — 오폭보다 고아가 낫다.
 *
 * Windows 는 이 패스를 건너뛴다(프로세스 그룹/ps 계약이 달라 별도 구현이 필요하다).
 */
export async function sweepOrphanedRunChildren(): Promise<OrphanSweepResult> {
  const result: OrphanSweepResult = { scanned: 0, signaled: 0, prunedDead: 0, keptLive: 0, prunedMismatched: 0 };
  if (process.platform === "win32") return result;
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
    if (!Number.isInteger(record.pid) || !Number.isInteger(record.hostPid)) {
      try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
      continue;
    }
    result.scanned += 1;
    if (!processAlive(record.pid)) {
      result.prunedDead += 1;
      try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
      continue;
    }
    if (record.hostPid === process.pid || processAlive(record.hostPid)) {
      result.keptLive += 1;
      continue;
    }
    // 호스트는 죽었고 자식 PID 는 살아 있다 — 죽이기 전에 정체를 확인한다.
    const command = await psCommandOf(record.pid);
    const expected = path.basename(record.spawnfile || "");
    if (!command || !expected || !command.includes(expected)) {
      // ps 실패 또는 커맨드 불일치(PID 재사용) — 절대 죽이지 않고 레코드만 정리.
      result.prunedMismatched += 1;
      try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
      continue;
    }
    const escalate = typeof record.termSignaledAt === "number";
    const signal: NodeJS.Signals = escalate ? "SIGKILL" : "SIGTERM";
    try {
      // detachedSpawnOpts 로 뜬 자식은 자기 PID 가 곧 프로세스 그룹이다 — 손자까지 함께.
      process.kill(-record.pid, signal);
    } catch {
      try { process.kill(record.pid, signal); } catch { /* 이미 죽었을 수 있다 */ }
    }
    result.signaled += 1;
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
