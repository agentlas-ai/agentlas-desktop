// Main-process i18n catalog for user-facing DISPLAY copy emitted by the "One"
// module. Main cannot import the renderer React catalog (renderer/lib/i18n.tsx
// is "use client"), so this is a plain-TS mirror of the same tFor semantics.
//
// Rules (same discipline as runtime/status-i18n.ts):
//  - Every key MUST be present in both ko and en.
//  - Only strings that are actually rendered to the user live here. Content-
//    detection regexes, structural column keys, and Intl locale args stay in
//    their call sites — they match content in both languages and are not copy.
//  - Callers pass the language they already resolved. For UI-locale surfaces
//    that is currentUiLocale(); for content-driven surfaces it is the local
//    Hangul-detection boolean that chooses the language to render in.
export type OneCopyLocale = "ko" | "en";

type Args = Record<string, string | number>;

function interpolate(template: string, args?: Args): string {
  if (!args) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => String(args[key] ?? ""));
}

// Keys are namespaced per source file so they never collide:
//   one.md.*   → markdown-surface.ts
//   one.mob.*  → mobile-suggestions.ts
//   one.cont.* → task-continuation.ts
//   one.onbe.* → onboarding.ts
const ONE_COPY = {
  ko: {
    // markdown-surface.ts — deterministic One Surface labels
    "one.md.headingRec": "{product} 추천",
    "one.md.recommended": "추천",
    "one.md.bestMatch": "조건에 가장 잘 맞는 추천",
    "one.md.widgetSummary": "핵심 요약",
    "one.md.widgetSchedule": "날짜별 일정",
    "one.md.widgetBudget": "예상 예산",
    "one.md.widgetComparison": "비교",
    "one.md.widgetDetails": "확인한 내용",
    "one.md.widgetBeforeYouGo": "출발 전 확인",
    "one.md.widgetFiles": "만든 파일",
    "one.md.widgetSources": "확인한 출처",
    // mobile-suggestions.ts — ecosystem suggestion copy + member fallbacks
    "one.mob.agentBuildTitle": "이 역할을 내 에이전트로 정리할까요?",
    "one.mob.agentBuildBody": "반복해서 확인된 작업 범위만 가져와 검토용 정의 초안을 준비합니다.",
    "one.mob.retainTeamTitle": "이 조합을 내 팀으로 둘까요?",
    "one.mob.retainTeamBody": "이번 작업에서만 다시 쓰거나, 검토 후 팀 초안으로 저장할 수 있습니다.",
    "one.mob.automationTitle": "이 반복 작업을 자동화로 검토할까요?",
    "one.mob.automationBody": "트리거와 권한, 중지 조건을 먼저 검토합니다. 아직 예약되거나 실행되지 않았습니다.",
    "one.mob.hubDerivativeTitle": "공개용 파생 에이전트를 검토할까요?",
    "one.mob.hubDerivativeBody": "원본 파일을 복사하지 않는 생성형 검토 스캐폴드만 준비합니다. 권리·게시 자격·경제·수수료는 미확인이며 게시나 수익은 보장되지 않습니다.",
    "one.mob.memberExternal": "외부 전문가",
    "one.mob.memberUnavailable": "확인이 필요한 구성원",
    "one.mob.memberInstalled": "설치된 에이전트",
    // task-continuation.ts — follow-up conversation seed message
    "one.cont.headerAccepted": "완료한 이전 일에서 이어갑니다 · {title}",
    "one.cont.headerPending": "검토 중인 이전 일에서 이어갑니다 · {title}",
    "one.cont.newRequestNote": "새 요청은 별도의 일로 처리합니다. 이전 팀·권한·임시 첨부는 자동으로 이어받지 않았어요.",
    "one.cont.fallbackPrevWork": "이전 일",
    "one.cont.fallbackSummary": "이전 결과의 핵심 맥락을 이어받았습니다.",
    "one.cont.fallbackFollowup": "이어지는 일",
    // onboarding.ts — starter team group metadata
    "one.onbe.groupName": "스타터 팀",
    "one.onbe.groupDescription":
      "One 온보딩에서 만든 로컬 스타터 팀입니다. 선택한 공개 패키지 버전을 고정해 예기치 않은 변경을 막습니다.",
    "one.onbe.orchestratorName": "Las 오케스트레이터",
  },
  en: {
    // markdown-surface.ts — deterministic One Surface labels
    "one.md.headingRec": "{product} recommendation",
    "one.md.recommended": "Recommended",
    "one.md.bestMatch": "Best match for the request",
    "one.md.widgetSummary": "Summary",
    "one.md.widgetSchedule": "Schedule",
    "one.md.widgetBudget": "Budget",
    "one.md.widgetComparison": "Comparison",
    "one.md.widgetDetails": "Details",
    "one.md.widgetBeforeYouGo": "Before you go",
    "one.md.widgetFiles": "Files",
    "one.md.widgetSources": "Sources",
    // mobile-suggestions.ts — ecosystem suggestion copy + member fallbacks
    "one.mob.agentBuildTitle": "Turn this role into your agent?",
    "one.mob.agentBuildBody": "One can prepare a review-only definition draft from the repeatedly observed scope.",
    "one.mob.retainTeamTitle": "Keep this combination as your team?",
    "one.mob.retainTeamBody": "Reuse it for this task only, or review a team draft before saving anything.",
    "one.mob.automationTitle": "Review this repeated task as an automation?",
    "one.mob.automationBody": "Review the trigger, permission, and stop control first. Nothing is scheduled or running.",
    "one.mob.hubDerivativeTitle": "Review a public derivative for Hub?",
    "one.mob.hubDerivativeBody": "Prepare only a generated review scaffold with no source files copied. Rights, entitlement, economy, and fees are unknown; publishing and earnings are not guaranteed.",
    "one.mob.memberExternal": "External specialist",
    "one.mob.memberUnavailable": "Unavailable member",
    "one.mob.memberInstalled": "Installed agent",
    // task-continuation.ts — follow-up conversation seed message
    "one.cont.headerAccepted": "Continuing from the completed work · {title}",
    "one.cont.headerPending": "Continuing from the result-ready work · {title}",
    "one.cont.newRequestNote": "This request starts separate work. The previous team, permissions, and temporary attachments were not carried over automatically.",
    "one.cont.fallbackPrevWork": "Previous work",
    "one.cont.fallbackSummary": "The key context from the previous result was carried forward.",
    "one.cont.fallbackFollowup": "Follow-up work",
    // onboarding.ts — starter team group metadata
    "one.onbe.groupName": "Starter team",
    "one.onbe.groupDescription":
      "Local starter team created during One onboarding. Selected public package versions are pinned to prevent unexpected changes.",
    "one.onbe.orchestratorName": "Las Orchestrator",
  },
} as const;

export type OneCopyKey = keyof typeof ONE_COPY["ko"];

/**
 * Resolve One display copy for a locale. Mirrors the renderer tFor semantics:
 * prefer the requested locale, fall back to English, then to the raw key, and
 * interpolate `{var}` placeholders from `vars`.
 */
export function oneText(locale: OneCopyLocale, key: OneCopyKey, vars?: Args): string {
  const template = ONE_COPY[locale][key] ?? ONE_COPY.en[key] ?? key;
  return interpolate(template, vars);
}
