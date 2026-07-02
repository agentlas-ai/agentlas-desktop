// T-rex 슬라이드 렌더 레이어 — 위치기반 블록 JSON을 container-query(cqw) 무대에 그린다.
// 편집기(trex/page)와 QA 갤러리가 동일 컴포넌트를 공유한다. 순수 프레젠테이션(스토어 의존 없음).
"use client";
import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { SceneKind, TrexBlock, TrexSlide } from "@/lib/trex/model";
import type { StyleDna } from "@/lib/trex/styles";

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
  slide, accent, editable, ratio, dna, selectedId, editingId, pending, pendingLabel, onSelect, onStartEdit, onDrag, onText,
}: {
  slide: TrexSlide; accent: string; editable: boolean; ratio?: string;
  /** Style DNA(styles.ts) — 서체·모서리·장식을 유파 규칙으로 렌더. 없으면 레거시 룩. */
  dna?: StyleDna | null;
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
    <div
      ref={ref}
      className="trex-stage"
      style={{ ...stageBase, ...bgStyle(slide.bg, accent), color: slide.ink, aspectRatio: ratio ?? "16 / 9", ...(dna ? { fontFamily: dna.bodyFont } : null) }}
      onPointerDown={() => editable && onSelect?.("")}
    >
      <Scene kind={slide.scene} accent={accent} />
      {dna && slide.deco && slide.deco !== "none" && <Deco slide={slide} dna={dna} accent={accent} />}
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
          dna={dna}
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

/* ─────────────── Style DNA 장식 모티프 레이어 ───────────────
 * 블록 뒤(zIndex 1)에 그려지는 유파별 시각 서명 — 스위스 거대 번호, 바우하우스 기하,
 * 디도 헤어라인 프레임, 비녤리 밴드, 브루탈 보더, 하라의 점. 전부 비인터랙티브. */
function Deco({ slide, dna, accent }: { slide: TrexSlide; dna: StyleDna; accent: string }) {
  const v = slide.decoV ?? "body";
  const ink = slide.ink;
  const n = slide.decoN ?? "01";
  const a2 = dna.accent2 ?? accent;
  const L: CSSProperties = { position: "absolute", inset: 0, pointerEvents: "none", zIndex: 1, overflow: "hidden" };

  if (slide.deco === "swiss-index") {
    // 뮐러-브로크만 — 거대 인덱스 숫자 + 상단 헤어라인(그리드의 존재를 드러낸다).
    const big = v === "cover";
    return (
      <div style={L} aria-hidden>
        <div
          style={{
            position: "absolute", top: big ? "-9cqw" : "-4.5cqw", right: "1.5cqw",
            fontFamily: dna.displayFont, fontWeight: 800, letterSpacing: "-.05em",
            fontSize: big ? "34cqw" : "20cqw", lineHeight: 1, color: withAlpha(ink, big ? 0.14 : 0.07),
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {n}
        </div>
        {v !== "cover" && <div style={{ position: "absolute", top: "8.5%", left: "6%", right: "6%", height: 1, background: withAlpha(ink, 0.2) }} />}
      </div>
    );
  }

  if (slide.deco === "bauhaus-geo") {
    // 바우하우스 — 원·삼각·바의 원색 기하. 커버는 대담하게, 본문은 여백의 소품으로.
    if (v === "cover" || v === "close") {
      return (
        <div style={L} aria-hidden>
          <div style={{ position: "absolute", top: "-14cqw", right: "-10cqw", width: "34cqw", height: "34cqw", borderRadius: "50%", background: a2, opacity: 0.92 }} />
          <div style={{ position: "absolute", top: "6cqw", right: "16cqw", width: "9cqw", height: "9cqw", borderRadius: "50%", background: accent, opacity: 0.9 }} />
          <div style={{ position: "absolute", bottom: 0, left: "-4cqw", width: "18cqw", height: "14cqw", clipPath: "polygon(0 100%, 50% 0, 100% 100%)", background: withAlpha(ink, 0.85), opacity: 0.18 }} />
          <div style={{ position: "absolute", bottom: "12%", left: 0, width: "38%", height: "0.5cqw", background: accent, opacity: 0.85 }} />
        </div>
      );
    }
    return (
      <div style={L} aria-hidden>
        <div style={{ position: "absolute", top: "5.5%", right: "5%", width: "4.6cqw", height: "4.6cqw", borderRadius: "50%", border: `0.34cqw solid ${a2}`, opacity: 0.9 }} />
        <div style={{ position: "absolute", top: "7.2%", right: "9.2%", width: "2.2cqw", height: "2.2cqw", borderRadius: "50%", background: accent, opacity: 0.85 }} />
      </div>
    );
  }

  if (slide.deco === "didot-frame") {
    // 패션 매거진 — 이중 헤어라인 프레임과 다이아 오너먼트. 지면 자체가 오브제가 된다.
    const strong = v !== "body";
    return (
      <div style={L} aria-hidden>
        <div style={{ position: "absolute", inset: "2.4%", border: `1px solid ${withAlpha(ink, strong ? 0.55 : 0.28)}` }} />
        {strong && <div style={{ position: "absolute", inset: "3.4%", border: `1px solid ${withAlpha(ink, 0.25)}` }} />}
        {strong && (
          <div style={{ position: "absolute", top: "2.4%", left: "50%", transform: "translate(-50%, -50%)", padding: "0 1.2cqw", background: bgFlat(slide.bg), color: accent, fontSize: "1.5cqw", lineHeight: 1 }}>◆</div>
        )}
      </div>
    );
  }

  if (slide.deco === "vignelli-band") {
    // 비녤리/유니그리드 — 상단의 두꺼운 잉크 밴드. 위계는 장식이 아니라 구조다.
    const coverBand = v === "cover";
    return (
      <div style={L} aria-hidden>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: coverBand ? "3.2cqw" : "1.4cqw", background: v === "close" ? withAlpha(ink, 0.92) : ink }} />
        {coverBand && <div style={{ position: "absolute", top: "3.2cqw", left: 0, right: 0, height: "0.55cqw", background: accent }} />}
        {!coverBand && v === "body" && <div style={{ position: "absolute", top: "1.4cqw", left: 0, width: "22%", height: "0.45cqw", background: accent }} />}
      </div>
    );
  }

  if (slide.deco === "brutal-frame") {
    // 브루탈리즘 — 원시 보더와 모노 인덱스 칩. 구조 그 자체를 노출한다.
    const bold = v !== "body";
    return (
      <div style={L} aria-hidden>
        <div style={{ position: "absolute", inset: "2.2%", border: `${bold ? 0.5 : 0.3}cqw solid ${withAlpha(ink, 0.9)}` }} />
        {/* 인덱스 칩 — 커버/클로징은 우하단(푸터 없음 근처 대담하게), 본문은 우상단(푸터 페이지번호와 충돌 방지). */}
        <div
          style={{
            position: "absolute", right: "2.2%", ...(bold ? { bottom: "2.2%" } : { top: "2.2%" }),
            padding: "0.5cqw 1.1cqw", background: bold ? accent : "transparent",
            border: `${bold ? 0 : 0.22}cqw solid ${withAlpha(ink, 0.9)}`,
            fontFamily: dna.monoFont ?? dna.bodyFont, fontWeight: 700, fontSize: bold ? "2.6cqw" : "1.4cqw",
            color: bold ? "#111" : withAlpha(ink, 0.8), lineHeight: 1.1,
          }}
        >
          {n}
        </div>
        {bold && <div style={{ position: "absolute", top: "2.2%", right: "2.2%", width: "4cqw", height: "4cqw", background: accent }} />}
      </div>
    );
  }

  if (slide.deco === "hara-void") {
    // 하라 켄야 — 점 하나. 여백이 일을 하게 둔다.
    return (
      <div style={L} aria-hidden>
        <div style={{ position: "absolute", top: v === "cover" ? "26%" : "6.5%", left: v === "cover" ? "50%" : "auto", right: v === "cover" ? "auto" : "6%", transform: v === "cover" ? "translateX(-50%)" : "none", width: "1.2cqw", height: "1.2cqw", borderRadius: "50%", background: accent }} />
        {v === "cover" && <div style={{ position: "absolute", bottom: "16%", left: "50%", transform: "translateX(-50%)", width: "10cqw", height: 1, background: withAlpha(ink, 0.3) }} />}
      </div>
    );
  }
  return null;
}

/** 프레임 오너먼트 배경 매칭용 — 솔리드만 확실히, 그 외엔 투명 처리. */
function bgFlat(bg: SlideBg | undefined): string {
  return bg && bg.kind === "solid" ? bg.color : "transparent";
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
  b, accent, ink, dna, editable, selected, editing, onPointerDown, onDoubleClick, onResize, onText,
}: {
  b: TrexBlock; accent: string; ink: string; dna?: StyleDna | null; editable: boolean; selected: boolean; editing: boolean;
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

  // Style DNA 타이포그래피 — 유파 서체·자간·굵기·대문자화(없으면 레거시 값 유지).
  const displayFont = dna?.displayFont;
  const bodyFont = dna?.bodyFont;
  const monoFont = dna?.monoFont ?? dna?.bodyFont;

  let inner: React.ReactNode = null;
  if (b.kind === "kicker")
    inner = (
      <div {...ed("text")} style={{ fontSize: cqw(b.size ?? 1.4), letterSpacing: dna?.kickerTracking ?? ".28em", fontWeight: dna ? 700 : 800, textTransform: "uppercase", color: b.accent ? accent : muted, ...(bodyFont ? { fontFamily: bodyFont } : null), textAlign: b.align ?? "left" }}>
        {b.text}
      </div>
    );
  else if (b.kind === "title")
    inner = (
      <div
        {...ed("text")}
        style={{
          fontSize: cqw(b.size ?? 3.4),
          fontWeight: dna ? dna.titleWeight : b.weight ?? 800,
          lineHeight: dna?.titleLineHeight ?? 1.12,
          letterSpacing: dna?.titleTracking ?? "-.02em",
          ...(dna?.titleTransform === "uppercase" ? { textTransform: "uppercase" as const } : null),
          ...(displayFont ? { fontFamily: displayFont } : null),
          color: b.accent ? accent : ink,
          wordBreak: "keep-all",
          textWrap: "balance" as never, // 2줄일 때 대칭/역삼각 — 과부(orphan) 방지
          textAlign: b.align ?? "left",
        }}
      >
        {b.text}
      </div>
    );
  else if (b.kind === "subtitle" || b.kind === "body")
    inner = b.inline ? (
      <div style={{ display: "flex", alignItems: "baseline", gap: cqw(1.8), wordBreak: "keep-all" }}>
        {b.label && <span style={{ fontSize: cqw((b.size ?? 1.7) * 1.02), fontWeight: 800, color: accent, fontVariantNumeric: "tabular-nums", flexShrink: 0, letterSpacing: "-.01em" }}>{b.label}</span>}
        <span {...ed("text")} style={{ fontSize: cqw(b.size ?? 1.7), lineHeight: 1.28, color: withAlpha(ink, 0.92), fontWeight: 600, wordBreak: "keep-all", textWrap: "pretty" as never }}>{b.text}</span>
      </div>
    ) : (
      <div style={{ wordBreak: "keep-all", textAlign: b.align ?? "left" }}>
        {b.label && <div style={{ fontSize: cqw(1.5), fontWeight: 800, color: accent, marginBottom: cqw(0.5) }}>{b.label}</div>}
        <div {...ed("text")} style={{ fontSize: cqw(b.size ?? 1.5), lineHeight: 1.5, color: b.kind === "subtitle" ? muted : withAlpha(ink, 0.86), fontWeight: 500, textWrap: "pretty" as never }}>{b.text}</div>
      </div>
    );
  else if (b.kind === "card")
    // 카드 공식: "테두리 대신 면(fill) 또는 부드러운 그림자(shadow)" — border는 브루탈처럼
    // 보더가 조형 언어인 유파만. 패딩은 글자 크기의 1.5배 이상(숨 쉴 공간).
    inner = (
      <div
        style={{
          height: b.h ? "100%" : undefined,
          boxSizing: "border-box",
          ...(dna
            ? dna.cardStyle === "border"
              ? {
                  background: withAlpha(ink, 0.04),
                  border: `${0.14 * dna.borderScale}cqw solid ${withAlpha(ink, 0.85)}`,
                  ...(dna.hardShadow ? { boxShadow: `0.55cqw 0.55cqw 0 ${withAlpha(ink, 0.9)}` } : null),
                }
              : dna.cardStyle === "shadow"
                ? { background: withAlpha(ink, 0.035), boxShadow: `0 0.9cqw 2.8cqw ${withAlpha("#000000", 0.09)}` }
                : { background: withAlpha(ink, 0.055) }
            : { background: withAlpha(ink, 0.04), border: `1px solid ${withAlpha(ink, 0.11)}` }),
          borderRadius: dna ? cqw(dna.radius) : cqw(1.3),
          padding: `${cqw(2.2)} ${cqw(2.2)}`,
          display: "flex",
          flexDirection: "column",
          gap: cqw(1),
          wordBreak: "keep-all",
          overflow: "hidden",
          position: "relative", // 인포그래픽 패널 배경(생성 이미지) 아래 깔기용
        }}
      >
        {b.src ? (
          // 생성된 "디자인된 빈 패널"을 카드 배경으로 — 텍스트는 패딩 안전영역 위 HTML 오버레이(굽지 않기).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={b.src} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", zIndex: 0 }} />
        ) : null}
        <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", gap: cqw(1), height: "100%", minHeight: 0 }}>
        {b.value ? (
          <div style={{ display: "flex", alignItems: "center", gap: cqw(1), marginBottom: cqw(0.2) }}>
            <span style={{ fontSize: cqw(dna ? (b.size ?? 1.45) * 1.7 : 2), fontWeight: 800, color: accent, letterSpacing: "-.02em", lineHeight: 1, fontVariantNumeric: "tabular-nums", ...(displayFont ? { fontFamily: displayFont } : null) }}>{b.value}</span>
            <span style={{ flex: 1, height: cqw(0.22), background: withAlpha(accent, 0.35), borderRadius: 2 }} />
          </div>
        ) : (
          <span style={{ width: cqw(3.4), height: cqw(0.44), background: accent, borderRadius: 999, marginBottom: cqw(0.4) }} />
        )}
        {b.label && <div {...ed("label")} style={{ fontSize: cqw(dna ? (b.size ?? 1.45) * 1.44 : (b.size ?? 1.45) + 0.35), fontWeight: 800, color: ink, lineHeight: 1.22, letterSpacing: "-.01em", textWrap: "balance" as never }}>{b.label}</div>}
        <div {...ed("text")} style={{ fontSize: cqw(b.size ?? 1.45), lineHeight: 1.5, color: withAlpha(ink, 0.72), fontWeight: 500, textWrap: "pretty" as never }}>{b.text}</div>
        </div>
      </div>
    );
  else if (b.kind === "rule") inner = <div style={{ height: cqw(dna && dna.borderScale > 1 ? 0.32 * dna.borderScale : 0.32), width: "100%", background: b.accent ? accent : muted, borderRadius: dna && dna.radius === 0 ? 0 : 2 }} />;
  else if (b.kind === "pill")
    inner = (
      <span {...ed("text")} style={{ display: "inline-block", fontSize: cqw(b.size ?? 1.2), fontWeight: 800, letterSpacing: ".06em", color: accent, background: withAlpha(accent, 0.14), padding: `${cqw(0.5)} ${cqw(1.1)}`, borderRadius: dna && dna.radius === 0 ? 0 : 999, ...(monoFont ? { fontFamily: monoFont } : null) }}>
        {b.text}
      </span>
    );
  else if (b.kind === "kpi")
    inner = (
      <div>
        <div {...ed("value")} style={{ fontSize: cqw(b.size ?? 6), fontWeight: dna ? Math.max(dna.titleWeight, 600) : 800, letterSpacing: dna?.titleTracking ?? "-.03em", lineHeight: 0.9, color: b.accent ? accent : ink, ...(displayFont ? { fontFamily: displayFont } : null) }}>{b.value}</div>
        <div style={{ height: cqw(0.26), width: cqw(3), background: accent, margin: `${cqw(1.1)} 0 ${cqw(0.9)}` }} />
        <div {...ed("label")} style={{ fontSize: cqw(1.25), color: muted, fontWeight: 600, lineHeight: 1.4 }}>{b.label}</div>
      </div>
    );
  else if (b.kind === "bar") {
    const v = Math.max(0, Math.min(100, Number(b.value) || 0));
    const barR = dna && dna.radius === 0 ? 0 : 999;
    inner = (
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: cqw(1.2) }}>
        <span {...ed("label")} style={{ fontSize: cqw(b.size ?? 1.3), fontWeight: 700, color: ink, minWidth: cqw(8) }}>{b.label}</span>
        <span style={{ height: cqw(2.4), background: withAlpha(ink, 0.06), borderRadius: barR, overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${v}%`, background: accent, borderRadius: barR }} /></span>
        <span style={{ fontSize: cqw(1.35), fontWeight: 800, color: accent, ...(monoFont ? { fontFamily: monoFont } : null) }}>{v}%</span>
      </div>
    );
  } else if (b.kind === "image") {
    // 생성 이미지 패널 — src 없으면 생성중 플레이스홀더(맥박 점). SVG 장식이 아니라 실제 사진이 원칙.
    // 공식① 풀블리드: scrim(다크 오버레이 40~60%)으로 위에 얹는 밝은 타이포 가독성 확보.
    // 공식③ 소프트 엣지: fade 마스크로 한쪽을 배경에 녹인다(사각 프레임 탈출).
    const bleed = !!b.scrim; // 풀블리드는 테두리/라운드 없이 화면에 붙는다
    const fadeMask =
      b.fade === "bottom"
        ? "linear-gradient(to bottom, black 62%, transparent 100%)"
        : b.fade === "left"
          ? "linear-gradient(to left, black 62%, transparent 100%)"
          : b.fade === "right"
            ? "linear-gradient(to right, black 62%, transparent 100%)"
            : undefined;
    inner = (
      <div
        style={{
          width: "100%",
          height: "100%",
          position: "relative",
          overflow: "hidden",
          borderRadius: bleed ? 0 : dna ? cqw(dna.radius) : cqw(1.3),
          ...(bleed || fadeMask
            ? null
            : {
                border: dna && dna.borderScale > 1.5 ? `${0.14 * dna.borderScale}cqw solid ${withAlpha(ink, 0.85)}` : `1px solid ${withAlpha(ink, 0.1)}`,
                ...(dna?.hardShadow ? { boxShadow: `0.55cqw 0.55cqw 0 ${withAlpha(ink, 0.9)}` } : null),
              }),
          background: bleed ? "transparent" : withAlpha(ink, 0.05),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          ...(fadeMask ? { WebkitMaskImage: fadeMask, maskImage: fadeMask } : null),
        }}
      >
        {b.src ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={b.src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            {b.scrim && <span style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(8,6,5,.62), rgba(8,6,5,.34) 55%, rgba(8,6,5,.58))" }} />}
          </>
        ) : (
          <>
            {/* 셔머 스켈레톤(하네스 §9) — 생성 중임을 살아있는 그라데이션으로. */}
            <span className="trex-shimmer" style={{ position: "absolute", inset: 0, background: `linear-gradient(100deg, transparent 30%, ${withAlpha(ink, 0.07)} 50%, transparent 70%)`, backgroundSize: "220% 100%" }} />
            <span className="trex-pulse" style={{ width: cqw(1.6), height: cqw(1.6), borderRadius: "50%", background: accent, display: "inline-block", position: "relative" }} />
          </>
        )}
      </div>
    );
  } else if (b.kind === "footer")
    inner = (
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: `1px solid ${withAlpha(ink, 0.14)}`, paddingTop: cqw(1.2), fontSize: cqw(b.size ?? 1.05), color: muted, ...(monoFont ? { fontFamily: monoFont } : null) }}>
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
      .trex-pulse { animation: trexpulse 1.2s ease-in-out infinite; }
      @keyframes trexpulse { 0%,100% { opacity: .35; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.15); } }
      .trex-shimmer { animation: trexshimmer 1.6s ease-in-out infinite; }
      @keyframes trexshimmer { 0% { background-position: 120% 0; } 100% { background-position: -120% 0; } }
      @media print {
        body.trex-printing * { visibility: hidden; }
        body.trex-printing .trex-print-slide, body.trex-printing .trex-print-slide * { visibility: visible; }
        body.trex-printing .trex-print-slide { position: relative; page-break-after: always; }
        @page { size: 1280px 720px; margin: 0; }
      }
    ` }} />
  );
}
