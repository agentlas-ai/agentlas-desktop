"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProductExtensionStatus } from "@shared/product-extension";
import { IconBrain, IconCheck, IconPower, IconTrash } from "@/components/Icon";
import { confirmPopup } from "@/lib/popup";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { requestScienceInstall, SCIENCE_INSTALL_DISCOVERY_ENABLED } from "@/lib/science-install-entry";
import styles from "./ScienceExtensionPanel.module.css";

const SCIENCE_ID = "agentlas-science";

function statusLabel(status: ProductExtensionStatus | null, ko: boolean): string {
  if (!status) return ko ? "확인 중" : "Checking";
  if (status.phase === "installed") return ko ? "설치됨" : "Installed";
  if (status.phase === "disabled") return ko ? "꺼짐" : "Disabled";
  if (status.phase === "repair-required") {
    if (status.installed && status.enabled) return ko ? "설치됨" : "Installed";
    return ko ? "복구 필요" : "Repair required";
  }
  return ko ? "설치 안 됨" : "Not installed";
}

export function ScienceExtensionPanel() {
  const { locale } = useT();
  const ko = locale !== "en";
  const [status, setStatus] = useState<ProductExtensionStatus | null>(null);
  const [busy, setBusy] = useState<"install" | "toggle" | "uninstall" | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api?.productExtensions) return;
    try {
      setStatus(await api.productExtensions.scienceStatus());
    } catch {
      setNotice({ text: ko ? "Science 설치 상태를 읽지 못했습니다." : "Could not read the Science installation status.", error: true });
    }
  }, [ko]);

  useEffect(() => {
    void refresh();
    const off = ipcEvents()?.onProductExtensionChanged?.((next) => {
      if (next.id === SCIENCE_ID) setStatus(next);
    });
    return () => off?.();
  }, [refresh]);

  const install = async () => {
    if (busy) return;
    setNotice(null);
    requestScienceInstall();
  };

  const update = async () => {
    const api = ipc();
    if (!api?.productExtensions || busy) return;
    setBusy("install");
    setNotice({ text: ko ? "Science 업데이트를 확인하고 있습니다." : "Checking for Science updates…", error: false });
    try {
      const receipt = await api.productExtensions.installScienceSuite();
      const next = await api.productExtensions.scienceStatus();
      setStatus(next);
      if (receipt.ok && next.installed && next.enabled) {
        setNotice({
          text: receipt.action === "unchanged"
            ? (ko ? `Science가 최신 상태입니다 (v${next.version ?? "0.1.0"}).` : `Science is up to date (v${next.version ?? "0.1.0"}).`)
            : (ko ? `Science ${next.version ?? ""} 업데이트가 완료되었습니다.` : `Science ${next.version ?? ""} is ready.`),
          error: false,
        });
      } else if (receipt.code === "science-suite-package-unavailable" || receipt.code === "science-extension-package-unavailable" || receipt.message?.includes("built-in") || receipt.message?.includes("No verified")) {
        if (next?.installed && next.enabled && next.phase === "installed") {
          setNotice({
            text: ko
              ? `Science가 이 Desktop 빌드의 최신 버전(v${next.version ?? "0.1.0"})으로 유지되고 있습니다. Science 업데이트는 Desktop 앱 업데이트와 함께 제공됩니다.`
              : `Science is up to date for this Desktop build (v${next.version ?? "0.1.0"}). Science updates are delivered alongside Desktop application updates.`,
            error: false,
          });
        } else {
          setNotice({
            text: ko
              ? "이 Desktop 빌드에 사용 가능한 별도 패키지가 없습니다. 위쪽의 Desktop 앱 업데이트를 확인하거나 앱을 다시 설치해 주세요."
              : "No standalone package is available for this Desktop build. Please check for Desktop updates above or reinstall the application.",
            error: true,
          });
        }
      } else {
        setNotice({
          text: receipt.message ?? (ko ? "Science를 업데이트하지 못했습니다." : "Could not update Science."),
          error: true,
        });
      }
    } catch {
      await refresh();
      setNotice({ text: ko ? "Science 업데이트 확인 중 오류가 발생했습니다. 다시 시도해 주세요." : "Could not check for Science updates. Please try again.", error: true });
    } finally {
      setBusy(null);
    }
  };

  const toggle = async () => {
    const api = ipc();
    if (!api?.productExtensions || !status?.installed || busy) return;
    setBusy("toggle");
    setNotice(null);
    try {
      const next = await api.productExtensions.setScienceEnabled(!status.enabled);
      setStatus(next);
      setNotice({ text: next.enabled ? (ko ? "Science를 켰습니다." : "Science is enabled.") : (ko ? "Science를 껐습니다." : "Science is disabled."), error: false });
    } catch {
      await refresh();
      setNotice({ text: ko ? "변경 뒤 실제 상태를 다시 읽었습니다." : "The actual state was read again after the change failed.", error: true });
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async () => {
    const api = ipc();
    if (!api?.productExtensions || !status?.installed || busy) return;
    const confirmed = await confirmPopup(ko
      ? "Agentlas Science 프로그램을 제거할까요? 연구 프로젝트와 데이터는 보존됩니다."
      : "Remove Agentlas Science? Research projects and data will be preserved.", { locale: ko ? "ko" : "en", tone: "danger", confirmLabel: ko ? "제거" : "Remove" });
    if (!confirmed) return;
    setBusy("uninstall");
    setNotice(null);
    try {
      const receipt = await api.productExtensions.uninstallScience();
      await refresh();
      setNotice(receipt.ok
        ? { text: ko ? "Science 프로그램을 제거했습니다. 연구 데이터는 보존했습니다." : "Science was removed. Research data was preserved.", error: false }
        : { text: receipt.message ?? (ko ? "Science를 제거하지 못했습니다." : "Could not remove Science."), error: true });
    } catch {
      await refresh();
      setNotice({ text: ko ? "제거 요청 뒤 실제 상태를 다시 확인했습니다." : "The actual state was checked again after the removal request.", error: true });
    } finally {
      setBusy(null);
    }
  };

  const tone = status?.phase === "installed" ? "ready" : status?.phase === "repair-required" ? "error" : "neutral";
  if (!SCIENCE_INSTALL_DISCOVERY_ENABLED && !status?.installed) return null;

  return (
    <section className={styles.section} aria-labelledby="science-extension-title">
      <h2 id="science-extension-title" className={styles.heading}>Agentlas Science</h2>
      <div className={styles.card}>
        <div className={styles.summary}>
          <span className={styles.icon} aria-hidden="true"><IconBrain size={21} /></span>
          <div className={styles.copy}>
            <strong>{ko ? "대화형 과학 연구실" : "Conversational science lab"}</strong>
            <span>{ko
              ? "Science 작업 공간, Ketcher, Mol*을 하나의 패키지로 확인하고 설치합니다."
              : "Review and install the Science workspace, Ketcher, and Mol* as one package."}</span>
          </div>
          <span className={styles.status} data-tone={tone}>{statusLabel(status, ko)}</span>
        </div>

        <div className={styles.details}>
          <div className={styles.detail}><span>{ko ? "버전" : "Version"}</span><strong>{status?.version ?? "—"}</strong></div>
          <div className={styles.detail}><span>{ko ? "실행 방식" : "Runtime"}</span><strong>{ko ? "필요할 때만 시작" : "Lazy start"}</strong></div>
          <div className={styles.detail}><span>{ko ? "삭제 시 데이터" : "Data on removal"}</span><strong>{ko ? "보존" : "Preserved"}</strong></div>
        </div>

        <div className={styles.actions}>
          {/*
            * ★단추가 회색인데 **이유가 없었다** (마우스 실측 2026-09-08).
            *   상태를 아직 못 읽었을 때도, 다른 작업이 도는 중일 때도 똑같이 회색이라
            *   사용자는 기다려야 하는지 고장인지 구분할 수 없다.
            */}
          {!status?.installed ? (
            <button type="button" className={styles.button} data-testid="science-settings-review-package" data-primary="true" disabled={busy !== null || status === null}
              title={busy !== null
                ? (ko ? "다른 작업이 끝나면 누를 수 있습니다." : "Available once the current step finishes.")
                : status === null
                  ? (ko ? "설치 상태를 아직 읽지 못했습니다. 잠시 뒤 다시 열어 주세요." : "The install status has not been read yet. Reopen this panel in a moment.")
                  : undefined}
              onClick={() => void install()}>
              <IconCheck size={14} />
              {ko ? "패키지 확인" : "Review package"}
            </button>
          ) : (
            <>
              <button type="button" className={styles.button} data-testid="science-settings-update" disabled={busy !== null}
                title={busy !== null ? (ko ? "다른 작업이 끝나면 누를 수 있습니다." : "Available once the current step finishes.") : undefined}
                onClick={() => void update()}>
                <IconCheck size={14} /> {busy === "install" ? (ko ? "업데이트 확인 중…" : "Checking for updates…") : (ko ? "업데이트 확인" : "Check for updates")}
              </button>
              <button type="button" className={styles.button} data-primary={status.enabled ? "false" : "true"} disabled={busy !== null}
                title={busy !== null ? (ko ? "다른 작업이 끝나면 누를 수 있습니다." : "Available once the current step finishes.") : undefined}
                onClick={() => void toggle()}>
                <IconPower size={14} /> {status.enabled ? (ko ? "끄기" : "Disable") : (ko ? "켜기" : "Enable")}
              </button>
              <button type="button" className={styles.button} disabled={busy !== null}
                title={busy !== null ? (ko ? "다른 작업이 끝나면 누를 수 있습니다." : "Available once the current step finishes.") : undefined}
                onClick={() => void uninstall()}>
                <IconTrash size={14} /> {ko ? "프로그램 제거" : "Remove program"}
              </button>
            </>
          )}
        </div>
        {notice && <p className={styles.notice} data-error={notice.error ? "true" : "false"} role="status">{notice.text}</p>}
      </div>
    </section>
  );
}
