// T-rex 슬라이드 스튜디오 — 프롬프트 한 줄 → 실시간 생성 → 결과(PDF/편집) → 구조화 편집기.
// 오베론처럼 독립 등록된 스튜디오. 슬라이드 에이전트는 이 안의 엔진으로만 내장(따로 호출 불가).
// docs/DESIGN.md: 토큰만, 강조 1개, 시스템 폰트, inline CSSProperties.
"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import {
  generateDeck,
  buildDeckFromContent,
  parseDeckContent,
  routeMode,
  newBlock,
  clampCount,
  MIN_SLIDES,
  MAX_SLIDES,
  MODE_THEMES,
  FORMATS,
  DEFAULT_FORMAT_ID,
  formatById,
  formatRatio,
  type ArtMode,
  type BlockKind,
  type DeckFormat,
  type FormatGroup,
  type SceneKind,
  type TrexBlock,
  type TrexDeck,
  type TrexSlide,
} from "@/lib/trex/model";
import { IconApps, IconSparkles, IconFileUp, IconEdit, IconChevronRight, IconCheck } from "@/components/Icon";
import { DeckStage, GlobalStyle, bgStyle } from "@/components/trex/DeckStage";

type ViewState = "home" | "generating" | "view" | "edit";
type ImageModel = "codex" | "gemini" | "svg";
const RECENTS_KEY = "trex.recents.v1";
const EXAMPLE = "중견 제조사 디지털 전환 전략 — 진단과 12개월 로드맵";
const EXAMPLE_EN = "Mid-market manufacturer digital transformation — diagnosis and a 12-month roadmap";
const ALL_MODES: ArtMode[] = ["editorial", "cinematic", "diagrammatic", "hybrid"];
const PALETTE: BlockKind[] = ["title", "subtitle", "body", "card", "kicker", "pill", "kpi", "bar", "rule", "footer"];

export default function TrexPage() {
  const { locale } = useT();
  const ko = locale !== "en";
  const [view, setView] = useState<ViewState>("home");
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(5);
  const [formatId, setFormatId] = useState<string>(DEFAULT_FORMAT_ID);
  const [imageModel, setImageModel] = useState<ImageModel>("codex");
  const [providers, setProviders] = useState<{ codex: boolean; gemini: boolean }>({ codex: false, gemini: false });
  const [aiContent, setAiContent] = useState(true);
  const [aiWriting, setAiWriting] = useState(false);
  const [contentEngines, setContentEngines] = useState<{ agy: boolean; codex: boolean }>({ agy: false, codex: false });
  const [modeOverride, setModeOverride] = useState<ArtMode | null>(null);

  useEffect(() => {
    const api = ipc();
    api?.trex?.imageProviders?.().then(setProviders).catch(() => { /* 브라우저/미지원 */ });
    api?.trex?.contentAvailable?.().then((c) => { setContentEngines(c); setAiContent(c.agy || c.codex); }).catch(() => { /* 브라우저/미지원 */ });
  }, []);
  const [deck, setDeck] = useState<TrexDeck | null>(null);
  const [recents, setRecents] = useState<TrexDeck[]>([]);
  const [revealed, setRevealed] = useState(0);
  const [activeSlide, setActiveSlide] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [imagePending, setImagePending] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENTS_KEY);
      if (raw) setRecents(JSON.parse(raw) as TrexDeck[]);
    } catch {
      /* ignore */
    }
  }, []);

  const persistRecents = useCallback((next: TrexDeck[]) => {
    setRecents(next);
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next.slice(0, 24)));
    } catch {
      /* ignore */
    }
  }, []);

  const routedMode = modeOverride ?? routeMode(prompt || EXAMPLE);

  // 생성한 덱을 한 장씩 드러낸다. 시네마틱/하이브리드는 codex/agy 이미지가 있으면 배경 교체.
  const revealDeck = useCallback(
    (d: TrexDeck) => {
      setDeck(d);
      setActiveSlide(0);
      setSelected(null);
      setRevealed(0);
      setView("generating");
      let i = 0;
      const tick = () => {
        i += 1;
        setRevealed(i);
        if (i < d.slides.length) {
          window.setTimeout(tick, 380);
        } else {
          window.setTimeout(() => {
            setView("view");
            persistRecents([d, ...recents.filter((r) => r.id !== d.id)]);
            const gen = ipc()?.trex?.generateImage;
            if (imageModel !== "svg" && gen) {
              setImagePending(new Set(d.slides.filter((s) => s.scene !== "none").map((s) => s.id)));
              void maybeFetchScenes(d, imageModel, (slideId, src) => {
                setDeck((cur) => (cur && cur.id === d.id ? patchSlideBg(cur, slideId, src) : cur));
                setImagePending((prev) => {
                  const nn = new Set(prev);
                  nn.delete(slideId);
                  return nn;
                });
              }).finally(() => setImagePending(new Set()));
            }
          }, 360);
        }
      };
      window.setTimeout(tick, 300);
    },
    [imageModel, persistRecents, recents],
  );

  // 실시간 생성 — AI(agy/codex)가 슬라이드별 실제 내용을 쓰고, 완성되면 렌더. 미가용 시 스캐폴드.
  const runGenerate = useCallback(
    async (text: string, n: number) => {
      const p = text.trim() || (ko ? EXAMPLE : EXAMPLE_EN);
      const gc = ipc()?.trex?.generateContent;
      if (aiContent && gc) {
        setDeck(null);
        setView("generating");
        setAiWriting(true);
        let d: TrexDeck;
        try {
          const r = await gc({ topic: p, count: n, mode: modeOverride ?? undefined });
          const parsed = r?.ok && r.text ? parseDeckContent(r.text) : null;
          d = parsed ? buildDeckFromContent(parsed, formatId, locale) : generateDeck(p, modeOverride ?? undefined, n, formatId, locale);
        } catch {
          d = generateDeck(p, modeOverride ?? undefined, n, formatId, locale);
        }
        setAiWriting(false);
        revealDeck(d);
      } else {
        revealDeck(generateDeck(p, modeOverride ?? undefined, n, formatId, locale));
      }
    },
    [aiContent, modeOverride, formatId, revealDeck, locale],
  );

  const updateDeck = useCallback((updater: (d: TrexDeck) => TrexDeck) => {
    setDeck((cur) => (cur ? updater(cur) : cur));
  }, []);

  const patchBlock = useCallback(
    (slideId: string, blockId: string, patch: Partial<TrexBlock>) => {
      updateDeck((d) => ({
        ...d,
        slides: d.slides.map((s) => (s.id === slideId ? { ...s, blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, ...patch } : b)) } : s)),
      }));
    },
    [updateDeck],
  );

  const removeBlock = useCallback(
    (slideId: string, blockId: string) => {
      updateDeck((d) => ({ ...d, slides: d.slides.map((s) => (s.id === slideId ? { ...s, blocks: s.blocks.filter((b) => b.id !== blockId) } : s)) }));
      setSelected(null);
      setEditingId(null);
    },
    [updateDeck],
  );

  const addBlock = useCallback(
    (kind: BlockKind) => {
      if (!deck) return;
      const slide = deck.slides[activeSlide];
      const b = newBlock(kind, locale);
      updateDeck((d) => ({ ...d, slides: d.slides.map((s) => (s.id === slide.id ? { ...s, blocks: [...s.blocks, b] } : s)) }));
      setSelected(b.id);
    },
    [deck, activeSlide, updateDeck, locale],
  );

  const duplicateBlock = useCallback(() => {
    if (!deck || !selected) return;
    const slide = deck.slides[activeSlide];
    const src = slide.blocks.find((b) => b.id === selected);
    if (!src) return;
    const clone: TrexBlock = { ...src, id: `b_${Date.now().toString(36)}`, x: Math.min(96, src.x + 3), y: Math.min(96, src.y + 3) };
    updateDeck((d) => ({ ...d, slides: d.slides.map((s) => (s.id === slide.id ? { ...s, blocks: [...s.blocks, clone] } : s)) }));
    setSelected(clone.id);
  }, [deck, selected, activeSlide, updateDeck]);

  const addSlide = useCallback(() => {
    if (!deck) return;
    const theme = MODE_THEMES[deck.mode];
    const seedTitle = { ...newBlock("title", locale), x: 7, y: 16, w: 80 };
    const seedBody = { ...newBlock("body", locale), x: 7, y: 46, w: 66, size: 1.6 };
    const blank: TrexSlide = { id: `s_${Date.now().toString(36)}`, bg: theme.bodyBg, ink: theme.ink, scene: "none", blocks: [seedTitle, seedBody] };
    updateDeck((d) => {
      const slides = [...d.slides];
      slides.splice(activeSlide + 1, 0, blank);
      return { ...d, slides };
    });
    setActiveSlide((i) => i + 1);
    setSelected(null);
  }, [deck, activeSlide, updateDeck, locale]);

  const deleteSlide = useCallback(() => {
    if (!deck || deck.slides.length <= 1) return;
    updateDeck((d) => ({ ...d, slides: d.slides.filter((_, i) => i !== activeSlide) }));
    setActiveSlide((i) => Math.max(0, i - 1));
    setSelected(null);
  }, [deck, activeSlide, updateDeck]);

  const exportPdf = useCallback(() => {
    document.body.classList.add("trex-printing");
    window.setTimeout(() => {
      window.print();
      window.setTimeout(() => document.body.classList.remove("trex-printing"), 600);
    }, 60);
  }, []);

  useEffect(() => {
    if (view !== "edit") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      if ((e.key === "Delete" || e.key === "Backspace") && selected && !typing && deck) {
        e.preventDefault();
        removeBlock(deck.slides[activeSlide].id, selected);
      }
      if ((e.key === "d" || e.key === "D") && (e.metaKey || e.ctrlKey) && selected && !typing) {
        e.preventDefault();
        duplicateBlock();
      }
      if (e.key === "Escape") {
        setEditingId(null);
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, selected, deck, activeSlide, removeBlock, duplicateBlock]);

  return (
    <div style={shell}>
      <GlobalStyle />
      {deck && (
        <style
          dangerouslySetInnerHTML={{
            __html: `@media print { @page { size: ${formatById(deck.formatId).w}${formatById(deck.formatId).unit} ${formatById(deck.formatId).h}${formatById(deck.formatId).unit}; margin: 0; } }`,
          }}
        />
      )}
      <header className="titlebar-drag" style={topbar}>
        <Link href="/apps" className="titlebar-nodrag" style={backLink}>
          <IconApps size={15} /> Apps
        </Link>
        <span style={wordmark} className="titlebar-nodrag">
          <span style={{ color: "var(--accent)" }}>T-rex</span> {ko ? "슬라이드 스튜디오" : "Slide Studio"}
        </span>
        {deck && view !== "home" && view !== "generating" && (
          <div className="titlebar-nodrag" style={{ display: "flex", gap: 8, marginLeft: "auto", alignItems: "center" }}>
            <select value={deck.formatId} onChange={(e) => updateDeck((d) => ({ ...d, formatId: e.target.value }))} style={{ ...ghostBtn, padding: "0 8px", cursor: "pointer" }} aria-label={ko ? "캔버스 규격" : "Canvas format"}>
              {(["screen", "social", "print"] as FormatGroup[]).map((g) => (
                <optgroup key={g} label={g === "screen" ? (ko ? "화면" : "Screen") : g === "social" ? (ko ? "소셜" : "Social") : ko ? "인쇄" : "Print"}>
                  {FORMATS.filter((f) => f.group === g).map((f) => (
                    <option key={f.id} value={f.id}>{ko ? f.labelKo : f.labelEn}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button type="button" onClick={() => setView("home")} style={ghostBtn} aria-label={ko ? "새로 만들기" : "New"}>
              {ko ? "새 덱" : "New"}
            </button>
            <button type="button" onClick={exportPdf} style={ghostBtn}>
              <IconFileUp size={13} /> PDF
            </button>
            {view === "view" ? (
              <button type="button" onClick={() => setView("edit")} style={primaryBtn}>
                <IconEdit size={13} /> {ko ? "편집" : "Edit"}
              </button>
            ) : (
              <button type="button" onClick={() => { setView("view"); setSelected(null); setEditingId(null); }} style={primaryBtn}>
                <IconCheck size={13} /> {ko ? "완료" : "Done"}
              </button>
            )}
          </div>
        )}
      </header>

      {view === "home" && (
        <Home
          ko={ko}
          prompt={prompt}
          setPrompt={setPrompt}
          count={count}
          setCount={(n) => setCount(clampCount(n))}
          formatId={formatId}
          setFormatId={setFormatId}
          imageModel={imageModel}
          setImageModel={setImageModel}
          providers={providers}
          aiContent={aiContent}
          setAiContent={setAiContent}
          contentEngines={contentEngines}
          routedMode={routedMode}
          modeOverride={modeOverride}
          setModeOverride={setModeOverride}
          recents={recents}
          onGenerate={() => runGenerate(prompt, count)}
          onOpen={(d) => { setDeck(d); setActiveSlide(0); setView("view"); }}
        />
      )}

      {view === "generating" && aiWriting && !deck && (
        <div style={aiWritingWrap}>
          <span className="trex-spin" style={aiWritingSpinner} />
          <div style={aiWritingText}>{ko ? "AI가 슬라이드 내용을 작성 중…" : "AI is writing your slides…"}</div>
          <div style={aiWritingSub}>{ko ? "실제 카피와 수치를 구성하고 있어요 · 10–30초" : "Composing real copy & figures · 10–30s"}</div>
        </div>
      )}

      {(view === "generating" || view === "view") && deck && (
        <div style={scrollStage}>
          <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", gap: 22 }}>
            {view === "generating" && (
              <div style={genHint}>
                <span className="trex-spin" style={spinner} /> {ko ? "T-rex가 만드는 중" : "T-rex is building"} · {MODE_THEMES[deck.mode][ko ? "labelKo" : "labelEn"]} · {deck.slides.length}{ko ? "장" : ""}
              </div>
            )}
            {deck.slides.map((s, i) => (
              <div
                key={s.id}
                className="trex-print-slide"
                style={{ opacity: view === "generating" && i >= revealed ? 0.1 : 1, transform: view === "generating" && i >= revealed ? "translateY(10px)" : "none", transition: "opacity .4s, transform .4s" }}
              >
                <DeckStage slide={s} accent={deck.accent} editable={false} ratio={formatRatio(formatById(deck.formatId))} pending={imagePending.has(s.id)} pendingLabel={imageModel === "gemini" ? (ko ? "나노바나나 이미지 생성 중" : "Generating nano-banana image") : ko ? "이미지 생성 중" : "Generating image"} />
              </div>
            ))}
          </div>
        </div>
      )}

      {view === "edit" && deck && (
        <Editor
          deck={deck}
          activeSlide={Math.min(activeSlide, deck.slides.length - 1)}
          setActiveSlide={(i) => { setActiveSlide(i); setSelected(null); setEditingId(null); }}
          selected={selected}
          setSelected={setSelected}
          editingId={editingId}
          setEditingId={setEditingId}
          patchBlock={patchBlock}
          removeBlock={removeBlock}
          addBlock={addBlock}
          duplicateBlock={duplicateBlock}
          addSlide={addSlide}
          deleteSlide={deleteSlide}
          ko={ko}
        />
      )}
    </div>
  );
}

/* ─────────────── codex image_gen 시드(선택) ─────────────── */
function scenePrompt(kind: SceneKind, deckTitle: string): string | null {
  if (kind === "dusk") return `Cinematic dusk landscape for "${deckTitle}", glowing amber-indigo sky, layered silhouettes, painterly, no text, open negative space on the left.`;
  if (kind === "impact") return `Dramatic dark night sky with a fiery streak and horizon glow for "${deckTitle}", cinematic, no text, dark upper-left negative space.`;
  if (kind === "field" || kind === "pitch") return `Cinematic night stadium under floodlights for "${deckTitle}", deep green pitch, moody, no text, darker top for negative space.`;
  return null;
}

async function maybeFetchScenes(deck: TrexDeck, model: "codex" | "gemini", onImage: (slideId: string, src: string) => void): Promise<void> {
  const gen = ipc()?.trex?.generateImage;
  if (!gen) return; // 브라우저/미지원 — SVG 씬으로 폴백(렌더러가 그림)
  for (const s of deck.slides) {
    const p = scenePrompt(s.scene, deck.title);
    if (!p) continue;
    try {
      const r = await gen({ model, prompt: p });
      if (r?.ok && r.src) onImage(s.id, r.src);
    } catch {
      /* keep SVG fallback */
    }
  }
}

function patchSlideBg(deck: TrexDeck, slideId: string, src: string): TrexDeck {
  return { ...deck, slides: deck.slides.map((s) => (s.id === slideId ? { ...s, bg: { kind: "image", src }, scene: "none" } : s)) };
}

/* ─────────────── 랜딩 ─────────────── */
function Home({
  ko, prompt, setPrompt, count, setCount, formatId, setFormatId, imageModel, setImageModel, providers, aiContent, setAiContent, contentEngines, routedMode, modeOverride, setModeOverride, recents, onGenerate, onOpen,
}: {
  ko: boolean; prompt: string; setPrompt: (v: string) => void; count: number; setCount: (n: number) => void;
  formatId: string; setFormatId: (id: string) => void;
  imageModel: ImageModel; setImageModel: (m: ImageModel) => void; providers: { codex: boolean; gemini: boolean };
  aiContent: boolean; setAiContent: (v: boolean) => void; contentEngines: { agy: boolean; codex: boolean };
  routedMode: ArtMode; modeOverride: ArtMode | null; setModeOverride: (m: ArtMode | null) => void;
  recents: TrexDeck[]; onGenerate: () => void; onOpen: (d: TrexDeck) => void;
}) {
  return (
    <div style={homeWrap}>
      <div style={homeInner}>
        <div style={eyebrow}>T-REX · SLIDE STUDIO</div>
        <h1 style={homeTitle}>{ko ? "무엇을 발표할까요?" : "What are you presenting?"}</h1>
        <p style={homeSub}>{ko ? "한 줄로 적고 엔터하면, 목적에 맞춰 실시간으로 덱을 만듭니다." : "Type one line and hit enter — a deck builds itself, art-directed to your purpose."}</p>

        <div style={promptBox}>
          <IconSparkles size={16} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 3 }} />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onGenerate(); } }}
            placeholder={ko ? `예: ${EXAMPLE}` : `e.g. ${EXAMPLE_EN}`}
            rows={2}
            style={promptInput}
            aria-label={ko ? "발표 주제" : "Deck prompt"}
          />
          <button type="button" onClick={onGenerate} style={genBtn} aria-label={ko ? "생성" : "Generate"}>
            <IconChevronRight size={18} />
          </button>
        </div>

        <div style={controlRow}>
          {/* 장 수 지정 */}
          <div style={stepper} aria-label={ko ? "슬라이드 장 수" : "Slide count"}>
            <button type="button" onClick={() => setCount(count - 1)} disabled={count <= MIN_SLIDES} style={stepBtn(count <= MIN_SLIDES)} aria-label={ko ? "한 장 줄이기" : "Fewer"}>－</button>
            <span style={stepValue}>{count}{ko ? "장" : ""}</span>
            <button type="button" onClick={() => setCount(count + 1)} disabled={count >= MAX_SLIDES} style={stepBtn(count >= MAX_SLIDES)} aria-label={ko ? "한 장 늘리기" : "More"}>＋</button>
          </div>
          <span style={dividerDot} />
          <span style={{ fontSize: 11.5, color: "var(--muted-deep)", fontWeight: 700 }}>{ko ? "규격" : "Size"}</span>
          <select value={formatId} onChange={(e) => setFormatId(e.target.value)} style={imageSelect} aria-label={ko ? "캔버스 규격" : "Canvas format"}>
            {(["screen", "social", "print"] as FormatGroup[]).map((g) => (
              <optgroup key={g} label={g === "screen" ? (ko ? "화면" : "Screen") : g === "social" ? (ko ? "소셜·마케팅" : "Social") : ko ? "인쇄" : "Print"}>
                {FORMATS.filter((f) => f.group === g).map((f) => (
                  <option key={f.id} value={f.id}>
                    {(ko ? f.labelKo : f.labelEn)} · {f.w}×{f.h}
                    {f.unit === "mm" ? "mm" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span style={dividerDot} />
          <span style={{ fontSize: 11.5, color: "var(--muted-deep)", fontWeight: 700 }}>{ko ? "아트디렉션" : "Art"}</span>
          <button type="button" onClick={() => setModeOverride(null)} style={modeChip(modeOverride === null)}>
            {ko ? "자동" : "Auto"}<span style={{ opacity: 0.6, marginLeft: 4 }}>· {MODE_THEMES[routedMode][ko ? "labelKo" : "labelEn"]}</span>
          </button>
          {ALL_MODES.map((m) => (
            <button key={m} type="button" onClick={() => setModeOverride(m)} style={modeChip(modeOverride === m)}>{MODE_THEMES[m][ko ? "labelKo" : "labelEn"]}</button>
          ))}
        </div>

        <div style={controlRow}>
          {(contentEngines.agy || contentEngines.codex) && (
            <>
              <button type="button" onClick={() => setAiContent(!aiContent)} style={modeChip(aiContent)} title={ko ? "AI가 슬라이드별 실제 내용을 작성" : "AI writes real per-slide content"}>
                ✦ {ko ? "AI 내용 작성" : "AI content"} {aiContent ? "✓" : "○"}
              </button>
              <span style={dividerDot} />
            </>
          )}
          <span style={{ fontSize: 11.5, color: "var(--muted-deep)", fontWeight: 700 }}>{ko ? "이미지 모델" : "Image model"}</span>
          <select value={imageModel} onChange={(e) => setImageModel(e.target.value as ImageModel)} style={imageSelect} aria-label={ko ? "이미지 모델" : "Image model"}>
            <option value="codex">Codex image_gen{providers.codex ? "" : ko ? " · CLI 필요" : " · needs CLI"}</option>
            <option value="gemini" disabled={!providers.gemini}>Antigravity 나노바나나{providers.gemini ? "" : ko ? " · 연결 필요" : " · connect Antigravity"}</option>
            <option value="svg">{ko ? "오프라인 SVG (생성 안 함)" : "Offline SVG"}</option>
          </select>
          <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
            {imageModel === "svg"
              ? ko ? "AI 이미지 없이 벡터 배경" : "Vector backgrounds, no AI image"
              : ko ? "생성 직후 배경을 실제 이미지로 채웁니다" : "Backgrounds fill with real images after generation"}
          </span>
        </div>

        {recents.length > 0 && (
          <div style={{ width: "100%", marginTop: 30 }}>
            <div style={recentsHead}>{ko ? "최근 작업" : "Recent"}</div>
            <div style={recentsGrid}>
              {recents.slice(0, 8).map((d) => (
                <button key={d.id} type="button" onClick={() => onOpen(d)} className="trex-recent" style={recentCard}>
                  <span style={{ ...recentThumb, aspectRatio: formatRatio(formatById(d.formatId)), ...bgStyle(d.slides[0]?.bg, d.accent) }}>
                    <span style={recentMode}>{MODE_THEMES[d.mode][ko ? "labelKo" : "labelEn"]} · {d.slides.length}</span>
                  </span>
                  <span style={recentTitle}>{d.title}</span>
                  <span style={recentMeta}>{new Date(d.createdAt).toLocaleDateString(ko ? "ko-KR" : "en-US")}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────── 편집기 ─────────────── */
function Editor({
  deck, activeSlide, setActiveSlide, selected, setSelected, editingId, setEditingId, patchBlock, removeBlock, addBlock, duplicateBlock, addSlide, deleteSlide, ko,
}: {
  deck: TrexDeck; activeSlide: number; setActiveSlide: (i: number) => void;
  selected: string | null; setSelected: (id: string | null) => void;
  editingId: string | null; setEditingId: (id: string | null) => void;
  patchBlock: (slideId: string, blockId: string, patch: Partial<TrexBlock>) => void;
  removeBlock: (slideId: string, blockId: string) => void;
  addBlock: (kind: BlockKind) => void; duplicateBlock: () => void; addSlide: () => void; deleteSlide: () => void; ko: boolean;
}) {
  const slide = deck.slides[activeSlide];
  const selBlock = selected ? slide.blocks.find((b) => b.id === selected) ?? null : null;

  const onDrag = (id: string, dx: number, dy: number, mode: "move" | "resize") => {
    const b = slide.blocks.find((x) => x.id === id);
    if (!b) return;
    if (mode === "move") patchBlock(slide.id, id, { x: clamp(b.x + dx, -4, 99), y: clamp(b.y + dy, -4, 98) });
    else patchBlock(slide.id, id, { w: clamp(b.w + dx, 6, 100) });
  };
  const onText = (id: string, field: "text" | "value" | "label", v: string) => patchBlock(slide.id, id, { [field]: v } as Partial<TrexBlock>);
  const bumpSize = (d: number) => selBlock && patchBlock(slide.id, selBlock.id, { size: Math.max(0.6, Math.round(((selBlock.size ?? 2) + d) * 10) / 10) });

  return (
    <div style={editorShell}>
      <aside style={slideRail}>
        <div style={railHeadRow}>
          <span style={railLabel}>{ko ? "슬라이드" : "Slides"}</span>
          <button type="button" onClick={addSlide} style={miniBtn} title={ko ? "슬라이드 추가" : "Add slide"}>＋</button>
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {deck.slides.map((s, i) => (
            <button key={s.id} type="button" onClick={() => setActiveSlide(i)} style={{ ...thumbBtn, aspectRatio: formatRatio(formatById(deck.formatId)), borderColor: i === activeSlide ? deck.accent : "var(--paper-edge)" }}>
              <span style={{ ...thumbInner, ...bgStyle(s.bg, deck.accent) }} />
              <span style={thumbNo}>{i + 1}</span>
            </button>
          ))}
        </div>
        {deck.slides.length > 1 && <button type="button" onClick={deleteSlide} style={delSlideBtn}>{ko ? "현재 슬라이드 삭제" : "Delete slide"}</button>}
      </aside>

      <section style={canvasWrap} onPointerDown={() => { setSelected(null); setEditingId(null); }}>
        <div style={{ width: "min(880px, 100%)" }} onPointerDown={(e) => e.stopPropagation()}>
          <DeckStage
            slide={slide}
            accent={deck.accent}
            editable
            ratio={formatRatio(formatById(deck.formatId))}
            selectedId={selected}
            editingId={editingId}
            onSelect={(id) => { setSelected(id || null); if (!id) setEditingId(null); }}
            onStartEdit={(id) => { setSelected(id); setEditingId(id); }}
            onDrag={onDrag}
            onText={onText}
          />
          <div style={canvasHint}>{ko ? "클릭=선택 · 끌기=이동 · 모서리=크기 · 더블클릭=텍스트 편집 · Delete=삭제" : "Click=select · drag=move · corner=resize · double-click=edit · Delete=remove"}</div>
        </div>
      </section>

      <aside style={paletteRail} onPointerDown={(e) => e.stopPropagation()}>
        {selBlock ? (
          <div style={{ marginBottom: 18 }}>
            <span style={railLabel}>{ko ? "선택한 블록" : "Selected"}</span>
            <div style={selName}>{blockLabel(selBlock.kind, ko)}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
              <button type="button" onClick={() => bumpSize(-0.3)} style={ctrlBtn}>A−</button>
              <span style={{ fontSize: 11.5, color: "var(--muted-deep)", fontWeight: 700, minWidth: 38, textAlign: "center" }}>{(selBlock.size ?? 2).toFixed(1)}</span>
              <button type="button" onClick={() => bumpSize(0.3)} style={ctrlBtn}>A＋</button>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              {(["left", "center", "right"] as const).map((a) => {
                const on = (selBlock.align ?? "left") === a;
                return (
                  <button key={a} type="button" onClick={() => patchBlock(slide.id, selBlock.id, { align: a })} style={{ ...ctrlBtn, background: on ? "var(--fill-1)" : "var(--paper)", color: on ? "var(--accent)" : "var(--ink)" }} aria-label={a} title={a}>
                    {a === "left" ? "⇤" : a === "center" ? "≡" : "⇥"}
                  </button>
                );
              })}
            </div>
            <button type="button" onClick={() => patchBlock(slide.id, selBlock.id, { accent: !selBlock.accent })} style={{ ...ctrlWide, marginTop: 8, color: selBlock.accent ? deck.accent : "var(--ink-soft)" }}>
              {ko ? "강조 색" : "Accent"} {selBlock.accent ? "●" : "○"}
            </button>
            <button type="button" onClick={duplicateBlock} style={{ ...ctrlWide, marginTop: 8 }}>{ko ? "블록 복제 (⌘D)" : "Duplicate (⌘D)"}</button>
            <button type="button" onClick={() => removeBlock(slide.id, selBlock.id)} style={{ ...ctrlWide, marginTop: 8, color: "#C0202A" }}>{ko ? "블록 삭제" : "Delete block"}</button>
          </div>
        ) : null}

        <span style={railLabel}>{ko ? "블록 추가" : "Add block"}</span>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
          {PALETTE.map((k) => <button key={k} type="button" onClick={() => addBlock(k)} style={paletteBtn}>{blockLabel(k, ko)}</button>)}
        </div>
      </aside>
    </div>
  );
}

/* ─────────────── 헬퍼 ─────────────── */
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
function blockLabel(k: BlockKind, ko: boolean): string {
  const map: Record<BlockKind, [string, string]> = {
    title: ["제목", "Title"], subtitle: ["부제", "Subtitle"], body: ["본문", "Body"], card: ["카드", "Card"], kicker: ["라벨", "Kicker"],
    pill: ["태그", "Pill"], kpi: ["숫자", "KPI"], bar: ["막대", "Bar"], rule: ["선", "Rule"], footer: ["푸터", "Footer"],
  };
  return ko ? map[k][0] : map[k][1];
}

/* ─────────────── 스타일 ─────────────── */
const shell: CSSProperties = { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "#f6f7f9", color: "var(--ink)" };
const topbar: CSSProperties = { minHeight: 44, borderBottom: "1px solid var(--paper-edge)", background: "var(--paper)", display: "flex", alignItems: "center", gap: 12, padding: "6px 16px 6px 90px", flexShrink: 0 };
const backLink: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, color: "var(--accent)", fontWeight: 800, fontSize: 12, textDecoration: "none" };
const wordmark: CSSProperties = { fontSize: 13, fontWeight: 800, color: "var(--ink)" };
const ghostBtn: CSSProperties = { height: 30, border: "1px solid var(--paper-edge)", borderRadius: 7, background: "var(--paper)", color: "var(--ink-soft)", display: "inline-flex", alignItems: "center", gap: 6, padding: "0 11px", fontSize: 12, fontWeight: 800, cursor: "pointer" };
const primaryBtn: CSSProperties = { height: 30, border: "none", borderRadius: 7, background: "var(--accent)", color: "#fff", display: "inline-flex", alignItems: "center", gap: 6, padding: "0 13px", fontSize: 12, fontWeight: 900, cursor: "pointer" };

const homeWrap: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "60px 32px" };
const homeInner: CSSProperties = { width: "100%", maxWidth: 720, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" };
const eyebrow: CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: ".18em", color: "var(--muted-deep)", marginBottom: 14 };
const homeTitle: CSSProperties = { margin: 0, fontSize: 26, fontWeight: 800, lineHeight: 1.14, color: "var(--ink)", fontFamily: "var(--font-display, inherit)" };
const homeSub: CSSProperties = { margin: "10px 0 26px", fontSize: 14, lineHeight: 1.5, color: "var(--muted-deep)" };
const promptBox: CSSProperties = { width: "100%", display: "flex", alignItems: "flex-start", gap: 10, padding: "14px 14px 14px 16px", border: "1px solid var(--paper-edge)", borderRadius: 16, background: "var(--paper)", boxShadow: "var(--rd-shadow-1, 0 4px 16px rgba(0,0,0,.05))" };
const promptInput: CSSProperties = { flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", resize: "none", color: "var(--ink)", fontSize: 15, lineHeight: 1.5, fontFamily: "inherit" };
const genBtn: CSSProperties = { width: 40, height: 40, flexShrink: 0, border: "none", borderRadius: 12, background: "var(--accent)", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" };
const controlRow: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 16 };
const stepper: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid var(--paper-edge)", borderRadius: 999, padding: "3px 5px", background: "var(--paper)" };
function stepBtn(disabled: boolean): CSSProperties { return { width: 26, height: 26, borderRadius: 999, border: "none", background: "transparent", color: disabled ? "var(--paper-edge)" : "var(--ink)", fontSize: 15, fontWeight: 900, cursor: disabled ? "default" : "pointer" }; }
const stepValue: CSSProperties = { minWidth: 40, textAlign: "center", fontSize: 12.5, fontWeight: 800, color: "var(--ink)" };
const dividerDot: CSSProperties = { width: 4, height: 4, borderRadius: 999, background: "var(--paper-edge)" };
const imageSelect: CSSProperties = { height: 30, border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", fontSize: 12, fontWeight: 700, padding: "0 8px", cursor: "pointer" };
function modeChip(active: boolean): CSSProperties { return { border: `1px solid ${active ? "var(--accent)" : "var(--paper-edge)"}`, borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: 800, background: active ? "var(--fill-1)" : "var(--paper)", color: active ? "var(--accent)" : "var(--ink-soft)", cursor: "pointer" }; }
const recentsHead: CSSProperties = { fontSize: 11, fontWeight: 900, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted-deep)", textAlign: "left", marginBottom: 12 };
const recentsGrid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 14 };
const recentCard: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, padding: 10, border: "1px solid var(--paper-edge)", borderRadius: 12, background: "var(--paper)", textAlign: "left", cursor: "pointer" };
const recentThumb: CSSProperties = { position: "relative", aspectRatio: "16 / 9", borderRadius: 8, overflow: "hidden", display: "block" };
const recentMode: CSSProperties = { position: "absolute", left: 8, bottom: 8, fontSize: 9.5, fontWeight: 800, color: "#fff", background: "rgba(0,0,0,.45)", padding: "2px 6px", borderRadius: 999 };
const recentTitle: CSSProperties = { fontSize: 12.5, fontWeight: 700, color: "var(--ink)", lineHeight: 1.35, wordBreak: "keep-all", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" };
const recentMeta: CSSProperties = { fontSize: 11, color: "var(--muted-deep)" };

const scrollStage: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", padding: "32px 28px 64px" };
const genHint: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 9, alignSelf: "center", fontSize: 12.5, fontWeight: 800, color: "var(--muted-deep)", background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: 999, padding: "7px 14px", marginBottom: 4 };
const spinner: CSSProperties = { width: 13, height: 13, borderRadius: "50%", border: "2px solid var(--paper-edge)", borderTopColor: "var(--accent)", display: "inline-block" };
const aiWritingWrap: CSSProperties = { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 40, textAlign: "center" };
const aiWritingSpinner: CSSProperties = { width: 34, height: 34, borderRadius: "50%", border: "3px solid var(--paper-edge)", borderTopColor: "var(--accent)", display: "inline-block" };
const aiWritingText: CSSProperties = { fontSize: 16, fontWeight: 800, color: "var(--ink)" };
const aiWritingSub: CSSProperties = { fontSize: 13, color: "var(--muted-deep)" };

const editorShell: CSSProperties = { flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "120px minmax(0,1fr) 188px", overflow: "hidden" };
const slideRail: CSSProperties = { borderRight: "1px solid var(--paper-edge)", background: "var(--paper)", padding: 12, overflowY: "auto" };
const railHeadRow: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 };
const railLabel: CSSProperties = { fontSize: 11, fontWeight: 900, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted-deep)" };
const miniBtn: CSSProperties = { width: 24, height: 24, border: "1px solid var(--paper-edge)", borderRadius: 6, background: "var(--paper)", color: "var(--ink-soft)", fontSize: 15, fontWeight: 800, cursor: "pointer", lineHeight: 1 };
const thumbBtn: CSSProperties = { position: "relative", width: "100%", aspectRatio: "16 / 9", border: "2px solid var(--paper-edge)", borderRadius: 8, overflow: "hidden", cursor: "pointer", padding: 0, background: "none" };
const thumbInner: CSSProperties = { position: "absolute", inset: 0 };
const thumbNo: CSSProperties = { position: "absolute", left: 5, top: 4, fontSize: 10, fontWeight: 800, color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,.6)" };
const delSlideBtn: CSSProperties = { marginTop: 14, width: "100%", border: "1px solid var(--paper-edge)", borderRadius: 7, background: "var(--paper)", color: "var(--muted-deep)", fontSize: 11.5, fontWeight: 700, padding: "7px 0", cursor: "pointer" };
const canvasWrap: CSSProperties = { minWidth: 0, minHeight: 0, overflowY: "auto", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 32px" };
const canvasHint: CSSProperties = { marginTop: 14, textAlign: "center", fontSize: 11.5, color: "var(--muted-deep)", lineHeight: 1.5 };
const paletteRail: CSSProperties = { borderLeft: "1px solid var(--paper-edge)", background: "var(--paper)", padding: 14, overflowY: "auto" };
const paletteBtn: CSSProperties = { border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", fontSize: 12, fontWeight: 800, padding: "10px 0", cursor: "pointer" };
const selName: CSSProperties = { fontSize: 14, fontWeight: 800, color: "var(--ink)", marginTop: 6 };
const ctrlBtn: CSSProperties = { flex: 1, border: "1px solid var(--paper-edge)", borderRadius: 7, background: "var(--paper)", color: "var(--ink)", fontSize: 12, fontWeight: 800, padding: "7px 0", cursor: "pointer" };
const ctrlWide: CSSProperties = { width: "100%", border: "1px solid var(--paper-edge)", borderRadius: 7, background: "var(--paper)", fontSize: 12, fontWeight: 800, padding: "8px 0", cursor: "pointer" };
