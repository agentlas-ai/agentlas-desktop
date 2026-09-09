"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WorkLiveViewState, WorkLiveViewStatus } from "@/lib/types";
import styles from "./NativeLiveWebView.module.css";

// Native guests sit above the renderer DOM. Their hide/cleanup requests must be
// dispatched before a replacement surface paints; SSR has no native guest.
const useNativeViewLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type Props = {
  url: string;
  title: string;
  runtimeLabel?: string;
  bare?: boolean;
  mode?: "app" | "browser";
  viewId?: string;
  taskScopeId?: string;
  active?: boolean;
  /** Hide the guest on unmount; its task tab owner closes it explicitly. */
  retainOnUnmount?: boolean;
  onStatus?: (status: WorkLiveViewStatus) => void;
  /** Keep one native WebContentsView while its address changes through navigation controls. */
  stableNavigation?: boolean;
};

function nextViewId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `work_${random}`.slice(0, 72);
}

function stateLabel(state: WorkLiveViewState): string {
  if (state === "ready") return "Loaded";
  if (state === "error") return "OFFLINE";
  if (state === "closed") return "CLOSED";
  return "CONNECTING";
}

export function NativeLiveWebView({ url, title, runtimeLabel, bare = false, mode = "app", viewId, taskScopeId, active = true, retainOnUnmount = false, onStatus, stableNavigation = false }: Props) {
  const generationRef = useRef(0);
  const visibilityRef = useRef(active);
  visibilityRef.current = active;
  const syncRef = useRef<(() => void) | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewIdRef = useRef(viewId || nextViewId());
  const statusHandlerRef = useRef(onStatus);
  statusHandlerRef.current = onStatus;
  const initialUrlRef = useRef(url);
  const runtimeUrl = stableNavigation ? initialUrlRef.current : url;
  const statusRef = useRef<WorkLiveViewStatus>({ viewId: viewIdRef.current, state: "opening", url: runtimeUrl });
  const [status, setStatus] = useState<WorkLiveViewStatus>(statusRef.current);
  const [openError, setOpenError] = useState<string | null>(null);

  useNativeViewLayoutEffect(() => {
    const api = window.agentlas?.workLiveView;
    const stage = stageRef.current;
    if (!api || !stage) {
      setOpenError("The native live-view bridge is unavailable in this build.");
      return;
    }
    const viewId = viewIdRef.current;
    const generation = ++generationRef.current;
    // A new document/scope cannot inherit a previous effect's ready receipt.
    statusRef.current = { viewId, taskScopeId, state: "opening", url: runtimeUrl };
    setStatus(statusRef.current);
    setOpenError(null);
    let disposed = false;
    let frame = 0;
    let intersecting = true;
    let lastBounds = "";
    let receivedReady = false;

    const bounds = () => {
      const rect = stage.getBoundingClientRect();
      return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
    };
    const overlaySelector = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], dialog[open]';
    const geometricallyVisible = () => {
      const rect = stage.getBoundingClientRect();
      const covered = Array.from(document.querySelectorAll<HTMLElement>(overlaySelector)).some((overlay) => {
        const box = overlay.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(overlay).visibility !== "hidden"
          && box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top;
      });
      return visibilityRef.current && document.visibilityState === "visible" && !covered && intersecting
        && rect.width >= 120
        && rect.height >= 100
        && rect.bottom > 0
        && rect.right > 0
        && rect.top < window.innerHeight
        && rect.left < window.innerWidth;
    };
    let lastGeometry = bounds();
    const publishBounds = (visible: boolean) => {
      if (disposed) return;
      // Hiding never waits for a paint or a fresh layout measurement.
      if (visible) lastGeometry = bounds();
      const next = { viewId, taskScopeId, bounds: lastGeometry, visible };
      const signature = JSON.stringify(next);
      if (signature === lastBounds) return;
      lastBounds = signature;
      void api.setBounds(next).then((result) => {
        // Main can reject a stale owner/guest attachment without rejecting the
        // IPC promise. Let the next authoritative status retry the same
        // geometry; otherwise a failed visible=true handoff is cached forever.
        if (!result?.ok && lastBounds === signature) lastBounds = "";
      }).catch(() => { if (lastBounds === signature) lastBounds = ""; });
    };
    const readyToDisplay = () => statusRef.current.state === "ready"
      || (receivedReady && statusRef.current.state === "loading");
    const hideImmediately = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      publishBounds(false);
    };
    const syncBounds = () => {
      if (disposed) return;
      if (statusRef.current.state === "ready") receivedReady = true;
      else if (statusRef.current.state === "error" || statusRef.current.state === "closed") receivedReady = false;
      if (!visibilityRef.current || document.visibilityState !== "visible" || !intersecting || !readyToDisplay()) {
        hideImmediately();
        return;
      }
      // The current document remains displayed through subsequent navigation.
      // Only showing/resizing is frame-coalesced; terminal and privacy hides are not.
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (disposed) return;
        publishBounds(geometricallyVisible() && readyToDisplay());
      });
    };
    syncRef.current = syncBounds;
    const overlayChanged = (node: Node) => node instanceof Element
      && (Boolean(node.closest(overlaySelector)) || Boolean(node.querySelector(overlaySelector)));
    const overlays = new MutationObserver((records) => {
      if (!visibilityRef.current) return;
      if (records.some((record) => overlayChanged(record.target)
        || [...record.addedNodes, ...record.removedNodes].some(overlayChanged))) {
        if (!geometricallyVisible()) hideImmediately();
        else syncBounds();
      }
    });
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["open", "role", "aria-modal", "hidden", "style", "class"] });
    document.addEventListener("visibilitychange", syncBounds);
    const offStatus = api.onStatus((next) => {
      if (next.viewId !== viewId || next.taskScopeId !== taskScopeId || disposed) return;
      statusRef.current = next;
      setStatus(next);
      statusHandlerRef.current?.(next);
      if (next.state === "error") setOpenError(next.error || "The live app could not be loaded.");
      else if (next.state === "ready") setOpenError(null);
      // Native showOnly()/reparenting can detach a guest without changing its
      // URL or DOM geometry. Ready/loading receipts are the bounded, event
      // driven reattachment points; inactive tabs still publish visible=false
      // through syncBounds and therefore cannot fight the selected tab.
      if (next.state === "ready" || next.state === "loading" || next.presentation) lastBounds = "";
      syncBounds();
    });
    const resize = new ResizeObserver(syncBounds);
    resize.observe(stage);
    const intersection = new IntersectionObserver(
      ([entry]) => {
        intersecting = Boolean(entry?.isIntersecting);
        syncBounds();
      },
      { threshold: [0, 0.05] },
    );
    intersection.observe(stage);
    window.addEventListener("resize", syncBounds);
    window.addEventListener("scroll", syncBounds, true);

    const initialBounds = lastGeometry;
    void api.open({
      viewId,
      url: runtimeUrl,
      bounds: initialBounds,
      visible: false,
      mode,
      taskScopeId,
    }).then((result) => {
      if (disposed) {
        if (!retainOnUnmount && generationRef.current === generation) void api.close(viewId, taskScopeId);
        return;
      }
      if (!result.ok && result.reason !== "navigation-superseded") {
        const error = result.reason || "The live app could not be opened.";
        statusRef.current = { viewId, state: "error", url: runtimeUrl, error };
        setStatus(statusRef.current);
        setOpenError(error);
      }
      syncBounds();
    }).catch((error) => {
      if (disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      statusRef.current = { viewId, state: "error", url: runtimeUrl, error: message };
      setStatus(statusRef.current);
      setOpenError(message);
      syncBounds();
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      offStatus();
      syncRef.current = null;
      overlays.disconnect();
      document.removeEventListener("visibilitychange", syncBounds);
      resize.disconnect();
      intersection.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);
      if (retainOnUnmount) void api.setBounds({ viewId, taskScopeId, bounds: bounds(), visible: false });
      else void api.close(viewId, taskScopeId);
    };
  }, [mode, runtimeUrl, taskScopeId, retainOnUnmount]);

  useNativeViewLayoutEffect(() => { syncRef.current?.(); }, [active]);

  const reload = () => {
    setOpenError(null);
    statusRef.current = { ...statusRef.current, state: "loading", error: undefined };
    setStatus(statusRef.current);
    void window.agentlas.workLiveView.reload(viewIdRef.current, taskScopeId).then((result) => {
      if (!result.ok) throw new Error("The app view is no longer available.");
      syncRef.current?.();
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      statusRef.current = { ...statusRef.current, state: "error", error: message };
      setStatus(statusRef.current);
      setOpenError(message);
      syncRef.current?.();
    });
  };

  return (
    <section className={styles.shell} data-bare={bare ? "true" : "false"} aria-label={`${title} live app`}>
      {!bare && <div className={styles.toolbar}>
        <div className={styles.identity}>
          <span className={`${styles.statusDot} ${styles[status.state]}`} aria-hidden="true" />
          <strong>{title}</strong>
          <span className={styles.statusLabel}>{stateLabel(status.state)}</span>
          {runtimeLabel ? <span className={styles.runtimeLabel}>{runtimeLabel}</span> : null}
        </div>
        <div className={styles.actions}>
          <button type="button" onClick={reload}>Reload</button>
        </div>
      </div>}
      {!bare && <div className={styles.address} title={status.url || url}>{status.url || url}</div>}
      <div ref={stageRef} className={styles.stage}>
        {status.state !== "ready" && !openError ? (
          <div className={styles.message} role="status" aria-live="polite">
            <span className={styles.spinner} aria-hidden="true" />
            Connecting to the real app runtime…
          </div>
        ) : null}
        {openError ? (
          <div className={styles.message} role="alert">
            <strong>Live app unavailable</strong>
            <span>{openError}</span>
            <button type="button" onClick={reload}>Try again</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
