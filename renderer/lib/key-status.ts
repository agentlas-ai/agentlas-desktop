// BYOC 키/구독 상태를 UsageSnapshot 에서 도출하는 단일 로직.
// 기획안 비평 5번(통제의 대가): "키 사망(만료/한도초과/다운그레이드) 시 모든 일꾼이 죽는다"를
// 화면이 책임져야 한다. 세 화면 공통 KeyStatusBanner 가 이 결과를 소비한다.
//
// 실측 원칙: UsageSnapshot.providers 의 status/usedPercent 에서만 도출한다. 추측 금지.
import type { UsageProviderErrorCode, UsageSnapshot } from "./types";

export type KeyHealth = "ok" | "warning" | "error" | "unknown";

export interface KeyStatus {
  health: KeyHealth;
  /** 한도 임박/오류인 프로바이더 라벨들 (실측). */
  affected: string[];
  /** 키 사망이 실측되지 않은(= 계속 일할 수 있는) 프로바이더 수 — 0이면 전 함대 정지. */
  connected: number;
}

/** usedPercent 가 이 값 이상이면 한도 임박 경고. */
const NEAR_LIMIT_PERCENT = 90;

// status="error" 는 "키가 죽었다"가 아니라 "usage 조회가 실패했다"는 뜻이다.
// 그 중 실제로 일꾼을 멈추는 것은 자격증명/한도 계열뿐이고, 429·네트워크·프록시 차단·
// unsupported_client(Antigravity 등 usage 미제공 런타임)는 키가 멀쩡해도 발생한다.
// main(electron/usage/index.ts)은 last-good 스냅샷이 2h 안에 있을 때만 이 일시 장애를 가려주므로
// 신규 설치·장기 차단에서는 그대로 렌더러까지 올라온다 — 그래서 판정은 여기서 코드로 해야 한다.
// EngineUsage 가 429를 "일시 제한(429)"로 따로 라벨하는 것과 같은 기준.
const KEY_DEATH_ERRORS: ReadonlySet<UsageProviderErrorCode> = new Set<UsageProviderErrorCode>([
  "auth_expired",
  "credentials_corrupt",
  "keychain_blocked",
  "quota_exhausted",
]);

function isKeyDeath(status: string, error?: UsageProviderErrorCode): boolean {
  return status === "error" && !!error && KEY_DEATH_ERRORS.has(error);
}

export function deriveKeyStatus(snap: UsageSnapshot | null | undefined): KeyStatus {
  if (!snap || !Array.isArray(snap.providers)) {
    return { health: "unknown", affected: [], connected: 0 };
  }
  const providers = snap.providers;
  if (providers.length === 0) return { health: "unknown", affected: [], connected: 0 };

  const dead = providers.filter((p) => isKeyDeath(p.status, p.error));
  // usage 조회에 성공한 프로바이더만 "살아있음"을 실측한 것이다. 조회 실패(일시/미제공)는
  // 살아있다는 근거도, 죽었다는 근거도 아니다 — 어느 쪽으로도 단정하지 않는다.
  const healthy = providers.filter((p) => p.status !== "error");
  const connected = providers.length - dead.length;

  const nearLimit = providers
    .filter((p) => p.status === "ok" && p.windows.some((w) => (w.usedPercent ?? 0) >= NEAR_LIMIT_PERCENT))
    .map((p) => p.label);

  // 전 프로바이더가 '키 사망'으로 실측된 경우에만 "모든 에이전트가 멈춥니다"를 단언한다.
  if (connected === 0) return { health: "error", affected: dead.map((p) => p.label), connected: 0 };
  // 살아있음이 하나도 실측되지 않았다(전부 429/네트워크/미제공). 키는 멀쩡할 수 있으니
  // "정상"도 "끊김"도 주장하지 않고 판단을 보류한다 — 배너/pill 모두 침묵.
  if (healthy.length === 0) return { health: "unknown", affected: [], connected };
  // 한도 임박만 경고로 올린다. 일부 프로바이더의 usage 조회 실패(transient)는
  // "한도 임박"과 다른 사안이므로 경고 배너로 오인시키지 않는다(연결 자체는 살아있음).
  if (nearLimit.length > 0) return { health: "warning", affected: nearLimit, connected };
  return { health: "ok", affected: [], connected };
}
