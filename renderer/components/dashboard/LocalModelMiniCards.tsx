"use client";
/*
 * 대시보드 "로컬" 묶음 — 설치된 로컬 모델을 한 행 두 장씩, 가로형 미니 카드로 (오너 2026-09-13).
 * "Agentlas Local · 연결" 한 줄은 뜻이 틀렸다: 로컬 모델은 연결하는 게 아니라 받아서 쓰는 것이다.
 * 화면 글자는 이름·양자화·크기뿐, 나머지(저장소·GPU 근거)는 마우스를 올리면 보인다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import type { LocalModelHubSnapshot } from "@shared/local-model-hub";
import { AccelerationChip } from "@/components/settings/LocalModelHubPanel";

function size(bytes: number): string { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.ceil(bytes / 1024 ** 2)} MiB`; }

export function useLocalModelSnapshot(): { snapshot: LocalModelHubSnapshot | null; refresh: () => Promise<void> } {
  const [snapshot, setSnapshot] = useState<LocalModelHubSnapshot | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try { const value = await ipc()?.localModelHub.snapshot(); if (mounted.current && value) setSnapshot(value); }
    catch { /* 읽기 실패는 "모델 없음"이 아니다 — 이전 표시를 유지한다 */ }
  }, []);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, [refresh]);
  useVisibleInterval(() => void refresh(), 15_000);
  return { snapshot, refresh };
}

export function LocalModelMiniCards({ ko, snapshot, refresh }: { ko: boolean; snapshot: LocalModelHubSnapshot | null; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const installed = [...(snapshot?.modelInstallations ?? [])].reverse();
  const resident = snapshot?.resident ?? null;
  const open = () => navigate("/local-models");
  const use = async (installationId: string, fileName: string) => {
    const api = ipc(); if (!api || busy) return;
    setBusy(installationId); setNotice(null);
    try {
      const receipt = await api.localModelHub.loadModel({ installationId, contextTokens: 0, operationId: crypto.randomUUID() });
      if (receipt.state !== "resident") throw new Error(receipt.reasonCode ?? receipt.state);
      await api.runtime.setActive({ kind: "agentlas-local", backend: "agentlas-local", source: `agentlas-local:${receipt.enginePackageId}:${receipt.installationId}`, model: fileName });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setNotice(code === "engine_not_installed" ? (ko ? "실행 엔진을 먼저 준비해야 합니다." : "Set up the engine first.") : (ko ? "모델을 불러오지 못했습니다. 로컬 모델 화면에서 사유를 확인하세요." : "Could not load the model. See Local Models for the reason."));
    } finally { setBusy(null); await refresh(); }
  };
  if (!snapshot) return <div className="dashboard-engine-grid" aria-busy="true"><div className="dashboard-local-model-card" data-empty="true"><span className="dashboard-local-model-name">{ko ? "확인 중…" : "Checking…"}</span></div></div>;
  if (!installed.length) {
    return <div className="dashboard-engine-grid">
      <button type="button" className="dashboard-local-model-card titlebar-nodrag" data-empty="true" onClick={open} title={ko ? "Hugging Face 에서 모델을 받아 이 컴퓨터에서 실행합니다" : "Download a model from Hugging Face and run it on this computer"}>
        <span className="dashboard-local-model-name">{ko ? "로컬 모델 받기" : "Get a local model"}</span><span className="dashboard-local-model-arrow" aria-hidden="true">→</span>
      </button>
    </div>;
  }
  return <>
    <div className="dashboard-engine-grid" data-local-models>
      {installed.map((item) => {
        const model = snapshot.modelCatalog.find((row) => row.packageId === item.modelPackageId);
        const active = resident?.installationId === item.installationId;
        const name = item.fileName.replace(/\.gguf$/i, "");
        const meta = [item.repository.split("/")[0], item.quantization, model ? size(model.byteLength) : null].filter(Boolean).join(" · ");
        const title = `${item.repository} · ${item.quantization}${model ? ` · ${size(model.byteLength)}` : ""}${active ? (ko ? " · 사용 중" : " · in use") : ""}`;
        return <div key={item.installationId} className="dashboard-local-model-card" data-active={active ? "true" : "false"} data-local-model={item.modelPackageId} title={title}>
          <button type="button" className="dashboard-local-model-main titlebar-nodrag" onClick={open} aria-label={`${name} · ${ko ? "로컬 모델 열기" : "open local models"}`}>
            <span className="dashboard-local-model-name">{name}</span>
            <span className="dashboard-local-model-meta">{meta}</span>
          </button>
          {active
            ? <AccelerationChip evidence={resident?.acceleration} ko={ko} />
            : <button type="button" className="dashboard-local-model-use titlebar-nodrag" disabled={!!busy} onClick={() => void use(item.installationId, item.fileName)} title={ko ? "이 모델을 불러와 실행 모델로 선택" : "Load this model and select it as the runtime model"}>
                {busy === item.installationId ? (ko ? "불러오는 중…" : "Loading…") : (ko ? "사용" : "Use")}
              </button>}
        </div>;
      })}
    </div>
    {notice && <div className="dashboard-usage-load-error" role="status">{notice}</div>}
  </>;
}
