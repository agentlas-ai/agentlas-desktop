"use client";

import type { McpBuildCandidate, McpBuildPlan } from "@/lib/types";

function recommendation(candidate: McpBuildCandidate, ko: boolean): string {
  const copy: Record<McpBuildCandidate["recommendationReasonCode"], [string, string]> = {
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
  const base = copy[candidate.recommendationReasonCode]?.[ko ? 0 : 1] ?? copy["task-match"][ko ? 0 : 1];
  return candidate.installed
    ? `${base} · ${ko ? "시스템에 설치됨" : "installed system-wide"}`
    : base;
}

function permissionBasis(candidate: McpBuildCandidate, ko: boolean): string {
  if (candidate.permissionBasis === "catalog-declared") return ko ? "카탈로그 명시" : "catalog-declared";
  if (candidate.permissionBasis === "host-inferred") return ko ? "호스트 추정" : "host estimate";
  return ko ? "확인 불가" : "unknown";
}

function badge(candidate: McpBuildCandidate, ko: boolean): string {
  if (candidate.readiness === "missing-key") return ko ? "키 없음" : "key missing";
  if (candidate.readiness === "runtime-incompatible") return ko ? "이 모델 미지원" : "runtime unsupported";
  if (candidate.readiness === "disabled") return ko ? "꺼짐" : "disabled";
  if (candidate.readiness === "available") return ko ? "키 불필요 · 연결 예정" : "no key · connect after approval";
  return candidate.keyState === "not-required" ? (ko ? "키 불필요" : "no key") : (ko ? "키 있음" : "key ready");
}

export function McpBuildPlanCard(props: {
  plan: McpBuildPlan;
  selectedIds: string[];
  ko: boolean;
  onChange: (ids: string[]) => void;
  onApprove: () => void;
  onContinueWithout: () => void;
  onCancel: () => void;
}) {
  const selected = new Set(props.selectedIds);
  const toggle = (candidate: McpBuildCandidate) => {
    if (candidate.readiness === "missing-key" || candidate.readiness === "disabled" || candidate.readiness === "runtime-incompatible") return;
    const next = new Set(selected);
    if (next.has(candidate.id)) next.delete(candidate.id);
    else next.add(candidate.id);
    props.onChange([...next]);
  };

  return (
    <section className="build-card build-mcp-plan-card" aria-label={props.ko ? "MCP 연결 계획" : "MCP attachment plan"}>
      <div className="build-card-head">
        <span>{props.ko ? "MCP 연결 계획" : "MCP attachment plan"}</span>
        <span>{props.ko ? "한 번 확인" : "one confirmation"}</span>
      </div>
      <p className="build-mcp-hint">
        {props.ko
          ? "시스템 전역 MCP를 먼저 확인했습니다. 아직 설치·연결하지 않았으며, 승인한 항목만 각각 점검해서 정상인 것만 붙입니다."
          : "Agentlas checked the system-wide MCP registry first. Nothing has been installed or contacted yet; only approved items will be tested independently and healthy ones attached."}
      </p>
      {props.plan.status !== "ready" && (
        <div className="build-mcp-empty" role="status">
          {props.plan.status === "unavailable"
            ? (props.ko ? "MCP 추천 서비스 불가 · 한 번 확인 후 MCP 없이 계속할 수 있습니다." : "MCP recommendation service unavailable · confirm once to continue without MCP.")
            : (props.ko ? "일부 MCP 정보를 확인하지 못했습니다. 표시된 항목만 검토하거나 MCP 없이 계속하세요." : "Some MCP information could not be checked. Review only what is shown or continue without MCP.")}
        </div>
      )}
      <div className="build-mcp-list">
        {props.plan.candidates.length === 0 ? (
          props.plan.status === "ready" ? (
            <div className="build-mcp-empty">{props.ko ? "이 요청에 맞는 MCP 추천이 없습니다. MCP 없이 계속할 수 있습니다." : "No task-relevant MCP was found. You can continue without MCP."}</div>
          ) : null
        ) : props.plan.candidates.map((candidate) => {
          const blocked = candidate.readiness === "missing-key" || candidate.readiness === "disabled" || candidate.readiness === "runtime-incompatible";
          const active = selected.has(candidate.id);
          return (
            <button
              key={candidate.id}
              type="button"
              className="build-mcp-row titlebar-nodrag"
              data-selected={active ? "true" : "false"}
              data-blocked={blocked ? "true" : "false"}
              aria-pressed={active}
              onClick={() => toggle(candidate)}
            >
              <span className="build-mcp-check" aria-hidden="true">{active ? "✓" : ""}</span>
              <span className="build-mcp-copy">
                <strong>{candidate.name}</strong>
                <small>{recommendation(candidate, props.ko)}</small>
                <small>
                  {props.ko ? "예상 필요 권한" : "Estimated required permission"}: {candidate.minimumPermission}
                  {" · "}{props.ko ? "범위" : "scope"}: {candidate.minimumScopes.join(", ")}
                  {" · "}{permissionBasis(candidate, props.ko)}
                  {" · "}{candidate.permissionEnforced ? (props.ko ? "강제됨" : "enforced") : (props.ko ? "강제 안 됨" : "not enforced")}
                  {" · "}{candidate.requiresKey ? (props.ko ? "키 필요" : "key required") : (props.ko ? "키 불필요" : "no key")}
                </small>
              </span>
              <span className="build-mcp-badge" data-state={candidate.readiness}>{badge(candidate, props.ko)}</span>
            </button>
          );
        })}
      </div>
      <p className="build-mcp-hint">
        {props.ko
          ? "표시 권한은 예상치입니다. 실제 API 키·서버·DB 계정 권한은 더 넓을 수 있으며, 권한 확대 감지는 아직 자동 강제하지 않습니다."
          : "Shown permissions are estimates. Actual API-key, server, or database-account access can be broader; permission widening is not yet automatically enforced."}
      </p>
      <div className="build-mcp-actions">
        <button type="button" className="build-secondary-button titlebar-nodrag" onClick={props.onCancel}>{props.ko ? "취소" : "Cancel"}</button>
        <button type="button" className="build-secondary-button titlebar-nodrag" onClick={props.onContinueWithout}>{props.ko ? "MCP 없이 계속" : "Continue without MCP"}</button>
        {props.plan.candidates.length > 0 && (
          <button type="button" className="build-primary-button titlebar-nodrag" onClick={props.onApprove}>
            {props.ko ? `선택 ${props.selectedIds.length}개로 빌드` : `Build with ${props.selectedIds.length} selected`}
          </button>
        )}
      </div>
    </section>
  );
}
