"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { buildDocument } from "@/lib/apps";
import { useT } from "@/lib/i18n";
import { IconApps, IconChevronRight, IconEdit, IconPlus, IconSparkles } from "@/components/Icon";

type Mode = "report" | "paper" | "brief";

const EXAMPLE_GOAL = "대학교 리포트: AI native Apps가 지식 작업을 바꾸는 방식";

export default function DocumentStudioPage() {
  const { locale } = useT();
  const [goal, setGoal] = useState(EXAMPLE_GOAL);
  const [mode, setMode] = useState<Mode>("paper");
  const [activeTab, setActiveTab] = useState("draft");
  const initialDoc = useMemo(() => buildDocument(EXAMPLE_GOAL, "paper"), []);
  const [title, setTitle] = useState(initialDoc.title);
  const [documentText, setDocumentText] = useState(initialDoc.body);
  const [figureCaption, setFigureCaption] = useState(initialDoc.figureCaption);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  function generate() {
    const next = buildDocument(goal, mode);
    setTitle(next.title);
    setDocumentText(next.body);
    setFigureCaption(next.figureCaption);
    setActiveTab("draft");
    setGeneratedAt(new Date().toLocaleTimeString(locale === "en" ? "en-US" : "ko-KR", { hour: "2-digit", minute: "2-digit" }));
  }

  const wordCount = documentText.trim().split(/\s+/).filter(Boolean).length;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--paper)" }}>
      <header
        className="titlebar-drag glass-thin"
        style={{
          minHeight: 48,
          borderBottom: "1px solid var(--glass-border)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 20px 8px 90px",
          flexShrink: 0,
        }}
      >
        <Link href="/apps" className="titlebar-nodrag" style={backLink}>
          <IconApps size={15} />
          Apps
        </Link>
        <IconChevronRight size={12} style={{ color: "var(--muted)" }} />
        <div style={{ fontWeight: 700, fontFamily: "var(--font-head)", color: "var(--ink)" }}>
          {locale === "en" ? "Document Studio" : "문서 스튜디오"}
        </div>
        <div className="titlebar-nodrag" style={tabBar}>
          <TabButton active={activeTab === "draft"} onClick={() => setActiveTab("draft")} label={locale === "en" ? "Draft" : "초안"} />
          <TabButton active={activeTab === "sources"} onClick={() => setActiveTab("sources")} label={locale === "en" ? "Sources" : "소스"} />
          <button onClick={() => setActiveTab("draft")} style={newTabBtn} aria-label={locale === "en" ? "New document tab" : "새 문서 탭"}>
            <IconPlus size={13} />
          </button>
        </div>
      </header>

      <main style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "280px minmax(360px, 1fr) 260px", overflow: "hidden" }}>
        <aside style={sidePanel}>
          <div style={panelHeader}>
            <IconSparkles size={16} style={{ color: "var(--accent)" }} />
            <strong>{locale === "en" ? "Goal" : "목표"}</strong>
          </div>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            style={goalInput}
            rows={6}
            aria-label={locale === "en" ? "Document goal" : "문서 목표"}
          />
          <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
            {(["paper", "report", "brief"] as Mode[]).map((id) => (
              <button
                key={id}
                onClick={() => setMode(id)}
                style={{
                  ...modeBtn,
                  background: mode === id ? "var(--fill-1)" : "var(--paper)",
                  borderColor: mode === id ? "var(--accent)" : "var(--paper-edge)",
                  color: mode === id ? "var(--accent)" : "var(--ink-soft)",
                }}
              >
                {labelForMode(id, locale)}
              </button>
            ))}
          </div>
          <button onClick={generate} className="neu-btn-primary" style={generateBtn}>
            <IconSparkles size={14} />
            {locale === "en" ? "Generate document" : "문서 생성"}
          </button>
          <div style={smallStat}>
            {locale === "en" ? "Runs locally in Agentlas Desktop renderer" : "Agentlas Desktop renderer 안에서 로컬 실행"}
          </div>
        </aside>

        <section style={{ minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", borderLeft: "var(--hairline)", borderRight: "var(--hairline)" }}>
          <div style={editorTop}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={titleInput}
                aria-label={locale === "en" ? "Document title" : "문서 제목"}
              />
              <div style={{ color: "var(--muted-deep)", fontSize: 11.5 }}>
                {wordCount} words {generatedAt ? `· ${generatedAt}` : ""}
              </div>
            </div>
            <span style={statusPill}>{locale === "en" ? "Editable App Artifact" : "수정 가능한 App 산출물"}</span>
          </div>
          {activeTab === "draft" ? (
            <textarea
              value={documentText}
              onChange={(e) => setDocumentText(e.target.value)}
              style={editor}
              aria-label={locale === "en" ? "Generated document editor" : "생성 문서 편집기"}
            />
          ) : (
            <div style={{ padding: 22, overflowY: "auto", display: "grid", gap: 14 }}>
              <SourceBlock title="Agentlas Apps Architecture" text="Apps are top-level runnable surfaces; vault credentials, MCP engines, and generated files support them." />
              <SourceBlock title="Local Prompt" text={goal} />
              <SourceBlock title="Future Connectors" text="Attach web, PDF, academic database, and browser sources through Plugins." />
            </div>
          )}
        </section>

        <aside style={rightPanel}>
          <div style={panelHeader}>
            <IconEdit size={16} style={{ color: "var(--accent)" }} />
            <strong>{locale === "en" ? "Output" : "출력"}</strong>
          </div>
          <div className="glass-strong" style={figureBox}>
            <div style={figureGrid}>
              <span style={figureNode} />
              <span style={figureNode} />
              <span style={figureNode} />
            </div>
            <textarea
              value={figureCaption}
              onChange={(e) => setFigureCaption(e.target.value)}
              rows={4}
              style={captionInput}
              aria-label={locale === "en" ? "Figure caption" : "그림 캡션"}
            />
          </div>
          <button style={ctaBtn}>{locale === "en" ? "Open in Apps" : "Apps에서 확인하기"}</button>
          <div style={smallStat}>
            {locale === "en"
              ? "This is the CTA a chat answer can leave after using the installed App."
              : "AI가 설치된 App을 사용한 뒤 채팅에 남길 수 있는 CTA입니다."}
          </div>
        </aside>
      </main>
    </div>
  );
}

function labelForMode(mode: Mode, locale: "ko" | "en") {
  if (locale === "en") {
    return mode === "paper" ? "Academic paper" : mode === "brief" ? "Executive brief" : "Long report";
  }
  return mode === "paper" ? "학술 논문" : mode === "brief" ? "요약 브리프" : "장문 리포트";
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 12px",
        borderRadius: "7px 7px 0 0",
        background: active ? "var(--paper)" : "var(--paper-2)",
        border: "1px solid var(--paper-edge)",
        borderBottomColor: active ? "var(--paper)" : "var(--paper-edge)",
        color: active ? "var(--ink)" : "var(--muted-deep)",
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {label}
    </button>
  );
}

function SourceBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="neu" style={{ borderRadius: 8, padding: 14 }}>
      <strong style={{ display: "block", fontSize: 13, color: "var(--ink)", marginBottom: 4 }}>{title}</strong>
      <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: 12.5, lineHeight: 1.6 }}>{text}</p>
    </div>
  );
}

const backLink: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  color: "var(--accent)",
  fontWeight: 800,
  fontSize: 12,
  textDecoration: "none",
};

const tabBar: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 4,
  marginLeft: "auto",
  alignSelf: "stretch",
  paddingTop: 10,
};

const newTabBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 7,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--muted-deep)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const sidePanel: React.CSSProperties = {
  padding: 16,
  background: "var(--paper-2)",
  overflowY: "auto",
};

const rightPanel: React.CSSProperties = {
  padding: 16,
  background: "var(--paper-2)",
  overflowY: "auto",
};

const panelHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 10,
  color: "var(--ink)",
  fontSize: 13,
};

const goalInput: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--paper)",
  padding: 10,
  resize: "vertical",
  outline: "none",
  fontSize: 13,
  lineHeight: 1.5,
};

const modeBtn: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  textAlign: "left",
  fontSize: 12.5,
  fontWeight: 700,
};

const generateBtn: React.CSSProperties = {
  marginTop: 14,
  width: "100%",
  minHeight: 38,
  borderRadius: 8,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
};

const smallStat: React.CSSProperties = {
  marginTop: 10,
  color: "var(--muted-deep)",
  fontSize: 11.5,
  lineHeight: 1.5,
};

const editorTop: React.CSSProperties = {
  minHeight: 74,
  padding: "12px 16px",
  borderBottom: "var(--hairline)",
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const titleInput: React.CSSProperties = {
  width: "100%",
  border: "none",
  outline: "none",
  background: "transparent",
  fontFamily: "var(--font-head)",
  fontWeight: 800,
  fontSize: 18,
  color: "var(--ink)",
};

const statusPill: React.CSSProperties = {
  flexShrink: 0,
  padding: "4px 8px",
  borderRadius: 999,
  background: "var(--fill-1)",
  color: "var(--accent)",
  fontSize: 10.5,
  fontWeight: 800,
};

const editor: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  width: "100%",
  border: "none",
  outline: "none",
  resize: "none",
  padding: "20px 24px",
  background: "var(--paper)",
  color: "var(--ink)",
  fontFamily: "var(--font-body)",
  fontSize: 14,
  lineHeight: 1.65,
};

const figureBox: React.CSSProperties = {
  borderRadius: 10,
  padding: 12,
};

const figureGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: 6,
  height: 72,
  marginBottom: 10,
};

const figureNode: React.CSSProperties = {
  borderRadius: 8,
  background: "linear-gradient(135deg, var(--fill-2), var(--paper))",
  border: "1px solid var(--paper-edge)",
};

const captionInput: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--paper)",
  padding: 9,
  resize: "vertical",
  outline: "none",
  fontSize: 12.5,
  lineHeight: 1.45,
};

const ctaBtn: React.CSSProperties = {
  marginTop: 12,
  width: "100%",
  minHeight: 36,
  borderRadius: 8,
  background: "var(--ink)",
  color: "var(--paper)",
  fontWeight: 800,
};
