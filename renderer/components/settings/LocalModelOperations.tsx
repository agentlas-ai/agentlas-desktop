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
      const status = row.state === "completed" ? ko ? "완료" : "Completed" : row.state === "failed" ? `${ko ? "완료하지 못함" : "Failed"}${failureReason(row.reasonCode, ko)}`
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

/*
 * 실패 사유를 사람 말로. 코드는 main(local-model-hub-ipc.ts failureReasonCode)이 그대로 실어 보낸다.
 * 모르는 코드는 코드 그대로 보여 준다 — 숨기는 것보다 낫다(프로덕션 1.2.0 실측: "완료하지 못함"만 보여 원인을 알 수 없었다).
 */
function failureReason(code: string | null | undefined, ko: boolean): string {
  if (!code || code === "local_model_operation_failed") return "";
  const known: Record<string, [string, string]> = {
    engine_attestation_managed_runtime_unavailable: ["실행 엔진 검증에 쓰는 내장 Node 를 사용할 수 없습니다. 앱을 재시작하거나 다시 설치하면 복구됩니다(자세한 사유는 앱 로그)", "The bundled Node used to verify the engine is unavailable. Restart or reinstall the app (details in the app log)"],
    engine_attestation_fetch_failed: ["엔진 서명 증명을 GitHub 에서 가져오지 못했습니다(네트워크)", "Could not fetch the engine's signed attestation from GitHub (network)"],
    engine_attestation_rate_limited: ["GitHub 요청 한도에 걸렸습니다. 잠시 뒤 다시 시도해 주세요", "GitHub rate limit reached. Try again later"],
    engine_attestation_bundle_missing: ["이 판의 서명 증명이 없습니다", "No signed attestation exists for this build"],
    engine_not_installed: ["실행 엔진이 아직 설치되지 않았습니다", "The execution engine is not installed yet"],
    engine_health_timeout: ["실행 엔진이 제때 응답하지 않았습니다. 메모리 여유를 확인하고 다시 시도해 주세요", "The engine did not respond in time. Check free memory and retry"],
    model_file_sha256_mismatch: ["모델 파일이 내려받은 뒤 바뀌었습니다. 다시 내려받아 주세요", "The model file changed after download. Download it again"],
    engine_package_host_mismatch: ["이 컴퓨터용 엔진이 아닙니다", "This engine package is not for this computer"],
    local_model_hub_owned_by_other_process: ["다른 Agentlas 창이 로컬 모델을 쓰고 있습니다", "Another Agentlas window is using local models"],
  };
  const text = known[code]?.[ko ? 0 : 1] ?? code;
  return ` · ${text}`;
}
