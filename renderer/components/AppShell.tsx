// 모든 라우트의 공통 셸 — 좌측 Sidebar(glass) + 우측 페이지 슬롯.
// body 그라데이션 위에 떠 있는 frosted glass 레이아웃.
// + Electron 메뉴 → 라우터 브릿지.
// + 자동 업데이트 배너 (downloading/downloaded 상태에서만 노출).
"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { MenuBridge } from "./MenuBridge";
import { UpdateBanner } from "./UpdateBanner";
import { ImportAgentsModal } from "./ImportAgentsModal";
import { ipc } from "@/lib/ipc";
import { SideNav } from "./SideNav";
import { usePathname } from "next/navigation";
import { registerRouter } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
import { IconChat, IconLayers } from "./Icon";

const ONBOARDED_KEY = "agentlas.onboarded";
const IMPORT_PROMPTED_KEY = "agentlas.import.prompted";
const TOUR_DISMISSED_KEY = "agentlas.shellTour.dismissed.v1";
const ATTENTION_POLL_MS = 3_000;

export function AppShell({ children }: { children: React.ReactNode }) {
  const [importOpen, setImportOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStep, setTourStep] = useState(0);
  const [pendingConfirmations, setPendingConfirmations] = useState(0);
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const { locale } = useT();

  // navigate() 헬퍼가 hard navigation(window.location) 대신 soft navigation을
  // 쓰도록 App Router 인스턴스를 등록한다. static export 셸에서 hard navigation은
  // RSC(.txt) 페이로드를 메인 document로 로드해 화면을 깨뜨린다. (navigation.ts 참고)
  useEffect(() => {
    registerRouter(router);
    return () => registerRouter(null);
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const syncAttention = async () => {
      const api = ipc();
      if (!api) {
        if (!cancelled) setPendingConfirmations(0);
        return;
      }
      try {
        const list = await api.confirm.listPending();
        if (cancelled) return;
        const count = list.length;
        setPendingConfirmations(count);
        await api.attention?.setPendingConfirmations(count);
      } catch {
        // Transient IPC errors should not clear an existing badge.
      }
    };

    void syncAttention();
    timer = window.setInterval(() => void syncAttention(), ATTENTION_POLL_MS);
    window.addEventListener("focus", syncAttention);
    window.addEventListener("agentlas:attention-refresh", syncAttention);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      window.removeEventListener("focus", syncAttention);
      window.removeEventListener("agentlas:attention-refresh", syncAttention);
      const api = ipc();
      void api?.attention?.setPendingConfirmations(0);
    };
  }, []);

  // 온보딩을 마쳤는데 로컬 에이전트가 0개면 "내 에이전트 가져오기" 팝업을 한 번 띄운다.
  useEffect(() => {
    const api = ipc();
    if (!api) return;
    let onboarded = false;
    let prompted = false;
    try {
      onboarded = window.localStorage.getItem(ONBOARDED_KEY) === "1";
      prompted = window.sessionStorage.getItem(IMPORT_PROMPTED_KEY) === "1";
    } catch {
      // ignore
    }
    if (!onboarded || prompted) return;
    void api.team.list().then((agents) => {
      if (agents.length === 0) {
        try {
          window.sessionStorage.setItem(IMPORT_PROMPTED_KEY, "1");
        } catch {
          // ignore
        }
        setImportOpen(true);
      }
    });
  }, []);

  useEffect(() => {
    try {
      const dismissed = window.localStorage.getItem(TOUR_DISMISSED_KEY) === "1";
      const onboarded = window.localStorage.getItem(ONBOARDED_KEY) === "1";
      if (onboarded && !dismissed) {
        const timer = window.setTimeout(() => setTourOpen(true), 600);
        return () => window.clearTimeout(timer);
      }
    } catch {
      // ignore
    }
    return undefined;
  }, []);

  function dismissTour() {
    setTourOpen(false);
    try {
      window.localStorage.setItem(TOUR_DISMISSED_KEY, "1");
    } catch {
      // ignore
    }
  }

  const showSidebar = pathname.startsWith("/chat") || pathname.startsWith("/project");

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        height: "100vh",
        background: "transparent",
        overflow: "hidden",
      }}
    >
      <SideNav pendingConfirmations={pendingConfirmations} />
      {showSidebar && <Sidebar />}
      <main
        style={{
          position: "relative",
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "transparent",
        }}
      >
        <UpdateBanner />
        {pendingConfirmations > 0 && (
          <AttentionNudge
            count={pendingConfirmations}
            locale={locale}
            onOpen={() => router.push("/dashboard#approval-inbox")}
          />
        )}
        {children}
      </main>
      <FirstRunTour
        open={tourOpen}
        step={tourStep}
        onStep={setTourStep}
        onClose={dismissTour}
      />
      <ImportAgentsModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          // 새로 가져온 에이전트가 사이드바·홈 등 전역에 반영되도록 리로드.
          try {
            window.location.reload();
          } catch {
            // ignore
          }
        }}
      />
      <GuideFab
        avoidComposer={pathname.startsWith("/chat")}
        onReplayOnboarding={() => router.push("/onboarding")}
        onReplayTour={() => {
          setTourStep(0);
          setTourOpen(true);
        }}
      />
    </div>
  );
}

function AttentionNudge({
  count,
  locale,
  onOpen,
}: {
  count: number;
  locale: string;
  onOpen: () => void;
}) {
  const ko = locale === "ko";
  return (
    <div className="app-attention-nudge titlebar-nodrag" role="status" aria-live="assertive">
      <span className="app-attention-dot" aria-hidden="true" />
      <div className="app-attention-copy">
        <strong>
          {ko
            ? `${count > 99 ? "99+" : count}개 승인 대기`
            : `${count > 99 ? "99+" : count} approval${count === 1 ? "" : "s"} waiting`}
        </strong>
        <span>{ko ? "에이전트가 답을 기다리고 있습니다." : "An agent is waiting for your answer."}</span>
      </div>
      <button type="button" onClick={onOpen}>
        {ko ? "열기" : "Open"}
      </button>
    </div>
  );
}

// 우측 하단 상시 가이드 버튼 — 언제든 처음 설정/메뉴 투어를 다시 부른다.
function GuideFab({
  avoidComposer,
  onReplayOnboarding,
  onReplayTour,
}: {
  avoidComposer?: boolean;
  onReplayOnboarding: () => void;
  onReplayTour: () => void;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [open, setOpen] = useState(false);
  const bottom = avoidComposer ? 102 : 20;
  return (
    <div className="titlebar-nodrag" style={{ position: "fixed", right: 20, bottom, zIndex: 150 }}>
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: 58,
            right: 0,
            width: 226,
            background: "var(--paper)",
            border: "1px solid var(--paper-edge)",
            borderRadius: 12,
            boxShadow: "0 12px 32px rgba(0,0,0,0.16)",
            padding: 6,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div style={{ padding: "6px 10px 4px", fontSize: 11, color: "var(--muted-deep)", fontWeight: 600 }}>
            {ko ? "도움이 필요하신가요?" : "Need some help?"}
          </div>
          <FabItem
            icon={<IconChat size={15} />}
            label={ko ? "처음 설정 다시 보기" : "Replay setup"}
            onClick={() => {
              setOpen(false);
              onReplayOnboarding();
            }}
          />
          <FabItem
            icon={<IconLayers size={15} />}
            label={ko ? "앱 기능 다시 둘러보기" : "Take the tour again"}
            onClick={() => {
              setOpen(false);
              onReplayTour();
            }}
          />
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={ko ? "도움말" : "Help"}
        style={{
          width: 46,
          height: 46,
          borderRadius: "50%",
          border: "none",
          background: "var(--accent)",
          color: "#fff",
          fontSize: 22,
          fontWeight: 700,
          cursor: "pointer",
          boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {open ? "×" : "?"}
      </button>
    </div>
  );
}

function FabItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="hover-bg-fill"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 10px",
        borderRadius: 8,
        border: "none",
        background: "transparent",
        color: "var(--ink)",
        fontSize: 13,
        fontWeight: 500,
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
      }}
    >
      <span style={{ color: "var(--accent)", display: "inline-flex" }}>{icon}</span>
      {label}
    </button>
  );
}

const TOUR_STEPS = [
  {
    title: "Workspace",
    body: "여기서 에이전트에게 채팅으로 일을 시켜요. 처음엔 그냥 메시지만 보내도 충분해요 — 입력창 아래 옵션(클라우드 협업 등)은 익숙해지면 써보면 돼요.",
    bodyEn:
      "This is where you put your agents to work through chat. At first, just sending a message is enough — the options below the input box (like cloud collaboration) are there for when you get comfortable.",
  },
  {
    title: "Agent Forge",
    body: "나만의 에이전트나 팀을 직접 만들고 다듬는 곳이에요. 개발에 익숙한 분을 위한 고급 메뉴라, 처음엔 건너뛰어도 괜찮아요.",
    bodyEn:
      "This is where you build and fine-tune your own agents or teams. It's an advanced menu meant for those comfortable with development, so it's fine to skip it at first.",
  },
  {
    title: "Studio",
    body: "바로 쓸 수 있는 완성형 작업 앱들이에요(창업·커머스·크리에이티브 등). 하고 싶은 걸 적으면 알아서 만들어 줘요.",
    bodyEn:
      "These are ready-to-use, fully built work apps (for startups, commerce, creative work, and more). Just write down what you want to do, and it builds it for you.",
  },
  {
    title: "Hub",
    body: "남들이 만든 에이전트·팀을 찾아 설치하는 곳이에요. 설치는 무료고, 받은 에이전트는 내 구독으로 돌아가요.",
    bodyEn:
      "This is where you find and install agents and teams made by others. Installing is free, and the agents you get run on your own subscription.",
  },
  {
    title: "Environment",
    body: "AI 연결(구독·API 키)과 도구 설정을 관리하는 곳이에요. 잘 모르면 나중에 와도 괜찮아요.",
    bodyEn:
      "This is where you manage AI connections (subscriptions and API keys) and tool settings. If you're not sure, it's fine to come back later.",
  },
];

function FirstRunTour({
  open,
  step,
  onStep,
  onClose,
}: {
  open: boolean;
  step: number;
  onStep: (step: number) => void;
  onClose: () => void;
}) {
  const { t, locale } = useT();
  if (!open) return null;
  const current = TOUR_STEPS[Math.min(step, TOUR_STEPS.length - 1)];
  const last = step >= TOUR_STEPS.length - 1;
  return (
    <div
      className="titlebar-nodrag"
      role="dialog"
      aria-label="Agentlas menu tour"
      style={{
        position: "fixed",
        top: 64,
        left: "50%",
        transform: "translateX(-50%)",
        width: "min(460px, calc(100vw - 32px))",
        zIndex: 200,
        border: "1px solid var(--paper-edge)",
        borderRadius: 10,
        background: "var(--paper)",
        boxShadow: "0 16px 40px rgba(11, 11, 15, 0.16)",
        padding: 14,
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: -7,
          left: "50%",
          width: 12,
          height: 12,
          transform: "translateX(-50%) rotate(45deg)",
          background: "var(--paper)",
          borderLeft: "1px solid var(--paper-edge)",
          borderTop: "1px solid var(--paper-edge)",
        }}
      />
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: "var(--fill-1)", color: "var(--accent)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, flexShrink: 0 }}>
          {step + 1}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "var(--ink)" }}>{current.title}</h2>
          <p style={{ margin: "5px 0 0", fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>{locale === "ko" ? current.body : current.bodyEn}</p>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
        <div style={{ display: "flex", gap: 4, flex: 1 }}>
          {TOUR_STEPS.map((item, index) => (
            <button
              key={item.title}
              aria-label={`${index + 1}`}
              onClick={() => onStep(index)}
              style={{
                width: 22,
                height: 4,
                borderRadius: 999,
                border: "none",
                background: index === step ? "var(--accent)" : "var(--paper-edge)",
                padding: 0,
                cursor: "pointer",
              }}
            />
          ))}
        </div>
        <button onClick={onClose} style={tourSecondaryButton}>{t("onb.step.skip")}</button>
        <button
          onClick={() => {
            if (last) onClose();
            else onStep(step + 1);
          }}
          style={tourPrimaryButton}
        >
          {last ? (locale === "ko" ? "완료" : "Done") : t("onb.step.next")}
        </button>
      </div>
    </div>
  );
}

const tourSecondaryButton: React.CSSProperties = {
  height: 30,
  padding: "0 10px",
  borderRadius: 7,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--muted-deep)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

const tourPrimaryButton: React.CSSProperties = {
  height: 30,
  padding: "0 12px",
  borderRadius: 7,
  border: "none",
  background: "var(--ink)",
  color: "var(--paper)",
  fontSize: 12,
  fontWeight: 800,
  cursor: "pointer",
};
