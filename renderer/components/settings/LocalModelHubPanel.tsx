"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentlasIpc } from "@/lib/types";
import { ipc } from "@/lib/ipc";
import type { LocalModelHubAPI, LocalModelHubSnapshot } from "@shared/local-model-hub";

type HubBridge = AgentlasIpc & { localModelHub: LocalModelHubAPI };

function bytes(value: number | null): string {
  if (value === null) return "unknown";
  const gib = value / 1024 / 1024 / 1024;
  return gib >= 1 ? `${gib.toFixed(1)} GiB` : `${(value / 1024 / 1024).toFixed(0)} MiB`;
}

function machineMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function LocalModelHubPanel({ locale }: { locale: string }) {
  const ko = locale === "ko";
  const [snapshot, setSnapshot] = useState<LocalModelHubSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);

  const bridge = useCallback(() => ipc() as HubBridge | null, []);
  const refresh = useCallback(async () => {
    const api = bridge()?.localModelHub;
    if (!api) return;
    try {
      setSnapshot(await api.snapshot());
    } catch (error) {
      setNotice(`${ko ? "로컬 모델 상태를 읽지 못했습니다" : "Could not read local model state"}: ${machineMessage(error)}`);
    }
  }, [bridge, ko]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void refresh(), 750);
    return () => window.clearInterval(timer);
  }, [busy, refresh]);

  const run = useCallback(async (label: string, action: (api: HubBridge) => Promise<void>) => {
    const api = bridge();
    if (!api || busy) return;
    setBusy(label);
    setNotice(null);
    try {
      await action(api);
      await refresh();
    } catch (error) {
      setNotice(`${ko ? "작업이 완료되지 않았습니다" : "Operation did not complete"}: ${machineMessage(error)}`);
    } finally {
      setBusy(null);
      setOperationId(null);
    }
  }, [bridge, busy, ko, refresh]);

  const engine = useMemo(() => snapshot?.engineCatalog.find((item) =>
    item.platform === snapshot.hardware.platform && item.arch === snapshot.hardware.arch) ?? null, [snapshot]);
  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const all = snapshot?.modelCatalog ?? [];
    if (!normalized) return all;
    return all.filter((item) => [item.repository, item.creator, item.converter, item.architecture, item.quantization]
      .some((value) => value.toLowerCase().includes(normalized)));
  }, [query, snapshot]);
  const model = snapshot?.modelCatalog.find((item) => item.packageId === selectedModelId)
    ?? filteredModels[0]
    ?? snapshot?.modelCatalog[0]
    ?? null;
  const engineInstall = engine
    ? snapshot?.engineInstallations.find((item) => item.enginePackageId === engine.packageId) ?? null
    : null;
  const modelInstall = model
    ? snapshot?.modelInstallations.find((item) => item.modelPackageId === model.packageId) ?? null
    : null;
  const fit = model
    ? snapshot?.fitAssessments.find((item) => item.modelPackageId === model.packageId) ?? null
    : null;

  const installEngine = () => engine && void run("engine", async (api) => {
    const id = crypto.randomUUID();
    setOperationId(id);
    const receipt = await api.localModelHub.downloadEngine({ packageId: engine.packageId, operationId: id });
    if (receipt.state !== "verified") throw new Error(receipt.reasonCode ?? receipt.state);
    await api.localModelHub.installEngine({ packageId: engine.packageId });
    setNotice(ko ? "엔진의 해시와 출처 증명을 확인하고 설치했습니다." : "Engine hash and provenance were verified before installation.");
  });

  const installModel = () => model && void run("model", async (api) => {
    const id = crypto.randomUUID();
    setOperationId(id);
    const receipt = await api.localModelHub.downloadModel({ packageId: model.packageId, operationId: id });
    if (receipt.state !== "verified") throw new Error(receipt.reasonCode ?? receipt.state);
    await api.localModelHub.installDownloadedModel({ packageId: model.packageId });
    setNotice(ko ? "모델 파일의 크기와 SHA-256을 확인했습니다." : "Model byte length and SHA-256 were verified.");
  });

  const importModel = () => model && void run("import", async (api) => {
    const receipt = await api.localModelHub.importModel({ packageId: model.packageId });
    setNotice(receipt
      ? (ko ? "선택한 파일을 고정 패키지 해시와 대조해 가져왔습니다." : "The selected file matched the pinned package hash and was imported.")
      : (ko ? "파일 선택을 취소했습니다." : "File selection was cancelled."));
  });

  const loadModel = () => modelInstall && void run("load", async (api) => {
    const id = crypto.randomUUID();
    setOperationId(id);
    const receipt = await api.localModelHub.loadModel({ installationId: modelInstall.installationId, contextTokens: 8192, operationId: id });
    if (receipt.state !== "resident") throw new Error(receipt.reasonCode ?? receipt.state);
    const source = `agentlas-local:${receipt.enginePackageId}:${receipt.installationId}`;
    await api.runtime.setActive({ kind: "agentlas-local", backend: "agentlas-local", source, model: modelInstall.fileName });
    setNotice(ko ? "이 모델을 메모리에 올리고 현재 엔진으로 선택했습니다." : "Loaded this model and selected it as the current engine.");
  });

  const unload = () => snapshot?.resident && void run("unload", async (api) => {
    await api.localModelHub.unload({ processEpoch: snapshot.resident!.processEpoch, cancelActiveRuns: true });
    setNotice(ko ? "진행 중 추론을 취소하고 모델을 메모리에서 내렸습니다." : "Cancelled active inference and unloaded the model.");
  });

  const testCapabilities = () => modelInstall && void run("capability", async (api) => {
    const id = crypto.randomUUID();
    setOperationId(id);
    const receipt = await api.localModelHub.testCapabilities({
      installationId: modelInstall.installationId,
      strictJson: true,
      toolUse: true,
      cancellation: true,
      operationId: id,
    });
    setNotice(`${ko ? "실측 영수증" : "Measured receipt"}: JSON ${receipt.strictJson} · tools ${receipt.toolUse} · cancel ${receipt.cancellation}`);
  });

  const cancel = () => operationId && void bridge()?.localModelHub.cancelOperation({ operationId });
  const latestProgress = [...(snapshot?.engineProgress ?? []), ...(snapshot?.modelProgress ?? [])]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

  return (
    <section aria-labelledby="local-model-hub-title" style={{ marginTop: 32 }}>
      <h2 id="local-model-hub-title" style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "0 0 8px" }}>
        {ko ? "Agentlas 로컬 모델" : "Agentlas local models"}
      </h2>
      <p style={{ margin: "0 0 12px", color: "var(--muted-deep)", fontSize: 12.5, lineHeight: 1.6 }}>
        {ko
          ? "고정된 엔진 릴리스와 모델 파일을 검증한 뒤 이 컴퓨터에서 직접 실행합니다. Ollama 설치와는 별도입니다."
          : "Runs a pinned engine release and verified model file directly on this computer. This is separate from Ollama."}
      </p>
      <div style={{ padding: 14, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)", display: "grid", gap: 14 }}>
        {!snapshot ? (
          <span style={{ fontSize: 12, color: "var(--muted-deep)" }}>{ko ? "상태 확인 중…" : "Checking status…"}</span>
        ) : (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 11.5, color: "var(--muted-deep)" }}>
              <span>{snapshot.hardware.cpuModel}</span>
              <span>· {bytes(snapshot.hardware.totalMemoryBytes)} RAM</span>
              <span>· {snapshot.hardware.accelerator}</span>
              <span>· {fit?.class ?? "unknown"} ({fit?.evidence ?? "not assessed"})</span>
            </div>
            {snapshot.unavailableReason && !engine ? (
              <div role="status" style={{ color: "var(--danger, #a33)", fontSize: 12 }}>
                {ko ? "이 운영체제/CPU용 검증 엔진이 없습니다" : "No verified engine is available for this OS/CPU"}: {snapshot.unavailableReason}
              </div>
            ) : null}
            {engine ? (
              <div style={{ display: "grid", gap: 7 }}>
                <strong style={{ fontSize: 12.5 }}>llama.cpp {engine.releaseTag} · {engine.arch}/{engine.accelerator}</strong>
                <code style={{ fontSize: 10.5, overflowWrap: "anywhere", color: "var(--muted-deep)" }}>SHA-256 {engine.sha256}</code>
                <div><button type="button" disabled={Boolean(busy)} onClick={installEngine} style={buttonStyle}>{engineInstall ? (ko ? "엔진 다시 검증" : "Reverify engine") : (ko ? "엔진 다운로드·검증" : "Download and verify engine")}</button></div>
              </div>
            ) : null}
            <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--paper-edge)", paddingTop: 12 }}>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={ko ? "모델·제작자 검색" : "Search model or creator"}
                aria-label={ko ? "로컬 모델 검색" : "Search local models"}
                style={{ width: "100%", border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)", color: "var(--ink)", padding: "8px 10px", fontSize: 12 }}
              />
              <div role="listbox" aria-label={ko ? "검증된 모델 목록" : "Verified model catalog"} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 8 }}>
                {filteredModels.map((item) => {
                  const itemFit = snapshot.fitAssessments.find((assessment) => assessment.modelPackageId === item.packageId);
                  const selected = model?.packageId === item.packageId;
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      key={item.packageId}
                      onClick={() => setSelectedModelId(item.packageId)}
                      style={{ ...buttonStyle, textAlign: "left", padding: 10, background: selected ? "var(--paper)" : "var(--paper-2)", boxShadow: selected ? "var(--neu-raised)" : "none" }}
                    >
                      <strong style={{ display: "block", marginBottom: 5 }}>{item.repository}</strong>
                      <span style={{ display: "block", color: "var(--muted-deep)", fontSize: 10.5 }}>
                        {item.creator} · {item.quantization} · {bytes(item.byteLength)}
                      </span>
                      <span style={{ display: "block", color: "var(--muted-deep)", fontSize: 10.5, marginTop: 3 }}>
                        {itemFit?.class ?? "unknown"} · {itemFit?.evidence ?? "not assessed"}
                      </span>
                    </button>
                  );
                })}
                {filteredModels.length === 0 ? <span style={{ fontSize: 12, color: "var(--muted-deep)" }}>{ko ? "검색 결과가 없습니다." : "No catalog results."}</span> : null}
              </div>
            </div>
            {model ? (
              <div style={{ display: "grid", gap: 7 }}>
                <strong style={{ fontSize: 12.5 }}>{model.repository} · {model.quantization} · {bytes(model.byteLength)}</strong>
                <span style={{ fontSize: 11.5, color: "var(--muted-deep)" }}>{ko ? "라이선스" : "License"}: {model.license} · revision {model.revision.slice(0, 12)}</span>
                <code style={{ fontSize: 10.5, overflowWrap: "anywhere", color: "var(--muted-deep)" }}>SHA-256 {model.sha256}</code>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                  <button type="button" disabled={Boolean(busy)} onClick={installModel} style={buttonStyle}>{modelInstall ? (ko ? "모델 다시 검증" : "Reverify model") : (ko ? "모델 다운로드·검증" : "Download and verify model")}</button>
                  <button type="button" disabled={Boolean(busy)} onClick={importModel} style={buttonStyle}>{ko ? "파일에서 가져오기" : "Import file"}</button>
                  {!snapshot.resident ? <button type="button" disabled={Boolean(busy) || !engineInstall || !modelInstall} onClick={loadModel} style={primaryButtonStyle}>{ko ? "메모리에 올리고 선택" : "Load and select"}</button> : null}
                  {snapshot.resident ? <button type="button" disabled={Boolean(busy)} onClick={unload} style={buttonStyle}>{ko ? "실행 취소·모델 내리기" : "Cancel runs and unload"}</button> : null}
                  {snapshot.resident ? <button type="button" disabled={Boolean(busy)} onClick={testCapabilities} style={buttonStyle}>{ko ? "JSON·도구·취소 실측" : "Measure JSON, tools, cancel"}</button> : null}
                </div>
              </div>
            ) : null}
            {busy && latestProgress ? (
              <div role="status" style={{ fontSize: 11.5, color: "var(--muted-deep)" }}>
                {latestProgress.state} · {bytes(latestProgress.downloadedBytes)} / {bytes(latestProgress.totalBytes)}
              </div>
            ) : null}
            {busy && operationId ? <button type="button" onClick={cancel} style={buttonStyle}>{ko ? "현재 작업 취소" : "Cancel operation"}</button> : null}
            {notice ? <div role="status" style={{ fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" }}>{notice}</div> : null}
          </>
        )}
      </div>
    </section>
  );
}

const buttonStyle = {
  border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)", color: "var(--ink)",
  padding: "7px 10px", fontSize: 11.5, fontWeight: 650, cursor: "pointer",
} as const;

const primaryButtonStyle = {
  ...buttonStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)",
} as const;
