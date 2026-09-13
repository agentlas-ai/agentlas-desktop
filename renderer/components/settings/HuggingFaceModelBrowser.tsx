"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { IconAlertTriangle, IconClose, IconCpu, IconRefresh, IconSearch } from "@/components/Icon";
import type { HuggingFaceModelFile, HuggingFaceRepositoryInspection, HuggingFaceSearchResult, LocalModelHubSnapshot } from "@shared/local-model-hub";
import styles from "./HuggingFaceModelBrowser.module.css";
import { LocalModelFitIcon, LocalModelInstallDialog, type LocalModelInstallPlan } from "./LocalModelInstallDialog";

function size(bytes: number | null) { return bytes === null ? "—" : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.ceil(bytes / 1024 ** 2)} MiB`; }
function compact(value: number) { return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value); }

export function HuggingFaceModelBrowser({ ko, onInstalled, onOperationStarted }: { ko: boolean; onInstalled: (packageId: string) => void; onOperationStarted?: (id: string) => void }) {
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [hardwareSnapshot, setHardwareSnapshot] = useState<LocalModelHubSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<HuggingFaceSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [inspection, setInspection] = useState<HuggingFaceRepositoryInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [operation, setOperation] = useState<{ id: string; packageId: string; fileName: string; alsoIds?: string[] } | null>(null);
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null; state: string } | null>(null);
  const searchEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const installing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; void ipc()?.localModelHub.snapshot().then(value => { if (mounted.current) setHardwareSnapshot(value); }).catch(() => {}); return () => { mounted.current = false; }; }, []);
  const [registering, setRegistering] = useState(false);
  const intent = useRef<{ cancelled: boolean } | null>(null);

  const search = useCallback(async (cursor?: string, refresh = false) => {
    const epoch = ++searchEpoch.current;
    const api = ipc()?.localModelHub;
    if (!api) { setError(ko ? "모델 검색 연결을 확인해 주세요." : "Check the model catalog connection."); return; }
    setLoading(true); setError(null);
    try {
      const next = await api.searchModels({ query, ...(cursor ? { cursor } : {}), ...(refresh ? { refresh } : {}) });
      if (epoch !== searchEpoch.current) return;
      if (next.stale && next.syncedAt === null) {
        setError(ko ? "Hugging Face에 연결하지 못했습니다. 연결을 확인하고 다시 시도하세요." : "Hugging Face is unavailable. Check your connection and retry.");
        if (cursor) return;
      }
      setResult(prior => cursor && prior ? { ...next, models: [...new Map([...prior.models, ...next.models].map(row => [row.repository, row])).values()] } : next);
    } catch { if (epoch === searchEpoch.current) setError(ko ? "Hugging Face 목록을 불러오지 못했습니다. 다시 시도하세요." : "Could not load Hugging Face models. Try again."); }
    finally { if (epoch === searchEpoch.current) setLoading(false); }
  }, [ko, query]);
  useEffect(() => { const timer = window.setTimeout(() => void search(), 300); return () => { window.clearTimeout(timer); searchEpoch.current++; }; }, [search]);
  useEffect(() => {
    if (!selected) return;
    const api = ipc()?.localModelHub;
    if (!api) { setError(ko ? "모델 파일 연결을 확인해 주세요." : "Check the model file connection."); return; }
    const epoch = ++detailEpoch.current;
    setInspection(null); setInspecting(true); setError(null);
    void api.inspectRepository({ repository: selected }).then(value => {
      if (epoch === detailEpoch.current) setInspection(value);
    }).catch(() => { if (epoch === detailEpoch.current) setError(ko ? "모델 파일을 확인하지 못했습니다." : "Could not inspect model files."); })
      .finally(() => { if (epoch === detailEpoch.current) setInspecting(false); });
    return () => { detailEpoch.current++; };
  }, [selected, ko]);
  useEffect(() => {
    if (!operation) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const snapshot = await ipc()?.localModelHub.snapshot();
        const row = snapshot?.modelProgress.find(item => item.packageId === operation.packageId);
        if (!disposed && row) setProgress({ downloaded: row.downloadedBytes, total: row.totalBytes, state: row.state });
      } catch { /* Download result retains the authoritative outcome. */ }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 600);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [operation]);

  const close = useCallback(() => { setSelected(null); opener.current?.focus(); }, []);
  useEffect(() => {
    if (!selected) return;
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key !== "Tab") return;
      const targets = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,[tabindex="0"]') ?? []);
      if (!targets.length) return;
      if (event.shiftKey && document.activeElement === targets[0]) { event.preventDefault(); targets.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === targets.at(-1)) { event.preventDefault(); targets[0].focus(); }
    };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, [selected, close]);

  const install = async (file: HuggingFaceModelFile) => {
    const api = ipc()?.localModelHub;
    if (!api || !inspection?.revision || !file.downloadable || installing.current) return;
    installing.current = true; setRegistering(true); setError(null); setProgress(null);
    const request = { cancelled: false }; intent.current = request;
    try {
      const model = await api.addModel({ repository: inspection.repository, revision: inspection.revision, fileName: file.fileName });
      if (request.cancelled || !mounted.current) throw new Error("cancelled");
      setConfirmation(model.packageId);
    } catch (failure) {
      installing.current = false; intent.current = null;
      if (mounted.current) setError(failure instanceof Error && failure.message === "cancelled" ? (ko ? "취소했습니다." : "Cancelled.") : (ko ? "파일 정보를 확인하지 못했습니다." : "Could not confirm file metadata."));
    } finally { if (mounted.current) setRegistering(false); }
  };
  const dismissConfirmation = () => { setConfirmation(null); installing.current = false; if (intent.current) intent.current.cancelled = true; intent.current = null; };
  const confirmInstall = async (plan: LocalModelInstallPlan) => {
    const api = ipc()?.localModelHub, request = intent.current;
    if (!api || !request || request.cancelled || !plan.model || !mounted.current || plan.model.packageId !== confirmation) return;
    setConfirmation(null); setError(null);
    const ids: string[] = [], pending: Promise<unknown>[] = [];
    if (plan.installEngine) {
      const id = crypto.randomUUID(); ids.push(id); onOperationStarted?.(id);
      pending.push(api.installEnginePackage({ packageId: plan.engine.packageId, operationId: id }));
    }
    const id = crypto.randomUUID(); ids.push(id); onOperationStarted?.(id);
    setOperation({ id, packageId: plan.model.packageId, fileName: plan.model.fileName, alsoIds: ids.slice(0,-1) });
    pending.push(api.installModelPackage({ packageId: plan.model.packageId, operationId: id }));
    try {
      const results = await Promise.allSettled(pending);
      const failed = results.find((row): row is PromiseRejectedResult => row.status === "rejected");
      if (failed) throw failed.reason;
      if (request.cancelled || !mounted.current) return;
      close(); onInstalled(plan.model.packageId);
    } catch (failure) {
      if (mounted.current) setError(request.cancelled ? (ko ? "설치를 중지했습니다." : "Installation stopped.") : (ko ? "설치를 완료하지 못했습니다. 작업 상태를 확인하고 다시 시도하세요." : "Installation did not finish. Check operation status and retry."));
    } finally { installing.current = false; intent.current = null; if (mounted.current) setOperation(null); }
  };

  const cancel = async () => {
    if (intent.current) intent.current.cancelled = true;
    if (operation) {
      const api = ipc()?.localModelHub;
      const results = await Promise.allSettled([operation.id,...(operation.alsoIds ?? [])].map(operationId => api?.cancelOperation({ operationId })));
      if (results.some(row => row.status === "rejected")) setError(ko ? "중지 상태를 확인하지 못했습니다. 다시 시도하세요." : "Could not confirm cancellation. Try again.");
    }
  };
  const status = result?.stale && result.syncedAt === null ? (ko ? "목록 연결 필요" : "Catalog unavailable") : result?.stale ? (ko ? "저장된 목록 · 업데이트 확인 필요" : "Saved catalog · update unavailable") : result?.source === "cache" ? (ko ? "저장된 목록" : "Saved catalog") : "Hugging Face";
  return <section className={styles.browser} aria-label={ko ? "Hugging Face 모델 탐색" : "Browse Hugging Face models"}>
    <div className={styles.searchRow}><label className={styles.search}><IconSearch size={18} /><input aria-label={ko ? "Hugging Face 모델 검색" : "Search Hugging Face models"} placeholder={ko ? "모델이나 제작자를 검색하세요" : "Search models or publishers"} value={query} onChange={event => { searchEpoch.current++; setResult(null); setQuery(event.target.value); }} /></label>
      <button className={styles.refresh} type="button" disabled={loading} title={result?.syncedAt ? `${ko ? "확인" : "Checked"} ${new Date(result.syncedAt).toLocaleString(ko ? "ko-KR" : "en-US")}` : undefined} aria-label={ko ? "모델 목록 새로고침" : "Refresh model catalog"} onClick={() => void search(undefined, true)}><IconRefresh size={17} /></button></div>
    <div className={styles.source}><span title={ko ? "Hugging Face 공개 목록을 조회만 하고, 파일은 원본 저장소에서 이 컴퓨터로 직접 내려받습니다. 복제·재배포하지 않으며 라이선스 표기는 원본 그대로 둡니다." : "Only the public Hugging Face listing is queried; files download straight from the source repository to this computer. Nothing is mirrored or redistributed, and licenses stay as published."}>{status} · GGUF</span></div>
    {error && !selected && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.grid} aria-busy={loading}>
      {result?.models.map(model => <button key={model.repository} type="button" data-hf-repository={model.repository} className={styles.card} onClick={event => { opener.current = event.currentTarget; setSelected(model.repository); }}>
        <span className={styles.modelMark}><IconCpu size={22} /><LocalModelFitIcon snapshot={hardwareSnapshot} blocked={model.gated === true} ko={ko}/></span><span className={styles.publisher}>{model.author ?? model.repository.split("/")[0]}</span>
        <strong>{model.repository.split("/").slice(1).join("/")}</strong>
        <span className={styles.tags}>{model.license ?? (ko ? "라이선스 확인 필요" : "License unconfirmed")}{model.gated === true ? ` · ${ko ? "접근 승인 필요" : "Access approval required"}` : ""}</span>
        <span className={styles.cardFooter}><span>{model.downloads !== undefined ? `${compact(model.downloads)} ${ko ? "다운로드" : "downloads"}` : (ko ? "원본 파일 살펴보기" : "Browse source files")}</span><span>{ko ? "파일 보기 →" : "View files →"}</span></span>
      </button>)}
    </div>
    {loading && <p className={styles.empty} role="status">{ko ? "모델을 찾는 중…" : "Finding models…"}</p>}
    {!loading && !error && result?.models.length === 0 && <p className={styles.empty}>{ko ? "검색 결과가 없습니다. 다른 이름으로 검색해 보세요." : "No models found. Try another name."}</p>}
    {result?.nextCursor && <button className={styles.more} type="button" disabled={loading} onClick={() => void search(result.nextCursor)}>{ko ? "더 보기" : "Load more"}</button>}
    {registering && !selected && <div className={styles.downloadStatus} role="status"><span className={styles.pending} aria-label={ko ? "파일 확인 중" : "Checking file"} title={ko ? "파일 확인 중" : "Checking file"}><IconRefresh size={16}/></span><button type="button" onClick={() => void cancel()}>{ko ? "중지" : "Stop"}</button></div>}
    {operation && !selected && <div className={styles.downloadStatus} role="status"><span data-download-package={operation.packageId}>{operation.fileName} · {size(progress?.downloaded ?? 0)} / {size(progress?.total ?? null)}</span><button type="button" onClick={() => void cancel()}>{ko ? "취소" : "Cancel"}</button></div>}
    {selected && <div className={styles.backdrop} aria-hidden={!!confirmation} onPointerDown={event => { if (event.target === event.currentTarget) close(); }}><div ref={dialog} className={styles.detail} role="dialog" aria-modal="true" aria-labelledby="hf-model-detail-title">
      <header><div><span>Hugging Face</span><h2 id="hf-model-detail-title">{selected}</h2></div><button type="button" aria-label={ko ? "모델 상세 닫기" : "Close model details"} onClick={close}><IconClose size={18} /></button></header>
      {inspecting ? <span role="status" className={styles.pending} aria-label={ko ? "파일 확인 중" : "Checking files"} title={ko ? "파일 확인 중" : "Checking files"}><IconRefresh size={16}/></span> : inspection && <>
        <div className={styles.metadata}><span>{ko ? "제작자" : "Creator"}<strong>{inspection.creator ?? (ko ? "확인 필요" : "Unconfirmed")}</strong></span><span>{ko ? "배포자 / 변환자" : "Publisher / converter"}<strong>{inspection.publisher ?? "—"} / {inspection.converter ?? "—"}</strong></span><span>{ko ? "라이선스" : "License"}<strong>{inspection.license ?? (ko ? "확인 필요" : "Unconfirmed")}</strong></span></div>

        {inspection.stale && <span role="status" className={styles.stale} aria-label={ko ? "저장된 목록 · 연결 확인 필요" : "Saved list; check connection"} title={ko ? "저장된 목록 · 연결 확인 필요" : "Saved list; check connection"}><IconAlertTriangle size={16}/></span>}
        <div className={styles.files}>{inspection.files.map(file => <div key={file.fileName} className={styles.file}><div><strong>{file.fileName} <LocalModelFitIcon snapshot={hardwareSnapshot} packageId={hardwareSnapshot?.modelCatalog.find(model => model.repository === inspection.repository && model.revision === inspection.revision && model.fileName === file.fileName)?.packageId} blocked={!file.downloadable} ko={ko}/></strong><span>{file.quantization ?? "GGUF"} · {size(file.byteLength)}</span>{!file.downloadable && <span>{inspection.gated === true ? (ko ? "원본 저장소에서 접근 승인이 필요합니다." : "Access approval is required at the source.") : (ko ? "이 파일은 현재 다운로드 대상으로 지원하지 않습니다." : "This file is not currently supported for download.")}</span>}</div><button type="button" disabled={!file.downloadable || registering || operation !== null || confirmation !== null || !inspection.revision} onClick={() => void install(file)}>{ko ? "다운로드" : "Download"}</button></div>)}</div>
        {!inspection.files.length && <p>{inspection.reasonCode && inspection.revision === null ? (ko ? "원본 파일 정보를 읽지 못했습니다. 연결이나 접근 권한을 확인해 주세요." : "Source file metadata is unavailable. Check connectivity or access.") : (ko ? "현재 지원하는 GGUF 파일이 없습니다." : "No supported GGUF files are available.")}</p>}
        <a className={styles.sourceLink} href={`https://huggingface.co/${inspection.repository}${inspection.revision ? `/tree/${inspection.revision}` : ""}`} target="_blank" rel="noreferrer">{ko ? "Hugging Face 원본 보기 ↗" : "View source on Hugging Face ↗"}</a>
      </>}
      {registering && <div className={styles.downloadStatus} role="status"><span className={styles.pending} aria-label={ko ? "파일 확인 중" : "Checking file"} title={ko ? "파일 확인 중" : "Checking file"}><IconRefresh size={16}/></span><button type="button" onClick={() => void cancel()}>{ko ? "중지" : "Stop"}</button></div>}
      {operation && <div className={styles.downloadStatus} role="status"><span data-download-package={operation.packageId}>{operation.fileName} · {size(progress?.downloaded ?? 0)} / {size(progress?.total ?? null)}</span><button type="button" onClick={() => void cancel()}>{ko ? "다운로드 취소" : "Cancel download"}</button></div>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div></div>}
    {confirmation && <LocalModelInstallDialog key={confirmation} packageId={confirmation} ko={ko} onCancel={dismissConfirmation} onConfirm={plan => void confirmInstall(plan)}/> }
  </section>;
}
