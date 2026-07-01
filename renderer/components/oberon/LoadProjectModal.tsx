// Oberon — 저장된 프로젝트 불러오기 팝업. 있으면 가져오기, 없으면 새로 만들기 안내.
"use client";
import { useEffect, useState } from "react";
import {
  deleteProduction,
  GENRE_TEMPLATES,
  listProductions,
  loadProduction,
  taxonomyText,
  type FilmFormat,
  type FilmProduction,
  type ProductionMeta,
} from "@/lib/oberon";
import { useT } from "@/lib/i18n";
import { Glyph, OberonBadge } from "./icons";
import { GhostButton } from "./ui";

/** ProductionMeta.format(string)을 GENRE_TEMPLATES 카탈로그에서 locale에 맞게 고른다.
 *  키가 카탈로그에 없으면(구버전 데이터) 원본 문자열로 폴백. */
function formatLabel(format: string, locale: "ko" | "en"): string {
  const tpl = GENRE_TEMPLATES[format as FilmFormat];
  if (!tpl) return format;
  return taxonomyText(tpl.label, tpl.labelEn, locale);
}

export function LoadProjectModal({
  open,
  onClose,
  onLoad,
}: {
  open: boolean;
  onClose: () => void;
  onLoad: (prod: FilmProduction) => void;
}) {
  const { locale } = useT();
  const [list, setList] = useState<ProductionMeta[]>([]);

  useEffect(() => {
    if (open) setList(listProductions());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

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
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ob-ink)", fontFamily: "var(--font-display)" }}>
              {locale === "ko" ? "저장된 프로젝트" : "Saved Projects"}
            </div>
            <div style={{ fontSize: 12, color: "var(--ob-muted)" }}>
              {locale === "ko" ? "이전에 만든 작업을 이어서 합니다" : "Pick up work you started earlier"}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={locale === "ko" ? "닫기" : "Close"}
            style={{ border: "none", background: "var(--ob-fill)", borderRadius: 999, width: 30, height: 30, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--ob-ink-soft)" }}
          >
            <Glyph name="x" size={14} strokeWidth={2.2} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: list.length ? 14 : 0 }}>
          {list.length === 0 ? (
            <div style={{ textAlign: "center", padding: "48px 24px", color: "var(--ob-muted)" }}>
              <OberonBadge name="film" size={40} />
              <p style={{ fontSize: 14, color: "var(--ob-ink-soft)", margin: "16px 0 4px", fontWeight: 600 }}>
                {locale === "ko" ? "저장된 프로젝트가 없어요" : "No saved projects yet"}
              </p>
              <p style={{ fontSize: 13, margin: 0 }}>
                {locale === "ko" ? "창을 닫고 제목·프롬프트를 적어 새로 만들어 보세요." : "Close this window and enter a title and prompt to start a new one."}
              </p>
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
                      {formatLabel(m.format, locale)} · {locale === "ko" ? `${m.shotCount}컷` : `${m.shotCount} shots`}
                    </div>
                  </div>
                  <button onClick={() => handleLoad(m.id)} style={loadBtn}>{locale === "ko" ? "불러오기" : "Load"}</button>
                  <button
                    onClick={() => handleDelete(m.id)}
                    aria-label={locale === "ko" ? "삭제" : "Delete"}
                    style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ob-muted)", display: "inline-flex", padding: 6 }}
                  >
                    <Glyph name="x" size={14} strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ padding: "14px 20px", borderTop: "1px solid var(--ob-edge)", display: "flex", justifyContent: "flex-end" }}>
          <GhostButton onClick={onClose}>{locale === "ko" ? "닫고 새로 만들기" : "Close and Start New"}</GhostButton>
        </div>
      </div>
    </div>
  );
}

const loadBtn: React.CSSProperties = {
  border: "1px solid transparent", background: "var(--ob-accent)", color: "#fff",
  borderRadius: 999, padding: "7px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer",
};
