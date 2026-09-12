"use client";

import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { LocalModelHubSnapshot, LocalModelOperationView } from "@shared/local-model-hub";
import styles from "./LocalModelHubPanel.module.css";

/** Restores host-owned work after route changes without replaying a mutation. */
export function LocalModelOperations({ ko, hiddenIds, onViewModel }: { ko: boolean; hiddenIds: ReadonlySet<string>; onViewModel: (packageId: string) => void }) {
  const [operations, setOperations] = useState<LocalModelOperationView[]>([]);
  const [snapshot, setSnapshot] = useState<LocalModelHubSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let disposed = false;
    let running = false;
    const poll = async () => {
      if (running) return;
      running = true;
      try {
        const api = ipc()?.localModelHub;
        if (!api) throw new Error("local_model_bridge_unavailable");
        const rows = await api.operations();
        const state = rows.length ? await api.snapshot() : null;
        if (!disposed) { setOperations(rows); setSnapshot(state); setUnavailable(false); }
      } catch { if (!disposed) setUnavailable(true); }
      finally { running = false; }
    };
    void poll(); const timer = window.setInterval(() => void poll(), 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  const cancel = async (operationId: string) => {
    try { await ipc()?.localModelHub.cancelOperation({ operationId }); }
    catch { setUnavailable(true); }
  };
  const visible = operations.filter(row => !hiddenIds.has(row.operationId)).sort((a,b) => b.startedAt.localeCompare(a.startedAt));
  const pending = visible.filter(row => row.state === "pending" || row.state === "cancelling");
  const recent = visible.filter(row => row.state !== "pending" && row.state !== "cancelling").slice(0,3);
  return <div className={styles.library} aria-label={ko ? "진행 중인 모델 작업" : "Model operations"}>
    {unavailable && <p role="status" className={styles.notice}>{ko ? "진행 중인 작업 상태를 확인하지 못했습니다. 자동으로 다시 확인합니다." : "Could not read ongoing operations. Checking again automatically."}</p>}
    {[...pending,...recent].map(row => {
      const installed = snapshot?.modelInstallations.find(item => item.installationId === row.installationId);
      const model = snapshot?.modelCatalog.find(item => item.packageId === row.packageId || item.packageId === installed?.modelPackageId);
      const progress = [...(snapshot?.modelProgress ?? []),...(snapshot?.engineProgress ?? [])].find(item => item.packageId === row.packageId);
      const active = row.state === "pending" || row.state === "cancelling";
      const status = row.state === "completed" ? ko ? "완료" : "Completed" : row.state === "failed" ? ko ? "완료하지 못함" : "Failed"
        : row.state === "cancelled" ? ko ? "중지됨" : "Stopped" : row.state === "cancelling" ? ko ? "중지 요청됨" : "Stop requested"
        : row.phase === "install" ? ko ? "파일 확인 및 설치 중" : "Verifying and installing" : row.phase === "download" ? ko ? "다운로드 중" : "Downloading"
        : row.phase === "load" ? ko ? "모델 불러오는 중" : "Loading" : ko ? "기능 확인 중" : "Checking capabilities";
      return <div title={active ? (ko ? "앱 실행 중 계속됨 · 앱 종료 시 중단" : "Continues while the app is open · stops when closed") : undefined} className={styles.progress} role="status" data-host-operation={row.operationId} key={row.operationId}>
        <span>{model?.fileName ?? (row.kind === "downloadEngine" || row.kind === "installEnginePackage" ? "llama.cpp" : ko ? "모델 작업" : "Model operation")} · {status}{active && row.phase === "download" && progress ? ` · ${Math.floor(progress.downloadedBytes / 1048576)} / ${Math.ceil(progress.totalBytes / 1048576)} MiB` : ""}</span>
        {active ? <button type="button" onClick={() => void cancel(row.operationId)}>{ko ? "중지" : "Stop"}</button>
          : row.state === "completed" && installed && model && <button type="button" onClick={() => onViewModel(model.packageId)}>{ko ? "모델 보기" : "View model"}</button>}
      </div>;
    })}
  </div>;
}
