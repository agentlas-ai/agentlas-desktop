"use client";
// 빌드 MCP 인터뷰 카드 — grill-me 원칙(한 번에 하나, 추천 답변 동봉, 확실하면 안 물어봄)을 따른다.
// 이전 "전체 후보 한 번에 승인" 카드(McpBuildPlanCard) 대신, 실제로 판단이 필요한 후보만
// 하나씩 순서대로 묻는다:
//   · readiness가 ready/available인 후보는 묻지 않고 자동 포함
//   · runtime-incompatible은 이번 실행에서 사용자가 할 수 있는 게 없어 묻지 않고 자동 제외(안내만)
//   · missing-key/disabled만 "제외(추천)" vs "그래도 포함" 2지선다로 질문
//     — 같은 fallbackGroup에 이미 자동 포함된 대안이 있으면 추천 문구에 그 이름을 밝힌다
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
    "task-match": ["요청과 기능이 일치", "The MCP capability matches the request"],
  };
  return reasons[candidate.recommendationReasonCode]?.[ko ? 0 : 1] ?? reasons["task-match"][ko ? 0 : 1];
}

export function McpBuildInterviewCard(props: {
  plan: McpBuildPlan;
  ko: boolean;
  onApprove: (selectedIds: string[]) => void;
  onCancel: () => void;
}) {
  const { plan, ko } = props;

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

  const finish = (finalDecisions: Record<string, boolean>) => {
    const included = new Set(autoIncludedIds);
    for (const s of steps) {
      if (finalDecisions[s.candidate.id] ?? false) included.add(s.candidate.id);
    }
    props.onApprove([...included]);
  };

  const choose = (include: boolean) => {
    if (!step) return;
    const next = { ...decisions, [step.candidate.id]: include };
    setDecisions(next);
    if (isLast) finish(next);
    else setActive(active + 1);
  };

  const skip = () => choose(false); // 추천 답변(제외)을 그대로 채택

  // 질문이 하나도 없으면(전부 자동 판정) 즉시 확정 — grill-me 원칙: 확실하면 안 물어본다.
  useEffect(() => {
    if (plan.candidates.length > 0 && steps.length === 0) finish({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.id, steps.length]);

  if (plan.candidates.length === 0) {
    return (
      <section className="build-card build-mcp-interview-card" aria-label={ko ? "MCP 연결 계획" : "MCP attachment plan"}>
        <div className="build-mcp-empty">
          {ko ? "이 요청에 맞는 MCP 추천이 없습니다. MCP 없이 계속할 수 있습니다." : "No task-relevant MCP was found. You can continue without MCP."}
        </div>
        <div className="build-mcp-actions">
          <button type="button" className="build-secondary-button titlebar-nodrag" onClick={props.onCancel}>{ko ? "취소" : "Cancel"}</button>
          <button type="button" className="build-primary-button titlebar-nodrag" onClick={() => props.onApprove([])}>{ko ? "계속" : "Continue"}</button>
        </div>
      </section>
    );
  }

  if (!step) return null; // 자동 확정 이펙트가 이번 렌더 직후 처리한다.

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
    <section className="build-card build-mcp-interview-card titlebar-nodrag" role="dialog" aria-label={ko ? "MCP 연결 질문" : "MCP attachment question"}>
      <div className="build-mcp-interview-head">
        {steps.length > 1 && <span className="build-mcp-interview-step">{active + 1}/{steps.length}</span>}
        <strong className="build-mcp-interview-question">{step.candidate.name}</strong>
      </div>
      <p className="build-mcp-hint">
        {candidateLabel(step.candidate, ko)} · {blockerNote}
      </p>
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
        <button type="button" className="build-mcp-interview-skip" onClick={skip}>{ko ? "건너뛰기" : "Skip"}</button>
      </div>
    </section>
  );
}
