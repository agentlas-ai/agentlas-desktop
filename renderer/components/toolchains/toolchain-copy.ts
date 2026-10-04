// Toolchain wording shared by the One rail (OneToolchains) and the Work
// management screen (ToolchainsManager). One source, so the two surfaces never
// describe the same state differently.

import type { ToolchainAutomationView, ToolchainCrystallizationView, ToolchainInterface } from "@shared/toolchain";

export type ToolchainCopy = ReturnType<typeof toolchainCopy>;

export function toolchainCopy(locale: string) {
  const ko = locale === "ko";
  return {
    title: ko ? "툴체인" : "Toolchains",
    subtitle: ko ? "반복 실행에서 배운 것 — 확실하지 않으면 원래 방식으로 돕니다" : "What repeated runs taught — anything uncertain runs the original way",
    analyze: ko ? "다시 분석" : "Analyze now",
    analyzing: ko ? "분석 중…" : "Analyzing…",
    empty: ko ? "아직 배운 것이 없습니다. 자동화가 같은 일을 여러 번 하면 여기에 나타납니다." : "Nothing learned yet. Repeated automation work appears here.",
    unavailable: ko ? "이 화면에서는 툴체인을 불러올 수 없습니다." : "Toolchains are unavailable here.",
    stateFile: (target: string, lines: number | null) => ko ? `상태 파일 미리 읽기 · ${target} (마지막 ${lines ?? 10}줄)` : `Pre-read state file · ${target} (last ${lines ?? 10} lines)`,
    pageRead: (target: string) => ko ? `페이지 읽기 · ${target}` : `Page read · ${target}`,
    evidence: (share: number, runs: number, weak: boolean) => ko
      ? `성공한 실행 ${runs}회 중 ${Math.round(share * 100)}%에서 반복${weak ? " · 판정 없이 완료만 확인됨" : ""}`
      : `Repeated in ${Math.round(share * 100)}% of ${runs} successful runs${weak ? " · completion only, not judged" : ""}`,
    shadow: (matches: number, need: number, mismatches: number) => ko
      ? `실제 실행과 비교 중 ${matches}/${need} 일치${mismatches ? ` · 불일치 ${mismatches}` : ""}`
      : `Comparing with real runs ${matches}/${need} matched${mismatches ? ` · ${mismatches} mismatched` : ""}`,
    active: (runs: number, rereads: number, fallbacks: number) => ko
      ? `적용 ${runs}회 · 에이전트가 다시 읽음 ${rereads} · 원래 방식으로 돌아감 ${fallbacks}`
      : `Applied ${runs} · agent re-read ${rereads} · fell back ${fallbacks}`,
    outcomes: (b: { accepted: number; judged: number }, a: { accepted: number; judged: number }) => ko
      ? `수락률 적용 전 ${b.accepted}/${b.judged} → 후 ${a.accepted}/${a.judged}`
      : `Accepted before ${b.accepted}/${b.judged} → after ${a.accepted}/${a.judged}`,
    cost: (c: { measuredEpisodes: number; avgReadChars: number; avgNodeInputTokens: number; readCapped: boolean }) => ko
      ? `측정 ${c.measuredEpisodes}회 · 페이지 읽기 결과 평균 ${c.readCapped ? "≥" : ""}${c.avgReadChars.toLocaleString()}자 · 이 단계 입력 평균 ${c.avgNodeInputTokens.toLocaleString()}토큰`
      : `Measured ${c.measuredEpisodes} runs · page reads avg ${c.readCapped ? "≥" : ""}${c.avgReadChars.toLocaleString()} chars · step input avg ${c.avgNodeInputTokens.toLocaleString()} tokens`,
    notMeasured: ko ? "아직 측정된 실행이 없습니다" : "No measured runs yet",
    observed: (step: string, target: string, share: number, waitingForIdentity: boolean) => ko
      ? `관찰 중 · ${step} 단계 · ${target} ${Math.round(share * 100)}%${waitingForIdentity ? " — 기준(80%)은 넘었고, 단계 기록이 쌓이면 비교를 시작합니다" : " (기준 80%)"}`
      : `Observing · step ${step} · ${target} ${Math.round(share * 100)}%${waitingForIdentity ? " — above 80%; comparison starts once step records accumulate" : " (needs 80%)"}`,
    state: {
      candidate: ko ? "측정 대기" : "Needs measurement",
      shadow: ko ? "비교 중" : "Comparing",
      ready: ko ? "적용 승인 대기" : "Ready to apply",
      active: ko ? "적용 중" : "Active",
      demoted: ko ? "중단됨" : "Stopped",
      rejected: ko ? "무시함" : "Dismissed",
      blacklisted: ko ? "맞지 않음" : "Did not match",
      superseded: ko ? "단계가 바뀜" : "Step changed",
    } as Record<string, string>,
    reason: {
      needs_cost_measurement: ko ? "읽기 비용을 먼저 잰 뒤 결정합니다" : "Decided after its cost is measured",
      shadow_matched: ko ? "비교한 실행이 모두 일치했습니다" : "Every compared run matched",
      shadow_mismatch: ko ? "실제 실행과 내용이 달랐습니다" : "Differed from what real runs read",
      agent_still_reads: ko ? "에이전트가 계속 직접 읽어 절약이 없었습니다" : "The agent kept reading it itself — no saving",
      outcome_regressed: ko ? "적용 후 수락률이 떨어졌습니다" : "Acceptance dropped after applying",
      file_missing: ko ? "파일이 없어 원래 방식으로 돌았습니다" : "File missing — ran the original way",
      folder_changed: ko ? "작업 폴더가 바뀌어 원래 방식으로 돌았습니다" : "Working folder changed — ran the original way",
      folder_unknown: ko ? "작업 폴더를 아직 모릅니다" : "Working folder not known yet",
      node_definition_changed: ko ? "단계 지시가 바뀌어 새로 배웁니다" : "The step changed; learning again",
      owner_approved: ko ? "승인함" : "Approved",
      owner_dismissed: ko ? "무시함" : "Dismissed",
      owner_demoted: ko ? "직접 껐습니다" : "Turned off",
      owner_retry: ko ? "다시 비교합니다" : "Comparing again",
    } as Record<string, string>,
    approve: ko ? "적용" : "Apply",
    dismiss: ko ? "무시" : "Dismiss",
    demote: ko ? "끄기" : "Turn off",
    retry: ko ? "다시 비교" : "Compare again",
    callableTitle: ko ? "One이 부를 수 있게" : "Callable by One",
    expose: ko ? "호출 가능하게 만들기" : "Make callable",
    exposing: ko ? "새 세션으로 시험 중…" : "Testing in a fresh session…",
    retest: ko ? "다시 시험" : "Test again",
    withdraw: ko ? "호출 중단" : "Withdraw",
    callable: ko ? "호출 가능" : "Callable",
    draft: ko ? "시험 미통과" : "Did not pass",
    deprecated: ko ? "중단됨" : "Withdrawn",
    stale: ko ? "자동화가 바뀌어 다시 시험이 필요합니다" : "Automation changed — test again",
    coldStart: (c: { positives: number; positiveFound?: number; positiveSelected: number; positiveBound: number; negatives: number; negativeSelected: number }) => ko
      ? `새 세션 시험: 맞는 요청 ${c.positives}개 중 검색 ${c.positiveFound ?? "?"}·선택 ${c.positiveSelected}·입력 ${c.positiveBound}, 아닌 요청 ${c.negatives}개 중 잘못 선택 ${c.negativeSelected}`
      : `Fresh-session test: of ${c.positives} fitting requests, found ${c.positiveFound ?? "?"} · chosen ${c.positiveSelected} · bound ${c.positiveBound}; ${c.negativeSelected} wrong picks of ${c.negatives}`,
    casesTitle: ko ? "시험한 요청 보기" : "Show test requests",
    caseVerdict: (k: { kind: "positive" | "negative"; found: boolean; selected: boolean; bound: boolean }) => k.kind === "positive"
      ? (k.bound ? (ko ? "통과" : "Passed") : k.selected ? (ko ? "입력 틀림" : "Wrong input") : k.found ? (ko ? "고르지 않음" : "Not chosen") : (ko ? "검색에서 못 찾음" : "Not found"))
      : (k.selected ? (ko ? "잘못 고름" : "Wrongly chosen") : (ko ? "정상 거절" : "Correctly declined")),
    caseKind: (kind: "positive" | "negative") => kind === "positive" ? (ko ? "맞는 요청" : "Should use") : (ko ? "아닌 요청" : "Should not"),
    usage: (returned: number, runs: number) => ko ? `검색에 나옴 ${returned} · 실제 호출 ${runs}` : `Returned by search ${returned} · called ${runs}`,
    others: (count: number) => ko ? `다른 자동화 ${count}개` : `${count} other automations`,
    viewAll: ko ? "전체 보기" : "View all",
    failed: ko ? "처리하지 못했습니다" : "Could not complete",
    errors: {
      no_isolated_runtime: ko
        ? "도구 없이 시험할 수 있는 모델이 연결돼 있지 않습니다. 시험 요청에 '게시해 줘' 같은 문장이 섞이므로 도구가 꺼진 모델(Claude 등)이 필요합니다."
        : "No model that can run with tools disabled is connected. Test requests include phrases like \"post this\", so a tool-free model (e.g. Claude) is required.",
      cold_start_unavailable: ko ? "시험용 모델 호출이 실패했습니다. 잠시 뒤 다시 시도하세요." : "The test model call failed. Try again shortly.",
      unreadable: ko ? "시험 모델의 답을 읽지 못했습니다. 다시 시도하세요." : "Could not read the test model's answer. Try again.",
      not_allowed: ko ? "지금 상태에서는 할 수 없는 동작입니다. 화면을 새로 고칩니다." : "That action is not allowed in the current state. Refreshing.",
    },
    // ── Work management screen ──
    manager: {
      subtitle: ko
        ? "One이 저장한 그래프를 다른 대화에서도 부를 수 있게 만든 도구, 그리고 반복 실행에서 배운 것"
        : "Graphs One saved and made callable from other conversations, and what repeated runs taught",
      localOnly: ko ? "학습·시험·실행은 이 컴퓨터에서만 일어납니다" : "Learning, testing and runs stay on this computer",
      search: ko ? "이름·용도로 찾기" : "Find by name or purpose",
      lanes: {
        all: ko ? "전체" : "All",
        callable: ko ? "호출 가능" : "Callable",
        learning: ko ? "학습 중" : "Learning",
        draft: ko ? "초안·중단" : "Draft & withdrawn",
        unregistered: ko ? "등록 안 함" : "Not registered",
      },
      laneEmpty: {
        all: ko ? "그래프가 있는 자동화가 아직 없습니다. One에게 반복할 일을 자동화로 만들어 달라고 하면 여기에 나타납니다." : "No automation with a graph yet. Ask One to turn repeated work into an automation and it appears here.",
        callable: ko ? "아직 호출 가능한 툴체인이 없습니다. One이 그래프를 저장하고 등록하거나, 아래 '등록 안 함'에서 직접 만들 수 있습니다." : "No callable toolchain yet. One can publish a graph it saved, or make one callable under Not registered.",
        learning: ko ? "지금 배우는 것이 없습니다. 같은 자동화가 10번 넘게 성공하면 반복되는 읽기를 찾기 시작합니다." : "Nothing is being learned. After 10 successful runs of one automation, repeated reads are looked for.",
        draft: ko ? "시험에 떨어졌거나 중단한 툴체인이 없습니다." : "No toolchain failed its test or was withdrawn.",
        unregistered: ko ? "모든 자동화가 툴체인으로 등록돼 있거나 학습 중입니다." : "Every automation is registered or being learned.",
      },
      noMatch: ko ? "찾는 이름의 툴체인이 없습니다." : "No toolchain matches that search.",
      loading: ko ? "불러오는 중…" : "Loading…",
      loadFailed: ko ? "툴체인 목록을 읽지 못했습니다. 비어 있는 것이 아닙니다 — 다시 분석을 눌러 보세요." : "Could not read toolchains. This is not an empty list — try Analyze now.",
      noDate: ko ? "기록 없음" : "No activity yet",
      exposedByOne: ko ? "One이 등록" : "Published by One",
      exposedByOwner: ko ? "직접 등록" : "Registered by you",
      tested: (at: string, model: string | null) => ko ? `시험 ${at}${model ? ` · ${model}` : ""}` : `Tested ${at}${model ? ` · ${model}` : ""}`,
      paused: ko ? "자동화 꺼짐" : "Automation off",
      contract: ko ? "계약 보기" : "Contract",
      whenToUse: ko ? "이럴 때 씀" : "Use when",
      whenNotToUse: ko ? "이럴 땐 안 씀" : "Do not use when",
      inputs: ko ? "입력" : "Inputs",
      noInputs: ko ? "입력 없음" : "No inputs",
      required: ko ? "필수" : "required",
      effects: {
        readOnly: ko ? "읽기만" : "Read-only",
        writes: ko ? "바깥을 바꿈" : "Changes the outside",
        destructive: ko ? "덮어쓰기·삭제 가능" : "May overwrite or delete",
        idempotent: ko ? "반복해도 같은 결과" : "Idempotent",
        openWorld: ko ? "외부 서비스 접근" : "Reaches outside services",
      },
      learned: ko ? "배운 것" : "Learned",
      openAutomation: ko ? "자동화 열기" : "Open automation",
      focused: ko ? "답변에서 연 툴체인" : "Opened from an answer",
    },
  };
}

/** Main refusals carry a machine code; say what it means, never the code. */
export function toolchainErrorText(error: unknown, copy: ToolchainCopy): string {
  const message = String(error instanceof Error ? error.message : error ?? "");
  if (/no_isolated_runtime/.test(message)) return copy.errors.no_isolated_runtime;
  if (/toolchain_cold_start_unavailable/.test(message)) return copy.errors.cold_start_unavailable;
  if (/toolchain_cold_start_(?:generation|selection)_unreadable/.test(message)) return copy.errors.unreadable;
  if (/toolchain_decision_not_allowed/.test(message)) return copy.errors.not_allowed;
  return copy.failed;
}

export function crystallizationLabel(item: ToolchainCrystallizationView, copy: ToolchainCopy): string {
  return item.kind === "state_file_read" ? copy.stateFile(item.target, item.lines) : copy.pageRead(item.target);
}

export function interfaceStateLabel(view: ToolchainAutomationView, copy: ToolchainCopy): string | null {
  const contract: ToolchainInterface | null = view.interface;
  if (!contract) return null;
  if (view.interfaceStale) return copy.stale;
  return contract.state === "callable" ? copy.callable : contract.state === "draft" ? copy.draft : copy.deprecated;
}
