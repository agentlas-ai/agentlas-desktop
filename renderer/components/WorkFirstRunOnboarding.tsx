"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { IconCheck, IconClose } from "@/components/Icon";
import { PluginLogo, usePluginBrandMap } from "@/components/PluginLogo";
import { openPricing } from "@/components/UpgradeCta";
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

/*
 * ★ 2026-09-24 개편 (오너 지시: Aside 온보딩 벤치마킹).
 *   예전 7단계 투어는 결제로 이어지는 단계가 하나도 없었고, 모델 선택지에 Agentlas 자체 모델이
 *   빠져 있었으며, "익스퍼트"를 고르면 모델 연결을 통째로 건너뛰었다(setStep(5)).
 *   이제 첫 질문은 "어떤 AI로 일할까요?" 하나다. Agentlas 가 맨 위에 추천으로 오고, 구독을 가진
 *   사람은 그 구독을 연결한다. Agentlas 를 고르면 공개 요금제를 비교한다.
 */
type Choice =
  | "agentlas"
  | "claude-code"
  | "codex"
  | "antigravity"
  | "grok"
  | "kimi"
  | "cursor"
  | "copilot"
  | "local"
  | "api-key";
type CliKind = "claude-code" | "codex" | "antigravity" | "grok" | "kimi";

/** Choose AI → the essentials → optional tools. */
const LAST_STEP = 3;
const STEPS = [1, 2, 3];

/** 검색 전에 보여주는 도구 타일 수. 나머지는 "더 보기"가 맡는다. */
const TOOL_TILES = 18;

/** Keep completed onboarding state: people who finished the old tour are not asked again. */
const STORAGE_KEY = "agentlas.work.firstRunOnboarding.v3";
/** Legacy credentials and plugins phases both resume at optional tools. */
const PHASE_KEY = "agentlas.work.firstRunOnboarding.v3.phase";

type ChoiceRow = {
  id: Choice;
  logo: string;
  /** 연결 방법. cli = 설치·로그인을 이 화면에서, route = 그 설정 화면으로 보낸다. */
  connect: { kind: "agentlas" } | { kind: "cli"; cli: CliKind; installable: boolean } | { kind: "route"; href: string };
};

const PRIMARY_CHOICES: ChoiceRow[] = [
  { id: "agentlas", logo: "/brand/agentlas-mark.png", connect: { kind: "agentlas" } },
  { id: "claude-code", logo: "/brand/llm/claude.svg", connect: { kind: "cli", cli: "claude-code", installable: true } },
  { id: "codex", logo: "/brand/llm/openai.svg", connect: { kind: "cli", cli: "codex", installable: true } },
];

const MORE_CHOICES: ChoiceRow[] = [
  { id: "antigravity", logo: "/brand/llm/googlegemini.svg", connect: { kind: "cli", cli: "antigravity", installable: false } },
  { id: "grok", logo: "/brand/llm/x.svg", connect: { kind: "cli", cli: "grok", installable: true } },
  { id: "kimi", logo: "/brand/llm/kimi.svg", connect: { kind: "cli", cli: "kimi", installable: true } },
  { id: "cursor", logo: "/brand/llm/cursor.svg", connect: { kind: "route", href: "/dashboard" } },
  { id: "copilot", logo: "/brand/llm/githubcopilot.svg", connect: { kind: "route", href: "/dashboard" } },
  { id: "local", logo: "/brand/llm/ollama.svg", connect: { kind: "route", href: "/local-models" } },
  { id: "api-key", logo: "/brand/llm/openai.svg", connect: { kind: "route", href: "/dashboard" } },
];

/* Agentlas 서빙 런타임 선택. detect.ts 가 로그인된 사람에게만 이 런타임을 내놓는다. */
const AGENTLAS_SELECTION = { kind: "agentlas", backend: "agentlas", source: "agentlas:serving", model: "agentlas-normal" } as const;

export function WorkFirstRunOnboarding({ onVisibilityChange }: { onVisibilityChange?: (visible: boolean) => void }) {
  const { locale, setPref } = useT();
  const router = useRouter();
  const ko = locale === "ko";
  const [open, setOpen] = useState(false);
  const [offerTour, setOfferTour] = useState(false);
  const [step, setStep] = useState(1);
  const [choice, setChoice] = useState<Choice>("agentlas");
  const [showMore, setShowMore] = useState(false);
  /** 연결 전에 한 번 더 확인하는 작은 창. Aside 처럼 무엇이 일어나는지 한 문장으로 말한다. */
  const [confirming, setConfirming] = useState<ChoiceRow | null>(null);
  /** Agentlas 를 고른 사람에게만 보이는 공개 요금제 비교. */
  const [planOpen, setPlanOpen] = useState(false);
  const confirmingRef = useRef<ChoiceRow | null>(null);
  const planOpenRef = useRef(false);
  confirmingRef.current = confirming;
  planOpenRef.current = planOpen;
  const [connecting, setConnecting] = useState(false);
  const [connectPhase, setConnectPhase] = useState<"installing" | "loggingIn" | "signingIn" | "checking">("checking");
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Optional tools reuse the Connect plugin picker.
  const brandMap = usePluginBrandMap();
  const catalog = usePluginCatalog({ enabled: open && step >= 2 });
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
    s1: "어떤 AI로 일할까요?", s1sub: "Agentlas 모델을 바로 쓰거나, 이미 가진 구독을 연결하세요.",
    recommended: "추천", showMore: "더 보기", showLess: "접기", connectCta: "연결하기", cancel: "취소",
    choices: {
      agentlas: ["Agentlas", "Agentlas 계정만 있으면 바로 시작 — 매달 무료 크레딧 포함"],
      "claude-code": ["Claude", "Claude Pro·Max 구독을 그대로 사용"],
      codex: ["ChatGPT", "ChatGPT Plus·Pro 구독을 그대로 사용"],
      antigravity: ["Gemini", "Google 계정으로 Antigravity 연결"],
      grok: ["Grok", "xAI 구독 연결"],
      kimi: ["Kimi Code", "Kimi 구독 연결"],
      cursor: ["Cursor", "Cursor 구독 연결 — 설정 화면에서"],
      copilot: ["GitHub Copilot", "Copilot 구독 연결 — 설정 화면에서"],
      local: ["로컬 모델", "이 컴퓨터에서 무료로 실행"],
      "api-key": ["내 API 키", "DeepSeek·GLM 등 API 키 등록"],
    } as Record<Choice, [string, string]>,
    confirmTitle: (name: string) => `${name} 연결`,
    confirmBody: (name: string) => `Agentlas가 ${name} 구독으로 작업합니다. 공식 로그인 화면에서 직접 로그인해 연결하세요. 비밀번호는 Agentlas에 저장되지 않아요.`,
    agentlasSignIn: "Agentlas 모델을 쓰려면 먼저 Agentlas 계정으로 로그인해 주세요. 브라우저가 열려요.",
    checking: "연결 상태 확인 중…", installing: "준비하는 중… 처음 한 번만 1~2분 걸려요", loggingIn: "열린 창에서 로그인해 주세요", signingIn: "브라우저에서 로그인해 주세요", connected: "연결됐어요", continue: "연결하지 않고 계속",
    planTitle: "Agentlas로 시작하기", planSub: "무료로 시작하고, 크레딧이 더 필요할 때 올리세요.",
    free: "Free", freeFor: "매일 쓰는 작업에", perForever: "/ 영원히",
    freeLines: ["내 AI 구독·키 연결 무제한", "Agentlas 크레딧 월 100", "Agent Hub 에이전트 무료 사용·공유", "비공개 클라우드 에이전트 20개", "Work 프로젝트당 에이전트·팀 3개"],
    freeCta: "무료로 시작", freeNote: "무료로 시작하고 언제든 올릴 수 있어요.",
    pro: "Pro", proFor: "길고 복잡한 작업에", perMonth: "/ 월",
    proLines: ["Free의 모든 것", "Agentlas 크레딧 월 7,600", "비공개 클라우드 에이전트 100개", "Work 프로젝트당 에이전트·팀 10개", "Alive Agent 사용 가능"],
    proCta: "구독하기", proNote: "결제는 agentlas.cloud에서 진행돼요.",
    max: "Max", maxFor: "큰 에이전트 컬렉션에",
    maxLines: ["Agentlas 크레딧 월 45,000", "비공개 클라우드 에이전트 500개", "Work 프로젝트당 에이전트·팀 20개", "Alive Agent 사용 가능"],
    wow: "WoW", wowFor: "가장 큰 작업 공간에",
    wowLines: ["Agentlas 크레딧 월 100,000", "비공개 클라우드 에이전트 2,500개", "Work 프로젝트당 에이전트·팀 32개", "Alive Agent 사용 가능"],
    s2: "Agentlas에서는 이렇게 일해요.", s2sub: "필요한 전문가가 팀으로 모이고, 결과까지 확인한 뒤 끝납니다.",
    build: "작업 공간", buildSub: "프로젝트를 만들고 결과를 말하면 팀이 꾸려져요.", automation: "자동화", automationSub: "반복 작업을 자연어로 맡겨요.", hub: "Agent Hub", hubSub: "다른 사람이 만든 에이전트를 무료로 데려와요.",
    mobile: "휴대폰에서도 이어서", mobileSub: "App Store·Play Store에서 Agentlas를 설치하고, 설정 → 새 기기 연결의 QR로 붙이세요.",
    s8: "매일 쓰는 서비스가 뭐예요?", s8sub: "고른 것은 모든 에이전트가 함께 씁니다. 나중에 환경설정에서 더 추가할 수 있어요.",
    s8search: "서비스 이름으로 찾기", s8loading: "목록을 불러오는 중…", s8empty: "표시할 서비스가 없어요.", s8none: "찾는 이름과 맞는 서비스가 없어요.",
    s8installed: "이미 연결됨", s8adding: "추가하는 중…", s8skip: "이대로 시작하기", s8more: "더 보기",
  } : {
    label: "Getting started", next: "Next", back: "Back", close: "Later", finish: "Let's get started",
    s1: "Choose your AI", s1sub: "Use the Agentlas model right away, or connect a subscription you already have.",
    recommended: "Recommended", showMore: "Show more options", showLess: "Show fewer", connectCta: "Connect", cancel: "Cancel",
    choices: {
      agentlas: ["Agentlas", "Just your Agentlas account — free monthly credits included"],
      "claude-code": ["Claude", "Reuse your Claude Pro or Max subscription"],
      codex: ["ChatGPT", "Reuse your ChatGPT Plus or Pro subscription"],
      antigravity: ["Gemini", "Connect Antigravity with your Google account"],
      grok: ["Grok", "Connect your xAI subscription"],
      kimi: ["Kimi Code", "Connect your Kimi subscription"],
      cursor: ["Cursor", "Connect your Cursor subscription in Settings"],
      copilot: ["GitHub Copilot", "Connect your Copilot subscription in Settings"],
      local: ["Local model", "Run for free on this computer"],
      "api-key": ["Your own API key", "Add an API key such as DeepSeek or GLM"],
    } as Record<Choice, [string, string]>,
    confirmTitle: (name: string) => `Connect with ${name}`,
    confirmBody: (name: string) => `Agentlas will use your ${name} subscription. Sign in on the official login screen to connect. Your password is never stored by Agentlas.`,
    agentlasSignIn: "Sign in to your Agentlas account to use the Agentlas model. Your browser will open.",
    checking: "Checking connection…", installing: "Getting ready… first time only, 1–2 minutes", loggingIn: "Log in in the window that opened", signingIn: "Sign in in your browser", connected: "Connected", continue: "Continue without connecting",
    planTitle: "Start with Agentlas", planSub: "Start free. Upgrade when you need more credits.",
    free: "Free", freeFor: "Best for daily tasks", perForever: "/ forever",
    freeLines: ["Bring your own AI subscription or key", "100 Agentlas credits per month", "Use and share Agent Hub agents for free", "20 private Cloud agents", "3 agents or teams per Work project"],
    freeCta: "Get started", freeNote: "Start free. Upgrade anytime.",
    pro: "Pro", proFor: "Best for longer, complex work", perMonth: "/ month",
    proLines: ["Everything in Free", "7,600 Agentlas credits per month", "100 private Cloud agents", "10 agents or teams per Work project", "Alive Agent included"],
    proCta: "Subscribe", proNote: "Checkout opens on agentlas.cloud.",
    max: "Max", maxFor: "For large agent collections",
    maxLines: ["45,000 Agentlas credits per month", "500 private Cloud agents", "20 agents or teams per Work project", "Alive Agent included"],
    wow: "WoW", wowFor: "For the largest workspaces",
    wowLines: ["100,000 Agentlas credits per month", "2,500 private Cloud agents", "32 agents or teams per Work project", "Alive Agent included"],
    s2: "Here is how work happens in Agentlas.", s2sub: "The right specialists assemble as a team, and the work ends only after it is checked.",
    build: "Workspace", buildSub: "Create a project, describe the result, and a team forms.", automation: "Automation", automationSub: "Delegate repeatable work in natural language.", hub: "Agent Hub", hubSub: "Bring in agents others made — free.",
    mobile: "Continue on your phone", mobileSub: "Install Agentlas from the App Store or Play Store, then scan the QR code in Settings → Connect new device.",
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
      // 위에 뜬 작은 창이 있으면 그것부터 닫는다. 요금제 창의 Escape 는 "무료로 시작"과 같다 —
      // 결제를 강요하지 않고 다음 단계로 간다.
      if (confirmingRef.current) { setConfirming(null); return; }
      if (planOpenRef.current) { setPlanOpen(false); setStep(2); return; }
      dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dismiss]);

  const rowOf = (id: Choice) => [...PRIMARY_CHOICES, ...MORE_CHOICES].find((row) => row.id === id) ?? PRIMARY_CHOICES[0];

  /** 설치(가능하면) → 공식 로그인 → 감지될 때까지 확인. 예전 흐름을 그대로 쓴다. */
  const connectCli = async (cli: CliKind, installable: boolean) => {
    const api = ipc();
    if (installable) {
      setConnectPhase("installing");
      const installed = await api?.runtime.installCli(cli as "claude-code" | "codex" | "kimi" | "grok");
      if (!installed?.ok) throw new Error(installed?.message || "installation failed");
    }
    setConnectPhase("loggingIn");
    const result = await api?.runtime.openCliLogin(cli);
    if (!result?.ok) throw new Error(result?.message || "connection failed");
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const runtimes = await api?.runtime.detect(true);
      if (runtimes?.some((runtime) => runtime.kind === cli)) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    }
    return false;
  };

  /*
   * Agentlas 모델은 로그인이 자격이다(detect.ts: 로그인하지 않으면 목록에 없다).
   * 로그인 → 서빙 런타임을 기본으로 → 요금제 비교.
   */
  const connectAgentlas = async () => {
    const api = ipc();
    const session = await api?.auth.getSession();
    if (!session?.signedIn) {
      setConnectPhase("signingIn");
      const signedIn = await api?.auth.signInWithBrowser();
      if (!signedIn?.signedIn) throw new Error(copy.agentlasSignIn);
    }
    const runtimes = await api?.runtime.detect(true);
    if (!runtimes?.some((runtime) => runtime.kind === "agentlas")) return false;
    await api?.runtime.setActive({ ...AGENTLAS_SELECTION });
    return true;
  };

  const connectChoice = async (row: ChoiceRow) => {
    if (connecting) return;
    if (row.connect.kind === "route") {
      // 이 화면에서 끝낼 수 없는 연결은 그 설정 화면으로 보낸다. 완료로 표시하지 않으므로
      // "처음 사용 안내"로 다시 돌아올 수 있다.
      dismiss();
      router.push(row.connect.href);
      return;
    }
    setConfirming(null);
    setConnecting(true); setConnectionError(null); setConnected(false);
    try {
      const ok = row.connect.kind === "agentlas"
        ? await connectAgentlas()
        : await connectCli(row.connect.cli, row.connect.installable);
      if (!ok) {
        setConnectionError(ko ? "로그인은 끝났지만 아직 연결 상태를 확인하지 못했어요. 설정에서 다시 확인할 수 있어요." : "Login finished, but the connection has not been verified yet. You can check again in Settings.");
        return;
      }
      setConnected(true);
      if (row.connect.kind === "agentlas") setPlanOpen(true);
      else setStep(2);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "connection failed");
    } finally { setConnecting(false); setConnectPhase("checking"); }
  };

  /** 하단 "연결하기": Agentlas 는 바로, 구독은 확인 창을 한 번 거친다. */
  const startConnect = () => {
    const row = rowOf(choice);
    if (row.connect.kind === "cli") { setConfirming(row); return; }
    void connectChoice(row);
  };

  const leavePlan = (subscribe: boolean) => {
    if (subscribe) openPricing();
    setPlanOpen(false);
    setStep(2);
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

  const goBack = () => setStep((current) => Math.max(1, current - 1));

  const goNext = () => {
    if (step === 1) { startConnect(); return; }
    if (step === LAST_STEP) { void handleToolsNext(); return; }
    setStep((current) => Math.min(LAST_STEP, current + 1));
  };

  const nextLabel = step === 1
    ? (connecting ? copy[connectPhase] : copy.connectCta)
    : step === LAST_STEP
      ? (toolBusy
        ? copy.s8adding
        : toolPicked.size > 0
          ? (ko ? `${toolPicked.size}개로 계속` : `Continue with ${toolPicked.size}`)
          : copy.s8skip)
      : copy.next;

  const renderChoice = (row: ChoiceRow) => {
    const [name, sub] = copy.choices[row.id];
    const selected = choice === row.id;
    return (
      <button
        key={row.id}
        type="button"
        role="radio"
        aria-checked={selected}
        className={styles.aiRow}
        data-selected={selected}
        disabled={connecting}
        onClick={() => setChoice(row.id)}
        onDoubleClick={() => { setChoice(row.id); if (row.connect.kind === "cli") setConfirming(row); else void connectChoice(row); }}
      >
        <img src={row.logo} alt="" />
        <span className={styles.aiText}>
          <strong>{name}{row.id === "agentlas" && <em className={styles.badge}>{copy.recommended}</em>}</strong>
          <small>{sub}</small>
        </span>
        <span className={styles.radio} aria-hidden="true" />
      </button>
    );
  };

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
          {step === 1 && (
            <>
              <h1 id="work-onboarding-title">{copy.s1}</h1>
              <p>{copy.s1sub}</p>
              <div className={styles.aiList} role="radiogroup" aria-labelledby="work-onboarding-title">
                {PRIMARY_CHOICES.map(renderChoice)}
                {showMore && MORE_CHOICES.map(renderChoice)}
              </div>
              <button type="button" className={styles.moreButton} onClick={() => setShowMore((value) => !value)}>
                {showMore ? copy.showLess : copy.showMore}
              </button>
              {connectionError && <p className={styles.error}>{connectionError}</p>}
              {connected && <div className={styles.success}>{copy.connected}</div>}
              <button className={styles.textButton} onClick={() => setStep(2)} disabled={connecting}>{copy.continue}</button>
            </>
          )}
          {step === 2 && (
            <>
              <h1>{copy.s2}</h1>
              <p>{copy.s2sub}</p>
              <div className={styles.featureGrid}>
                <Feature title={copy.build} body={copy.buildSub} image="/brand/agentlas-mark.png" />
                <Feature title={copy.automation} body={copy.automationSub} image="/apps/document-studio.png" />
                <Feature title={copy.hub} body={copy.hubSub} image="/brand/agentlas-mark.png" />
              </div>
              <div className={styles.mobileCard}><div className={styles.mobileIcon}>QR</div><div><strong>{copy.mobile}</strong><span>{copy.mobileSub}</span></div></div>
            </>
          )}

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
              disabled={connecting || toolBusy}
            >
              {nextLabel}
            </button>
          )}
        </footer>
        {confirming && (() => {
          const [name] = copy.choices[confirming.id];
          return (
            <div className={styles.modalScrim} role="presentation" onClick={() => setConfirming(null)}>
              <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="onboarding-confirm-title" onClick={(event) => event.stopPropagation()}>
                <img className={styles.modalLogo} src={confirming.logo} alt="" />
                <h2 id="onboarding-confirm-title">{copy.confirmTitle(name)}</h2>
                <p>{copy.confirmBody(name)}</p>
                <div className={styles.modalActions}>
                  <button type="button" className={styles.secondary} onClick={() => setConfirming(null)}>{copy.cancel}</button>
                  <button type="button" className={styles.next} onClick={() => void connectChoice(confirming)}>{copy.connectCta} ↗</button>
                </div>
              </div>
            </div>
          );
        })()}
        {planOpen && (
          <div className={styles.modalScrim} role="presentation">
            <div className={styles.planModal} role="dialog" aria-modal="true" aria-labelledby="onboarding-plan-title">
              <h2 id="onboarding-plan-title">{copy.planTitle}</h2>
              <p>{copy.planSub}</p>
              <div className={styles.planGrid}>
                <section className={styles.planCard}>
                  <header><strong>{copy.free}</strong><span>{copy.freeFor}</span></header>
                  <div className={styles.price}><b>$0</b><span>{copy.perForever}</span></div>
                  <ul>{copy.freeLines.map((line) => <li key={line}><IconCheck size={13} />{line}</li>)}</ul>
                  <button type="button" className={styles.secondary} onClick={() => leavePlan(false)}>{copy.freeCta}</button>
                  <small>{copy.freeNote}</small>
                </section>
                <section className={styles.planCard} data-highlight="true">
                  <header><strong>{copy.pro}</strong><span>{copy.proFor}</span></header>
                  <div className={styles.price}><b>$19</b><span>{copy.perMonth}</span></div>
                  <ul>{copy.proLines.map((line) => <li key={line}><IconCheck size={13} />{line}</li>)}</ul>
                  <button type="button" className={styles.next} onClick={() => leavePlan(true)}>{copy.proCta}</button>
                  <small>{copy.proNote}</small>
                </section>
                <section className={styles.planCard}>
                  <header><strong>{copy.max}</strong><span>{copy.maxFor}</span></header>
                  <div className={styles.price}><b>$99</b><span>{copy.perMonth}</span></div>
                  <ul>{copy.maxLines.map((line) => <li key={line}><IconCheck size={13} />{line}</li>)}</ul>
                  <button type="button" className={styles.next} onClick={() => leavePlan(true)}>{copy.proCta}</button>
                  <small>{copy.proNote}</small>
                </section>
                <section className={styles.planCard}>
                  <header><strong>{copy.wow}</strong><span>{copy.wowFor}</span></header>
                  <div className={styles.price}><b>$200</b><span>{copy.perMonth}</span></div>
                  <ul>{copy.wowLines.map((line) => <li key={line}><IconCheck size={13} />{line}</li>)}</ul>
                  <button type="button" className={styles.next} onClick={() => leavePlan(true)}>{copy.proCta}</button>
                  <small>{copy.proNote}</small>
                </section>
              </div>
            </div>
          </div>
        )}
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
