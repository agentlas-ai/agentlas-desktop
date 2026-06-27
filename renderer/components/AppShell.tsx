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
import { TopNavbar } from "./TopNavbar";
import { usePathname } from "next/navigation";
import { registerRouter } from "@/lib/navigation";

const ONBOARDED_KEY = "agentlas.onboarded";
const IMPORT_PROMPTED_KEY = "agentlas.import.prompted";
const TOUR_DISMISSED_KEY = "agentlas.shellTour.dismissed.v1";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [importOpen, setImportOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStep, setTourStep] = useState(0);
  const router = useRouter();
  const pathname = usePathname() ?? "/";

  // navigate() 헬퍼가 hard navigation(window.location) 대신 soft navigation을
  // 쓰도록 App Router 인스턴스를 등록한다. static export 셸에서 hard navigation은
  // RSC(.txt) 페이로드를 메인 document로 로드해 화면을 깨뜨린다. (navigation.ts 참고)
  useEffect(() => {
    registerRouter(router);
    return () => registerRouter(null);
  }, [router]);

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
        flexDirection: "column",
        height: "100vh",
        background: "transparent",
        overflow: "hidden",
      }}
    >
      <TopNavbar />
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
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
          {children}
        </main>
      </div>
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
    </div>
  );
}

const TOUR_STEPS = [
  {
    title: "Workspace",
    body: "채팅으로 에이전트를 호출하고, 입력창의 Hephaestus 토글로 cloud, network, build, upload 명령을 바로 보낼 수 있습니다.",
  },
  {
    title: "Agent Forge",
    body: "Build는 새 에이전트와 팀을 만들고, Agent 메뉴는 프롬프트, 메모리, 플레이북, 진화 로그를 확인하고 수정하는 곳입니다.",
  },
  {
    title: "Studio",
    body: "Apps는 실제 first-party Studio와 생성 앱을 여는 작업 화면입니다. Startup Studio는 실제 로컬 런타임으로 실행됩니다.",
  },
  {
    title: "Hub",
    body: "Agentlas Web Hub와 같은 구조로 Team, Plugin, Agent를 찾고 설치합니다. Plugin은 로컬 MCP 도구 카탈로그와 연결됩니다.",
  },
  {
    title: "Environment",
    body: "API 키와 MCP 도구 설정을 관리합니다. Hub Plugin 설치 후 필요한 Env 키도 여기에서 이어집니다.",
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
          <p style={{ margin: "5px 0 0", fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>{current.body}</p>
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
        <button onClick={onClose} style={tourSecondaryButton}>건너뛰기</button>
        <button
          onClick={() => {
            if (last) onClose();
            else onStep(step + 1);
          }}
          style={tourPrimaryButton}
        >
          {last ? "완료" : "다음"}
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
