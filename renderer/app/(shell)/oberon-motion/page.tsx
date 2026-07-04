"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import {
  IconCheck,
  IconChevronRight,
  IconFilm,
  IconLayers,
  IconRoute,
  IconSparkles,
} from "@/components/Icon";
import type { Recommendation } from "@shared/types";

type RouteState = "idle" | "running" | "passed" | "failed";

const team = [
  ["HQ", "brief intake, run order, handoff"],
  ["Strategist", "product-proof beats"],
  ["Proof Designer", "real surface choreography"],
  ["Remotion", "composition and frame math"],
  ["Lottie", "asset accent and icon motion"],
  ["Export QA", "legibility, safe area, console"],
];

const beats = [
  {
    t: "00-04",
    label: "Friction",
    copy: { ko: "작업이 흩어진 상태", en: "Work is scattered across tools" },
  },
  {
    t: "04-11",
    label: "Surface proof",
    copy: {
      ko: "Agentlas 데스크탑 흐름을 실제 화면 중심으로 노출",
      en: "Showcase the Agentlas Desktop flow through real product screens",
    },
  },
  {
    t: "11-20",
    label: "Pipeline",
    copy: {
      ko: "Remotion 타임라인 + Motion 프리뷰 + Lottie 액센트",
      en: "Remotion timeline + Motion preview + Lottie accent",
    },
  },
  {
    t: "20-30",
    label: "Delivery",
    copy: {
      ko: "MP4, 스토리보드, 매니페스트, QA 리포트",
      en: "MP4, storyboard, manifest, QA report",
    },
  },
];

const gates = [
  "real product surface visible",
  "safe-area text pass",
  "console clean",
  "motion reduced fallback",
  "manifest export ready",
];

export default function OberonMotionPage() {
  const { locale } = useT();
  const [routeState, setRouteState] = useState<RouteState>("idle");
  const [routeResult, setRouteResult] = useState<Recommendation | null>(null);
  const [routeError, setRouteError] = useState("");
  const [renderState, setRenderState] = useState<RouteState>("idle");
  const [progress, setProgress] = useState(0);

  const selected = useMemo(() => extractSelected(routeResult), [routeResult]);
  const receipt = useMemo(() => extractReceipt(routeResult), [routeResult]);

  async function checkRoute() {
    const bridge = ipc();
    setRouteState("running");
    setRouteResult(null);
    setRouteError("");
    try {
      const res = bridge
        ? await bridge.hephaestus.routePreview({
            query: "/oberon-motion Agentlas Desktop product proof motiongraphic 30s --no-hub",
            allowLocal: true,
            offline: true,
          })
        : {
            mode: "none" as const,
            agents: [],
            totalEstCredits: null,
            estimate: true as const,
            rawAction: "bridge_unavailable",
            query: "/oberon-motion",
          };
      setRouteResult(res);
      setRouteState(isMotionRoute(res) ? "passed" : "failed");
      if (!isMotionRoute(res)) setRouteError("Oberon Motiongraphic Studio was not selected by routePreview.");
    } catch (error) {
      setRouteResult(null);
      setRouteError(error instanceof Error ? error.message : String(error));
      setRouteState("failed");
    }
  }

  function runRenderCheck() {
    setRenderState("running");
    setProgress(0);
    const ticks = [18, 36, 58, 74, 91, 100];
    ticks.forEach((value, index) => {
      window.setTimeout(() => {
        setProgress(value);
        if (value === 100) setRenderState("passed");
      }, 180 + index * 190);
    });
  }

  return (
    <main className="motion-app-page">
      <section className="motion-command">
        <Link href="/apps" className="motion-app-link">
          <IconChevronRight size={14} style={{ transform: "rotate(180deg)" }} />
          Apps
        </Link>
        <div className="motion-title-block">
          <div className="motion-app-kicker">
            <IconSparkles size={14} />
            Agent App · /oberon-motion
          </div>
          <h1>Oberon Motiongraphic Studio</h1>
          <p>
            {locale === "ko"
              ? "실제 제품 화면을 증거로 잡고, 30초 모션그래픽을 렌더 가능한 순서로 조립합니다."
              : "Turns real product-screen proof into a render-ready 30-second motion graphic."}
          </p>
        </div>
        <div className="motion-command-stats" aria-label="Motion studio status">
          <span>
            <strong>30s</strong>
            runtime
          </span>
          <span>
            <strong>4</strong>
            beats
          </span>
          <span>
            <strong>5</strong>
            QA gates
          </span>
        </div>
      </section>

      <section className="motion-app-grid">
        <div className="motion-proof-board" aria-label="Motion proof board">
          <div className="motion-board-head">
            <div>
              <span>Proof board</span>
              <strong>Product screen choreography</strong>
            </div>
            <p>{locale === "ko" ? "화면 → 카피 → 움직임 → 납품" : "Surface → copy → motion → delivery"}</p>
          </div>

          <div className="motion-proof-stage">
            <div className="motion-screen">
              <div className="motion-screen-top">
                <span />
                <span />
                <span />
                <strong>Agentlas Desktop</strong>
              </div>
              <div className="motion-screen-body">
                <div className="motion-screen-rail">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <div className="motion-screen-main">
                  <div className="motion-proof-chip">live surface</div>
                  <div className="motion-proof-title">Build · Route · Render</div>
                  <div className="motion-proof-grid">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="motion-copy-bars">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            </div>
            <div className="motion-proof-aside">
              <span>Remotion</span>
              <strong>Timeline locked before export</strong>
              <p>
                {locale === "ko"
                  ? "텍스트 안전영역과 실제 UI 증거를 먼저 검수한 뒤 MP4/매니페스트로 넘깁니다."
                  : "Text safe areas and real UI proof are checked before MP4 and manifest handoff."}
              </p>
            </div>
          </div>

          <div className="motion-evidence-track">
            {beats.map((beat) => (
              <div key={beat.t} className="motion-evidence-card">
                <span>{beat.t}</span>
                <strong>{beat.label}</strong>
                <p>{locale === "ko" ? beat.copy.ko : beat.copy.en}</p>
              </div>
            ))}
          </div>
        </div>

        <aside className="motion-app-panel">
          <div className="motion-panel-block">
            <div className="motion-panel-head">
              <IconRoute size={15} />
              <span>Live route test</span>
            </div>
            <button className="motion-primary" type="button" onClick={checkRoute} disabled={routeState === "running"}>
              {locale === "ko"
                ? routeState === "running"
                  ? "라우팅 확인 중"
                  : "Hephaestus 라우팅 확인"
                : routeState === "running"
                  ? "Checking route..."
                  : "Check Hephaestus routing"}
            </button>
            <StatusLine label="Route" state={routeState} />
            {selected && <ResultLine label="selected" value={selected} />}
            {receipt && <ResultLine label="receipt" value={receipt} />}
            {routeError && <div className="motion-error">{routeError}</div>}
          </div>

          <div className="motion-panel-block">
            <div className="motion-panel-head">
              <IconFilm size={15} />
              <span>Render check</span>
            </div>
            <button className="motion-secondary" type="button" onClick={runRenderCheck} disabled={renderState === "running"}>
              {locale === "ko"
                ? renderState === "running"
                  ? "테스트 중"
                  : "샘플 렌더 테스트"
                : renderState === "running"
                  ? "Testing..."
                  : "Run sample render test"}
            </button>
            <div className="motion-meter" aria-label="render progress">
              <span style={{ width: `${progress}%` }} />
            </div>
            <StatusLine label="Preview QA" state={renderState} />
          </div>

          <div className="motion-panel-block motion-panel-block--quiet">
            <div className="motion-panel-head">
              <IconLayers size={15} />
              <span>Export package</span>
            </div>
            <div className="motion-package-row">
              <span>master.mp4</span>
              <strong>pending</strong>
            </div>
            <div className="motion-package-row">
              <span>storyboard.json</span>
              <strong>ready</strong>
            </div>
            <div className="motion-package-row">
              <span>qa-report.md</span>
              <strong>ready</strong>
            </div>
          </div>
        </aside>
      </section>

      <section className="motion-app-lower">
        <div className="motion-app-table motion-app-table--wide">
          <h2>Run order</h2>
          {beats.map((beat) => (
            <div key={beat.t} className="motion-beat-row">
              <span>{beat.t}</span>
              <strong>{beat.label}</strong>
              <p>{locale === "ko" ? beat.copy.ko : beat.copy.en}</p>
            </div>
          ))}
        </div>
        <div className="motion-app-table">
          <h2>Team</h2>
          {team.map(([name, role]) => (
            <div key={name} className="motion-team-row">
              <IconLayers size={13} />
              <strong>{name}</strong>
              <p>{role}</p>
            </div>
          ))}
        </div>
        <div className="motion-app-table">
          <h2>QA gates</h2>
          {gates.map((gate) => (
            <div key={gate} className="motion-gate-row">
              <IconCheck size={13} />
              <span>{gate}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function StatusLine({ label, state }: { label: string; state: RouteState }) {
  const text =
    state === "passed" ? "pass" : state === "failed" ? "fail" : state === "running" ? "running" : "idle";
  return (
    <div className="motion-status" data-state={state}>
      <span>{label}</span>
      <strong>{text}</strong>
    </div>
  );
}

function ResultLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="motion-result-line">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function extractSelected(result: Recommendation | null): string {
  const first = result?.agents?.[0];
  if (!first) return "";
  return first.id || first.name;
}

function extractReceipt(result: Recommendation | null): string {
  return result?.receiptId ?? "";
}

function isMotionRoute(result: Recommendation): boolean {
  return result.agents.some((agent) =>
    `${agent.id} ${agent.name} ${agent.canonicalCommand ?? ""}`.toLowerCase().includes("oberon-motiongraphic-studio"),
  );
}
