"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentlasIpc } from "@/lib/types";
import { ipc } from "@/lib/ipc";
import type { LocalModelHubAPI, LocalModelHubSnapshot } from "@shared/local-model-hub";

type HubBridge = AgentlasIpc & { localModelHub: LocalModelHubAPI };

const FIT_ORDER = ["recommended", "runnable", "may_be_slow", "not_recommended", "unsupported", "unknown"] as const;

function bytes(value: number | null): string {
  if (value === null) return "unknown";
  const gib = value / 1024 / 1024 / 1024;
  return gib >= 1 ? `${gib.toFixed(1)} GiB` : `${(value / 1024 / 1024).toFixed(0)} MiB`;
}

function machineMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fitLabel(value: string | undefined, ko: boolean): string {
  if (!ko) return value ?? "unknown";
  switch (value) {
    case "recommended": return "실행 적합";
    case "runnable": return "실행 가능";
    case "may_be_slow": return "느릴 수 있음";
    case "not_recommended": return "권장하지 않음";
    case "unsupported": return "지원하지 않음";
    default: return "확인 필요";
  }
}

export function LocalModelHubPanel({ locale }: { locale: string }) {
  const ko = locale === "ko";
  const [snapshot, setSnapshot] = useState<LocalModelHubSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [architecture, setArchitecture] = useState("all");
  const [fitClass, setFitClass] = useState("all");

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
    return all.filter((item) => {
      const assessment = snapshot?.fitAssessments.find((candidate) => candidate.modelPackageId === item.packageId);
      return (architecture === "all" || item.architecture === architecture)
        && (fitClass === "all" || (assessment?.class ?? "unknown") === fitClass)
        && (!normalized || [item.repository, item.creator, item.converter, item.architecture, item.quantization, item.license]
          .some((value) => value.toLowerCase().includes(normalized)));
    }).sort((a, b) => {
      const fitA = snapshot?.fitAssessments.find((item) => item.modelPackageId === a.packageId)?.class ?? "unknown";
      const fitB = snapshot?.fitAssessments.find((item) => item.modelPackageId === b.packageId)?.class ?? "unknown";
      return FIT_ORDER.indexOf(fitA) - FIT_ORDER.indexOf(fitB) || a.byteLength - b.byteLength;
    });
  }, [architecture, fitClass, query, snapshot]);
  const model = filteredModels.find((item) => item.packageId === selectedModelId)
    ?? filteredModels[0]
    ?? null;
  const architectures = useMemo(() => [...new Set((snapshot?.modelCatalog ?? []).map((item) => item.architecture))].sort(), [snapshot]);
  const engineInstall = engine
    ? snapshot?.engineInstallations.find((item) => item.enginePackageId === engine.packageId) ?? null
    : null;
  const modelInstall = model
    ? snapshot?.modelInstallations.find((item) => item.modelPackageId === model.packageId) ?? null
    : null;
  const fit = model
    ? snapshot?.fitAssessments.find((item) => item.modelPackageId === model.packageId) ?? null
    : null;
  const capability = modelInstall
    ? [...(snapshot?.capabilityReceipts ?? [])].reverse().find((item) => item.installationId === modelInstall.installationId) ?? null
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
              <span>· {fitLabel(fit?.class, ko)} ({fit?.evidence === "verified_on_this_device" ? (ko ? "이 PC에서 확인" : "measured on this PC") : (ko ? "메모리 기준 추정" : "memory-based estimate")})</span>
            </div>
            {snapshot.unavailableReason && !engine ? (
              <div role="status" style={{ color: "var(--danger, #a33)", fontSize: 12 }}>
                {ko ? "이 운영체제/CPU용 검증 엔진이 없습니다" : "No verified engine is available for this OS/CPU"}: {snapshot.unavailableReason}
              </div>
            ) : null}
            {engine ? (
              <div style={{ display: "grid", gap: 7 }}>
                <strong style={{ fontSize: 12.5 }}>llama.cpp {engine.releaseTag} · {engine.arch}/{engine.accelerator}</strong>
                <details style={{ fontSize: 10.5, color: "var(--muted-deep)" }}>
                  <summary>{ko ? "엔진 기술 상세" : "Engine technical details"}</summary>
                  <code style={{ display: "block", marginTop: 5, overflowWrap: "anywhere" }}>SHA-256 {engine.sha256}</code>
                </details>
                <div><button type="button" disabled={Boolean(busy)} onClick={installEngine} style={buttonStyle}>{engineInstall ? (ko ? "엔진 다시 검증" : "Reverify engine") : (ko ? "엔진 다운로드·검증" : "Download and verify engine")}</button></div>
              </div>
            ) : null}
            <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--paper-edge)", paddingTop: 12 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={ko ? "모델·제작자·라이선스 검색" : "Search model, creator, or license"}
                  aria-label={ko ? "로컬 모델 검색" : "Search local models"}
                  style={{ flex: "1 1 190px", minWidth: 0, border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)", color: "var(--ink)", padding: "8px 10px", fontSize: 12 }}
                />
                <select value={architecture} onChange={(event) => setArchitecture(event.target.value)} aria-label={ko ? "아키텍처 필터" : "Architecture filter"} style={selectStyle}>
                  <option value="all">{ko ? "모든 아키텍처" : "All architectures"}</option>
                  {architectures.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
                <select value={fitClass} onChange={(event) => setFitClass(event.target.value)} aria-label={ko ? "적합도 필터" : "Fit filter"} style={selectStyle}>
                  <option value="all">{ko ? "모든 적합도" : "All fit classes"}</option>
                  {FIT_ORDER.map((item) => <option key={item} value={item}>{fitLabel(item, ko)}</option>)}
                </select>
              </div>
              <div role="listbox" aria-label={ko ? "검증된 모델 목록" : "Verified model catalog"} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 8 }}>
                {filteredModels.map((item) => {
                  const itemFit = snapshot.fitAssessments.find((assessment) => assessment.modelPackageId === item.packageId);
                  const selected = model?.packageId === item.packageId;
                  const recommended = item.packageId === filteredModels[0]?.packageId
                    && (itemFit?.class === "recommended" || itemFit?.class === "runnable");
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
                      {recommended ? <span style={{ display: "block", color: "var(--accent)", fontSize: 10.5, marginBottom: 3 }}>
                        {itemFit?.evidence === "verified_on_this_device"
                          ? (ko ? "이 PC에서 확인한 추천" : "Measured recommendation for this PC")
                          : (ko ? "이 PC 메모리 기준 추천" : "Recommended from this PC's memory")}
                      </span> : null}
                      <span style={{ display: "block", color: "var(--muted-deep)", fontSize: 10.5 }}>
                        {item.creator} · {item.quantization} · {bytes(item.byteLength)}
                      </span>
                      <span style={{ display: "block", color: "var(--muted-deep)", fontSize: 10.5, marginTop: 3 }}>
                        {fitLabel(itemFit?.class, ko)} · {itemFit?.evidence === "verified_on_this_device" ? (ko ? "이 PC에서 확인" : "measured") : (ko ? "메모리 기준 추정" : "memory estimate")}
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
                <span style={{ fontSize: 11.5, color: "var(--muted-deep)" }}>
                  {ko ? "제작자" : "Creator"}: {model.creator} · {ko ? "변환자" : "Converter"}: {model.converter} · {ko ? "라이선스" : "License"}: {model.license}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--muted-deep)" }}>{model.architecture} · {model.format} · {model.gated ? (ko ? "접근 승인 필요" : "gated access") : (ko ? "공개 파일" : "public file")}</span>
                <span style={{ fontSize: 11.5, color: "var(--muted-deep)" }}>
                  {ko ? "이 PC 적합도" : "Fit on this PC"}: {fitLabel(fit?.class, ko)} · {fit?.evidence === "verified_on_this_device" ? (ko ? "이 PC에서 확인" : "measured on this PC") : (ko ? "메모리 기준 추정" : "memory-based estimate")}
                  {fit?.requiredBytes ? ` · ${ko ? "예상 필요" : "estimated required"} ${bytes(fit.requiredBytes)}` : ""}
                  {fit?.availableBytes ? ` · ${ko ? "현재 가용" : "currently available"} ${bytes(fit.availableBytes)}` : ""}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--muted-deep)" }}>
                  {capability
                    ? `${ko ? "기능 확인 결과" : "Capability check"}: JSON ${capability.strictJson} · tools ${capability.toolUse} · image ${capability.imageInput} · cancel ${capability.cancellation}`
                    : modelInstall
                      ? (ko ? "아직 이 모델의 기능을 검사하지 않았습니다." : "This model's capabilities have not been checked yet.")
                      : (ko ? "설치 후 기능을 확인할 수 있습니다." : "Install the model to check its capabilities.")}
                </span>
                <details style={{ fontSize: 10.5, color: "var(--muted-deep)" }}>
                  <summary>{ko ? "모델 기술 상세" : "Model technical details"}</summary>
                  <code style={{ display: "block", marginTop: 5, overflowWrap: "anywhere" }}>revision {model.revision}</code>
                  {fit?.reasonCodes.length ? <code style={{ display: "block", marginTop: 5 }}>{fit.reasonCodes.join(" · ")}</code> : null}
                  <code style={{ display: "block", marginTop: 5, overflowWrap: "anywhere" }}>{model.sourceUrl}</code>
                  <code style={{ display: "block", marginTop: 5, overflowWrap: "anywhere" }}>SHA-256 {model.sha256}</code>
                </details>
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

const selectStyle = {
  border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)", color: "var(--ink)",
  padding: "8px 10px", fontSize: 11.5,
} as const;
