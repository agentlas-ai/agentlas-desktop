"use client";

import { useEffect, useRef, useState } from "react";
import type { ProductExtensionStatus, ProductExtensionViewBounds, ProductExtensionViewStatus } from "@shared/product-extension";
import { BrowserActionApprovalSheet } from "@/components/BrowserActionApprovalSheet";
import { ipc, ipcEvents } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
import { TaskSidePanel } from "@/components/workspace/TaskSidePanel";
import { useChatOutputs } from "@/lib/one-earlier-outputs";
import styles from "./ScienceHost.module.css";

function elementBounds(element: HTMLElement): ProductExtensionViewBounds {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

export default function ScienceHostPage() {
  const { locale } = useT();
  const ko = locale !== "en";
  const surfaceRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  const openedActivationRef = useRef<string | null>(null);
  const mountEpochRef = useRef(0);
  const [extension, setExtension] = useState<ProductExtensionStatus | null>(null);
  const [view, setView] = useState<ProductExtensionViewStatus | null>(null);
  const [approvalHeight, setApprovalHeight] = useState(0);
  const [outputScope, setOutputScope] = useState<{ chatId: string } | null>(null);
  const [outputWidth, setOutputWidth] = useState(324);
  const [outputEmpty, setOutputEmpty] = useState(false);
  const { artifacts, earlierOutputs: earlier } = useChatOutputs({
    chatId: outputScope?.chatId, historyEnabled: Boolean(outputScope), poll: true, pollIntervalMs: 1500,
  });

  useEffect(() => {
    let disposed = false;
    let reading = false;
    let generation = 0;
    let pendingRefresh = false;
    setOutputScope(null);
    const refresh = async () => {
      if (reading) { pendingRefresh = true; return; }
      reading = true;
      const requestGeneration = generation;
      const current = () => !disposed && requestGeneration === generation;
      try {
        const scope = await ipc()?.productExtensions.scienceOutputScope();
        if (current()) setOutputScope(previous => !scope ? null
          : previous?.chatId === scope.chatId ? previous : { chatId: scope.chatId });
      } catch { if (current()) setOutputScope(null); }
      finally {
        reading = false;
        if (!disposed && pendingRefresh) { pendingRefresh = false; void refresh(); }
      }
    };
    const offSelection = ipcEvents()?.onProductExtensionChanged?.((status) => {
      if (status.id !== "agentlas-science") return;
      generation += 1;
      setOutputScope(null);
      void refresh();
    });
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => { disposed = true; generation += 1; offSelection?.(); window.clearInterval(timer); };
  }, [view?.leaseId]);

  useEffect(() => {
    const surface = surfaceRef.current;
    const api = ipc();
    if (!surface || !api?.productExtensions) return;
    const epoch = ++mountEpochRef.current;
    const leaseId = crypto.randomUUID();
    let disposed = false;
    let requested = 0;
    let chain: Promise<void> = Promise.resolve();
    let checkedForUpdate = false;
    let observedView: ProductExtensionViewStatus | null = null;
    const isCurrent = () => !disposed && mountEpochRef.current === epoch;
    const activation = (status: ProductExtensionStatus) => JSON.stringify([status.version ?? null, status.installedAt ?? null]);
    const closeView = () => api.productExtensions.closeScienceView(leaseId).catch(() => undefined);
    // Installed timestamps identify same-version repairs too. Events only
    // invalidate the read: delayed payloads cannot close a newer activation.
    const refresh = () => {
      const request = ++requested;
      const current = () => isCurrent() && request === requested;
      const run = async () => {
        if (!current()) return;
        const failed: ProductExtensionViewStatus = {
          id: "agentlas-science", leaseId, state: "error", errorCode: "science-host-open-failed",
          errorMessage: "The Science interface could not be opened.",
        };
        const readStatus = async () => {
          const status = await api.productExtensions.scienceStatus().catch(() => null);
          // Main may have retired the child before this invalidation. Keep
          // any live lease, but expose a retryable fallback beneath it.
          if (!status && current()) setView(failed);
          return status;
        };
        let status = await readStatus();
        if (!current() || !status) return;
        if (status.readFailure) {
          // An unavailable authority read cannot grant a command or replace an
          // existing document. Main still checks every effect independently.
          if (!openedRef.current || observedView?.leaseId !== leaseId || observedView.state !== "ready") setView(failed);
          return;
        }
        setExtension(status);
        if (status.phase !== "installed" || !status.enabled) {
          openedRef.current = false;
          openedActivationRef.current = null;
          await closeView();
          return;
        }
        if (openedRef.current && activation(status) === openedActivationRef.current) {
          if (observedView) setView(observedView);
          return;
        }
        if (openedRef.current) {
          openedRef.current = false;
          await closeView();
        }
        if (!current()) return;
        // Closing yields to Main; revalidate the actual active package before
        // acquiring this lease instead of trusting the earlier event/read.
        status = await readStatus();
        if (!current() || !status) return;
        if (status.readFailure) { setView(failed); return; }
        setExtension(status);
        if (status.phase !== "installed" || !status.enabled) return;
        openedRef.current = true;
        openedActivationRef.current = activation(status);
        const nextView = await api.productExtensions.openScienceView(elementBounds(surface), leaseId).catch(() => failed);
        if (!isCurrent()) {
          await closeView(); // A late old open may release only its own lease.
          return;
        }
        if (nextView.state === "error" || nextView.state === "closed") openedRef.current = false;
        if (current()) { observedView = nextView; setView(nextView); }
        // Check once on entry, without blocking the installed interface. A
        // resulting unchanged broadcast must never create an open/install loop.
        if (!checkedForUpdate && nextView.state === "ready") {
          checkedForUpdate = true;
          if (api.productExtensions.installScienceSuite) void api.productExtensions.installScienceSuite().catch(() => undefined);
        }
      };
      // As on the Hub's native embed, serialize this lease's opens/closes.
      chain = chain.then(run, run).catch(() => undefined);
      return chain;
    };
    void refresh();
    let frame = 0;
    const resize = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (isCurrent() && openedRef.current) void api.productExtensions.setScienceViewBounds(elementBounds(surface), leaseId);
      });
    });
    resize.observe(surface);
    const offView = ipcEvents()?.onProductExtensionViewStatus?.((status) => {
      if (isCurrent() && status.leaseId === leaseId) {
        if (status.state === "closed" || status.state === "error") openedRef.current = false;
        observedView = status;
        setView(status);
      }
    });
    const offExtension = ipcEvents()?.onProductExtensionChanged?.((status) => {
      if (status.id === "agentlas-science") void refresh();
    });
    return () => {
      disposed = true;
      if (mountEpochRef.current === epoch) mountEpochRef.current += 1;
      window.cancelAnimationFrame(frame);
      resize.disconnect();
      offView?.();
      offExtension?.();
      openedRef.current = false;
      // Cleanup never waits for a potentially stalled open. Its late result
      // also releases this exact lease, leaving any newer mount untouched.
      void closeView();
    };
  }, []);

  const unavailable = extension !== null && (extension.phase !== "installed" || !extension.enabled);
  const failed = view?.state === "error";
  return (
    <>
      <div className={styles.page} style={approvalHeight > 0 ? {
        // Native WebContentsViews paint above renderer overlays. Reserve an
        // actual host-owned area; the surface observer updates native bounds.
        gridTemplateRows: `minmax(0, 1fr) ${approvalHeight}px`,
      } : undefined}>
        <div className={styles.workspace}>
        <div ref={surfaceRef} className={styles.surface}>
          {(unavailable || failed) && (
            <div className={styles.fallback}>
              <div className={styles.fallbackCard}>
                <h1>{failed ? (ko ? "Science를 열지 못했습니다" : "Science could not be opened") : (ko ? "Science가 설치되어 있지 않습니다" : "Science is not installed")}</h1>
                <p>{failed ? (view?.errorMessage ?? view?.errorCode) : (ko ? "설정에서 검증된 Science 확장을 설치하거나 다시 켜세요." : "Install or re-enable the verified Science extension in Settings.")}</p>
                <button type="button" onClick={() => navigate("/settings")}>{ko ? "설정 열기" : "Open Settings"}</button>
              </div>
            </div>
          )}
        </div>
        {outputScope && (artifacts.length > 0 || Boolean(earlier?.count)) && <aside className={styles.outputs}
          style={{ width: outputEmpty ? 0 : outputWidth }} aria-label={ko ? "결과" : "Outputs"}>
          <TaskSidePanel screenChatId={outputScope.chatId} locale={ko ? "ko" : "en"} items={artifacts}
            earlierOutputs={earlier} visible width={outputWidth} onResize={setOutputWidth} onEmptyChange={setOutputEmpty}
            onRequestReadableWidth={setOutputWidth} onRestorePreferredWidth={() => setOutputWidth(324)} />
        </aside>}
        </div>
      </div>
      <BrowserActionApprovalSheet onStandaloneHeightChange={setApprovalHeight} />
    </>
  );
}
