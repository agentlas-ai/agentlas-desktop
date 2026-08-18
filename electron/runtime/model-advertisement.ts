import type { RuntimeStatus } from "../../shared/types";
import { cliModels } from "../../shared/models";

/**
 * 런타임 모델 광고 어댑터 — 모든 런타임의 `allocationModels`/`allocationModelProfiles`를
 * 한 곳에서 같은 규칙으로 만든다.
 *
 * 배경(2026-08-18 실측): 런타임별 손코딩이 서로 다른 의미를 갖고 있었다 —
 * claude/byok는 "현재 선택된 모델 1개"만, codex/antigravity/grok은 디스커버리 실패 시
 * 빈 배열을 광고했다. 그 결과 부모 플래너가 워커 티어를 낮추려 해도
 * `parent-model-not-in-live-inventory-active-preserved`로 전부 기각됐고, 전 기간 트랜스크립트에서
 * economy 티어 배정이 사실상 0건이었다(haiku 2회/18K 호출).
 *
 * 규칙(우선순위 순):
 * 1. 라이브 디스커버리가 최우선 권위다 — 런타임이 실제 광고한 목록을 그대로 쓴다.
 * 2. 라이브가 비어 있으면, `catalogFallback`이 허용된 런타임에 한해 호스트 카탈로그
 *    별칭(cliModels)을 광고한다. 별칭 실행이 계정 자격에 따라 실패할 수 있으므로,
 *    이 폴백을 켠 호출자는 워커 실패 시 기본 모델로 재시도하는 안전망과 함께 써야 한다
 *    (swarm-run의 allocated-worker-fallback). 카탈로그가 표시 전용이라 자격을 전혀
 *    보증하지 못하는 런타임(cursor)은 반드시 false로 둔다.
 * 3. 현재 선택/활성 모델은 항상 포함한다 — 실행이 이미 증명된 유일한 값이다.
 */
export interface AllocationAdvertisementSpec {
  /** cliModels() 카탈로그 키. 생략하면 카탈로그 병합/폴백 없이 라이브만 쓴다. */
  catalogKind?: string;
  /** 런타임이 실제 광고한 라이브 모델 목록(디스커버리 결과). */
  live?: readonly (string | null | undefined)[] | null;
  /** 현재 선택/활성 모델 — 항상 광고에 포함된다. */
  selected?: string | null;
  /** 라이브가 비었을 때 호스트 카탈로그 별칭을 광고할지. §규칙 2 참조. */
  catalogFallback: boolean;
  /** 런타임이 직접 광고한 모델별 프로필 — 카탈로그·이름 추론보다 우선. */
  liveProfiles?: RuntimeStatus["allocationModelProfiles"];
  /** 이 kind 전체에 공통인 호스트 실측 기본값(예: claude 200K 컨텍스트). */
  profileDefaults?: Partial<NonNullable<RuntimeStatus["allocationModelProfiles"]>[string]>;
}

type Profiles = NonNullable<RuntimeStatus["allocationModelProfiles"]>;
type Profile = Profiles[string];

/**
 * 이름 기반 티어 분류 — 카탈로그에도 라이브 프로필에도 티어가 없을 때의 마지막 폴백.
 * 공급자 공통 어휘의 단어 경계 토큰만 본다. 모호한 이름은 분류하지 않는다(null) —
 * 티어가 없어도 배정은 가능하고(정확 모델 지정), 잘못 붙인 티어는
 * `requested-exact-model-tier-mismatch`로 유효한 배정을 기각시키기 때문이다.
 */
const TIER_NAME_TOKENS: Array<{ tier: NonNullable<Profile["costTier"]>; tokens: string[] }> = [
  { tier: "economy", tokens: ["haiku", "luna", "flash", "mini", "lite", "nano", "fast"] },
  { tier: "balanced", tokens: ["sonnet", "terra", "tera", "composer", "air"] },
  { tier: "frontier", tokens: ["opus", "sol", "fable"] },
];

export function classifyTierByName(modelId: string): Profile["costTier"] | null {
  const normalized = modelId.toLowerCase();
  for (const { tier, tokens } of TIER_NAME_TOKENS) {
    for (const token of tokens) {
      // 단어 경계: 구분자(-, _, ., /, 공백) 또는 문자열 끝으로 둘러싸인 토큰만 매치.
      const re = new RegExp(`(^|[-_./ ])${token}($|[-_./ 0-9])`);
      if (re.test(normalized)) return tier;
    }
  }
  return null;
}

function mergedProfile(
  modelId: string,
  spec: AllocationAdvertisementSpec,
  catalogTier: Profile["costTier"] | undefined,
): Profile | null {
  const live = spec.liveProfiles?.[modelId];
  const defaults = spec.profileDefaults ?? {};
  const costTier = live?.costTier ?? catalogTier ?? defaults.costTier ?? classifyTierByName(modelId) ?? undefined;
  const merged: Profile = {
    ...(costTier ? { costTier } : {}),
    ...(live?.contextWindow ?? defaults.contextWindow
      ? { contextWindow: live?.contextWindow ?? defaults.contextWindow }
      : {}),
    ...(live?.capabilities ?? defaults.capabilities
      ? { capabilities: live?.capabilities ?? defaults.capabilities }
      : {}),
    ...(live?.supportsTools ?? defaults.supportsTools !== undefined
      ? { supportsTools: live?.supportsTools ?? defaults.supportsTools }
      : {}),
    ...(live?.supportsMultimodal ?? defaults.supportsMultimodal !== undefined
      ? { supportsMultimodal: live?.supportsMultimodal ?? defaults.supportsMultimodal }
      : {}),
    ...(live?.efforts ?? defaults.efforts ? { efforts: live?.efforts ?? defaults.efforts } : {}),
    ...(live?.defaultEffort ?? defaults.defaultEffort
      ? { defaultEffort: live?.defaultEffort ?? defaults.defaultEffort }
      : {}),
  };
  return Object.keys(merged).length > 0 ? merged : null;
}

/** 광고 본체 — detect.ts의 각 런타임 분기가 이 한 함수만 부른다. */
export function allocationAdvertisement(
  spec: AllocationAdvertisementSpec,
): Pick<RuntimeStatus, "allocationModels" | "allocationModelProfiles"> {
  const liveClean = (spec.live ?? [])
    .filter((model): model is string => typeof model === "string" && model.trim().length > 0)
    .map((model) => model.trim());
  const catalog = spec.catalogKind ? cliModels(spec.catalogKind) : [];
  const catalogTierById = new Map(
    catalog.flatMap((model) => (model.workforceTier ? [[model.id, model.workforceTier] as const] : [])),
  );
  const base = liveClean.length > 0
    ? liveClean
    : spec.catalogFallback
      ? catalog.map((model) => model.id)
      : [];
  const allocationModels = [
    ...new Set([...base, ...(spec.selected && spec.selected.trim() ? [spec.selected.trim()] : [])]),
  ];
  const allocationModelProfiles: Profiles = {};
  for (const modelId of allocationModels) {
    const profile = mergedProfile(modelId, spec, catalogTierById.get(modelId));
    if (profile) allocationModelProfiles[modelId] = profile;
  }
  return {
    allocationModels,
    ...(Object.keys(allocationModelProfiles).length > 0 ? { allocationModelProfiles } : {}),
  };
}
