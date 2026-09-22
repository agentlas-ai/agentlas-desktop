"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { IconCheck, IconClose } from "@/components/Icon";
import { PluginLogo, usePluginBrandMap } from "@/components/PluginLogo";
import {
  installPlugins,
  KeyStep,
  LoginStep,
  setupHintFor,
  usePluginCatalog,
  type KeyStepState,
  type LoginStepState,
} from "@/components/plugins/PluginPickerCore";
import styles from "./WorkFirstRunOnboarding.module.css";

type Experience = "beginner" | "intermediate" | "expert";
type Provider = "codex" | "claude-code" | "antigravity";

/** Product tour followed by optional tools. Browser import lives at first browser use. */
const LAST_STEP = 7;
const STEPS = [1, 2, 3, 4, 5, 6, 7];

/** 검색 전에 보여주는 도구 타일 수. 나머지는 "더 보기"가 맡는다. */
const TOOL_TILES = 18;

/** Keep completed onboarding state across the browser-step removal. */
const STORAGE_KEY = "agentlas.work.firstRunOnboarding.v3";
/** Legacy credentials and plugins phases both resume at optional tools. */
const PHASE_KEY = "agentlas.work.firstRunOnboarding.v3.phase";

const PROVIDERS: Array<{ id: Provider; label: string; logo: string; cli: "codex" | "claude-code" | "antigravity" }> = [
  { id: "codex", label: "GPT / Codex", logo: "/brand/llm/openai.svg", cli: "codex" },
  { id: "claude-code", label: "Claude", logo: "/brand/llm/claude.svg", cli: "claude-code" },
  { id: "antigravity", label: "Antigravity", logo: "/brand/llm/googlegemini.svg", cli: "antigravity" },
];

export function WorkFirstRunOnboarding({ onVisibilityChange }: { onVisibilityChange?: (visible: boolean) => void }) {
  const { locale, setPref } = useT();
  const router = useRouter();
  const ko = locale === "ko";
  const [open, setOpen] = useState(false);
  const [offerTour, setOfferTour] = useState(false);
  const [step, setStep] = useState(1);
  const [experience, setExperience] = useState<Experience | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectPhase, setConnectPhase] = useState<"installing" | "loggingIn" | "checking">("checking");
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Optional tools reuse the Connect plugin picker.
  const brandMap = usePluginBrandMap();
  const catalog = usePluginCatalog({ enabled: open && step >= 6 });
  const [toolQuery, setToolQuery] = useState("");
  const [toolPicked, setToolPicked] = useState<Set<string>>(new Set());
  const [toolExpanded, setToolExpanded] = useState(false);
  const [toolBusy, setToolBusy] = useState(false);
  const [toolProgress, setToolProgress] = useState<string | null>(null);
  const [toolNote, setToolNote] = useState<string | null>(null);
  const [loginStage, setLoginStage] = useState<LoginStepState | null>(null);
  const [keyStage, setKeyStage] = useState<KeyStepState | null>(null);

  useEffect(() => {
    let seen = false;
    let saved: string | null = null;
    try {
      seen = window.localStorage.getItem(STORAGE_KEY) === "1";
      saved = window.localStorage.getItem(PHASE_KEY);
    } catch { /* private mode */ }
    if (seen) return;
    if (saved === "credentials" || saved === "plugins") setStep(LAST_STEP);
    setOfferTour(true);
  }, []);

  useEffect(() => onVisibilityChange?.(open), [onVisibilityChange, open]);

  /** 세팅 단계에 도달한 사실을 남긴다 — 여기서 앱을 닫아도 설명을 다시 보지 않는다. */
  useEffect(() => {
    if (!open) return;
    try {
      if (step === LAST_STEP) window.localStorage.setItem(PHASE_KEY, "plugins");
    } catch { /* ignore */ }
  }, [open, step]);

  const copy = useMemo(() => ko ? {
    label: "처음 사용 안내", next: "다음", back: "뒤로", close: "나중에 보기", finish: "이제 시작할게요",
    s1: "AI를 얼마나 활용해 보셨나요?", s1sub: "당신에게 맞는 시작 경로를 준비해 드릴게요.",
    beginner: "초보자", beginnerSub: "무료 GPT만 써봤어요", intermediate: "중급자", intermediateSub: "유료로 AI를 쓰고 있어요", expert: "익스퍼트", expertSub: "Claude Code·Codex를 쓸 줄 알아요",
    s2: "AI로 작업하고 에이전트를 사용하려면 계정을 연결해야 해요.", s2sub: "사용할 AI를 하나 선택하면 공식 로그인 화면을 열어드릴게요.", connect: "로그인하고 연결하기", checking: "연결 상태 확인 중…", installing: "준비하는 중… 처음 한 번만 1~2분 걸려요", loggingIn: "열린 창에서 로그인해 주세요", connected: "연결됐어요", continue: "연결하지 않고 계속",
    s3: "Agentlas는 에이전트를 만들고, 작업을 자동화하고, 팀과 공유하는 플랫폼이에요.", s3sub: "복잡한 기술을 직접 조립하지 않아도 결과 중심으로 시작할 수 있어요.",
    build: "에이전트 빌드", buildSub: "필요한 역할을 직접 만들어요.", automation: "자동화", automationSub: "자연어로 반복 작업을 맡겨요.", hub: "Agent Hub", hubSub: "검증된 에이전트를 팀에 데려와요.",
    s4: "바이브코딩 에이전트가 무료로 제공돼요.", s4sub: "필요한 역할이 위에서부터 연결되고, 하나의 팀으로 일을 시작합니다.",
    s5: "Agentlas의 주요 공간을 한 번에 볼게요.", workspace: "작업공간", workspaceSub: "프로젝트를 만들고 에이전트를 조합해 작업을 완성해요.", agentHub: "Agent Hub", agentHubSub: "다른 사람들이 만든 에이전트를 우리 팀에 합류시켜요.", automationNav: "자동화", automationNavSub: "자연어로 에이전트 기반 작업 흐름을 만들고 실행해요.", connectNav: "커넥트", connectNavSub: "텔레그램과 브라우저 로그인을 연결해요.", cloud: "에이전트 클라우드", cloudSub: "에이전트를 만들고 다른 컴퓨터에서도 사용해요.", settings: "환경설정", settingsSub: "Gmail·Notion·커스텀 MCP를 등록해요.",
    s6: "Agentlas는 모바일에서도 사용할 수 있어요.", s6sub: "App Store와 Play Store에서 Agentlas를 설치한 뒤, 환경설정에서 새 기기 연결을 눌러 QR 코드로 연결하세요.",
    s8: "매일 쓰는 서비스가 뭐예요?", s8sub: "고른 것은 모든 에이전트가 함께 씁니다. 나중에 환경설정에서 더 추가할 수 있어요.",
    s8search: "서비스 이름으로 찾기", s8loading: "목록을 불러오는 중…", s8empty: "표시할 서비스가 없어요.", s8none: "찾는 이름과 맞는 서비스가 없어요.",
    s8installed: "이미 연결됨", s8adding: "추가하는 중…", s8skip: "이대로 시작하기", s8more: "더 보기",
  } : {
    label: "Getting started", next: "Next", back: "Back", close: "Later", finish: "Let's get started",
    s1: "How familiar are you with AI?", s1sub: "We will prepare the right starting path for you.",
    beginner: "Beginner", beginnerSub: "I have only used free GPT", intermediate: "Intermediate", intermediateSub: "I already pay for an AI", expert: "Expert", expertSub: "I use Claude Code or Codex",
    s2: "To work with AI and agents, you need to connect an account.", s2sub: "Choose one AI and we will open its official login flow.", connect: "Log in and connect", checking: "Checking connection…", installing: "Getting ready… first time only, 1–2 minutes", loggingIn: "Log in in the window that opened", connected: "Connected", continue: "Continue without connecting",
    s3: "Agentlas is a platform for building agents, automating work, and sharing teams.", s3sub: "Start with the outcome instead of assembling complex technical pieces.",
    build: "Agent Build", buildSub: "Create the role you need.", automation: "Automation", automationSub: "Delegate repeatable work in natural language.", hub: "Agent Hub", hubSub: "Bring proven agents into your team.",
    s4: "Vibe-coding agents are included for free.", s4sub: "Roles connect from the top down and become a team ready to work.",
    s5: "Here is the rest of Agentlas at a glance.", workspace: "Workspace", workspaceSub: "Create projects, combine agents, and finish robustly.", agentHub: "Agent Hub", agentHubSub: "Bring agents made by others into your team.", automationNav: "Automation", automationNavSub: "Create and run agent workflows in natural language.", connectNav: "Connect", connectNavSub: "Connect Telegram and save browser logins.", cloud: "Agent Cloud", cloudSub: "Build agents and use them from another computer.", settings: "Settings", settingsSub: "Register Gmail, Notion, or custom MCPs.",
    s6: "Agentlas also works on mobile.", s6sub: "Install Agentlas from the App Store or Play Store, then choose Connect new device in Settings and scan the QR code.",
    s8: "What do you use every day?", s8sub: "Every agent shares what you pick. You can add more later in Settings.",
    s8search: "Find a service by name", s8loading: "Loading…", s8empty: "Nothing to show yet.", s8none: "No service matches that name.",
    s8installed: "Already connected", s8adding: "Adding…", s8skip: "Start without any", s8more: "Show more",
  }, [ko]);

  /** 온보딩 전체가 끝났다. 이 표시가 있어야만 다음 실행에서 다시 뜨지 않는다. */
  const finish = useCallback(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
      window.localStorage.removeItem(PHASE_KEY);
    } catch { /* ignore */ }
    setOpen(false);
    setOfferTour(false);
  }, []);

  /**
   * "나중에 보기" — 닫되 **완료로 표시하지 않는다**.
   *
   * ★왜 (QA 실측 2026-09-08): × 를 누르면 닫히지 않고 7단계로 넘어갔다
   *   (`step < 7 ? setStep(7) : finish()`). 닫기라고 쓰여 있는 것이 닫지 않으면
   *   사람은 자기가 잘못 눌렀다고 생각하고 다시 누른다.
   *
   * finish() 와 다른 점: finish 는 "다 봤다"고 기록해 다시 안 뜬다. × 의 라벨은
   * "나중에 보기"이므로 다시 볼 수 있어야 한다. 진행 단계(PHASE_KEY)는 남겨
   * 다음에 열 때 보던 자리에서 이어진다.
   */
  const dismiss = useCallback(() => {
    setOpen(false);
  }, []);

  /*
   * ★전체 화면 안내는 Escape 로도 닫혀야 한다 (실측 2026-09-08).
   *   × 는 고쳤지만 키보드로 나가는 길은 여전히 없었다. dismiss() 와 같은 뜻이다 —
   *   닫되 완료로 표시하지 않으므로 나중에 다시 볼 수 있다.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) return;
      event.stopPropagation();
      dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dismiss]);

  const chooseExperience = (next: Experience) => {
    setExperience(next);
    setStep(next === "beginner" ? 2 : 5);
  };

  const connectProvider = async (next: Provider) => {
    const selected = PROVIDERS.find((item) => item.id === next);
    if (!selected || connecting) return;
    setProvider(next); setConnecting(true); setConnectionError(null); setConnected(false);
    try {
      const api = ipc();
      if (selected.cli !== "antigravity") {
        setConnectPhase("installing");
        const installed = await api?.runtime.installCli(selected.cli);
        if (!installed?.ok) throw new Error(installed?.message || "installation failed");
      }
      setConnectPhase("loggingIn");
      const result = await api?.runtime.openCliLogin(selected.cli);
      if (!result?.ok) throw new Error(result?.message || "connection failed");
      let detected = false;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const runtimes = await api?.runtime.detect(true);
        if (runtimes?.some((runtime) => runtime.kind === selected.cli)) { detected = true; setConnected(true); setStep(3); break; }
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      }
      if (!detected) setConnectionError(ko ? "로그인은 끝났지만 아직 연결 상태를 확인하지 못했어요. 설정에서 다시 확인할 수 있어요." : "Login finished, but the connection has not been verified yet. You can check again in Settings.");
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "connection failed");
    } finally { setConnecting(false); setConnectPhase("checking"); }
  };

  const toolMatches = useMemo(() => {
    const needle = toolQuery.trim().toLowerCase();
    if (!needle) return catalog.listings;
    return catalog.listings.filter((listing) =>
      [listing.name, listing.slug, listing.tagline, listing.category, listing.developer]
        .filter(Boolean).join(" ").toLowerCase().includes(needle));
  }, [catalog.listings, toolQuery]);

  // 처음에는 허브가 대표로 고른 것부터. 검색을 시작하면 그 축소는 의미가 없다 —
  // 사용자가 이미 목표를 말했기 때문이다.
  const toolNarrowed = !toolExpanded && !toolQuery.trim();
  const visibleTools = useMemo(() => {
    if (!toolNarrowed) return toolMatches;
    const featured = toolMatches.filter((listing) => listing.featured);
    const rest = toolMatches.filter((listing) => !listing.featured);
    return [...featured, ...rest].slice(0, TOOL_TILES);
  }, [toolMatches, toolNarrowed]);

  const toggleTool = (slug: string) => {
    setToolPicked((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  /** 고른 도구를 설치한다. 아무것도 고르지 않았으면 그대로 끝 — 그게 건너뛰기다. */
  const handleToolsNext = async () => {
    if (toolBusy) return;
    const chosen = catalog.listings.filter((listing) => toolPicked.has(listing.slug));
    if (chosen.length === 0) { finish(); return; }
    setToolBusy(true);
    setToolNote(null);
    let outcome: Awaited<ReturnType<typeof installPlugins>>;
    try {
      outcome = await installPlugins({ chosen, ko, onProgress: setToolProgress });
    } finally {
      setToolBusy(false);
    }
    await catalog.refresh();

    // 로그인이 먼저다. 키 입력은 사용자가 다른 사이트를 다녀와야 할 수도 있어
    // 흐름이 길어지는데, 로그인은 대개 클릭 두 번이라 여기서 끝내는 편이 낫다.
    if (outcome.needLogin.length > 0) {
      setLoginStage({ queue: outcome.needLogin, index: 0, keyQueue: outcome.needKeys, result: outcome.result });
      return;
    }
    if (outcome.needKeys.length > 0) {
      setKeyStage({ queue: outcome.needKeys, index: 0, result: outcome.result });
      return;
    }
    if (outcome.result.skipped.length > 0) {
      // 붙지 않은 것을 조용히 넘기지 않는다. 선택은 비워지므로 다음을 한 번 더 누르면 끝난다.
      setToolNote(outcome.result.skipped.map((row) => `${row.slug}: ${row.reason}`).join(" · "));
      setToolPicked(new Set());
      return;
    }
    finish();
  };

  if (!open) return offerTour ? <button type="button" onClick={() => setOpen(true)} style={{ position: "fixed", top: 12, right: 20, zIndex: 30, height: 32, padding: "0 12px", border: "1px solid var(--paper-edge)", borderRadius: 15, background: "var(--paper)", color: "var(--ink-soft)", fontSize: 12, fontWeight: 400, cursor: "pointer", WebkitAppRegion: "no-drag" } as CSSProperties}>{ko ? "처음 사용 안내" : "Getting started"}</button> : null;

  const inToolStage = Boolean(loginStage || keyStage);
  const menuItems = [
    [copy.workspace, copy.workspaceSub], [copy.agentHub, copy.agentHubSub], [copy.automationNav, copy.automationNavSub],
    [copy.connectNav, copy.connectNavSub], [copy.cloud, copy.cloudSub], [copy.settings, copy.settingsSub],
  ];

  const goBack = () => {
    setStep((current) => {
      if (current === 5 && experience !== "beginner") return 1;
      return Math.max(1, current - 1);
    });
  };

  const goNext = () => {
    if (step === LAST_STEP) { void handleToolsNext(); return; }
    setStep((current) => Math.min(LAST_STEP, current + 1));
  };

  const nextLabel = step === LAST_STEP
      ? (toolBusy
        ? copy.s8adding
        : toolPicked.size > 0
          ? (ko ? `${toolPicked.size}개로 계속` : `Continue with ${toolPicked.size}`)
          : copy.s8skip)
      : copy.next;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="work-onboarding-title">
      <section className={styles.panel}>
        <header className={styles.header}>
          <div className={styles.brand}><strong>Agentlas</strong><span>Work</span></div>
          <div className={styles.headerCenter}><span className={styles.eyebrow}>{copy.label}</span><div className={styles.progress}>{STEPS.map((item) => <span key={item} data-current={step === item} data-done={step > item} />)}</div></div>
          {/* × 는 현재 단계에서 온보딩을 닫는다.
              세팅 각 단계는 아무것도 고르지 않고 다음을 눌러 건너뛸 수도 있다. */}
          <div className={styles.headerActions}><button
            className={styles.language}
            type="button"
            /* ★이 단추에는 onClick 이 없었다 — 눌러도 아무 일도 안 일어나는 죽은 단추였다
               (한국어 화면 훑기 2026-09-08). 지금 언어의 반대를 눌러 바꾼다. */
            onClick={() => setPref(ko ? "en" : "ko")}
            aria-label={ko ? "English 로 바꾸기" : "한국어로 바꾸기"}
          >{ko ? "KO · EN" : "EN · KO"}</button><button className={styles.close} onClick={dismiss} aria-label={copy.close}><IconClose size={16} /></button></div>
        </header>
        <main className={styles.content}>
          {step === 1 && <><h1 id="work-onboarding-title">{copy.s1}</h1><p>{copy.s1sub}</p><div className={styles.choiceGrid}>{(["beginner", "intermediate", "expert"] as Experience[]).map((item) => <button key={item} className={`${styles.choice} ${experience === item ? styles.selected : ""}`} onClick={() => chooseExperience(item)}><div className={styles.choiceIllustration}>{item === "beginner" ? "01" : item === "intermediate" ? "02" : "03"}</div><strong>{copy[item]}</strong><small>{copy[`${item}Sub` as "beginnerSub" | "intermediateSub" | "expertSub"]}</small></button>)}</div></>}
          {step === 2 && <><h1>{copy.s2}</h1><p>{copy.s2sub}</p><div className={styles.providerGrid}>{PROVIDERS.map((item) => <button key={item.id} className={`${styles.provider} ${provider === item.id ? styles.selected : ""}`} onClick={() => void connectProvider(item.id)} disabled={connecting}><img src={item.logo} alt="" /><strong>{item.label}</strong><span>{provider === item.id && connecting ? copy[connectPhase] : copy.connect}</span></button>)}</div>{connectionError && <p className={styles.error}>{connectionError}</p>}<button className={styles.textButton} onClick={() => setStep(3)}>{copy.continue}</button></>}
          {step === 3 && <><h1>{copy.s3}</h1><p>{copy.s3sub}</p>{connected && <div className={styles.success}>{copy.connected}</div>}<div className={styles.featureGrid}><Feature title={copy.build} body={copy.buildSub} image="/brand/agentlas-mark.png" /><Feature title={copy.automation} body={copy.automationSub} image="/apps/document-studio.png" /><Feature title={copy.hub} body={copy.hubSub} image="/brand/agentlas-mark.png" /></div></>}
          {step === 4 && <><h1>{copy.s4}</h1><p>{copy.s4sub}</p><div className={styles.orgAnimation}><div className={styles.orgNode}>Agentlas Orchestrator</div><i /><div className={styles.orgRow}><span>Frontend</span><span>Backend</span><span>QA</span><span>Copy</span></div></div></>}
          {step === 5 && <><h1>{copy.s5}</h1><div className={styles.menuTour}><div className={styles.menuMock}>{menuItems.map(([title]) => <div key={title} className={styles.menuMockItem}>{title}</div>)}</div><div className={styles.menuDescriptions}>{menuItems.map(([title, body], index) => <div key={title} className={styles.menuDescription} style={{ animationDelay: `${index * 180}ms` }}><b>{title}</b><span>{body}</span></div>)}</div></div></>}
          {step === 6 && <><h1>{copy.s6}</h1><p>{copy.s6sub}</p><div className={styles.mobileCard}><div className={styles.mobileIcon}>QR</div><div><strong>Agentlas Mobile</strong><span>iOS · Android</span></div></div></>}

          {step === LAST_STEP && !inToolStage && (
            <>
              <h1>{copy.s8}</h1>
              <p>{copy.s8sub}</p>

              <div className={styles.searchRow}>
                <label className={styles.srOnly} htmlFor="onboarding-tool-search">{copy.s8search}</label>
                <input
                  id="onboarding-tool-search"
                  className={styles.searchInput}
                  value={toolQuery}
                  onChange={(event) => setToolQuery(event.target.value)}
                  placeholder={copy.s8search}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {!catalog.loaded && <p className={styles.stepNote}>{copy.s8loading}</p>}
              {catalog.loaded && catalog.loadError && <p className={styles.stepError}>{catalog.loadError}</p>}
              {catalog.loaded && !catalog.loadError && visibleTools.length === 0 && (
                <p className={styles.stepNote}>{toolQuery.trim() ? copy.s8none : copy.s8empty}</p>
              )}

              {visibleTools.length > 0 && (
                <div className={styles.tileGrid}>
                  {visibleTools.map((listing) => {
                    const picked = toolPicked.has(listing.slug);
                    const already = catalog.isInstalled(listing);
                    const hint = setupHintFor({ listing, ko, hasLogin: catalog.hasBrowserLogin(listing) });
                    return (
                      <button
                        key={listing.slug}
                        type="button"
                        className={styles.tile}
                        data-selected={picked}
                        aria-pressed={picked}
                        disabled={toolBusy}
                        onClick={() => toggleTool(listing.slug)}
                      >
                        <PluginLogo slug={listing.slug} name={listing.name} size={38} brandColor={listing.brandColor} brandMap={brandMap} />
                        <strong className={styles.tileName}>{listing.name}</strong>
                        {already
                          ? <span className={styles.tileHint} data-tone="ready">{copy.s8installed}</span>
                          : hint
                            ? <span className={styles.tileHint} data-tone={hint.tone}>{hint.text}</span>
                            : <small className={styles.tileMeta} title={listing.tagline}>{listing.tagline}</small>}
                        {picked && <span className={styles.tileCheck} aria-hidden="true"><IconCheck size={13} /></span>}
                      </button>
                    );
                  })}
                </div>
              )}

              {toolNarrowed && toolMatches.length > visibleTools.length && (
                <button type="button" className={styles.moreButton} onClick={() => setToolExpanded(true)}>
                  {`${copy.s8more} (${toolMatches.length - visibleTools.length})`}
                </button>
              )}

              {toolBusy && toolProgress && <p className={styles.stepNote}>{`${copy.s8adding} ${toolProgress}`}</p>}
              {toolNote && <p className={styles.stepNote}>{toolNote}</p>}
            </>
          )}

          {/* 설치 뒤 후속 단계(로그인·키)도 같은 화면 안에서 이어진다 — 팝업으로 튀어
              나가지 않는다. 이 단계에는 자기 버튼이 있어서 푸터의 다음은 잠시 물러난다. */}
          {loginStage && (
            <LoginStep
              ko={ko}
              chrome="inline"
              state={loginStage}
              brandMap={brandMap}
              onDone={(result, keyQueue) => {
                setLoginStage(null);
                if (keyQueue.length > 0) { setKeyStage({ queue: keyQueue, index: 0, result }); return; }
                finish();
              }}
              onAdvance={setLoginStage}
            />
          )}
          {keyStage && (
            <KeyStep
              ko={ko}
              chrome="inline"
              state={keyStage}
              brandMap={brandMap}
              onDone={() => { setKeyStage(null); finish(); }}
              onAdvance={setKeyStage}
            />
          )}
        </main>
        <footer className={styles.footer}>
          <button className={styles.back} onClick={goBack} disabled={step === 1 || toolBusy || inToolStage}>{copy.back}</button>
          {!inToolStage && (
            <button
              className={styles.next}
              onClick={goNext}
              disabled={(step === 1 && !experience) || toolBusy}
            >
              {nextLabel}
            </button>
          )}
        </footer>
        <nav className={styles.productNav} aria-label="Agentlas product navigation">
          {/*
            * 이 줄은 **실제 좌측 내비게이션을 그린 그림**이다. 진짜 내비게이션은 번역되는데
            * 여기 사본만 영어로 박혀 있어서, 한국어 사용자는 첫 화면에서 자기가 보게 될
            * 것과 다른 메뉴를 배운다(한국어 화면 훑기 2026-09-08).
            * One·Work 는 제품 이름이라 두 언어에서 같다.
            */}
          {([
            ["⌂", "One", "One"],
            ["◎", "Agents", "에이전트"],
            ["◉", "Work", "Work"],
            ["ϟ", "Automations", "자동화"],
            ["⚙", "Settings", "설정"],
          ] as const).map(([icon, label, korean]) => (
            <span key={label} className={label === "Work" ? styles.activeNav : ""}>
              <b aria-hidden="true">{icon}</b>{ko ? korean : label}
            </span>
          ))}
        </nav>
      </section>
    </div>
  );
}

function Feature({ title, body, image }: { title: string; body: string; image: string }) {
  return <article className={styles.feature}><img src={image} alt="" /><strong>{title}</strong><span>{body}</span></article>;
}

/** 타일 앞머리 글자 — 로고가 없는 사이트에 가짜 그림을 만들지 않는다(정직한 공백). */
function initialOf(domain: string): string {
  const match = domain.replace(/^www\./, "").match(/[a-z0-9]/i);
  return (match?.[0] ?? "?").toUpperCase();
}
