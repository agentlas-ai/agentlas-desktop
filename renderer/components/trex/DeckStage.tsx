// T-rex 슬라이드 렌더 레이어 — 위치기반 블록 JSON을 container-query(cqw) 무대에 그린다.
// 편집기(trex/page)와 QA 갤러리가 동일 컴포넌트를 공유한다. 순수 프레젠테이션(스토어 의존 없음).
"use client";
import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { SceneKind, TrexBlock, TrexSlide } from "@/lib/trex/model";

type SlideBg = TrexSlide["bg"];

export function cqw(n: number): string { return `${n}cqw`; }
export function bgStyle(bg: SlideBg | undefined, accent: string): CSSProperties {
  if (!bg) return { background: "#111" };
  if (bg.kind === "solid") return { background: bg.color };
  if (bg.kind === "gradient") return { background: `linear-gradient(${bg.angle ?? 160}deg, ${bg.from}, ${bg.to})` };
  return { background: "#111", backgroundImage: `url(${bg.src})`, backgroundSize: "cover", backgroundPosition: "center" };
}
export function withAlpha(hex: string, a: number): string {
  const m = hex.replace("#", "");
  if (m.length !== 6) return hex;
  return `rgba(${parseInt(m.slice(0, 2), 16)}, ${parseInt(m.slice(2, 4), 16)}, ${parseInt(m.slice(4, 6), 16)}, ${a})`;
}

const stageBase: CSSProperties = { position: "relative", width: "100%", aspectRatio: "16 / 9", borderRadius: 14, overflow: "hidden", boxShadow: "0 14px 44px rgba(0,0,0,.18)", fontFamily: "var(--font-body, 'Pretendard', sans-serif)" };
const pendingOverlay: CSSProperties = { position: "absolute", inset: 0, zIndex: 8, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1.4cqw", background: "rgba(10,10,14,.5)", color: "#fff", backdropFilter: "blur(2px)" };

/* ─────────────── 슬라이드 무대 ─────────────── */
export function DeckStage({
  slide, accent, editable, ratio, selectedId, editingId, pending, pendingLabel, onSelect, onStartEdit, onDrag, onText,
}: {
  slide: TrexSlide; accent: string; editable: boolean; ratio?: string;
  selectedId?: string | null; editingId?: string | null; pending?: boolean; pendingLabel?: string;
  onSelect?: (id: string) => void; onStartEdit?: (id: string) => void;
  onDrag?: (id: string, dx: number, dy: number, mode: "move" | "resize") => void;
  onText?: (id: string, field: "text" | "value" | "label", v: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  const startDrag = (e: ReactPointerEvent, b: TrexBlock, mode: "move" | "resize") => {
    if (!editable || !onDrag || !ref.current || editingId === b.id) return;
    e.stopPropagation();
    e.preventDefault();
    onSelect?.(b.id);
    const rect = ref.current.getBoundingClientRect();
    let lastX = e.clientX;
    let lastY = e.clientY;
    const move = (ev: globalThis.PointerEvent) => {
      const dx = ((ev.clientX - lastX) / rect.width) * 100;
      const dy = ((ev.clientY - lastY) / rect.height) * 100;
      lastX = ev.clientX;
      lastY = ev.clientY;
      onDrag(b.id, dx, dy, mode);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={ref} className="trex-stage" style={{ ...stageBase, ...bgStyle(slide.bg, accent), color: slide.ink, aspectRatio: ratio ?? "16 / 9" }} onPointerDown={() => editable && onSelect?.("")}>
      <Scene kind={slide.scene} accent={accent} />
      {pending && (
        <div style={pendingOverlay}>
          <span className="trex-spin" style={{ width: "3cqw", height: "3cqw", borderRadius: "50%", border: "0.35cqw solid rgba(255,255,255,.25)", borderTopColor: accent, display: "inline-block" }} />
          <span style={{ fontSize: "1.5cqw", fontWeight: 700, letterSpacing: ".02em" }}>{pendingLabel}</span>
        </div>
      )}
      {slide.blocks.map((b) => (
        <BlockView
          key={b.id}
          b={b}
          accent={accent}
          ink={slide.ink}
          editable={editable}
          selected={selectedId === b.id}
          editing={editingId === b.id}
          onPointerDown={(e) => startDrag(e, b, "move")}
          onDoubleClick={() => editable && onStartEdit?.(b.id)}
          onResize={(e) => startDrag(e, b, "resize")}
          onText={onText}
        />
      ))}
    </div>
  );
}

function Scene({ kind, accent }: { kind: SceneKind; accent: string }) {
  if (kind === "none") return null;
  const common: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" };
  if (kind === "dusk") {
    return (
      <svg style={common} viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <defs>
          <radialGradient id="tg-sun" cx="74%" cy="72%" r="42%"><stop offset="0" stopColor="#ffe6bd" stopOpacity=".9" /><stop offset=".6" stopColor={accent} stopOpacity="0" /></radialGradient>
        </defs>
        <rect width="1280" height="720" fill="url(#tg-sun)" />
        <circle cx="930" cy="500" r="60" fill="#ffe7be" opacity=".85" />
        <path d="M0,470 L180,415 L360,452 L560,400 L760,450 L980,408 L1280,452 L1280,720 L0,720 Z" fill="#000" opacity=".22" />
        <path d="M0,540 L260,500 L520,540 L820,498 L1280,540 L1280,720 L0,720 Z" fill="#000" opacity=".4" />
      </svg>
    );
  }
  if (kind === "impact") {
    return (
      <svg style={common} viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <defs>
          <linearGradient id="tg-tail" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffd9a0" stopOpacity="0" /><stop offset=".7" stopColor="#ffae5c" stopOpacity=".8" /><stop offset="1" stopColor="#ffe9c4" /></linearGradient>
          <radialGradient id="tg-glow" cx="62%" cy="92%" r="55%"><stop offset="0" stopColor="#e86a2a" stopOpacity=".6" /><stop offset=".6" stopColor="#b8381a" stopOpacity="0" /></radialGradient>
        </defs>
        <rect width="1280" height="720" fill="url(#tg-glow)" />
        <path d="M1190,60 Q900,170 580,380 L566,364 Q880,168 1176,50 Z" fill="url(#tg-tail)" opacity=".85" />
        <circle cx="576" cy="376" r="16" fill="#ffe9c4" />
        <path d="M0,560 L320,532 L600,560 L900,524 L1280,560 L1280,720 L0,720 Z" fill="#000" opacity=".45" />
      </svg>
    );
  }
  // field / pitch
  return (
    <svg style={common} viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs><radialGradient id="tg-pitch" cx="50%" cy="100%" r="70%"><stop offset="0" stopColor={accent} stopOpacity=".22" /><stop offset=".6" stopColor={accent} stopOpacity="0" /></radialGradient></defs>
      <rect width="1280" height="720" fill="url(#tg-pitch)" />
      <ellipse cx="640" cy="760" rx="520" ry="120" fill="none" stroke={accent} strokeOpacity=".25" strokeWidth="3" />
      <line x1="0" y1="600" x2="1280" y2="600" stroke={accent} strokeOpacity=".15" strokeWidth="2" />
    </svg>
  );
}

function BlockView({
  b, accent, ink, editable, selected, editing, onPointerDown, onDoubleClick, onResize, onText,
}: {
  b: TrexBlock; accent: string; ink: string; editable: boolean; selected: boolean; editing: boolean;
  onPointerDown: (e: ReactPointerEvent) => void; onDoubleClick: () => void; onResize: (e: ReactPointerEvent) => void;
  onText?: (id: string, field: "text" | "value" | "label", v: string) => void;
}) {
  const pos: CSSProperties = {
    position: "absolute", left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`,
    ...(b.h ? { height: `${b.h}%` } : null),
    cursor: editable ? (editing ? "text" : "move") : "default",
    outline: selected ? `2px solid ${accent}` : "none", outlineOffset: 3, borderRadius: 4, zIndex: selected ? 5 : 2,
  };
  const muted = withAlpha(ink, 0.72); // AA 대비 마진 확보(작은 muted 텍스트: footer/label/subtitle)
  const ed = (field: "text" | "value" | "label") =>
    editable && editing
      ? { contentEditable: true, suppressContentEditableWarning: true, onBlur: (e: React.FocusEvent<HTMLElement>) => onText?.(b.id, field, e.currentTarget.textContent ?? ""), style: { outline: "none", cursor: "text" } as CSSProperties }
      : {};

  let inner: React.ReactNode = null;
  if (b.kind === "kicker") inner = <div {...ed("text")} style={{ fontSize: cqw(b.size ?? 1.4), letterSpacing: ".28em", fontWeight: 800, textTransform: "uppercase", color: b.accent ? accent : muted }}>{b.text}</div>;
  else if (b.kind === "title") inner = <div {...ed("text")} style={{ fontSize: cqw(b.size ?? 3.4), fontWeight: b.weight ?? 800, lineHeight: 1.12, letterSpacing: "-.02em", color: b.accent ? accent : ink, wordBreak: "keep-all", textAlign: b.align ?? "left" }}>{b.text}</div>;
  else if (b.kind === "subtitle" || b.kind === "body")
    inner = (
      <div style={{ wordBreak: "keep-all", textAlign: b.align ?? "left" }}>
        {b.label && <div style={{ fontSize: cqw(1.5), fontWeight: 800, color: accent, marginBottom: cqw(0.5) }}>{b.label}</div>}
        <div {...ed("text")} style={{ fontSize: cqw(b.size ?? 1.5), lineHeight: 1.5, color: b.kind === "subtitle" ? muted : withAlpha(ink, 0.86), fontWeight: 500 }}>{b.text}</div>
      </div>
    );
  else if (b.kind === "card")
    inner = (
      <div style={{ height: b.h ? "100%" : undefined, boxSizing: "border-box", background: withAlpha(ink, 0.04), border: `1px solid ${withAlpha(ink, 0.11)}`, borderRadius: cqw(1.3), padding: `${cqw(1.9)} ${cqw(1.7)}`, display: "flex", flexDirection: "column", gap: cqw(1), wordBreak: "keep-all", overflow: "hidden" }}>
        {b.value ? (
          <div style={{ display: "flex", alignItems: "center", gap: cqw(1), marginBottom: cqw(0.2) }}>
            <span style={{ fontSize: cqw(2), fontWeight: 800, color: accent, letterSpacing: "-.02em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{b.value}</span>
            <span style={{ flex: 1, height: cqw(0.22), background: withAlpha(accent, 0.35), borderRadius: 2 }} />
          </div>
        ) : (
          <span style={{ width: cqw(3.4), height: cqw(0.44), background: accent, borderRadius: 999, marginBottom: cqw(0.4) }} />
        )}
        {b.label && <div {...ed("label")} style={{ fontSize: cqw((b.size ?? 1.45) + 0.35), fontWeight: 800, color: ink, lineHeight: 1.22, letterSpacing: "-.01em" }}>{b.label}</div>}
        <div {...ed("text")} style={{ fontSize: cqw(b.size ?? 1.45), lineHeight: 1.5, color: withAlpha(ink, 0.72), fontWeight: 500 }}>{b.text}</div>
      </div>
    );
  else if (b.kind === "rule") inner = <div style={{ height: cqw(0.32), width: "100%", background: b.accent ? accent : muted, borderRadius: 2 }} />;
  else if (b.kind === "pill") inner = <span {...ed("text")} style={{ display: "inline-block", fontSize: cqw(b.size ?? 1.2), fontWeight: 800, letterSpacing: ".06em", color: accent, background: withAlpha(accent, 0.14), padding: `${cqw(0.5)} ${cqw(1.1)}`, borderRadius: 999 }}>{b.text}</span>;
  else if (b.kind === "kpi")
    inner = (
      <div>
        <div {...ed("value")} style={{ fontSize: cqw(b.size ?? 6), fontWeight: 800, letterSpacing: "-.03em", lineHeight: 0.9, color: b.accent ? accent : ink }}>{b.value}</div>
        <div style={{ height: cqw(0.26), width: cqw(3), background: accent, margin: `${cqw(1.1)} 0 ${cqw(0.9)}` }} />
        <div {...ed("label")} style={{ fontSize: cqw(1.25), color: muted, fontWeight: 600, lineHeight: 1.4 }}>{b.label}</div>
      </div>
    );
  else if (b.kind === "bar") {
    const v = Math.max(0, Math.min(100, Number(b.value) || 0));
    inner = (
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: cqw(1.2) }}>
        <span {...ed("label")} style={{ fontSize: cqw(b.size ?? 1.3), fontWeight: 700, color: ink, minWidth: cqw(8) }}>{b.label}</span>
        <span style={{ height: cqw(1.9), background: withAlpha(ink, 0.1), borderRadius: 999, overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${v}%`, background: accent, borderRadius: 999 }} /></span>
        <span style={{ fontSize: cqw(1.35), fontWeight: 800, color: accent }}>{v}%</span>
      </div>
    );
  } else if (b.kind === "footer")
    inner = (
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: `1px solid ${withAlpha(ink, 0.14)}`, paddingTop: cqw(1.2), fontSize: cqw(b.size ?? 1.05), color: muted }}>
        <span {...ed("text")}>{b.text}</span><span style={{ fontWeight: 700, opacity: 0.7 }}>{b.value}</span>
      </div>
    );

  return (
    <div style={pos} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
      {inner}
      {editable && selected && !editing && b.kind !== "rule" && (
        <span onPointerDown={onResize} style={{ position: "absolute", right: -7, bottom: -7, width: 13, height: 13, borderRadius: 3, background: accent, border: "2px solid #fff", cursor: "nwse-resize", zIndex: 6 }} />
      )}
    </div>
  );
}

export function GlobalStyle() {
  return (
    <style dangerouslySetInnerHTML={{ __html: `
      .trex-stage { container-type: inline-size; }
      .trex-recent { transition: transform .14s, box-shadow .14s; }
      .trex-recent:hover { transform: translateY(-2px); box-shadow: var(--rd-shadow-2, 0 10px 30px rgba(0,0,0,.12)); }
      .trex-spin { animation: trexspin .8s linear infinite; }
      @keyframes trexspin { to { transform: rotate(360deg); } }
      @media print {
        body.trex-printing * { visibility: hidden; }
        body.trex-printing .trex-print-slide, body.trex-printing .trex-print-slide * { visibility: visible; }
        body.trex-printing .trex-print-slide { position: relative; page-break-after: always; }
        @page { size: 1280px 720px; margin: 0; }
      }
    ` }} />
  );
}
