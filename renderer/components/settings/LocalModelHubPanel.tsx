"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentlasIpc } from "@/lib/types";
import { ipc } from "@/lib/ipc";
import { IconBolt, IconCode, IconCpu, IconImage, IconMoreHorizontal, IconPower, IconRefresh, IconSearch } from "@/components/Icon";
import type { LocalEngineDevice, LocalModelAccelerationEvidence, LocalModelHubSnapshot } from "@shared/local-model-hub";
import menu from "@/components/PanelPopover.module.css";
import styles from "./LocalModelHubPanel.module.css";
import { LocalModelFitIcon, LocalModelInstallDialog, type LocalModelInstallPlan } from "./LocalModelInstallDialog";

type Operation = { id: string; packageId: string; kind: "engine" | "model" | "load" | "capability"; alsoIds?: string[] };
function bytes(value: number | null): string {
  if (value === null) return "—";
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB` : `${Math.ceil(value / 1024 ** 2)} MiB`;
}
function gib(value: number | null | undefined): string { return typeof value === "number" && value > 0 ? `${(value / 1024 ** 3).toFixed(0)} GiB` : "—"; }
/**
 * 가속 표시는 짧게, 근거는 마우스를 올리면. 근거는 엔진 자신의 로그(몇 층이 GPU 에 올랐는지)뿐이며
 * 호스트 추정으로 "GPU" 라고 적지 않는다 — 윈도우 CPU 빌드는 영원히 CPU 였다(2026-09-13).
 */
export function AccelerationChip({ evidence, ko }: { evidence: LocalModelAccelerationEvidence | undefined; ko: boolean }) {
  const gpu = evidence?.devices.find(device => device.gpu);
  const layers = evidence && evidence.offloadedLayers !== null && evidence.totalLayers !== null ? `${evidence.offloadedLayers}/${evidence.totalLayers}` : null;
  const state = !evidence ? "unknown" : evidence.gpu ? "gpu" : "cpu";
  const label = state === "gpu" ? `${ko ? "GPU 가속" : "GPU accelerated"} · ${gpu?.name ?? evidence!.backend}${layers ? ` · ${layers} ${ko ? "층 GPU 에 올림" : "layers on GPU"}` : ""}`
    : state === "cpu" ? (gpu ? (ko ? `CPU 실행 · ${gpu.name} 에 층이 올라가지 않음` : `Running on CPU · no layers placed on ${gpu.name}`) : (ko ? "CPU 실행 · 이 엔진이 GPU 장치를 찾지 못함" : "Running on CPU · the engine found no GPU device"))
    : ko ? "가속 여부 미확인 · 모델을 다시 불러오면 확인됨" : "Acceleration unverified · reload the model to check";
  return <span role="img" data-acceleration={state} className={`${styles.chip} ${state === "gpu" ? styles.chipGpu : ""}`} title={label} aria-label={label}>
    {state === "gpu" ? <IconBolt size={12} /> : <IconCpu size={12} />}<span>{state === "gpu" ? "GPU" : state === "cpu" ? "CPU" : "?"}</span>
  </span>;
}
function deviceSummary(snapshot: LocalModelHubSnapshot | null, engineInstalled: boolean, ko: boolean): { text: string; title: string } {
  const devices: LocalEngineDevice[] = snapshot?.hardware.engineDevices ?? [];
  const gpu = devices.find(device => device.gpu);
  if (gpu) return { text: `GPU · ${gpu.name}`, title: ko ? `실행 엔진이 감지한 장치 · 메모리 ${gib(gpu.memoryBytes)} · ${gpu.accelerator}` : `Device listed by the engine · memory ${gib(gpu.memoryBytes)} · ${gpu.accelerator}` };
  if (engineInstalled && devices.length) return { text: ko ? "GPU 없음 · CPU 실행" : "No GPU · CPU only", title: ko ? "실행 엔진이 GPU 장치를 찾지 못했습니다. 그래픽 드라이버(Vulkan)를 확인해 주세요." : "The engine found no GPU device. Check the graphics driver (Vulkan)." };
  if (snapshot?.hardware.accelerator === "metal") return { text: "Metal", title: ko ? "Apple Silicon · 엔진 설치 후 장치를 다시 확인합니다" : "Apple Silicon · rechecked after the engine is installed" };
  return { text: ko ? "GPU · 엔진 설치 후 확인" : "GPU · checked after engine setup", title: ko ? "실행 엔진이 설치되면 어떤 장치가 보이는지 엔진에게 직접 묻습니다" : "Once the engine is installed it reports the devices it can use" };
}
function checked(value: string | undefined, ko: boolean): string {
  return value === "verified" ? ko ? "확인됨" : "Verified" : value === "failed" ? ko ? "실패" : "Failed" : ko ? "미검사" : "Not tested";
}

export function LocalModelHubPanel({ locale, standalone = false, selectedPackageId, onOperationStarted }: { locale: string; standalone?: boolean; selectedPackageId?: string; onOperationStarted?: (id: string) => void }) {
  const ko = locale === "ko";
  const [snapshot, setSnapshot] = useState<LocalModelHubSnapshot | null>(null);
  const [confirmation, setConfirmation] = useState<{ packageId?: string; engineOnly: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedModelId, setSelectedModelId] = useState<string | null>(selectedPackageId ?? null);
  const [panel, setPanel] = useState<"computer" | "model" | null>(null);
  const active = useRef(false);
  const lastRequestedPackage = useRef(selectedPackageId);
  const mounted = useRef(true);
  const refreshEpoch = useRef(0);
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLElement | null>(null);
  const bridge = useCallback(() => ipc(), []);
  const refresh = useCallback(async () => {
    const epoch = ++refreshEpoch.current;
    const api = bridge()?.localModelHub;
    if (!api) { setNotice(ko ? "로컬 모델 연결을 확인해 주세요." : "Check the local model connection."); return; }
    try { const value = await api.snapshot(); if (mounted.current && epoch === refreshEpoch.current) setSnapshot(value); }
    catch { if (mounted.current && epoch === refreshEpoch.current) setNotice(ko ? "모델 상태를 읽지 못했습니다. 다시 확인해 주세요." : "Could not read model state. Try refreshing."); }
  }, [bridge, ko]);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; refreshEpoch.current++; }; }, [refresh]);
  useEffect(() => { lastRequestedPackage.current = selectedPackageId; if (selectedPackageId) { setSelectedModelId(selectedPackageId); setQuery(""); void refresh(); } }, [selectedPackageId, refresh]);
  useEffect(() => { if (!busy) return; const timer = window.setInterval(() => void refresh(), 750); return () => window.clearInterval(timer); }, [busy, refresh]);
  const closeMenu = useCallback(() => { setPanel(null); menuButton.current?.focus(); }, []);
  useEffect(() => {
    if (!panel) return;
    menuRoot.current?.querySelector<HTMLElement>('[role="menu"] button')?.focus();
    const outside = (event: PointerEvent) => { if (!menuRoot.current?.contains(event.target as Node)) closeMenu(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") closeMenu(); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [panel, closeMenu]);
  const run = useCallback(async (label: string, action: (api: AgentlasIpc) => Promise<void>) => {
    const api = bridge(); if (!api || active.current) return;
    active.current = true; setBusy(label); setNotice(null);
    try { await action(api); }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (mounted.current) setNotice(/cancel/i.test(code) ? (ko ? "작업을 중지했습니다." : "Operation stopped.")
        : code === "local_model_runs_active" ? (ko ? "실행 중인 작업을 중지한 뒤 모델을 바꿔 주세요." : "Stop the active task before switching models.")
        : ko ? "작업이 완료되지 않았습니다. 연결과 저장 공간을 확인한 뒤 다시 시도하세요." : "The operation did not finish. Check your connection and disk space, then retry.");
    } finally { await refresh(); active.current = false; if (mounted.current) { setBusy(null); setOperation(null); } }
  }, [bridge, ko, refresh]);
  const engine = useMemo(() => snapshot?.engineCatalog.find(item => item.platform === snapshot.hardware.platform && item.arch === snapshot.hardware.arch) ?? null, [snapshot]);
  const filtered = useMemo(() => (snapshot?.modelCatalog ?? []).filter(item => !query.trim() || [item.repository,item.quantization,item.license].some(value => value.toLowerCase().includes(query.trim().toLowerCase()))), [snapshot, query]);
  // A requested exact package never temporarily falls back to another model.
  const requestedId = selectedPackageId !== lastRequestedPackage.current ? selectedPackageId : selectedModelId;
  const model = requestedId ? filtered.find(item => item.packageId === requestedId) ?? null : filtered[0] ?? null;
  const engineInstall = snapshot?.engineInstallations.find(item => item.enginePackageId === engine?.packageId && item.enginePackageSha256 === engine?.sha256 && item.provenanceVerified);
  const modelInstall = [...(snapshot?.modelInstallations ?? [])].reverse().find(item => item.modelPackageId === model?.packageId);
  const resident = snapshot?.resident;
  const residentModel = snapshot?.modelInstallations.find(item => item.installationId === resident?.installationId);
  const selectedResident = !!modelInstall && resident?.installationId === modelInstall.installationId;
  const capability = [...(snapshot?.capabilityReceipts ?? [])].reverse().find(item => item.installationId === modelInstall?.installationId && item.enginePackageId === engine?.packageId);
  const progress = operation && (operation.kind === "engine" || operation.kind === "model")
    ? [...(snapshot?.engineProgress ?? []), ...(snapshot?.modelProgress ?? [])].find(item => item.packageId === operation.packageId) : null;
  const unavailable = !!snapshot?.unavailableReason;
  const beginOperation = (value: Operation) => { onOperationStarted?.(value.id); setOperation(value); };
  const installEngine = () => { if (!engine) return; closeMenu(); setConfirmation({ packageId: model?.packageId, engineOnly: true }); };
  const installModel = () => { if (model) setConfirmation({ packageId: model.packageId, engineOnly: false }); };
  const confirmInstall = (plan: LocalModelInstallPlan) => {
    setConfirmation(null);
    void run(ko ? "설치 준비 중…" : "Preparing installation…", async api => {
      const ids: string[] = [], pending: Promise<unknown>[] = [];
      if (plan.installEngine) {
        const id = crypto.randomUUID(); ids.push(id); onOperationStarted?.(id);
        pending.push(api.localModelHub.installEnginePackage({ packageId: plan.engine.packageId, operationId: id }));
      }
      if (plan.installModel && plan.model) {
        const id = crypto.randomUUID(); ids.push(id); onOperationStarted?.(id);
        pending.push(api.localModelHub.installModelPackage({ packageId: plan.model.packageId, operationId: id }));
      }
      const id = ids.at(-1)!;
      setOperation({ id, packageId: plan.installModel ? plan.model!.packageId : plan.engine.packageId, kind: plan.installModel ? "model" : "engine", alsoIds: ids.slice(0,-1) });
      const results = await Promise.allSettled(pending);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
    });
  };
  const importModel = () => { if (!model) return; closeMenu(); void run(ko ? "파일 확인 중…" : "Checking file…", async api => {
    const receipt = await api.localModelHub.importModel({ packageId: model.packageId });
    if (!receipt) setNotice(ko ? "파일 선택을 취소했습니다." : "File selection cancelled.");
  }); };
  const loadModel = () => { if (!modelInstall) return; void run(ko ? "모델 불러오는 중…" : "Loading model…", async api => {
    const id = crypto.randomUUID(); beginOperation({ id, packageId: modelInstall.modelPackageId, kind: "load" });
    const receipt = await api.localModelHub.loadModel({ installationId: modelInstall.installationId, contextTokens: 8192, operationId: id });
    if (receipt.state !== "resident") throw new Error(receipt.reasonCode ?? receipt.state);
    if (!mounted.current) return;
    await api.runtime.setActive({ kind: "agentlas-local", backend: "agentlas-local", source: `agentlas-local:${receipt.enginePackageId}:${receipt.installationId}`, model: modelInstall.fileName });
    setNotice(ko ? "이 모델을 로드하고 실행 모델로 선택했습니다." : "Loaded and selected this runtime model.");
  }); };
  const unload = async () => {
    if (!resident) return;
    try { await bridge()?.localModelHub.unload({ processEpoch: resident.processEpoch, cancelActiveRuns: true }); await refresh(); }
    catch { setNotice(ko ? "모델을 내리지 못했습니다. 다시 시도하세요." : "Could not unload the model. Try again."); }
  };
  const testCapabilities = () => { if (!modelInstall || !selectedResident) return; void run(ko ? "기능 확인 중…" : "Checking capabilities…", async api => {
    const id = crypto.randomUUID(); beginOperation({ id, packageId: modelInstall.modelPackageId, kind: "capability" });
    await api.localModelHub.testCapabilities({ installationId: modelInstall.installationId, strictJson: true, toolUse: true, cancellation: true, operationId: id });
  }); };
  const cancel = async () => { if (!operation) return;
    const api = bridge()?.localModelHub;
    const results = await Promise.allSettled([operation.id,...(operation.alsoIds ?? [])].map(operationId => api?.cancelOperation({ operationId })));
    if (results.some(row => row.status === "rejected")) setNotice(ko ? "중지 상태를 확인하지 못했습니다. 다시 시도하세요." : "Could not confirm cancellation. Try again.");
  };
  const toggleMenu = (value: "computer" | "model", button: HTMLElement) => { menuButton.current = button; setPanel(panel === value ? null : value); };
  return <section className={styles.library} style={{ marginTop: standalone ? 0 : 32 }} aria-label={ko ? "모델 라이브러리" : "Model library"}>
    <div className={styles.toolbar}>
      <label className={styles.search}><IconSearch size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={ko ? "내 모델 찾기" : "Find a model"} aria-label={ko ? "로컬 모델 검색" : "Search local models"} /></label>
      <div ref={menuRoot} className={styles.menus}>
        <button type="button" className={styles.icon} aria-label={ko ? "컴퓨터와 실행 엔진" : "Computer and engine"} aria-expanded={panel === "computer"} onClick={event => toggleMenu("computer",event.currentTarget)}><IconCpu size={17} /></button>
        <button type="button" className={styles.icon} aria-label={ko ? "모델 메뉴" : "Model menu"} aria-expanded={panel === "model"} disabled={!model} onClick={event => toggleMenu("model",event.currentTarget)}><IconMoreHorizontal size={18} /></button>
        <button type="button" className={styles.icon} aria-label={ko ? "모델 상태 새로고침" : "Refresh model state"} onClick={() => void refresh()}><IconRefresh size={16} /></button>
        {panel && <div role="menu" className={`${menu.panelPopover} ${styles.popover}`}>
          {panel === "computer" ? <>
            <span className={menu.panelMenuLabel}>{snapshot?.hardware.cpuModel ?? "—"}</span>
            <span className={menu.panelMenuLabel} title={ko ? `지금 쓸 수 있는 메모리 ${bytes(snapshot?.hardware.availableMemoryBytes ?? null)}` : `Available now ${bytes(snapshot?.hardware.availableMemoryBytes ?? null)}`}>{bytes(snapshot?.hardware.totalMemoryBytes ?? null)} RAM</span>
            {(() => { const device = deviceSummary(snapshot, !!engineInstall, ko); return <span className={menu.panelMenuLabel} data-engine-device title={device.title}>{device.text}</span>; })()}
            <div className={menu.panelMenuSeparator} />
            <span className={menu.panelMenuLabel}>{engine ? `llama.cpp ${engine.releaseTag}` : ko ? "지원 엔진 없음" : "No compatible engine"}</span>
            <span className={menu.panelMenuLabel}>{engineInstall ? ko ? "엔진 설치됨" : "Engine installed" : ko ? "엔진 준비 필요" : "Engine setup needed"}</span>
            <button type="button" role="menuitem" className={menu.panelMenuRow} disabled={!!busy || !engine || unavailable} onClick={installEngine}>{engineInstall ? ko ? "엔진 다시 확인" : "Recheck engine" : ko ? "실행 엔진 준비" : "Set up engine"}</button>
          </> : model && <>
            <button type="button" role="menuitem" className={menu.panelMenuRow} disabled={!!busy || unavailable} onClick={importModel}>{ko ? "파일에서 가져오기" : "Import file"}</button>
            <button type="button" role="menuitem" className={menu.panelMenuRow} disabled={!!busy || model.gated || unavailable} onClick={() => { closeMenu(); installModel(); }}>{ko ? "파일 다시 확인" : "Recheck model file"}</button>
            <div className={menu.panelMenuSeparator} />
            <span className={menu.panelMenuLabel}>{ko ? "제작자" : "Creator"}: {model.creator === "unknown" ? ko ? "확인 필요" : "Unconfirmed" : model.creator}</span>
            <span className={menu.panelMenuLabel}>{ko ? "변환자" : "Converter"}: {model.converter === "unknown" ? ko ? "확인 필요" : "Unconfirmed" : model.converter}</span>
            <span className={menu.panelMenuLabel}>{model.architecture} · {model.license}</span>
            <details className={styles.provenance}><summary>{ko ? "파일 출처" : "File provenance"}</summary><code>{model.revision}</code><code>{model.sha256}</code><a href={model.sourceUrl} target="_blank" rel="noreferrer">{ko ? "원본 저장소 보기" : "View repository"}</a></details>
          </>}
        </div>}
      </div>
    </div>
    {residentModel && <div className={styles.resident} data-resident-installation={resident?.installationId}><span>{ko ? "로드됨" : "Loaded"} · {residentModel.fileName}</span><AccelerationChip evidence={resident?.acceleration} ko={ko} /><button type="button" onClick={() => void unload()}>{ko ? "내리기" : "Unload"}</button></div>}
    {!snapshot ? <p role="status" className={styles.empty}>{notice ?? (ko ? "모델 상태 확인 중…" : "Checking model state…")}</p> : <>
      {unavailable && <p role="status" className={styles.notice}>{!engine ? ko ? "이 컴퓨터에서 사용할 실행 엔진이 아직 없습니다." : "A compatible engine is not available for this computer." : ko ? "로컬 모델 상태를 사용할 수 없습니다. 앱을 다시 열어 확인해 주세요." : "Local model state is unavailable. Reopen the app and check again."}</p>}
      <div className={styles.layout}>
        <div role="listbox" aria-label={ko ? "모델 목록" : "Model catalog"} className={styles.models}>
          {filtered.map(item => {
            const installed = snapshot.modelInstallations.some(value => value.modelPackageId === item.packageId);
            return <button type="button" role="option" key={item.packageId} aria-selected={model?.packageId === item.packageId} data-model-package={item.packageId} className={styles.model} onClick={() => { setSelectedModelId(item.packageId); setNotice(null); }}>
              <span>{item.repository.split("/").at(-1)} <LocalModelFitIcon snapshot={snapshot} packageId={item.packageId} ko={ko}/></span><small>{item.repository.split("/")[0]} · {item.quantization} · {bytes(item.byteLength)}</small><small>{installed ? ko ? "설치됨" : "Installed" : ko ? "다운로드 가능" : "Available to download"}</small>
            </button>;
          })}
          {!filtered.length && <p className={styles.empty}>{ko ? "검색 결과가 없습니다." : "No matching models."}</p>}
        </div>
        {model ? <div className={styles.detail} data-selected-package={model.packageId}>
          <h2>{model.repository.split("/").at(-1)}</h2><p className={styles.muted}>{model.repository.split("/")[0]} · {model.quantization} · {bytes(model.byteLength)}</p>
          <LocalModelFitIcon snapshot={snapshot} packageId={model.packageId} ko={ko}/>
          <div className={styles.actions}>
            {!modelInstall ? <button type="button" className={styles.primary} disabled={!!busy || model.gated || unavailable} onClick={installModel}>{model.gated ? ko ? "접근 승인 필요" : "Access approval required" : ko ? "다운로드" : "Download"}</button>
              : !engineInstall ? <button type="button" className={styles.primary} disabled={!!busy || !engine || unavailable} onClick={installEngine}>{ko ? "실행 엔진 준비" : "Set up engine"}</button>
              : <button type="button" className={styles.primary} disabled={!!busy || unavailable} onClick={loadModel}>{selectedResident ? ko ? "실행 모델로 선택" : "Select runtime model" : resident ? ko ? "이 모델로 전환" : "Switch to this model" : ko ? "사용하기" : "Use model"}</button>}
            {selectedResident && <button type="button" className={styles.secondary} disabled={!!busy || unavailable} onClick={testCapabilities}>{ko ? "기능 확인" : "Check capabilities"}</button>}
          </div>
          <div className={styles.capabilities} aria-label={ko ? "모델 기능 상태" : "Model capabilities"}>
            {[{Icon:IconCode,label:"JSON",value:capability?.strictJson},{Icon:IconBolt,label:ko ? "도구" : "Tools",value:capability?.toolUse},{Icon:IconImage,label:ko ? "이미지" : "Images",value:capability?.imageInput},{Icon:IconPower,label:ko ? "중지" : "Cancellation",value:capability?.cancellation}].map(item => <span key={item.label} role="img" title={`${item.label} · ${checked(item.value,ko)}`} aria-label={`${item.label} · ${checked(item.value,ko)}`}><item.Icon size={15} /></span>)}
          </div>
        </div> : <p className={styles.empty}>{ko ? "목록에서 모델을 선택해 주세요." : "Select a model from the list."}</p>}
      </div>
      {busy && <div role="status" className={styles.progress} data-operation-package={operation?.packageId}><span>{busy}{progress ? ` ${bytes(progress.downloadedBytes)} / ${bytes(progress.totalBytes)}` : ""}</span>{operation && <button type="button" onClick={() => void cancel()}>{ko ? "중지" : "Stop"}</button>}</div>}
      {notice && <p role="status" className={styles.notice}>{notice}</p>}
    </>}
    {confirmation && <LocalModelInstallDialog key={`${confirmation.packageId}:${confirmation.engineOnly}`} {...confirmation} ko={ko} onCancel={() => setConfirmation(null)} onConfirm={confirmInstall}/> }
  </section>;
}
