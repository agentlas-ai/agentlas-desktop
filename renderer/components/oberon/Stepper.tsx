// Oberon — 상단 단계 위저드. 화면 끝까지 균등 분포(connector flex:1) + 인디고 넘버드 서클.
// 이전 단계를 완료(승인)하기 전에는 다음 단계로 못 넘어간다(잠금).
"use client";
import { Fragment } from "react";
import { OBERON_STEPS, type OberonStepId, type StepState } from "@/lib/oberon";
import { Glyph } from "./icons";

export function Stepper({
  state,
  active,
  onSelect,
}: {
  state: Record<OberonStepId, StepState>;
  active: OberonStepId;
  onSelect: (id: OberonStepId) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        width: "100%",
        padding: "16px 40px 14px",
        borderBottom: "1px solid var(--ob-edge)",
        background: "var(--ob-surface)",
        boxSizing: "border-box",
      }}
    >
      {OBERON_STEPS.map((step, i) => {
        const st = state[step.id];
        const isActive = active === step.id;
        const clickable = st !== "locked";
        const prevDone = i > 0 && state[OBERON_STEPS[i - 1].id] === "done";

        return (
          <Fragment key={step.id}>
            {i > 0 && (
              <div
                aria-hidden
                style={{
                  flex: 1,
                  minWidth: 16,
                  height: 2,
                  marginTop: 14,
                  borderRadius: 2,
                  background: prevDone ? "var(--ob-accent)" : "var(--ob-edge-strong)",
                  transition: "background 0.25s",
                }}
              />
            )}
            <button
              type="button"
              onClick={() => clickable && onSelect(step.id)}
              disabled={!clickable}
              title={step.about}
              style={{
                flexShrink: 0,
                width: 92,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                padding: 0,
                border: "none",
                background: "transparent",
                cursor: clickable ? "pointer" : "default",
              }}
            >
              <Node state={st} isActive={isActive} index={i + 1} />
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: isActive ? 700 : 600,
                  color: st === "locked" ? "var(--ob-muted)" : isActive ? "var(--ob-ink)" : "var(--ob-ink-soft)",
                  lineHeight: 1.2,
                  textAlign: "center",
                  letterSpacing: 0,
                }}
              >
                {step.title}
              </span>
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

function Node({ state, isActive, index }: { state: StepState; isActive: boolean; index: number }) {
  const done = state === "done";
  const locked = state === "locked";

  // done = 인디고 채움+체크 · current = 인디고 채움+번호+soft 글로우 · upcoming/locked = 아웃라인
  const filled = done || isActive;
  const bg = filled ? "var(--ob-accent)" : "var(--ob-surface)";
  const fg = filled ? "#fff" : locked ? "var(--ob-muted)" : "var(--ob-ink-soft)";
  const border = filled ? "transparent" : "var(--ob-edge-strong)";

  return (
    <span
      style={{
        width: 30,
        height: 30,
        borderRadius: "50%",
        background: bg,
        border: `${filled ? 0 : 1.5}px solid ${border}`,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: fg,
        fontSize: 12.5,
        fontWeight: 700,
        fontFamily: "var(--font-mono)",
        fontVariantNumeric: "tabular-nums",
        boxShadow: isActive ? "0 0 0 4px var(--ob-accent-soft)" : "none",
        transition: "all 0.18s ease",
      }}
    >
      {done ? <Glyph name="check" size={14} strokeWidth={2.6} /> : locked ? <Glyph name="lock" size={11} strokeWidth={2} /> : index}
    </span>
  );
}
