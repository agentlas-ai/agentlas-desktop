// 사이드바 푸터의 작은 버전 표기 + 클릭 시 업데이트 강제 체크.
// 디버깅 가시성용: 사용자가 자기 앱이 어느 버전인지, 업데이트 체크가 실제로 도는지 확인 가능.
"use client";
import { useEffect, useState } from "react";
import { ipc, updaterEvents } from "@/lib/ipc";
import type { UpdaterState } from "@/lib/types";
import { useT } from "@/lib/i18n";

export function VersionChip() {
  const { t } = useT();
  const [version, setVersion] = useState<string>("");
  const [state, setState] = useState<UpdaterState>({ status: "idle" });
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    void api.app.getVersion().then(setVersion);
    void api.updater.getState().then(setState);
    const events = updaterEvents();
    const off = events?.onState((next) => setState(next));
    return () => off?.();
  }, []);

  async function check() {
    const api = ipc();
    if (!api || checking) return;
    setChecking(true);
    try {
      await api.updater.check();
    } finally {
      // 사용자가 시각적으로 확인할 수 있게 살짝 대기 후 해제
      setTimeout(() => setChecking(false), 1200);
    }
  }

  // 상태별 보조 표기 — 평소엔 vX.Y.Z만, 체크/다운로드/에러일 땐 그 상태를 짧게
  const subText = (() => {
    switch (state.status) {
      case "checking":
        return t("update.status.checking");
      case "downloading":
        return `${state.progress ?? 0}%`;
      case "downloaded":
        return t("update.status.ready");
      case "installing":
        return t("update.status.installing");
      case "updated":
        return t("update.status.updated");
      case "available":
        return t("update.status.available");
      case "manual-required":
        return state.canRetry ? t("update.status.retry") : t("update.status.paused");
      case "incompatible":
        return state.canRetry ? t("update.status.retry") : t("update.status.compatibility");
      case "recovery-required":
        return t("update.status.recovery");
      case "error":
        return t("update.status.check_failed");
      case "not-available":
        return null;
      default:
        return null;
    }
  })();

  return (
    <button
      onClick={() => void check()}
      disabled={checking}
      title={
        checking
          ? t("update.checking")
          : t("update.action.check")
      }
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 4,
        flex: "0 0 auto",
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        color: "var(--muted-deep)",
        whiteSpace: "normal",
        flexWrap: "wrap",
        overflowWrap: "anywhere",
        maxWidth: "100%",
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: checking ? "default" : "pointer",
        opacity: checking ? 0.5 : 1,
      }}
    >
      <span>v{version || "?"}</span>
      {subText && (
        <span
          style={{
            color: state.status === "idle" ? "var(--muted-deep)" : "var(--accent)",
            whiteSpace: "normal",
            overflowWrap: "anywhere",
          }}
        >
          · {subText}
        </span>
      )}
    </button>
  );
}
