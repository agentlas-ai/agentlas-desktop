"use client";
// Site Studio: Web/mobile 화면은 self-contained HTML을 opaque-origin sandbox에서만
// 미리 본다. Agent App은 renderer가 실행 경로나 secret을 받지 않고, main이 검증한
// React + Astryx artifact와 capability-scoped runtime/public publish IPC만 사용한다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { getSnapshot as getBuildSnapshot, prepareBuildHandoff } from "@/lib/build-session";
import { navigate } from "@/lib/navigation";
import { SiteLanding, type SiteAgentAppMcpLiveState, elapsedCopy, formatElapsed } from "@/components/site/SiteLanding";
import { ElapsedClock } from "@/components/ElapsedClock";
import { SitePublishDialog } from "@/components/site/SitePublishDialog";
import { SITE_MESSAGE_KEY } from "@shared/site-studio";
import type {
  SiteAgentAppTargetRef,
  SiteGuestMessage,
  SiteActivityEvent,
  SiteConversationEntry,
  SiteHostMessage,
  SiteProjectOperation,
  SiteProjectPublicMeta,
  SiteScreenMeta,
  SiteSelectionPayload,
  SiteSurface,
} from "@shared/site-studio";

type DevicePreset = { id: string; label: string; labelEn: string; width: number };
const DEVICES: DevicePreset[] = [
  { id: "mobile", label: "모바일", labelEn: "Mobile", width: 375 },
  { id: "tablet", label: "태블릿", labelEn: "Tablet", width: 768 },
  { id: "desktop", label: "데스크탑", labelEn: "Desktop", width: 1280 },
];

type Diagnostic = { level: "error" | "warn"; message: string };
type LiveSiteActivity = { runId: string; status: string; feedback: string };

function isImeSubmit(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

export default function SiteStudioPage() {
  const { locale } = useT();
  const ko = locale !== "en";

  // ── 데이터 상태 ─────────────────────────────────────────
  const [projects, setProjects] = useState<SiteProjectPublicMeta[]>([]);
  const [agentAppMcpLiveStates, setAgentAppMcpLiveStates] = useState<Record<string, SiteAgentAppMcpLiveState>>({});
  const [projectId, setProjectId] = useState<string | null>(null);
  const [activeScreenId, setActiveScreenId] = useState<string | null>(null);
  const [avail, setAvail] = useState<{ ready: boolean; agent: string } | null>(null);

  // ── 홈(브리프) 상태 ─────────────────────────────────────
  const [view, setView] = useState<"home" | "studio">("home");
  const [generating, setGenerating] = useState(false);
  // A toast disappears in 3.5s and leaves the landing view looking untouched,
  // so a failed create reads as "the button did nothing". Keep the reason on
  // screen, with the exact request, until the user retries or dismisses it.
  const [createFailure, setCreateFailure] = useState<
    { reason: string; brief: string; surface: SiteSurface; agentAppTarget?: SiteAgentAppTargetRef; projectId: string | null } | null
  >(null);

  // ── 캔버스/렌더 상태 ────────────────────────────────────
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [renderKey, setRenderKey] = useState(0);
  const [device, setDevice] = useState<DevicePreset>(DEVICES[2]);
  const [selectMode, setSelectMode] = useState(false);
  const [selection, setSelection] = useState<SiteSelectionPayload | null>(null);
  const [selectionThumb, setSelectionThumb] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [instruction, setInstruction] = useState("");
  const [editing, setEditing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [conversation, setConversation] = useState<SiteConversationEntry[]>([]);
  const [liveActivity, setLiveActivity] = useState<LiveSiteActivity | null>(null);
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [handingOff, setHandingOff] = useState(false);
  const [remoteOperation, setRemoteOperation] = useState<SiteProjectOperation | null>(null);
  const [publishProjectId, setPublishProjectId] = useState<string | null>(null);

  // ── 새 화면 인라인 폼 ───────────────────────────────────
  const [addOpen, setAddOpen] = useState(false);
  const [addBrief, setAddBrief] = useState("");
  const [addSameStyle, setAddSameStyle] = useState(true);
  /*
   * 스타일 방향 — preload→IPC→프롬프트(STYLE DIRECTION)까지 전부 배선돼 있었는데
   * 렌더러가 한 번도 보내지 않아 죽어 있던 칸이다. 디자인 도구에서 "톤을 이렇게"는
   * 브리프와 다른 축이라 입력을 따로 준다.
   */
  const [addStyleHint, setAddStyleHint] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const nonceRef = useRef<string | null>(null);
  const selectModeRef = useRef(false);
  const activeScreenRef = useRef<string | null>(null);
  const scrollMapRef = useRef(new Map<string, { x: number; y: number }>());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversationProjectRef = useRef<string | null>(null);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  // 생성·수정·Build handoff는 같은 프로젝트 snapshot을 읽고 쓴다. React state가
  // 반영되기 전의 더블클릭까지 막기 위해 동기 ref를 단일 작업 mutex로 사용한다.
  const operationRef = useRef<"generate" | "edit" | "handoff" | null>(null);
  const projectRefreshGenerationRef = useRef(0);
  // Generation from the landing view has no open project yet, so activity would
  // otherwise be filtered out for its whole duration — up to the 10-minute
  // engine timeout. Track the in-flight project separately so the home view
  // receives the same live status and design feedback the studio view gets.
  const generatingProjectRef = useRef<string | null>(null);

  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId]);
  /* 앱 디자인 프로젝트인가 — 미리보기 기기 프레임과 내보내기 대상이 여기서 갈린다. */
  const appPreview = project?.surface === "mobile";
  const publishProject = useMemo(
    () => projects.find((candidate) => candidate.id === publishProjectId) ?? null,
    [projects, publishProjectId],
  );
  const screens = project?.screens ?? [];
  const activeScreen = screens.find((s) => s.id === activeScreenId) ?? null;
  const siteBusy = generating || editing || handingOff || remoteOperation !== null;

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const refreshProjects = useCallback(async (): Promise<SiteProjectPublicMeta[]> => {
    const generation = ++projectRefreshGenerationRef.current;
    // A prior approval is not a live-health cache. Clear it before the async
    // refresh so key removal or registry damage can never flash a stale ✓.
    setAgentAppMcpLiveStates({});
    const api = ipc();
    const list = (await api?.site?.listProjects?.()) ?? [];
    setProjects(list);
    const candidates = list.filter((candidate) =>
      candidate.surface === "agent-app" &&
      ((candidate.agentAppContract?.capabilities?.readonlyMcpCatalogIds.length ?? 0) +
        (candidate.agentAppContract?.capabilities?.unavailable.length ?? 0)) > 0,
    );
    const recommendAgentAppMcp = api?.site?.agentAppMcpRecommendation;
    const offlineStates = Object.fromEntries(
      candidates.map((candidate) => [candidate.id, { kind: "offline" } as const]),
    );
    if (generation === projectRefreshGenerationRef.current) setAgentAppMcpLiveStates(offlineStates);
    if (!recommendAgentAppMcp || candidates.length === 0) {
      return list;
    }
    void Promise.all(candidates.map(async (candidate) => {
      try {
        const recommendation = await recommendAgentAppMcp({ projectId: candidate.id });
        if (recommendation.projectId !== candidate.id || !Array.isArray(recommendation.rows)) {
          throw new Error("MCP recommendation identity mismatch");
        }
        return [candidate.id, { kind: "resolved", recommendation } as const] as const;
      } catch {
        return [candidate.id, { kind: "offline" } as const] as const;
      }
    })).then((entries) => {
      if (generation !== projectRefreshGenerationRef.current) return;
      setAgentAppMcpLiveStates(Object.fromEntries(entries));
    });
    return list;
  }, []);

  const syncOperationStatus = useCallback(async (pid: string) => {
    const operation = (await ipc()?.site?.operationStatus?.({ projectId: pid }).catch(() => null)) ?? null;
    if (conversationProjectRef.current !== pid) return;
    setRemoteOperation(operation);
    if (operation) {
      const status =
        operation === "generate"
          ? ko ? "새 화면을 생성하는 중…" : "Generating a new screen…"
          : operation === "edit"
            ? ko ? "화면 수정을 적용하는 중…" : "Applying screen edits…"
            : operation === "publish"
              ? ko ? "Agent App을 공개 배포하는 중…" : "Publishing the Agent App…"
              : ko ? "작업공간 리비전을 만드는 중…" : "Preparing a workspace revision…";
      setLiveActivity((current) => current ?? { runId: `restored:${pid}`, status, feedback: "" });
    } else {
      setLiveActivity((current) => current?.runId === `restored:${pid}` ? null : current);
    }
  }, [ko]);

  const loadConversation = useCallback(async (pid: string) => {
    try {
      const entries = (await ipc()?.site?.listConversation?.({ projectId: pid })) ?? [];
      if (conversationProjectRef.current === pid) setConversation(entries);
    } catch (error) {
      if (conversationProjectRef.current !== pid) return;
      setConversation([]);
      showToast(
        ko
          ? `대화 기록을 읽지 못했습니다. 손상된 원본은 보존했습니다: ${error instanceof Error ? error.message : String(error)}`
          : `Could not read the conversation. The damaged original was preserved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [ko, showToast]);

  useEffect(() => {
    void refreshProjects();
    ipc()
      ?.site?.contentAvailable?.()
      .then((a) => setAvail(a ?? { ready: false, agent: "web-master" }))
      .catch(() => setAvail({ ready: false, agent: "web-master" }));
  }, [refreshProjects]);

  useEffect(() => {
    const timeline = conversationScrollRef.current;
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }, [conversation.length, editing, generating, liveActivity?.feedback, liveActivity?.status]);

  useEffect(() => {
    const unsubscribe = ipcEvents()?.onSiteActivity?.((event: SiteActivityEvent) => {
      const watched = event.projectId === conversationProjectRef.current
        || event.projectId === generatingProjectRef.current;
      if (!watched) return;
      if (event.type === "message") {
        setConversation((prev) => (prev.some((entry) => entry.id === event.entry.id) ? prev : [...prev, event.entry]));
        return;
      }
      if (event.type === "status") {
        setLiveActivity((prev) =>
          prev?.runId === event.runId
            ? { ...prev, status: event.text }
            : { runId: event.runId, status: event.text, feedback: "" },
        );
        return;
      }
      if (event.type === "feedback-reset") {
        setLiveActivity((prev) => ({
          runId: event.runId,
          status: prev?.runId === event.runId ? prev.status : ko ? "디자인 피드백을 작성하는 중…" : "Writing design feedback…",
          feedback: "",
        }));
        return;
      }
      if (event.type === "feedback-delta") {
        setLiveActivity((prev) => ({
          runId: event.runId,
          status: prev?.runId === event.runId ? prev.status : ko ? "디자인 피드백을 작성하는 중…" : "Writing design feedback…",
          feedback: `${prev?.runId === event.runId ? prev.feedback : ""}${event.delta}`,
        }));
        return;
      }
      if (event.type === "complete") {
        setRemoteOperation(null);
        setLiveActivity(null);
      }
    });
    return () => unsubscribe?.();
  }, [ko]);

  // 시계는 ElapsedClock 리프가 스스로 돈다 — 조용한 단계에서도 라벨은 계속 흐르되
  // (see electron/site/generate.ts), 1,100줄 페이지가 초당 리렌더되지는 않는다.

  // ── 게스트(iframe) 통신 ─────────────────────────────────
  const postToGuest = useCallback((message: SiteHostMessage) => {
    const win = iframeRef.current?.contentWindow;
    const nonce = nonceRef.current;
    if (!win || !nonce) return;
    win.postMessage({ [SITE_MESSAGE_KEY]: nonce, message }, "*");
  }, []);

  const captureSelectionThumb = useCallback(async (payload: SiteSelectionPayload) => {
    setSelectionThumb(null);
    const iframe = iframeRef.current;
    if (!iframe) return;
    const box = iframe.getBoundingClientRect();
    const x = Math.max(box.left, box.left + payload.rect.x);
    const y = Math.max(box.top, box.top + payload.rect.y);
    const right = Math.min(box.right, box.left + payload.rect.x + payload.rect.width);
    const bottom = Math.min(box.bottom, box.top + payload.rect.y + payload.rect.height);
    if (right - x < 4 || bottom - y < 4) return;
    // 오버레이 하이라이트를 잠깐 숨기고 캡처(Orca 방식) — 복원은 finally에서.
    postToGuest({ type: "setOverlayVisible", visible: false });
    try {
      await new Promise((r) => setTimeout(r, 60));
      const res = await ipc()?.site?.captureRect?.({ x, y, width: right - x, height: bottom - y });
      if (res?.ok && res.dataUrl) setSelectionThumb(res.dataUrl);
    } finally {
      postToGuest({ type: "setOverlayVisible", visible: true });
    }
  }, [postToGuest]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;
      const data = event.data as { [SITE_MESSAGE_KEY]?: string; message?: SiteGuestMessage } | null;
      if (!data || data[SITE_MESSAGE_KEY] !== nonceRef.current || !data.message) return;
      const m = data.message;
      if (m.type === "ready") {
        const screenId = activeScreenRef.current;
        const pos = screenId ? scrollMapRef.current.get(screenId) : null;
        if (pos) postToGuest({ type: "restoreScroll", x: pos.x, y: pos.y });
        postToGuest({ type: "setMode", mode: selectModeRef.current ? "select" : "browse" });
      } else if (m.type === "select") {
        setSelection(m.payload);
        void captureSelectionThumb(m.payload);
      } else if (m.type === "scroll") {
        const screenId = activeScreenRef.current;
        if (screenId) scrollMapRef.current.set(screenId, { x: m.x, y: m.y });
      } else if (m.type === "console" || m.type === "pageError") {
        const message = m.type === "console" ? m.message : m.message;
        const level: Diagnostic["level"] = m.type === "pageError" || m.level === "error" ? "error" : "warn";
        setDiagnostics((prev) => [...prev.slice(-4), { level, message }]);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [captureSelectionThumb, postToGuest]);

  // ── 렌더 로드 ───────────────────────────────────────────
  const loadRender = useCallback(async (pid: string, screenId: string) => {
    const res = await ipc()?.site?.prepareRender?.({ projectId: pid, screenId });
    if (!res?.ok || !res.renderHtml || !res.nonce) {
      setSrcDoc(null);
      nonceRef.current = null;
      return false;
    }
    // nonce를 srcDoc보다 먼저 갱신 — ready 메시지가 새 nonce로 검증되도록.
    nonceRef.current = res.nonce;
    activeScreenRef.current = screenId;
    setSelection(null);
    setSelectionThumb(null);
    setDiagnostics([]);
    setSrcDoc(res.renderHtml);
    setRenderKey((k) => k + 1);
    return true;
  }, []);

  const openScreen = useCallback(
    async (pid: string, screenId: string, allowDuringOperation = false) => {
      if (operationRef.current && !allowDuringOperation) return;
      conversationProjectRef.current = pid;
      setLiveActivity(null);
      setProjectId(pid);
      setActiveScreenId(screenId);
      activeScreenRef.current = screenId;
      setView("studio");
      await Promise.all([loadConversation(pid), loadRender(pid, screenId), syncOperationStatus(pid)]);
    },
    [loadConversation, loadRender, syncOperationStatus],
  );

  // ── 생성/수정 흐름 ──────────────────────────────────────
  const runGenerate = useCallback(
    async (opts: {
      pid: string | null;
      briefText: string;
      variantCount: number;
      baseScreenId?: string;
      /** 브리프와 별개의 스타일 방향 — 프롬프트의 STYLE DIRECTION 으로 간다. */
      styleHint?: string;
      surface?: SiteSurface;
      agentAppTarget?: SiteAgentAppTargetRef;
    }) => {
      const text = opts.briefText.trim();
      if (!text || siteBusy || operationRef.current) return;
      operationRef.current = "generate";
      setGenerating(true);
      setGenerationStartedAt(Date.now());
      setCreateFailure(null);
      setLiveActivity(null);
      const surface = opts.surface ?? "web";
      const failWith = (reason: string, pid: string | null) => {
        showToast((ko ? "생성 실패: " : "Generation failed: ") + reason);
        setCreateFailure({ reason, brief: text, surface, agentAppTarget: opts.agentAppTarget, projectId: pid });
      };
      try {
        const siteApi = ipc()?.site;
        let pid = opts.pid;
        generatingProjectRef.current = pid;
        if (!pid) {
          const created = await siteApi?.createProject?.({
            name: text.slice(0, 30),
            surface: opts.surface,
            agentAppTarget: opts.agentAppTarget,
          });
          if (!created) {
            failWith(ko ? "Electron 브리지를 사용할 수 없습니다." : "Electron bridge unavailable.", null);
            return;
          }
          pid = created.id;
          generatingProjectRef.current = pid;
          setDevice(created.surface === "mobile" ? DEVICES[0] : DEVICES[2]);
          if (created.surface === "agent-app") {
            // This main-owned prompt must complete before design generation or
            // Astryx scaffolding starts. Cancel, missing key, bridge failure,
            // and readiness churn all continue safely in no-tool mode.
            try {
              const review = await siteApi?.prebuildReviewAgentAppMcp?.({ projectId: created.id });
              if (review?.status === "review-required") {
                showToast(ko
                  ? "MCP 상태가 검토 중 바뀌어 이번 앱은 MCP 없이 계속 만듭니다."
                  : "MCP state changed during review. This app will keep building without MCP.");
              }
            } catch {
              showToast(ko
                ? "MCP 추천을 확인하지 못해 이번 앱은 MCP 없이 계속 만듭니다."
                : "MCP recommendations were unavailable. This app will keep building without MCP.");
            }
          }
        }
        const res = await siteApi?.generateScreen?.({
          projectId: pid,
          brief: text,
          variants: opts.variantCount,
          baseScreenId: opts.baseScreenId,
          styleHint: opts.styleHint,
          locale: ko ? "ko" : "en",
        });
        if (!res?.ok || !res.screens?.length) {
          failWith(res?.reason ?? (ko ? "알 수 없는 이유" : "unknown"), pid);
          return;
        }
        const generatedScreens = res.screens;
        await refreshProjects();
        await openScreen(pid, generatedScreens[0].id, true);
        if (res.agentAppReason) {
          showToast(
            (ko ? "디자인은 완성했지만 Astryx 앱 소스를 만들지 못했습니다: " : "The design is ready, but the Astryx app scaffold failed: ") +
              res.agentAppReason,
          );
          return;
        }
        if (res.agentApp) {
          showToast(
            ko
              ? `Agent App과 Astryx React 소스를 만들었습니다 · ${res.agentApp.appName}`
              : `Agent App and Astryx React source are ready · ${res.agentApp.appName}`,
          );
          return;
        }
        showToast(
          generatedScreens.length > 1
            ? ko
              ? `시안 ${generatedScreens.length}개 생성 완료 (${res.engine})`
              : `${generatedScreens.length} variants ready (${res.engine})`
            : ko
              ? `화면 생성 완료 (${res.engine})`
              : `Screen ready (${res.engine})`,
        );
      } catch (error) {
        failWith(error instanceof Error ? error.message : String(error), generatingProjectRef.current);
      } finally {
        if (operationRef.current === "generate") operationRef.current = null;
        generatingProjectRef.current = null;
        setGenerating(false);
        setGenerationStartedAt(null);
        // Live activity belongs to the run that just ended. The studio view
        // restores its own status from main when a project is opened.
        setLiveActivity((current) => (current?.runId.startsWith("restored:") ? current : null));
      }
    },
    [ko, openScreen, refreshProjects, showToast, siteBusy],
  );

  const runEdit = useCallback(async () => {
    const text = instruction.trim();
    if (!text || siteBusy || operationRef.current || !projectId || !activeScreenId) return;
    operationRef.current = "edit";
    setEditing(true);
    try {
      const res = await ipc()?.site?.editScreen?.({
        projectId,
        screenId: activeScreenId,
        instruction: text,
        selectionId: selection?.id,
        selectionContext: selection ? selection.selector || selection.tagName : undefined,
        locale: ko ? "ko" : "en",
      });
      if (!res?.ok) {
        showToast((ko ? "수정 실패: " : "Edit failed: ") + (res?.reason ?? "unknown"));
        return;
      }
      setInstruction("");
      await refreshProjects();
      await loadRender(projectId, activeScreenId);
      await loadConversation(projectId);
      if (res.agentAppReason) {
        showToast(
          (ko ? "화면은 수정했지만 Astryx 앱 계약을 다시 만들지 못했습니다: " : "The screen changed, but the Astryx app contract could not be regenerated: ") +
            res.agentAppReason,
        );
        return;
      }
      showToast(
        res.mode === "patch"
          ? ko
            ? "선택 요소만 반영했습니다"
            : "Patched the selected element"
          : ko
            ? "화면 전체를 갱신했습니다"
            : "Regenerated the full screen",
      );
    } finally {
      if (operationRef.current === "edit") operationRef.current = null;
      setEditing(false);
    }
  }, [activeScreenId, instruction, ko, loadConversation, loadRender, projectId, refreshProjects, selection, showToast, siteBusy]);

  const fixWithAi = useCallback(
    (diag: Diagnostic) => {
      setSelection(null);
      setSelectionThumb(null);
      setInstruction((ko ? "이 화면에서 다음 오류를 고쳐줘: " : "Fix this error in the screen: ") + diag.message);
    },
    [ko],
  );

  const toggleSelectMode = useCallback(() => {
    if (siteBusy || operationRef.current) return;
    setSelectMode((prev) => {
      const next = !prev;
      selectModeRef.current = next;
      postToGuest({ type: "setMode", mode: next ? "select" : "browse" });
      if (!next) {
        setSelection(null);
        setSelectionThumb(null);
        postToGuest({ type: "clearSelection" });
      }
      return next;
    });
  }, [postToGuest, siteBusy]);

  const clearSelection = useCallback(() => {
    setSelection(null);
    setSelectionThumb(null);
    postToGuest({ type: "clearSelection" });
  }, [postToGuest]);

  const deleteScreen = useCallback(
    async (screenId: string) => {
      if (!projectId || siteBusy || operationRef.current) return;
      if (!window.confirm(ko ? "이 화면을 삭제할까요?" : "Delete this screen?")) return;
      try {
        await ipc()?.site?.deleteScreen?.({ projectId, screenId });
        const list = await refreshProjects();
        const meta = list.find((p) => p.id === projectId);
        if (activeScreenId === screenId) {
          const nextScreen = meta?.screens[0];
          if (nextScreen) await openScreen(projectId, nextScreen.id);
          else {
            setActiveScreenId(null);
            setSrcDoc(null);
            setView("home");
          }
        }
      } catch (error) {
        showToast((ko ? "화면을 삭제하지 못했습니다: " : "Could not delete the screen: ") + (error instanceof Error ? error.message : String(error)));
      }
    },
    [activeScreenId, ko, openScreen, projectId, refreshProjects, showToast, siteBusy],
  );

  const commitRename = useCallback(async () => {
    if (!projectId || !renamingId || siteBusy || operationRef.current) return;
    const name = renameDraft.trim();
    setRenamingId(null);
    if (!name) return;
    try {
      await ipc()?.site?.renameScreen?.({ projectId, screenId: renamingId, name });
      await refreshProjects();
    } catch (error) {
      showToast((ko ? "이름을 바꾸지 못했습니다: " : "Could not rename the screen: ") + (error instanceof Error ? error.message : String(error)));
    }
  }, [ko, projectId, renameDraft, renamingId, refreshProjects, showToast, siteBusy]);

  const exportScreen = useCallback(async () => {
    if (!projectId || !activeScreenId || siteBusy || operationRef.current) return;
    const res = await ipc()?.site?.exportScreen?.({ projectId, screenId: activeScreenId });
    if (res?.ok && res.path) showToast((ko ? "저장됨: " : "Saved: ") + res.path);
  }, [activeScreenId, ko, projectId, showToast, siteBusy]);

  /*
   * 디자인 → 코드. Site 는 디자인 생성기이므로(오너 정의 2026-08-20) 산출물의 마지막 칸은
   * 개발자가 가져갈 소스다: 웹은 React, 앱은 Flutter/React Native. 배포는 여기서 하지 않는다.
   */
  const [exportTargets, setExportTargets] = useState<string[]>([]);
  const [exportingTarget, setExportingTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) { setExportTargets([]); return; }
    let alive = true;
    void ipc()?.site?.exportTargets?.({ projectId })
      .then((res) => { if (alive && res?.ok && Array.isArray(res.targets)) setExportTargets(res.targets); })
      .catch(() => {});
    return () => { alive = false; };
  }, [projectId]);

  const exportCode = useCallback(async (target: string) => {
    if (!projectId || !activeScreenId || siteBusy || operationRef.current || exportingTarget) return;
    setExportingTarget(target);
    try {
      const res = await ipc()?.site?.exportScreenCode?.({ projectId, screenId: activeScreenId, target });
      if (res?.ok && res.path) {
        const count = res.files?.length ?? 0;
        showToast((ko ? `${target} 코드 ${count}개 파일 저장됨: ` : `Saved ${count} ${target} file(s): `) + res.path);
      } else if (res?.reason) {
        showToast((ko ? "코드 내보내기 실패: " : "Code export failed: ") + res.reason);
      }
    } finally {
      setExportingTarget(null);
    }
  }, [activeScreenId, exportingTarget, ko, projectId, showToast, siteBusy]);

  const exportZip = useCallback(async () => {
    if (!projectId || siteBusy || operationRef.current) return;
    const res = await ipc()?.site?.exportProjectZip?.({ projectId });
    if (res?.ok && res.path) showToast((ko ? "ZIP 저장됨: " : "ZIP saved: ") + res.path);
    else if (res?.reason) showToast((ko ? "내보내기 실패: " : "Export failed: ") + res.reason);
  }, [ko, projectId, showToast, siteBusy]);

  const handoffToWorkspace = useCallback(async () => {
    if (!projectId || siteBusy || operationRef.current) return;
    const api = ipc();
    if (!api) return;
    const currentBuild = getBuildSnapshot();
    if (currentBuild.phase === "running" || currentBuild.phase === "interview") {
      showToast(ko ? "진행 중인 Build를 먼저 완료하거나 취소해 주세요." : "Finish or cancel the active Build before importing this design.");
      return;
    }
    operationRef.current = "handoff";
    setHandingOff(true);
    try {
      // 대상 폴더를 사용자가 매번 직접 선택한다. 이 capability 외 경로에는 쓰지 않는다.
      const workspaceGrant = await api.fs.pickDirectory();
      if (!workspaceGrant) return;
      const res = await api.site.handoffToWorkspace({ projectId, workspaceGrant, locale: ko ? "ko" : "en" });
      if (!res.ok || !res.handoff) {
        showToast((ko ? "작업공간으로 가져오지 못했어요: " : "Could not import into the workspace: ") + (res.reason ?? "unknown"));
        return;
      }
      const prepared = prepareBuildHandoff({ workspace: workspaceGrant, request: res.handoff.buildPrompt });
      if (!prepared.ok) {
        showToast(
          ko
            ? `디자인 리비전은 ${res.handoff.relativePath}에 저장했습니다. 진행 중인 Build를 마친 뒤 다시 연결해 주세요.`
            : `The design revision was saved to ${res.handoff.relativePath}. Finish the active Build, then connect it again.`,
        );
        return;
      }
      navigate("/build");
    } catch (err) {
      showToast((ko ? "작업공간으로 가져오지 못했어요: " : "Could not import into the workspace: ") + (err instanceof Error ? err.message : String(err)));
    } finally {
      if (operationRef.current === "handoff") operationRef.current = null;
      setHandingOff(false);
    }
  }, [ko, projectId, showToast, siteBusy]);

  const deleteProject = useCallback(
    async (pid: string) => {
      if ((projectId === pid && siteBusy) || operationRef.current) return;
      if (!window.confirm(ko ? "프로젝트와 모든 화면을 삭제할까요?" : "Delete this project and all screens?")) return;
      try {
        const deleted = await ipc()?.site?.deleteProject?.({ projectId: pid });
        if (!deleted) throw new Error(ko ? "Electron 삭제 브리지를 사용할 수 없습니다." : "The Electron deletion bridge is unavailable.");
        if (!deleted.ok) {
          showToast(deleted.message);
          return;
        }
        if (projectId === pid) {
          setProjectId(null);
          setActiveScreenId(null);
          setSrcDoc(null);
        }
        await refreshProjects();
        showToast(deleted.message);
      } catch (error) {
        showToast((ko ? "프로젝트를 삭제하지 못했습니다: " : "Could not delete the project: ") + (error instanceof Error ? error.message : String(error)));
      }
    },
    [ko, projectId, refreshProjects, showToast, siteBusy],
  );

  const noEngine = avail !== null && !avail.ready;

  // ── 홈 뷰 ───────────────────────────────────────────────
  if (view === "home") {
    return (
      <div style={shell}>
        <SiteLanding
          projects={projects}
          agentAppMcpLiveStates={agentAppMcpLiveStates}
          locale={ko ? "ko" : "en"}
          busy={siteBusy}
          noEngine={noEngine}
          generating={generating}
          activity={generating ? liveActivity : null}
          elapsedStartedAt={generating ? generationStartedAt ?? undefined : undefined}
          failure={generating ? null : createFailure}
          onRetryCreate={() => {
            const failed = createFailure;
            if (!failed) return;
            // Reuse the project the failed attempt already created so retrying
            // never leaves an empty project behind in the gallery.
            void runGenerate({
              pid: failed.projectId,
              briefText: failed.brief,
              variantCount: 1,
              surface: failed.surface,
              agentAppTarget: failed.agentAppTarget,
            });
          }}
          onDismissFailure={() => setCreateFailure(null)}
          onCreate={({ brief: nextBrief, surface, agentAppTarget, variantCount }) => {
            void runGenerate({
              pid: null,
              briefText: nextBrief,
              // 랜딩에서 고른 시안 수를 그대로 쓴다(엔진 상한 3은 main 이 클램프).
              variantCount: variantCount ?? 1,
              surface,
              agentAppTarget,
            });
          }}
          onOpenProject={(nextProject) => {
            if (nextProject.surface === "agent-app" && nextProject.agentAppArtifact?.status === "ready") {
              void ipc()?.site?.launchAgentApp?.({ projectId: nextProject.id }).then((result) => {
                if (!result?.ok) showToast(result?.reason || (ko ? "Agent App을 실행하지 못했습니다." : "Could not launch the Agent App."));
              }).catch((error) => {
                showToast((ko ? "Agent App 실행 실패: " : "Agent App launch failed: ") + (error instanceof Error ? error.message : String(error)));
              });
              return;
            }
            setDevice(nextProject.surface === "mobile" ? DEVICES[0] : DEVICES[2]);
            if (nextProject.screens.length) void openScreen(nextProject.id, nextProject.screens[0].id);
            else {
              setProjectId(nextProject.id);
              setView("studio");
            }
          }}
          onExit={() => navigate("/dashboard")}
          onDeleteProject={(nextProjectId) => void deleteProject(nextProjectId)}
          onLoadAgentAppThumbnail={async (nextProjectId) => {
            const result = await ipc()?.site?.agentAppThumbnail?.({ projectId: nextProjectId });
            return result?.ok && result.dataUrl
              ? { ok: true, dataUrl: result.dataUrl }
              : { ok: false, reason: result?.reason || (ko ? "썸네일을 읽지 못했습니다." : "Could not read the thumbnail.") };
          }}
          onReviewAgentAppMcp={(nextProject) => {
            void ipc()?.site?.reviewAgentAppMcp?.({ projectId: nextProject.id }).then(async (result) => {
              await refreshProjects();
              if (result.status === "approved") {
                const ready = result.rows.filter((row) => row.readiness === "ready").length;
                showToast(ko
                  ? `MCP 사용을 허용했습니다 · 현재 연결 가능 ${ready}/${result.rows.length}`
                  : `MCP access allowed · ${ready}/${result.rows.length} currently ready`);
              } else if (result.status === "declined") {
                showToast(ko ? "이 Agent App은 MCP 없이 실행됩니다." : "This Agent App will run without MCP.");
              }
            }).catch((error) => {
              showToast((ko ? "MCP 검토 실패: " : "MCP review failed: ") + (error instanceof Error ? error.message : String(error)));
            });
          }}
          onPublishProject={(nextProject) => setPublishProjectId(nextProject.id)}
        />
        {publishProject && (
          <SitePublishDialog
            project={publishProject}
            locale={ko ? "ko" : "en"}
            onClose={() => setPublishProjectId(null)}
            onPublished={async (result) => {
              await refreshProjects();
              if (
                result.provider === "render" &&
                result.status === "needs-user-action" &&
                result.userAction?.code === "render-llm-key-required"
              ) {
                showToast(ko
                  ? "Render 서비스가 생성되었습니다. 게시 완료 전 LLM 키 설정이 필요합니다."
                  : "Render service created. LLM-key setup is required before publishing is complete.");
              } else if (
                (result.provider === "vercel" || result.provider === "railway") &&
                result.status === "needs-user-action" &&
                result.userAction?.code === "deployment-verification-required"
              ) {
                showToast(ko
                  ? "원격 배포 영수증은 저장했지만 공개 페이지 검증이 필요합니다. 아직 Live가 아닙니다."
                  : "The remote deployment receipt was saved, but public endpoint verification is still required. It is not Live yet.");
              } else if (!result.ok && (result.providerProjectId || result.url)) {
                showToast(ko
                  ? "Provider 변경 이력을 저장했습니다. 아직 Live가 아니며 dashboard에서 기존 resource와 secret 상태를 확인해야 합니다."
                  : "The provider mutation receipt was saved. It is not Live; review the existing resource and secret state in the provider dashboard.");
              } else {
                showToast(
                  result.url
                    ? (ko ? `공개 배포 완료: ${result.url}` : `Published: ${result.url}`)
                    : (ko ? "공개 배포가 완료되었습니다." : "Public deployment completed."),
                );
              }
            }}
          />
        )}
        {toast && <div style={toastStyle}>{toast}</div>}
      </div>
    );
  }

  // ── 스튜디오 뷰 ─────────────────────────────────────────
  return (
    <div style={shell}>
      <div style={topbar}>
        <button
          type="button"
          style={backLink}
          onClick={() => navigate("/dashboard")}
        >
          <span aria-hidden="true">←</span> Work
        </button>
        <span aria-hidden="true" style={{ color: "var(--paper-edge)" }}>·</span>
        <button
          type="button"
          style={backLink}
          disabled={siteBusy}
          onClick={() => {
            if (operationRef.current) return;
            setView("home");
            void refreshProjects();
          }}
        >
          <span aria-hidden="true">←</span> Site
        </button>
        <span style={wordmark}>{project?.name ?? (ko ? "사이트" : "Site")}</span>
        {activeScreen && <span style={projectContext}>{ko ? `${screens.length}개 버전` : `${screens.length} versions`}</span>}
        <div style={{ flex: 1 }} />
        <div style={{ display: "inline-flex", gap: 4 }}>
          {DEVICES.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDevice(d)}
              style={{ ...segBtn, ...(device.id === d.id ? segBtnOn : null) }}
              title={`${d.width}px`}
            >
              {ko ? d.label : d.labelEn}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={toggleSelectMode}
          disabled={siteBusy}
          style={{ ...ghostBtn, ...(selectMode ? { borderColor: "var(--accent)", color: "var(--accent)" } : null) }}
          aria-pressed={selectMode}
        >
          {ko ? "요소 선택" : "Select"}
        </button>
        <button type="button" style={ghostBtn} onClick={() => void exportScreen()} disabled={!activeScreenId || siteBusy}>
          HTML
        </button>
        {/* 디자인 → 코드. 표면이 허용하는 대상만 뜬다(웹: React, 앱: Flutter·React Native). */}
        {exportTargets.filter((target) => target !== "html").map((target) => (
          <button
            key={target}
            type="button"
            style={ghostBtn}
            onClick={() => void exportCode(target)}
            disabled={!activeScreenId || siteBusy || Boolean(exportingTarget)}
            title={ko ? "이 화면을 코드로 내보냅니다" : "Export this screen as code"}
          >
            {exportingTarget === target
              ? (ko ? "변환 중…" : "Converting…")
              : target === "react"
                ? "React"
                : target === "flutter"
                  ? "Flutter"
                  : "React Native"}
          </button>
        ))}
        <button type="button" style={ghostBtn} onClick={() => void exportZip()} disabled={siteBusy}>
          ZIP
        </button>
        <button
          type="button"
          style={primaryBtn}
          onClick={() => void handoffToWorkspace()}
          disabled={!projectId || siteBusy}
          title={
            ko
              ? "구현할 프로젝트 폴더를 선택하면 디자인 리비전을 복사하고 Build 화면으로 이동합니다."
              : "Choose a project folder to copy the design revision there and continue in Build."
          }
        >
          {handingOff ? (ko ? "Build로 넘기는 중…" : "Sending to Build…") : (ko ? "Build에서 이어서 구현" : "Continue in Build")}
        </button>
      </div>

      <div style={studioBody}>
        {/* 좌: 생성·수정 지시를 한 흐름으로 이어가는 Site 대화창 */}
        <aside style={chatPanel} aria-label={ko ? "사이트 디자인 대화" : "Site design conversation"}>
          <div style={chatPanelHeader}>
            <div>
              <div style={metaLabel}>SITE COPILOT</div>
              <strong style={chatPanelTitle}>{ko ? "사이트를 함께 다듬기" : "Refine this site together"}</strong>
            </div>
            <span style={chatStatus}>{siteBusy ? (ko ? "작업 중" : "Working") : ko ? "캔버스 연결됨" : "Canvas linked"}</span>
          </div>

          <div ref={conversationScrollRef} style={chatTimeline}>
            {conversation.length === 0 && (
              <div style={{ ...chatBubble, ...assistantBubble }}>
                {ko
                  ? "원하는 변경을 말해 주세요. 캔버스에서 요소를 선택하면 그 부분만 정확히 다듬을 수 있습니다."
                  : "Describe the change you want. Select an element on the canvas when you want a precise edit."}
              </div>
            )}
            {conversation.map((item) => (
              <div key={item.id} style={{ ...chatBubble, ...(item.role === "user" ? userBubble : assistantBubble) }}>
                {item.context && <span style={conversationContext}>{item.context}</span>}
                <span>{item.text}</span>
              </div>
            ))}
            {liveActivity ? (
              <div style={liveActivityCard} role="status" aria-live="polite">
                <div style={liveActivityHeader}>
                  <span style={livePulse} aria-hidden="true" />
                  <strong>{liveActivity.status}</strong>
                  <span style={liveBadge}>{ko ? "LIVE" : "LIVE"}</span>
                  <ElapsedClock startedAt={generationStartedAt} format={formatElapsed} style={liveActivityHint} />
                </div>
                {liveActivity.feedback && (
                  <p style={liveFeedbackText}>
                    {liveActivity.feedback}
                    <span style={typingCursor} aria-hidden="true" />
                  </p>
                )}
                <span style={liveActivityHint}>
                  {liveActivity.feedback
                    ? ko
                      ? "디자인 마스터의 피드백을 입력하고 있습니다"
                      : "The design master is typing feedback"
                    : ko
                      ? "현재 작업 단계를 실시간으로 표시합니다"
                      : "Showing the current work stage in real time"}
                </span>
              </div>
            ) : (
              (generating || editing) && (
                <div style={{ ...chatBubble, ...assistantBubble, color: "var(--muted-deep)" }}>
                  {generating
                    ? generationStartedAt !== null
                      ? <ElapsedClock startedAt={generationStartedAt} format={(ms) => elapsedCopy(ko, ms)} />
                      : elapsedCopy(ko, 0)
                    : ko
                      ? "수정 요청을 준비하는 중…"
                      : "Preparing the edit request…"}
                </div>
              )
            )}
          </div>

          {selection && (
            <div style={selectionCard}>
              <div style={selectionCardHeader}>
                <span>{ko ? "선택한 요소" : "Selected element"}</span>
                <button type="button" onClick={clearSelection} style={chipX} disabled={siteBusy} aria-label={ko ? "선택 해제" : "Clear selection"}>
                  ✕
                </button>
              </div>
              <div style={selectionCardBody}>
                {selectionThumb && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={selectionThumb} alt="" style={selectionThumbStyle} />
                )}
                <span>{selection.selector || selection.tagName}</span>
              </div>
            </div>
          )}

          {diagnostics.length > 0 && (
            <div style={diagnosticCard}>
              <div style={selectionCardHeader}>
                <span style={{ color: diagnostics[diagnostics.length - 1].level === "error" ? "var(--danger)" : "var(--warn)" }}>
                  {diagnostics[diagnostics.length - 1].level === "error" ? (ko ? "미리보기 오류" : "Preview error") : ko ? "미리보기 경고" : "Preview warning"}
                </span>
                <button type="button" onClick={() => setDiagnostics([])} style={chipX} aria-label={ko ? "닫기" : "Dismiss"}>
                  ✕
                </button>
              </div>
              <p style={diagnosticText}>{diagnostics[diagnostics.length - 1].message}</p>
              <button type="button" style={{ ...ghostBtn, alignSelf: "flex-start" }} disabled={siteBusy} onClick={() => fixWithAi(diagnostics[diagnostics.length - 1])}>
                {ko ? "대화에 가져오기" : "Bring into chat"}
              </button>
            </div>
          )}

          <div style={chatComposer}>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  if (isImeSubmit(e)) return;
                  e.preventDefault();
                  void runEdit();
                }
              }}
              placeholder={
                selection
                  ? ko
                    ? "선택한 요소를 어떻게 바꿀까요?"
                    : "How should the selected element change?"
                  : ko
                    ? "현재 버전에 대한 수정 지시를 입력하세요"
                    : "Describe a change for the current version"
              }
              rows={3}
              style={chatTextarea}
              disabled={siteBusy || !activeScreenId}
            />
            <div style={chatComposerFooter}>
              <span style={chatHint}>{ko ? "Enter 전송 · Shift+Enter 줄바꿈" : "Enter to send · Shift+Enter for a new line"}</span>
              <button
                type="button"
                style={{ ...primaryBtn, opacity: siteBusy || !instruction.trim() || !activeScreenId ? 0.5 : 1 }}
                disabled={siteBusy || !instruction.trim() || !activeScreenId}
                onClick={() => void runEdit()}
              >
                {editing ? (ko ? "반영 중…" : "Applying…") : ko ? "보내기" : "Send"}
              </button>
            </div>
          </div>
        </aside>

        {/* 우: 버전 탭 + 캔버스 */}
        <section style={previewColumn}>
          <div style={screenTabsBar}>
            <span style={tabRailLabel}>{ko ? "사이트 버전" : "SITE VERSIONS"}</span>
            <div style={screenTabs} role="tablist" aria-label={ko ? "사이트 버전" : "Site versions"}>
              {screens.map((s) => {
                const active = s.id === activeScreenId;
                return (
                  <div key={s.id} style={{ ...versionTab, ...(active ? versionTabActive : null) }}>
                    {renamingId === s.id ? (
                      <input
                        autoFocus
                        value={renameDraft}
                        disabled={siteBusy}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => void commitRename()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            if (isImeSubmit(e)) return;
                            e.preventDefault();
                            void commitRename();
                          }
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        style={tabRenameInput}
                      />
                    ) : (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active}
                        disabled={siteBusy}
                        style={{ ...versionTabMain, color: active ? "var(--accent)" : "var(--ink-soft)" }}
                        onClick={() => projectId && void openScreen(projectId, s.id)}
                        onDoubleClick={() => {
                          if (operationRef.current) return;
                          setRenamingId(s.id);
                          setRenameDraft(s.name);
                        }}
                        title={ko ? "더블클릭: 이름 변경" : "Double-click to rename"}
                      >
                        {s.variantLabel ? `${ko ? "시안" : "Variant"} ${s.variantLabel}` : s.name}
                      </button>
                    )}
                    <button
                      type="button"
                      style={versionTabClose}
                      disabled={siteBusy}
                      title={ko ? "버전 삭제" : "Delete version"}
                      aria-label={ko ? `${s.name} 삭제` : `Delete ${s.name}`}
                      onClick={() => void deleteScreen(s.id)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                style={{ ...versionAddTab, ...(addOpen ? versionTabActive : null) }}
                title={ko ? "새 버전 만들기" : "Create a new version"}
                aria-label={ko ? "새 버전 만들기" : "Create a new version"}
                disabled={siteBusy}
                onClick={() => setAddOpen((v) => !v)}
              >
                ＋
              </button>
            </div>
          </div>

          {addOpen && (
            <div style={newVersionBar}>
              <textarea
                value={addBrief}
                onChange={(e) => setAddBrief(e.target.value)}
                rows={1}
                placeholder={ko ? "새 버전에 담을 화면 또는 방향을 입력하세요" : "Describe the screen or direction for this new version"}
                style={newVersionInput}
                disabled={siteBusy}
              />
              <input
                value={addStyleHint}
                onChange={(e) => setAddStyleHint(e.target.value)}
                placeholder={ko ? "스타일 방향(선택): 예) 차분한 뉴트럴, 큰 여백" : "Style direction (optional): e.g. calm neutrals, generous spacing"}
                style={newVersionInput}
                disabled={siteBusy}
              />
              <label style={newVersionCheckbox}>
                <input type="checkbox" checked={addSameStyle} disabled={siteBusy} onChange={(e) => setAddSameStyle(e.target.checked)} />
                {ko ? "현재 버전의 스타일 유지" : "Match current version"}
              </label>
              <button
                type="button"
                style={{ ...primaryBtn, opacity: siteBusy || !addBrief.trim() ? 0.5 : 1 }}
                disabled={siteBusy || !addBrief.trim()}
                onClick={() => {
                  const text = addBrief;
                  const hint = addStyleHint.trim();
                  setAddBrief("");
                  setAddStyleHint("");
                  setAddOpen(false);
                  void runGenerate({
                    pid: projectId,
                    briefText: text,
                    variantCount: 1,
                    styleHint: hint || undefined,
                    baseScreenId: addSameStyle && activeScreenId ? activeScreenId : undefined,
                  });
                }}
              >
                {generating ? (ko ? "생성 중…" : "Creating…") : ko ? "새 버전" : "New version"}
              </button>
            </div>
          )}

          <div style={canvasWrap}>
            {generating && (
              <div style={busyOverlay}>
                <div style={busyCard}>
                  {ko ? "웹앱디자인마스터가 작업 중… (1~3분)" : "Design master at work… (1–3 min)"}
                </div>
              </div>
            )}
            {srcDoc ? (
              /*
               * 앱 디자인은 기기 프레임 안에서 본다 — "좁은 웹페이지"로 보이면 사람도
               * 모델도 앱 화면으로 판단하지 못한다(Site 는 웹과 앱 디자인을 함께 만든다).
               */
              <div style={{ ...frameHolder, width: appPreview ? APP_FRAME_WIDTH : device.width }}>
                <div style={appPreview ? appDeviceFrame : undefined}>
                  <iframe
                    key={renderKey}
                    ref={iframeRef}
                    title="site-preview"
                    sandbox="allow-scripts"
                    srcDoc={srcDoc}
                    style={{
                      ...frameStyle,
                      ...(appPreview ? appDeviceScreen : null),
                      cursor: selectMode ? "crosshair" : "auto",
                    }}
                  />
                </div>
              </div>
            ) : (
              <div style={canvasEmptyState}>
                {ko ? "상단 ＋ 탭에서 첫 사이트 버전을 만드세요." : "Create the first site version with the ＋ tab above."}
              </div>
            )}
          </div>
        </section>
      </div>

      {toast && <div style={toastStyle}>{toast}</div>}
    </div>
  );
}

// ── 스타일 (docs/DESIGN.md: 토큰만, 인라인 CSSProperties) ──────────
const shell: CSSProperties = { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--paper)", color: "var(--ink)", position: "relative" };
const topbar: CSSProperties = { minHeight: 44, borderBottom: "1px solid var(--paper-edge)", background: "var(--paper)", display: "flex", alignItems: "center", gap: 8, padding: "6px 16px 6px 90px", flexShrink: 0 };
const backLink: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, color: "var(--accent)", fontWeight: 800, fontSize: 12, background: "none", border: "none", cursor: "pointer", padding: 0 };
const wordmark: CSSProperties = { fontSize: 13, fontWeight: 800, color: "var(--ink)" };
const projectContext: CSSProperties = { fontSize: 11.5, color: "var(--muted-deep)" };
const ghostBtn: CSSProperties = { height: 30, border: "1px solid var(--paper-edge)", borderRadius: 7, background: "var(--paper)", color: "var(--ink-soft)", display: "inline-flex", alignItems: "center", gap: 6, padding: "0 11px", fontSize: 12, fontWeight: 800, cursor: "pointer" };
const primaryBtn: CSSProperties = { height: 30, border: "none", borderRadius: 7, background: "var(--accent)", color: "var(--white)", display: "inline-flex", alignItems: "center", gap: 6, padding: "0 13px", fontSize: 12, fontWeight: 900, cursor: "pointer" };
const ghostIconBtn: CSSProperties = { width: 24, height: 24, border: "none", borderRadius: 6, background: "transparent", color: "var(--muted-deep)", cursor: "pointer", fontSize: 12, lineHeight: "24px", flexShrink: 0 };
const segBtn: CSSProperties = { height: 28, border: "1px solid var(--paper-edge)", borderRadius: 7, background: "var(--paper)", color: "var(--ink-soft)", padding: "0 10px", fontSize: 11.5, fontWeight: 800, cursor: "pointer" };
const segBtnOn: CSSProperties = { borderColor: "var(--accent)", color: "var(--accent)", background: "var(--fill-1, rgba(0,0,0,.03))" };
const metaLabel: CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: ".14em", color: "var(--muted-deep)", textTransform: "uppercase" };

const studioBody: CSSProperties = { flex: 1, minHeight: 0, minWidth: 0, display: "flex" };
const chatPanel: CSSProperties = { width: 336, minWidth: 280, flex: "0 1 336px", borderRight: "1px solid var(--paper-edge)", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--paper)" };
const chatPanelHeader: CSSProperties = { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "15px 16px 13px", borderBottom: "1px solid var(--paper-edge)", flexShrink: 0 };
const chatPanelTitle: CSSProperties = { display: "block", marginTop: 5, color: "var(--ink)", fontSize: 14, lineHeight: 1.25 };
const chatStatus: CSSProperties = { marginTop: 1, padding: "4px 7px", borderRadius: 999, background: "var(--fill-1, rgba(0,0,0,.035))", color: "var(--muted-deep)", fontSize: 10.5, fontWeight: 800, whiteSpace: "nowrap" };
const chatTimeline: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 9, padding: "16px 14px" };
const chatBubble: CSSProperties = { maxWidth: "92%", padding: "10px 11px", borderRadius: 12, fontSize: 12.5, lineHeight: 1.52, whiteSpace: "pre-wrap" };
const assistantBubble: CSSProperties = { alignSelf: "flex-start", background: "var(--fill-1, rgba(0,0,0,.035))", color: "var(--ink-soft)", border: "1px solid var(--paper-edge)" };
const userBubble: CSSProperties = { alignSelf: "flex-end", background: "var(--accent)", color: "var(--white)" };
const conversationContext: CSSProperties = { display: "block", width: "max-content", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 6, padding: "2px 5px", borderRadius: 4, background: "color-mix(in srgb, currentColor 14%, transparent)", fontSize: 10.5, fontWeight: 800 };
const liveActivityCard: CSSProperties = { alignSelf: "flex-start", width: "100%", padding: 11, borderRadius: 12, border: "1px solid var(--accent)", background: "var(--fill-1, rgba(0,0,0,.035))", color: "var(--ink)" };
const liveActivityHeader: CSSProperties = { display: "flex", alignItems: "center", gap: 7, fontSize: 11.5, lineHeight: 1.35 };
const livePulse: CSSProperties = { width: 7, height: 7, borderRadius: 999, background: "var(--accent)", boxShadow: "0 0 0 4px color-mix(in srgb, var(--accent) 14%, transparent)", flexShrink: 0 };
const liveBadge: CSSProperties = { marginLeft: "auto", padding: "2px 5px", borderRadius: 4, background: "color-mix(in srgb, var(--accent) 14%, transparent)", color: "var(--accent)", fontSize: 9.5, fontWeight: 900, letterSpacing: ".08em" };
const liveFeedbackText: CSSProperties = { margin: "9px 0 5px", color: "var(--ink-soft)", fontSize: 12.5, lineHeight: 1.55, whiteSpace: "pre-wrap" };
const typingCursor: CSSProperties = { display: "inline-block", width: 6, height: "1em", marginLeft: 2, verticalAlign: "-0.12em", borderRadius: 1, background: "var(--accent)" };
const liveActivityHint: CSSProperties = { color: "var(--muted-deep)", fontSize: 10.5, lineHeight: 1.35 };
const selectionCard: CSSProperties = { margin: "0 14px 10px", padding: 10, border: "1px solid var(--accent)", borderRadius: 10, background: "var(--fill-1, rgba(0,0,0,.035))", flexShrink: 0 };
const selectionCardHeader: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, color: "var(--accent)", fontSize: 10.5, fontWeight: 900, letterSpacing: ".06em", textTransform: "uppercase" };
const selectionCardBody: CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginTop: 7, color: "var(--ink)", fontSize: 11.5, fontWeight: 700, minWidth: 0 };
const selectionThumbStyle: CSSProperties = { width: 42, height: 26, objectFit: "cover", borderRadius: 5, border: "1px solid var(--paper-edge)", flexShrink: 0 };
const diagnosticCard: CSSProperties = { margin: "0 14px 10px", padding: 10, border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper)", display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 };
const diagnosticText: CSSProperties = { margin: 0, color: "var(--ink-soft)", fontSize: 11.5, lineHeight: 1.45, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" };
const chatComposer: CSSProperties = { padding: "10px 12px 12px", borderTop: "1px solid var(--paper-edge)", background: "var(--paper)", flexShrink: 0 };
const chatTextarea: CSSProperties = { width: "100%", minHeight: 72, resize: "vertical", border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper)", color: "var(--ink)", padding: "9px 10px", fontSize: 12.5, lineHeight: 1.5, outline: "none", fontFamily: "inherit" };
const chatComposerFooter: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 8 };
const chatHint: CSSProperties = { color: "var(--muted-deep)", fontSize: 10.5, lineHeight: 1.25 };

const previewColumn: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" };
const screenTabsBar: CSSProperties = { minHeight: 48, display: "flex", alignItems: "center", gap: 12, padding: "7px 14px", borderBottom: "1px solid var(--paper-edge)", background: "var(--paper)", flexShrink: 0 };
const tabRailLabel: CSSProperties = { flexShrink: 0, color: "var(--muted-deep)", fontSize: 10.5, fontWeight: 900, letterSpacing: ".12em", whiteSpace: "nowrap" };
const screenTabs: CSSProperties = { minWidth: 0, flex: 1, overflowX: "auto", display: "flex", alignItems: "center", gap: 6, paddingBottom: 1 };
const versionTab: CSSProperties = { maxWidth: 190, height: 32, display: "flex", alignItems: "center", gap: 2, padding: "0 4px 0 8px", border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper)", flexShrink: 0 };
const versionTabActive: CSSProperties = { borderColor: "var(--accent)", background: "var(--fill-1, rgba(0,0,0,.035))" };
const versionTabMain: CSSProperties = { minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", border: "none", background: "transparent", cursor: "pointer", padding: 0, fontSize: 11.5, fontWeight: 800, textAlign: "left" };
const versionTabClose: CSSProperties = { width: 21, height: 21, border: "none", borderRadius: 5, background: "transparent", color: "var(--muted-deep)", cursor: "pointer", padding: 0, fontSize: 15, lineHeight: "18px", flexShrink: 0 };
const versionAddTab: CSSProperties = { width: 32, height: 32, border: "1px dashed var(--paper-edge)", borderRadius: 8, background: "var(--paper)", color: "var(--accent)", cursor: "pointer", fontSize: 17, lineHeight: 1, flexShrink: 0 };
const tabRenameInput: CSSProperties = { width: 128, minWidth: 0, border: "none", outline: "none", background: "transparent", color: "var(--ink)", fontSize: 11.5, fontWeight: 800, fontFamily: "inherit" };
const newVersionBar: CSSProperties = { display: "flex", alignItems: "center", gap: 9, padding: "8px 14px", borderBottom: "1px solid var(--paper-edge)", background: "var(--paper)", flexShrink: 0 };
const newVersionInput: CSSProperties = { flex: 1, minWidth: 130, height: 30, resize: "none", border: "1px solid var(--paper-edge)", borderRadius: 7, background: "var(--paper)", color: "var(--ink)", padding: "6px 9px", fontSize: 12, lineHeight: 1.35, outline: "none", fontFamily: "inherit" };
const newVersionCheckbox: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, color: "var(--ink-soft)", fontSize: 11, whiteSpace: "nowrap" };

const canvasWrap: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, overflow: "auto", display: "flex", justifyContent: "center", alignItems: "stretch", padding: 18, background: "var(--fill-1, rgba(0,0,0,.035))", position: "relative" };
const frameHolder: CSSProperties = { maxWidth: "100%", minHeight: 0, display: "flex", flexShrink: 0, margin: "0 auto" };
/* 앱 미리보기 — 최신 폰 기준(393x852). 생성 계약(outputContract)의 뷰포트와 같은 값이다. */
const APP_FRAME_WIDTH = 393;
const appDeviceFrame: CSSProperties = {
  width: APP_FRAME_WIDTH, height: 852, padding: 12, borderRadius: 44,
  background: "var(--black)", boxShadow: "0 18px 48px rgba(0,0,0,.28)", flexShrink: 0,
};
const appDeviceScreen: CSSProperties = { height: "100%", minHeight: 0, borderRadius: 32, border: "none" };
const frameStyle: CSSProperties = { width: "100%", height: "100%", minHeight: 480, border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper)", boxShadow: "var(--rd-shadow-1, 0 6px 24px rgba(0,0,0,.08))" };
const busyOverlay: CSSProperties = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "color-mix(in srgb, var(--paper) 55%, transparent)", zIndex: 5 };
const busyCard: CSSProperties = { padding: "10px 18px", borderRadius: 10, background: "var(--paper)", border: "1px solid var(--paper-edge)", fontSize: 13, fontWeight: 800, color: "var(--ink)" };
const canvasEmptyState: CSSProperties = { margin: "auto", color: "var(--muted-deep)", fontSize: 13, textAlign: "center" };
const chipX: CSSProperties = { border: "none", background: "none", color: "inherit", cursor: "pointer", fontSize: 11, padding: 0 };
const toastStyle: CSSProperties = { position: "absolute", bottom: 18, right: 18, padding: "9px 14px", borderRadius: 9, background: "var(--ink)", color: "var(--paper)", fontSize: 12, fontWeight: 700, zIndex: 20, maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
