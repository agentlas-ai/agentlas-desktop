// 모든 라우트의 공통 셸 — 좌측 Sidebar(glass) + 우측 페이지 슬롯.
// body 그라데이션 위에 떠 있는 frosted glass 레이아웃.
// + Electron 메뉴 → 라우터 브릿지.
// + 자동 업데이트 배너 (downloading/downloaded 상태에서만 노출).
"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ProjectSidebar } from "./ProjectSidebar";
import { ProjectSettingsHost } from "./ProjectSettingsHost";
import { MenuBridge } from "./MenuBridge";
import { ImportAgentsModal } from "./ImportAgentsModal";
import TelegramOneDialog from "./connect/TelegramOneDialog";
import { ipc, ipcEvents, updaterEvents } from "@/lib/ipc";
import { SideNav } from "./SideNav";
import { ErrorBoundary } from "./ErrorBoundary";
import { usePathname } from "next/navigation";
import { registerRouter } from "@/lib/navigation";
import { useAttention } from "@/lib/attention";
import { AttentionCoveredSwitcherDot } from "./AttentionDot";
import { useT } from "@/lib/i18n";
import { IconLayers, IconBug, IconCheck } from "./Icon";
import { PageTour, replayCurrentPageTour } from "./PageTour";
import { BuildDoneToast } from "./BuildDoneToast";
import { BrowserActionApprovalSheet } from "./BrowserActionApprovalSheet";
import { AskUserSheet } from "./AskUserSheet";
import { ToolApprovalSheet } from "./ToolApprovalSheet";
import { WorkFirstRunOnboarding } from "./WorkFirstRunOnboarding";
import { ScienceInstallExperience } from "./ScienceInstallExperience";
import { SCIENCE_INSTALL_DISCOVERY_ENABLED } from "@/lib/science-install-entry";
import { announceHubBookmarkChange } from "@/lib/hub-bookmark-events";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { AgiBugReportDialog } from "./agi/AgiBugReport";
import {
  isMultimodalJobActive,
  startMultimodalJobMonitor,
  subscribeMultimodalJobs,
  visibleMultimodalJobs,
  type MultimodalJob,
} from "@/lib/multimodal/jobs";

/**
 * 오너가 부르지 않은 창(페이지 투어·Science 소개·에이전트 가져오기)을 저절로 여는가.
 * 오너 2026-09-29 "시트 띄우지말고 …" — 끈다. 각 창은 오너가 여는 길로만 남는다.
 */
const UNINVITED_AUTO_OPEN = false;
const GUIDE_FAB_HIDDEN_KEY = "agentlas.guideFab.hidden";

// 표시 내용이 같으면 이전 배열 참조를 그대로 돌려줘야 셸이 리렌더되지 않는다.
// visibleMultimodalJobs()는 호출마다 새 배열을 만들므로 여기서 걸러 준다.
function sameJobList(prev: MultimodalJob[], next: MultimodalJob[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    const a = prev[i];
    const b = next[i];
    if (
      a.id !== b.id || a.status !== b.status || a.percent !== b.percent
      || a.message !== b.message || a.phase !== b.phase || a.label !== b.label
      || a.updatedAtMs !== b.updatedAtMs
    ) return false;
  }
  return true;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [importOpen, setImportOpen] = useState(false);
  const [activeChatCount, setActiveChatCount] = useState<number | null>(null);
  const [multimodalJobs, setMultimodalJobs] = useState<MultimodalJob[]>([]);
  const [appUpdateBusy, setAppUpdateBusy] = useState(true);
  const [workFirstRunVisible, setWorkFirstRunVisible] = useState(false);
  const [sciencePromoVisible, setSciencePromoVisible] = useState(false);
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const { locale } = useT();
  // 승인 대기 수는 전역 주의 저장소가 센다(폴링·독 배지 포함 — 라우트 트리와 무관하게 돈다).
  // 대시보드 항목의 알림 수는 예전 그대로 "대화 질문(승인 인박스)"만 센다.
  const pendingConfirmations = useAttention(pathname).items.filter((item) => item.key.startsWith("confirm:")).length;

  // navigate() 헬퍼가 hard navigation(window.location) 대신 soft navigation을
  // 쓰도록 App Router 인스턴스를 등록한다. static export 셸에서 hard navigation은
  // RSC(.txt) 페이로드를 메인 document로 로드해 화면을 깨뜨린다. (navigation.ts 참고)
  useEffect(() => {
    registerRouter(router);
    return () => registerRouter(null);
  }, [router]);

  // Web↔Desktop Hub bookmark lifecycle sync. There is deliberately no polling:
  // startup, account changes, and returning focus/visibility are the only
  // automatic triggers. Main broadcasts the reconciled full snapshot so every
  // mounted surface replaces the same account-isolated slice at once.
  useEffect(() => {
    const api = ipc();
    if (!api?.marketplace?.syncBookmarks || !api.marketplace.onBookmarksSnapshot) return;
    let syncQueued = false;
    let syncTimer: number | null = null;
    const requestSync = () => {
      if (syncQueued) return;
      syncQueued = true;
      syncTimer = window.setTimeout(() => {
        syncQueued = false;
        syncTimer = null;
        void api.marketplace.syncBookmarks().catch(() => {
          // Offline keeps the last local cache/outbox; the next lifecycle trigger retries.
        });
      }, 0);
    };
    const unsubscribe = api.marketplace.onBookmarksSnapshot((snapshot) => {
      announceHubBookmarkChange({
        action: "synced",
        bookmarks: snapshot.bookmarks,
        syncedAt: snapshot.syncedAt,
      });
    });
    const unsubscribeAuth = api.auth.onSessionChanged?.(() => requestSync());
    const onVisibility = () => {
      if (document.visibilityState === "visible") requestSync();
    };
    requestSync();
    window.addEventListener("focus", requestSync);
    window.addEventListener("agentlas:auth-changed", requestSync);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (syncTimer !== null) window.clearTimeout(syncTimer);
      unsubscribe();
      unsubscribeAuth?.();
      window.removeEventListener("focus", requestSync);
      window.removeEventListener("agentlas:auth-changed", requestSync);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (!SCIENCE_INSTALL_DISCOVERY_ENABLED) return;
    let cancelled = false;
    const apply = (chatIds: string[]) => {
      if (!cancelled) setActiveChatCount(new Set(chatIds).size);
    };
    const api = ipc();
    if (api?.invoke?.activeChats) {
      void api.invoke.activeChats().then(apply).catch(() => {
        // Unknown authority remains fail-closed for this optional modal.
      });
    } else {
      setActiveChatCount(0);
    }
    const unsubscribe = ipcEvents()?.onActiveChats(apply);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  /*
   * ★저절로 뜨는 창은 없다 (오너 2026-09-29 "시트 띄우지말고 …").
   *   예전에는 로컬 에이전트가 0개면 "내 에이전트 가져오기" 모달을 세션마다 한 번 저절로
   *   띄웠다. 이제 이 모달은 오너가 여는 것만 남는다. 페이지 투어·Science 소개도 같은 이유로
   *   저절로 열지 않는다(투어는 도움말 버튼의 "투어 다시 보기"로 연다).
   */
  useEffect(() => {
    // 이 폴은 잡이 하나도 없어도 2초마다 새 배열로 setState 해 셸 전체(사이드바·
    // 투어·토스트 전부)를 상시 리렌더시키던 유일한 지점이다. 내용이 같으면 이전
    // 참조를 유지해 리렌더를 없애고, 창이 숨어 있는 동안은 틱을 쉰다(변화는
    // subscribeMultimodalJobs 이벤트가 즉시 반영한다).
    const sync = () => setMultimodalJobs((prev) => {
      const next = visibleMultimodalJobs();
      return sameJobList(prev, next) ? prev : next;
    });
    const tick = () => {
      if (document.visibilityState !== "hidden") sync();
    };
    sync();
    const stopMonitor = startMultimodalJobMonitor();
    const unsubscribe = subscribeMultimodalJobs(sync);
    const timer = window.setInterval(tick, 2_000);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
      stopMonitor();
    };
  }, []);

  useEffect(() => {
    if (!SCIENCE_INSTALL_DISCOVERY_ENABLED) return;
    let cancelled = false;
    const sync = (status: string) => {
      if (cancelled) return;
      setAppUpdateBusy([
        "available",
        "downloading",
        "downloaded",
        "installing",
        "manual-required",
        "incompatible",
      ].includes(status));
    };
    const api = ipc();
    if (api?.updater?.getState) {
      void api.updater.getState().then((state) => sync(state.status)).catch(() => sync("idle"));
    } else {
      sync("idle");
    }
    const off = updaterEvents()?.onState((state) => sync(state.status));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const showWorkspaceSidebar = pathname.startsWith("/workspace") || pathname.startsWith("/project");
  const sciencePromoPath = pathname.replace(/\.html$/, "");
  const sciencePromoRouteEligible =
    sciencePromoPath === "/"
    || sciencePromoPath === "/dashboard"
    || sciencePromoPath.startsWith("/library");
  const sciencePromoEligible = SCIENCE_INSTALL_DISCOVERY_ENABLED
    && sciencePromoRouteEligible
    && !workFirstRunVisible
    && pendingConfirmations === 0
    && activeChatCount === 0
    && !appUpdateBusy
    && !multimodalJobs.some(isMultimodalJobActive)
    && !importOpen;
  // 투어는 저절로 열지 않는다 — 도움말 버튼의 "투어 다시 보기"(replayCurrentPageTour)로만.
  const pageTourAutoOpenSuspended = !UNINVITED_AUTO_OPEN
    || workFirstRunVisible
    || sciencePromoVisible
    || (SCIENCE_INSTALL_DISCOVERY_ENABLED && sciencePromoRouteEligible);

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
      {!showWorkspaceSidebar && <SideNav pendingConfirmations={pendingConfirmations} />}
      {showWorkspaceSidebar && <ProjectSidebar />}
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
        <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
      </main>
      <ProjectSettingsHost />
      <PageTour pathname={pathname} autoOpenSuspended={pageTourAutoOpenSuspended} />
      {pathname.startsWith("/dashboard") && (
        <WorkFirstRunOnboarding onVisibilityChange={setWorkFirstRunVisible} />
      )}
      {SCIENCE_INSTALL_DISCOVERY_ENABLED && (
        <ScienceInstallExperience
          // 저절로 뜨는 소개 모달은 끈다. 설치는 전환기의 Science 항목(다운로드 필요)에서.
          eligible={UNINVITED_AUTO_OPEN && sciencePromoEligible}
          locale={locale === "ko" ? "ko" : "en"}
          onVisibilityChange={setSciencePromoVisible}
        />
      )}
      <AttentionCoveredSwitcherDot pathname={pathname} locale={locale === "ko" ? "ko" : "en"} />
      <BuildDoneToast />
      <BrowserActionApprovalSheet />
      <AskUserSheet />
      <ToolApprovalSheet />
      <BackgroundWorkPill
        jobs={multimodalJobs}
        avoidComposer={pathname.startsWith("/workspace/task")}
        locale={locale}
        onOpen={() => router.push("/dashboard")}
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
      {/* 커넥트 ▸ 텔레그램은 페이지가 아니라 팝업이다. 사이드바에서만 열리므로
          셸 안에 한 번만 마운트한다. */}
      <TelegramOneDialog />
      <GuideFab
        avoidComposer={pathname.startsWith("/workspace/task")}
        onReplayTour={replayCurrentPageTour}
      />
    </div>
  );
}

function BackgroundWorkPill({
  jobs,
  avoidComposer,
  locale,
  onOpen,
}: {
  jobs: MultimodalJob[];
  avoidComposer?: boolean;
  locale: string;
  onOpen: () => void;
}) {
  const job = jobs.find(isMultimodalJobActive) ?? jobs[0];
  if (!job) return null;
  const active = isMultimodalJobActive(job);
  const failed = job.status === "failed" || job.status === "cancelled";
  const ko = locale === "ko";
  const headline = active
    ? (ko ? "백그라운드 작업 중" : "Working in background")
    : failed
      ? (ko ? "확인 필요" : "Needs attention")
      : (ko ? "작업 완료" : "Work complete");
  const color = failed ? "var(--red-deep)" : active ? "var(--accent)" : "var(--green-deep)";
  const bottom = avoidComposer ? 160 : 78;

  return (
    <button
      type="button"
      className="background-work-pill titlebar-nodrag"
      style={{ bottom }}
      onClick={onOpen}
      aria-label={`Multimodal ${job.label} ${job.percent}%`}
    >
      <span
        className="background-work-ring"
        style={{ background: `conic-gradient(${color} ${job.percent}%, var(--paper-edge) 0)` }}
        aria-hidden="true"
      >
        <span>{job.percent}%</span>
      </span>
      <span className="background-work-copy">
        <strong>{headline}</strong>
        <span>{`${job.kind} · ${job.label} · ${job.title}`}</span>
      </span>
    </button>
  );
}

function GuideFab({
  avoidComposer,
  onReplayTour,
}: {
  avoidComposer?: boolean;
  onReplayTour: () => void;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [bugOpen, setBugOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bottom = avoidComposer ? 102 : 20;

  useDismissibleLayer({
    open,
    roots: [rootRef],
    restoreFocusRef: triggerRef,
    onDismiss: () => setOpen(false),
  });

  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(GUIDE_FAB_HIDDEN_KEY) === "1");
    } catch {
      // ignore
    }
  }, []);

  function hideGuideFab() {
    try {
      window.localStorage.setItem(GUIDE_FAB_HIDDEN_KEY, "1");
    } catch {
      // ignore
    }
    setOpen(false);
    setHidden(true);
  }

  if (hidden) return null;

  return (
    <div
      ref={rootRef}
      className="guide-fab titlebar-nodrag"
      style={{
        position: "fixed",
        right: "var(--guide-fab-right, 20px)",
        bottom: avoidComposer ? "var(--guide-fab-bottom-chat, 102px)" : "var(--guide-fab-bottom, 20px)",
        zIndex: 150,
      }}
    >
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
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 4px 4px 10px" }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--muted-deep)", fontWeight: 600 }}>
              {ko ? "도움이 필요하신가요?" : "Need some help?"}
            </div>
            <button
              type="button"
              onClick={hideGuideFab}
              aria-label={ko ? "도움말 버튼 숨기기" : "Hide help button"}
              title={ko ? "도움말 버튼 숨기기" : "Hide help button"}
              style={{
                width: 24,
                height: 24,
                borderRadius: 7,
                border: "none",
                background: "transparent",
                color: "var(--muted-deep)",
                cursor: "pointer",
                fontSize: 16,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
          <FabItem
            icon={<IconLayers size={15} />}
            label={ko ? "앱 기능 다시 둘러보기" : "Take the tour again"}
            onClick={() => {
              setOpen(false);
              onReplayTour();
            }}
          />
          <FabItem
            icon={<IconBug size={15} />}
            label={ko ? "결함 보고" : "Report a defect"}
            onClick={() => {
              setOpen(false);
              setBugOpen(true);
            }}
          />
        </div>
      )}
      {/* "결함 보고" (owner D5): the same preview-then-send path as the AGI chip; nothing leaves without Send. */}
      <AgiBugReportDialog open={bugOpen} onClose={() => setBugOpen(false)} draft={null} locale={ko ? "ko" : "en"} />
      <div style={{ position: "relative", width: 46, height: 46 }}>
        <button
          ref={triggerRef}
          onClick={() => setOpen((o) => !o)}
          aria-label={ko ? "도움말" : "Help"}
          style={{
            width: 46,
            height: 46,
            borderRadius: "50%",
            border: "none",
            background: "var(--accent)",
            color: "var(--white)",
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
        {!open && (
          <button
            type="button"
            onClick={hideGuideFab}
            aria-label={ko ? "도움말 버튼 숨기기" : "Hide help button"}
            title={ko ? "도움말 버튼 숨기기 — 다시 보려면 설정에서" : "Hide help button — re-enable in Settings"}
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              width: 18,
              height: 18,
              borderRadius: "50%",
              border: "1px solid var(--paper-edge)",
              background: "var(--paper)",
              color: "var(--muted-deep)",
              fontSize: 11,
              lineHeight: 1,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
            }}
          >
            ×
          </button>
        )}
      </div>
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
    title: "Hub",
    body: "공개 에이전트와 팀을 무료로 찾아보고 설치하는 곳이에요. 카드를 열면 에이전트 스페이스를 볼 수 있어요.",
    bodyEn:
      "Find and install shared agents and teams for free. Open a card to view its Agent Space.",
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
        width: "var(--popup-3-width)",
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
