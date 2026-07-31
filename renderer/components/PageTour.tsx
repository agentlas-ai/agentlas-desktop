"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  autoOpen?: boolean;
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

export function PageTour({
  pathname,
  autoOpenSuspended = false,
}: {
  pathname: string;
  /** A higher-priority first-run surface is visible or still resolving. */
  autoOpenSuspended?: boolean;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const config = useMemo(() => tourConfigForPath(pathname), [pathname]);
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const lastTargetRef = useRef<HTMLElement | null>(null);
  const scrollSnapshotRef = useRef<Array<{ element: Element; top: number; left: number }>>([]);

  const restoreScrollSnapshot = useCallback(() => {
    const snapshot = scrollSnapshotRef.current;
    scrollSnapshotRef.current = [];
    for (const item of snapshot) {
      item.element.scrollTop = item.top;
      item.element.scrollLeft = item.left;
    }
  }, []);

  useEffect(() => {
    restoreScrollSnapshot();
    setOpen(false);
    setStepIndex(0);
    if (!config) return undefined;
    if (autoOpenSuspended) return undefined;
    if (config.autoOpen === false) return undefined;
    try {
      if (window.localStorage.getItem(pageTourStorageKey(config.id)) === "1") return undefined;
    } catch {
      // private mode: show the tour for this session only
    }
    const timer = window.setTimeout(() => setOpen(true), 650);
    return () => window.clearTimeout(timer);
  }, [autoOpenSuspended, config, restoreScrollSnapshot]);

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
    if (target && scrollSnapshotRef.current.length === 0) {
      const elements: Element[] = [];
      for (let parent = target.parentElement; parent; parent = parent.parentElement) {
        if (parent.scrollHeight > parent.clientHeight + 1 || parent.scrollWidth > parent.clientWidth + 1) {
          elements.push(parent);
        }
      }
      if (document.scrollingElement && !elements.includes(document.scrollingElement)) {
        elements.push(document.scrollingElement);
      }
      scrollSnapshotRef.current = elements.map((element) => ({
        element,
        top: element.scrollTop,
        left: element.scrollLeft,
      }));
    }
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
    window.requestAnimationFrame(restoreScrollSnapshot);
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

  let top = Math.max(16, rect.top);
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
          titleKo: "내 팀 한눈에",
          bodyKo: "로컬·클라우드·허브 에이전트가 한 곳에 모입니다. 일을 맡기기 전, 지금 누가 대기 중인지 여기서 확인하세요.",
          titleEn: "Your whole team",
          bodyEn: "Every local, cloud, and Hub agent in one place. Check who's ready before you hand off work.",
        },
        {
          target: "dashboard.llm",
          titleKo: "엔진 연결 상태",
          bodyKo: "Claude·Codex·Gemini가 연결됐는지, 한도가 얼마 남았는지 한눈에 봅니다. 최종 청구서가 아니라 연결과 한도 감시용입니다.",
          titleEn: "Engine connections",
          bodyEn: "See at a glance which engines are connected and how much headroom is left. This tracks access and limits, not final billing.",
        },
        {
          target: "dashboard.worker-model",
          titleKo: "오케스트레이터와 워커",
          bodyKo: "오케스트레이터는 요청을 판단하고 일을 나눈 뒤 결과를 합칩니다. 워커는 나눠 받은 일을 실행합니다. 워커 풀을 비워 두면 오케스트레이터 모델을 따르고, 직접 지정하면 워커 전용 후보 행을 사용합니다.",
          titleEn: "Orchestrator and workers",
          bodyEn: "The orchestrator decides, delegates, and combines the result. Workers execute the delegated parts. An empty worker pool follows the orchestrator model; direct selection uses worker-specific candidate rows.",
        },
        {
          target: "dashboard.activity",
          titleKo: "지금 돌아가는 일",
          bodyKo: "진행 중인 실행과 최근 움직임이 실시간으로 보입니다. 멈춘 것 같을 땐 여기서 작업이 살아 있는지 가장 먼저 확인하세요.",
          titleEn: "What's running now",
          bodyEn: "Active runs and recent movement, live. When something feels stuck, check here first to see if it's still alive.",
        },
        {
          target: "dashboard.approvals",
          titleKo: "내 승인 대기함",
          bodyKo: "에이전트가 당신의 결정을 기다리면 여기 쌓입니다. 비워둘수록 그만큼 작업도 멈춰 있습니다.",
          titleEn: "Waiting on you",
          bodyEn: "When agents need your decision, it lands here. The longer it sits, the longer work stays blocked.",
        },
        {
          target: "dashboard.automations",
          titleKo: "예약된 반복 작업",
          bodyKo: "정해진 시간에 알아서 도는 작업을 모아 봅니다. 예약한 에이전트가 켜져 있는지 여기서 확인하세요.",
          titleEn: "Scheduled runs",
          bodyEn: "All your recurring, time-based jobs in one view. Confirm scheduled agents are still switched on.",
        },
        {
          target: "dashboard.hub",
          titleKo: "Hub 연결 상태",
          bodyKo: "빌리거나 설치한 Hub 에이전트의 흐름을 봅니다. 연결이 끊기면 가짜 목록을 채우지 않고 끊긴 상태 그대로 보여줍니다.",
          titleEn: "Hub status",
          bodyEn: "Track the Hub agents you borrow or install. If Hub drops, you see that — never a fake fallback list.",
        },
      ],
    };
  }
  if (pathname.startsWith("/chat") || pathname.startsWith("/project")) {
    const sidebarStep: TourStep = {
      target: "workspace.sidebar",
      titleKo: "대화·프로젝트 이동",
      bodyKo: "최근 대화와 프로젝트가 왼쪽에 쌓입니다. 작업 맥락을 바꿀 땐 여기서 한 번에 건너뛰세요.",
      titleEn: "Jump between work",
      bodyEn: "Recent chats and projects sit on the left. Switch context in one click from this rail.",
    };
    // 채팅 전용 스텝(대화 본문·실행 로그·입력창)은 /chat 에만 존재한다.
    // /project 상세에는 사이드바만 있으므로 그 한 스텝만 안내해 빈 화면 중앙 콜아웃을 막는다.
    const chatOnlySteps: TourStep[] = [
      {
        target: "workspace.chat",
        titleKo: "대화가 흐르는 곳",
        bodyKo: "요청, 응답, 진행 카드가 여기 쌓입니다. 진행 카드를 누르면 오른쪽 실행 로그가 바로 열립니다.",
        titleEn: "The conversation",
        bodyEn: "Requests, replies, and progress cards stack here. Click any progress card to open its workflow log.",
      },
      {
        target: "workspace.workflow-toggle",
        titleKo: "무대 뒤 보기",
        bodyKo: "에이전트가 지금 어떤 도구를 쓰고 어느 단계인지 보여주는 오른쪽 패널을 이 버튼으로 여닫습니다.",
        titleEn: "Peek behind the run",
        bodyEn: "Toggle the right panel to watch which tools and steps the agent is running right now.",
      },
      {
        target: "workspace.input",
        titleKo: "여기서 일 맡기기",
        bodyKo: "할 일을 쓰고 알아서 에이전트 부르기·Stormbreaker·권한·모델을 고르세요. 처음엔 한 줄로 짧게 시작해도 됩니다.",
        titleEn: "Hand off the task",
        bodyEn: "Write the task, then set agent finding, Stormbreaker, permissions, and model. One short line is enough to start.",
      },
    ];
    return {
      id: "workspace",
      labelKo: "워크스페이스",
      labelEn: "Workspace",
      autoOpen: false,
      steps: pathname.startsWith("/chat") ? [sidebarStep, ...chatOnlySteps] : [sidebarStep],
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
          titleKo: "말로 주문하기",
          bodyKo: "원하는 에이전트나 팀을 평소 말투로 적으세요. Hephaestus 빌더가 만들기 전에 필요한 걸 먼저 캐묻습니다.",
          titleEn: "Describe it",
          bodyEn: "Say what agent or team you want in plain words. The Hephaestus builder digs for details before it builds.",
        },
        {
          target: "build.pipeline",
          titleKo: "빌드 진행 지도",
          bodyKo: "분류·인터뷰·패키지 생성·검증·배포까지 단계별로 보여줍니다. 지금 어디까지 왔고 어디서 걸렸는지 한눈에 잡힙니다.",
          titleEn: "Build progress map",
          bodyEn: "Classify, interview, package, verify, deliver — step by step. See how far it's come and where it's stuck.",
        },
        {
          target: "build.interview",
          titleKo: "딥인터뷰 시작",
          bodyKo: "바로 찍어내지 않고 먼저 묻습니다. 답할수록 에이전트의 역할과 쓸 도구가 또렷해집니다.",
          titleEn: "Deep interview",
          bodyEn: "It asks before it builds. The more you answer, the sharper the agent's role and toolset get.",
        },
        {
          target: "build.log",
          titleKo: "실시간 빌드 로그",
          bodyKo: "빌드가 시작되면 진짜 진행 로그가 실시간으로 쌓입니다. 멈춘 것 같으면 맨 아래 줄을 보세요.",
          titleEn: "Live build log",
          bodyEn: "Once it starts, real logs stream in line by line. If it feels stalled, read the last line.",
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
          titleKo: "보유한 에이전트",
          bodyKo: "가진 팀과 싱글 에이전트를 여기서 고릅니다. 왼쪽에서 누르면 오른쪽 제어판이 그 에이전트로 바뀝니다.",
          titleEn: "Your roster",
          bodyEn: "Pick any team or single agent here. Selecting one swaps the control center on the right to match.",
        },
        {
          target: "agents.import",
          titleKo: "기존 것 끌어오기",
          bodyKo: "내 폴더 속 Claude·Codex·Gemini 에이전트를 분석해 라이브러리에 그대로 등록합니다.",
          titleEn: "Import what you have",
          bodyEn: "Point it at a local Claude, Codex, or Gemini agent folder; it analyzes and adds it to your library.",
        },
        {
          target: "agents.detail",
          titleKo: "에이전트 운영실",
          bodyKo: "프롬프트·메모리·플레이북·활동 기록을 보고 직접 손봅니다. 이 에이전트를 관리하는 본부입니다.",
          titleEn: "The operations room",
          bodyEn: "View and edit prompts, memory, playbooks, and activity. This is where you tune the agent.",
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
          titleKo: "진짜 연결인지 확인",
          bodyKo: "지금 보는 게 실시간 Hub 데이터인지 여기서 먼저 확인하세요. 끊겼는데 된 척하거나 가짜 목록으로 채우지 않습니다.",
          titleEn: "Is this live?",
          bodyEn: "Check here that you're seeing real, live Hub data. It never fakes a connection or fills in placeholder agents.",
        },
        {
          target: "hub.search",
          titleKo: "필요한 일꾼 찾기",
          bodyKo: "공개 Hub의 에이전트·팀·플러그인을 검색합니다. 맡기려는 일을 키워드로 넣으면 후보가 좁혀집니다.",
          titleEn: "Find a worker",
          bodyEn: "Search public Hub agents, teams, and plugins. Type the job you need done to narrow it down.",
        },
        {
          target: "hub.results",
          titleKo: "설치하거나 바로 호출",
          bodyKo: "카드에서 바로 설치하거나 호출하세요. 연결이 끊기면 진짜 에이전트를 받을 때까지 결과를 비워 둡니다.",
          titleEn: "Install or call",
          bodyEn: "Install or call straight from a card. If Hub is down, results stay empty until real agents load — no fakes.",
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
          titleKo: "반복 작업 설정",
          bodyKo: "이름·실행 주기·대상 에이전트·반복 요청을 정하세요. 저장하면 백그라운드 스케줄러가 알아서 돌립니다.",
          titleEn: "Set it and forget it",
          bodyEn: "Set a name, schedule, target agent, and the prompt to repeat. Save it and the background scheduler runs it for you.",
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
          titleKo: "잘 돌고 있나",
          bodyKo: "켜짐 여부·대상·마지막 실행·프롬프트를 한눈에 봅니다. 이 반복 작업이 정말 살아서 도는지 확인하는 화면입니다.",
          titleEn: "Still running?",
          bodyEn: "See on/off state, target, last run, and prompt at a glance. Confirm this recurring job is actually alive.",
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
          titleKo: "새로 등록하기",
          bodyKo: "반복해서 돌릴 일을 새로 등록하세요. 대상은 에이전트 한 명이든 팀 전체든 됩니다.",
          titleEn: "Add a new one",
          bodyEn: "Register recurring work here. Aim it at one agent or an entire team.",
        },
        {
          target: "automation.list",
          titleKo: "켜고 끄고 열기",
          bodyKo: "등록한 자동화를 바로 켜고 끄거나, 눌러서 상세 화면으로 들어갑니다.",
          titleEn: "Toggle and open",
          bodyEn: "Flip any automation on or off, or open it for the full detail view.",
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
          titleKo: "키는 키체인에 안전",
          bodyKo: "API 키 원문은 화면에 남기지 않고 시스템 키체인에 보관합니다. 여기엔 저장됨 여부만 표시됩니다.",
          titleEn: "Safe in the keychain",
          bodyEn: "Your raw API keys go to the system keychain, never the renderer. The page shows only whether each is saved.",
        },
        {
          target: "env.toolbar",
          titleKo: "찾고 한 번에 채우기",
          bodyKo: "키를 검색하고 저장됨·미설정 상태로 걸러 봅니다. .env 파일을 끌어다 놓으면 한 번에 등록됩니다.",
          titleEn: "Find and bulk-fill",
          bodyEn: "Search keys and filter by saved or missing. Drop a .env file to import every value at once.",
        },
        {
          target: "env.sections",
          titleKo: "누가 쓰는 키인지",
          bodyKo: "필요한 키가 그걸 요구하는 에이전트·도구별로 묶여 있습니다. 어디에 쓰이는지 보면서 값을 저장하세요.",
          titleEn: "Grouped by who needs it",
          bodyEn: "Keys are grouped under the agent or tool that needs them. Save each value with its purpose in view.",
        },
      ],
    };
  }
  return null;
}
