"use client";

import { browserLoginImportDiagnostic, browserLoginImportNotice } from "@/lib/browser-login-import-notice";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { DiscoveredBrowserProfile, DiscoveredCredentialDomain } from "@/lib/types";
import { siteDisplayName } from "@shared/registrable-domain";
import styles from "./WorkFirstRunOnboarding.module.css";

type Experience = "beginner" | "intermediate" | "expert";
type Provider = "codex" | "claude-code" | "antigravity";

/**
 * 처음 실행 온보딩 — 설명(1~6)과 세팅(7~8)이 **하나의 전체화면**으로 이어진다.
 *
 * 예전에는 "tour" 하나뿐이었고, 마지막 화면에서 다음이나 건너뛰기를 누르면 창이 그냥
 * 닫혔다. 즉 앱을 처음 연 사람은 제품 설명만 듣고 아무것도 연결되지 않은 빈 앱 앞에
 * 남겨졌다 — 그다음에 무엇을 해야 하는지는 스스로 찾아야 했고, 브라우저 로그인과 도구
 * 연결은 설정 화면 깊숙이 있어 대부분 그대로 지나갔다.
 *
 * 그래서 설명이 끝나는 자리를 종료가 아니라 세팅의 시작으로 바꿨다. 그 세팅을 처음에는
 * 팝업(자격증명 다이얼로그 → 도구 다이얼로그)으로 띄웠는데, 이미 흰 전체화면이 열려 있는
 * 위에 창이 또 뜨니 사용자 입장에서는 흐름이 거기서 한 번 끊긴다 — 진행 표시도, 뒤로
 * 가는 길도 갑자기 다른 물건이 된다. 지금은 같은 화면의 7·8단계로 이어 붙였고, 헤더의
 * 진행 점과 푸터의 뒤로/다음이 처음부터 끝까지 같은 자리에 있다.
 *
 * 팝업 자체는 사라지지 않았다. Connect 화면과 설정 화면에서 버튼으로 여는 길은 그대로
 * 팝업이다(그 자리에서는 전체화면이 아니라 팝업이 맞다). 온보딩만 팝업을 쓰지 않는다.
 *
 * 세팅 각 단계는 여전히 건너뛸 수 있다 — 아무것도 고르지 않고 다음을 누르면 그게
 * 건너뛰기다(강제하지 않는다).
 */

/** 마지막 스텝. 1~6 설명, 7 로그인 가져오기, 8 도구 고르기. */
const LAST_STEP = 8;
const STEPS = [1, 2, 3, 4, 5, 6, 7, 8];

/** 검색 전에 보여주는 도구 타일 수. 나머지는 "더 보기"가 맡는다. */
const TOOL_TILES = 18;

/**
 * 검색 전에 보여주는 사이트 타일 수. 나머지는 "더 보기"가 맡는다.
 *
 * 실측(2026-08-20 dev QA): 이 오너의 Chrome 하나에서 113줄이 한꺼번에 그려져 화면을
 * 여덟 번 넘게 굴려야 끝이 났다. 목록은 방문 횟수 순이라 실제로 쓰는 곳은 앞쪽에
 * 모여 있고, 뒤쪽은 한 번 들어가 본 곳이다. 도구 스텝(18칸)과 같은 규칙으로 줄인다.
 */
const SITE_TILES = 18;

/**
 * 버전을 v2에서 올린 이유: 이 세팅 흐름은 기존 사용자도 한 번은 거쳐야 한다. 기존 키를
 * 그대로 두면 이미 앱을 쓰던 사람은 브라우저 자격증명도 도구 선택도 영영 못 본다.
 * 키가 바뀌면 업데이트 후 첫 실행에서 한 번 뜨고, 끝내면 다시 뜨지 않는다.
 */
const STORAGE_KEY = "agentlas.work.firstRunOnboarding.v3";
/**
 * 못 끝낸 지점. 세팅 도중 앱을 닫은 사람에게 제품 설명을 처음부터 다시 보게 하면
 * 그 사람은 두 번째에도 끝까지 가지 않는다 — 멈춘 자리에서 다시 연다.
 * 값이 "credentials"/"plugins" 인 것은 팝업이던 시절과 같다: 그때 멈춘 사람이 업데이트
 * 뒤에 열어도 같은 자리(7·8단계)에서 이어진다.
 */
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
  const [step, setStep] = useState(1);
  const [experience, setExperience] = useState<Experience | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // ── 7단계: 브라우저에 이미 있는 로그인 ─────────────────────────────────────
  //
  // TODO(온보딩/Connect 합치기): 같은 preload 호출(browser.scanCredentials ·
  // browser.importCredentials)을 Connect의 CredentialImportDialog 도 한다. 지금은
  // 그 파일을 다른 작업이 고치는 중이라 건드리지 않고 여기서 직접 부른다. 그 작업이
  // 끝나면 도구 쪽(PluginPickerCore)처럼 "목록 + 선택 + 실행"만 뽑아 한 벌로 합칠 것.
  //
  // 목록은 메인이 준 배열을 그대로 그린다. 어떤 행이 오는지(필터 규칙)는 메인이 정하고
  // 이 화면은 그 판단을 다시 하지 않는다 — 여기서 조건을 하나 더 걸면 두 곳의 규칙이
  // 조용히 갈린다. 쿠키 개수 같은 내부 수치는 앞세우지 않는다: 사용자가 알아보는 것은
  // 사이트 이름과 주소다.
  const [siteProfiles, setSiteProfiles] = useState<DiscoveredBrowserProfile[]>([]);
  const [siteProfileId, setSiteProfileId] = useState<string | null>(null);
  const [sites, setSites] = useState<DiscoveredCredentialDomain[]>([]);
  const [sitePicked, setSitePicked] = useState<Set<string>>(new Set());
  const [siteQuery, setSiteQuery] = useState("");
  const [siteExpanded, setSiteExpanded] = useState(false);
  const [siteScanning, setSiteScanning] = useState(false);
  const [siteBusy, setSiteBusy] = useState(false);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [siteNote, setSiteNote] = useState<string | null>(null);
  const [siteDiagnostic, setSiteDiagnostic] = useState<string | null>(null);
  /*
   * ★ 상태가 아니라 ref 다 (오너 신고 2026-08-24 수리): 예전에는 useState 였고 그 값이
   *   아래 effect 의 deps 에 들어 있었다. `setSiteScanStarted(true)` 가 곧바로 effect 를
   *   다시 돌려 **직전 실행의 정리 함수가 실행**되고, 그것이 `alive = false` 로 만들었다.
   *   그래서 스캔이 제때 끝나 결과가 도착해도 `if (!alive) return` 에 걸려 통째로 버려졌고,
   *   화면은 "브라우저를 살펴보는 중…" 에 영영 남았다. 한 번만 하고 싶다는 뜻은 렌더와
   *   무관한 사실이므로 ref 가 맞는 자리다.
   */
  const siteScanStartedRef = useRef(false);
  const [siteStalled, setSiteStalled] = useState(false);

  // ── 8단계: 자주 쓰는 도구 ───────────────────────────────────────────────────
  // 목록·설치·후속 단계는 팝업(PluginPickerDialog)과 같은 코어를 쓴다. 다른 것은
  // 껍데기(생김새)뿐이다.
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
    if (saved === "credentials") setStep(7);
    else if (saved === "plugins") setStep(8);
    setOpen(true);
  }, []);

  useEffect(() => onVisibilityChange?.(open), [onVisibilityChange, open]);

  /** 세팅 단계에 도달한 사실을 남긴다 — 여기서 앱을 닫아도 설명을 다시 보지 않는다. */
  useEffect(() => {
    if (!open) return;
    try {
      if (step === 7) window.localStorage.setItem(PHASE_KEY, "credentials");
      else if (step === 8) window.localStorage.setItem(PHASE_KEY, "plugins");
    } catch { /* ignore */ }
  }, [open, step]);

  const copy = useMemo(() => ko ? {
    label: "처음 사용 안내", next: "다음", back: "뒤로", close: "나중에 보기", finish: "이제 시작할게요",
    s1: "AI를 얼마나 활용해 보셨나요?", s1sub: "당신에게 맞는 시작 경로를 준비해 드릴게요.",
    beginner: "초보자", beginnerSub: "무료 GPT만 써봤어요", intermediate: "중급자", intermediateSub: "유료로 AI를 쓰고 있어요", expert: "익스퍼트", expertSub: "Claude Code·Codex를 쓸 줄 알아요",
    s2: "AI로 작업하고 에이전트를 사용하려면 계정을 연결해야 해요.", s2sub: "사용할 AI를 하나 선택하면 공식 로그인 화면을 열어드릴게요.", connect: "로그인하고 연결하기", checking: "연결 상태 확인 중…", connected: "연결됐어요", continue: "연결하지 않고 계속",
    s3: "Agentlas는 에이전트를 만들고, 작업을 자동화하고, 팀과 공유하는 플랫폼이에요.", s3sub: "복잡한 기술을 직접 조립하지 않아도 결과 중심으로 시작할 수 있어요.",
    build: "에이전트 빌드", buildSub: "필요한 역할을 직접 만들어요.", automation: "자동화", automationSub: "자연어로 반복 작업을 맡겨요.", hub: "Agent Hub", hubSub: "검증된 에이전트를 팀에 데려와요.",
    s4: "바이브코딩 에이전트가 무료로 제공돼요.", s4sub: "필요한 역할이 위에서부터 연결되고, 하나의 팀으로 일을 시작합니다.",
    s5: "Agentlas의 주요 공간을 한 번에 볼게요.", workspace: "작업공간", workspaceSub: "프로젝트를 만들고 에이전트를 조합해 작업을 완성해요.", agentHub: "Agent Hub", agentHubSub: "다른 사람들이 만든 에이전트를 우리 팀에 합류시켜요.", automationNav: "자동화", automationNavSub: "자연어로 에이전트 기반 작업 흐름을 만들고 실행해요.", site: "사이트", siteSub: "웹·앱 디자인을 만들고 AI와 실시간으로 수정해요.", connectNav: "커넥트", connectNavSub: "텔레그램과 브라우저 로그인을 연결해요.", cloud: "에이전트 클라우드", cloudSub: "에이전트를 만들고 다른 컴퓨터에서도 사용해요.", settings: "환경설정", settingsSub: "Gmail·Notion·커스텀 MCP를 등록해요.",
    s6: "Agentlas는 모바일에서도 사용할 수 있어요.", s6sub: "App Store와 Play Store에서 Agentlas를 설치한 뒤, 환경설정에서 새 기기 연결을 눌러 QR 코드로 연결하세요.",
    s7: "이미 로그인해 둔 사이트를 가져올까요?", s7sub: "평소 쓰는 브라우저에 로그인돼 있는 곳이에요. 고른 곳만 Agentlas로 넘어옵니다. 비밀번호와 결제수단은 가져오지 않아요.",
    s7search: "사이트 이름이나 주소로 찾기", s7scanning: "브라우저를 살펴보는 중…", s7empty: "가져올 로그인을 찾지 못했어요.", s7none: "찾는 이름과 맞는 사이트가 없어요.",
    s7stalled: "브라우저를 읽는 데 시간이 걸리고 있어요. 지금 건너뛰고 나중에 설정에서 해도 됩니다.", s7skip: "건너뛰기", s7skipped: "건너뛰었어요. 설정 → 커넥트에서 언제든 가져올 수 있어요.",
    s7linked: "이미 연결됨", s7importing: "가져오는 중…", s7profiles: "브라우저 프로필", s7more: "더 보기",
    s8: "매일 쓰는 서비스가 뭐예요?", s8sub: "고른 것은 모든 에이전트가 함께 씁니다. 나중에 환경설정에서 더 추가할 수 있어요.",
    s8search: "서비스 이름으로 찾기", s8loading: "목록을 불러오는 중…", s8empty: "표시할 서비스가 없어요.", s8none: "찾는 이름과 맞는 서비스가 없어요.",
    s8installed: "이미 연결됨", s8adding: "추가하는 중…", s8skip: "이대로 시작하기", s8more: "더 보기",
  } : {
    label: "Getting started", next: "Next", back: "Back", close: "Later", finish: "Let's get started",
    s1: "How familiar are you with AI?", s1sub: "We will prepare the right starting path for you.",
    beginner: "Beginner", beginnerSub: "I have only used free GPT", intermediate: "Intermediate", intermediateSub: "I already pay for an AI", expert: "Expert", expertSub: "I use Claude Code or Codex",
    s2: "To work with AI and agents, you need to connect an account.", s2sub: "Choose one AI and we will open its official login flow.", connect: "Log in and connect", checking: "Checking connection…", connected: "Connected", continue: "Continue without connecting",
    s3: "Agentlas is a platform for building agents, automating work, and sharing teams.", s3sub: "Start with the outcome instead of assembling complex technical pieces.",
    build: "Agent Build", buildSub: "Create the role you need.", automation: "Automation", automationSub: "Delegate repeatable work in natural language.", hub: "Agent Hub", hubSub: "Bring proven agents into your team.",
    s4: "Vibe-coding agents are included for free.", s4sub: "Roles connect from the top down and become a team ready to work.",
    s5: "Here is the rest of Agentlas at a glance.", workspace: "Workspace", workspaceSub: "Create projects, combine agents, and finish robustly.", agentHub: "Agent Hub", agentHubSub: "Bring agents made by others into your team.", automationNav: "Automation", automationNavSub: "Create and run agent workflows in natural language.", site: "Site", siteSub: "Create web and app designs and revise them with AI.", connectNav: "Connect", connectNavSub: "Connect Telegram and save browser logins.", cloud: "Agent Cloud", cloudSub: "Build agents and use them from another computer.", settings: "Settings", settingsSub: "Register Gmail, Notion, or custom MCPs.",
    s6: "Agentlas also works on mobile.", s6sub: "Install Agentlas from the App Store or Play Store, then choose Connect new device in Settings and scan the QR code.",
    s7: "Which sites are you already signed in to?", s7sub: "These are places your everyday browser is signed in to. Only the ones you pick come over. Passwords and payment methods stay behind.",
    s7search: "Find a site by name or address", s7scanning: "Looking through your browser…", s7empty: "No logins to bring over.", s7none: "No site matches that name.",
    s7stalled: "Reading your browser is taking a while. You can skip this now and do it later in Settings.", s7skip: "Skip", s7skipped: "Skipped. You can bring sites over any time from Settings → Connect.",
    s7linked: "Already connected", s7importing: "Bringing them over…", s7profiles: "Browser profile", s7more: "Show more",
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
        const installed = await api?.runtime.installCli(selected.cli);
        if (!installed?.ok) throw new Error(installed?.message || "installation failed");
      }
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
    } finally { setConnecting(false); }
  };

  // 7단계에 처음 닿을 때만 브라우저를 훑는다. 설명을 보는 동안 미리 훑으면 아직
  // 물어보지도 않은 일을 하는 셈이고, 여기까지 오지 않는 사람에게는 그냥 낭비다.
  useEffect(() => {
    if (!open || step !== 7 || siteScanStartedRef.current) return;
    siteScanStartedRef.current = true;
    let alive = true;
    void (async () => {
      const api = ipc();
      if (!api) return;
      setSiteScanning(true);
      setSiteStalled(false);
      /*
       * ★ 왜 시간 상한이 필요한가 (오너 신고 2026-08-24): 이 화면이 "브라우저를 살펴보는
       *   중…"에서 영영 멈춰 있었다. 스캔 자체는 이 기계에서 56ms 만에 154개를 돌려준다 —
       *   느린 것이 아니라 **응답이 오지 않는 것**이다. 본체가 다른 동기 작업으로 막히면
       *   이 요청은 큐에 남고, 화면에는 빠져나올 길이 없다. 기다림에는 끝이 있어야 한다.
       */
      const stallTimer = window.setTimeout(() => { if (alive) setSiteStalled(true); }, 8_000);
      try {
        const res = await api.browser.scanCredentials(null);
        window.clearTimeout(stallTimer);
        if (!alive) return;
        const profiles = res.profiles ?? [];
        setSiteProfiles(profiles);
        const first = profiles.find((entry) => entry.readable) ?? null;
        if (first) {
          setSiteProfileId(first.id);
          return; // 도메인 목록은 아래 효과가 이어서 받는다.
        }
        setSiteScanning(false);
        setSiteError(ko
          ? "이 컴퓨터에서 Chrome 계열 브라우저 프로필을 찾지 못했어요. 다음으로 넘어가도 괜찮아요."
          : "No Chrome-family browser profile was found on this computer. It is fine to continue.");
      } catch (error) {
        window.clearTimeout(stallTimer);
        if (!alive) return;
        setSiteScanning(false);
        setSiteError(error instanceof Error ? error.message : "scan failed");
      }
    })();
    return () => { alive = false; };
  }, [open, step, ko]);

  const loadSites = useCallback(async (profileId: string) => {
    const api = ipc();
    if (!api) return;
    setSiteScanning(true);
    setSiteStalled(false);
    setSiteError(null);
    const stallTimer = window.setTimeout(() => setSiteStalled(true), 8_000);
    try {
      const res = await api.browser.scanCredentials(profileId);
      setSites(Array.isArray(res.domains) ? res.domains : []);
      setSitePicked(new Set());
      if (!res.ok && res.error) setSiteError(res.error);
    } catch (error) {
      setSiteError(error instanceof Error ? error.message : "scan failed");
    } finally {
      window.clearTimeout(stallTimer);
      setSiteScanning(false);
      setSiteStalled(false);
    }
  }, []);

  useEffect(() => {
    if (!siteProfileId) return;
    void loadSites(siteProfileId);
  }, [siteProfileId, loadSites]);

  const siteMatches = useMemo(() => {
    const needle = siteQuery.trim().toLowerCase();
    if (!needle) return sites;
    return sites.filter((entry) =>
      entry.domain.toLowerCase().includes(needle) || siteDisplayName(entry.domain).toLowerCase().includes(needle));
  }, [sites, siteQuery]);

  // 도구 스텝과 같은 규칙: 검색을 시작하면 축소는 의미가 없다(사용자가 이미 목표를 말했다).
  const siteNarrowed = !siteExpanded && !siteQuery.trim();
  const visibleSites = useMemo(
    () => (siteNarrowed ? siteMatches.slice(0, SITE_TILES) : siteMatches),
    [siteMatches, siteNarrowed]);

  const toggleSite = (domain: string) => {
    setSitePicked((current) => {
      const next = new Set(current);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };

  /**
   * 고른 사이트를 가져온다. 아무것도 고르지 않았으면 그대로 다음 단계 — 그게 건너뛰기다.
   * 일부만 실패했을 때는 화면에 남아 이유를 말한다(성공으로 뭉개지 않는다). 선택은
   * 비워지므로 다음을 한 번 더 누르면 그대로 넘어간다.
   */
  const handleSitesNext = async () => {
    if (siteBusy) return;
    const api = ipc();
    if (!api || !siteProfileId || sitePicked.size === 0) { setStep(8); return; }
    setSiteBusy(true);
    setSiteError(null);
    setSiteNote(null);
    setSiteDiagnostic(null);
    try {
      const res = await api.browser.importCredentials(siteProfileId, [...sitePicked]);
      if (!res.ok) {
        setSiteError(res.error ?? (ko ? "가져오지 못했어요." : "Import failed."));
        return;
      }
      const nativeNotice = browserLoginImportNotice(res.nativeSession, ko);
      setSiteDiagnostic(browserLoginImportDiagnostic(res.nativeSession, ko));
      const linked = res.linkedSites.length;
      const skipped = res.skipped.length;
      const loginRequired = res.requiresLoginSites ?? [];
      if (loginRequired.length > 0) {
        const first = loginRequired[0];
        const opened = await api.browser.openLogin(first);
        setSitePicked(new Set());
        setSiteNote([opened.ok
          ? (ko
              ? `${first}은 Chrome이 보호한 세션이라 깨진 복사본을 만들지 않고 Agentlas 전용 로그인 창을 열었어요. 여기서 한 번 로그인하면 이후 자동화가 계속 재사용합니다.${loginRequired.length > 1 ? ` 나머지 ${loginRequired.length - 1}개는 Connect 목록에 추가했어요.` : ""}`
              : `${first} is protected by Chrome, so Agentlas opened its dedicated sign-in instead of making a broken copy. Sign in once and later automations will reuse it.${loginRequired.length > 1 ? ` The other ${loginRequired.length - 1} were added to Connect.` : ""}`)
          : (opened.error ?? (ko ? "전용 로그인 창을 열지 못했어요." : "Could not open the dedicated sign-in window.")), nativeNotice].filter(Boolean).join(" "));
        await loadSites(siteProfileId);
        return;
      }
      if (skipped > 0) {
        setSiteNote([ko
          ? `${linked}개를 가져왔어요. 가져오지 못한 곳: ${res.skipped.map((row) => `${row.domain} (${row.reason})`).join(", ")}`
          : `Brought over ${linked}. Could not bring: ${res.skipped.map((row) => `${row.domain} (${row.reason})`).join(", ")}`, nativeNotice].filter(Boolean).join(" "));
        await loadSites(siteProfileId);
        return;
      }
      if (nativeNotice) {
        setSitePicked(new Set());
        setSiteNote(nativeNotice);
        await loadSites(siteProfileId);
        return;
      }
      setStep(8);
    } catch (error) {
      setSiteError(error instanceof Error ? error.message : "import failed");
    } finally {
      setSiteBusy(false);
    }
  };

  // ── 8단계 ──────────────────────────────────────────────────────────────────

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

  if (!open) return null;

  const inToolStage = Boolean(loginStage || keyStage);
  const menuItems = [
    [copy.workspace, copy.workspaceSub], [copy.agentHub, copy.agentHubSub], [copy.automationNav, copy.automationNavSub],
    [copy.site, copy.siteSub], [copy.connectNav, copy.connectNavSub], [copy.cloud, copy.cloudSub], [copy.settings, copy.settingsSub],
  ];

  const goBack = () => {
    setStep((current) => {
      if (current === 5 && experience !== "beginner") return 1;
      return Math.max(1, current - 1);
    });
  };

  const goNext = () => {
    if (step === 7) { void handleSitesNext(); return; }
    if (step === LAST_STEP) { void handleToolsNext(); return; }
    setStep((current) => Math.min(LAST_STEP, current + 1));
  };

  const nextLabel = step === 7
    ? (siteBusy
      ? copy.s7importing
      : sitePicked.size > 0
        ? (ko ? `${sitePicked.size}개 가져오기` : `Bring ${sitePicked.size} over`)
        // 아무것도 안 골랐을 때 "지금은 건너뛰기"라고 쓰면 이 스텝이 안 해도 되는 곁가지처럼
        // 읽힌다. 하는 일은 다음 스텝으로 가는 것뿐이므로 다른 스텝과 같은 "다음"이다.
        : copy.next)
    : step === LAST_STEP
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
          {/* 설명 중 × 는 세팅으로 이동하고, 세팅 중 × 는 "나중에"로 온보딩을 닫는다.
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
          {step === 2 && <><h1>{copy.s2}</h1><p>{copy.s2sub}</p><div className={styles.providerGrid}>{PROVIDERS.map((item) => <button key={item.id} className={`${styles.provider} ${provider === item.id ? styles.selected : ""}`} onClick={() => void connectProvider(item.id)} disabled={connecting}><img src={item.logo} alt="" /><strong>{item.label}</strong><span>{provider === item.id && connecting ? copy.checking : copy.connect}</span></button>)}</div>{connectionError && <p className={styles.error}>{connectionError}</p>}<button className={styles.textButton} onClick={() => setStep(3)}>{copy.continue}</button></>}
          {step === 3 && <><h1>{copy.s3}</h1><p>{copy.s3sub}</p>{connected && <div className={styles.success}>{copy.connected}</div>}<div className={styles.featureGrid}><Feature title={copy.build} body={copy.buildSub} image="/brand/agentlas-mark.png" /><Feature title={copy.automation} body={copy.automationSub} image="/apps/document-studio.png" /><Feature title={copy.hub} body={copy.hubSub} image="/brand/agentlas-mark.png" /></div></>}
          {step === 4 && <><h1>{copy.s4}</h1><p>{copy.s4sub}</p><div className={styles.orgAnimation}><div className={styles.orgNode}>Agentlas Orchestrator</div><i /><div className={styles.orgRow}><span>Frontend</span><span>Backend</span><span>QA</span><span>Copy</span></div></div></>}
          {step === 5 && <><h1>{copy.s5}</h1><div className={styles.menuTour}><div className={styles.menuMock}>{menuItems.map(([title]) => <div key={title} className={styles.menuMockItem}>{title}</div>)}</div><div className={styles.menuDescriptions}>{menuItems.map(([title, body], index) => <div key={title} className={styles.menuDescription} style={{ animationDelay: `${index * 180}ms` }}><b>{title}</b><span>{body}</span></div>)}</div></div></>}
          {step === 6 && <><h1>{copy.s6}</h1><p>{copy.s6sub}</p><div className={styles.mobileCard}><div className={styles.mobileIcon}>QR</div><div><strong>Agentlas Mobile</strong><span>iOS · Android</span></div></div></>}

          {step === 7 && (
            <>
              <h1>{copy.s7}</h1>
              <p>{copy.s7sub}</p>

              {siteProfiles.length > 1 && (
                <div className={styles.chipRow} role="group" aria-label={copy.s7profiles}>
                  {siteProfiles.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={styles.chip}
                      data-on={entry.id === siteProfileId}
                      aria-pressed={entry.id === siteProfileId}
                      disabled={!entry.readable || siteBusy}
                      title={entry.reason ?? entry.path}
                      onClick={() => setSiteProfileId(entry.id)}
                    >
                      {entry.displayName}
                      <small>{entry.accountEmail ?? entry.browser}</small>
                    </button>
                  ))}
                </div>
              )}

              <div className={styles.searchRow}>
                <label className={styles.srOnly} htmlFor="onboarding-site-search">{copy.s7search}</label>
                <input
                  id="onboarding-site-search"
                  className={styles.searchInput}
                  value={siteQuery}
                  onChange={(event) => setSiteQuery(event.target.value)}
                  placeholder={copy.s7search}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {siteScanning && !siteStalled && <p className={styles.stepNote}>{copy.s7scanning}</p>}
              {siteScanning && siteStalled && (
                <p className={styles.stepNote}>
                  {copy.s7stalled}{" "}
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => {
                      // 기다림을 끊고 이 단계를 비워 둔다. 나중에 설정에서 다시 할 수 있다.
                      setSiteScanning(false);
                      setSiteStalled(false);
                      setSiteNote(copy.s7skipped);
                    }}
                  >
                    {copy.s7skip}
                  </button>
                </p>
              )}
              {!siteScanning && visibleSites.length === 0 && (
                <p className={styles.stepNote}>{siteQuery.trim() ? copy.s7none : copy.s7empty}</p>
              )}

              {visibleSites.length > 0 && (
                <div className={styles.tileGrid}>
                  {visibleSites.map((entry) => {
                    const picked = sitePicked.has(entry.domain);
                    // 이름은 **도메인에서** 만든다. 방문 기록 제목(entry.title)은 "마지막에
                    // 본 페이지"의 것이라 사이트 이름이 아니다 — 실측에서 google.com 줄에
                    // 받은편지함 제목과 이메일 주소가 그대로 떴고, google.co.kr 줄에는
                    // 엉뚱하게 GitHub 제목이 붙었다. 도메인은 언제나 맞고 개인정보가 없다.
                    const name = siteDisplayName(entry.domain) || entry.domain;
                    return (
                      <button
                        key={entry.domain}
                        type="button"
                        className={styles.tile}
                        data-selected={picked}
                        aria-pressed={picked}
                        disabled={entry.alreadyLinked || siteBusy}
                        onClick={() => toggleSite(entry.domain)}
                      >
                        <span className={styles.tileMark} aria-hidden="true">{initialOf(entry.domain)}</span>
                        <strong className={styles.tileName}>{name}</strong>
                        <small className={styles.tileMeta} title={entry.domain}>{entry.domain}</small>
                        {entry.alreadyLinked && <span className={styles.tileHint} data-tone="ready">{copy.s7linked}</span>}
                        {picked && <span className={styles.tileCheck} aria-hidden="true"><IconCheck size={13} /></span>}
                      </button>
                    );
                  })}
                </div>
              )}

              {siteNarrowed && siteMatches.length > visibleSites.length && (
                <button type="button" className={styles.moreButton} onClick={() => setSiteExpanded(true)}>
                  {`${copy.s7more} (${siteMatches.length - visibleSites.length})`}
                </button>
              )}

              {siteNote && <p className={styles.stepNote}>{siteNote}</p>}
              {siteDiagnostic && <details className={styles.stepNote}><summary>{ko ? "자세히" : "Details"}</summary><code>{siteDiagnostic}</code></details>}
              {siteError && <p className={styles.stepError}>{siteError}</p>}
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
          <button className={styles.back} onClick={goBack} disabled={step === 1 || siteBusy || toolBusy || inToolStage}>{copy.back}</button>
          {!inToolStage && (
            <button
              className={styles.next}
              onClick={goNext}
              disabled={(step === 1 && !experience) || siteBusy || toolBusy}
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
