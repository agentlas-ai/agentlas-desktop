"use client";

import { useEffect, useRef, useState } from "react";
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
  const openedVersionRef = useRef<string | null>(null);
  const mountEpochRef = useRef(0);
  const [extension, setExtension] = useState<ProductExtensionStatus | null>(null);
  const [view, setView] = useState<ProductExtensionViewStatus | null>(null);

  useEffect(() => {
    const surface = surfaceRef.current;
    const api = ipc();
    if (!surface || !api?.productExtensions) return;
    const epoch = ++mountEpochRef.current;
    const leaseId = crypto.randomUUID();
    let disposed = false;
    const isCurrent = () => !disposed && mountEpochRef.current === epoch;
    const openView = async () => {
      openedRef.current = true;
      const nextView = await api.productExtensions.openScienceView(elementBounds(surface), leaseId).catch((): ProductExtensionViewStatus => ({
        id: "agentlas-science",
        leaseId,
        state: "error",
        errorCode: "science-host-open-failed",
        errorMessage: "The Science interface could not be opened.",
      }));
      if (isCurrent()) setView(nextView);
    };
    /*
     * ★들어올 때마다 새 판이 있는지 묻는다 (2026-09-08 실측으로 없던 것을 넣음).
     *   이 자리는 설치 여부만 보고 바로 열었고, 카탈로그를 읽는 경로는 설정 화면의
     *   "받기" 단추 하나뿐이었다. 그래서 한 번 설치한 사용자는 손으로 다시 누르기
     *   전까지 영원히 그 판을 썼다.
     *
     *   두 가지를 지킨다:
     *   - **여는 것을 막지 않는다.** 확인은 뒤에서 돌고 화면은 설치된 판으로 즉시 열린다.
     *     네트워크가 느리거나 끊겨 있어도 사용자는 기다리지 않는다.
     *   - **갱신되면 새 판을 잡는다.** 설치기가 판을 바꾸면 productExtensions:changed 가
     *     오고, 아래 구독이 그때 창을 닫았다 다시 연다.
     */
    const checkForUpdate = () => {
      if (!api.productExtensions.installScienceSuite) return;
      void api.productExtensions.installScienceSuite().catch(() => undefined);
    };
    const open = async () => {
      const status = await api.productExtensions.scienceStatus().catch(() => null);
      if (!isCurrent()) return;
      setExtension(status);
      if (!status || status.phase !== "installed" || !status.enabled) return;
      openedVersionRef.current = status.version ?? null;
      await openView();
      if (isCurrent()) checkForUpdate();
    };
    void open();
    let frame = 0;
    const resize = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (openedRef.current) void api.productExtensions.setScienceViewBounds(elementBounds(surface), leaseId);
      });
    });
    resize.observe(surface);
    const offView = ipcEvents()?.onProductExtensionViewStatus?.((status) => {
      if (status.leaseId === leaseId) setView(status);
    });
    const offExtension = ipcEvents()?.onProductExtensionChanged?.((status) => {
      if (status.id !== "agentlas-science") return;
      setExtension(status);
      // 갱신이 끝나 판이 바뀌었으면, 옛 판을 띄워 둔 창을 닫고 새 판으로 다시 연다.
      if (status.phase === "installed" && status.enabled && openedRef.current
        && (status.version ?? null) !== openedVersionRef.current) {
        openedVersionRef.current = status.version ?? null;
        openedRef.current = false;
        void api.productExtensions.closeScienceView(leaseId).then(() => {
          if (isCurrent()) void openView();
        });
        return;
      }
      if (status.phase !== "installed" || !status.enabled) {
        openedRef.current = false;
        void api.productExtensions.closeScienceView(leaseId);
      }
    });
    return () => {
      disposed = true;
      if (mountEpochRef.current === epoch) mountEpochRef.current += 1;
      window.cancelAnimationFrame(frame);
      resize.disconnect();
      offView?.();
      offExtension?.();
      openedRef.current = false;
      void api.productExtensions.closeScienceView(leaseId);
    };
  }, []);

  const unavailable = extension !== null && (extension.phase !== "installed" || !extension.enabled);
  const failed = view?.state === "error";
  return (
    <>
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
    </>
  );
}
