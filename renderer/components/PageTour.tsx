"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";

interface TourStep {
  target: string;
  titleKo: string;
  bodyKo: string;
  titleEn: string;
  bodyEn: string;
}

interface TourConfig {
  id: string;
  labelKo: string;
  labelEn: string;
  steps: TourStep[];
}

const TOUR_VERSION = "v2";
const REPLAY_EVENT = "agentlas:page-tour-replay";
const CALLOUT_WIDTH = 348;

export const PAGE_TOUR_IDS = [
  "dashboard",
  "workspace",
  "build",
  "agents",
  "hub",
  "automation",
  "automation-new",
  "automation-detail",
  "environment",
];

export function pageTourStorageKey(id: string): string {
  return `agentlas.pageTour.${id}.dismissed.${TOUR_VERSION}`;
}

export function PageTour({ pathname }: { pathname: string }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const config = useMemo(() => tourConfigForPath(pathname), [pathname]);
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const lastTargetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setOpen(false);
    setStepIndex(0);
    if (!config) return undefined;
    try {
      if (window.localStorage.getItem(pageTourStorageKey(config.id)) === "1") return undefined;
    } catch {
      // private mode: show the tour for this session only
    }
    const timer = window.setTimeout(() => setOpen(true), 650);
    return () => window.clearTimeout(timer);
  }, [config]);

  useEffect(() => {
    const onReplay = () => {
      if (!config) return;
      setStepIndex(0);
      setOpen(true);
    };
    window.addEventListener(REPLAY_EVENT, onReplay);
    return () => window.removeEventListener(REPLAY_EVENT, onReplay);
  }, [config]);

  const step = config?.steps[Math.min(stepIndex, (config?.steps.length ?? 1) - 1)];

  useEffect(() => {
    const previous = lastTargetRef.current;
    previous?.classList.remove("agentlas-tour-target-active");
    previous?.removeAttribute("aria-describedby");
    lastTargetRef.current = null;

    if (!open || !step) {
      setTargetRect(null);
      return undefined;
    }

    let cancelled = false;
    const findTarget = () => document.querySelector<HTMLElement>(`[data-tour-id="${step.target}"]`);
    const measure = () => {
      const el = findTarget();
      if (!el || cancelled) {
        setTargetRect(null);
        return;
      }
      el.classList.add("agentlas-tour-target-active");
      el.setAttribute("aria-describedby", "agentlas-page-tour-callout");
      lastTargetRef.current = el;
      const rect = el.getBoundingClientRect();
      setTargetRect(rect.width > 0 && rect.height > 0 ? rect : null);
    };

    const target = findTarget();
    target?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    const timer = window.setTimeout(measure, target ? 220 : 80);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      const current = lastTargetRef.current;
      current?.classList.remove("agentlas-tour-target-active");
      current?.removeAttribute("aria-describedby");
      lastTargetRef.current = null;
    };
  }, [open, step]);

  if (!config || !open || !step) return null;

  const last = stepIndex >= config.steps.length - 1;
  const progress = `${stepIndex + 1}/${config.steps.length}`;
  const callout = positionCallout(targetRect);

  const close = () => {
    setOpen(false);
    try {
      window.localStorage.setItem(pageTourStorageKey(config.id), "1");
    } catch {
      // ignore
    }
  };

  const go = (next: number) => {
    const safe = Math.max(0, Math.min(next, config.steps.length - 1));
    setStepIndex(safe);
  };

  return (
    <>
      <div className="agentlas-tour-backdrop" aria-hidden="true" />
      {targetRect && (
        <div
          className="agentlas-tour-ring"
          aria-hidden="true"
          style={{
            left: Math.max(6, targetRect.left - 8),
            top: Math.max(6, targetRect.top - 8),
            width: Math.min(window.innerWidth - 12, targetRect.width + 16),
            height: Math.min(window.innerHeight - 12, targetRect.height + 16),
          }}
        />
      )}
      <section
        id="agentlas-page-tour-callout"
        className="agentlas-tour-callout titlebar-nodrag"
        role="dialog"
        aria-modal="false"
        aria-label={ko ? `${config.labelKo} 안내` : `${config.labelEn} tour`}
        style={{ left: callout.left, top: callout.top }}
      >
        <div className="agentlas-tour-source">
          <span>{ko ? "Hephaestus 카피라이터" : "Hephaestus Copywriter"}</span>
          <span>{ko ? "Gemini 초안 검수" : "Gemini draft reviewed"}</span>
        </div>
        <div className="agentlas-tour-topline">
          <span>{progress}</span>
          <button type="button" onClick={close} aria-label={ko ? "튜토리얼 닫기" : "Close tutorial"}>
            ×
          </button>
        </div>
        <h2>{ko ? step.titleKo : step.titleEn}</h2>
        <p>{ko ? step.bodyKo : step.bodyEn}</p>
        <div className="agentlas-tour-actions">
          <button type="button" className="agentlas-tour-secondary" onClick={close}>
            {ko ? "건너뛰기" : "Skip"}
          </button>
          <button type="button" className="agentlas-tour-secondary" onClick={() => go(stepIndex - 1)} disabled={stepIndex === 0}>
            {ko ? "이전" : "Back"}
          </button>
          <button type="button" className="agentlas-tour-primary" onClick={() => (last ? close() : go(stepIndex + 1))}>
            {last ? (ko ? "완료" : "Done") : ko ? "다음" : "Next"}
          </button>
        </div>
      </section>
    </>
  );
}

export function replayCurrentPageTour() {
  window.dispatchEvent(new CustomEvent(REPLAY_EVENT));
}

function positionCallout(rect: DOMRect | null): { left: number; top: number } {
  const gap = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxLeft = Math.max(12, vw - CALLOUT_WIDTH - 12);
  if (!rect) {
    return {
      left: Math.min(maxLeft, Math.max(12, (vw - CALLOUT_WIDTH) / 2)),
      top: Math.max(16, Math.min(vh - 260, 96)),
    };
  }
  let left = rect.right + gap;
  if (left + CALLOUT_WIDTH > vw - 12) left = rect.left - CALLOUT_WIDTH - gap;
  if (left < 12) left = Math.min(maxLeft, Math.max(12, rect.left));

  let top = rect.top;
  if (rect.height < 120 && rect.bottom + 230 < vh) top = rect.bottom + gap;
  if (top + 230 > vh - 12) top = Math.max(16, vh - 242);
  return { left, top };
}

function tourConfigForPath(pathname: string): TourConfig | null {
  if (pathname.startsWith("/dashboard") || pathname === "/") {
    return {
      id: "dashboard",
      labelKo: "대시보드",
      labelEn: "Dashboard",
      steps: [
        {
          target: "dashboard.org",
          titleKo: "왼쪽 조직도",
          bodyKo: "로컬, 클라우드, 허브에서 가져온 에이전트와 팀이 여기 모입니다. 누가 내 일꾼인지 먼저 보는 자리예요.",
          titleEn: "Left org chart",
          bodyEn: "Your local, cloud, and Hub agents live here. Start here to see who is available to work.",
        },
        {
          target: "dashboard.llm",
          titleKo: "LLM 연결과 사용량",
          bodyKo: "Claude, Codex, Gemini 같은 실행 엔진의 연결 상태를 확인합니다. 실제 비용 확정표가 아니라 연결과 한도 감시용입니다.",
          titleEn: "LLM connections and usage",
          bodyEn: "Check whether Claude, Codex, Gemini, and other engines are connected. This monitors access and limits, not final billing.",
        },
        {
          target: "dashboard.activity",
          titleKo: "현재 활동",
          bodyKo: "진행 중인 실행과 최근 움직임을 봅니다. 멈춘 것처럼 보일 때는 이 영역에서 살아 있는 작업인지 먼저 확인하세요.",
          titleEn: "Current activity",
          bodyEn: "See active runs and recent movement. If something feels stuck, this is the first place to check whether work is still alive.",
        },
        {
          target: "dashboard.approvals",
          titleKo: "승인 인박스",
          bodyKo: "에이전트가 결정을 기다리면 여기에 쌓입니다. 답이 늦어질수록 실제 작업도 멈출 수 있어요.",
          titleEn: "Approval inbox",
          bodyEn: "When agents need your decision, it waits here. The longer this sits, the longer work can remain blocked.",
        },
        {
          target: "dashboard.automations",
          titleKo: "자동화",
          bodyKo: "정해진 시간에 반복 실행되는 작업을 봅니다. 예약된 에이전트가 제대로 켜져 있는지 확인하는 곳입니다.",
          titleEn: "Automations",
          bodyEn: "Review scheduled work that runs repeatedly. Use this to confirm recurring agents are still enabled.",
        },
        {
          target: "dashboard.hub",
          titleKo: "Hub 상태",
          bodyKo: "빌려오거나 설치한 Hub 에이전트의 흐름을 확인합니다. 오프라인 폴백이면 실제 Hub 연결로 착각하지 않게 표시됩니다.",
          titleEn: "Hub status",
          bodyEn: "Track Hub agents you borrow or install. If the app is using an offline fallback, it is shown explicitly.",
        },
      ],
    };
  }
  if (pathname.startsWith("/chat") || pathname.startsWith("/project")) {
    return {
      id: "workspace",
      labelKo: "워크스페이스",
      labelEn: "Workspace",
      steps: [
        {
          target: "workspace.sidebar",
          titleKo: "대화와 프로젝트",
          bodyKo: "왼쪽에는 최근 대화와 프로젝트가 모입니다. 작업 맥락을 바꿀 때 여기서 바로 이동하세요.",
          titleEn: "Chats and projects",
          bodyEn: "Recent chats and projects live on the left. Use this rail to switch work context quickly.",
        },
        {
          target: "workspace.chat",
          titleKo: "대화 본문",
          bodyKo: "사용자 요청, 에이전트 응답, 진행 카드가 쌓이는 곳입니다. 진행 카드를 누르면 우측 실행 로그가 열립니다.",
          titleEn: "Conversation",
          bodyEn: "Requests, replies, and progress cards appear here. Click a progress card to open the workflow log on the right.",
        },
        {
          target: "workspace.workflow-toggle",
          titleKo: "실행 로그 열기",
          bodyKo: "이 버튼은 에이전트가 지금 어떤 도구와 단계를 거치는지 보여주는 우측 패널을 여닫습니다.",
          titleEn: "Open workflow logs",
          bodyEn: "This opens the right panel that shows which tools and steps the agent is running.",
        },
        {
          target: "workspace.input",
          titleKo: "입력창",
          bodyKo: "요청을 쓰고 에이전트 찾기, Stormbreaker, 권한, 모델을 정합니다. 처음엔 짧게 써도 됩니다.",
          titleEn: "Composer",
          bodyEn: "Write the task, then choose agent finding, Stormbreaker, permissions, and model options. Short prompts are fine at first.",
        },
      ],
    };
  }
  if (pathname.startsWith("/build")) {
    return {
      id: "build",
      labelKo: "빌드",
      labelEn: "Build",
      steps: [
        {
          target: "build.request",
          titleKo: "빌드 요청",
          bodyKo: "만들고 싶은 에이전트나 팀을 자연어로 적습니다. Hephaestus 빌더가 먼저 요구사항을 캐묻습니다.",
          titleEn: "Build request",
          bodyEn: "Describe the agent or team you want. The Hephaestus builder asks follow-up questions before creating it.",
        },
        {
          target: "build.pipeline",
          titleKo: "파이프라인",
          bodyKo: "분류, 인터뷰, 패키지 생성, 검증, 배포 흐름을 단계별로 봅니다. 지금 어디에 걸렸는지 확인하는 지도입니다.",
          titleEn: "Pipeline",
          bodyEn: "Follow classification, interview, package generation, verification, and delivery. It shows where the build currently is.",
        },
        {
          target: "build.interview",
          titleKo: "딥인터뷰 시작",
          bodyKo: "바로 만들지 않고 먼저 질문합니다. 답할수록 에이전트 역할과 도구 계약이 선명해집니다.",
          titleEn: "Start deep interview",
          bodyEn: "The builder asks before it generates. Your answers clarify the role and tool contract.",
        },
        {
          target: "build.log",
          titleKo: "빌드 로그",
          bodyKo: "빌드가 시작되면 실제 진행 로그가 여기에 쌓입니다. 멈춘 것 같을 때 마지막 로그를 확인하세요.",
          titleEn: "Build log",
          bodyEn: "Once a build starts, live logs appear here. If it feels stalled, check the latest line.",
        },
      ],
    };
  }
  if (pathname.startsWith("/library/agents")) {
    return {
      id: "agents",
      labelKo: "에이전트 라이브러리",
      labelEn: "Agent library",
      steps: [
        {
          target: "agents.roster",
          titleKo: "내 에이전트 목록",
          bodyKo: "보유한 팀과 싱글 에이전트를 고릅니다. 왼쪽에서 선택하면 오른쪽 제어판이 바뀝니다.",
          titleEn: "My agents",
          bodyEn: "Pick teams or single agents here. Selecting one changes the control center on the right.",
        },
        {
          target: "agents.import",
          titleKo: "에이전트 가져오기",
          bodyKo: "로컬 폴더의 Claude, Codex, Gemini 에이전트를 분석해 라이브러리에 추가합니다.",
          titleEn: "Import agents",
          bodyEn: "Analyze a local Claude, Codex, or Gemini agent folder and add it to your library.",
        },
        {
          target: "agents.detail",
          titleKo: "상세 제어판",
          bodyKo: "프롬프트, 메모리, 플레이북, 활동 기록을 확인하고 수정합니다. 에이전트 운영실이라고 보면 됩니다.",
          titleEn: "Control center",
          bodyEn: "Review and edit prompts, memory, playbooks, and activity. Think of it as the agent's operations room.",
        },
      ],
    };
  }
  if (pathname.startsWith("/marketplace")) {
    return {
      id: "hub",
      labelKo: "Hub",
      labelEn: "Hub",
      steps: [
        {
          target: "hub.status",
          titleKo: "Hub 연결 상태",
          bodyKo: "실시간 Hub인지, 기본 내장 목록인지 여기서 먼저 확인합니다. 연결되지 않았는데 되는 척하지 않습니다.",
          titleEn: "Hub connection",
          bodyEn: "First check whether this is live Hub data or the built-in catalog. The app does not pretend fallback data is live.",
        },
        {
          target: "hub.search",
          titleKo: "허브 검색",
          bodyKo: "에이전트, 팀, 플러그인을 한 번에 찾습니다. 필요한 업무를 키워드로 넣어 좁혀 보세요.",
          titleEn: "Hub search",
          bodyEn: "Search agents, teams, and plugins together. Use keywords from the job you want done.",
        },
        {
          target: "hub.categories",
          titleKo: "카테고리",
          bodyKo: "팀, 플러그인, 에이전트를 나눠 봅니다. 실행 주체와 도구 레이어를 섞어 보지 않게 합니다.",
          titleEn: "Categories",
          bodyEn: "Switch between teams, plugins, and agents. This keeps workers and tool layers separate.",
        },
        {
          target: "hub.results",
          titleKo: "설치 또는 호출",
          bodyKo: "카드에서 설치하거나 호출합니다. 오프라인 목록이면 실제 최신 공개 상태가 아니라는 점을 계속 표시합니다.",
          titleEn: "Install or call",
          bodyEn: "Use cards to install or call. If this is an offline catalog, the UI keeps that boundary visible.",
        },
      ],
    };
  }
  if (pathname.startsWith("/automation/new")) {
    return {
      id: "automation-new",
      labelKo: "새 자동화",
      labelEn: "New automation",
      steps: [
        {
          target: "automation.form",
          titleKo: "자동화 작성",
          bodyKo: "이름, 실행 주기, 대상 에이전트, 반복 요청을 정합니다. 저장하면 백그라운드 스케줄러가 관리합니다.",
          titleEn: "Automation form",
          bodyEn: "Set the name, schedule, target agent, and repeated prompt. After saving, the background scheduler manages it.",
        },
      ],
    };
  }
  if (pathname.startsWith("/automation/detail")) {
    return {
      id: "automation-detail",
      labelKo: "자동화 상세",
      labelEn: "Automation detail",
      steps: [
        {
          target: "automation.status",
          titleKo: "실행 상태",
          bodyKo: "켜짐 여부, 대상, 마지막 실행, 프롬프트를 확인합니다. 반복 작업이 실제로 살아 있는지 보는 화면입니다.",
          titleEn: "Execution status",
          bodyEn: "Check enabled state, target, latest run, and prompt. This page shows whether recurring work is alive.",
        },
      ],
    };
  }
  if (pathname.startsWith("/automation")) {
    return {
      id: "automation",
      labelKo: "자동화",
      labelEn: "Automations",
      steps: [
        {
          target: "automation.new",
          titleKo: "새 자동화 만들기",
          bodyKo: "반복 실행할 일을 새로 등록합니다. 대상은 에이전트 하나나 팀 전체가 될 수 있습니다.",
          titleEn: "Create automation",
          bodyEn: "Register recurring work. The target can be one agent or a whole team.",
        },
        {
          target: "automation.list",
          titleKo: "자동화 목록",
          bodyKo: "등록된 자동화를 켜고 끄거나 상세 화면으로 들어갑니다.",
          titleEn: "Automation list",
          bodyEn: "Turn automations on or off, or open the detail page.",
        },
      ],
    };
  }
  if (pathname.startsWith("/library/env")) {
    return {
      id: "environment",
      labelKo: "Environment",
      labelEn: "Environment",
      steps: [
        {
          target: "env.security",
          titleKo: "키는 로컬 키체인",
          bodyKo: "API 키 값은 렌더러에 오래 남기지 않고 시스템 키체인에 저장합니다. 화면에는 저장 여부만 보입니다.",
          titleEn: "Keys stay in keychain",
          bodyEn: "Secret values are stored in the system keychain, not kept in the renderer. The page shows only saved state.",
        },
        {
          target: "env.toolbar",
          titleKo: "검색과 필터",
          bodyKo: "필요한 키를 찾고, 저장됨/미설정 상태로 좁혀 봅니다. .env 파일을 끌어와 등록할 수도 있습니다.",
          titleEn: "Search and filters",
          bodyEn: "Find keys and filter by saved or missing state. You can also drop a .env file to import values.",
        },
        {
          target: "env.sections",
          titleKo: "섹션별 키",
          bodyKo: "에이전트나 도구가 요구하는 키가 출처별로 묶입니다. 어디에 필요한 키인지 확인하고 저장하세요.",
          titleEn: "Keys by section",
          bodyEn: "Required keys are grouped by the agent or tool that needs them. Save values with the context visible.",
        },
      ],
    };
  }
  return null;
}
