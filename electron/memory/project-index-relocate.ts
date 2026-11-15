// 옛 자리(`<프로젝트>/.agentlas/code-map/`)에 지도가 남은 프로젝트를 새 자리(프로젝트 기억 폴더의 `index/`)로 옮기는 한 번의 순회.
//
// 옮기는 일은 엔진이 한다: 스위치(`memory_layout=split-1`)가 켜진 엔진의 `context refresh` 는 지도를 만들기 전에 옛 폴더를 **한 번의 `os.rename`** 으로 새 자리에 들인다
// (프로젝트 잠금 안, 실패하면 조용히 포기하고 새 자리에 새로 만든다 — 복사·검증 단계가 없어 어느 시점에 죽어도 반쪽 폴더가 생기지 않는다). 이 순회는 그 일이 필요한 프로젝트만
// lstat 로 골라 순차로 한 번씩 부른다. 새 규칙·새 저장 필드·새 IPC·타이머·감시가 없다: 불러야 도는 함수이고, 상태는 디스크(옛 manifest 와 새 자리의 완전한 지도)에서 다시 읽는다.
//
// ★계약(첫 실행 마이그레이션 ⑦ "세션 파일·코드 색인" 자리와 앱 시작이 같은 함수를 부른다):
//   · 언제: 스위치가 켜진 *뒤*(⑥ 기억 이사가 `memory_layout` 을 쓴 뒤), 사용자가 유휴일 때(엔진을 부르므로). 스위치가 꺼져 있으면 `switch_off` 이고 아무것도 읽지 않는다(`done=false`).
//   · 끝 판정: `report.done === true` ⇔ 스위치 켜짐 ∧ 중단 없음 ∧ 이 호출이 아직 손대지 않은 후보 0. 실패한 프로젝트(`failed`)는 `done` 을 붙잡지 않는다 — 옛 지도는 그대로 읽히므로 잃는 것이 없고
//     다음 호출이 다시 시도한다(프로세스 안에서는 갱신 실패 대기 5분→6시간이 막는다). 후보가 전부 새 자리에 있다는 뜻은 `complete`(= done ∧ failed 0)다. 한 호출의 엔진 호출 수 상한(`limit`, 기본 8) 때문에 남은 후보는 `remaining` 으로 보인다 — `done=false` 이면 다음 신호에 다시 부른다.
//   · 다시 불러도 안전한가: 예. 옮긴 프로젝트는 옛 manifest 가 없거나 새 자리가 완전해서 후보가 아니다(엔진이 새 자리가 완전한 옛 사본을 30일 뒤 치운다). 동시에 두 번 부르면 두 번째는 `busy`(동시 1개).
//   · 비용: 프로젝트마다 옛 manifest 를 lstat 1번(없으면 끝). 후보만 활성화 확인 + 엔진 1번(타임아웃 15초는 `triggerProjectContextMapRefresh` 의 것). 종료(`onHostShutdown`)·호출자의 신호가 오면 진행 중인 엔진 자식을 끝내고 멈춘다.
import fs from "node:fs";
import path from "node:path";
import { hostShutdownPending, onHostShutdown } from "../host-lifecycle";
import { completeStamp, defaultIndexContext, indexDir, legacyIndexDir, writeSwitchOn, type IndexContext } from "./project-index";

export interface RelocateReport {
  /** switch_off: 스위치가 아직 꺼져 있다(할 일 없음, 끝 아님) · busy: 다른 순회가 돌고 있다 · aborted: 종료·신호로 멈췄다 · ran: 순회를 끝까지 봤다 */
  state: "switch_off" | "busy" | "aborted" | "ran";
  looked: number;
  /** 이 순회가 부른 `lstat` 의 수(프로젝트마다 옛 manifest 1번, 후보만 새 자리 확인 몇 번 더). */
  lstats: number;
  candidates: number;
  /** 엔진 갱신을 부른 수(`triggerProjectContextMapRefresh` 호출). */
  attempted: number;
  relocated: number;
  failed: number;
  /** 폴더 없음·활성화 안 됨·새 자리를 풀 수 없음. 손대지 않았다. */
  skipped: number;
  remaining: number;
  /** 이 호출이 후보를 모두 봤다(`remaining` 0, 중단 없음). 실패한 프로젝트가 있어도 참이다 — 옛 지도는 그대로 읽히기 때문. */
  done: boolean;
  /** `done` 이고 실패가 없다: 후보가 전부 새 자리에 있다. */
  complete: boolean;
  ms: number;
}

export interface RelocateOptions {
  projects?: ReadonlyArray<{ id: string; folderPath: string | null }>;
  signal?: AbortSignal;
  /** 한 호출의 엔진 갱신 수 상한. */
  limit?: number;
  ctx?: IndexContext;
  /** 시험용: 엔진 갱신을 바꿔 끼운다(기본은 `triggerProjectContextMapRefresh`). */
  refresh?: (projectPath: string, options: { signal?: AbortSignal }) => Promise<boolean>;
}

export const RELOCATE_ENGINE_CALLS_PER_PASS = 8;
let running = false;

const empty = (state: RelocateReport["state"], ms = 0): RelocateReport =>
  ({ state, looked: 0, lstats: 0, candidates: 0, attempted: 0, relocated: 0, failed: 0, skipped: 0, remaining: 0, done: false, complete: false, ms });

export async function relocateProjectIndexesOnce(options: RelocateOptions = {}): Promise<RelocateReport> {
  if (running) return empty("busy");
  if (!hostShutdownPending()) return empty("aborted"); // 종료가 이미 시작됐다: 시작하지 않는다
  running = true;
  const started = performance.now();
  const stop = new AbortController();
  const unhook = onHostShutdown(() => stop.abort());
  const onCaller = (): void => stop.abort();
  options.signal?.addEventListener("abort", onCaller, { once: true });
  if (options.signal?.aborted) stop.abort();
  const report = empty("ran");
  try {
    const ctx = options.ctx ?? defaultIndexContext();
    if (!writeSwitchOn(ctx)) return { ...empty("switch_off"), ms: performance.now() - started };
    const projects = options.projects ?? (require("../store/projects") as typeof import("../store/projects")).listProjects();
    const limit = Math.max(1, options.limit ?? RELOCATE_ENGINE_CALLS_PER_PASS);
    const lstat = (target: string): fs.Stats | null => {
      report.lstats += 1;
      try { return fs.lstatSync(target); } catch { return null; }
    };
    for (const project of projects) {
      if (stop.signal.aborted) { report.state = "aborted"; break; }
      const folder = project.folderPath;
      if (!folder || !path.isAbsolute(folder)) continue;
      report.looked += 1;
      // 옛 manifest 가 없으면 옮길 것이 없다(대부분의 프로젝트): lstat 한 번으로 끝.
      if (!lstat(path.join(legacyIndexDir(folder), "manifest.json"))?.isFile()) continue;
      const place = indexDir(folder, ctx);
      if (!place) { report.skipped += 1; continue; }
      report.lstats += 3;
      if (completeStamp(place) !== null) continue; // 새 자리가 이미 완전하다(엔진이 옛 사본을 30일 뒤 치운다)
      report.candidates += 1;
      if (report.attempted >= limit) { report.remaining += 1; continue; }
      let refreshed = false;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        if (!(require("../architecture/activation") as typeof import("../architecture/activation")).verifyActivatedFolderIdentity(folder)) { report.skipped += 1; continue; }
        const refresh = options.refresh
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          ?? ((target: string, passed: { signal?: AbortSignal }) => (require("./context-map") as typeof import("./context-map")).triggerProjectContextMapRefresh(target, { ...passed, force: true }));
        report.attempted += 1;
        refreshed = await refresh(folder, { signal: stop.signal });
      } catch { refreshed = false; }
      report.lstats += 3;
      // 중단 신호가 갱신 도중 왔어도 이미 새 자리가 완전하면 옮겨진 것이다(디스크에서 다시 읽은 사실만 센다).
      if (completeStamp(place) !== null && (refreshed || stop.signal.aborted)) report.relocated += 1;
      else if (stop.signal.aborted) { report.remaining += 1; }
      else report.failed += 1;
      if (stop.signal.aborted) { report.state = "aborted"; break; }
    }
    report.done = report.state === "ran" && report.remaining === 0;
    report.complete = report.done && report.failed === 0;
    return report;
  } catch {
    return { ...report, state: "aborted", done: false, ms: performance.now() - started };
  } finally {
    report.ms = performance.now() - started;
    options.signal?.removeEventListener("abort", onCaller);
    unhook();
    running = false;
  }
}
