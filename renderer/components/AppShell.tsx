// 모든 라우트의 공통 셸 — 좌측 Sidebar(glass) + 우측 페이지 슬롯.
// body 그라데이션 위에 떠 있는 frosted glass 레이아웃.
// + Electron 메뉴 → 라우터 브릿지.
// + 자동 업데이트 배너 (downloading/downloaded 상태에서만 노출).
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ProjectSidebar } from "./ProjectSidebar";
import { MenuBridge } from "./MenuBridge";
import { ImportAgentsModal } from "./ImportAgentsModal";
import TelegramOneDialog from "./connect/TelegramOneDialog";
import { ipc, ipcEvents, updaterEvents } from "@/lib/ipc";
import { SideNav } from "./SideNav";
import { ErrorBoundary } from "./ErrorBoundary";
import { usePathname } from "next/navigation";
import { registerRouter } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
import { IconLayers, IconBug, IconCheck } from "./Icon";
import { PageTour, replayCurrentPageTour } from "./PageTour";
import { BuildDoneToast } from "./BuildDoneToast";
import { BrowserActionApprovalSheet } from "./BrowserActionApprovalSheet";
import { AskUserSheet } from "./AskUserSheet";
import { ToolApprovalSheet } from "./ToolApprovalSheet";
import FloatingComputerUsePanel from "./browser/FloatingComputerUsePanel";
import { WorkFirstRunOnboarding } from "./WorkFirstRunOnboarding";
import { ScienceInstallExperience } from "./ScienceInstallExperience";
import { SCIENCE_INSTALL_DISCOVERY_ENABLED } from "@/lib/science-install-entry";
import { announceHubBookmarkChange } from "@/lib/hub-bookmark-events";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import {
  isMultimodalJobActive,
  startMultimodalJobMonitor,
  subscribeMultimodalJobs,
  visibleMultimodalJobs,
  type MultimodalJob,
} from "@/lib/multimodal/jobs";

const ONBOARDED_KEY = "agentlas.onboarded";
const IMPORT_PROMPTED_KEY = "agentlas.import.prompted";
const GUIDE_FAB_HIDDEN_KEY = "agentlas.guideFab.hidden";
const ATTENTION_POLL_MS = 3_000;
const ATTENTION_POLL_HIDDEN_MS = 15_000;

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
  const [pendingConfirmations, setPendingConfirmations] = useState(0);
  const [activeChatCount, setActiveChatCount] = useState<number | null>(null);
  const [multimodalJobs, setMultimodalJobs] = useState<MultimodalJob[]>([]);
  const [appUpdateBusy, setAppUpdateBusy] = useState(true);
  const [workFirstRunVisible, setWorkFirstRunVisible] = useState(false);
  const [sciencePromoVisible, setSciencePromoVisible] = useState(false);
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

  const syncAttention = useCallback(async () => {
    const api = ipc();
    if (!api) {
      setPendingConfirmations(0);
      return;
    }
    try {
      const list = await api.confirm.listPending();
      const count = list.length;
      setPendingConfirmations(count);
      await api.attention?.setPendingConfirmations(count);
    } catch {
      // Transient IPC errors should not clear an existing badge.
    }
  }, []);

  // 승인 대기(독 빨간 배지·독 튕김·"승인 대기" 알림)는 앱을 내려놓은 사이에 와도 떠야 하므로
  // 이 폴링만은 화면이 숨어도 계속 돈다(다른 폴러와 달리 절전 예외). 이 알림은 오직 렌더러
  // 폴링에만 물려 있어서(메인이 따로 안 쏨) 멈추면 최소화 중 승인 요청이 배지·알림으로 안 뜬다.
  // 다만 숨김 중 배지는 몇 초 늦어도 무방하므로 간격만 늘려 백그라운드 IPC를 줄인다.
  useEffect(() => {
    void syncAttention();
    let timer = window.setInterval(() => void syncAttention(), ATTENTION_POLL_MS);
    const onVisibility = () => {
      window.clearInterval(timer);
      const hidden = document.visibilityState === "hidden";
      timer = window.setInterval(() => void syncAttention(), hidden ? ATTENTION_POLL_HIDDEN_MS : ATTENTION_POLL_MS);
      if (!hidden) void syncAttention();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("agentlas:attention-refresh", syncAttention);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("agentlas:attention-refresh", syncAttention);
      const api = ipc();
      void api?.attention?.setPendingConfirmations(0);
    };
  }, [syncAttention]);

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
  const pageTourAutoOpenSuspended = workFirstRunVisible
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
        {pendingConfirmations > 0 && (
          <AttentionNudge
            count={pendingConfirmations}
            locale={locale}
            onOpen={() => router.push("/dashboard#approval-inbox")}
          />
        )}
        <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
      </main>
      <PageTour pathname={pathname} autoOpenSuspended={pageTourAutoOpenSuspended} />
      {pathname.startsWith("/dashboard") && (
        <WorkFirstRunOnboarding onVisibilityChange={setWorkFirstRunVisible} />
      )}
      {SCIENCE_INSTALL_DISCOVERY_ENABLED && (
        <ScienceInstallExperience
          eligible={sciencePromoEligible}
          locale={locale === "ko" ? "ko" : "en"}
          onVisibilityChange={setSciencePromoVisible}
        />
      )}
      <BuildDoneToast />
      <BrowserActionApprovalSheet />
      <AskUserSheet />
      <ToolApprovalSheet />
      {showWorkspaceSidebar && <FloatingComputerUsePanel />}
      <BackgroundWorkPill
        jobs={multimodalJobs}
        avoidComposer={pathname.startsWith("/workspace/task")}
        locale={locale}
        onOpen={() => router.push("/work")}
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

// 우측 하단 상시 가이드 버튼 — 언제든 메뉴 투어를 다시 부른다.
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
            label={ko ? "버그 신고하기" : "Report a bug"}
            onClick={() => {
              setOpen(false);
              setBugOpen(true);
            }}
          />
        </div>
      )}
      <BugReportModal open={bugOpen} onClose={() => setBugOpen(false)} />
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

// 버그 신고 팝업 — 신고 내용을 웹 API(→MongoDB)로 보낸다. 앱 버전/플랫폼은 메인이 첨부.
function BugReportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const pathname = usePathname() ?? "/";
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState("");
  const [severity, setSeverity] = useState<"low" | "medium" | "high">("medium");
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  // 열릴 때마다 폼 초기화.
  useEffect(() => {
    if (open) {
      setMessage("");
      setTitle("");
      setEmail("");
      setSeverity("medium");
      setStatus("idle");
      setErrorMsg("");
    }
  }, [open]);

  if (!open) return null;

  async function submit() {
    const body = message.trim();
    if (!body || status === "sending") return;
    setStatus("sending");
    setErrorMsg("");
    try {
      const res = await ipc()?.support.submitBugReport({
        message: body,
        title: title.trim() || undefined,
        email: email.trim() || undefined,
        severity,
        page: pathname,
        locale,
      });
      if (res?.ok) {
        setStatus("done");
        window.setTimeout(() => onClose(), 1400);
      } else {
        setStatus("error");
        setErrorMsg(
          res?.code === "network"
            ? ko
              ? "네트워크 오류로 전송하지 못했어요. 잠시 후 다시 시도해 주세요."
              : "Couldn't reach the server. Please try again shortly."
            : ko
              ? "전송에 실패했어요. 잠시 후 다시 시도해 주세요."
              : "Something went wrong. Please try again shortly.",
        );
      }
    } catch {
      setStatus("error");
      setErrorMsg(ko ? "전송에 실패했어요." : "Something went wrong.");
    }
  }

  const sevOptions: { key: "low" | "medium" | "high"; label: string }[] = [
    { key: "low", label: ko ? "사소함" : "Low" },
    { key: "medium", label: ko ? "보통" : "Medium" },
    { key: "high", label: ko ? "심각함" : "High" },
  ];

  return (
    <div
      className="titlebar-nodrag"
      role="dialog"
      aria-modal="true"
      aria-label={ko ? "버그 신고" : "Report a bug"}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        background: "rgba(11,11,15,0.42)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          width: "var(--popup-3-width)",
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
          background: "var(--paper)",
          border: "1px solid var(--paper-edge)",
          borderRadius: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,0.28)",
          padding: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <span style={{ color: "var(--accent)", display: "inline-flex" }}>
            <IconBug size={18} />
          </span>
          <strong style={{ fontSize: 16, color: "var(--ink)", flex: 1 }}>
            {ko ? "버그 신고" : "Report a bug"}
          </strong>
          <button
            type="button"
            onClick={onClose}
            aria-label={ko ? "닫기" : "Close"}
            style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              border: "none",
              background: "transparent",
              color: "var(--muted-deep)",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--muted-deep)", margin: "0 0 14px" }}>
          {ko
            ? "무슨 일이 있었는지 알려주세요. 앱 버전과 사용 환경은 자동으로 함께 전송돼요."
            : "Tell us what happened. Your app version and environment are attached automatically."}
        </p>

        {status === "done" ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "14px 12px",
              borderRadius: 10,
              background: "var(--green-soft, rgba(34,197,94,0.12))",
              color: "var(--green-deep, var(--ok))",
              fontSize: 13.5,
              fontWeight: 600,
            }}
          >
            <IconCheck size={16} />
            {ko ? "신고가 접수됐어요. 감사합니다!" : "Your report was received. Thank you!"}
          </div>
        ) : (
          <>
            <label style={{ display: "block", marginBottom: 12 }}>
              <span style={bugLabelStyle}>{ko ? "심각도" : "Severity"}</span>
              <div style={{ display: "flex", gap: 6 }}>
                {sevOptions.map((opt) => {
                  const active = severity === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setSeverity(opt.key)}
                      style={{
                        flex: 1,
                        padding: "7px 0",
                        borderRadius: 8,
                        border: `1px solid ${active ? "var(--accent)" : "var(--paper-edge)"}`,
                        background: active ? "var(--accent)" : "transparent",
                        color: active ? "var(--white)" : "var(--ink)",
                        fontSize: 12.5,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </label>

            <label style={{ display: "block", marginBottom: 12 }}>
              <span style={bugLabelStyle}>{ko ? "제목 (선택)" : "Title (optional)"}</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                placeholder={ko ? "한 줄 요약" : "One-line summary"}
                style={bugInputStyle}
              />
            </label>

            <label style={{ display: "block", marginBottom: 12 }}>
              <span style={bugLabelStyle}>
                {ko ? "무엇이 잘못됐나요?" : "What went wrong?"}
                <span style={{ color: "var(--red-deep, var(--danger))" }}> *</span>
              </span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={8000}
                rows={5}
                autoFocus
                placeholder={
                  ko
                    ? "무엇을 하려다 어떤 문제가 생겼는지 적어주세요."
                    : "Describe what you were doing and what went wrong."
                }
                style={{ ...bugInputStyle, resize: "vertical", minHeight: 96, fontFamily: "inherit" }}
              />
            </label>

            <label style={{ display: "block", marginBottom: 16 }}>
              <span style={bugLabelStyle}>{ko ? "이메일 (선택 · 후속 연락용)" : "Email (optional · for follow-up)"}</span>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                maxLength={200}
                placeholder="you@example.com"
                style={bugInputStyle}
              />
            </label>

            {status === "error" && (
              <div style={{ fontSize: 12.5, color: "var(--red-deep, var(--danger))", marginBottom: 12 }}>{errorMsg}</div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: "9px 16px",
                  borderRadius: 9,
                  border: "1px solid var(--paper-edge)",
                  background: "transparent",
                  color: "var(--ink)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {ko ? "취소" : "Cancel"}
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!message.trim() || status === "sending"}
                style={{
                  padding: "9px 18px",
                  borderRadius: 9,
                  border: "none",
                  background: !message.trim() || status === "sending" ? "var(--paper-edge)" : "var(--accent)",
                  color: "var(--white)",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: !message.trim() || status === "sending" ? "default" : "pointer",
                }}
              >
                {status === "sending" ? (ko ? "보내는 중…" : "Sending…") : ko ? "신고 보내기" : "Send report"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const bugLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--muted-deep)",
  marginBottom: 6,
};

const bugInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 11px",
  borderRadius: 9,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2, var(--paper))",
  color: "var(--ink)",
  fontSize: 13.5,
  outline: "none",
  boxSizing: "border-box",
};

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
    title: "Sites",
    body: "웹·모바일·에이전트용 인터페이스를 한 곳에서 만들고 다듬는 화면이에요.",
    bodyEn:
      "Build and refine interfaces for the web, mobile, and agents in one place.",
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
