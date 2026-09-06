"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProductExtensionStatus } from "@shared/product-extension";
import { IconBrain, IconCheck, IconPower, IconTrash } from "@/components/Icon";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { requestScienceInstall, SCIENCE_INSTALL_DISCOVERY_ENABLED } from "@/lib/science-install-entry";
import styles from "./ScienceExtensionPanel.module.css";

const SCIENCE_ID = "agentlas-science";

function statusLabel(status: ProductExtensionStatus | null, ko: boolean): string {
  if (!status) return ko ? "확인 중" : "Checking";
  if (status.phase === "installed") return ko ? "설치됨" : "Installed";
  if (status.phase === "disabled") return ko ? "꺼짐" : "Disabled";
  if (status.phase === "repair-required") return ko ? "복구 필요" : "Repair required";
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
    setNotice({ text: ko ? "Science 업데이트를 확인하고 설치하고 있습니다." : "Checking and installing the Science update.", error: false });
    try {
      const receipt = await api.productExtensions.installScienceSuite();
      const next = await api.productExtensions.scienceStatus();
      setStatus(next);
      setNotice(receipt.ok && next.installed && next.enabled
        ? { text: ko ? `Science ${next.version ?? ""}을 사용할 수 있습니다.` : `Science ${next.version ?? ""} is ready.`, error: false }
        : { text: receipt.message ?? (ko ? "Science를 업데이트하지 못했습니다." : "Could not update Science."), error: true });
    } catch {
      await refresh();
      setNotice({ text: ko ? "Science를 업데이트하지 못했습니다. 다시 시도해 주세요." : "Could not update Science. Please try again.", error: true });
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
    const confirmed = window.confirm(ko
      ? "Agentlas Science 프로그램을 제거할까요? 연구 프로젝트와 데이터는 보존됩니다."
      : "Remove Agentlas Science? Research projects and data will be preserved.");
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
          {!status?.installed ? (
            <button type="button" className={styles.button} data-testid="science-settings-review-package" data-primary="true" disabled={busy !== null || status === null} onClick={() => void install()}>
              <IconCheck size={14} />
              {ko ? "패키지 확인" : "Review package"}
            </button>
          ) : (
            <>
              <button type="button" className={styles.button} data-testid="science-settings-update" disabled={busy !== null} onClick={() => void update()}>
                <IconCheck size={14} /> {busy === "install" ? (ko ? "업데이트 중…" : "Updating…") : (ko ? "업데이트" : "Update")}
              </button>
              <button type="button" className={styles.button} data-primary={status.enabled ? "false" : "true"} disabled={busy !== null} onClick={() => void toggle()}>
                <IconPower size={14} /> {status.enabled ? (ko ? "끄기" : "Disable") : (ko ? "켜기" : "Enable")}
              </button>
              <button type="button" className={styles.button} disabled={busy !== null} onClick={() => void uninstall()}>
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
