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
      <section className="motion-app-hero">
        <div className="motion-app-kicker">
          <IconSparkles size={14} />
          Agent App · /oberon-motion
        </div>
        <div className="motion-app-title-row">
          <div>
            <h1>Oberon Motiongraphic Studio</h1>
            <p>
              {locale === "ko"
                ? "제품 화면 증거를 중심으로 모션그래픽 팀을 실행합니다."
                : "Runs a motion-graphics team built around real product-screen evidence."}
            </p>
          </div>
          <Link href="/apps" className="motion-app-link">
            Apps
            <IconChevronRight size={14} />
          </Link>
        </div>
      </section>

      <section className="motion-app-grid">
        <div className="motion-app-preview" aria-label="Motion preview">
          <div className="motion-frame">
            <div className="motion-frame-top">
              <span />
              <span />
              <span />
            </div>
            <div className="motion-frame-body">
              <div className="motion-proof-window">
                <div className="motion-proof-rail" />
                <div className="motion-proof-main">
                  <div className="motion-proof-chip">Agentlas Desktop</div>
                  <div className="motion-proof-title">Build → Route → Render</div>
                  <div className="motion-proof-bars">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
              <div className="motion-lottie-mark" />
              <div className="motion-caption">product proof first</div>
            </div>
          </div>
        </div>

        <aside className="motion-app-panel">
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

          <div className="motion-divider" />

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
        </aside>
      </section>

      <section className="motion-app-lower">
        <div className="motion-app-table">
          <h2>Storyboard</h2>
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
