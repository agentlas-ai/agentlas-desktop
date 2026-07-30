// 자동 업데이트 카드 — 실제 업데이트가 있을 때만 좌측 사이드바 하단에 노출.
//   - available:   새 버전 발견 (자동 다운로드 시작) 알림
//   - downloading: 진행률 표시
//   - downloaded:  "재시작 업데이트" 강조 버튼 (dismissed 전까지)
//   - manual-required: 안전한 재시도 또는 로컬 데이터를 보존하는 공식 설치본 경로 노출
//   - recovery-required: 보존한 SQLite 복구본을 여는 경로 노출
//   - checking / not-available / routine error: 노출하지 않음 — 백그라운드로 조용히.
//
// 사용자가 "나중에"로 일단 닫으면 같은 다운로드 버전에 대해 다시 안 뜸 (세션 한정).
// 새 버전이 다시 다운로드되면 자동으로 다시 노출.
"use client";
import { useEffect, useRef, useState } from "react";
import { ipc, updaterEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { UpdaterState } from "@/lib/types";

export function UpdateBanner({ collapsed = false }: { collapsed?: boolean }) {
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
  const isInstalling = state.status === "installing";
  const isManual = state.status === "manual-required" || state.status === "incompatible";
  const isRecovery = state.status === "recovery-required";
  const canUseOfficialInstaller = state.status === "manual-required" && (
    state.code === "install-source-untrusted"
    || state.code === "install-not-applied"
    || state.code === "install-start-failed"
  );
  const canRevealRecovery = isRecovery && state.recoveryBackupAvailable === true;
  // "available"도 즉시 노출 — 새 버전 발견 순간 알림(자동 다운로드 중).
  const isDownloading = state.status === "downloading" || state.status === "available";
  const isDismissed =
    isDownloaded && state.version && dismissedVersion === state.version;
  // 실제 업데이트가 있을 때만 노출. checking/not-available/error 등 routine 백그라운드 체크는 숨김.
  if (!isDownloaded && !isDownloading && !isInstalling && !isManual && !isRecovery) return null;
  if (isDownloaded && isDismissed) return null;

  async function install() {
    const api = ipc();
    if (!api) return;
    await api.updater.install();
  }

  async function revealRecoveryBackup() {
    await ipc()?.updater.revealRecoveryBackup();
  }

  async function retrySafetyAction() {
    const api = ipc();
    if (!api) return;
    if (state.code === "continuity-backup-failed") await api.updater.install();
    else await api.updater.check();
  }

  async function openOfficialInstaller() {
    await ipc()?.updater.openManualDownload();
  }

  const attentionCopy = isRecovery
    ? t("update.recovery_required")
    : state.code === "install-source-untrusted"
      ? t("update.repair_required")
    : state.code === "install-not-applied"
      ? t("update.install_not_applied")
    : state.code === "install-start-failed"
      ? t("update.install_start_failed")
    : state.code === "continuity-backup-failed"
      ? t("update.safety_backup_failed")
      : state.code === "legacy-cleanup-failed"
        ? t("update.cleanup_failed")
        : state.code === "compatibility-metadata-missing"
          ? t("update.metadata_missing")
          : state.code === "minimum-schema-version"
            ? t("update.schema_incompatible")
    : state.status === "incompatible"
      ? t("update.incompatible")
      : isManual
        ? t("update.manual_required")
        : isInstalling
          ? t("update.installing", { version: state.version ?? "?" })
          : "";

  return (
    <div
      className="sidenav-update-card titlebar-nodrag"
      data-downloaded={isDownloaded ? "true" : "false"}
      data-action-required={isManual || isRecovery ? "true" : "false"}
      data-collapsed={collapsed ? "true" : "false"}
      role={isManual || isRecovery ? "alert" : "status"}
      aria-live="polite"
    >
      {isDownloaded ? (
        <>
          <span className="sidenav-update-dot" aria-hidden />
          <span className="sidenav-update-copy">
            <strong>{collapsed ? "↑" : t("update.ready_compact")}</strong>
          </span>
          <button
            onClick={() => void install()}
            className="sidenav-update-action"
            title={t("update.restart_now")}
          >
            {collapsed ? "↻" : t("update.restart_compact")}
          </button>
          {!collapsed && (
            <button
              onClick={() => state.version && setDismissedVersion(state.version)}
              aria-label={t("update.dismiss")}
              title={t("update.dismiss")}
              className="sidenav-update-dismiss"
            >
              ×
            </button>
          )}
        </>
      ) : isManual || isRecovery || isInstalling ? (
        <>
          <span className="sidenav-update-dot" aria-hidden />
          <span className="sidenav-update-copy">
            <strong>{collapsed ? "↑" : attentionCopy}</strong>
          </span>
          {!isInstalling && (
            (canRevealRecovery || canUseOfficialInstaller || state.canRetry) && (
              <button
                onClick={() => void (
                  canRevealRecovery
                    ? revealRecoveryBackup()
                    : canUseOfficialInstaller
                      ? openOfficialInstaller()
                    : state.canRetry
                      ? retrySafetyAction()
                      : retrySafetyAction()
                )}
                className="sidenav-update-action"
                title={
                  canRevealRecovery
                    ? t("update.reveal_recovery")
                    : canUseOfficialInstaller
                      ? t("update.open_download")
                    : state.canRetry
                      ? t("update.retry")
                      : t("update.retry")
                }
              >
                {collapsed
                  ? (state.canRetry && !isRecovery ? "↻" : "↗")
                  : canRevealRecovery
                    ? t("update.reveal_recovery")
                    : canUseOfficialInstaller
                      ? t("update.open_download")
                    : state.canRetry
                      ? t("update.retry")
                    : t("update.retry")}
              </button>
            )
          )}
        </>
      ) : (
        <>
          <Spinner />
          <span className="sidenav-update-copy">
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
