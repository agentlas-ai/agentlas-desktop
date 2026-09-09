"use client";
// 빌드 MCP 인터뷰 카드 — grill-me 원칙(한 번에 하나, 추천 답변 동봉, 확실하면 안 물어봄)을 따른다.
// 이전 "전체 후보 한 번에 승인" 카드(McpBuildPlanCard) 대신, 실제로 판단이 필요한 후보만
// 하나씩 순서대로 묻는다:
//   · readiness가 ready/available인 후보는 개별 질문 없이 추천 목록에 포함
//   · runtime-incompatible은 이번 실행에서 사용자가 할 수 있는 게 없어 묻지 않고 자동 제외(안내만)
//   · missing-key/disabled만 "제외(추천)" vs "그래도 포함" 2지선다로 질문
//     — 같은 fallbackGroup에 이미 자동 포함된 대안이 있으면 추천 문구에 그 이름을 밝힌다
// 추천이 확정적이어도 MCP 연결은 외부 도구 권한 경계이므로 마지막 한 번의 명시적 동의를 받는다.
import { useEffect, useMemo, useState } from "react";
import type { McpBuildCandidate, McpBuildPlan } from "@/lib/types";

interface InterviewStep {
  candidate: McpBuildCandidate;
  alternativeName: string | null;
}

function candidateLabel(candidate: McpBuildCandidate, ko: boolean): string {
  const reasons: Record<McpBuildCandidate["recommendationReasonCode"], [string, string]> = {
    "browser-interaction": ["브라우저 조작이 필요한 요청", "The request needs browser interaction"],
    "desktop-interaction": ["데스크탑 조작이 필요한 요청", "The request needs desktop interaction"],
    "workspace-preview": ["로컬 개발 서버 미리보기가 필요한 요청", "The request needs a local development preview"],
    "agent-routing": ["에이전트·Hub 탐색이 필요한 요청", "The request may need agent or Hub routing"],
    "current-web-research": ["최신 웹 조사가 필요한 요청", "The request needs current web research"],
    "repository-work": ["저장소 작업이 포함된 요청", "The request includes repository work"],
    "workspace-files": ["워크스페이스 파일 작업이 필요한 요청", "The request needs workspace file access"],
    "database-work": ["데이터베이스 작업이 포함된 요청", "The request includes database work"],
    "notion-work": ["Notion 작업이 포함된 요청", "The request includes Notion work"],
    "linear-work": ["Linear 작업이 포함된 요청", "The request includes Linear work"],
    "slack-work": ["Slack 작업이 포함된 요청", "The request includes Slack work"],
    "discord-work": ["Discord 작업이 포함된 요청", "The request includes Discord work"],
    "ui-components": ["UI 컴포넌트 탐색이 필요한 요청", "The request needs UI component lookup"],
    "custom-name-match": ["사용자가 설치한 MCP 이름이 요청과 일치", "A user-installed MCP name matches the request"],
    "hub-plugin-match": ["Agentlas 허브 플러그인이 요청과 일치", "An Agentlas Hub plugin matches the request"],
    "task-match": ["요청과 기능이 일치", "The MCP capability matches the request"],
  };
  return reasons[candidate.recommendationReasonCode]?.[ko ? 0 : 1] ?? reasons["task-match"][ko ? 0 : 1];
}

function permissionBasis(candidate: McpBuildCandidate, ko: boolean): string {
  if (candidate.permissionBasis === "catalog-declared") return ko ? "카탈로그 명시" : "catalog-declared";
  if (candidate.permissionBasis === "host-inferred") return ko ? "호스트 추정" : "host estimate";
  return ko ? "확인 불가" : "unknown";
}

function readinessBadge(candidate: McpBuildCandidate, ko: boolean): string {
  if (candidate.readiness === "missing-key") return ko ? "키 없음" : "key missing";
  if (candidate.readiness === "runtime-incompatible") return ko ? "이 모델 미지원" : "runtime unsupported";
  if (candidate.readiness === "disabled") return ko ? "꺼짐" : "disabled";
  if (candidate.readiness === "available") return ko ? "키 불필요 · 승인 후 연결" : "no key · connect after approval";
  return candidate.keyState === "not-required" ? (ko ? "키 불필요" : "no key") : (ko ? "키 있음" : "key ready");
}

export function McpBuildInterviewCard(props: {
  plan: McpBuildPlan;
  ko: boolean;
  onApprove: (selectedIds: string[]) => void;
  onCancel: () => void;
}) {
  const { plan, ko } = props;

  /*
   * ★대화상자는 Escape 로 닫혀야 한다 (실측 2026-09-08).
   *   이 카드에는 Escape 처리가 없어 나가는 길이 "취소" 단추뿐이었다.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) return;
      event.stopPropagation();
      props.onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.onCancel]);

  const { autoIncludedIds, steps, incompatibleCount } = useMemo(() => {
    const readyByGroup = new Map<string, McpBuildCandidate>();
    for (const c of plan.candidates) {
      if (c.readiness === "ready" || c.readiness === "available") {
        if (!readyByGroup.has(c.fallbackGroup)) readyByGroup.set(c.fallbackGroup, c);
      }
    }
    const autoIncluded: string[] = [];
    const decisionSteps: InterviewStep[] = [];
    let incompatible = 0;
    for (const c of plan.candidates) {
      if (c.readiness === "ready" || c.readiness === "available") {
        autoIncluded.push(c.id);
      } else if (c.readiness === "missing-key" || c.readiness === "disabled") {
        const alt = readyByGroup.get(c.fallbackGroup);
        decisionSteps.push({ candidate: c, alternativeName: alt && alt.id !== c.id ? alt.name : null });
      } else {
        incompatible += 1;
      }
    }
    return { autoIncludedIds: autoIncluded, steps: decisionSteps, incompatibleCount: incompatible };
  }, [plan.candidates]);

  const [active, setActive] = useState(0);
  // 후보별 결정 — 기본값은 각 질문의 추천(제외)으로 미리 채워, Skip이 바로 그 값을 확정하게 한다.
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setActive(0);
    setDecisions({});
  }, [plan.id]);

  const step = steps[active];
  const isLast = active >= steps.length - 1;

  const selectedIds = (finalDecisions: Record<string, boolean>) => {
    const included = new Set(autoIncludedIds);
    for (const s of steps) {
      if (finalDecisions[s.candidate.id] ?? false) included.add(s.candidate.id);
    }
    return [...included];
  };

  const choose = (include: boolean) => {
    if (!step) return;
    const next = { ...decisions, [step.candidate.id]: include };
    setDecisions(next);
    if (isLast) setActive(steps.length);
    else setActive(active + 1);
  };

  const skip = () => choose(false); // 추천 답변(제외)을 그대로 채택

  const renderPlanSummary = (approvedIds: string[]) => {
    const approved = new Set(approvedIds);
    return (
      <>
        <div className="build-mcp-list">
          {plan.candidates.map((candidate) => {
            const blocked = candidate.readiness === "missing-key"
              || candidate.readiness === "disabled"
              || candidate.readiness === "runtime-incompatible";
            return (
              <div
                key={candidate.id}
                className="build-mcp-row titlebar-nodrag"
                data-selected={approved.has(candidate.id) ? "true" : "false"}
                data-blocked={blocked ? "true" : "false"}
              >
                <span className="build-mcp-check" aria-hidden="true">{approved.has(candidate.id) ? "✓" : ""}</span>
                <span className="build-mcp-copy">
                  <strong>{candidate.name}</strong>
                  <small>{candidateLabel(candidate, ko)}{candidate.installed ? ` · ${ko ? "시스템에 설치됨" : "installed system-wide"}` : ""}</small>
                  <small>
                    {ko ? "예상 필요 권한" : "Estimated required permission"}: {candidate.minimumPermission}
                    {" · "}{ko ? "범위" : "scope"}: {candidate.minimumScopes.join(", ")}
                    {" · "}{permissionBasis(candidate, ko)}
                    {" · "}{candidate.permissionEnforced ? (ko ? "강제됨" : "enforced") : (ko ? "강제 안 됨" : "not enforced")}
                  </small>
                </span>
                <span className="build-mcp-badge" data-state={candidate.readiness}>{readinessBadge(candidate, ko)}</span>
              </div>
            );
          })}
        </div>
        <p className="build-mcp-hint">
          {ko
            ? "표시 권한은 예상치입니다. 실제 API 키·서버·DB 계정 권한은 더 넓을 수 있으며, 권한 확대 감지는 아직 자동 강제하지 않습니다."
            : "Shown permissions are estimates. Actual API-key, server, or database-account access can be broader; permission widening is not yet automatically enforced."}
        </p>
      </>
    );
  };

  if (plan.candidates.length === 0) {
    return (
      <section className="build-card build-mcp-plan-card build-mcp-interview-card" aria-label={ko ? "MCP 연결 계획" : "MCP attachment plan"}>
        <div className="build-mcp-empty">
          {plan.status === "unavailable"
            ? ko
              ? "MCP 추천 서비스 불가 · 한 번 확인 후 MCP 없이 계속할 수 있습니다."
              : "MCP recommendation service unavailable · confirm once to continue without MCP."
            : ko
              ? "이 요청에 맞는 MCP 추천이 없습니다. MCP 없이 계속할 수 있습니다."
              : "No task-relevant MCP was found. You can continue without MCP."}
        </div>
        <div className="build-mcp-actions">
          <button type="button" className="build-secondary-button titlebar-nodrag" onClick={props.onCancel}>{ko ? "취소" : "Cancel"}</button>
          <button type="button" className="build-primary-button titlebar-nodrag" onClick={() => props.onApprove([])}>{ko ? "MCP 없이 계속" : "Continue without MCP"}</button>
        </div>
      </section>
    );
  }

  if (!step) {
    const approvedIds = selectedIds(decisions);
    const approvedNames = plan.candidates
      .filter((candidate) => approvedIds.includes(candidate.id))
      .map((candidate) => candidate.name);
    return (
      <section className="build-card build-mcp-plan-card build-mcp-interview-card titlebar-nodrag" role="dialog" aria-label={ko ? "MCP 연결 확인" : "Confirm MCP attachment"}>
        <div className="build-mcp-interview-head">
          <strong className="build-mcp-interview-question">{ko ? "MCP 연결을 확인해 주세요" : "Confirm MCP attachment"}</strong>
        </div>
        <p className="build-mcp-hint">
          {ko
            ? `추천 ${approvedIds.length}개를 준비했습니다. 아직 어떤 MCP도 연결하지 않았습니다.`
            : `${approvedIds.length} recommended MCP(s) are ready. Nothing has been attached yet.`}
        </p>
        {approvedNames.length > 0 && <div className="build-mcp-empty">{approvedNames.join(" · ")}</div>}
        {renderPlanSummary(approvedIds)}
        <div className="build-mcp-actions">
          <button type="button" className="build-secondary-button titlebar-nodrag" onClick={props.onCancel}>{ko ? "취소" : "Cancel"}</button>
          <button type="button" className="build-secondary-button titlebar-nodrag" onClick={() => props.onApprove([])}>{ko ? "MCP 없이 계속" : "Continue without MCP"}</button>
          {approvedIds.length > 0 && (
            <button type="button" className="build-primary-button titlebar-nodrag" onClick={() => props.onApprove(approvedIds)}>
              {ko ? `추천 ${approvedIds.length}개 연결하고 빌드` : `Attach ${approvedIds.length} and build`}
            </button>
          )}
        </div>
      </section>
    );
  }

  const altNote = step.alternativeName
    ? ko
      ? `제외 — 대신 이미 포함된 "${step.alternativeName}"을(를) 씁니다`
      : `Skip — "${step.alternativeName}" is already included instead`
    : ko
      ? "이 도구 없이 진행"
      : "Continue without this tool";
  const blockerNote =
    step.candidate.readiness === "missing-key"
      ? ko
        ? "이 도구는 API 키가 필요한데 현재 없습니다."
        : "This tool needs an API key that isn't set yet."
      : ko
        ? "이 도구는 현재 꺼져 있습니다."
        : "This tool is currently disabled.";

  return (
    <section className="build-card build-mcp-plan-card build-mcp-interview-card titlebar-nodrag" role="dialog" aria-label={ko ? "MCP 연결 질문" : "MCP attachment question"}>
      <div className="build-mcp-interview-head">
        {steps.length > 1 && <span className="build-mcp-interview-step">{active + 1}/{steps.length}</span>}
        <strong className="build-mcp-interview-question">{step.candidate.name}</strong>
      </div>
      <p className="build-mcp-hint">
        {candidateLabel(step.candidate, ko)} · {blockerNote}
      </p>
      {renderPlanSummary(selectedIds(decisions))}
      <div className="build-mcp-interview-opts">
        <button type="button" className="build-mcp-interview-opt" data-recommended="true" onClick={() => choose(false)}>
          <span className="build-mcp-interview-opt-body">
            <strong>{ko ? "제외 (추천)" : "Skip (recommended)"}</strong>
            <span>{altNote}</span>
          </span>
        </button>
        <button type="button" className="build-mcp-interview-opt" onClick={() => choose(true)}>
          <span className="build-mcp-interview-opt-body">
            <strong>{ko ? "그래도 포함" : "Include anyway"}</strong>
            <span>
              {ko
                ? "키 설정/활성화는 나중에 하고, 이번 빌드에는 일단 포함합니다."
                : "Set up the key or re-enable it later; include it in this build for now."}
            </span>
          </span>
        </button>
      </div>
      <div className="build-mcp-interview-foot">
        <span className="build-mcp-interview-hint">
          {incompatibleCount > 0
            ? ko
              ? `현재 런타임이 지원하지 않는 도구 ${incompatibleCount}개는 자동 제외됩니다.`
              : `${incompatibleCount} tool(s) unsupported by the current runtime are skipped automatically.`
            : ""}
        </span>
        <button type="button" className="build-mcp-interview-skip" onClick={props.onCancel}>{ko ? "취소" : "Cancel"}</button>
        <button type="button" className="build-mcp-interview-skip" onClick={() => props.onApprove([])}>{ko ? "MCP 없이 계속" : "Continue without MCP"}</button>
        <button type="button" className="build-mcp-interview-skip" onClick={skip}>{ko ? "건너뛰기" : "Skip"}</button>
        <button type="button" className="build-primary-button titlebar-nodrag" onClick={() => props.onApprove(selectedIds(decisions))}>
          {ko ? `선택 ${selectedIds(decisions).length}개로 빌드` : `Build with ${selectedIds(decisions).length} selected`}
        </button>
      </div>
    </section>
  );
}
