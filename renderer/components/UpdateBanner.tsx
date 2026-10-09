// 아이콘 중심 업데이트 행 — 실제 업데이트가 있을 때만 사이드바 하단에 노출.
//   - available:   새 버전 발견 (자동 다운로드 시작) 알림
//   - downloading: 진행률 표시
//   - downloaded:  "재시작 업데이트" 강조 버튼 (dismissed 전까지)
//   - manual-required: 앱 내 복구 재시도와 사용자 선택형 대체 경로 노출
//   - checking / not-available / routine error: 노출하지 않음 — 백그라운드로 조용히.
//
// 사용자가 "나중에"로 일단 닫으면 같은 다운로드 버전에 대해 다시 안 뜸 (세션 한정).
// 새 버전이 다시 다운로드되면 자동으로 다시 노출.
"use client";
import { useEffect, useId, useRef, useState } from "react";
import { IconAlertTriangle, IconCheck, IconChevronDown, IconClose, IconDownload, IconRefresh } from "@/components/Icon";
import { ipc, updaterEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { UpdaterState } from "@/lib/types";
import { updaterCanUseOfficialInstaller } from "@shared/types";
import { UpdateResumeConfirm } from "./UpdateResumeConfirm";

export function UpdateBanner({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useT();
  const [state, setState] = useState<UpdaterState>({ status: "idle" });
  /** 사용자가 "나중에" 누른 버전. 그 버전에 대해서는 더 이상 안 띄움 */
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);
  const [installDeferred, setInstallDeferred] = useState(false);
  /** Main's count + one-line names of the running work; the in-app confirm is open while set. */
  const [resumeConfirm, setResumeConfirm] = useState<{ count: number; line?: string } | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [laterChosen, setLaterChosen] = useState(false);
  const lastFocusCheck = useRef(0);
  const releaseNotesId = useId();

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
  const canUseOfficialInstaller = updaterCanUseOfficialInstaller(state);
  // "available"도 즉시 노출 — 새 버전 발견 순간 알림(자동 다운로드 중).
  const isDownloading = state.status === "downloading" || state.status === "available";
  const isDismissed =
    isDownloaded && state.version && dismissedVersion === state.version;
  const releaseNoteLines = (state.releaseNotes ?? "")
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 5);
  async function install() {
    const api = ipc();
    if (!api) return;
    setInstallDeferred(false);
    const result = await api.updater.install();
    if (result.blockedBy === "active-runs") {
      // Work is running: ask in-app (count + names from Main) instead of refusing.
      setResumeConfirm({ count: result.activeRunCount ?? 1, line: result.activeWorkLine });
      return;
    }
  }

  async function installAndResume() {
    const api = ipc();
    if (!api || resumeBusy) return;
    setResumeBusy(true);
    try {
      const result = await api.updater.install({ resumeWork: true });
      if (!result.accepted) setInstallDeferred(result.blockedBy === "active-runs");
    } finally {
      setResumeBusy(false);
      setResumeConfirm(null);
    }
  }

  async function installLater() {
    const result = await ipc()?.updater.deferInstall();
    setResumeConfirm(null);
    setLaterChosen(Boolean(result?.deferred));
  }

  const confirm = resumeConfirm ? (
    <UpdateResumeConfirm
      count={resumeConfirm.count}
      line={resumeConfirm.line}
      busy={resumeBusy}
      onInstall={() => void installAndResume()}
      onLater={() => void installLater()}
    />
  ) : null;

  // 실제 업데이트가 있을 때만 노출. checking/not-available/error 등 routine 백그라운드 체크는 숨김.
  if (!isDownloaded && !isDownloading && !isInstalling && !isManual) return confirm;
  if (isDownloaded && isDismissed) return confirm;

  async function retrySafetyAction() {
    const api = ipc();
    if (!api) return;
    if (state.code === "continuity-backup-failed") await api.updater.install();
    else await api.updater.check();
  }

  async function openOfficialInstaller() {
    await ipc()?.updater.openManualDownload();
  }

  const retrySourceSeal = state.code === "install-source-untrusted" && state.diagnostic?.category === "source-seal" && state.canRetry;

  async function openReleaseNotes() {
    await ipc()?.updater.openReleaseNotes(state.version);
  }

  const attentionCopy = state.code === "install-source-untrusted"
      ? t(state.diagnostic?.category === "source-seal" ? "update.source_files_changed" : "update.repair_required")
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
          : state.code === "minimum-app-version"
            ? t("update.too_old_to_auto_update")
          : state.code === "minimum-schema-version"
            ? t("update.schema_incompatible")
    : state.status === "incompatible"
      ? t("update.incompatible")
      : isManual
        ? t("update.manual_required")
        : isInstalling
          ? t("update.installing", { version: state.version ?? "?" })
          : "";

  const progress = state.status === "downloading" && typeof state.progress === "number" && Number.isFinite(state.progress)
    ? Math.round(Math.min(100, Math.max(0, state.progress)))
    : undefined;
  const progressLabel = progress === undefined
    ? t("update.found", { version: state.version ?? "?" })
    : t("update.downloading", { pct: progress });
  const recoveryLabel = canUseOfficialInstaller && !retrySourceSeal ? t("update.open_download") : t("update.retry");
  const deferredCopy = installDeferred ? t("update.active_runs") : laterChosen ? t("update.resume_deferred") : null;

  return (
    <>
    {confirm}
    <div
      className="sidenav-update-card titlebar-nodrag"
      data-downloaded={isDownloaded ? "true" : "false"}
      data-action-required={isManual ? "true" : "false"}
      data-collapsed={collapsed ? "true" : "false"}
      data-state={state.status}
      role={isManual ? "alert" : "status"}
      aria-live="polite"
      aria-busy={isDownloading || isInstalling}
    >
      {isDownloaded ? (
        collapsed ? (
          <button
            type="button"
            onClick={() => void install()}
            className="sidenav-update-action"
            aria-label={t("update.restart_action")}
            title={`${t("update.ready_version", { version: state.version ?? "?" })} · ${t("update.restart_now")}`}
          >
            <IconRefresh size={18} />
            <span className="sidenav-update-ready-dot" aria-hidden="true" />
          </button>
        ) : (
          <>
            <div className="sidenav-update-head">
              <button
                type="button"
                className="sidenav-update-secondary"
                aria-label={showReleaseNotes ? t("update.hide_whats_new") : t("update.whats_new")}
                title={showReleaseNotes ? t("update.hide_whats_new") : t("update.whats_new")}
                aria-expanded={showReleaseNotes}
                aria-controls={releaseNotesId}
                onClick={() => setShowReleaseNotes((visible) => !visible)}
              >
                <span className="sidenav-update-icon" aria-hidden="true"><IconCheck size={16} /></span>
                <span className="sidenav-update-copy">
                  <strong className="sidenav-update-version">v{state.version ?? "?"}</strong>
                  <span>{t("update.status.ready")}</span>
                </span>
                <span className="sidenav-update-chevron" data-open={showReleaseNotes ? "true" : "false"} aria-hidden="true">
                  <IconChevronDown size={12} />
                </span>
              </button>
              <button
                type="button"
                onClick={() => void install()}
                className="sidenav-update-action"
                aria-label={t("update.restart_action")}
                title={`${t("update.restart_action")} · ${t("update.ready_description")}`}
              >
                <IconRefresh size={18} />
              </button>
              <button
                type="button"
                onClick={() => state.version && setDismissedVersion(state.version)}
                aria-label={t("update.dismiss")}
                title={t("update.dismiss")}
                className="sidenav-update-dismiss"
              >
                <IconClose size={15} aria-hidden="true" />
              </button>
            </div>
            {deferredCopy && (
              <p className="sidenav-update-feedback" role="status" data-update-resume-deferred={laterChosen && !installDeferred ? "true" : undefined}>
                {deferredCopy}
              </p>
            )}
            {showReleaseNotes && (
              <div className="sidenav-update-changelog" id={releaseNotesId}>
                <p className="sidenav-update-description">{t("update.ready_description")}</p>
                <strong>{t("update.changelog_title")}</strong>
                {releaseNoteLines.length > 0 ? (
                  <ul>
                    {releaseNoteLines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
                  </ul>
                ) : (
                  <p>{t("update.changelog_unavailable")}</p>
                )}
                <button
                  type="button"
                  className="sidenav-update-release-link"
                  onClick={() => void openReleaseNotes()}
                >
                  {t("update.open_release_notes")}
                </button>
              </div>
            )}
          </>
        )
      ) : isManual ? (
        <>
          {(!collapsed || (!canUseOfficialInstaller && !state.canRetry)) && (
            <span className="sidenav-update-icon" title={attentionCopy} aria-hidden="true"><IconAlertTriangle size={17} /></span>
          )}
          <span className={collapsed ? "sr-only" : "sidenav-update-copy"}>
            <strong>{attentionCopy}</strong>
          </span>
          {(canUseOfficialInstaller || state.canRetry) && (
            <button
              type="button"
              onClick={() => void (
                canUseOfficialInstaller && !retrySourceSeal ? openOfficialInstaller() : retrySafetyAction()
              )}
              className="sidenav-update-action"
              aria-label={recoveryLabel}
              title={`${attentionCopy} · ${recoveryLabel}`}
            >
              {canUseOfficialInstaller && !retrySourceSeal ? <IconDownload size={18} /> : <IconRefresh size={18} />}
            </button>
          )}
        </>
      ) : (
        <>
          <UpdateProgress progress={isInstalling ? undefined : progress} installing={isInstalling} label={isInstalling ? attentionCopy : progressLabel} />
          {!collapsed && (
            <>
              <span className="sidenav-update-copy">
                <strong className="sidenav-update-version">v{state.version ?? "?"}</strong>
                {isInstalling && <span>{t("update.status.installing")}</span>}
              </span>
              {progress !== undefined && !isInstalling && <span className="sidenav-update-percent" aria-hidden="true">{progress}%</span>}
            </>
          )}
        </>
      )}
    </div>
    </>
  );
}

function UpdateProgress({ progress, installing, label }: { progress?: number; installing: boolean; label: string }) {
  return (
    <span
      className="sidenav-update-progress"
      data-indeterminate={progress === undefined ? "true" : "false"}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
      aria-valuetext={label}
      title={label}
    >
      <svg className="sidenav-update-progress-ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle className="sidenav-update-progress-track" cx="18" cy="18" r="15" />
        <circle className="sidenav-update-progress-fill" cx="18" cy="18" r="15" pathLength="100" strokeDasharray={progress === undefined ? "24 76" : "100"} strokeDashoffset={progress === undefined ? 0 : 100 - progress} />
      </svg>
      {installing ? <IconRefresh size={14} /> : <IconDownload size={14} />}
    </span>
  );
}
