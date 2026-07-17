// T-rex 슬라이드 스튜디오 — 프롬프트 한 줄 → 실시간 생성 → 결과(PDF/편집) → 구조화 편집기.
// 오베론처럼 독립 등록된 스튜디오. 슬라이드 에이전트는 이 안의 엔진으로만 내장(따로 호출 불가).
// docs/DESIGN.md: 토큰만, 강조 1개, 시스템 폰트, inline CSSProperties.
"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { currentLocale, useT } from "@/lib/i18n";
import { grantForDroppedFile, ipc } from "@/lib/ipc";
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
  type DeckGenre,
  type DeckFormat,
  type FormatGroup,
  type SceneKind,
  type TrexBlock,
  type TrexDeck,
  type TrexSlide,
} from "@/lib/trex/model";
import { IconApps, IconSparkles, IconFileUp, IconEdit, IconChevronRight, IconCheck } from "@/components/Icon";
import { DeckStage, GlobalStyle, bgStyle } from "@/components/trex/DeckStage";
import { STYLES, STYLE_IDS, styleById, routeStyle, PALETTES, type StyleId } from "@/lib/trex/styles";
import type { OpenCrabReadiness } from "@/lib/types";

type ViewState = "home" | "generating" | "view" | "edit";
// "auto"=codex↔나노바나나 자동 페일오버(사용량 부족 시 남는 엔진 사용). "none"=이미지 생성 끔.
type ImageModel = "auto" | "codex" | "gemini" | "none";
const RECENTS_KEY = "trex.recents.v1";
const EXAMPLE = "중견 제조사 디지털 전환 전략 — 진단과 12개월 로드맵";
const EXAMPLE_EN = "Mid-market manufacturer digital transformation — diagnosis and a 12-month roadmap";
const ALL_MODES: ArtMode[] = ["editorial", "cinematic", "diagrammatic", "hybrid"];
const PALETTE: BlockKind[] = ["title", "subtitle", "body", "card", "image", "kicker", "pill", "kpi", "bar", "rule", "footer"];
type TrexSource = { name: string; text: string };

// electron/fs/workspace.ts가 실제 UTF-8 본문으로 읽는 형식 중, 이미지인 SVG를 제외한 소스 형식.
// PDF·Word·이미지는 별도 파서가 생기기 전까지 파일명조차 모델 컨텍스트에 넣지 않는다.
const TREX_TEXT_EXTENSIONS = [
  ".txt", ".md", ".mdx", ".json", ".yml", ".yaml", ".toml", ".csv", ".tsv",
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".swift", ".sh", ".bash", ".zsh", ".html", ".htm", ".css",
  ".scss", ".sass", ".less", ".xml", ".url", ".webloc", ".vue", ".astro", ".sql",
  ".env", ".gitignore", ".npmrc", ".editorconfig", ".prettierrc", ".eslintrc",
  ".dockerfile", ".gradle", ".properties", ".ini", ".conf", ".log",
] as const;
const TREX_TEXT_EXTENSION_SET = new Set<string>(TREX_TEXT_EXTENSIONS);
const TREX_EXTENSIONLESS_TEXT_FILES = new Set(["readme", "license", "makefile", "dockerfile"]);
const TREX_TEXT_ACCEPT = TREX_TEXT_EXTENSIONS.join(",");

function isReadableTrexTextSource(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (TREX_EXTENSIONLESS_TEXT_FILES.has(lower)) return true;
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && TREX_TEXT_EXTENSION_SET.has(lower.slice(dot));
}

export default function TrexPage() {
  const { locale } = useT();
  const ko = locale !== "en";
  const [view, setView] = useState<ViewState>("home");
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(5);
  const [formatId, setFormatId] = useState<string>(DEFAULT_FORMAT_ID);
  const [genre, setGenre] = useState<DeckGenre | null>(null); // 덱 대분류(장르) — null=일반
  const [imageModel, setImageModel] = useState<ImageModel>("auto");
  const [providers, setProviders] = useState<{ codex: boolean; gemini: boolean }>({ codex: false, gemini: false });
  const [aiContent, setAiContent] = useState(true);
  const [aiWriting, setAiWriting] = useState(false);
  const [contentEngines, setContentEngines] = useState<{ agy: boolean; codex: boolean }>({ agy: false, codex: false });
  const [openCrabReadiness, setOpenCrabReadiness] = useState<OpenCrabReadiness | null>(null);
  const [useOpenCrab, setUseOpenCrab] = useState(false);
  const [modeOverride, setModeOverride] = useState<ArtMode | null>(null);
  // Style DNA — null=자동(주제 라우팅, 매치 없으면 레거시 모드 룩), "legacy"=명시적 기본 룩.
  const [styleOverride, setStyleOverride] = useState<string | null>(null); // StyleId·팔레트id·"legacy"·null(자동)
  // 소스 파일 — 실제로 읽은 텍스트 본문만 덱의 재료로 쓴다. 읽지 못한 파일은 상태에도 넣지 않는다.
  const [sources, setSources] = useState<TrexSource[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachmentRejected, setAttachmentRejected] = useState<string[]>([]);

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setAttaching(true);
    setAttachmentRejected([]);
    const api = ipc();
    const next: TrexSource[] = [];
    const rejected = files.slice(12).map((file) => file.name);
    try {
      for (const file of files.slice(0, 12)) {
        const name = file.name;
        if (!isReadableTrexTextSource(name)) {
          rejected.push(name);
          continue;
        }
        try {
          const grant = await grantForDroppedFile(file);
          if (!grant || !api?.fs?.readTextFile) {
            rejected.push(name);
            continue;
          }
          const preview = await api.fs.readTextFile(grant.path, grant.scope);
          // 확장자가 맞아도 binary/too-large/빈 파일이면 소스로 가장하지 않는다.
          if (!preview || preview.reason || !preview.content.trim()) {
            rejected.push(name);
            continue;
          }
          next.push({ name, text: preview.content.slice(0, 12_000) });
        } catch {
          rejected.push(name);
        }
      }
      if (next.length > 0) setSources((prev) => [...prev, ...next].slice(0, 12));
      setAttachmentRejected(Array.from(new Set(rejected)));
    } finally {
      setAttaching(false);
    }
  }, []);
  const removeSource = useCallback((name: string) => setSources((prev) => prev.filter((s) => s.name !== name)), []);

  // 첨부 소스 → 프롬프트 주입용 텍스트. 검증을 통과해 읽힌 본문만 들어온다.
  const buildSourcesText = useCallback((): string => {
    return sources.map((source) => `### ${source.name}\n${source.text}`).join("\n\n");
  }, [sources]);

  useEffect(() => {
    const api = ipc();
    api?.trex?.imageProviders?.()
      .then((value) => {
        setProviders({ codex: value?.codex === true, gemini: value?.gemini === true });
      })
      .catch(() => { /* 브라우저/미지원 */ });
    api?.trex?.contentAvailable?.()
      .then((value) => {
        const available = { agy: value?.agy === true, codex: value?.codex === true };
        setContentEngines(available);
        setAiContent(available.agy || available.codex);
      })
      .catch(() => { /* 브라우저/미지원 */ });
    api?.openCrab?.readiness?.()
      .then((value) => {
        setOpenCrabReadiness(value);
        if (value?.state !== "ready") setUseOpenCrab(false);
      })
      .catch(() => {
        setOpenCrabReadiness(null);
        setUseOpenCrab(false);
      });
  }, []);
  const [deck, setDeck] = useState<TrexDeck | null>(null);
  // AI 콘텐츠 생성이 시도됐으나 실패해 스켈레톤으로 폴백했을 때의 사유 — 배너로 명확히 알리고 재시도 제공.
  // (조용히 프롬프트를 제목으로 박은 스켈레톤을 완성본처럼 보여주던 "장난하나" 버그의 UX 보정.)
  const [contentError, setContentError] = useState<{ reason: string; text: string; count: number } | null>(null);
  const [recents, setRecents] = useState<TrexDeck[]>([]);
  const [revealed, setRevealed] = useState(0);
  const [activeSlide, setActiveSlide] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [imagePending, setImagePending] = useState<Set<string>>(new Set());
  // 병렬 에이전트 활동 피드 — 콘텐츠/이미지 에이전트의 라이브 상태(멈춤 아님을 보여주는 창구).
  const [agentJobs, setAgentJobs] = useState<AgentJob[]>([]);
  const [, setJobTick] = useState(0); // 경과초 1s 갱신

  const patchJob = useCallback((j: AgentJobPatch) => {
    setAgentJobs((prev) => {
      const now = Date.now();
      const ex = prev.find((p) => p.key === j.key);
      if (ex) return prev.map((p) => (p.key === j.key ? { ...p, ...j, ...(j.status !== "running" ? { endedAt: now } : {}) } : p));
      return [...prev, { ...j, startedAt: now, ...(j.status !== "running" ? { endedAt: now } : {}) }];
    });
  }, []);

  // 실행 중 작업이 있으면 1초마다 경과초 리렌더, 전부 끝나면 8초 후 피드 정리.
  useEffect(() => {
    const anyRunning = agentJobs.some((j) => j.status === "running");
    if (anyRunning) {
      const t = window.setInterval(() => setJobTick((v) => v + 1), 1000);
      return () => window.clearInterval(t);
    }
    if (agentJobs.length > 0) {
      const t = window.setTimeout(() => setAgentJobs([]), 8000);
      return () => window.clearTimeout(t);
    }
  }, [agentJobs]);

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
      // dataURL 이미지(장당 ~1-2MB)는 localStorage 쿼터를 즉시 태운다 → 저장본에선 스트립.
      // 세션 안에서는 상태(deck)에 남아 있고, 재열람 시 이미지 블록은 생성중 표시로 되돌아간다.
      const slim = next.slice(0, 24).map((d) => ({
        ...d,
        slides: d.slides.map((s) => ({
          ...s,
          bg: s.bg.kind === "image" && s.bg.src.startsWith("data:") ? { kind: "solid" as const, color: "#111" } : s.bg,
          blocks: s.blocks.map((b) => ((b.kind === "image" || b.kind === "card") && (b.src || "").startsWith("data:") ? { ...b, src: "" } : b)),
        })),
      }));
      localStorage.setItem(RECENTS_KEY, JSON.stringify(slim));
    } catch {
      /* ignore */
    }
  }, []);

  // 최근 작업(덱) 삭제 — recents에서 제거 + 영속. 현재 열려있는 덱이면 홈으로.
  const deleteRecent = useCallback(
    (id: string) => {
      persistRecents(recents.filter((r) => r.id !== id));
      setDeck((cur) => {
        if (cur && cur.id === id) {
          setView("home");
          return null;
        }
        return cur;
      });
    },
    [persistRecents, recents],
  );

  const routedMode = modeOverride ?? routeMode(prompt || EXAMPLE);
  const routedStyle = routeStyle(prompt || EXAMPLE); // 주제 자동 라우팅(항상 StyleId|null — Auto 라벨 표시용)

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
            if (imageModel !== "none" && gen) {
              // 레거시 씬 배경(cinematic/hybrid)은 슬라이드 오버레이로, 이미지 블록은 블록 자체가
              // 생성중 표시를 하므로 pending 상태가 따로 필요 없다.
              setImagePending(new Set(d.slides.filter((s) => s.scene !== "none").map((s) => s.id)));
              void maybeFetchScenes(d, imageModel, (slideId, src) => {
                setDeck((cur) => (cur && cur.id === d.id ? patchSlideBg(cur, slideId, src) : cur));
                setImagePending((prev) => {
                  const nn = new Set(prev);
                  nn.delete(slideId);
                  return nn;
                });
              }).finally(() => setImagePending(new Set()));
              void fillBlockImages(
                d,
                imageModel,
                (slideId, blockId, src) => {
                  setDeck((cur) =>
                    cur && cur.id === d.id
                      ? blockId.startsWith("__panel__")
                        ? patchPanelSrc(cur, slideId, src)
                        : patchBlockSrc(cur, slideId, blockId, src)
                      : cur,
                  );
                },
                patchJob,
              );
            }
          }, 360);
        }
      };
      window.setTimeout(tick, 300);
    },
    [imageModel, persistRecents, recents, patchJob],
  );

  // 실시간 생성 — AI(agy/codex)가 슬라이드별 실제 내용을 쓰고, 완성되면 렌더. 미가용 시 스캐폴드.
  const runGenerate = useCallback(
    async (text: string, n: number) => {
      const sourcesText = buildSourcesText();
      // 소스 파일이 있으면 주제가 비어도 생성(소스가 재료). 둘 다 없으면 예시로 폴백.
      const p = text.trim() || (sourcesText ? "" : ko ? EXAMPLE : EXAMPLE_EN);
      // 스타일 결정 — 명시 선택 > 자동(주제/소스 라우팅) > LLM 위임(undefined) > "legacy"=명시적 기본 룩(null).
      const styleId = styleOverride === "legacy" ? null : styleOverride ?? routeStyle(p || sourcesText) ?? undefined;
      // 장르가 카드뉴스/advertise면 판형을 자동 지정(4:5 / 9:16) — 그 외엔 사용자 선택 판형 유지.
      const gFmt = genre === "cardnews" ? "ig-portrait" : genre === "advertise" ? "story" : formatId;
      const gArg = genre ?? undefined;
      const gc = ipc()?.trex?.generateContent;
      if (aiContent && gc) {
        setDeck(null);
        setContentError(null);
        setView("generating");
        setAiWriting(true);
        setAgentJobs([]);
        patchJob({ key: "content", label: ko ? "콘텐츠 에이전트 — 카피·수치 작성" : "Content agent — writing copy & figures", status: "running" });
        const openCrabEnabled = useOpenCrab && openCrabReadiness?.state === "ready";
        if (openCrabEnabled) {
          patchJob({ key: "opencrab", label: ko ? "OpenCrab 온톨로지 — 관련 근거 찾는 중" : "OpenCrab ontology — finding relevant evidence", status: "running" });
        }
        const withImages = imageModel !== "none";
        let d: TrexDeck;
        let contentOk = false;
        let failReason: string | null = null;
        try {
          const r = await gc({
            topic: p,
            count: n,
            mode: modeOverride ?? undefined,
            sources: sourcesText || undefined,
            locale: ko ? "ko" : "en",
            useOpenCrab: openCrabEnabled,
          });
          const parsed = r?.ok && r.text ? parseDeckContent(r.text) : null;
          if (openCrabEnabled) {
            const applied = Boolean(parsed && r?.openCrab?.used);
            patchJob({
              key: "opencrab",
              label: applied
                ? (ko
                    ? `OpenCrab 온톨로지 — 관련 근거 ${r?.openCrab?.evidenceCount ?? 0}개 확인`
                    : `OpenCrab ontology — ${r?.openCrab?.evidenceCount ?? 0} relevant records checked`)
                : (ko ? "OpenCrab 보강 건너뜀 — 기본 생성 계속" : "OpenCrab skipped — continuing standard generation"),
              status: "done",
              engine: applied ? "ontology" : "skipped",
            });
          }
          contentOk = !!parsed;
          if (!parsed) failReason = r?.reason || "parse-failed";
          d = parsed ? buildDeckFromContent({ ...parsed, genre: gArg ?? parsed.genre }, gFmt, locale, styleId, withImages) : generateDeck(p, modeOverride ?? undefined, n, gFmt, locale, styleId, withImages, gArg);
        } catch {
          if (openCrabEnabled) {
            patchJob({
              key: "opencrab",
              label: ko ? "OpenCrab 보강 건너뜀 — 기본 생성 계속" : "OpenCrab skipped — continuing standard generation",
              status: "done",
              engine: "skipped",
            });
          }
          failReason = "exception";
          d = generateDeck(p, modeOverride ?? undefined, n, gFmt, locale, styleId, withImages, gArg);
        }
        patchJob({ key: "content", label: ko ? "콘텐츠 에이전트 — 카피·수치 작성" : "Content agent — writing copy & figures", status: contentOk ? "done" : "failed", engine: contentOk ? "agy/codex" : undefined });
        setAiWriting(false);
        // 콘텐츠 생성이 시도됐는데 실패했으면(런타임은 있으나 산출/파싱 실패), 스켈레톤을 완성본으로
        // 위장하지 않고 배너로 알린다. 런타임 자체가 없으면(no-llm-runtime) 스켈레톤이 정상 폴백이라 조용히 둔다.
        if (!contentOk && failReason && failReason !== "no-llm-runtime") {
          setContentError({ reason: failReason, text, count: n });
        }
        revealDeck(d);
      } else {
        revealDeck(generateDeck(p, modeOverride ?? undefined, n, gFmt, locale, styleId, imageModel !== "none", gArg));
      }
    },
    [aiContent, modeOverride, styleOverride, formatId, genre, revealDeck, locale, imageModel, ko, patchJob, buildSourcesText, useOpenCrab, openCrabReadiness],
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
      {/* 병렬 에이전트 활동 피드 — 덱이 만들어지는 동안 무엇이 돌고 있는지 라이브로 보여준다. */}
      {agentJobs.length > 0 && view !== "home" && (
        <aside style={agentFeedWrap} aria-live="polite">
          <div style={agentFeedHead}>
            {agentJobs.some((j) => j.status === "running") ? (
              <span className="trex-spin" style={agentFeedSpin} />
            ) : (
              <IconCheck size={12} />
            )}
            {ko ? "에이전트 활동" : "Agent activity"}
          </div>
          {agentJobs.map((j) => {
            const secs = Math.max(0, Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000));
            return (
              <div key={j.key} style={agentFeedRow}>
                <span style={{ flexShrink: 0, width: 14, textAlign: "center" }}>
                  {j.status === "running" ? <span className="trex-spin" style={agentFeedSpin} /> : j.status === "done" ? "✓" : "✗"}
                </span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.label}</span>
                {j.engine && <span style={agentFeedEngine}>{j.engine}</span>}
                <span style={{ opacity: 0.55, fontVariantNumeric: "tabular-nums" }}>{secs}s</span>
              </div>
            );
          })}
        </aside>
      )}
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
          genre={genre}
          setGenre={setGenre}
          imageModel={imageModel}
          setImageModel={setImageModel}
          providers={providers}
          aiContent={aiContent}
          setAiContent={setAiContent}
          contentEngines={contentEngines}
          openCrabReadiness={openCrabReadiness}
          useOpenCrab={useOpenCrab}
          setUseOpenCrab={setUseOpenCrab}
          routedMode={routedMode}
          modeOverride={modeOverride}
          setModeOverride={setModeOverride}
          routedStyle={routedStyle}
          styleOverride={styleOverride}
          setStyleOverride={setStyleOverride}
          recents={recents}
          sources={sources}
          attaching={attaching}
          attachmentRejected={attachmentRejected}
          onAddFiles={addFiles}
          onRemoveSource={removeSource}
          onGenerate={() => runGenerate(prompt, count)}
          onOpen={(d) => { setDeck(d); setActiveSlide(0); setView("view"); }}
          onDeleteRecent={deleteRecent}
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
            {contentError && view !== "generating" && (
              <div style={contentErrorBanner} role="alert">
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <strong style={{ fontSize: 13, color: "var(--rd-ink)" }}>
                    {ko ? "AI가 기획안을 반영하지 못했어요" : "AI could not apply your brief"}
                  </strong>
                  <span style={{ fontSize: 12, color: "var(--rd-ink-3)", lineHeight: 1.5 }}>
                    {ko
                      ? "콘텐츠 생성이 실패해 기본 골격만 표시됩니다. 첨부한 소스는 그대로 있어요 — 다시 시도하세요."
                      : "Content generation failed, so only the skeleton is shown. Your attached sources are kept — try again."}
                  </span>
                </div>
                <button
                  type="button"
                  style={contentErrorRetryBtn}
                  onClick={() => {
                    const t = contentError.text;
                    const c = contentError.count;
                    setContentError(null);
                    void runGenerate(t, c);
                  }}
                >
                  {ko ? "다시 시도" : "Retry"}
                </button>
              </div>
            )}
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
                <DeckStage slide={s} accent={deck.accent} editable={false} ratio={formatRatio(formatById(deck.formatId))} dna={styleById(deck.styleId)} pending={imagePending.has(s.id)} pendingLabel={imageModel === "gemini" ? (ko ? "나노바나나 이미지 생성 중" : "Generating nano-banana image") : ko ? "이미지 생성 중" : "Generating image"} />
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

async function maybeFetchScenes(deck: TrexDeck, model: ImageModel, onImage: (slideId: string, src: string) => void): Promise<void> {
  const gen = ipc()?.trex?.generateImage;
  if (!gen || model === "none") return; // 브라우저/미지원 — SVG 씬으로 폴백(렌더러가 그림)
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

/** 에이전트 활동 피드 항목 — 병렬 생성이 "멈추지 않았다"는 라이브 피드백용. */
interface AgentJob {
  key: string;
  label: string;
  status: "running" | "done" | "failed";
  engine?: string;
  startedAt: number;
  endedAt?: number;
}
type AgentJobPatch = Pick<AgentJob, "key" | "label" | "status"> & { engine?: string };

/**
 * Style DNA 덱의 이미지 블록 채우기 — 각 블록의 장면 설명 + 유파 사진 룩(dna.photoStyle)으로
 * 실제 이미지를 생성한다(auto면 codex↔나노바나나 자동 페일오버). **병렬 워커 2개**가
 * 배열 순서(커버 우선)대로 작업을 집어가며 동시에 그린다 — 활동은 onJob으로 피드에 중계.
 */
async function fillBlockImages(
  deck: TrexDeck,
  model: ImageModel,
  onImage: (slideId: string, blockId: string, src: string) => void,
  onJob?: (j: AgentJobPatch) => void,
): Promise<void> {
  const gen = ipc()?.trex?.generateImage;
  if (!gen || model === "none") return;
  // 모듈 함수라 훅을 못 쓴다 — 활동 피드 라벨용 locale 스냅샷(build-session.ts와 같은 패턴).
  const ko = currentLocale() === "ko";
  const dna = styleById(deck.styleId);
  const tasks: Array<{ slideId: string; blockId: string; label: string; prompt: string }> = [];
  deck.slides.forEach((s, si) => {
    for (const b of s.blocks) {
      if (b.kind !== "image" || b.src) continue;
      const scene = (b.prompt || "").trim() || `An evocative editorial photograph for a presentation titled "${deck.title}"`;
      tasks.push({
        slideId: s.id,
        blockId: b.id,
        label: si === 0 ? (ko ? "표지 이미지" : "Cover image") : ko ? `슬라이드 ${si + 1} 이미지` : `Slide ${si + 1} image`,
        prompt: `${scene}. ${dna?.photoStyle ?? "Clean professional editorial photography"}. Absolutely no text, no letters, no numbers, no watermark.`,
      });
    }
    // 인포그래픽 도형 패널 — 슬라이드당 1장 생성해 카드들이 배경으로 공유(텍스트는 HTML 오버레이).
    if (dna && s.blocks.some((b) => b.kind === "card" && b.prompt === "panel" && !b.src)) {
      tasks.push({
        slideId: s.id,
        blockId: `__panel__:${s.id}`,
        label: ko ? `슬라이드 ${si + 1} 도형 패널` : `Slide ${si + 1} shape panel`,
        prompt: `${dna.graphicStyle}. Landscape rectangular panel. Absolutely no text, no letters, no numbers, no watermark, nothing in the center.`,
      });
    }
  });
  if (!tasks.length) return;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      const t = tasks[i];
      onJob?.({ key: t.blockId, label: t.label, status: "running" });
      try {
        const r = await gen({ model, prompt: t.prompt });
        if (r?.ok && r.src) {
          onImage(t.slideId, t.blockId, r.src);
          onJob?.({ key: t.blockId, label: t.label, status: "done", engine: r.engine });
        } else {
          onJob?.({ key: t.blockId, label: t.label, status: "failed" });
        }
      } catch {
        onJob?.({ key: t.blockId, label: t.label, status: "failed" });
      }
    }
  };
  await Promise.all([worker(), worker()]);
}

/** 슬라이드의 panel 카드 전부에 같은 도형 패널 이미지를 배경으로 심는다. */
function patchPanelSrc(deck: TrexDeck, slideId: string, src: string): TrexDeck {
  return {
    ...deck,
    slides: deck.slides.map((s) =>
      s.id === slideId ? { ...s, blocks: s.blocks.map((b) => (b.kind === "card" && b.prompt === "panel" ? { ...b, src } : b)) } : s,
    ),
  };
}

function patchBlockSrc(deck: TrexDeck, slideId: string, blockId: string, src: string): TrexDeck {
  return {
    ...deck,
    slides: deck.slides.map((s) =>
      s.id === slideId ? { ...s, blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, src } : b)) } : s,
    ),
  };
}

function patchSlideBg(deck: TrexDeck, slideId: string, src: string): TrexDeck {
  return { ...deck, slides: deck.slides.map((s) => (s.id === slideId ? { ...s, bg: { kind: "image", src }, scene: "none" } : s)) };
}

/* ─────────────── 랜딩 ─────────────── */
function Home({
  ko, prompt, setPrompt, count, setCount, formatId, setFormatId, genre, setGenre, imageModel, setImageModel, providers, aiContent, setAiContent, contentEngines, openCrabReadiness, useOpenCrab, setUseOpenCrab, routedMode, modeOverride, setModeOverride, routedStyle, styleOverride, setStyleOverride, recents, sources, attaching, attachmentRejected, onAddFiles, onRemoveSource, onGenerate, onOpen, onDeleteRecent,
}: {
  ko: boolean; prompt: string; setPrompt: (v: string) => void; count: number; setCount: (n: number) => void;
  formatId: string; setFormatId: (id: string) => void;
  genre: DeckGenre | null; setGenre: (g: DeckGenre | null) => void;
  imageModel: ImageModel; setImageModel: (m: ImageModel) => void; providers: { codex: boolean; gemini: boolean };
  aiContent: boolean; setAiContent: (v: boolean) => void; contentEngines: { agy: boolean; codex: boolean };
  openCrabReadiness: OpenCrabReadiness | null; useOpenCrab: boolean; setUseOpenCrab: (v: boolean) => void;
  routedMode: ArtMode; modeOverride: ArtMode | null; setModeOverride: (m: ArtMode | null) => void;
  routedStyle: StyleId | null; styleOverride: string | null; setStyleOverride: (s: string | null) => void;
  recents: TrexDeck[];
  sources: TrexSource[];
  attaching: boolean;
  attachmentRejected: string[];
  onAddFiles: (files: File[]) => void;
  onRemoveSource: (name: string) => void;
  onGenerate: () => void; onOpen: (d: TrexDeck) => void;
  onDeleteRecent: (id: string) => void;
}) {
  return (
    <div style={homeWrap}>
      <div style={homeInner}>
        <div style={eyebrow}>T-REX · SLIDE STUDIO</div>
        <h1 style={homeTitle}>{ko ? "무엇을 발표할까요?" : "What are you presenting?"}</h1>
        <p style={homeSub}>{ko ? "한 줄로 적고 엔터하면, 목적에 맞춰 실시간으로 덱을 만듭니다." : "Type one line and hit enter — a deck builds itself, art-directed to your purpose."}</p>

        <div
          style={promptBox}
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={(e) => {
            e.preventDefault();
            const files = Array.from(e.dataTransfer?.files ?? []);
            if (files.length) onAddFiles(files);
          }}
        >
          <IconSparkles size={16} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 3 }} />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onGenerate(); } }}
            placeholder={ko ? `예: ${EXAMPLE} — 또는 텍스트 파일을 소스로 추가` : `e.g. ${EXAMPLE_EN} — or add text files as sources`}
            rows={2}
            style={promptInput}
            aria-label={ko ? "발표 주제" : "Deck prompt"}
          />
          <label style={attachBtn} title={ko ? "텍스트 소스 첨부 (md·txt·csv·json 등)" : "Attach text sources (md, txt, csv, json…)"}>
            <IconFileUp size={17} />
            <input
              type="file"
              multiple
              accept={TREX_TEXT_ACCEPT}
              onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) onAddFiles(files); e.currentTarget.value = ""; }}
              style={{ display: "none" }}
            />
          </label>
          <button type="button" onClick={onGenerate} style={genBtn} aria-label={ko ? "생성" : "Generate"}>
            <IconChevronRight size={18} />
          </button>
        </div>

        {(sources.length > 0 || attaching) && (
          <div style={sourceChips}>
            {attaching && <span style={sourceChipMuted}>{ko ? "읽는 중…" : "Reading…"}</span>}
            {sources.map((s) => (
              <span key={s.name} data-testid="trex-source-chip" style={sourceChip} title={`${s.text.length.toLocaleString()}${ko ? "자" : " chars"}`}>
                <IconFileUp size={11} />
                <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                <button type="button" onClick={() => onRemoveSource(s.name)} style={sourceChipX} aria-label={ko ? "제거" : "Remove"}>×</button>
              </span>
            ))}
          </div>
        )}

        {attachmentRejected.length > 0 && (
          <div
            role="alert"
            data-testid="trex-attachment-error"
            style={{
              marginTop: 9,
              padding: "9px 12px",
              border: "1px solid rgba(185, 92, 48, .35)",
              borderRadius: 10,
              background: "rgba(255, 239, 229, .72)",
              color: "var(--ink-soft)",
              fontSize: 11.5,
              lineHeight: 1.55,
            }}
          >
            {ko
              ? "PDF·Word·이미지 등 현재 본문을 읽을 수 없는 파일은 소스로 추가하지 않습니다. .txt, .md, .csv, .json 같은 텍스트 파일로 변환해 주세요."
              : "PDF, Word, images, and other files whose contents cannot be read are not added as sources. Convert them to text such as .txt, .md, .csv, or .json."}
            <div style={{ marginTop: 3, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
              {ko ? "제외: " : "Not added: "}{attachmentRejected.join(", ")}
            </div>
          </div>
        )}

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
          <span style={{ fontSize: 11.5, color: "var(--muted-deep)", fontWeight: 700 }}>{ko ? "장르" : "Genre"}</span>
          <button type="button" onClick={() => setGenre(null)} style={modeChip(genre === null)} title={ko ? "일반 덱(역할 기반 자동 레이아웃)" : "General deck"}>{ko ? "일반" : "General"}</button>
          {([["pitch", ko ? "피치" : "Pitch", ko ? "저밀도 · 차트+그림 스토리" : "Low-density story"], ["report", ko ? "리포트" : "Report", ko ? "고밀도 · 고정 레이아웃" : "High-density fixed"], ["cardnews", ko ? "카드뉴스" : "Cardnews", ko ? "인스타 캐러셀 4:5 · 이미지 중심" : "IG carousel 4:5"], ["advertise", ko ? "광고" : "Advertise", ko ? "포스터 · 단일 오퍼 9:16" : "Poster · single offer"]] as [DeckGenre, string, string][]).map(([g, lab, hint]) => (
            <button key={g} type="button" onClick={() => setGenre(g)} style={modeChip(genre === g)} title={hint}>{lab}</button>
          ))}
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
          <span style={{ fontSize: 11.5, color: "var(--muted-deep)", fontWeight: 700 }}>{ko ? "디자인 유파" : "Design DNA"}</span>
          <button type="button" onClick={() => setStyleOverride(null)} style={modeChip(styleOverride === null)} title={ko ? "주제에 맞는 유파를 자동 선택" : "Auto-route a design school by topic"}>
            {ko ? "자동" : "Auto"}
            {routedStyle && <span style={{ opacity: 0.6, marginLeft: 4 }}>· {STYLES[routedStyle][ko ? "nameKo" : "nameEn"]}</span>}
          </button>
          <button type="button" onClick={() => setStyleOverride("legacy")} style={modeChip(styleOverride === "legacy")} title={ko ? "기존 기본 룩" : "The original default look"}>
            {ko ? "기본" : "Default"}
          </button>
          {STYLE_IDS.map((sid) => (
            <button key={sid} type="button" onClick={() => setStyleOverride(sid)} style={modeChip(styleOverride === sid)} title={ko ? STYLES[sid].hintKo : STYLES[sid].hintEn}>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: STYLES[sid].radius === 0 ? 1 : 999, background: STYLES[sid].accent, marginRight: 5, verticalAlign: "baseline" }} />
              {STYLES[sid][ko ? "nameKo" : "nameEn"]}
            </button>
          ))}
        </div>

        {/* (b) 색조합 팔레트 50종 선택기 — 그라데이션 스와치. styleById가 팔레트 id를 해석해 그대로 적용. */}
        <div style={{ ...controlRow, alignItems: "flex-start" }}>
          <span style={{ fontSize: 11.5, color: "var(--muted-deep)", fontWeight: 700, paddingTop: 4 }}>{ko ? "색조합" : "Palette"}</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 88, overflowY: "auto" }}>
            {PALETTES.map((p) => {
              const on = styleOverride === p.id;
              return (
                <button key={p.id} type="button" onClick={() => setStyleOverride(p.id)} title={p[ko ? "nameKo" : "nameEn"]}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px 3px 4px", borderRadius: 999, cursor: "pointer", fontSize: 11, fontWeight: 700, color: on ? "#fff" : "var(--fg)", background: on ? `linear-gradient(135deg, ${p.accent}, ${p.accent2})` : "var(--chip-bg, #f2f2f6)", border: on ? "none" : "1px solid var(--border, #e2e1ea)" }}>
                  <span style={{ display: "inline-block", width: 13, height: 13, borderRadius: 999, background: `linear-gradient(135deg, ${p.accent}, ${p.accent2})`, boxShadow: on ? "0 0 0 1.5px #fff" : "none" }} />
                  {p[ko ? "nameKo" : "nameEn"]}
                </button>
              );
            })}
          </div>
        </div>

        <div style={controlRow}>
          {(contentEngines.agy || contentEngines.codex) && (
            <>
              <button
                type="button"
                onClick={() => {
                  const next = !aiContent;
                  setAiContent(next);
                  if (!next) setUseOpenCrab(false);
                }}
                style={modeChip(aiContent)}
                title={ko ? "AI가 슬라이드별 실제 내용을 작성" : "AI writes real per-slide content"}
              >
                ✦ {ko ? "AI 내용 작성" : "AI content"} {aiContent ? "✓" : "○"}
              </button>
              <span style={dividerDot} />
            </>
          )}
          {aiContent && openCrabReadiness?.state === "ready" && (
            <>
              <button
                type="button"
                onClick={() => setUseOpenCrab(!useOpenCrab)}
                style={modeChip(useOpenCrab)}
                title={ko ? "발표 주제만 OpenCrab에 검색합니다. 첨부 파일 본문은 보내지 않습니다." : "Searches OpenCrab with the deck topic only. Attached source bodies are not sent."}
              >
                OpenCrab {useOpenCrab ? "✓" : "○"}
              </button>
              <span style={dividerDot} />
            </>
          )}
          <span style={{ fontSize: 11.5, color: "var(--muted-deep)", fontWeight: 700 }}>{ko ? "이미지 모델" : "Image model"}</span>
          <select value={imageModel} onChange={(e) => setImageModel(e.target.value as ImageModel)} style={imageSelect} aria-label={ko ? "이미지 모델" : "Image model"}>
            <option value="auto">{ko ? "자동 (Codex ↔ 나노바나나)" : "Auto (Codex ↔ nano-banana)"}</option>
            <option value="codex">Codex image_gen{providers.codex ? "" : ko ? " · CLI 필요" : " · needs CLI"}</option>
            <option value="gemini" disabled={!providers.gemini}>{ko ? "Antigravity 나노바나나" : "Antigravity nano-banana"}{providers.gemini ? "" : ko ? " · 연결 필요" : " · connect Antigravity"}</option>
            <option value="none">{ko ? "이미지 끄기" : "No images"}</option>
          </select>
          <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
            {imageModel === "none"
              ? ko ? "텍스트·도표 전용 레이아웃" : "Text & chart only layouts"
              : imageModel === "auto"
                ? ko ? "사용량이 부족하면 남는 엔진을 자동 사용" : "Falls over to whichever engine has quota"
                : ko ? "생성 직후 실제 이미지로 채웁니다" : "Fills with real images after generation"}
          </span>
        </div>

        {recents.length > 0 && (
          <div style={{ width: "100%", marginTop: 30 }}>
            <div style={recentsHead}>{ko ? "최근 작업" : "Recent"}</div>
            <div style={recentsGrid}>
              {recents.slice(0, 8).map((d) => (
                <div key={d.id} className="trex-recent" style={recentCardWrap}>
                  <button type="button" onClick={() => onOpen(d)} style={recentCard}>
                    <span style={{ ...recentThumb, aspectRatio: formatRatio(formatById(d.formatId)), ...bgStyle(d.slides[0]?.bg, d.accent) }}>
                      <span style={recentMode}>{MODE_THEMES[d.mode][ko ? "labelKo" : "labelEn"]} · {d.slides.length}</span>
                    </span>
                    <span style={recentTitle}>{d.title}</span>
                    <span style={recentMeta}>{new Date(d.createdAt).toLocaleDateString(ko ? "ko-KR" : "en-US")}</span>
                  </button>
                  <button
                    type="button"
                    className="trex-recent-del"
                    style={recentDelBtn}
                    title={ko ? "삭제" : "Delete"}
                    aria-label={ko ? "이 작업 삭제" : "Delete this deck"}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(ko ? `"${d.title}" 작업을 삭제할까요?` : `Delete "${d.title}"?`)) onDeleteRecent(d.id);
                    }}
                  >
                    ×
                  </button>
                </div>
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

  // 선택 요소 LLM 수정(select-to-edit) — 자연어 지시로 블록 텍스트를 다시 쓴다.
  const [aiEdit, setAiEdit] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState(false);
  // 블록의 주 텍스트 필드 판별(text > value > label) — refine 결과를 같은 필드로 되돌린다.
  const aiField: "text" | "value" | "label" | null = selBlock
    ? typeof (selBlock as { text?: unknown }).text === "string"
      ? "text"
      : typeof (selBlock as { value?: unknown }).value === "string"
        ? "value"
        : typeof (selBlock as { label?: unknown }).label === "string"
          ? "label"
          : null
    : null;
  const runAiEdit = async () => {
    if (!selBlock || !aiField || !aiEdit.trim() || aiBusy) return;
    const refine = ipc()?.trex?.refineText;
    if (!refine) return;
    setAiBusy(true);
    setAiErr(false);
    try {
      const current = String((selBlock as unknown as Record<string, unknown>)[aiField] ?? "");
      const context = `${slide.blocks.map((b) => (b as { text?: string }).text || (b as { value?: string }).value || "").filter(Boolean).join(" · ")}`;
      const r = await refine({ current, instruction: aiEdit.trim(), context });
      if (r?.ok && typeof r.text === "string" && r.text.trim()) {
        patchBlock(slide.id, selBlock.id, { [aiField]: r.text.trim() } as Partial<TrexBlock>);
        setAiEdit("");
      } else {
        setAiErr(true);
      }
    } catch {
      setAiErr(true);
    } finally {
      setAiBusy(false);
    }
  };

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
            dna={styleById(deck.styleId)}
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

            {aiField && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed var(--paper-edge)" }}>
                <span style={railLabel}>{ko ? "✦ AI로 수정" : "✦ Edit with AI"}</span>
                <textarea
                  value={aiEdit}
                  onChange={(e) => setAiEdit(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void runAiEdit();
                    }
                  }}
                  placeholder={ko ? "예: 더 임팩트 있게 · 수치를 강조 · 한 줄로 줄여" : "e.g. make it punchier · emphasize the number · shorten to one line"}
                  rows={2}
                  disabled={aiBusy}
                  style={aiEditInput}
                />
                <button type="button" onClick={() => void runAiEdit()} disabled={aiBusy || !aiEdit.trim()} style={{ ...ctrlWide, marginTop: 8, opacity: aiBusy || !aiEdit.trim() ? 0.55 : 1 }}>
                  {aiBusy ? (ko ? "AI가 고치는 중…" : "AI editing…") : ko ? "이 요소 AI로 수정 (⌘↵)" : "Edit this element with AI (⌘↵)"}
                </button>
                {aiErr && <div style={{ marginTop: 6, fontSize: 11.5, color: "#C0202A" }}>{ko ? "수정 실패 — 다시 시도하세요." : "Edit failed — try again."}</div>}
              </div>
            )}
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
    title: ["제목", "Title"], subtitle: ["부제", "Subtitle"], body: ["본문", "Body"], card: ["카드", "Card"], image: ["이미지", "Image"], kicker: ["라벨", "Kicker"],
    pill: ["태그", "Pill"], kpi: ["숫자", "KPI"], bar: ["막대", "Bar"], rule: ["선", "Rule"], footer: ["푸터", "Footer"], band: ["챕터 밴드", "Chapter Band"], panel: ["패널", "Panel"], asset: ["인포그래픽", "Infographic"], badge: ["오퍼 뱃지", "Badge"], cta: ["CTA 버튼", "CTA"],
  };
  return ko ? map[k][0] : map[k][1];
}

/* ─────────────── 스타일 ─────────────── */
const shell: CSSProperties = { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--rd-bg)", color: "var(--ink)" };
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
const attachBtn: CSSProperties = { width: 40, height: 40, flexShrink: 0, border: "1px solid var(--paper-edge)", borderRadius: 12, background: "var(--paper)", color: "var(--muted-deep)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" };
const sourceChips: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 7, marginTop: 10, width: "100%" };
const sourceChip: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 6px 4px 9px", borderRadius: 999, border: "1px solid var(--paper-edge)", background: "var(--fill-1)", color: "var(--ink-soft)", fontSize: 12, fontWeight: 600 };
const sourceChipMuted: CSSProperties = { display: "inline-flex", alignItems: "center", padding: "4px 10px", borderRadius: 999, background: "var(--fill-1)", color: "var(--muted-deep)", fontSize: 12 };
const sourceChipX: CSSProperties = { width: 18, height: 18, border: "none", borderRadius: "50%", background: "transparent", color: "var(--muted-deep)", cursor: "pointer", fontSize: 14, lineHeight: 1, display: "inline-flex", alignItems: "center", justifyContent: "center" };
const controlRow: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 16 };
const stepper: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid var(--paper-edge)", borderRadius: 999, padding: "3px 5px", background: "var(--paper)" };
function stepBtn(disabled: boolean): CSSProperties { return { width: 26, height: 26, borderRadius: 999, border: "none", background: "transparent", color: disabled ? "var(--paper-edge)" : "var(--ink)", fontSize: 15, fontWeight: 900, cursor: disabled ? "default" : "pointer" }; }
const stepValue: CSSProperties = { minWidth: 40, textAlign: "center", fontSize: 12.5, fontWeight: 800, color: "var(--ink)" };
const dividerDot: CSSProperties = { width: 4, height: 4, borderRadius: 999, background: "var(--paper-edge)" };
const imageSelect: CSSProperties = { height: 30, border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", fontSize: 12, fontWeight: 700, padding: "0 8px", cursor: "pointer" };
function modeChip(active: boolean): CSSProperties { return { border: `1px solid ${active ? "var(--accent)" : "var(--paper-edge)"}`, borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: 800, background: active ? "var(--fill-1)" : "var(--paper)", color: active ? "var(--accent)" : "var(--ink-soft)", cursor: "pointer" }; }
const recentsHead: CSSProperties = { fontSize: 11, fontWeight: 900, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted-deep)", textAlign: "left", marginBottom: 12 };
const recentsGrid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 14 };
const recentCardWrap: CSSProperties = { position: "relative" };
const recentCard: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, padding: 10, border: "1px solid var(--paper-edge)", borderRadius: 12, background: "var(--paper)", textAlign: "left", cursor: "pointer", width: "100%" };
// 삭제 × — 평소엔 반투명, 카드 hover 시 또렷(CSS 아래 globals의 .trex-recent:hover .trex-recent-del).
const recentDelBtn: CSSProperties = { position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 6, border: "1px solid var(--paper-edge)", background: "color-mix(in srgb, var(--paper) 82%, transparent)", color: "var(--muted-deep)", fontSize: 15, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.55 };
const recentThumb: CSSProperties = { position: "relative", aspectRatio: "16 / 9", borderRadius: 8, overflow: "hidden", display: "block" };
const recentMode: CSSProperties = { position: "absolute", left: 8, bottom: 8, fontSize: 9.5, fontWeight: 800, color: "#fff", background: "rgba(0,0,0,.45)", padding: "2px 6px", borderRadius: 999 };
const recentTitle: CSSProperties = { fontSize: 12.5, fontWeight: 700, color: "var(--ink)", lineHeight: 1.35, wordBreak: "keep-all", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" };
const recentMeta: CSSProperties = { fontSize: 11, color: "var(--muted-deep)" };

const scrollStage: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", padding: "32px 28px 64px" };
const contentErrorBanner: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "12px 16px", borderRadius: 12, border: "1px solid color-mix(in srgb, var(--red-deep, #d4483b) 30%, var(--paper-edge))", background: "color-mix(in srgb, var(--red-deep, #d4483b) 7%, var(--paper))" };
const contentErrorRetryBtn: CSSProperties = { flexShrink: 0, padding: "8px 16px", borderRadius: 9, border: "1px solid var(--accent)", background: "var(--accent)", color: "var(--paper)", fontSize: 12.5, fontWeight: 700, cursor: "pointer" };
const genHint: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 9, alignSelf: "center", fontSize: 12.5, fontWeight: 800, color: "var(--muted-deep)", background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: 999, padding: "7px 14px", marginBottom: 4 };
const spinner: CSSProperties = { width: 13, height: 13, borderRadius: "50%", border: "2px solid var(--paper-edge)", borderTopColor: "var(--accent)", display: "inline-block" };
// 에이전트 활동 피드 — 우하단 고정 미니 패널(생성 병렬 작업의 라이브 상태).
const agentFeedWrap: CSSProperties = { position: "fixed", right: 16, bottom: 16, zIndex: 60, width: 264, maxHeight: 220, overflowY: "auto", background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: 10, boxShadow: "0 10px 30px rgba(0,0,0,.14)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 };
const agentFeedHead: CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 800, color: "var(--ink)", letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 2 };
const agentFeedRow: CSSProperties = { display: "flex", alignItems: "center", gap: 7, fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.3 };
const agentFeedSpin: CSSProperties = { width: 10, height: 10, borderRadius: "50%", border: "2px solid var(--paper-edge)", borderTopColor: "var(--accent)", display: "inline-block" };
const agentFeedEngine: CSSProperties = { flexShrink: 0, fontSize: 9.5, fontWeight: 800, color: "var(--accent)", border: "1px solid var(--paper-edge)", borderRadius: 4, padding: "0 4px" };

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
const aiEditInput: CSSProperties = { width: "100%", marginTop: 8, padding: "8px 10px", border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", fontSize: 12, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" };
