/**
 * 런타임 일시 정지 기록 — "지금 못 쓴다"는 **만료가 있는 사실**이지, 사용자의 선택이 아니다.
 *
 * ★왜 생겼나 (오너 실사용 보고 2026-09-07). 사용자가 제미나이를 골라 놨는데 실행이 이렇게 갔다:
 *
 *   7m 4s 동안 작업 · 실패 — antigravity runtime exit: Antigravity CLI exit 1
 *   → One 이 폴백 → grok → "grok 사용 한도가 찼습니다 (524673/500000, 24시간 롤링)"
 *   → 다음 턴에도 grok. 사용자: "제미나이로 했는데", "왜 자꾸 그록으로 바뀌냐".
 *
 * 두 가지가 겹쳐 있었다.
 *  ① One 의 폴백이 `setChatRuntimeSelection` 으로 **사용자의 선택을 영구히 덮어썼다.**
 *     agy 한도는 25분이면 풀리는데, 대화는 영영 grok 에 남는다. (같은 자리의 Work 경로는
 *     "저장된 선택은 변경하지 않았습니다" 라고 이미 옳게 하고 있었다 — One 만 달랐다.)
 *  ② 폴백이 **이미 죽은 런타임을 골랐다.** grok 은 그 시점에 이미 한도 초과였는데
 *     후보 필터가 "지금 한도에 걸린 런타임"이라는 개념을 갖고 있지 않았다.
 *
 * 그래서 선택을 고치는 대신 **고장 사실에 시한을 붙인다.** 선택은 사용자 것이라 그대로 두고,
 * 한도에 걸린 런타임만 그 시간 동안 후보에서 빠졌다가 **스스로 돌아온다.**
 *
 * 프로세스 안 메모리에만 산다: 앱을 다시 켜면 사라진다. 그게 맞다 — 재시작은 사람이
 * "다시 해 봐"라고 말한 것이고, 잘못된 시한 때문에 멀쩡한 런타임이 잠기면 안 된다.
 */
import type { RunnerFailure, RunnerFailureKind } from "./runner";
import type { RuntimeSelection, RuntimeStatus } from "../../shared/types";

/** 시한을 못 읽었을 때의 보수적 기본값. 너무 길면 멀쩡해진 런타임을 잠근다. */
const DEFAULT_COOLDOWN_MS = 10 * 60_000;
/** 런타임이 알려준 시각이라도 이보다 길게는 믿지 않는다(“24시간 롤링”류를 그대로 받으면 하루가 잠긴다). */
const MAX_COOLDOWN_MS = 60 * 60_000;
/** 한도/인증만 시한부다. refused·empty·exit 는 요청 자체의 문제일 수 있어 런타임을 잠그지 않는다. */
const COOLDOWN_KINDS: ReadonlySet<RunnerFailureKind> = new Set(["quota", "rate_limit", "auth"]);
/** Request throttling lifts by itself: without the provider's Retry-After, step aside briefly, not for ten minutes. */
const RATE_LIMIT_DEFAULT_COOLDOWN_MS = 60_000;

export interface RuntimeCooldown {
  until: number;
  kind: RunnerFailureKind;
  message: string;
}

const cooldowns = new Map<string, RuntimeCooldown>();

/** What names one runtime. An open ACP seat also carries its agent id; a caller that cannot name the seat passes none. */
type RuntimeIdentity = Pick<RuntimeStatus, "kind" | "backend" | "source" | "model"> & { acpAgentId?: string | null };

/** Every runtime except an open ACP seat, and any caller that cannot name its seat, has no seat. */
const NO_SEAT = "";
function seatOf(runtime: RuntimeIdentity): string {
  return runtime.kind === "acp" && runtime.acpAgentId ? runtime.acpAgentId : NO_SEAT;
}
/** The stored key: kind, backend, source and model (a different model has a different limit), then the seat. */
function entryKey(runtime: RuntimeIdentity, seat: string = seatOf(runtime)): string {
  return JSON.stringify([runtime.kind, runtime.backend, runtime.source, runtime.model ?? null, seat]);
}
/** Stored keys of every seat that runs this executable and model. */
function seatKeys(map: ReadonlyMap<string, unknown>, runtime: RuntimeIdentity): string[] {
  const prefix = `${JSON.stringify([runtime.kind, runtime.backend, runtime.source, runtime.model ?? null]).slice(0, -1)},`;
  const own = entryKey(runtime, NO_SEAT);
  return [...map.keys()].filter(key => key.startsWith(prefix) && key !== own);
}
/**
 * The stored keys that can answer for a runtime, nearest first. Identities are rebuilt in several places (checkpoint selections, judgment receipts,
 * the Science probe) and not all of them can name an ACP seat, so a record and a lookup must still meet:
 * - a caller that names its seat sees that seat's record and a record made without a seat (that one covers every seat of the executable and model);
 * - a caller that cannot name its seat sees the record made without a seat, else the single seat that is cooling.
 */
function candidateKeys(map: ReadonlyMap<string, unknown>, runtime: RuntimeIdentity): string[] {
  const seat = seatOf(runtime);
  if (seat !== NO_SEAT) return [entryKey(runtime, seat), entryKey(runtime, NO_SEAT)];
  if (runtime.kind !== "acp") return [entryKey(runtime, NO_SEAT)];
  return [entryKey(runtime, NO_SEAT), ...seatKeys(map, runtime)];
}
/** Picks the answer among the matching records: the nearest for a named seat, else the unseated record or the only seat that has one. */
function pickRecord<T>(map: ReadonlyMap<string, T>, runtime: RuntimeIdentity, keys: string[]): T | null {
  const hits = keys.filter(key => map.has(key));
  if (!hits.length) return null;
  if (seatOf(runtime) !== NO_SEAT || runtime.kind !== "acp") return map.get(hits[0]) ?? null;
  const unseated = entryKey(runtime, NO_SEAT);
  if (hits.includes(unseated)) return map.get(unseated) ?? null;
  return hits.length === 1 ? map.get(hits[0]) ?? null : null;
}

/**
 * 런타임이 알려준 복구 시각을 밀리초로 옮긴다. 못 읽으면 null.
 * 형태 둘을 실측했다: ISO 시각(claude `rate_limit_info.resetsAt`), 사람 문장("Resets in 25m37s", agy).
 */
export function parseRetryHint(hint: string | undefined, now: number): number | null {
  const text = String(hint ?? "").trim();
  if (!text) return null;
  const iso = Date.parse(text);
  if (Number.isFinite(iso) && iso > now) return iso;
  // "Resets in 25m37s" / "resets in 2h" / "try again in 45s"
  const relative = text.match(/\bin\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  if (relative && (relative[1] || relative[2] || relative[3])) {
    const ms = (Number(relative[1] ?? 0) * 3_600 + Number(relative[2] ?? 0) * 60 + Number(relative[3] ?? 0)) * 1_000;
    if (ms > 0) return now + ms;
  }
  return null;
}

/**
 * 이 런타임을 잠시 후보에서 뺀다. 잠글 만한 실패가 아니면 아무 일도 하지 않는다.
 * @returns 기록했으면 그 시한, 아니면 null
 */
export function noteRuntimeFailure(
  runtime: RuntimeIdentity,
  failure: Pick<RunnerFailure, "kind" | "message" | "retryAfterHint">,
  now = Date.now(),
): RuntimeCooldown | null {
  if (!COOLDOWN_KINDS.has(failure.kind)) return null;
  const hinted = parseRetryHint(failure.retryAfterHint, now);
  const until = Math.min(hinted ?? now + (failure.kind === "rate_limit" ? RATE_LIMIT_DEFAULT_COOLDOWN_MS : DEFAULT_COOLDOWN_MS), now + MAX_COOLDOWN_MS);
  const entry: RuntimeCooldown = {
    until,
    kind: failure.kind,
    message: String(failure.message ?? "").slice(0, 400),
  };
  cooldowns.set(entryKey(runtime), entry);
  /*
   * ★로그인 만료는 기다린다고 낫지 않는다.
   *
   * 한도는 시간이 지나면 스스로 풀리지만 인증은 사람이 로그인해야 풀린다. 시한부로만 다루면
   * 한 시간 뒤 이 런타임은 다시 "연결됨"이 되고, 사용자는 초록불을 보면서 같은 실패를 다시
   * 겪는다 — 그리고 푸는 길은 터미널을 직접 여는 것뿐이었다.
   *
   * 그래서 인증 실패는 따로, 시간이 아니라 **사실**로 기록한다. 지워지는 때는 그 런타임이
   * 실제로 한 번 성공했을 때뿐이다.
   */
  if (failure.kind === "auth") {
    signedOut.set(entryKey(runtime), {
      since: now,
      message: String(failure.message ?? "").slice(0, 400),
    });
  }
  return entry;
}

export interface RuntimeSignedOut {
  since: number;
  message: string;
}

const signedOut = new Map<string, RuntimeSignedOut>();

/** 이 런타임이 로그인 실패를 낸 적이 있고 아직 성공한 적이 없는가. */
export function runtimeSignedOut(runtime: RuntimeIdentity): RuntimeSignedOut | null {
  return pickRecord(signedOut, runtime, candidateKeys(signedOut, runtime));
}

/** 실제 성공 한 번이 유일한 해제 조건 — 짐작으로 초록불을 되돌리지 않는다. (A success that cannot name its seat clears every seat of that executable and model.) */
export function noteRuntimeSucceeded(runtime: RuntimeIdentity): void {
  for (const key of candidateKeys(signedOut, runtime)) signedOut.delete(key);
}

/** 지금 이 런타임이 시한부로 막혀 있나. 만료된 기록은 그 자리에서 지운다(스스로 돌아온다). */
export function runtimeCooldown(runtime: RuntimeIdentity, now = Date.now()): RuntimeCooldown | null {
  const keys = candidateKeys(cooldowns, runtime);
  for (const key of keys) {
    const entry = cooldowns.get(key);
    if (entry && entry.until <= now) cooldowns.delete(key);
  }
  const picked = pickRecord(cooldowns, runtime, keys);
  if (!picked || seatOf(runtime) === NO_SEAT) return picked;
  // A named seat can have its own record and a record made without a seat: the one that holds longer answers, so a short throttle never hides a quota.
  const shared = cooldowns.get(entryKey(runtime, NO_SEAT));
  return shared && shared.until > picked.until ? shared : picked;
}

/** Exact checkpoint selections from older runs may lack backend. Match their
 * observed source/model only when the active cooldown has one unambiguous
 * provider identity; never guess across two accounts or backends. */
export function runtimeCooldownForSelection(selection: RuntimeSelection, now = Date.now()): RuntimeCooldown | null {
  if (!selection.source) return null;
  const acpAgentId = selection.acpAgentId ?? null;
  if (selection.backend) return runtimeCooldown({ kind: selection.kind, backend: selection.backend,
    source: selection.source, model: selection.model, acpAgentId }, now);
  const matches: RuntimeCooldown[] = [];
  const seen = new Set<string>();
  for (const [key] of cooldowns) {
    let identity: unknown;
    try { identity = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(identity) || identity.length !== 5 || identity[0] !== selection.kind
      || identity[2] !== selection.source || identity[3] !== (selection.model ?? null)) continue;
    const backend = identity[1] as RuntimeStatus["backend"];
    if (seen.has(String(backend))) continue;
    seen.add(String(backend));
    const entry = runtimeCooldown({ kind: selection.kind, backend, source: selection.source, model: selection.model, acpAgentId }, now);
    if (entry) matches.push(entry);
  }
  return matches.length === 1 ? matches[0] : null;
}

/** 사용자가 그 런타임을 직접 다시 고르면 우리 짐작보다 사용자가 우선이다. */
export function clearRuntimeCooldown(runtime: RuntimeIdentity): void {
  for (const key of candidateKeys(cooldowns, runtime)) cooldowns.delete(key);
}

/** 테스트 전용 — 프로세스 안 상태를 비운다. */
export function resetRuntimeCooldownsForTest(): void {
  signedOut.clear();
  cooldowns.clear();
}
