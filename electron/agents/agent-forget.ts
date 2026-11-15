// 에이전트를 지울 때 남는 흔적 정리.
//
//   하는 일: ① 이어하기 체크포인트의 그 에이전트 행(`forgetSessionCheckpointsForAgent`, 세션 저장소)
//            ② 번들 엔진 `agentlas_cloud.memory_split forget-agent --agent-id X` — 에이전트 기억 행·에피소드 요약·기억 파일.
//   하지 않는 일: 에이전트 폴더 삭제(호출자의 몫), 사용자 폴더 삭제(절대 안 함), 삭제 자체를 막는 것(이 파일은 던지지 않는다).
//
// ★누가 읽고 언제 지우나. `meta.agent-forget-pending:v1` 은 엔진이 "partial"(남은 것 있음)이라 답했거나 엔진을 못 불러
//   끝내지 못한 에이전트 id 목록(최대 PENDING_CAP, JSON; 항목마다 지운 시각 `at`). 에이전트당 한 줄(~100바이트)이라 가득 차도 20KB 안팎이다.
//   읽는 곳(신호 기반, 타이머 없음): 앱 시작 때 한 번과 엔진을 쓸 수 있게 됐다는 신호(`forget-stores.ts retryEngineForgetsOnce`)와 다음 에이전트 삭제 직후. 대기가 0이면 아무것도 돌지 않는다.
//   지우는 때: 엔진이 forgotten/skipped/unavailable 로 답했을 때, 같은 id 가 지운 뒤에 다시 설치됐을 때(새 에이전트의 기억을 지우지 않는다), 상한(PENDING_CAP)에 닿아 가장 오래된 것을 먼저 실제로 시도한 뒤(로그 한 줄).
// *횟수로는 버리지 않는다*(#1: 5번 만에 버려 폴더가 영영 남았다). 엔진이 안 닿는 것이 확인되면 한 묶음의 나머지는 시도하지 않는다.
//   새 표는 없다 — 기존 `meta` 키 하나.
// ★이 대기는 "엔진이 해 줄 일"(뿌리의 뷰·번역 작업·관찰된 턴)만 위한 것이다. 폴더와 그 안의 기억 저장소, 뿌리의 에이전트 줄·턴 기록은 데스크탑이 엔진과 상관없이 바로 지운다
//   (`settings-agent-ops.ts finishRemovedAgentFolders` + `memory/store-delete.ts purgeAgentRowsFromRoot`) — 엔진 상태와 무관하게 사용자는 항상 에이전트를 지울 수 있다.
// ★엔진이 너무 낡아 모듈이 없으면(`No module named`) 재시도해도 소용없으므로 목록에 넣지 않는다("unavailable").
// ★허브에서 부르기만 한 에이전트(로컬 폴더 없음)는 로컬 기억이 없다 — 체크포인트만 지우고 엔진은 부르지 않는다.
import fs from "node:fs";
import path from "node:path";
import { leftToRetry, noteLeftThatEndsHere, readLeftReasons, type LeftReasons } from "../memory/engine-left";

export const PENDING_KEY = "agent-forget-pending:v1";
export const PENDING_CAP = 200;
const BATCH = 5;

export type ForgetEngineState = "forgotten" | "partial" | "skipped" | "unavailable" | "not_called";
export interface ForgetOutcome {
  /** 세션 저장소에서 지운 체크포인트 행 수(못 열면 0). */
  checkpointRows: number;
  engine: ForgetEngineState;
  /** 엔진이 남았다고 한 항목 이름(`root_locked` 등). 사용자에게는 한 줄로만 보인다. */
  left: string[];
  /** Desktop repair 6: why the engine left it (`{views: "views_path_too_long" | "views_file_busy" | "views_retry"}`), when the engine said. A left that no retry changes is not queued. */
  leftReasons?: LeftReasons;
}
/**
 * `finish`: (의 옛 항목에만 있다 — 새 항목은 쓰지 않는다) 엔진이 못 끝냈을 때 폴더를 *건드리지 않고 남겨 둔* 기록. 다음 시도에서 데스크탑이 폴더를 직접 마무리하고 이 칸을 지운다(#1).
 */
export interface PendingFinish { folder: string | null; appFolders: string[]; removeSource: boolean }
interface PendingEntry { id: string; tries: number; aliases?: string[]; /** 지운 시각(ISO). 없으면 옛 항목. */ at?: string; finish?: PendingFinish }

function readPending(getMeta: (key: string) => string | null): PendingEntry[] {
  try {
    const parsed: unknown = JSON.parse(getMeta(PENDING_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): PendingEntry[] => {
      const entry = item as { id?: unknown; tries?: unknown };
      const aliases = Array.isArray((entry as { aliases?: unknown }).aliases) ? ((entry as { aliases: unknown[] }).aliases).filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 16) : undefined;
      const at = typeof (entry as { at?: unknown }).at === "string" && Number.isFinite(Date.parse((entry as { at: string }).at)) ? (entry as { at: string }).at : undefined;
      const rawFinish = (entry as { finish?: { folder?: unknown; appFolders?: unknown; removeSource?: unknown } }).finish;
      const finish: PendingFinish | undefined = rawFinish && typeof rawFinish === "object" ? {
        folder: typeof rawFinish.folder === "string" && path.isAbsolute(rawFinish.folder) ? rawFinish.folder : null,
        appFolders: Array.isArray(rawFinish.appFolders) ? rawFinish.appFolders.filter((x): x is string => typeof x === "string" && path.isAbsolute(x)).slice(0, 4) : [],
        removeSource: rawFinish.removeSource === true,
      } : undefined;
      return typeof entry?.id === "string" && entry.id ? [{ id: entry.id, tries: Number.isInteger(entry.tries) ? Number(entry.tries) : 0, ...(aliases?.length ? { aliases } : {}), ...(at ? { at } : {}), ...(finish ? { finish } : {}) }] : [];
    }).slice(0, PENDING_CAP);
  } catch { return []; }
}

async function pendingStore() {
  const meta = await import("../store/meta");
  return {
    read: () => readPending(meta.getMeta),
    write: (entries: PendingEntry[]) => {
      try { meta.setMeta(PENDING_KEY, JSON.stringify(entries.slice(0, PENDING_CAP))); } catch { /* 목록을 못 쓰면 다음 삭제 때 엔진이 다시 본다 */ }
    },
  };
}

/**
 * 사용자의 폴더(앱이 만들지 않은 곳)인가. 판정은 home.ts 의 `classifyAgentFolder` 한 곳이다 — 폴더를 옮길지와 휴지통으로 보낼지가 같은 규칙을 읽는다.
 * 앱 소유 = 앱이 만드는 네 루트(에이전트 루트, 예전 userData/agents, userData/generated-agent-os, 엔진 빌더 홈)의 바로 아래 폴더. `~/.agentlas` 아래의 나머지
 * (projects 등)는 사용자 것이다 — 사용자가 거기를 가리켜 등록한 폴더가 휴지통으로 가지 않게. 링크·git 저장소·모르는 곳도 사용자 것(모르면 사용자 것).
 */
export async function isUserOwnedFolder(folder: string): Promise<boolean> {
  try {
    const home = await import("./home");
    return home.classifyAgentFolder(folder).owner === "user";
  } catch { return true; }
}

let engineForTests: ((agentId: string, aliases: string[]) => Promise<{ state: ForgetEngineState; left: string[]; leftReasons?: LeftReasons }>) | null = null;
/** Test seam: replaces the engine call (a fake engine); `null` restores the real one. */
export function setForgetEngineForTests(fn: typeof engineForTests): void { engineForTests = fn; }

/** The arguments of the engine call: `forget-agent --agent-id <id> [--alias <id>]...` (the ids the agent's folder names in owner.json). */
export function forgetEngineArgs(agentId: string, aliases: string[] = []): string[] {
  return ["forget-agent", "--agent-id", agentId, ...aliases.filter((a) => a && a !== agentId).flatMap((a) => ["--alias", a])];
}

/** Every id the agent's folder says it has had (`.agentlas-local/owner.json` ids[]), read BEFORE the folder is moved. Never throws. */
export function ownerAliases(folder: string | null | undefined): string[] {
  if (!folder) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(folder, ".agentlas-local", "owner.json"), "utf8").replace(/^\uFEFF/, "")) as { agentId?: unknown; ids?: unknown };
    const ids = [parsed.agentId, ...(Array.isArray(parsed.ids) ? parsed.ids : [])].filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200);
    return [...new Set(ids)].slice(0, 16);
  } catch { return []; }
}

async function callEngine(agentId: string, aliases: string[] = []): Promise<{ state: ForgetEngineState; left: string[]; leftReasons?: LeftReasons }> {
  if (engineForTests) return engineForTests(agentId, aliases);
  try {
    const [{ runHephaestus }, { trustedMemoryOwnerEnvironment }] = await Promise.all([
      import("../hephaestus/engine"), import("../memory/trusted-owner-binding"),
    ]);
    let env: Record<string, string> = {};
    try { env = trustedMemoryOwnerEnvironment(); } catch { /* 소유자를 못 묶으면 엔진이 deferred 로 답한다 */ }
    const result = await runHephaestus<{ state?: string; left?: unknown }>(
      "agentlas_cloud.memory_split" as unknown as Parameters<typeof runHephaestus>[0],
      forgetEngineArgs(agentId, aliases), { timeoutMs: 10_000, env });
    const text = `${result.stderr ?? ""}\n${result.error ?? ""}`;
    if (!result.json && /No module named|ModuleNotFoundError/i.test(text)) return { state: "unavailable", left: [] };
    const state = result.json?.state;
    if (state === "forgotten") return { state: "forgotten", left: [] };
    if (state === "skipped" || state === "deferred") return { state: "skipped", left: [] };
    if (state === "partial") {
      const left = Array.isArray(result.json?.left) ? result.json!.left.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
      const leftReasons = readLeftReasons(result.json);
      return { state: "partial", left, ...(leftReasons ? { leftReasons } : {}) };
    }
    // 엔진이 JSON 없이 끝났다(타임아웃·크래시): 끝내지 못한 것으로 두고 다시 시도한다.
    return { state: "partial", left: ["engine_no_answer"] };
  } catch {
    return { state: "partial", left: ["engine_not_started"] };
  }
}

/** 대기 목록을 읽고 쓰는 일은 한 줄로 세운다 — 삭제와 재시도가 겹쳐 서로의 쓰기를 덮지 않게. */
let serial: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = serial.then(task, task);
  serial = run.catch(() => undefined);
  return run;
}

/** 지운 뒤에 같은 id(또는 그 에이전트의 옛 id)가 다시 설치됐는가 — 그렇다면 그 id 의 기억은 새 에이전트의 것이다. */
async function installedAgainSince(entry: PendingEntry): Promise<boolean> {
  try {
    const { getDb } = await import("../store/db");
    const db = getDb();
    const ids = [entry.id, ...(entry.aliases ?? [])];
    const at = entry.at ? Date.parse(entry.at) : NaN;
    for (const id of ids) {
      const row = db.prepare("SELECT installed_at FROM installed_agents WHERE id = ?").get(id) as { installed_at?: string } | undefined;
      if (!row) continue;
      const installed = row.installed_at ? Date.parse(row.installed_at) : NaN;
      if (!Number.isFinite(at) || !Number.isFinite(installed) || installed >= at) return true;
    }
    return false;
  } catch { return false; } // DB 를 못 열면 새 설치 여부를 모른다 — 엔진이 소유자·존재를 다시 본다
}

/** 엔진 호출이 "안 닿는다"로 끝났나(엔진·Python 없음, 응답 없음). 같은 묶음의 나머지도 같은 이유로 실패하니 더 시도하지 않는다. */
function engineUnreachable(state: ForgetEngineState, left: readonly string[]): boolean {
  return state === "unavailable" || left.some((code) => code.startsWith("engine_"));
}

/** 대기 한 건을 한 번 시도한다. 목록에 남겨야 하면 갱신된 항목(`keep`)을, 끝났으면 null. */
async function attemptPending(entry: PendingEntry): Promise<{ keep: PendingEntry | null; engineDown: boolean }> {
  if (await installedAgainSince(entry)) {
    console.warn(`[agent-forget] dropped a pending cleanup: ${entry.id} was installed again after it was removed`);
    return { keep: null, engineDown: false };
  }
  try {
    const rows = await import("../memory/session-store");
    rows.forgetSessionCheckpointsForAgent(entry.id);
  } catch { /* 위와 같다 */ }
  const { state, left, leftReasons } = await callEngine(entry.id, entry.aliases ?? []);
  // 옛 항목(폴더를 남겨 둔 채 기다리던 것): 엔진이 끝냈든 못 끝냈든 데스크탑이 이제 폴더를 마무리한다 — 엔진을 기다리며 폴더가 영영 남지 않게. 던지지 않는다.
  if (entry.finish) {
    try { await (await import("../harness/settings-agent-ops")).finishRemovedAgentFolders(entry.id, entry.finish, { engine: state, aliases: [entry.id, ...(entry.aliases ?? [])] }); } catch { console.warn(`[agent-forget] the kept folder of ${entry.id} could not be finished`); }
  }
  const engineDown = engineUnreachable(state, left);
  if (state !== "partial") return { keep: null, engineDown }; // forgotten / skipped / unavailable: 엔진이 더 해 줄 일이 없다
  // Desktop repair 6: a left the engine says no retry changes (`views_path_too_long`) ends the entry - it would be tried at every start for ever. Its code goes to the memory screen's open codes.
  noteLeftThatEndsHere(left, leftReasons);
  if (left.length > 0 && leftToRetry(left, leftReasons).length === 0) return { keep: null, engineDown };
  const { finish: _finished, ...rest } = entry;
  return { keep: { ...rest, tries: Math.min(entry.tries + 1, 1_000_000) }, engineDown };
}

/**
 * 지운 에이전트의 흔적을 정리한다. 던지지 않는다 — 삭제는 이미 끝났고, 못 끝낸 것은 목록에 남겨 다음 기회에 다시 한다.
 * `callOnly` : 허브에서 부르기만 한 에이전트(로컬 폴더·기억 없음).
 */
export async function forgetAgentTraces(agentId: string, options: { callOnly?: boolean; aliases?: string[] } = {}): Promise<ForgetOutcome> {
  // 루트 이동 뒤 보존된 이전 루트에도 이 에이전트의 폴더 사본이 있다(Agentlas 2.0 #3): 새 쪽에서 지워진 에이전트의 옛 사본은 이 정리가 함께 지운다. 보존본이 없으면 저널 파일 하나를 읽고 끝난다.
  if (!options.callOnly) { try { await (await import("./root-move")).retireRetainedRootAfterErase(); } catch { /* 이 프로세스에는 에이전트 루트 모듈이 없다 */ } }
  let checkpointRows = 0;
  try {
    const store = await import("../memory/session-store");
    checkpointRows = store.forgetSessionCheckpointsForAgent(agentId);
  } catch { /* 세션 저장소가 없거나 잠겼다 — 90일 보존 작업이 마지막 방어선 */ }
  if (options.callOnly) return { checkpointRows, engine: "not_called", left: [] };
  const aliases = (options.aliases ?? []).filter((a) => a !== agentId);
  const { state, left, leftReasons } = await callEngine(agentId, aliases);
  noteLeftThatEndsHere(left, leftReasons);
  if (state === "partial" && !(left.length > 0 && leftToRetry(left, leftReasons).length === 0)) {
    await exclusive(async () => {
      const store = await pendingStore();
      let entries = store.read().filter((entry) => entry.id !== agentId);
      // 상한에 닿기 전에 가장 오래된 것부터 실제로 시도한다. 못 끝내면 버리는 이유를 로그 한 줄로 남긴다.
      while (entries.length >= PENDING_CAP) {
        const [oldest, ...rest] = entries;
        const { keep: kept } = await attemptPending(oldest);
        entries = rest;
        if (kept) console.warn(`[agent-forget] pending list full (${PENDING_CAP}): dropped the oldest cleanup ${oldest.id} after a last try`);
      }
      entries.push({ id: agentId, tries: 1, at: new Date().toISOString(), ...(aliases.length ? { aliases } : {}) });
      store.write(entries);
    });
  }
  // 다음 삭제는 신호다: 이전에 끝내지 못한 다른 에이전트도 한 번 더 시도한다(삭제 응답은 기다리지 않는다).
  void retryPendingAgentForgets({ except: agentId }).catch(() => undefined);
  return { checkpointRows, engine: state, left, ...(leftReasons ? { leftReasons } : {}) };
}

/** 끝내지 못한 에이전트를 다시 시도한다(타이머 없음 — 앱 시작과 다음 삭제가 부른다). 한 번에 BATCH 개까지. 대기가 0이면 아무것도 하지 않는다. */
export async function retryPendingAgentForgets(options: { except?: string } = {}): Promise<{ pending: number; retried: number; before: number }> {
  const waiting = await pendingAgentForgetCount();
  if (waiting === 0) return { pending: 0, retried: 0, before: 0 };
  return exclusive(async () => {
    const store = await pendingStore();
    const all = store.read();
    const entries = all.filter((entry) => entry.id !== options.except); // the one that just failed is not retried at once
    const batch = entries.slice(0, BATCH);
    const remaining: PendingEntry[] = [...all.filter((entry) => entry.id === options.except), ...entries.slice(BATCH)];
    let engineDown = false;
    for (const entry of batch) {
      if (engineDown) { remaining.push(entry); continue; } // 엔진이 안 닿는다고 이미 확인됐다 — 같은 묶음의 나머지는 건너뛴다(횟수도 올리지 않는다)
      const { keep, engineDown: down } = await attemptPending(entry);
      if (keep) remaining.push(keep);
      if (down) engineDown = true;
    }
    // 시도하는 동안 새로 들어온 항목은 exclusive 가 막아 두었으므로 덮어쓸 것이 없다.
    store.write(remaining);
    return { pending: remaining.length, retried: batch.length, before: all.length };
  });
}

/** 읽기만: 지금 남은 개수. */
export async function pendingAgentForgetCount(): Promise<number> {
  return (await pendingStore()).read().length;
}

/** 시험용: 지금 돌고 있는 대기 목록 작업이 모두 끝날 때까지 기다린다. */
export function whenForgetIdleForTests(): Promise<void> { return serial.then(() => undefined); }
