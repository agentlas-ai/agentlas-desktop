"use client";

/**
 * 결과 레일 안의 "에이전트가 보는 화면" — One 과 같은 자리에서 같은 모양으로 본다.
 *
 * 브라우저·컴퓨터 도구가 도는 동안 사람이 보고 싶은 것은 지금 무슨 화면을 만지고 있는지다.
 * One 은 그것을 결과 레일 안에 그린다. Work 는 떠 있는 카드로만 그렸다 — 사용자가 띄워
 * 달라고만 했는데 매번 떠다닌다고 보고한 자리다(2026-09-03 실측). 화면 부품은
 * AgentScreenView 한 벌을 떠 있는 카드와 함께 쓴다.
 */

import { useAgentScreen, AgentScreenCanvas, AgentScreenFooter, type AgentScreenMode } from "./AgentScreenView";

export function RailAgentScreen({
  mode,
  active,
  onModeChange,
  ko,
}: {
  mode: AgentScreenMode;
  /** 이 화면이 실제로 보이는 동안에만 캡처한다. */
  active: boolean;
  onModeChange: (mode: AgentScreenMode) => void;
  ko: boolean;
}) {
  const screen = useAgentScreen(mode, active, ko);
  return (
    <section className="rail-agent-screen" data-rail-agent-screen="true" aria-label={ko ? "에이전트가 보는 화면" : "Screen visible to the agent"}>
      <header>
        <div className="title">
          <span className={`cua-live-dot ${screen.ready ? "ready" : ""}`} aria-hidden="true" />
          <span title={screen.label}>{screen.label}</span>
          {active && <small>{ko ? "에이전트 조작 중" : "Agent working"}</small>}
        </div>
        <div className="modes">
          <button type="button" className={mode === "browser" ? "selected" : ""} onClick={() => onModeChange("browser")}>
            {ko ? "브라우저" : "Browser"}
          </button>
          <button type="button" className={mode === "computer" ? "selected" : ""} onClick={() => onModeChange("computer")}>
            {ko ? "컴퓨터" : "Computer"}
          </button>
        </div>
      </header>
      <AgentScreenCanvas screen={screen} ko={ko} />
      {screen.focusNotice && <div className="notice" role="status">{screen.focusNotice}</div>}
      <AgentScreenFooter screen={screen} ko={ko} />
      <style jsx>{`
        .rail-agent-screen { display: flex; flex-direction: column; min-height: 0; height: 100%; }
        header { flex-shrink: 0; height: 40px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 8px 0 12px; border-bottom: 1px solid color-mix(in srgb, var(--line) 75%, transparent); }
        .title { min-width: 0; display: flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 700; }
        .title > span:nth-child(2) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .title small { color: var(--accent); font-size: 9.5px; white-space: nowrap; }
        .modes { flex-shrink: 0; display: flex; align-items: center; gap: 2px; }
        .modes button { height: 26px; border: 0; border-radius: 7px; padding: 0 8px; background: transparent; color: var(--ink); font-size: 10.5px; font-weight: 650; cursor: pointer; }
        .modes button.selected { background: var(--black); color: var(--white); }
        .notice { flex-shrink: 0; min-height: 28px; display: flex; align-items: center; padding: 5px 10px; border-top: 1px solid color-mix(in srgb, var(--line) 75%, transparent); color: var(--muted-deep); font-size: 10px; line-height: 1.35; }
      `}</style>
      {/* 캔버스·빈 화면·푸터는 떠 있는 카드와 같은 마크업이라 같은 규칙으로 그린다. */}
      <style jsx global>{`
        .rail-agent-screen .cua-canvas { flex: 1; min-height: 0; width: 100%; display: grid; place-items: center; overflow: hidden; border: 0; padding: 0; background: var(--black); cursor: pointer; }
        .rail-agent-screen .cua-canvas:disabled { cursor: wait; opacity: 0.82; }
        .rail-agent-screen .cua-canvas img { display: block; width: 100%; height: 100%; object-fit: contain; }
        .rail-agent-screen .cua-canvas:hover img { filter: brightness(1.035); }
        .rail-agent-screen .cua-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); flex-shrink: 0; }
        .rail-agent-screen .cua-live-dot.ready { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 13%, transparent); }
        .rail-agent-screen .cua-empty { display: flex; flex-direction: column; align-items: center; gap: 5px; color: var(--white-soft); text-align: center; padding: 12px; }
        .rail-agent-screen .cua-empty strong { font-size: 12px; }
        .rail-agent-screen .cua-empty > span:last-child { max-width: 280px; font-size: 10.5px; line-height: 1.45; opacity: 0.5; }
        .rail-agent-screen .cua-empty-screen { width: 28px; height: 19px; border: 1.5px solid var(--white-faint); border-radius: 4px; position: relative; margin-bottom: 3px; }
        .rail-agent-screen .cua-empty-screen::after { content: ""; position: absolute; left: 9px; right: 9px; bottom: -5px; height: 1.5px; background: var(--white-faint); }
        .rail-agent-screen footer { flex-shrink: 0; min-height: 31px; display: flex; align-items: center; gap: 7px; padding: 5px 10px; font-size: 9.5px; color: var(--muted-deep); border-top: 1px solid color-mix(in srgb, var(--line) 75%, transparent); }
        .rail-agent-screen footer select { max-width: 120px; border: 0; background: transparent; color: var(--ink); font-size: 9.5px; }
        .rail-agent-screen footer .ok { color: var(--green-deep); font-weight: 700; }
        .rail-agent-screen footer .warn { color: var(--warn); font-weight: 700; }
        .rail-agent-screen footer .native { margin-left: auto; }
      `}</style>
    </section>
  );
}
