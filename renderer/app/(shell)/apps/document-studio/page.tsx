"use client";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import {
  CITATION_STYLES,
  buildBibliography,
  formatInline,
  formatReference,
  type CitationStyle,
  type Reference,
  type ReferenceType,
} from "@/lib/citations";
import {
  clearDocumentDraft,
  loadDocumentDraft,
  loadReferences,
  loadStyle,
  newReferenceId,
  saveDocumentDraft,
  saveReferences,
  saveStyle,
  takeDocumentHandoff,
  type DocumentDraftSaveResult,
  type DocumentStudioDraftInput,
} from "@/lib/document-store";
import {
  IconApps,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconFileUp,
  IconImage,
  IconPlus,
  IconSparkles,
  IconTrash,
  IconClose,
} from "@/components/Icon";

type Mode = "report" | "paper" | "brief";
type ReviseAction = "expand" | "rewrite" | "shorten" | "improve" | "formal" | "casual";

const EXAMPLE_GOAL_KO = "대학교 리포트: AI native Apps가 지식 작업을 바꾸는 방식";
const EXAMPLE_GOAL_EN = "University report: how AI-native Apps change knowledge work";

const REVISE_ACTIONS: { id: ReviseAction; en: string; ko: string }[] = [
  { id: "expand", en: "Expand", ko: "확장" },
  { id: "rewrite", en: "Rewrite", ko: "재작성" },
  { id: "shorten", en: "Shorten", ko: "축약" },
  { id: "improve", en: "Improve", ko: "개선" },
  { id: "formal", en: "Formal", ko: "격식" },
  { id: "casual", en: "Casual", ko: "구어" },
];

const REF_TYPES: { id: ReferenceType; en: string; ko: string }[] = [
  { id: "article", en: "Journal article", ko: "저널 논문" },
  { id: "book", en: "Book", ko: "도서" },
  { id: "chapter", en: "Book chapter", ko: "도서 챕터" },
  { id: "web", en: "Web page", ko: "웹 페이지" },
  { id: "report", en: "Report", ko: "보고서" },
];

export default function DocumentStudioPage() {
  const { locale } = useT();
  const exampleGoal = locale === "ko" ? EXAMPLE_GOAL_KO : EXAMPLE_GOAL_EN;
  const [goal, setGoal] = useState(exampleGoal);
  const [mode, setMode] = useState<Mode>("paper");
  // no-fallback: 초기 화면은 가짜 초안으로 채우지 않는다.
  const [title, setTitle] = useState("");
  const [documentText, setDocumentText] = useState("");
  const [figureCaption, setFigureCaption] = useState("");
  const [figureSrc, setFigureSrc] = useState(""); // 생성된 도표 이미지 data URI(codex/agy image_gen).
  const [figureBusy, setFigureBusy] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [revising, setRevising] = useState<ReviseAction | null>(null);
  const [genEngine, setGenEngine] = useState<"agy" | "codex" | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  // Which PDF path this computer actually has. Shown before the click so the
  // user is never surprised by a browser-rendered page when they wanted LaTeX.
  const [pdfLatex, setPdfLatex] = useState(false);
  const [handoffSource, setHandoffSource] = useState<string>("");
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftSaveResult, setDraftSaveResult] = useState<DocumentDraftSaveResult | null>(null);

  const [references, setReferences] = useState<Reference[]>([]);
  const [citationStyle, setCitationStyle] = useState<CitationStyle>("APA");
  const [citationOpen, setCitationOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [editingRef, setEditingRef] = useState<Reference | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const editorRef = useRef<HTMLTextAreaElement>(null);
  const citationRootRef = useRef<HTMLDivElement>(null);
  const citationTriggerRef = useRef<HTMLButtonElement>(null);
  const exportRootRef = useRef<HTMLDivElement>(null);
  const exportTriggerRef = useRef<HTMLButtonElement>(null);
  const selection = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  const firstSave = useRef(true); // 초기 [] 로 저장된 소스를 덮어쓰지 않도록 첫 저장을 건너뛴다.
  const draftHydratedRef = useRef(false);
  const draftSnapshotRef = useRef<DocumentStudioDraftInput>({
    title: "",
    body: "",
    figureSrc: "",
    figureCaption: "",
  });

  useDismissibleLayer({
    open: citationOpen,
    roots: [citationRootRef],
    restoreFocusRef: citationTriggerRef,
    onDismiss: () => setCitationOpen(false),
  });
  useDismissibleLayer({
    open: exportOpen,
    roots: [exportRootRef],
    restoreFocusRef: exportTriggerRef,
    onDismiss: () => setExportOpen(false),
  });

  if (draftHydrated) {
    draftSnapshotRef.current = { title, body: documentText, figureSrc, figureCaption };
  }

  // 초기 로드: 인계된 답변(있으면 우선) → 작성 중인 초안 + 저장된 소스/스타일 + LLM 가용 여부.
  useEffect(() => {
    // 채팅/One 에서 넘어온 답변이 있으면 초안보다 먼저다. 사용자가 방금 "문서로
    // 열기"를 눌렀는데 예전 초안이 뜨면 누른 행동이 무시된 것으로 읽힌다.
    const handoff = takeDocumentHandoff();
    if (handoff) {
      setTitle(handoff.title);
      setDocumentText(handoff.body);
      draftSnapshotRef.current = {
        title: handoff.title,
        body: handoff.body,
        figureSrc: "",
        figureCaption: "",
      };
      setHandoffSource(handoff.sourceLabel);
      draftHydratedRef.current = true;
      setDraftHydrated(true);
      setReferences(loadReferences());
      const styleFromStore = loadStyle();
      if (styleFromStore && (CITATION_STYLES as string[]).includes(styleFromStore)) setCitationStyle(styleFromStore);
      void ipc()
        ?.document?.available()
        .then((st) => setAiAvailable(Boolean(st?.agy || st?.codex)))
        .catch(() => setAiAvailable(false));
      void ipc()
        ?.document?.pdfCapability()
        .then((cap) => setPdfLatex(Boolean(cap?.latex)))
        .catch(() => setPdfLatex(false));
      return;
    }
    const restored = loadDocumentDraft();
    if (restored) {
      setTitle(restored.title);
      setDocumentText(restored.body);
      setFigureSrc(restored.figureSrc);
      setFigureCaption(restored.figureCaption);
      draftSnapshotRef.current = {
        title: restored.title,
        body: restored.body,
        figureSrc: restored.figureSrc,
        figureCaption: restored.figureCaption,
      };
      setDraftSaveResult(
        restored.figurePersistence === "omitted-size" || restored.figurePersistence === "omitted-quota"
          ? {
              status: "saved-without-figure",
              figurePersistence: restored.figurePersistence,
              updatedAt: restored.updatedAt,
            }
          : {
              status: "saved",
              figurePersistence: restored.figurePersistence,
              updatedAt: restored.updatedAt,
            },
      );
    }
    draftHydratedRef.current = true;
    setDraftHydrated(true);
    setReferences(loadReferences());
    const s = loadStyle();
    if (s && (CITATION_STYLES as string[]).includes(s)) setCitationStyle(s);
    void ipc()
      ?.document?.available()
      .then((st) => setAiAvailable(Boolean(st?.agy || st?.codex)))
      .catch(() => setAiAvailable(false));
    void ipc()
      ?.document?.pdfCapability()
      .then((cap) => setPdfLatex(Boolean(cap?.latex)))
      .catch(() => setPdfLatex(false));
  }, []);

  // Synchronous localStorage writes are debounced while typing. The unmount
  // boundary below flushes the ref immediately, so route changes cannot lose
  // the final keystroke that is still inside this debounce window.
  useEffect(() => {
    if (!draftHydrated) return;
    setDraftSaving(true);
    const timer = window.setTimeout(() => {
      setDraftSaveResult(saveDocumentDraft(draftSnapshotRef.current));
      setDraftSaving(false);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draftHydrated, title, documentText, figureSrc, figureCaption]);

  useEffect(
    () => () => {
      if (draftHydratedRef.current) saveDocumentDraft(draftSnapshotRef.current);
    },
    [],
  );

  // 소스 변경 시 영속. 첫 실행(초기 []) 은 건너뛰어 저장된 소스를 클로버하지 않는다.
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    saveReferences(references);
  }, [references]);

  const pickStyle = (s: CitationStyle) => {
    setCitationStyle(s);
    saveStyle(s);
    setCitationOpen(false);
  };

  const bibliography = useMemo(() => buildBibliography(references, citationStyle), [references, citationStyle]);
  const wordCount = documentText.trim() ? documentText.trim().split(/\s+/).filter(Boolean).length : 0;
  const readingMin = Math.max(1, Math.round(wordCount / 200));
  const sectionCount = (documentText.match(/^#{1,3}\s+/gm) || []).length;
  const draftPersistence = draftPersistenceCopy(draftSaving, draftSaveResult, locale);

  function setError(text: string) {
    setStatusMsg({ kind: "error", text });
  }

  function startNewDocument() {
    const hasDraft = Boolean(title || documentText || figureSrc || figureCaption);
    if (
      hasDraft &&
      !window.confirm(
        locale === "en"
          ? "Start a new document? The current title, body, figure, and caption will be cleared."
          : "새 문서를 시작할까요? 현재 제목, 본문, 도표, 캡션이 지워집니다.",
      )
    ) {
      return;
    }
    const emptyDraft: DocumentStudioDraftInput = {
      title: "",
      body: "",
      figureSrc: "",
      figureCaption: "",
    };
    const clearResult = clearDocumentDraft();
    draftSnapshotRef.current = emptyDraft;
    setTitle("");
    setDocumentText("");
    setFigureSrc("");
    setFigureCaption("");
    setGoal(exampleGoal);
    setMode("paper");
    setGeneratedAt(null);
    setGenEngine(null);
    setStatusMsg(null);
    setExportStatus(null);
    setDraftSaving(false);
    setDraftSaveResult(clearResult.status === "failed" ? clearResult : null);
    selection.current = { start: 0, end: 0 };
  }

  async function generate() {
    if (generating || revising) return;
    setGenerating(true);
    setExportStatus(null);
    setStatusMsg(null);
    try {
      const sources = references.map((r) => ({
        authors: r.authors.join(", "),
        title: r.title,
        year: r.year,
        container: r.container,
      }));
      const res = await ipc()?.document?.generate({ goal, mode, locale, sources });
      if (res?.ok && res.doc) {
        if (res.doc.title) setTitle(res.doc.title);
        setDocumentText(res.doc.body);
        if (res.doc.figureCaption) setFigureCaption(res.doc.figureCaption);
        setGeneratedAt(new Date().toLocaleTimeString(locale === "en" ? "en-US" : "ko-KR", { hour: "2-digit", minute: "2-digit" }));
        setGenEngine(res.engine ?? null);
        setStatusMsg({ kind: "ok", text: locale === "en" ? `Drafted with ${res.engine}` : `${res.engine}로 작성됨` });
        return;
      }
      // no-fallback: 미연결/실패면 가짜 초안을 만들지 않고 명시적으로 막는다.
      setGenEngine(null);
      setError(
        res?.reason === "empty-goal"
          ? locale === "en"
            ? "Enter a document goal first."
            : "문서 목표를 먼저 입력하세요."
          : locale === "en"
            ? "No AI runtime connected. Connect the agy or codex CLI, then generate — no template fallback."
            : "AI 런타임이 연결되지 않았습니다. agy 또는 codex CLI를 연결한 뒤 생성하세요 — 템플릿 폴백 없음.",
      );
    } catch {
      setGenEngine(null);
      setError(locale === "en"
        ? "The draft could not be generated. Your current document and goal are unchanged; check the AI runtime and try again."
        : "초안을 생성하지 못했습니다. 현재 문서와 목표는 그대로입니다. AI 런타임을 확인한 뒤 다시 시도하세요.");
    } finally {
      setGenerating(false);
    }
  }

  function rememberSelection() {
    const el = editorRef.current;
    if (el) selection.current = { start: el.selectionStart, end: el.selectionEnd };
  }

  async function revise(action: ReviseAction) {
    if (revising || generating) return;
    const el = editorRef.current;
    if (!el) return;
    const { start, end } = selection.current;
    const hasSel = end > start;
    const target = hasSel ? documentText.slice(start, end) : documentText;
    if (!target.trim()) {
      setError(locale === "en" ? "Select some text to edit, or generate a draft first." : "편집할 텍스트를 선택하거나 먼저 초안을 생성하세요.");
      return;
    }
    setRevising(action);
    setStatusMsg({ kind: "info", text: locale === "en" ? "Editing…" : "편집 중…" });
    try {
      const res = await ipc()?.document?.revise({ text: target, action, locale });
      if (res?.ok && res.text) {
        const next = hasSel ? documentText.slice(0, start) + res.text + documentText.slice(end) : res.text;
        setDocumentText(next);
        setStatusMsg({ kind: "ok", text: locale === "en" ? `Edited with ${res.engine}` : `${res.engine}로 편집됨` });
      } else {
        setError(
          locale === "en"
            ? "No AI runtime connected — cannot edit. Connect agy or codex."
            : "AI 런타임 미연결 — 편집 불가. agy 또는 codex를 연결하세요.",
        );
      }
    } catch {
      setError(locale === "en"
        ? "The edit could not be applied. The selected text and document are unchanged; try again."
        : "편집을 적용하지 못했습니다. 선택한 텍스트와 문서는 그대로입니다. 다시 시도하세요.");
    } finally {
      setRevising(null);
    }
  }

  // 도표 캡션 → 실제 이미지(codex/agy image_gen, 키리스). no-fallback.
  async function generateFigure() {
    const prompt = figureCaption.trim();
    if (figureBusy) return;
    if (!prompt) {
      setError(locale === "en" ? "Write a figure note first — it is the image prompt." : "도표 메모를 먼저 작성하세요 — 그게 이미지 프롬프트입니다.");
      return;
    }
    setFigureBusy(true);
    setStatusMsg({ kind: "info", text: locale === "en" ? "Generating figure…" : "도표 생성 중…" });
    try {
      const r = await ipc()?.multimodal?.generateImage({
        model: "auto",
        prompt: `${prompt}. Clean editorial diagram or illustration for a document figure. No text, letters, or numbers anywhere in the image.`,
      });
      if (r?.ok && r.src) {
        setFigureSrc(r.src);
        setStatusMsg({ kind: "ok", text: locale === "en" ? `Figure via ${r.engine}` : `도표 생성 · ${r.engine}` });
      } else {
        setError(
          locale === "en"
            ? "No image runtime connected (codex/agy) — cannot render the figure."
            : "이미지 런타임 미연결(codex/agy) — 도표를 만들 수 없습니다.",
        );
      }
    } catch {
      setError(locale === "en"
        ? "The figure could not be generated. The current figure and note are unchanged; check the image runtime and try again."
        : "도표를 생성하지 못했습니다. 현재 도표와 메모는 그대로입니다. 이미지 런타임을 확인한 뒤 다시 시도하세요.");
    } finally {
      setFigureBusy(false);
    }
  }

  function insertCitation(ref: Reference) {
    if (revising) return; // 개정 중 본문 변경 금지(인덱스 드리프트로 개정 결과가 엉뚱한 위치에 splice되는 것 방지).
    const inline = formatInline(ref, citationStyle, references);
    const el = editorRef.current;
    const pos = el ? el.selectionStart : documentText.length;
    const next = `${documentText.slice(0, pos)}${inline}${documentText.slice(pos)}`;
    setDocumentText(next);
    setStatusMsg({ kind: "info", text: locale === "en" ? `Inserted ${inline}` : `삽입: ${inline}` });
  }

  function upsertReference(ref: Reference) {
    setReferences((prev) => {
      const idx = prev.findIndex((r) => r.id === ref.id);
      if (idx < 0) return [...prev, ref];
      const copy = [...prev];
      copy[idx] = ref;
      return copy;
    });
    setEditingRef(null);
  }

  function deleteReference(id: string) {
    setReferences((prev) => prev.filter((r) => r.id !== id));
  }

  function composeMarkdown(): string {
    const figHead = locale === "en" ? "Figure" : "도표";
    return [
      `# ${title.trim() || goal.trim() || "Agentlas Document"}`,
      documentText.trim(),
      figureCaption.trim() ? `## ${figHead}\n\n${figureCaption.trim()}` : "",
      references.length ? bibliography : "",
    ]
      .filter((p) => p !== "")
      .join("\n\n");
  }

  function download(name: string, content: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportMarkdown() {
    download(`${fileSlug(title || goal)}.md`, composeMarkdown(), "text/markdown;charset=utf-8");
    setExportStatus(locale === "en" ? "Markdown exported" : "Markdown 내보냄");
    setExportOpen(false);
  }

  function exportHtml() {
    const fig = figureCaption.trim() ? `## ${locale === "en" ? "Figure" : "도표"}\n\n${figureCaption.trim()}` : "";
    download(`${fileSlug(title || goal)}.html`, buildHtmlDoc(title || goal, documentText, references, citationStyle, bibliography, fig, figureSrc), "text/html;charset=utf-8");
    setExportStatus(locale === "en" ? "HTML exported" : "HTML 내보냄");
    setExportOpen(false);
  }

  // PDF는 저장 위치를 네이티브 다이얼로그가 정하므로 download() 경로를 쓰지 않는다.
  // 결과에는 어떤 엔진이 만들었는지가 담겨 오고, 그대로 사용자에게 보여준다 —
  // Chromium 으로 만든 PDF를 LaTeX 조판인 것처럼 말하지 않기 위해서다.
  async function exportPdf() {
    const body = documentText.trim();
    if (!body) {
      setExportStatus(locale === "en" ? "Nothing to export yet" : "내보낼 내용이 없습니다");
      setExportOpen(false);
      return;
    }
    setExportOpen(false);
    setExportBusy(true);
    setExportStatus(locale === "en" ? "Building PDF…" : "PDF 만드는 중…");
    try {
      const withBibliography = bibliography.trim()
        ? `${body}\n\n## ${locale === "en" ? "References" : "참고문헌"}\n\n${bibliography.trim()}`
        : body;
      const res = await ipc()?.document?.exportPdf({
        title: title || goal,
        markdown: withBibliography,
        figureCaption: figureCaption.trim() || undefined,
        suggestedName: `${fileSlug(title || goal)}.pdf`,
      });
      if (!res || res.canceled) {
        setExportStatus(null);
        return;
      }
      if (!res.ok) {
        setExportStatus((locale === "en" ? "PDF failed: " : "PDF 실패: ") + (res.reason ?? "unknown"));
        return;
      }
      const how =
        res.engine === "tectonic"
          ? locale === "en" ? "LaTeX typeset" : "LaTeX 조판"
          : locale === "en" ? "browser-rendered" : "브라우저 렌더";
      // "설치가 없다" 와 "조판이 실패했다" 는 사용자가 할 일이 다르다. 툴체인이
      // 깔린 사람에게 "없다"고 말하면 그건 그냥 거짓말이다.
      const note =
        res.degraded === "toolchain-missing"
          ? locale === "en" ? " · no LaTeX toolchain here" : " · 이 컴퓨터에 LaTeX 툴체인 없음"
          : res.degraded === "typeset-failed"
            ? (locale === "en" ? " · LaTeX typesetting failed: " : " · LaTeX 조판 실패: ")
              + (res.degradedReason?.split("\n")[0]?.slice(0, 120) ?? "unknown")
            : "";
      setExportStatus(`${locale === "en" ? "PDF exported" : "PDF 내보냄"} · ${how}${note}`);
    } catch (error) {
      setExportStatus((locale === "en" ? "PDF failed: " : "PDF 실패: ") + (error instanceof Error ? error.message : String(error)));
    } finally {
      setExportBusy(false);
    }
  }

  return (
    <div
      style={shell}
      data-testid="document-studio-root"
      data-draft-hydrated={draftHydrated ? "true" : "false"}
      aria-busy={!draftHydrated}
    >
      <style>{RESPONSIVE_CSS}</style>
      <header className="titlebar-drag document-studio-toolbar" style={topToolbar}>
        <Link href="/apps" className="titlebar-nodrag" style={backLink}>
          <IconApps size={15} />
          Apps
        </Link>
        <button
          type="button"
          className="titlebar-nodrag"
          data-testid="document-studio-new-document"
          onClick={startNewDocument}
          style={newDocumentButton}
        >
          <IconPlus size={13} />
          {locale === "en" ? "New document" : "새 문서"}
        </button>
        <div ref={citationRootRef} style={{ position: "relative", marginLeft: "auto" }} className="titlebar-nodrag">
          <button ref={citationTriggerRef} type="button" onClick={() => { setCitationOpen((o) => !o); setExportOpen(false); }} style={citationButton} title={locale === "en" ? "Citation style" : "인용 스타일"}>
            {citationStyle}
            <IconChevronDown size={13} />
          </button>
          {citationOpen && (
            <div style={citationMenu}>
              <div style={citationList}>
                {CITATION_STYLES.map((style) => (
                  <button key={style} type="button" onClick={() => pickStyle(style)} style={citationOption}>
                    <span>{style}</span>
                    {style === citationStyle ? <IconCheck size={15} style={{ color: "var(--green-deep)" }} /> : null}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div ref={exportRootRef} style={{ position: "relative" }} className="titlebar-nodrag">
          <button ref={exportTriggerRef} onClick={() => { setExportOpen((o) => !o); setCitationOpen(false); }} style={exportButton}>
            <IconFileUp size={14} />
            {locale === "en" ? "Export" : "내보내기"}
            <IconChevronDown size={12} />
          </button>
          {exportOpen && (
            <div style={{ ...citationMenu, width: 180 }}>
              <div style={citationList}>
                <button type="button" onClick={exportMarkdown} style={citationOption}>
                  <span>Markdown (.md)</span>
                </button>
                <button type="button" onClick={exportHtml} style={citationOption}>
                  <span>HTML (.html)</span>
                </button>
                <button type="button" onClick={() => void exportPdf()} disabled={exportBusy} style={citationOption}>
                  <span>
                    PDF (.pdf)
                    <em style={{ fontStyle: "normal", color: "var(--muted-deep)", marginLeft: 6, fontSize: 11 }}>
                      {pdfLatex
                        ? locale === "en" ? "LaTeX" : "LaTeX 조판"
                        : locale === "en" ? "browser" : "브라우저 렌더"}
                    </em>
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>
        {handoffSource && (
          <span style={{ ...exportStatusStyle, color: "var(--muted-deep)" }}>
            {locale === "en" ? `From ${handoffSource}` : `${handoffSource}에서 가져옴`}
          </span>
        )}
        {exportStatus && <span role="status" style={exportStatusStyle}>{exportStatus}</span>}
      </header>

      <div className="document-studio-ai-toolbar" style={aiToolbar}>
        <span style={aiBadge}>AI</span>
        <div className="document-studio-goal" style={goalBox}>
          <IconSparkles size={14} style={{ color: "var(--accent)" }} />
          <input value={goal} onChange={(e) => setGoal(e.target.value)} style={goalInput} aria-label={locale === "en" ? "Document goal" : "문서 목표"} />
        </div>
        {(["paper", "report", "brief"] as Mode[]).map((id) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            style={{ ...modeChip, color: mode === id ? "var(--accent)" : "var(--muted-deep)", background: mode === id ? "var(--fill-1)" : "transparent" }}
          >
            {labelForMode(id, locale)}
          </button>
        ))}
        <button type="button" onClick={generate} disabled={generating} style={{ ...generateButton, opacity: generating ? 0.6 : 1, cursor: generating ? "not-allowed" : "pointer" }}>
          <IconSparkles size={13} />
          {generating ? (locale === "en" ? "Generating…" : "생성 중…") : locale === "en" ? "Generate" : "생성"}
        </button>
      </div>

      <main
        className="document-studio-workspace"
        style={{ ...workspace, gridTemplateColumns: `${leftOpen ? "270px" : "40px"} minmax(360px, 1fr) ${rightOpen ? "300px" : "40px"}` }}
      >
        {leftOpen ? (
          <aside style={sourceRail}>
            <div style={railHeader}>
              <span style={railTitle}>{locale === "en" ? `Sources · ${references.length}` : `소스 · ${references.length}`}</span>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  onClick={() => setEditingRef({ id: newReferenceId(), type: "article", authors: [], title: "", year: "" })}
                  style={collapseButton}
                  title={locale === "en" ? "Add source" : "소스 추가"}
                  aria-label={locale === "en" ? "Add source" : "소스 추가"}
                >
                  <IconPlus size={14} />
                </button>
                <button type="button" onClick={() => setLeftOpen(false)} style={collapseButton} title={locale === "en" ? "Collapse" : "접기"} aria-label="collapse">
                  <IconChevronRight size={14} style={{ transform: "rotate(180deg)" }} />
                </button>
              </div>
            </div>

            {references.length === 0 && !editingRef && (
              <p style={emptyHint}>
                {locale === "en"
                  ? "Add sources to ground the draft and build a real bibliography in your chosen style."
                  : "소스를 추가하면 초안 근거가 되고, 선택한 스타일로 실제 참고문헌이 만들어집니다."}
              </p>
            )}

            {references.map((ref) => (
              <div key={ref.id} style={sourceCard}>
                <button type="button" onClick={() => setEditingRef(ref)} style={sourceCardMain}>
                  <strong style={{ color: "var(--ink)" }}>{ref.title || (locale === "en" ? "Untitled source" : "제목 없음")}</strong>
                  <span>{[ref.authors.join(", "), ref.year, ref.container].filter(Boolean).join(" · ")}</span>
                </button>
                <div style={{ display: "flex", gap: 4 }}>
                  <button type="button" onClick={() => insertCitation(ref)} style={miniButton} title={locale === "en" ? "Insert citation at cursor" : "커서에 인용 삽입"}>
                    {formatInline(ref, citationStyle, references)}
                  </button>
                  <button type="button" onClick={() => deleteReference(ref.id)} style={miniIconButton} title={locale === "en" ? "Delete" : "삭제"} aria-label="delete">
                    <IconTrash size={13} />
                  </button>
                </div>
              </div>
            ))}

            {editingRef && (
              <ReferenceForm
                key={editingRef.id}
                value={editingRef}
                locale={locale}
                onSave={upsertReference}
                onCancel={() => setEditingRef(null)}
              />
            )}
          </aside>
        ) : (
          <CollapsedRail side="left" label={locale === "en" ? "Sources" : "소스"} onExpand={() => setLeftOpen(true)} ariaLabel="expand sources" />
        )}

        <section style={editorStage}>
          <div style={paper}>
            <textarea
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              rows={2}
              style={titleInput}
              placeholder={locale === "en" ? "Title appears after you generate" : "생성하면 제목이 채워집니다"}
              aria-label={locale === "en" ? "Document title" : "문서 제목"}
            />
            <div style={docMeta}>
              <span>{wordCount} {locale === "en" ? "words" : "단어"}</span>
              <span>{readingMin} {locale === "en" ? "min read" : "분 읽기"}</span>
              <span>{sectionCount} {locale === "en" ? "sections" : "섹션"}</span>
              <span>{citationStyle}</span>
              {generatedAt ? <span>{genEngine ? `${genEngine} · ` : ""}{generatedAt}</span> : null}
              {draftPersistence ? (
                <span
                  role="status"
                  aria-live="polite"
                  data-testid="document-draft-save-status"
                  data-state={draftPersistence.state}
                  style={{
                    ...draftPersistenceStatus,
                    color:
                      draftPersistence.state === "failed"
                        ? "var(--danger)"
                        : draftPersistence.state === "degraded"
                          ? "var(--warn)"
                          : draftPersistence.state === "saved"
                            ? "var(--green-deep)"
                            : "var(--muted-deep)",
                  }}
                >
                  {draftPersistence.text}
                </span>
              ) : null}
            </div>

            {/* AI 편집 툴바 — 선택 텍스트(없으면 전체)를 개정 */}
            <div style={editToolbar}>
              <span style={editToolbarLabel}>{locale === "en" ? "AI edit" : "AI 편집"}</span>
              {REVISE_ACTIONS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onMouseDown={rememberSelection}
                  onClick={() => revise(a.id)}
                  disabled={Boolean(revising)}
                  style={{ ...editToolbarBtn, opacity: revising && revising !== a.id ? 0.4 : 1 }}
                >
                  {revising === a.id ? "…" : locale === "en" ? a.en : a.ko}
                </button>
              ))}
            </div>

            {statusMsg && (
              <div style={{ ...statusBar, color: statusMsg.kind === "error" ? "var(--danger)" : statusMsg.kind === "ok" ? "var(--green-deep)" : "var(--muted-deep)" }}>
                {statusMsg.text}
              </div>
            )}

            <textarea
              ref={editorRef}
              value={documentText}
              onChange={(e) => setDocumentText(e.target.value)}
              onSelect={rememberSelection}
              onKeyUp={rememberSelection}
              onMouseUp={rememberSelection}
              readOnly={Boolean(revising)}
              style={editor}
              placeholder={
                locale === "en"
                  ? "Enter a goal above and click Generate. Requires a connected AI runtime (agy/codex) — no template fallback. Select text and use AI edit to expand/rewrite/shorten."
                  : "위에 목표를 입력하고 생성을 누르세요. 연결된 AI 런타임(agy/codex)이 필요합니다 — 템플릿 폴백 없음. 텍스트를 선택하고 AI 편집으로 확장/재작성/축약하세요."
              }
              aria-label={locale === "en" ? "Document editor" : "문서 편집기"}
            />
          </div>
        </section>

        {rightOpen ? (
          <aside style={inspector}>
            <div style={railHeader}>
              <span style={railTitle}>{bibliography ? bibTitleFromMarkdown(bibliography) : locale === "en" ? "References" : "참고문헌"}</span>
              <button type="button" onClick={() => setRightOpen(false)} style={collapseButton} title={locale === "en" ? "Collapse" : "접기"} aria-label="collapse">
                <IconChevronRight size={14} />
              </button>
            </div>
            {references.length === 0 ? (
              <p style={emptyHint}>{locale === "en" ? "Your bibliography renders here in real time as you add sources." : "소스를 추가하면 여기에 참고문헌이 실시간으로 표시됩니다."}</p>
            ) : (
              <div style={bibPreview}>
                {references.map((ref) => (
                  <p key={ref.id} style={bibEntry} dangerouslySetInnerHTML={{ __html: mdInline(formatReference(ref, citationStyle)) }} />
                ))}
              </div>
            )}
            <div style={railHeader}>
              <span style={railTitle}>{locale === "en" ? "Figure" : "도표"}</span>
              <button
                type="button"
                onClick={generateFigure}
                disabled={figureBusy}
                style={{ ...miniButton, flex: "none", opacity: figureBusy ? 0.6 : 1 }}
                title={locale === "en" ? "Generate figure image from the note" : "메모로 도표 이미지 생성"}
              >
                <IconImage size={12} style={{ marginRight: 4, verticalAlign: "-1px" }} />
                {figureBusy ? (locale === "en" ? "…" : "…") : locale === "en" ? "Render" : "생성"}
              </button>
            </div>
            {figureSrc ? (
              <img src={figureSrc} alt={figureCaption} style={figureImg} />
            ) : null}
            <textarea
              value={figureCaption}
              onChange={(e) => setFigureCaption(e.target.value)}
              rows={4}
              style={figureInput}
              placeholder={locale === "en" ? "Describe a figure — then Render it into an image." : "도표를 묘사한 뒤 생성으로 이미지를 만드세요."}
              aria-label={locale === "en" ? "Figure note" : "도표 메모"}
            />
          </aside>
        ) : (
          <CollapsedRail side="right" label={locale === "en" ? "References" : "참고문헌"} onExpand={() => setRightOpen(true)} ariaLabel="expand references" />
        )}
      </main>
    </div>
  );
}

// ─────────────────────────── 참고문헌 입력 폼 ───────────────────────────

function ReferenceForm({ value, locale, onSave, onCancel }: { value: Reference; locale: "ko" | "en"; onSave: (r: Reference) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Reference>(value);
  const [authorsText, setAuthorsText] = useState(value.authors.join("; "));
  const set = (patch: Partial<Reference>) => setDraft((d) => ({ ...d, ...patch }));
  const field = (label: string, key: keyof Reference, placeholder?: string) => (
    <label style={formField}>
      <span style={formLabel}>{label}</span>
      <input value={(draft[key] as string) || ""} onChange={(e) => set({ [key]: e.target.value } as Partial<Reference>)} placeholder={placeholder} style={formInput} />
    </label>
  );
  return (
    <div style={refForm}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={formLabel}>{locale === "en" ? "Source" : "소스"}</span>
        <button type="button" onClick={onCancel} style={miniIconButton} aria-label="close">
          <IconClose size={13} />
        </button>
      </div>
      <label style={formField}>
        <span style={formLabel}>{locale === "en" ? "Type" : "유형"}</span>
        <select value={draft.type} onChange={(e) => set({ type: e.target.value as ReferenceType })} style={formInput}>
          {REF_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {locale === "en" ? t.en : t.ko}
            </option>
          ))}
        </select>
      </label>
      <label style={formField}>
        <span style={formLabel}>{locale === "en" ? "Authors (separate with ;)" : "저자 (; 로 구분)"}</span>
        <input value={authorsText} onChange={(e) => setAuthorsText(e.target.value)} placeholder="Smith, John; Doe, Jane" style={formInput} />
      </label>
      {field(locale === "en" ? "Title" : "제목", "title")}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {field(locale === "en" ? "Year" : "연도", "year", "2025")}
        {field(locale === "en" ? "Container / journal / site" : "저널/사이트", "container")}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
        {field(locale === "en" ? "Vol" : "권", "volume")}
        {field(locale === "en" ? "Issue" : "호", "issue")}
        {field(locale === "en" ? "Pages" : "쪽", "pages")}
      </div>
      {field(locale === "en" ? "Publisher" : "출판사", "publisher")}
      {field("DOI", "doi", "10.1000/xyz")}
      {field("URL", "url", "https://…")}
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button
          type="button"
          onClick={() => onSave({ ...draft, authors: authorsText.split(";").map((a) => a.trim()).filter(Boolean) })}
          style={formSaveBtn}
        >
          {locale === "en" ? "Save source" : "소스 저장"}
        </button>
        <button type="button" onClick={onCancel} style={formCancelBtn}>
          {locale === "en" ? "Cancel" : "취소"}
        </button>
      </div>
    </div>
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

// ─────────────────────────── 헬퍼 ───────────────────────────

function fileSlug(value: string) {
  const slug = value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return slug || "agentlas-document";
}

function labelForMode(mode: Mode, locale: "ko" | "en") {
  if (locale === "en") return mode === "paper" ? "Paper" : mode === "brief" ? "Brief" : "Report";
  return mode === "paper" ? "논문" : mode === "brief" ? "브리프" : "리포트";
}

function draftPersistenceCopy(
  saving: boolean,
  result: DocumentDraftSaveResult | null,
  locale: "ko" | "en",
): { state: "saving" | "saved" | "degraded" | "failed"; text: string } | null {
  if (saving) {
    return { state: "saving", text: locale === "en" ? "Saving locally…" : "로컬 저장 중…" };
  }
  if (!result || result.status === "cleared") return null;
  if (result.status === "failed") {
    return {
      state: "failed",
      text:
        locale === "en"
          ? "Local save failed · Current changes may not survive a restart"
          : "로컬 저장 실패 · 현재 변경은 재시작 후 복원되지 않을 수 있습니다",
    };
  }
  if (result.status === "saved-without-figure") {
    const sizeReason = result.figurePersistence === "omitted-size";
    return {
      state: "degraded",
      text:
        locale === "en"
          ? `Title and text saved · Figure ${sizeReason ? "exceeded the local size limit" : "could not fit in local storage"} and will not be restored after restart`
          : `본문·제목 저장됨 · 도표 이미지가 ${sizeReason ? "로컬 크기 한도를 넘어" : "로컬 저장 공간에 들어가지 않아"} 재시작 후 복원되지 않습니다`,
    };
  }
  return {
    state: "saved",
    text:
      locale === "en"
        ? result.figurePersistence === "stored"
          ? "Draft and figure saved locally"
          : "Draft saved locally"
        : result.figurePersistence === "stored"
          ? "초안과 도표 로컬 저장됨"
          : "초안 로컬 저장됨",
  };
}

function bibTitleFromMarkdown(md: string): string {
  const m = md.match(/^##\s+(.*)$/m);
  return m ? m[1] : "References";
}

// markdown 인라인(**bold**, *italic*, [text](url))만 HTML로 — 미리보기/HTML 내보내기용.
function mdInline(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // URL 스킴 화이트리스트 + 따옴표 이스케이프 — javascript: 주입·속성 탈출 차단(자기 XSS 방지).
    .replace(/\[(.+?)\]\((.+?)\)/g, (_m, text, url) => {
      const safe = /^(https?:|mailto:)/i.test(url) ? url.replace(/"/g, "%22") : "#";
      return `<a href="${safe}">${text}</a>`;
    });
}

// 최소 markdown → HTML(제목/목록/문단/인라인). HTML 내보내기 전용.
function mdToHtml(md: string): string {
  const lines = md.split("\n");
  let html = "";
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${mdInline(li[1])}</li>`;
      continue;
    }
    if (inList) {
      html += "</ul>";
      inList = false;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      html += `<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`;
      continue;
    }
    if (line === "") continue;
    html += `<p>${mdInline(line)}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}

// 내려받는 독립 HTML 문서다 — 앱의 토큰 블록이 따라가지 않으므로 색을 값으로 적는다.
/* colour-literal-allowed: standalone exported document, app tokens are not present there */
function buildHtmlDoc(title: string, body: string, refs: Reference[], style: CitationStyle, bibliographyMd: string, figureMd: string, figureSrc: string): string {
  const bodyHtml = mdToHtml(body);
  // 도표: 생성 이미지(data URI, 스킴 검증) + 캡션. 이미지가 없으면 캡션만.
  const safeImg = figureSrc && /^data:image\//i.test(figureSrc) ? `<img src="${figureSrc.replace(/"/g, "%22")}" alt="figure" style="max-width:100%;border-radius:8px;border:1px solid #eceef2" />` : ""; /* colour-literal-allowed: exported document */
  const figHtml = figureMd || safeImg ? `<figure style="margin:24px 0">${safeImg}${figureMd ? mdToHtml(figureMd) : ""}</figure>` : "";
  const bibHtml = refs.length ? mdToHtml(bibliographyMd) : "";
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${mdInline(title)}</title>
<style>
  body{max-width:760px;margin:48px auto;padding:0 24px;font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;color:#1a1d23} /* colour-literal-allowed: exported document */
  h1{font-size:30px;line-height:1.2;margin:0 0 24px}
  h2{font-size:21px;margin:32px 0 10px;border-bottom:1px solid #eceef2;padding-bottom:6px} /* colour-literal-allowed: exported document */
  h3{font-size:17px;margin:22px 0 8px}
  p{margin:0 0 14px}
  ul{margin:0 0 14px 22px}
  a{color:#2563eb} /* colour-literal-allowed: exported document */
  .cite-style{color:#8a90a0;font-size:13px;margin-bottom:28px} /* colour-literal-allowed: exported document */
</style></head><body>
<h1>${mdInline(title)}</h1>
<div class="cite-style">Citation style: ${style}</div>
${bodyHtml}
${figHtml}
${bibHtml}
</body></html>`;
}

const RESPONSIVE_CSS = `
  @media (max-width: 900px) {
    .document-studio-toolbar { padding-left: 16px !important; flex-wrap: wrap; min-height: auto !important; }
    .document-studio-ai-toolbar { flex-wrap: wrap; min-height: auto !important; }
    .document-studio-goal { min-width: min(100%, 220px) !important; flex-basis: 100%; }
    .document-studio-workspace { grid-template-columns: 1fr !important; overflow: auto !important; }
    .document-studio-workspace > aside { min-height: 160px; max-height: 320px; border-right: none !important; border-bottom: 1px solid var(--paper-edge); }
  }
`;

const shell: CSSProperties = { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--paper-edge)", color: "var(--ink)" };
const topToolbar: CSSProperties = { minHeight: 42, borderBottom: "1px solid var(--paper-edge)", background: "var(--paper)", display: "flex", alignItems: "center", gap: 6, padding: "6px 16px 6px 90px", flexShrink: 0 };
const backLink: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, color: "var(--accent)", fontWeight: 800, fontSize: 12, textDecoration: "none" };
const newDocumentButton: CSSProperties = { minHeight: 30, border: "1px solid var(--paper-edge)", borderRadius: 7, background: "var(--paper)", color: "var(--ink-soft)", display: "inline-flex", alignItems: "center", gap: 5, padding: "0 9px", fontSize: 11.5, fontWeight: 800, cursor: "pointer" };
const citationButton: CSSProperties = { height: 32, minWidth: 84, border: "1px solid var(--paper-edge)", borderRadius: 999, background: "var(--paper)", display: "inline-flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "0 12px", color: "var(--ink)", fontWeight: 800 };
const citationMenu: CSSProperties = { position: "absolute", top: 38, right: 0, width: 200, maxHeight: 360, border: "1px solid var(--paper-3)", borderRadius: 8, background: "var(--paper)", boxShadow: "0 18px 48px rgba(15,23,42,.16)", padding: 8, zIndex: 20 };
const citationList: CSSProperties = { display: "grid", gap: 1, maxHeight: 320, overflowY: "auto" };
const citationOption: CSSProperties = { minHeight: 32, border: "none", background: "transparent", color: "var(--ink)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "0 8px", borderRadius: 6, textAlign: "left", fontSize: 13, cursor: "pointer" };
const exportButton: CSSProperties = { height: 32, border: "none", borderRadius: 7, background: "var(--ok)", color: "var(--white)", display: "inline-flex", alignItems: "center", gap: 6, padding: "0 12px", fontWeight: 900, cursor: "pointer" };
const exportStatusStyle: CSSProperties = { color: "var(--green-deep)", fontSize: 11.5, fontWeight: 800, whiteSpace: "nowrap" };
const aiToolbar: CSSProperties = { minHeight: 42, borderBottom: "1px solid var(--paper-edge)", background: "var(--paper)", display: "flex", alignItems: "center", gap: 10, padding: "6px 18px", flexShrink: 0 };
const aiBadge: CSSProperties = { minWidth: 26, height: 22, borderRadius: 7, background: "var(--warn-soft)", color: "var(--warn)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 900 };
const goalBox: CSSProperties = { minWidth: 280, flex: 1, height: 30, border: "1px solid var(--paper-edge)", borderRadius: 7, background: "var(--paper)", display: "flex", alignItems: "center", gap: 8, padding: "0 9px" };
const goalInput: CSSProperties = { minWidth: 0, flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--ink)", fontSize: 12.5 };
const modeChip: CSSProperties = { border: "none", borderRadius: 999, padding: "6px 9px", fontSize: 11.5, fontWeight: 900, cursor: "pointer" };
const generateButton: CSSProperties = { minHeight: 30, border: "1px solid var(--accent-soft)", borderRadius: 7, background: "var(--fill-1)", color: "var(--accent)", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "0 10px", fontSize: 12, fontWeight: 900 };
const workspace: CSSProperties = { flex: 1, minHeight: 0, display: "grid", overflow: "hidden" };
const sourceRail: CSSProperties = { borderRight: "1px solid var(--paper-edge)", background: "var(--paper)", padding: 14, overflowY: "auto", display: "grid", alignContent: "start", gap: 10 };
const railTitle: CSSProperties = { color: "var(--muted-deep)", fontSize: 11, fontWeight: 900, textTransform: "uppercase", letterSpacing: ".06em" };
const railHeader: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
const collapseButton: CSSProperties = { width: 24, height: 24, border: "1px solid var(--paper-edge)", borderRadius: 6, background: "var(--paper)", color: "var(--muted-deep)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 };
const emptyHint: CSSProperties = { color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.55, margin: 0 };
const collapsedRail: CSSProperties = { borderRight: "1px solid var(--paper-edge)", borderLeft: "1px solid var(--paper-edge)", background: "var(--paper)", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "12px 0", overflow: "hidden" };
const expandButton: CSSProperties = { width: 26, height: 26, border: "1px solid var(--paper-edge)", borderRadius: 6, background: "var(--paper)", color: "var(--ink-soft)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 };
const collapsedLabel: CSSProperties = { writingMode: "vertical-rl", transform: "rotate(180deg)", color: "var(--muted-deep)", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".08em", whiteSpace: "nowrap" };
const sourceCard: CSSProperties = { border: "1px solid var(--paper-edge)", borderRadius: 8, padding: 10, display: "grid", gap: 7, background: "var(--paper)" };
const sourceCardMain: CSSProperties = { border: "none", background: "transparent", display: "grid", gap: 3, textAlign: "left", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.4, cursor: "pointer", padding: 0 };
const miniButton: CSSProperties = { border: "1px solid var(--accent-soft)", background: "var(--fill-1)", color: "var(--accent)", borderRadius: 6, padding: "3px 7px", fontSize: 11, fontWeight: 800, cursor: "pointer", flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const miniIconButton: CSSProperties = { width: 26, border: "1px solid var(--paper-edge)", background: "var(--paper)", color: "var(--muted-deep)", borderRadius: 6, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" };
const refForm: CSSProperties = { border: "1px solid var(--accent-soft)", borderRadius: 8, padding: 11, display: "grid", gap: 7, background: "var(--paper)" };
const formField: CSSProperties = { display: "grid", gap: 3 };
const formLabel: CSSProperties = { color: "var(--muted-deep)", fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em" };
const formInput: CSSProperties = { border: "1px solid var(--paper-edge)", borderRadius: 6, padding: "6px 8px", fontSize: 12.5, outline: "none", background: "var(--paper)", color: "var(--ink)", width: "100%" };
const formSaveBtn: CSSProperties = { flex: 1, border: "none", borderRadius: 6, background: "var(--ok)", color: "var(--white)", padding: "7px 0", fontWeight: 800, fontSize: 12, cursor: "pointer" };
const formCancelBtn: CSSProperties = { border: "1px solid var(--paper-edge)", borderRadius: 6, background: "var(--paper)", color: "var(--ink-soft)", padding: "7px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" };
const editorStage: CSSProperties = { minWidth: 0, minHeight: 0, overflowY: "auto", padding: "40px 40px 64px" };
const paper: CSSProperties = { width: "min(760px, 100%)", minHeight: "calc(100vh - 220px)", margin: "0 auto", background: "var(--paper)", border: "1px solid var(--paper-edge)", boxShadow: "0 20px 70px rgba(15,23,42,.08)", padding: "48px 60px" };
const titleInput: CSSProperties = { width: "100%", border: "none", outline: "none", background: "transparent", resize: "none", overflow: "hidden", color: "var(--ink)", fontFamily: "var(--font-head)", fontSize: 26, lineHeight: 1.2, fontWeight: 900 };
const docMeta: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, color: "var(--muted-deep)", fontSize: 11.5, marginTop: 8 };
const draftPersistenceStatus: CSSProperties = { fontWeight: 800, lineHeight: 1.4 };
const editToolbar: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 16, marginBottom: 8, paddingBottom: 12, borderBottom: "1px solid var(--paper-edge)" };
const editToolbarLabel: CSSProperties = { color: "var(--warn)", background: "var(--warn-soft)", borderRadius: 6, padding: "3px 7px", fontSize: 10.5, fontWeight: 900 };
const editToolbarBtn: CSSProperties = { border: "1px solid var(--paper-edge)", background: "var(--paper)", color: "var(--ink-soft)", borderRadius: 999, padding: "5px 11px", fontSize: 12, fontWeight: 800, cursor: "pointer" };
const statusBar: CSSProperties = { fontSize: 12, fontWeight: 700, marginBottom: 12 };
const editor: CSSProperties = { width: "100%", minHeight: 480, border: "none", outline: "none", resize: "vertical", background: "var(--paper)", color: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 15.5, lineHeight: 1.85 };
const inspector: CSSProperties = { borderLeft: "1px solid var(--paper-edge)", background: "var(--paper)", padding: 14, overflowY: "auto", display: "grid", alignContent: "start", gap: 12 };
const bibPreview: CSSProperties = { display: "grid", gap: 10 };
const bibEntry: CSSProperties = { margin: 0, color: "var(--ink-soft)", fontSize: 12, lineHeight: 1.5, paddingLeft: 14, textIndent: -14 };
const figureInput: CSSProperties = { width: "100%", border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper)", padding: 10, resize: "vertical", outline: "none", color: "var(--ink-soft)", fontSize: 12.5, lineHeight: 1.5 };
const figureImg: CSSProperties = { width: "100%", borderRadius: 8, border: "1px solid var(--paper-edge)", display: "block", background: "var(--black)" };
