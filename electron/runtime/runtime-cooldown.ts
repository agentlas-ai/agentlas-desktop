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
const COOLDOWN_KINDS: ReadonlySet<RunnerFailureKind> = new Set(["quota", "auth"]);

export interface RuntimeCooldown {
  until: number;
  kind: RunnerFailureKind;
  message: string;
}

const cooldowns = new Map<string, RuntimeCooldown>();

/** 후보 동일성 열쇠 — 모델까지 포함한다(같은 CLI 의 다른 모델은 다른 한도를 갖는다). */
export function runtimeCooldownKey(runtime: Pick<RuntimeStatus, "kind" | "backend" | "source" | "model">): string {
  return JSON.stringify([runtime.kind, runtime.backend, runtime.source, runtime.model ?? null]);
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
  runtime: Pick<RuntimeStatus, "kind" | "backend" | "source" | "model">,
  failure: Pick<RunnerFailure, "kind" | "message" | "retryAfterHint">,
  now = Date.now(),
): RuntimeCooldown | null {
  if (!COOLDOWN_KINDS.has(failure.kind)) return null;
  const hinted = parseRetryHint(failure.retryAfterHint, now);
  const until = Math.min(hinted ?? now + DEFAULT_COOLDOWN_MS, now + MAX_COOLDOWN_MS);
  const entry: RuntimeCooldown = {
    until,
    kind: failure.kind,
    message: String(failure.message ?? "").slice(0, 400),
  };
  cooldowns.set(runtimeCooldownKey(runtime), entry);
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
    signedOut.set(runtimeCooldownKey(runtime), {
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
export function runtimeSignedOut(
  runtime: Pick<RuntimeStatus, "kind" | "backend" | "source" | "model">,
): RuntimeSignedOut | null {
  return signedOut.get(runtimeCooldownKey(runtime)) ?? null;
}

/** 실제 성공 한 번이 유일한 해제 조건 — 짐작으로 초록불을 되돌리지 않는다. */
export function noteRuntimeSucceeded(
  runtime: Pick<RuntimeStatus, "kind" | "backend" | "source" | "model">,
): void {
  signedOut.delete(runtimeCooldownKey(runtime));
}

/** 지금 이 런타임이 시한부로 막혀 있나. 만료된 기록은 그 자리에서 지운다(스스로 돌아온다). */
export function runtimeCooldown(
  runtime: Pick<RuntimeStatus, "kind" | "backend" | "source" | "model">,
  now = Date.now(),
): RuntimeCooldown | null {
  const key = runtimeCooldownKey(runtime);
  const entry = cooldowns.get(key);
  if (!entry) return null;
  if (entry.until <= now) {
    cooldowns.delete(key);
    return null;
  }
  return entry;
}

/** Exact checkpoint selections from older runs may lack backend. Match their
 * observed source/model only when the active cooldown has one unambiguous
 * provider identity; never guess across two accounts or backends. */
export function runtimeCooldownForSelection(selection: RuntimeSelection, now = Date.now()): RuntimeCooldown | null {
  if (!selection.source) return null;
  if (selection.backend) return runtimeCooldown({ kind: selection.kind, backend: selection.backend,
    source: selection.source, model: selection.model }, now);
  const matches: RuntimeCooldown[] = [];
  for (const [key] of cooldowns) {
    let identity: unknown;
    try { identity = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(identity) || identity.length !== 4 || identity[0] !== selection.kind
      || identity[2] !== selection.source || identity[3] !== (selection.model ?? null)) continue;
    const entry = runtimeCooldown({ kind: selection.kind,
      backend: identity[1] as RuntimeStatus["backend"], source: selection.source, model: selection.model }, now);
    if (entry) matches.push(entry);
  }
  return matches.length === 1 ? matches[0] : null;
}

/** 사용자가 그 런타임을 직접 다시 고르면 우리 짐작보다 사용자가 우선이다. */
export function clearRuntimeCooldown(
  runtime: Pick<RuntimeStatus, "kind" | "backend" | "source" | "model">,
): void {
  cooldowns.delete(runtimeCooldownKey(runtime));
}

/** 테스트 전용 — 프로세스 안 상태를 비운다. */
export function resetRuntimeCooldownsForTest(): void {
  signedOut.clear();
  cooldowns.clear();
}
