"use client";

import { useEffect, useRef, useState } from "react";
import type { WorkLiveViewState, WorkLiveViewStatus } from "@/lib/types";
import styles from "./NativeLiveWebView.module.css";

type Props = {
  url: string;
  title: string;
  runtimeLabel?: string;
  bare?: boolean;
  mode?: "app" | "browser";
  viewId?: string;
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
  if (state === "ready") return "LIVE";
  if (state === "error") return "OFFLINE";
  if (state === "closed") return "CLOSED";
  return "CONNECTING";
}

export function NativeLiveWebView({ url, title, runtimeLabel, bare = false, mode = "app", viewId, onStatus, stableNavigation = false }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewIdRef = useRef(viewId || nextViewId());
  const statusHandlerRef = useRef(onStatus);
  statusHandlerRef.current = onStatus;
  const initialUrlRef = useRef(url);
  const runtimeUrl = stableNavigation ? initialUrlRef.current : url;
  const statusRef = useRef<WorkLiveViewStatus>({ viewId: viewIdRef.current, state: "opening", url: runtimeUrl });
  const [status, setStatus] = useState<WorkLiveViewStatus>(statusRef.current);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    const api = window.agentlas?.workLiveView;
    const stage = stageRef.current;
    if (!api || !stage) {
      setOpenError("The native live-view bridge is unavailable in this build.");
      return;
    }
    const viewId = viewIdRef.current;
    let disposed = false;
    let frame = 0;
    let intersecting = true;

    const bounds = () => {
      const rect = stage.getBoundingClientRect();
      return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
    };
    const geometricallyVisible = () => {
      const rect = stage.getBoundingClientRect();
      return intersecting
        && rect.width >= 120
        && rect.height >= 100
        && rect.bottom > 0
        && rect.right > 0
        && rect.top < window.innerHeight
        && rect.left < window.innerWidth;
    };
    const syncBounds = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        const visible = geometricallyVisible() && statusRef.current.state !== "error";
        void api.setBounds({ viewId, bounds: bounds(), visible });
      });
    };
    const offStatus = api.onStatus((next) => {
      if (next.viewId !== viewId || disposed) return;
      statusRef.current = next;
      setStatus(next);
      statusHandlerRef.current?.(next);
      if (next.state === "error") setOpenError(next.error || "The live app could not be loaded.");
      else if (next.state === "ready") setOpenError(null);
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

    const initialBounds = bounds();
    void api.open({
      viewId,
      url: runtimeUrl,
      bounds: initialBounds,
      visible: geometricallyVisible(),
      mode,
    }).then((result) => {
      if (disposed) {
        void api.close(viewId);
        return;
      }
      if (!result.ok) {
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
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      offStatus();
      resize.disconnect();
      intersection.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);
      void api.close(viewId);
    };
  }, [mode, runtimeUrl]);

  const reload = () => {
    setOpenError(null);
    statusRef.current = { ...statusRef.current, state: "loading", error: undefined };
    setStatus(statusRef.current);
    void window.agentlas.workLiveView.reload(viewIdRef.current).then(() => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (rect) {
        void window.agentlas.workLiveView.setBounds({
          viewId: viewIdRef.current,
          bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          visible: true,
        });
      }
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
