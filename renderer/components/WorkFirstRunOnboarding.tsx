"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import styles from "./WorkFirstRunOnboarding.module.css";

type Experience = "beginner" | "intermediate" | "expert";
type Provider = "codex" | "claude-code" | "gemini";

const STORAGE_KEY = "agentlas.work.firstRunOnboarding.v2";

const PROVIDERS: Array<{ id: Provider; label: string; logo: string; cli: "codex" | "claude-code" | "gemini" }> = [
  { id: "codex", label: "GPT / Codex", logo: "/brand/llm/openai.svg", cli: "codex" },
  { id: "claude-code", label: "Claude", logo: "/brand/llm/claude.svg", cli: "claude-code" },
  { id: "gemini", label: "Gemini / Antigravity", logo: "/brand/llm/googlegemini.svg", cli: "gemini" },
];

export function WorkFirstRunOnboarding({ onVisibilityChange }: { onVisibilityChange?: (visible: boolean) => void }) {
  const { locale } = useT();
  const router = useRouter();
  const ko = locale === "ko";
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [experience, setExperience] = useState<Experience | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    let seen = false;
    try { seen = window.localStorage.getItem(STORAGE_KEY) === "1"; } catch { /* private mode */ }
    if (!seen) setOpen(true);
  }, []);

  useEffect(() => onVisibilityChange?.(open), [onVisibilityChange, open]);

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
  }, [ko]);

  const finish = useCallback(() => {
    try { window.localStorage.setItem(STORAGE_KEY, "1"); } catch { /* ignore */ }
    setOpen(false);
  }, []);

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
      const installed = await api?.runtime.installCli(selected.cli);
      if (!installed?.ok) throw new Error(installed?.message || "installation failed");
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

  if (!open) return null;
  const menuItems = [
    [copy.workspace, copy.workspaceSub], [copy.agentHub, copy.agentHubSub], [copy.automationNav, copy.automationNavSub],
    [copy.site, copy.siteSub], [copy.connectNav, copy.connectNavSub], [copy.cloud, copy.cloudSub], [copy.settings, copy.settingsSub],
  ];
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="work-onboarding-title">
      <section className={styles.panel}>
        <header className={styles.header}>
          <div className={styles.brand}><strong>Agentlas</strong><span>Work</span></div>
          <div className={styles.headerCenter}><span className={styles.eyebrow}>{copy.label}</span><div className={styles.progress}>{[1, 2, 3, 4, 5, 6].map((item) => <span key={item} data-current={step === item} data-done={step > item} />)}</div></div>
          <div className={styles.headerActions}><button className={styles.language} type="button">EN · KO</button><button className={styles.close} onClick={finish} aria-label={copy.close}>×</button></div>
        </header>
        <main className={styles.content}>
          {step === 1 && <><h1 id="work-onboarding-title">{copy.s1}</h1><p>{copy.s1sub}</p><div className={styles.choiceGrid}>{(["beginner", "intermediate", "expert"] as Experience[]).map((item) => <button key={item} className={`${styles.choice} ${experience === item ? styles.selected : ""}`} onClick={() => chooseExperience(item)}><div className={styles.choiceIllustration}>{item === "beginner" ? "01" : item === "intermediate" ? "02" : "03"}</div><strong>{copy[item]}</strong><small>{copy[`${item}Sub` as "beginnerSub" | "intermediateSub" | "expertSub"]}</small></button>)}</div></>}
          {step === 2 && <><h1>{copy.s2}</h1><p>{copy.s2sub}</p><div className={styles.providerGrid}>{PROVIDERS.map((item) => <button key={item.id} className={`${styles.provider} ${provider === item.id ? styles.selected : ""}`} onClick={() => void connectProvider(item.id)} disabled={connecting}><img src={item.logo} alt="" /><strong>{item.label}</strong><span>{provider === item.id && connecting ? copy.checking : copy.connect}</span></button>)}</div>{connectionError && <p className={styles.error}>{connectionError}</p>}<button className={styles.textButton} onClick={() => setStep(3)}>{copy.continue}</button></>}
          {step === 3 && <><h1>{copy.s3}</h1><p>{copy.s3sub}</p>{connected && <div className={styles.success}>{copy.connected}</div>}<div className={styles.featureGrid}><Feature title={copy.build} body={copy.buildSub} image="/apps/oberon.png" /><Feature title={copy.automation} body={copy.automationSub} image="/apps/document-studio.png" /><Feature title={copy.hub} body={copy.hubSub} image="/brand/agentlas-mark.png" /></div></>}
          {step === 4 && <><h1>{copy.s4}</h1><p>{copy.s4sub}</p><div className={styles.orgAnimation}><div className={styles.orgNode}>Agentlas Orchestrator</div><i /><div className={styles.orgRow}><span>Frontend</span><span>Backend</span><span>QA</span><span>Copy</span></div></div></>}
          {step === 5 && <><h1>{copy.s5}</h1><div className={styles.menuTour}><div className={styles.menuMock}>{menuItems.map(([title]) => <div key={title} className={styles.menuMockItem}>{title}</div>)}</div><div className={styles.menuDescriptions}>{menuItems.map(([title, body], index) => <div key={title} className={styles.menuDescription} style={{ animationDelay: `${index * 180}ms` }}><b>{title}</b><span>{body}</span></div>)}</div></div></>}
          {step === 6 && <><h1>{copy.s6}</h1><p>{copy.s6sub}</p><div className={styles.mobileCard}><div className={styles.mobileIcon}>QR</div><div><strong>Agentlas Mobile</strong><span>iOS · Android</span></div></div></>}
        </main>
        <footer className={styles.footer}><button className={styles.back} onClick={() => setStep((current) => current === 5 && experience !== "beginner" ? 1 : Math.max(1, current - 1))} disabled={step === 1}>{copy.back}</button>{step < 6 ? <button className={styles.next} onClick={() => setStep((current) => current === 3 ? 4 : current + 1)} disabled={step === 1 && !experience}>{copy.next}</button> : <button className={styles.next} onClick={finish}>{copy.finish}</button>}</footer>
        <nav className={styles.productNav} aria-label="Agentlas product navigation">
          {([["⌂", "One"], ["◎", "Agents"], ["◉", "Work"], ["ϟ", "Automations"], ["⚙", "Settings"]] as const).map(([icon, label]) => <span key={label} className={label === "Work" ? styles.activeNav : ""}><b aria-hidden="true">{icon}</b>{label}</span>)}
        </nav>
      </section>
    </div>
  );
}

function Feature({ title, body, image }: { title: string; body: string; image: string }) {
  return <article className={styles.feature}><img src={image} alt="" /><strong>{title}</strong><span>{body}</span></article>;
}
