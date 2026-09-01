"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProductExtensionStatus, ProductExtensionViewBounds, ProductExtensionViewStatus } from "@shared/product-extension";
import { ProductModeMenu } from "@/components/one/ProductModeMenu";
import { ipc, ipcEvents } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
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
  const [extension, setExtension] = useState<ProductExtensionStatus | null>(null);
  const [view, setView] = useState<ProductExtensionViewStatus | null>(null);

  const open = useCallback(async () => {
    const api = ipc();
    const surface = surfaceRef.current;
    if (!api?.productExtensions || !surface) return;
    const status = await api.productExtensions.scienceStatus().catch(() => null);
    setExtension(status);
    if (!status || status.phase !== "installed" || !status.enabled) return;
    openedRef.current = true;
    setView(await api.productExtensions.openScienceView(elementBounds(surface)).catch((): ProductExtensionViewStatus => ({
      id: "agentlas-science",
      state: "error",
      errorCode: "science-host-open-failed",
      errorMessage: "The Science interface could not be opened.",
    })));
  }, []);

  useEffect(() => {
    void open();
    const surface = surfaceRef.current;
    const api = ipc();
    if (!surface || !api?.productExtensions) return;
    let frame = 0;
    const resize = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (openedRef.current) void api.productExtensions.setScienceViewBounds(elementBounds(surface));
      });
    });
    resize.observe(surface);
    const offView = ipcEvents()?.onProductExtensionViewStatus?.(setView);
    const offExtension = ipcEvents()?.onProductExtensionChanged?.((status) => {
      if (status.id !== "agentlas-science") return;
      setExtension(status);
      if (status.phase !== "installed" || !status.enabled) {
        openedRef.current = false;
        void api.productExtensions.closeScienceView();
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      resize.disconnect();
      offView?.();
      offExtension?.();
      openedRef.current = false;
      void api.productExtensions.closeScienceView();
    };
  }, [open]);

  const unavailable = extension !== null && (extension.phase !== "installed" || !extension.enabled);
  const failed = view?.state === "error";
  return (
    <div className={styles.page}>
      <header className={`${styles.header} titlebar-drag`}>
        <div className="titlebar-nodrag"><ProductModeMenu current="science" darkText locale={ko ? "ko" : "en"} /></div>
        <div className={styles.title}>{ko ? "재현 가능한 연구 워크벤치" : "Reproducible research workbench"}</div>
        <div className={styles.status}>{view?.state === "ready" ? (view.title || "Agentlas Science") : view?.state === "opening" ? (ko ? "여는 중" : "Opening") : ""}</div>
      </header>
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
    </div>
  );
}
