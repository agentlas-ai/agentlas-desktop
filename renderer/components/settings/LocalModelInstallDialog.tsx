"use client";

import { useEffect, useRef, useState } from "react";
import type { LocalEnginePackageIdentity, LocalModelHubSnapshot, LocalModelPackageIdentity } from "@shared/local-model-hub";
import { ipc } from "@/lib/ipc";
import menu from "@/components/PanelPopover.module.css";
import styles from "./LocalModelInstallDialog.module.css";

type FitState = "comfortable" | "caution" | "blocked";
export function modelFitState(snapshot: LocalModelHubSnapshot | null, packageId?: string): FitState {
  if (!snapshot) return "caution";
  const engine = snapshot.engineCatalog.find(row => row.platform === snapshot.hardware.platform && row.arch === snapshot.hardware.arch);
  if (!engine) return "blocked";
  const model = snapshot.modelCatalog.find(row => row.packageId === packageId);
  if (model?.gated) return "blocked";
  const fit = snapshot.fitAssessments.find(row => row.modelPackageId === packageId && row.hardwareProfileId === snapshot.hardware.profileId);
  if (fit?.class === "unsupported") return "blocked";
  // 적합도의 기준은 총 메모리다(오너 결정 2026-09-13) — 판정이 실린 값이 실제 총 메모리와 같을 때만 믿는다.
  const known = Number.isFinite(fit?.requiredBytes) && Number.isFinite(fit?.availableBytes)
    && (fit?.requiredBytes ?? 0) > 0 && (fit?.availableBytes ?? 0) >= (fit?.requiredBytes ?? Infinity)
    && Number.isFinite(snapshot.hardware.totalMemoryBytes) && snapshot.hardware.totalMemoryBytes > 0
    && fit?.availableBytes === snapshot.hardware.totalMemoryBytes;
  return known && fit?.class === "recommended" ? "comfortable" : "caution";
}

export function LocalModelFitIcon({ snapshot, packageId, blocked = false, ko }: { snapshot: LocalModelHubSnapshot | null; packageId?: string; blocked?: boolean; ko: boolean }) {
  const state = blocked ? "blocked" : modelFitState(snapshot, packageId);
  const label = state === "comfortable" ? ko ? "원활 예상 · 메모리 기준 추정, 실제 성능은 실행 후 확인" : "Comfortable memory fit estimated; performance requires a run"
    : state === "blocked" ? ko ? "불가 · 지원 또는 저장 공간 확인 필요" : "Unavailable; check support or storage"
    : ko ? "주의 · 성능이나 메모리 여유 확인 필요" : "Caution; performance or memory fit needs checking";
  return <span role="img" data-model-fit={state} aria-label={label} title={label} className={`${styles.fit} ${styles[state]}`}><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">{state === "comfortable" ? <><circle cx="10" cy="10" r="8"/><path d="m6 10 3 3 5-6"/></> : state === "blocked" ? <><circle cx="10" cy="10" r="8"/><path d="m6 6 8 8"/></> : <><path d="M10 2 19 18H1L10 2Z"/><path d="M10 7v5m0 2v1"/></>}</svg></span>;
}

export interface LocalModelInstallPlan {
  model: LocalModelPackageIdentity | null;
  engine: LocalEnginePackageIdentity;
  installModel: boolean;
  installEngine: boolean;
}

export function LocalModelInstallDialog({ packageId, engineOnly = false, ko, onCancel, onConfirm }: { packageId?: string; engineOnly?: boolean; ko: boolean; onCancel: () => void; onConfirm: (plan: LocalModelInstallPlan) => void }) {
  const [snapshot, setSnapshot] = useState<LocalModelHubSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const confirmed = useRef(false);
  const callbacks = useRef({ onCancel, onConfirm }); callbacks.current = { onCancel, onConfirm };
  useEffect(() => {
    let disposed = false;
    const prior = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    void ipc()?.localModelHub.snapshot().then(value => { if (!disposed) setSnapshot(value); }).catch(() => { if (!disposed) setFailed(true); });
    if (!ipc()?.localModelHub) setFailed(true);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); callbacks.current.onCancel(); }
      if (event.key !== "Tab") return;
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
    };
    document.addEventListener("keydown", key, true);
    return () => { disposed = true; document.removeEventListener("keydown", key, true); prior?.focus(); };
  }, []);
  const model = snapshot?.modelCatalog.find(row => row.packageId === packageId) ?? null;
  const engine = snapshot?.engineCatalog.find(row => row.platform === snapshot.hardware.platform && row.arch === snapshot.hardware.arch) ?? null;
  const engineInstalled = !!engine && snapshot?.engineInstallations.some(row => row.enginePackageId === engine.packageId && row.enginePackageSha256 === engine.sha256 && row.provenanceVerified);
  const installEngine = engineOnly || !engineInstalled;
  const modelBytes = engineOnly ? 0 : model?.byteLength ?? 0;
  const engineBytes = installEngine ? engine?.byteLength ?? 0 : 0;
  const total = modelBytes + engineBytes;
  const disk = snapshot?.hardware.diskAvailableBytes;
  const insufficientDisk = typeof disk === "number" && Number.isFinite(disk) && disk < total * 1.1;
  const unavailable = !snapshot || !engine || (!engineOnly && (!model || model.gated || modelFitState(snapshot,packageId) === "blocked")) || !!snapshot.unavailableReason || insufficientDisk;
  const gb = (value: number) => `${(value / 1_000_000_000).toFixed(3)} GB`;
  const confirm = () => {
    if (confirmed.current || unavailable || !engine) return;
    confirmed.current = true;
    callbacks.current.onConfirm({ model, engine, installModel: !engineOnly, installEngine });
  };
  return <div className={styles.backdrop} onPointerDown={event => { if (event.target === event.currentTarget) onCancel(); }}><div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="local-model-install-title" className={`${menu.panelPopover} ${styles.dialog}`}>
    <div id="local-model-install-title" className={styles.title}>{ko ? "설치 확인" : "Confirm installation"}</div>
    {snapshot ? <>
      {!engineOnly && <div className={styles.row}><span title={model?.fileName}>{model?.fileName ?? (ko ? "모델 확인 필요" : "Model unavailable")}</span><span>{gb(modelBytes)}</span></div>}
      <div className={styles.row}><span>llama.cpp</span><span>{installEngine ? gb(engineBytes) : ko ? "설치됨" : "Installed"}</span></div>
      <div className={styles.total}><span>{ko ? "총 다운로드" : "Total download"}</span><span>{gb(total)}</span></div>
      {!engineOnly && <div className={styles.assessment}><LocalModelFitIcon snapshot={snapshot} packageId={packageId} ko={ko}/><span>{ko ? "현재 컴퓨터의 예상 적합도" : "Estimated fit on this computer"}</span></div>}
      {insufficientDisk ? <p role="alert">{ko ? "저장 공간이 부족합니다." : "Not enough storage."}</p> : unavailable && <p role="alert">{ko ? "설치 조건을 확인하지 못했습니다." : "Installation requirements could not be confirmed."}</p>}
    </> : <p role="status">{failed ? ko ? "컴퓨터 상태를 읽지 못했습니다." : "Could not read computer status." : ko ? "컴퓨터 확인 중…" : "Checking this computer…"}</p>}
    <div className={styles.actions}><button type="button" className={menu.panelMenuRow} onClick={onCancel}>{ko ? "취소" : "Cancel"}</button><button type="button" className={menu.panelMenuRow} disabled={unavailable} onClick={confirm}>{ko ? "설치" : "Install"}</button></div>
  </div></div>;
}
