"use client";
import { useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import { buildDocument } from "@/lib/apps";
import { useT } from "@/lib/i18n";
import {
  IconApps,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconEdit,
  IconFileUp,
  IconImage,
  IconSearch,
  IconSparkles,
} from "@/components/Icon";

type Mode = "report" | "paper" | "brief";

const EXAMPLE_GOAL = "대학교 리포트: AI native Apps가 지식 작업을 바꾸는 방식";
const CITATION_STYLES = ["ACS", "AMA (11th ed.)", "APA", "APA (6th ed.)", "Cite Them Right 12th ed.", "CMOS author-date", "Council of Science Editors", "Harvard"];

export default function DocumentStudioPage() {
  const { locale } = useT();
  const [goal, setGoal] = useState(EXAMPLE_GOAL);
  const [mode, setMode] = useState<Mode>("paper");
  const initialDoc = useMemo(() => buildDocument(EXAMPLE_GOAL, "paper"), []);
  const [title, setTitle] = useState(initialDoc.title);
  const [documentText, setDocumentText] = useState(initialDoc.body);
  const [figureCaption, setFigureCaption] = useState(initialDoc.figureCaption);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [citationStyle, setCitationStyle] = useState("APA");
  const [citationOpen, setCitationOpen] = useState(false);
  const [citationSearch, setCitationSearch] = useState("");
  const [activeSource, setActiveSource] = useState("architecture");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  function generate() {
    const next = buildDocument(goal, mode);
    setTitle(next.title);
    setDocumentText(next.body);
    setFigureCaption(next.figureCaption);
    setGeneratedAt(new Date().toLocaleTimeString(locale === "en" ? "en-US" : "ko-KR", { hour: "2-digit", minute: "2-digit" }));
    setExportStatus(null);
  }

  function exportDocument() {
    const body = [
      `# ${title.trim() || goal.trim() || "Agentlas Document"}`,
      "",
      documentText.trim(),
      "",
      figureCaption.trim() ? `## ${locale === "en" ? "Figure note" : "도표 메모"}` : "",
      figureCaption.trim(),
      "",
      `Citation style: ${citationStyle}`,
    ].filter((part) => part !== "").join("\n");
    const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileSlug(title || goal)}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExportStatus(locale === "en" ? "Markdown exported" : "Markdown 내보냄");
  }

  const wordCount = documentText.trim().split(/\s+/).filter(Boolean).length;
  const filteredCitationStyles = CITATION_STYLES.filter((style) => style.toLowerCase().includes(citationSearch.toLowerCase()));
  const sourceCards = sourceItems(locale);

  return (
    <div style={shell}>
      <style>{`
        @media (max-width: 900px) {
          .document-studio-toolbar {
            padding-left: 16px !important;
            flex-wrap: wrap;
            min-height: auto !important;
          }
          .document-studio-ai-toolbar {
            flex-wrap: wrap;
            min-height: auto !important;
          }
          .document-studio-goal {
            min-width: min(100%, 220px) !important;
            flex-basis: 100%;
          }
          .document-studio-workspace {
            grid-template-columns: 1fr !important;
            overflow: auto !important;
          }
          .document-studio-workspace > aside {
            min-height: 160px;
            max-height: 260px;
            border-right: none !important;
            border-bottom: 1px solid #e5e7eb;
          }
        }
      `}</style>
      <header className="titlebar-drag document-studio-toolbar" style={topToolbar}>
        <Link href="/apps" className="titlebar-nodrag" style={backLink}>
          <IconApps size={15} />
          Apps
        </Link>
        <div style={{ position: "relative", marginLeft: "auto" }} className="titlebar-nodrag">
          <button type="button" onClick={() => setCitationOpen((open) => !open)} style={citationButton}>
            {citationStyle}
            <IconChevronDown size={13} />
          </button>
          {citationOpen && (
            <div style={citationMenu}>
              <label style={citationSearchBox}>
                <IconSearch size={14} />
                <input
                  value={citationSearch}
                  onChange={(event) => setCitationSearch(event.target.value)}
                  placeholder={locale === "en" ? "Search citation style" : "인용 스타일 검색"}
                  style={citationInput}
                />
              </label>
              <div style={citationList}>
                {filteredCitationStyles.map((style) => (
                  <button
                    key={style}
                    type="button"
                    onClick={() => {
                      setCitationStyle(style);
                      setCitationOpen(false);
                    }}
                    style={citationOption}
                  >
                    <span>{style}</span>
                    {style === citationStyle ? <IconCheck size={15} style={{ color: "var(--green-deep)" }} /> : null}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <button onClick={exportDocument} className="titlebar-nodrag" style={exportButton}>
          <IconFileUp size={14} />
          {locale === "en" ? "Export" : "내보내기"}
        </button>
        {exportStatus && <span role="status" style={exportStatusStyle}>{exportStatus}</span>}
      </header>

      <div className="document-studio-ai-toolbar" style={aiToolbar}>
        <span style={aiBadge}>AI</span>
        <div className="document-studio-goal" style={goalBox}>
          <IconSparkles size={14} style={{ color: "var(--accent)" }} />
          <input value={goal} onChange={(event) => setGoal(event.target.value)} style={goalInput} aria-label={locale === "en" ? "Document goal" : "문서 목표"} />
        </div>
        {(["paper", "report", "brief"] as Mode[]).map((id) => (
          <button key={id} onClick={() => setMode(id)} style={{ ...modeChip, color: mode === id ? "var(--accent)" : "var(--muted-deep)", background: mode === id ? "var(--fill-1)" : "transparent" }}>
            {labelForMode(id, locale)}
          </button>
        ))}
        <button type="button" onClick={generate} style={generateButton}>
          <IconSparkles size={13} />
          {locale === "en" ? "Generate" : "생성"}
        </button>
      </div>

      <main
        className="document-studio-workspace"
        style={{
          ...workspace,
          gridTemplateColumns: `${leftOpen ? "260px" : "40px"} minmax(360px, 1fr) ${rightOpen ? "290px" : "40px"}`,
        }}
      >
        {leftOpen ? (
          <aside style={sourceRail}>
            <div style={railHeader}>
              <span style={railTitle}>{locale === "en" ? "Sources" : "소스"}</span>
              <button
                type="button"
                onClick={() => setLeftOpen(false)}
                style={collapseButton}
                aria-label={locale === "en" ? "Collapse sources panel" : "소스 패널 접기"}
                title={locale === "en" ? "Collapse" : "접기"}
              >
                <IconChevronRight size={14} style={{ transform: "rotate(180deg)" }} />
              </button>
            </div>
            {sourceCards.map((source) => (
              <button
                key={source.id}
                onClick={() => setActiveSource(source.id)}
                style={{
                  ...sourceCard,
                  borderColor: activeSource === source.id ? "var(--accent)" : "var(--paper-edge)",
                  background: activeSource === source.id ? "var(--fill-1)" : "var(--paper)",
                }}
              >
                <strong>{source.title}</strong>
                <span>{source.detail}</span>
              </button>
            ))}
          </aside>
        ) : (
          <CollapsedRail
            side="left"
            label={locale === "en" ? "Sources" : "소스"}
            onExpand={() => setLeftOpen(true)}
            ariaLabel={locale === "en" ? "Expand sources panel" : "소스 패널 펼치기"}
          />
        )}

        <section style={editorStage}>
          <div style={paper}>
            <textarea value={title} onChange={(event) => setTitle(event.target.value)} rows={2} style={titleInput} aria-label={locale === "en" ? "Document title" : "문서 제목"} />
            <div style={docMeta}>
              <span>{wordCount} words</span>
              <span>{citationStyle}</span>
              {generatedAt ? <span>{generatedAt}</span> : null}
            </div>
            <div style={highlightStrip}>
              <span style={highlightPill}>{locale === "en" ? "6 claims checked" : "6개 주장 검토"}</span>
              <span style={highlightPill}>{locale === "en" ? "2 citations ready" : "인용 2개 준비됨"}</span>
              <span style={highlightPill}>{locale === "en" ? "Editable draft" : "편집 가능한 초안"}</span>
            </div>
            <textarea value={documentText} onChange={(event) => setDocumentText(event.target.value)} style={editor} aria-label={locale === "en" ? "Generated document editor" : "생성 문서 편집기"} />
          </div>
        </section>

        {rightOpen ? (
          <aside style={inspector}>
            <div style={railHeader}>
              <span style={railTitle}>{locale === "en" ? "Figure note" : "도표 메모"}</span>
              <button
                type="button"
                onClick={() => setRightOpen(false)}
                style={collapseButton}
                aria-label={locale === "en" ? "Collapse figure note panel" : "도표 메모 패널 접기"}
                title={locale === "en" ? "Collapse" : "접기"}
              >
                <IconChevronRight size={14} />
              </button>
            </div>
            <textarea
              value={figureCaption}
              onChange={(event) => setFigureCaption(event.target.value)}
              rows={6}
              style={figureInput}
              aria-label={locale === "en" ? "Figure note" : "도표 메모"}
            />
          </aside>
        ) : (
          <CollapsedRail
            side="right"
            label={locale === "en" ? "Figure note" : "도표 메모"}
            onExpand={() => setRightOpen(true)}
            ariaLabel={locale === "en" ? "Expand figure note panel" : "도표 메모 패널 펼치기"}
          />
        )}
      </main>
    </div>
  );
}

function fileSlug(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "agentlas-document";
}

function labelForMode(mode: Mode, locale: "ko" | "en") {
  if (locale === "en") return mode === "paper" ? "Paper" : mode === "brief" ? "Brief" : "Report";
  return mode === "paper" ? "논문" : mode === "brief" ? "브리프" : "리포트";
}

function ToolbarText({ label, active, italic, underline, strike }: { label: string; active?: boolean; italic?: boolean; underline?: boolean; strike?: boolean }) {
  return (
    <button
      style={{
        ...iconButton,
        fontWeight: active ? 800 : 700,
        fontStyle: italic ? "italic" : "normal",
        textDecoration: underline ? "underline" : strike ? "line-through" : "none",
      }}
    >
      {label}
    </button>
  );
}

function ActionCard({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <button style={actionCard}>
      <span style={actionIcon}>{icon}</span>
      <strong>{title}</strong>
      <span>{text}</span>
    </button>
  );
}

function CollapsedRail({ side, label, onExpand, ariaLabel }: { side: "left" | "right"; label: string; onExpand: () => void; ariaLabel: string }) {
  return (
    <div style={collapsedRail}>
      <button type="button" onClick={onExpand} style={expandButton} aria-label={ariaLabel} title={label}>
        <IconChevronRight size={14} style={{ transform: side === "left" ? "none" : "rotate(180deg)" }} />
      </button>
      <span style={collapsedLabel}>{label}</span>
    </div>
  );
}

function sourceItems(locale: "ko" | "en") {
  return locale === "en"
    ? [
        { id: "architecture", title: "Agentlas Apps Architecture", detail: "Apps as runnable surfaces with support engines below." },
        { id: "prompt", title: "Local prompt", detail: "The current user goal and writing mode." },
        { id: "future", title: "Future connectors", detail: "Web, PDF, academic database, and browser sources." },
      ]
    : [
        { id: "architecture", title: "Agentlas Apps Architecture", detail: "Apps를 실행 표면으로 두고 하위 엔진이 보조합니다." },
        { id: "prompt", title: "현재 프롬프트", detail: "사용자 목표와 문서 작성 모드입니다." },
        { id: "future", title: "추가 소스", detail: "웹, PDF, 논문 DB, 브라우저 소스 연결 예정." },
      ];
}

const shell: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  background: "#f7f8fa",
  color: "var(--ink)",
};

const topToolbar: CSSProperties = {
  minHeight: 42,
  borderBottom: "1px solid #e5e7eb",
  background: "#ffffff",
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 16px 6px 90px",
  flexShrink: 0,
};

const backLink: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  color: "var(--accent)",
  fontWeight: 800,
  fontSize: 12,
  textDecoration: "none",
};

const toolbarDivider: CSSProperties = { width: 1, height: 20, background: "#e5e7eb", margin: "0 4px" };

const iconButton: CSSProperties = {
  width: 30,
  height: 30,
  border: "none",
  background: "transparent",
  color: "var(--ink-soft)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 6,
  fontSize: 14,
};

const toolbarSelect: CSSProperties = {
  height: 30,
  border: "none",
  background: "transparent",
  color: "var(--ink-soft)",
  fontSize: 13,
  fontWeight: 700,
  outline: "none",
};

const citationButton: CSSProperties = {
  height: 32,
  minWidth: 96,
  border: "1px solid #d7dbe3",
  borderRadius: 999,
  background: "#ffffff",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "0 12px",
  color: "var(--ink)",
  fontWeight: 800,
};

const citationMenu: CSSProperties = {
  position: "absolute",
  top: 38,
  right: 0,
  width: 260,
  maxHeight: 360,
  border: "1px solid #e2e5ea",
  borderRadius: 8,
  background: "#ffffff",
  boxShadow: "0 18px 48px rgba(15,23,42,.16)",
  padding: 10,
  zIndex: 20,
};

const citationSearchBox: CSSProperties = {
  height: 34,
  border: "1px solid #1f2937",
  borderRadius: 7,
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "0 9px",
  color: "var(--muted-deep)",
};

const citationInput: CSSProperties = {
  border: "none",
  outline: "none",
  minWidth: 0,
  flex: 1,
  fontSize: 12.5,
};

const citationList: CSSProperties = { marginTop: 8, display: "grid", gap: 1, maxHeight: 284, overflowY: "auto" };

const citationOption: CSSProperties = {
  minHeight: 32,
  border: "none",
  background: "transparent",
  color: "var(--ink)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "0 8px",
  borderRadius: 6,
  textAlign: "left",
  fontSize: 13,
};

const exportButton: CSSProperties = {
  height: 32,
  border: "none",
  borderRadius: 7,
  background: "#108334",
  color: "#ffffff",
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  padding: "0 12px",
  fontWeight: 900,
};

const exportStatusStyle: CSSProperties = {
  color: "var(--green-deep)",
  fontSize: 11.5,
  fontWeight: 800,
  whiteSpace: "nowrap",
};

const aiToolbar: CSSProperties = {
  minHeight: 42,
  borderBottom: "1px solid #e5e7eb",
  background: "#ffffff",
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 18px",
  flexShrink: 0,
};

const aiBadge: CSSProperties = {
  minWidth: 26,
  height: 22,
  borderRadius: 7,
  background: "#fff4bf",
  color: "#7c5800",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 11,
  fontWeight: 900,
};

const plainTool: CSSProperties = {
  border: "none",
  background: "transparent",
  color: "var(--ink-soft)",
  fontSize: 12.5,
  fontWeight: 800,
};

const goalBox: CSSProperties = {
  minWidth: 280,
  flex: 1,
  height: 30,
  border: "1px solid #e4e7ec",
  borderRadius: 7,
  background: "#fbfcfd",
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "0 9px",
};

const goalInput: CSSProperties = {
  minWidth: 0,
  flex: 1,
  border: "none",
  outline: "none",
  background: "transparent",
  color: "var(--ink)",
  fontSize: 12.5,
};

const modeChip: CSSProperties = {
  border: "none",
  borderRadius: 999,
  padding: "6px 9px",
  fontSize: 11.5,
  fontWeight: 900,
};

const generateButton: CSSProperties = {
  minHeight: 30,
  border: "1px solid var(--accent-soft)",
  borderRadius: 7,
  background: "var(--fill-1)",
  color: "var(--accent)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: "0 10px",
  fontSize: 12,
  fontWeight: 900,
};

const workspace: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "grid",
  gridTemplateColumns: "260px minmax(420px, 1fr)",
  overflow: "hidden",
};

const sourceRail: CSSProperties = {
  borderRight: "1px solid #e5e7eb",
  background: "#fbfcfd",
  padding: 14,
  overflowY: "auto",
  display: "grid",
  alignContent: "start",
  gap: 10,
};

const railTitle: CSSProperties = {
  color: "var(--muted-deep)",
  fontSize: 11,
  fontWeight: 900,
  textTransform: "uppercase",
  letterSpacing: ".06em",
};

const railHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const collapseButton: CSSProperties = {
  width: 24,
  height: 24,
  border: "1px solid var(--paper-edge)",
  borderRadius: 6,
  background: "var(--paper)",
  color: "var(--muted-deep)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  flexShrink: 0,
};

const collapsedRail: CSSProperties = {
  borderRight: "1px solid #e5e7eb",
  borderLeft: "1px solid #e5e7eb",
  background: "#fbfcfd",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 12,
  padding: "12px 0",
  overflow: "hidden",
};

const expandButton: CSSProperties = {
  width: 26,
  height: 26,
  border: "1px solid var(--paper-edge)",
  borderRadius: 6,
  background: "var(--paper)",
  color: "var(--ink-soft)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  flexShrink: 0,
};

const collapsedLabel: CSSProperties = {
  writingMode: "vertical-rl",
  transform: "rotate(180deg)",
  color: "var(--muted-deep)",
  fontSize: 11,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: ".08em",
  whiteSpace: "nowrap",
};

const sourceCard: CSSProperties = {
  border: "1px solid #e3e6ec",
  borderRadius: 8,
  padding: 11,
  display: "grid",
  gap: 4,
  textAlign: "left",
  color: "var(--ink-soft)",
  fontSize: 12,
  lineHeight: 1.45,
};

const figurePanel: CSSProperties = { marginTop: 10, display: "grid", gap: 8 };

const figureInput: CSSProperties = {
  width: "100%",
  border: "1px solid #e3e6ec",
  borderRadius: 8,
  background: "#ffffff",
  padding: 10,
  resize: "vertical",
  outline: "none",
  color: "var(--ink-soft)",
  fontSize: 12.5,
  lineHeight: 1.5,
};

const editorStage: CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  overflowY: "auto",
  padding: "48px 40px 64px",
};

const paper: CSSProperties = {
  width: "min(760px, 100%)",
  minHeight: "calc(100vh - 220px)",
  margin: "0 auto",
  background: "#ffffff",
  border: "1px solid #edf0f4",
  boxShadow: "0 20px 70px rgba(15,23,42,.08)",
  padding: "54px 64px",
};

const titleInput: CSSProperties = {
  width: "100%",
  border: "none",
  outline: "none",
  background: "transparent",
  resize: "none",
  overflow: "hidden",
  color: "#20242a",
  fontFamily: "var(--font-head)",
  fontSize: 26,
  lineHeight: 1.2,
  fontWeight: 900,
};

const docMeta: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  color: "var(--muted-deep)",
  fontSize: 11.5,
  marginTop: 8,
};

const highlightStrip: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 7,
  marginTop: 18,
  marginBottom: 18,
};

const highlightPill: CSSProperties = {
  borderRadius: 999,
  background: "#edf7ff",
  color: "#2563eb",
  padding: "5px 8px",
  fontSize: 11.5,
  fontWeight: 900,
};

const editor: CSSProperties = {
  width: "100%",
  minHeight: 520,
  border: "none",
  outline: "none",
  resize: "vertical",
  background: "#ffffff",
  color: "#20242a",
  fontFamily: "var(--font-body)",
  fontSize: 15.5,
  lineHeight: 1.85,
};

const inspector: CSSProperties = {
  borderLeft: "1px solid #e5e7eb",
  background: "#fbfcfd",
  padding: 14,
  overflowY: "auto",
  display: "grid",
  alignContent: "start",
  gap: 10,
};

const actionCard: CSSProperties = {
  border: "1px solid #e3e6ec",
  borderRadius: 8,
  background: "#ffffff",
  padding: 12,
  display: "grid",
  gap: 5,
  textAlign: "left",
  color: "var(--ink-soft)",
  fontSize: 12.5,
  lineHeight: 1.45,
};

const actionIcon: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 7,
  background: "var(--fill-1)",
  color: "var(--accent)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};
