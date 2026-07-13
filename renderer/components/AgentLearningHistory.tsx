"use client";

import { useState } from "react";

import type { Locale } from "@/lib/i18n";

export type AgentLearningEventType = "skill" | "sync" | "evolution" | "resolve";

export interface AgentLearningEvent {
  id: string;
  timestamp: string;
  title: string;
  desc: string;
  type: AgentLearningEventType;
  kind?: string;
  confidence?: "high" | "medium" | "low";
  detail?: string;
}

const eventColor: Record<AgentLearningEventType, string> = {
  skill: "var(--purple-deep)",
  sync: "var(--accent)",
  evolution: "var(--amber-deep)",
  resolve: "var(--green-deep)",
};

function confidenceColor(confidence: "high" | "medium" | "low"): string {
  if (confidence === "high") return "var(--green-deep)";
  if (confidence === "medium") return "var(--amber-deep)";
  return "var(--muted-deep)";
}

export function memoryKindLabel(kind: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    fact: ["확인한 내용", "Verified"],
    decision: ["정한 기준", "Decision"],
    preference: ["사용자 선호", "Preference"],
    risk: ["문제 해결", "Problem solved"],
    gotcha: ["주의할 점", "Caution"],
    procedure: ["작업 방법", "How-to"],
    hypothesis: ["확인 필요", "To verify"],
    evidence: ["참고 사례", "Example"],
    deprecation: ["사용 중단", "Retired"],
    conflict: ["정보 충돌", "Conflict"],
  };
  const [ko, en] = labels[kind.toLowerCase()] ?? ["새로 배운 내용", "New learning"];
  return locale === "ko" ? ko : en;
}

export function confidenceLabel(confidence: "high" | "medium" | "low", locale: Locale): string {
  const labels = {
    high: locale === "ko" ? "신뢰도 높음" : "High confidence",
    medium: locale === "ko" ? "신뢰도 보통" : "Medium confidence",
    low: locale === "ko" ? "검토 필요" : "Needs review",
  };
  return labels[confidence];
}

type Props = {
  events: AgentLearningEvent[];
  locale: Locale;
  limit?: number;
  compact?: boolean;
  emptyMessage?: string;
};

export function AgentLearningHistory({ events, locale, limit, compact = false, emptyMessage }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const visibleEvents = typeof limit === "number" ? events.slice(0, limit) : events;

  if (visibleEvents.length === 0) {
    return (
      <div data-testid="agent-learning-history" style={{ padding: "12px 2px", fontSize: 12, color: "var(--muted-deep)", lineHeight: 1.55 }}>
        {emptyMessage ?? (locale === "ko"
          ? "아직 배운 내용이 없습니다. 작업을 완료하면 유용한 내용이 여기에 쌓입니다."
          : "Nothing learned yet. Useful takeaways will appear here after completed work.")}
      </div>
    );
  }

  return (
    <div data-testid="agent-learning-history" style={{ display: "flex", flexDirection: "column", gap: compact ? 8 : 10 }}>
      {visibleEvents.map((event) => {
        const color = eventColor[event.type];
        const isExpanded = Boolean(expanded[event.id]);
        return (
          <article
            key={event.id}
            style={{
              position: "relative",
              border: "1px solid var(--paper-edge)",
              borderRadius: 12,
              padding: compact ? "10px 12px" : "12px 14px",
              background: "var(--paper-2)",
              boxShadow: "0 1px 2px rgba(20, 20, 20, 0.03)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginBottom: 5 }}>
              <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 999, background: color, flexShrink: 0 }} />
              <strong style={{ fontSize: 12.5, color: "var(--ink)", lineHeight: 1.35 }}>{event.title}</strong>
              <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--muted-deep)", whiteSpace: "nowrap" }}>
                {event.timestamp}
              </span>
            </div>
            {(event.kind || event.confidence) && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", marginBottom: 6, paddingLeft: 14 }}>
                {event.kind && (
                  <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 999, background: "var(--fill-1)", color, fontWeight: 700 }}>
                    {memoryKindLabel(event.kind, locale)}
                  </span>
                )}
                {event.confidence && (
                  <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 999, border: "1px solid var(--paper-edge)", color: confidenceColor(event.confidence), fontWeight: 650 }}>
                    {confidenceLabel(event.confidence, locale)}
                  </span>
                )}
              </div>
            )}
            <p style={{ margin: 0, paddingLeft: 14, fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.55 }}>
              {event.desc}
            </p>
            {event.detail && (
              <div style={{ paddingLeft: 14, marginTop: 7 }}>
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() => setExpanded((current) => ({ ...current, [event.id]: !current[event.id] }))}
                  style={{
                    padding: 0,
                    border: 0,
                    background: "transparent",
                    color: "var(--muted-deep)",
                    fontSize: 10.5,
                    fontWeight: 650,
                    cursor: "pointer",
                  }}
                >
                  {isExpanded
                    ? (locale === "ko" ? "기술 기록 숨기기" : "Hide technical record")
                    : (locale === "ko" ? "기술 기록 보기" : "View technical record")}
                </button>
                {isExpanded && (
                  <div
                    style={{
                      marginTop: 7,
                      padding: "9px 10px",
                      borderRadius: 8,
                      background: "var(--paper)",
                      border: "1px solid var(--paper-edge)",
                      color: "var(--muted-deep)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 10.5,
                      lineHeight: 1.5,
                      overflowWrap: "anywhere",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {event.detail}
                  </div>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
