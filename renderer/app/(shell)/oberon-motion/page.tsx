"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import type { OberonMotionAdJob, OberonMotionAdRequest, Recommendation } from "@shared/types";

type RouteState = "idle" | "running" | "passed" | "failed";

const beats = [
  { t: "00-04", label: "Friction", copy: { ko: "작업이 흩어진 상태", en: "Work is scattered across tools" } },
  { t: "04-11", label: "Surface proof", copy: { ko: "실제 제품 화면 중심으로 노출", en: "Showcase through real product screens" } },
  { t: "11-20", label: "Pipeline", copy: { ko: "Remotion 타임라인 + 모션 프리뷰 + Lottie 액센트", en: "Remotion timeline + motion preview + Lottie accent" } },
  { t: "20-30", label: "Delivery", copy: { ko: "MP4 · HTML 프리뷰 · 프롬프트 팩", en: "MP4 · HTML preview · prompt pack" } },
];

const gates = [
  "real product surface visible",
  "safe-area text pass",
  "console clean",
  "motion reduced fallback",
  "manifest export ready",
];

const DURATIONS = [15, 30, 60] as const;

export default function OberonMotionPage() {
  const { locale } = useT();
  const ko = locale === "ko";

  // ── 스튜디오 입력 ──────────────────────────────
  const [title, setTitle] = useState("");
  const [brand, setBrand] = useState("");
  const [concept, setConcept] = useState("");
  const [aspect, setAspect] = useState<"16:9" | "9:16">("16:9");
  const [duration, setDuration] = useState<number>(30);
  const [accent, setAccent] = useState("#0e6a66");

  // ── 렌더 잡 ────────────────────────────────────
  const [job, setJob] = useState<OberonMotionAdJob | null>(null);
  const [generating, setGenerating] = useState(false);
  const [renderError, setRenderError] = useState("");
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (poll.current) clearInterval(poll.current);
    poll.current = null;
  }, []);

  useEffect(() => () => stopPoll(), [stopPoll]);

  const startPoll = useCallback(
    (jobId: string) => {
      stopPoll();
      poll.current = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        void (async () => {
          const bridge = ipc();
          const next = await bridge?.oberon.getMotionAdJob(jobId);
          if (!next) return;
          setJob(next);
          if (next.status === "succeeded" || next.status === "failed" || next.status === "cancelled") {
            stopPoll();
            setGenerating(false);
          }
        })().catch((error) => {
          stopPoll();
          setGenerating(false);
          setRenderError(error instanceof Error ? error.message : String(error));
        });
      }, 1000);
    },
    [stopPoll],
  );

  const render = useCallback(() => {
    const bridge = ipc();
    setRenderError("");
    if (!bridge?.oberon?.startMotionAd) {
      setRenderError(
        ko
          ? "데스크톱 앱 안에서만 모션그래픽을 렌더할 수 있어요. 웹이 아니라 Agentlas 데스크톱에서 열어주세요."
          : "Motion graphics can only render inside the desktop app. Open this in Agentlas Desktop, not the browser.",
      );
      return;
    }
    const request: OberonMotionAdRequest = {
      title: title.trim() || (ko ? "Agentlas 모션 광고" : "Agentlas Motion Ad"),
      brand: brand.trim() || undefined,
      concept: concept.trim() || undefined,
      aspectRatio: aspect,
      durationSec: duration,
      fps: 24,
      accentColor: /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : undefined,
    };
    setGenerating(true);
    setJob(null);
    void bridge.oberon
      .startMotionAd(request)
      .then((started) => {
        setJob(started);
        startPoll(started.id);
      })
      .catch((error) => {
        setGenerating(false);
        setRenderError(error instanceof Error ? error.message : String(error));
      });
  }, [aspect, accent, brand, concept, duration, ko, startPoll, title]);

  const cancel = useCallback(() => {
    const bridge = ipc();
    if (job && bridge?.oberon?.cancelMotionAd) void bridge.oberon.cancelMotionAd(job.id);
    stopPoll();
    setGenerating(false);
  }, [job, stopPoll]);

  const reset = useCallback(() => {
    stopPoll();
    setJob(null);
    setGenerating(false);
    setRenderError("");
  }, [stopPoll]);

  const files = job?.files ?? [];
  const mp4 = files.find((f) => f.kind === "motion_mp4");
  const preview = files.find((f) => f.kind === "html_preview");
  const promptPack = files.find((f) => f.kind === "prompt_pack");
  const percent = job?.progress.percent ?? 0;
  const statusTone =
    job?.status === "succeeded" ? "var(--ob-success, #0e8a5f)" : job?.status === "failed" || job?.status === "cancelled" ? "var(--ob-danger, #c0392b)" : "var(--ob-accent, #0e6a66)";

  return (
    <main className="motion-app-page">
      <section className="motion-app-hero">
        <div className="motion-app-kicker">
          <IconSparkles size={14} />
          Agent App · /oberon-motion
        </div>
        <div className="motion-app-title-row">
          <div>
            <h1>{ko ? "오베론 모션그래픽 스튜디오" : "Oberon Motiongraphic Studio"}</h1>
            <p>
              {ko
                ? "아이디어를 적고 렌더를 누르면, API 없이 로컬에서 모션그래픽 광고 MP4를 만들어 줍니다."
                : "Describe your idea and hit render — it builds a motion-graphics ad MP4 locally, no API keys."}
            </p>
          </div>
          <Link href="/apps" className="motion-app-link">
            Apps
            <IconChevronRight size={14} />
          </Link>
        </div>
      </section>

      <section className="motion-app-grid">
        {/* 좌: 미리보기 / 결과 */}
        <div className="motion-app-preview" aria-label={ko ? "모션 미리보기" : "Motion preview"}>
          {mp4 ? (
            <video
              controls
              autoPlay
              loop
              muted
              src={mp4.url}
              style={{ width: "100%", borderRadius: 14, background: "#111", aspectRatio: aspect === "9:16" ? "9 / 16" : "16 / 9", objectFit: "contain" }}
            />
          ) : (
            <div className="motion-frame" style={{ aspectRatio: aspect === "9:16" ? "9 / 16" : "16 / 9" }}>
              <div className="motion-frame-top">
                <span />
                <span />
                <span />
              </div>
              <div className="motion-frame-body">
                <div className="motion-proof-window">
                  <div className="motion-proof-rail" />
                  <div className="motion-proof-main">
                    <div className="motion-proof-chip">{brand.trim() || "Agentlas"}</div>
                    <div className="motion-proof-title">{title.trim() || (ko ? "여기에 모션 광고가 렌더됩니다" : "Your motion ad renders here")}</div>
                    <div className="motion-proof-bars">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                </div>
                <div className="motion-lottie-mark" style={{ background: accent }} />
                <div className="motion-caption">{generating ? (ko ? "렌더 중…" : "rendering…") : ko ? "미리보기" : "preview"}</div>
              </div>
            </div>
          )}
        </div>

        {/* 우: 스튜디오 폼 + 렌더 */}
        <aside className="motion-app-panel">
          <div className="motion-panel-head">
            <IconFilm size={15} />
            <span>{ko ? "모션그래픽 만들기" : "Make a motion graphic"}</span>
          </div>

          <label className=" obm-field">
            <span>{ko ? "제목" : "Title"}</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ko ? "예: Agentlas 데스크탑 30초 광고" : "e.g. Agentlas Desktop 30s ad"} className="obm-input" />
          </label>
          <label className=" obm-field">
            <span>{ko ? "브랜드 / 제품" : "Brand / product"}</span>
            <input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Agentlas" className="obm-input" />
          </label>
          <label className=" obm-field">
            <span>{ko ? "컨셉 / 핵심 메시지" : "Concept / key message"}</span>
            <textarea value={concept} onChange={(e) => setConcept(e.target.value)} rows={3} placeholder={ko ? "무엇을, 누구에게, 어떤 한 문장으로 각인시킬지" : "What, for whom, and the one line to land"} className="obm-input obm-textarea" />
          </label>

          <div className="obm-row">
            <label className=" obm-field" style={{ flex: 1 }}>
              <span>{ko ? "비율" : "Aspect"}</span>
              <div className="obm-toggle">
                {(["16:9", "9:16"] as const).map((a) => (
                  <button key={a} type="button" className={aspect === a ? "obm-chip obm-chip-on" : "obm-chip"} onClick={() => setAspect(a)}>
                    {a}
                  </button>
                ))}
              </div>
            </label>
            <label className=" obm-field" style={{ flex: 1 }}>
              <span>{ko ? "길이" : "Length"}</span>
              <div className="obm-toggle">
                {DURATIONS.map((d) => (
                  <button key={d} type="button" className={duration === d ? "obm-chip obm-chip-on" : "obm-chip"} onClick={() => setDuration(d)}>
                    {d}s
                  </button>
                ))}
              </div>
            </label>
            <label className=" obm-field" style={{ width: 66 }}>
              <span>{ko ? "강조색" : "Accent"}</span>
              <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} className="obm-color" aria-label={ko ? "강조색" : "Accent color"} />
            </label>
          </div>

          {!job || job.status === "failed" || job.status === "cancelled" ? (
            <button className="motion-primary" type="button" onClick={render} disabled={generating}>
              <IconSparkles size={14} />
              {generating ? (ko ? "렌더 중…" : "Rendering…") : ko ? "모션그래픽 렌더" : "Render motion graphic"}
            </button>
          ) : generating ? (
            <button className="motion-secondary" type="button" onClick={cancel}>
              {ko ? "취소" : "Cancel"}
            </button>
          ) : (
            <button className="motion-secondary" type="button" onClick={reset}>
              {ko ? "새로 만들기" : "Make another"}
            </button>
          )}

          {(job || generating) && (
            <>
              <div className="obm-status">
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusTone }} />
                <span>{job?.message ?? (ko ? "대기 중" : "Waiting")}</span>
                <strong style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>{percent}%</strong>
              </div>
              <div className="motion-meter" aria-label="render progress">
                <span style={{ width: `${percent}%`, background: statusTone }} />
              </div>
            </>
          )}

          {job?.error && <div className="motion-error">{job.error}</div>}
          {renderError && <div className="motion-error">{renderError}</div>}

          {files.length > 0 && (
            <div className="obm-files">
              {mp4 && <FileChip href={mp4.url} name={mp4.name} label="MP4" />}
              {preview && <FileChip href={preview.url} name={preview.name} label="HTML" />}
              {promptPack && <FileChip href={promptPack.url} name={promptPack.name} label="Prompt" />}
            </div>
          )}
          {job?.status === "succeeded" && (
            <button
              className="motion-ghost"
              type="button"
              onClick={() => {
                const bridge = ipc();
                if (bridge?.oberon?.openMotionAdOutput) void bridge.oberon.openMotionAdOutput(job.id);
              }}
            >
              {ko ? "출력 폴더 열기" : "Open output folder"}
            </button>
          )}
        </aside>
      </section>

      <section className="motion-app-lower">
        <div className="motion-app-table">
          <h2>{ko ? "스토리보드" : "Storyboard"}</h2>
          {beats.map((beat) => (
            <div key={beat.t} className="motion-beat-row">
              <span>{beat.t}</span>
              <strong>{beat.label}</strong>
              <p>{ko ? beat.copy.ko : beat.copy.en}</p>
            </div>
          ))}
        </div>
        <div className="motion-app-table">
          <h2>{ko ? "포함 산출물" : "You get"}</h2>
          {[
            ["MP4", ko ? "완성 모션그래픽 영상" : "Finished motion-graphic video"],
            ["HTML", ko ? "브라우저 프리뷰(수정 가능)" : "Editable browser preview"],
            ["Prompt", ko ? "재생성용 프롬프트 팩" : "Prompt pack to regenerate"],
          ].map(([name, role]) => (
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

      <RouteDiagnostic ko={ko} />

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .obm-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; }
        .obm-field > span { font-size: 11px; font-weight: 650; color: var(--ob-muted, #6b7280); }
        .obm-input {
          width: 100%; min-height: 36px; padding: 8px 11px; border-radius: 10px;
          border: 1px solid var(--ob-edge, #e5e7eb); background: var(--ob-paper, #fff);
          color: var(--ob-ink, #101820); font-size: 13px; font-family: inherit;
        }
        .obm-input:focus { outline: none; border-color: var(--ob-accent, #0e6a66); }
        .obm-textarea { resize: vertical; line-height: 1.5; }
        .obm-row { display: flex; gap: 10px; align-items: flex-start; }
        .obm-toggle { display: flex; gap: 6px; }
        .obm-chip {
          flex: 1; min-height: 34px; padding: 0 10px; border-radius: 9px; cursor: pointer;
          border: 1px solid var(--ob-edge, #e5e7eb); background: var(--ob-paper, #fff);
          color: var(--ob-ink, #101820); font-size: 12.5px; font-weight: 650; font-variant-numeric: tabular-nums;
        }
        .obm-chip-on { border-color: var(--ob-accent, #0e6a66); color: var(--ob-accent-text, #0e6a66); background: var(--ob-accent-soft, #e6f4f1); }
        .obm-color { width: 100%; height: 36px; padding: 2px; border-radius: 10px; border: 1px solid var(--ob-edge, #e5e7eb); background: var(--ob-paper, #fff); cursor: pointer; }
        .obm-status { display: flex; align-items: center; gap: 8px; margin-top: 14px; font-size: 13px; color: var(--ob-ink, #101820); }
        .obm-files { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
        .motion-ghost {
          margin-top: 12px; min-height: 34px; padding: 0 12px; border-radius: 10px; cursor: pointer;
          border: 1px solid var(--ob-edge, #e5e7eb); background: var(--ob-paper, #fff);
          color: var(--ob-ink, #101820); font-size: 12.5px; font-weight: 650;
        }
      `,
        }}
      />
    </main>
  );
}

function FileChip({ href, name, label }: { href: string; name: string; label: string }) {
  return (
    <a
      href={href}
      download={name}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minHeight: 34,
        padding: "0 12px",
        borderRadius: 999,
        border: "1px solid var(--ob-edge, #e5e7eb)",
        color: "var(--ob-ink, #101820)",
        background: "var(--ob-paper, #fff)",
        fontSize: 12,
        fontWeight: 700,
        textDecoration: "none",
      }}
    >
      {label}
    </a>
  );
}

/** 접힌 고급 진단 — Hephaestus 라우팅이 이 스튜디오로 잡히는지 확인(선택). */
function RouteDiagnostic({ ko }: { ko: boolean }) {
  const [open, setOpen] = useState(false);
  const [routeState, setRouteState] = useState<RouteState>("idle");
  const [routeError, setRouteError] = useState("");
  const [selected, setSelected] = useState("");

  async function checkRoute() {
    const bridge = ipc();
    setRouteState("running");
    setRouteError("");
    setSelected("");
    try {
      const res: Recommendation = bridge
        ? await bridge.hephaestus.routePreview({
            query: "/oberon-motion Agentlas Desktop product proof motiongraphic 30s --no-hub",
            allowLocal: true,
            offline: true,
          })
        : { mode: "none", agents: [], totalEstCredits: null, estimate: true, rawAction: "bridge_unavailable", query: "/oberon-motion" };
      const first = res.agents?.[0];
      setSelected(first ? first.id || first.name : "");
      const ok = res.agents.some((a) => `${a.id} ${a.name} ${a.canonicalCommand ?? ""}`.toLowerCase().includes("oberon-motiongraphic-studio"));
      setRouteState(ok ? "passed" : "failed");
      if (!ok) setRouteError("Oberon Motiongraphic Studio was not selected by routePreview.");
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : String(error));
      setRouteState("failed");
    }
  }

  return (
    <section style={{ padding: "0 4px 40px", maxWidth: 520 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", color: "var(--ob-muted, #6b7280)", fontSize: 12, fontWeight: 650, padding: "6px 0" }}
      >
        <IconRoute size={13} />
        {ko ? "고급: 라우팅 진단" : "Advanced: routing diagnostic"}
        <IconChevronRight size={12} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <button className="motion-secondary" type="button" onClick={checkRoute} disabled={routeState === "running"}>
            {routeState === "running" ? (ko ? "확인 중…" : "Checking…") : ko ? "Hephaestus 라우팅 확인" : "Check Hephaestus routing"}
          </button>
          <div className="motion-status" data-state={routeState} style={{ marginTop: 8 }}>
            <span>Route</span>
            <strong>{routeState === "passed" ? "pass" : routeState === "failed" ? "fail" : routeState === "running" ? "running" : "idle"}</strong>
          </div>
          {selected && (
            <div className="motion-result-line">
              <span>selected</span>
              <code>{selected}</code>
            </div>
          )}
          {routeError && <div className="motion-error">{routeError}</div>}
        </div>
      )}
    </section>
  );
}
