// Oberon — 저장된 프로젝트 불러오기 팝업. 있으면 가져오기, 없으면 새로 만들기 안내.
"use client";
import { useEffect, useState } from "react";
import {
  deleteProduction,
  listProductions,
  loadProduction,
  type FilmProduction,
  type ProductionMeta,
} from "@/lib/oberon";
import { Glyph, OberonBadge } from "./icons";
import { GhostButton } from "./ui";

const FORMAT_KO: Record<string, string> = {
  commercial_30: "30초 광고", commercial_60: "60초 광고", trailer: "트레일러",
  short_drama: "단편 드라마", music_video: "뮤직비디오", cinematic_short: "시네마틱 단편", social_short: "소셜 숏폼",
};

export function LoadProjectModal({
  open,
  onClose,
  onLoad,
}: {
  open: boolean;
  onClose: () => void;
  onLoad: (prod: FilmProduction) => void;
}) {
  const [list, setList] = useState<ProductionMeta[]>([]);

  useEffect(() => {
    if (open) setList(listProductions());
  }, [open]);

  if (!open) return null;

  function handleLoad(id: string) {
    const prod = loadProduction(id);
    if (prod) onLoad(prod);
  }
  function handleDelete(id: string) {
    deleteProduction(id);
    setList(listProductions());
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(11,11,15,0.32)", backdropFilter: "blur(2px)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 540, maxHeight: "80vh", display: "flex", flexDirection: "column",
          background: "var(--ob-paper)", borderRadius: 16, border: "1px solid var(--ob-edge)",
          boxShadow: "0 24px 64px rgba(11,11,15,0.18)", overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 20px", borderBottom: "1px solid var(--ob-edge)" }}>
          <OberonBadge name="layers" tone="accent" size={26} glyphSize={14} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ob-ink)", fontFamily: "var(--font-display)" }}>저장된 프로젝트</div>
            <div style={{ fontSize: 12, color: "var(--ob-muted)" }}>이전에 만든 작업을 이어서 합니다</div>
          </div>
          <button onClick={onClose} aria-label="닫기" style={{ border: "none", background: "var(--ob-fill)", borderRadius: 999, width: 30, height: 30, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--ob-ink-soft)" }}>
            <Glyph name="x" size={14} strokeWidth={2.2} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: list.length ? 14 : 0 }}>
          {list.length === 0 ? (
            <div style={{ textAlign: "center", padding: "48px 24px", color: "var(--ob-muted)" }}>
              <OberonBadge name="film" size={40} />
              <p style={{ fontSize: 14, color: "var(--ob-ink-soft)", margin: "16px 0 4px", fontWeight: 600 }}>저장된 프로젝트가 없어요</p>
              <p style={{ fontSize: 13, margin: 0 }}>창을 닫고 제목·프롬프트를 적어 새로 만들어 보세요.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {list.map((m) => (
                <div
                  key={m.id}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 12, border: "1px solid var(--ob-edge)", background: "var(--ob-surface)" }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ob-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.title || "Untitled"}</div>
                    <div style={{ fontSize: 12, color: "var(--ob-muted)", marginTop: 2 }}>
                      {FORMAT_KO[m.format] ?? m.format} · {m.shotCount}컷
                    </div>
                  </div>
                  <button onClick={() => handleLoad(m.id)} style={loadBtn}>불러오기</button>
                  <button onClick={() => handleDelete(m.id)} aria-label="삭제" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ob-muted)", display: "inline-flex", padding: 6 }}>
                    <Glyph name="x" size={14} strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ padding: "14px 20px", borderTop: "1px solid var(--ob-edge)", display: "flex", justifyContent: "flex-end" }}>
          <GhostButton onClick={onClose}>닫고 새로 만들기</GhostButton>
        </div>
      </div>
    </div>
  );
}

const loadBtn: React.CSSProperties = {
  border: "1px solid transparent", background: "var(--ob-accent)", color: "#fff",
  borderRadius: 999, padding: "7px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer",
};
