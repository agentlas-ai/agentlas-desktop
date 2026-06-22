// 자동 업데이트 배너 — 실제 업데이트가 있을 때만 노출 (우측 상단).
//   - available:   새 버전 발견 (자동 다운로드 시작) 알림
//   - downloading: 진행률 표시
//   - downloaded:  "재시작 업데이트" 강조 버튼 (dismissed 전까지)
//   - checking / not-available / error: 노출하지 않음 — 주기 체크(1시간)는 백그라운드로 조용히.
//
// 사용자가 "나중에"로 일단 닫으면 같은 다운로드 버전에 대해 다시 안 뜸 (세션 한정).
// 새 버전이 다시 다운로드되면 자동으로 다시 노출.
"use client";
import { useEffect, useRef, useState } from "react";
import { ipc, updaterEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { UpdaterState } from "@/lib/types";

export function UpdateBanner() {
  const { t } = useT();
  const [state, setState] = useState<UpdaterState>({ status: "idle" });
  /** 사용자가 "나중에" 누른 버전. 그 버전에 대해서는 더 이상 안 띄움 */
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const lastFocusCheck = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // 1) 마운트 직후 현재 상태 조회 — broadcast를 놓쳤을 경우의 백업
    const api = ipc();
    if (api) {
      void api.updater.getState().then((s) => {
        if (!cancelled) setState(s);
      });
    }
    // 창이 포커스될 때 자동 재확인(최대 10분에 1회) — 사용자가 수동으로 "업데이트 확인"을
    // 누르지 않아도 새 버전을 곧바로 발견·다운로드·알림.
    function onFocus() {
      const now = Date.now();
      if (now - lastFocusCheck.current < 10 * 60 * 1000) return;
      lastFocusCheck.current = now;
      void ipc()?.updater.check();
    }
    window.addEventListener("focus", onFocus);
    // 2) 이후 변화는 broadcast로 받음. checking/not-available/error는 그냥 상태만 갱신하고
    //    배너는 띄우지 않는다 — 백그라운드 체크가 사용자 화면에 안 보이게.
    const events = updaterEvents();
    const off = events?.onState((next) => {
      if (cancelled) return;
      setState(next);
    });
    return () => {
      cancelled = true;
      off?.();
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const isDownloaded = state.status === "downloaded";
  // "available"도 즉시 노출 — 새 버전 발견 순간 알림(자동 다운로드 중).
  const isDownloading = state.status === "downloading" || state.status === "available";
  const isDismissed =
    isDownloaded && state.version && dismissedVersion === state.version;
  // 실제 업데이트가 있을 때만 노출. checking/not-available/error 등 routine 백그라운드 체크는 숨김.
  if (!isDownloaded && !isDownloading) return null;
  if (isDownloaded && isDismissed) return null;

  async function install() {
    const api = ipc();
    if (!api) return;
    await api.updater.install();
  }

  return (
    <div
      // titlebar-drag 헤더 위에 떠 있으므로 no-drag로 클릭 영역을 확보한다.
      // (없으면 macOS가 이 영역을 창 드래그로 처리해 버튼 클릭이 먹히지 않는다.)
      className="titlebar-nodrag"
      style={{
        position: "absolute",
        top: 12,
        right: 16,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px 8px 14px",
        borderRadius: 999,
        background: isDownloaded ? "var(--accent)" : "var(--paper)",
        color: isDownloaded ? "white" : "var(--ink)",
        border: isDownloaded ? "none" : "1px solid var(--paper-edge)",
        boxShadow: isDownloaded
          ? "0 8px 24px rgba(11,11,15,0.18)"
          : "0 2px 8px rgba(11,11,15,0.06)",
        fontSize: 12,
        fontWeight: 500,
      }}
      role="status"
      aria-live="polite"
    >
      {isDownloaded ? (
        <>
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "white",
              boxShadow: "0 0 0 4px rgba(255,255,255,0.25)",
            }}
          />
          <span>
            {t("update.ready", { version: state.version ?? "?" })}
          </span>
          <button
            onClick={() => void install()}
            style={{
              padding: "4px 12px",
              borderRadius: 999,
              background: "white",
              color: "var(--accent)",
              fontWeight: 700,
              fontSize: 12,
              border: "none",
              cursor: "pointer",
              boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
            }}
          >
            {t("update.restart_now")}
          </button>
          <button
            onClick={() => state.version && setDismissedVersion(state.version)}
            aria-label={t("update.dismiss")}
            title={t("update.dismiss")}
            style={{
              padding: "2px 8px",
              borderRadius: 999,
              background: "transparent",
              color: "white",
              fontSize: 11,
              opacity: 0.85,
              border: "none",
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </>
      ) : (
        <>
          <Spinner />
          <span style={{ color: "var(--ink-soft)" }}>
            {state.status === "available"
              ? t("update.found", { version: state.version ?? "?" })
              : t("update.downloading", { pct: state.progress ?? 0 })}
          </span>
        </>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      style={{
        width: 12,
        height: 12,
        borderRadius: "50%",
        border: "2px solid var(--paper-edge)",
        borderTopColor: "var(--accent)",
        animation: "agentlas-spin 0.8s linear infinite",
        display: "inline-block",
      }}
    />
  );
}
