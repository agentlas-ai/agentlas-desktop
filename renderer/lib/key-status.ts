// BYOC 키/구독 상태를 UsageSnapshot 에서 도출하는 단일 로직.
// 기획안 비평 5번(통제의 대가): "키 사망(만료/한도초과/다운그레이드) 시 모든 일꾼이 죽는다"를
// 화면이 책임져야 한다. 세 화면 공통 KeyStatusBanner 가 이 결과를 소비한다.
//
// 실측 원칙: UsageSnapshot.providers 의 status/usedPercent 에서만 도출한다. 추측 금지.
import type { UsageSnapshot } from "./types";

export type KeyHealth = "ok" | "warning" | "error" | "unknown";

export interface KeyStatus {
  health: KeyHealth;
  /** 한도 임박/오류인 프로바이더 라벨들 (실측). */
  affected: string[];
  /** 연결된(과금 가능한) 프로바이더 수 — 0이면 BYOC 키 미연결. */
  connected: number;
}

/** usedPercent 가 이 값 이상이면 한도 임박 경고. */
const NEAR_LIMIT_PERCENT = 90;

export function deriveKeyStatus(snap: UsageSnapshot | null | undefined): KeyStatus {
  if (!snap || !Array.isArray(snap.providers)) {
    return { health: "unknown", affected: [], connected: 0 };
  }
  const providers = snap.providers;
  const connected = providers.filter((p) => p.status !== "error").length;

  const errored = providers.filter((p) => p.status === "error").map((p) => p.label);
  const nearLimit = providers
    .filter((p) => p.status === "ok" && p.windows.some((w) => (w.usedPercent ?? 0) >= NEAR_LIMIT_PERCENT))
    .map((p) => p.label);

  if (providers.length === 0) return { health: "unknown", affected: [], connected: 0 };

  // 모든 프로바이더가 error → 전 함대 정지(키 사망).
  if (connected === 0) return { health: "error", affected: errored, connected: 0 };
  // 일부 error 또는 한도 임박 → 경고.
  if (errored.length > 0) return { health: "warning", affected: errored, connected };
  if (nearLimit.length > 0) return { health: "warning", affected: nearLimit, connected };
  return { health: "ok", affected: [], connected };
}
