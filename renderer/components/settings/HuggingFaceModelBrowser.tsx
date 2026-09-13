"use client";
/*
 * 로컬 모델 탐색 — 카드가 아니라 필터 있는 표 (오너 2026-09-13).
 *   · 검색: 글자를 칠 때 결과를 비우지 않는다(비우면 목록이 깜빡이며 "반응이 깨진다"). 새 결과가 오면 바꾼다.
 *   · 열: 모델 · 역할(대화/추론/코딩/이미지/임베딩) · 크기 · 필요 메모리 · 추천(원활/주의/위험) · 다운로드.
 *   · 화면 글자는 짧게, 근거는 마우스를 올리면. 다운로드는 팝업에서 파일별로 다시 판정한다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { IconClose, IconRefresh, IconSearch } from "@/components/Icon";
import type { HuggingFaceModelFile, HuggingFaceRepositoryInspection, HuggingFaceSearchResult, LocalModelHubSnapshot } from "@shared/local-model-hub";
import { classifyModelRole, estimateFit, estimateModelBytes, fitLabel, parseParameterCount, roleLabel, type LocalModelFitLevel, type LocalModelRole } from "@/lib/local-model-fit";
import styles from "./HuggingFaceModelBrowser.module.css";
import { LocalModelInstallDialog, type LocalModelInstallPlan } from "./LocalModelInstallDialog";

function size(bytes: number | null) { return bytes === null ? "—" : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.ceil(bytes / 1024 ** 2)} MiB`; }
function compact(value: number) { return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function params(repository: string): string { const value = parseParameterCount(repository); return value ? `${Number((value / 1e9).toFixed(1))}B` : "—"; }

interface Row {
  repository: string;
  author: string;
  tags: string[];
  downloads?: number;
  license: string | null;
  gated: boolean | "unknown";
  bytes: number | null;
  exact: boolean;
  /** 내장 카탈로그(출처·변환자 확인) — 팝업 없이 바로 설치 확인창. */
  packageId?: string;
  role: LocalModelRole;
}

type RoleFilter = "all" | LocalModelRole;
type FitFilter = "all" | "smooth" | "caution";
const ROLE_FILTERS: RoleFilter[] = ["all", "chat", "reasoning", "coding", "vision", "embedding"];
const FIT_ORDER: Record<LocalModelFitLevel, number> = { smooth: 0, caution: 1, unknown: 2, risky: 3 };

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
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [fitFilter, setFitFilter] = useState<FitFilter>("all");
  const [sort, setSort] = useState<"popular" | "fit">("popular");
  const searchEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const installing = useRef(false);
  const mounted = useRef(true);
  const [registering, setRegistering] = useState(false);
  const intent = useRef<{ cancelled: boolean } | null>(null);
  const refreshSnapshot = useCallback(() => { void ipc()?.localModelHub.snapshot().then(value => { if (mounted.current) setHardwareSnapshot(value); }).catch(() => {}); }, []);
  useEffect(() => { mounted.current = true; refreshSnapshot(); return () => { mounted.current = false; }; }, [refreshSnapshot]);

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
      // 이전 결과는 새 결과가 올 때 바뀐다 — 타이핑 중에 표가 비었다 차는 깜빡임이 없다.
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
  const installCurated = (packageId: string) => {
    if (installing.current) return;
    installing.current = true; setError(null); setProgress(null);
    intent.current = { cancelled: false };
    setConfirmation(packageId);
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
    } catch {
      if (mounted.current) setError(request.cancelled ? (ko ? "설치를 중지했습니다." : "Installation stopped.") : (ko ? "설치를 완료하지 못했습니다. 작업 상태를 확인하고 다시 시도하세요." : "Installation did not finish. Check operation status and retry."));
    } finally {
      installing.current = false; intent.current = null;
      if (mounted.current) { setOperation(null); refreshSnapshot(); }
    }
  };
  const cancel = async () => {
    if (intent.current) intent.current.cancelled = true;
    if (operation) {
      const api = ipc()?.localModelHub;
      const results = await Promise.allSettled([operation.id,...(operation.alsoIds ?? [])].map(operationId => api?.cancelOperation({ operationId })));
      if (results.some(row => row.status === "rejected")) setError(ko ? "중지 상태를 확인하지 못했습니다. 다시 시도하세요." : "Could not confirm cancellation. Try again.");
    }
  };

  const hardware = hardwareSnapshot?.hardware ?? null;
  const rows = useMemo<Row[]>(() => {
    const installed = new Set((hardwareSnapshot?.modelInstallations ?? []).map(item => item.modelPackageId));
    const curated: Row[] = (hardwareSnapshot?.modelCatalog ?? []).filter(model => model.creator !== "unknown" && !installed.has(model.packageId)).map(model => ({
      repository: model.repository, author: model.creator, tags: [], license: model.license, gated: model.gated, bytes: model.byteLength, exact: true, packageId: model.packageId,
      role: classifyModelRole(model.repository),
    }));
    const curatedRepos = new Set(curated.map(row => row.repository));
    const searched: Row[] = (result?.models ?? []).filter(model => !curatedRepos.has(model.repository)).map(model => ({
      repository: model.repository, author: model.author ?? model.repository.split("/")[0], tags: model.tags, downloads: model.downloads, license: model.license ?? null,
      gated: model.gated, bytes: estimateModelBytes(model.repository), exact: false, role: classifyModelRole(model.repository, model.tags),
    }));
    // 검색어를 치는 동안(로딩 중)에는 추천 행도 그대로 둔다 — 행이 6→3→2 로 두 번 줄어드는 흔들림 대신 한 번에 바뀐다.
    const hideCurated = query.trim() !== "" && !loading;
    return [...(hideCurated ? [] : curated), ...searched];
  }, [hardwareSnapshot, result, query, loading]);
  const evaluated = useMemo(() => rows.map(row => ({ row, fit: estimateFit(hardware, row.bytes, ko, row.exact) })), [rows, hardware, ko]);
  const visible = useMemo(() => {
    const filtered = evaluated.filter(({ row, fit }) => (roleFilter === "all" || row.role === roleFilter) && (fitFilter === "all" || fit.level === fitFilter));
    if (sort === "fit") return [...filtered].sort((a, b) => FIT_ORDER[a.fit.level] - FIT_ORDER[b.fit.level] || (b.row.downloads ?? 0) - (a.row.downloads ?? 0));
    return filtered;
  }, [evaluated, roleFilter, fitFilter, sort]);
  const hardwareLine = hardware
    ? `${(hardware.totalMemoryBytes / 1024 ** 3).toFixed(0)} GiB · ${hardware.engineDevices?.find(device => device.gpu)?.name ?? (hardware.accelerator === "metal" ? "Metal" : (ko ? "GPU 미확인" : "GPU unverified"))}`
    : "";
  const fileFit = (file: HuggingFaceModelFile) => estimateFit(hardware, file.byteLength, ko, true);

  return <section className={styles.browser} aria-label={ko ? "Hugging Face 모델 탐색" : "Browse Hugging Face models"}>
    <div className={styles.searchRow}>
      <label className={styles.search} data-loading={loading ? "true" : "false"}>
        <IconSearch size={16} />
        <input aria-label={ko ? "Hugging Face 모델 검색" : "Search Hugging Face models"} placeholder={ko ? "모델이나 제작자 검색" : "Search models or publishers"} value={query} onChange={event => setQuery(event.target.value)} spellCheck={false} autoComplete="off" />
        <span className={styles.spinner} aria-hidden="true"><IconRefresh size={14} /></span>
      </label>
      <button className={styles.refresh} type="button" disabled={loading} title={result?.syncedAt ? `${ko ? "Hugging Face 확인" : "Checked Hugging Face"} ${new Date(result.syncedAt).toLocaleString(ko ? "ko-KR" : "en-US")}` : undefined} aria-label={ko ? "모델 목록 새로고침" : "Refresh model catalog"} onClick={() => void search(undefined, true)}><IconRefresh size={15} /></button>
    </div>
    <div className={styles.filters} role="group" aria-label={ko ? "필터" : "Filters"}>
      <div className={styles.segment} role="radiogroup" aria-label={ko ? "역할" : "Role"}>
        {ROLE_FILTERS.map(value => <button key={value} type="button" role="radio" aria-checked={roleFilter === value} data-filter-role={value} onClick={() => setRoleFilter(value)}>{value === "all" ? (ko ? "전체" : "All") : roleLabel(value, ko)}</button>)}
      </div>
      <div className={styles.segment} role="radiogroup" aria-label={ko ? "추천" : "Fit"}>
        {(["all", "smooth", "caution"] as FitFilter[]).map(value => <button key={value} type="button" role="radio" aria-checked={fitFilter === value} data-filter-fit={value} onClick={() => setFitFilter(value)}>{value === "all" ? (ko ? "모든 사양" : "Any fit") : fitLabel(value, ko)}</button>)}
      </div>
      <div className={styles.segment} role="radiogroup" aria-label={ko ? "정렬" : "Sort"}>
        <button type="button" role="radio" aria-checked={sort === "popular"} onClick={() => setSort("popular")}>{ko ? "인기순" : "Popular"}</button>
        <button type="button" role="radio" aria-checked={sort === "fit"} onClick={() => setSort("fit")}>{ko ? "추천순" : "Best fit"}</button>
      </div>
      <span className={styles.hardware} title={ko ? "이 컴퓨터의 총 메모리와 엔진이 감지한 GPU. 추천은 총 메모리 기준입니다." : "This computer's total memory and the GPU the engine reported. Fit is judged against total memory."}>{hardwareLine}</span>
    </div>
    {error && !selected && <p className={styles.error} role="alert">{error}</p>}
    <table className={styles.table} data-hf-table aria-busy={loading}>
      <thead><tr>
        <th>{ko ? "모델" : "Model"}</th><th>{ko ? "역할" : "Role"}</th><th>{ko ? "크기" : "Size"}</th>
        <th title={ko ? "모델 파일 + 실행 예비량. 이름에서 추정한 값은 파일 팝업에서 정확히 다시 잽니다." : "Model file plus runtime reserve. Name-based estimates are re-measured per file in the popup."}>{ko ? "필요 메모리" : "Memory"}</th>
        <th title={ko ? "이 컴퓨터 총 메모리·GPU 기준. 원활 / 주의 / 위험" : "Against this computer's total memory and GPU. Smooth / Caution / Risky"}>{ko ? "추천" : "Fit"}</th>
        <th><span className="sr-only">{ko ? "다운로드" : "Download"}</span></th>
      </tr></thead>
      <tbody>
        {visible.map(({ row, fit }) => {
          const name = row.repository.split("/").slice(1).join("/");
          const blocked = row.gated === true;
          const meta = [row.author, row.license ?? (ko ? "라이선스 확인 필요" : "license unconfirmed"), row.downloads !== undefined ? `${compact(row.downloads)} ${ko ? "다운로드" : "downloads"}` : null].filter(Boolean).join(" · ");
          return <tr key={row.repository} data-hf-repository={row.repository} data-fit={fit.level} data-curated={row.packageId ? "true" : "false"}>
            <td className={styles.model} title={`${row.repository}${row.license ? ` · ${row.license}` : ""}`}><strong>{name}</strong><small>{meta}</small></td>
            <td><span className={styles.role} data-role={row.role}>{roleLabel(row.role, ko)}</span></td>
            <td className={styles.num} title={row.exact ? `${ko ? "파일" : "File"} ${size(row.bytes)}` : (ko ? "이름의 파라미터 수" : "Parameters from the name")}>{row.exact ? size(row.bytes) : params(row.repository)}</td>
            <td className={styles.num} title={fit.reason}>{fit.memoryBytes ? `${row.exact ? "" : "≈"}${(fit.memoryBytes / 1024 ** 3).toFixed(1)} GiB` : "—"}</td>
            <td><span className={styles.fit} data-level={fit.level} title={fit.reason} aria-label={`${fitLabel(fit.level, ko)} · ${fit.reason}`}>{fitLabel(fit.level, ko)}</span></td>
            <td className={styles.action}>
              {row.packageId
                ? <button type="button" disabled={blocked || operation !== null || confirmation !== null} data-download-curated={row.packageId} title={blocked ? (ko ? "원본 저장소에서 접근 승인이 필요합니다" : "Access approval required at the source") : (ko ? "출처가 확인된 파일 · 바로 설치" : "Verified file · install directly")} onClick={() => installCurated(row.packageId!)}>{ko ? "다운로드" : "Download"}</button>
                : <button type="button" disabled={blocked || operation !== null} title={blocked ? (ko ? "원본 저장소에서 접근 승인이 필요합니다" : "Access approval required at the source") : (ko ? "파일을 골라 내려받기" : "Choose a file to download")} onClick={event => { opener.current = event.currentTarget; setSelected(row.repository); }}>{ko ? "다운로드" : "Download"}</button>}
            </td>
          </tr>;
        })}
      </tbody>
    </table>
    {!loading && !error && visible.length === 0 && <p className={styles.empty}>{rows.length ? (ko ? "필터에 맞는 모델이 없습니다." : "No models match the filters.") : (ko ? "검색 결과가 없습니다. 다른 이름으로 검색해 보세요." : "No models found. Try another name.")}</p>}
    {result?.nextCursor && <button className={styles.more} type="button" disabled={loading} onClick={() => void search(result.nextCursor)}>{ko ? "더 보기" : "Load more"}</button>}
    {registering && !selected && <div className={styles.downloadStatus} role="status"><span>{ko ? "파일 확인 중…" : "Checking file…"}</span><button type="button" onClick={() => void cancel()}>{ko ? "중지" : "Stop"}</button></div>}
    {operation && !selected && <div className={styles.downloadStatus} role="status"><span data-download-package={operation.packageId}>{operation.fileName} · {size(progress?.downloaded ?? 0)} / {size(progress?.total ?? null)}</span><button type="button" onClick={() => void cancel()}>{ko ? "취소" : "Cancel"}</button></div>}
    {selected && <div className={styles.backdrop} aria-hidden={!!confirmation} onPointerDown={event => { if (event.target === event.currentTarget) close(); }}><div ref={dialog} className={styles.detail} role="dialog" aria-modal="true" aria-labelledby="hf-model-detail-title">
      <header><div><span>{inspection?.publisher ?? selected.split("/")[0]}</span><h2 id="hf-model-detail-title">{selected.split("/").slice(1).join("/")}</h2></div><button type="button" aria-label={ko ? "닫기" : "Close"} onClick={close}><IconClose size={18} /></button></header>
      {inspecting ? <p role="status" className={styles.pendingText}>{ko ? "파일 확인 중…" : "Checking files…"}</p> : inspection && <>
        <p className={styles.detailMeta}>{[inspection.license ?? (ko ? "라이선스 확인 필요" : "license unconfirmed"), inspection.architecture, inspection.stale ? (ko ? "저장된 목록 · 연결 확인 필요" : "saved list · check connection") : null].filter(Boolean).join(" · ")}</p>
        {inspection.files.length > 0 && <table className={styles.table} data-hf-files>
          <thead><tr><th>{ko ? "파일" : "File"}</th><th>{ko ? "양자화" : "Quant"}</th><th>{ko ? "크기" : "Size"}</th><th>{ko ? "추천" : "Fit"}</th><th><span className="sr-only">{ko ? "다운로드" : "Download"}</span></th></tr></thead>
          <tbody>{inspection.files.map(file => { const fit = fileFit(file); return <tr key={file.fileName} data-hf-file={file.fileName} data-fit={fit.level}>
            <td className={styles.model} title={file.fileName}><strong>{file.fileName}</strong>{!file.downloadable && <small>{inspection.gated === true ? (ko ? "원본 저장소에서 접근 승인 필요" : "Access approval required at the source") : (ko ? "지원하지 않는 파일" : "Unsupported file")}</small>}</td>
            <td>{file.quantization ?? "GGUF"}</td>
            <td className={styles.num}>{size(file.byteLength)}</td>
            <td><span className={styles.fit} data-level={fit.level} title={fit.reason}>{fitLabel(fit.level, ko)}</span></td>
            <td className={styles.action}><button type="button" disabled={!file.downloadable || registering || operation !== null || confirmation !== null || !inspection.revision} onClick={() => void install(file)}>{ko ? "다운로드" : "Download"}</button></td>
          </tr>; })}</tbody>
        </table>}
        {!inspection.files.length && <p className={styles.empty}>{inspection.reasonCode && inspection.revision === null ? (ko ? "원본 파일 정보를 읽지 못했습니다. 연결이나 접근 권한을 확인해 주세요." : "Source file metadata is unavailable. Check connectivity or access.") : (ko ? "현재 지원하는 GGUF 파일이 없습니다." : "No supported GGUF files are available.")}</p>}
        <a className={styles.sourceLink} href={`https://huggingface.co/${inspection.repository}${inspection.revision ? `/tree/${inspection.revision}` : ""}`} target="_blank" rel="noreferrer" title={ko ? "목록은 조회만 하고 파일은 원본에서 직접 내려받습니다. 복제·재배포하지 않습니다." : "Only the listing is queried; files download straight from the source. Nothing is mirrored."}>{ko ? "Hugging Face 원본 ↗" : "Source on Hugging Face ↗"}</a>
      </>}
      {registering && <div className={styles.downloadStatus} role="status"><span>{ko ? "파일 확인 중…" : "Checking file…"}</span><button type="button" onClick={() => void cancel()}>{ko ? "중지" : "Stop"}</button></div>}
      {operation && <div className={styles.downloadStatus} role="status"><span data-download-package={operation.packageId}>{operation.fileName} · {size(progress?.downloaded ?? 0)} / {size(progress?.total ?? null)}</span><button type="button" onClick={() => void cancel()}>{ko ? "다운로드 취소" : "Cancel download"}</button></div>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div></div>}
    {confirmation && <LocalModelInstallDialog key={confirmation} packageId={confirmation} ko={ko} onCancel={dismissConfirmation} onConfirm={plan => void confirmInstall(plan)}/> }
  </section>;
}
