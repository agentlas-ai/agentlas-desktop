"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ToolchainsApi } from "@shared/toolchain";
import { requiredExecutionPermission } from "@shared/graph-node-protocol";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { navigate } from "@/lib/navigation";
import { IconClose, IconPlus, IconRefresh, IconToolchain } from "@/components/Icon";
import styles from "./ToolchainsManager.module.css";

type Asset = Awaited<ReturnType<ToolchainsApi["listAssets"]>>[number];
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

export function ToolchainsManager({ api, locale, focusAssetId = null, focusVersionNumber = null, focusAutomationId = null }: { api: ToolchainsApi | null | undefined; locale: string; focusAssetId?: string | null; focusVersionNumber?: number | null; focusAutomationId?: string | null }) {
  const ko = locale === "ko";
  const say = (kr: string, en: string) => ko ? kr : en;
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [lane, setLane] = useState("all");
  const [openId, setOpenId] = useState<string | null>(focusAssetId);
  const [allowEffectfulValidation, setAllowEffectfulValidation] = useState(false);
  const [versionNumber, setVersionNumber] = useState<number | null>(focusVersionNumber);
  const [form, setForm] = useState<string | null>(null);
  const [generation, setGeneration] = useState<Awaited<ReturnType<ToolchainsApi["generateAsset"]>> | null>(null);
  const [revisionOf, setRevisionOf] = useState<string | null>(null);
  const [args, setArgs] = useState("{}");
  const [runs, setRuns] = useState<unknown[]>([]);
  const [result, setResult] = useState<unknown>(null);
  const load = useCallback(async () => {
    if (!api) return;
    try { setAssets(await api.listAssets()); setLoaded(true); }
    catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
  }, [api]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 60_000); return () => clearInterval(timer); }, [load]);
  useEffect(() => { if (focusAssetId) { setOpenId(focusAssetId); setVersionNumber(focusVersionNumber); } }, [focusAssetId, focusVersionNumber]);
  const open = assets.find((asset) => asset.id === openId);
  const detailRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  useDismissibleLayer({ open: Boolean(open) || form !== null, roots: [detailRef, editorRef], onDismiss: () => { if (form !== null) setForm(null); else setOpenId(null); } });
  const version = versionNumber !== null ? open?.versions.find((item) => item.version === versionNumber) : open?.versions.find((item) => item.version === open.stableVersion) ?? open?.versions.at(-1);
  useEffect(() => { setAllowEffectfulValidation(false); }, [openId, versionNumber]);
  const effectful = Boolean(version && requiredExecutionPermission(version.implementation.snapshot.graph) === "write");
  useEffect(() => { setRuns([]); setResult(null); if (openId && api) void api.assetRuns(openId).then(setRuns).catch((cause) => setError(String(cause))); }, [openId, api]);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); await load(); }
    catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { setBusy(false); }
  };
  const edit = (asset?: Asset) => {
    setError("");
    setGeneration(null);
    setRevisionOf(asset?.id ?? null);
    setForm("");
  };
  const generate = async () => {
    if (!api || form === null || !form.trim()) return;
    await act(async () => {
      const generated = await api.generateAsset({ request: form.trim(), requestId: crypto.randomUUID(), ...(revisionOf ? { toolchainId: revisionOf } : {}) });
      setGeneration(generated);
      setOpenId(generated.asset.id);
      setVersionNumber(generated.version);
      const release = generated.asset.versions.find((item) => item.version === generated.version);
      setArgs(pretty(release?.contract.examples[0]?.input ?? {}));
      setForm(null);
    });
  };
  const visible = assets.filter((asset) => (lane === "all" || asset.status === lane) && `${asset.name} ${asset.versions.at(-1)?.contract.description ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  if (!api) return <p className={styles.notice}>{say("이 화면에서는 툴체인을 불러올 수 없습니다.", "Toolchains are unavailable here.")}</p>;
  return <section className={styles.root} data-toolchains-manager="true">
    <header className={styles.header}><h2>{say("툴체인", "Toolchains")}</h2><input className={styles.search} aria-label={say("툴체인 검색", "Search toolchains")} placeholder={say("이름·용도로 찾기", "Find by name or purpose")} value={query} onChange={(event) => setQuery(event.target.value)} /><button className={styles.refresh} aria-label={say("새로고침", "Refresh")} onClick={() => void load()}><IconRefresh size={16}/></button><button className={styles.create} disabled={busy} onClick={() => edit()}><IconPlus size={14}/>{say("새 툴체인", "New toolchain")}</button></header>
    <p className={styles.intro}>{say("AI가 요청을 재사용 가능한 기능으로 일반화합니다. 기능별 항목 하나에 버전을 보관하고, 검증된 버전을 그래프에서 호출합니다.", "AI generalizes your request into a reusable capability. Each capability keeps its versions in one catalog item; graphs call verified versions.")}</p>
    {focusAutomationId && <p className={styles.notice}>{say("이전 그래프 출처 링크입니다.", "This is a legacy graph source link.")} <button onClick={() => navigate(`/automation/flow?id=${encodeURIComponent(focusAutomationId)}`)}>{say("원본 그래프 열기", "Open source graph")}</button></p>}
    <div className={styles.lanes}>{["all", "callable", "draft", "withdrawn"].map((key) => <button key={key} data-active={lane === key} onClick={() => setLane(key)}>{({ all: say("전체", "All"), callable: say("호출 가능", "Callable"), draft: say("초안", "Draft"), withdrawn: say("호출 중단", "Withdrawn") })[key]}</button>)}</div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {!loaded ? <p className={styles.notice}>{say("불러오는 중…", "Loading…")}</p> : visible.length === 0 ? <p className={styles.notice}>{say("등록된 툴체인이 없습니다. 반복해서 사용할 기능을 AI에 요청하세요.", "No registered toolchains. Ask AI for a capability you can use repeatedly.")}</p> : <div className={styles.grid}>{visible.map((asset) => <button key={asset.id} className={styles.tile} data-toolchain-entry={asset.id} onClick={() => { setOpenId(asset.id); setVersionNumber(null); }}><span className={styles.assetIcon}><IconToolchain size={30}/></span><span className={styles.tileName}>{asset.name}</span><span className={styles.pill} title={asset.id}>{asset.id.slice(-8)} · {asset.status} · {asset.stableVersion ? `v${asset.stableVersion}` : say("미검증", "Unverified")}</span></button>)}</div>}
    {open && !version && <p className={styles.error} role="status">{say("요청한 버전을 찾지 못했습니다.", "The requested version could not be found.")} <button onClick={() => setVersionNumber(null)}>{say("현재 버전 보기", "View current version")}</button></p>}
    {open && version && form === null && <div className={styles.backdrop} onClick={() => setOpenId(null)}><div ref={detailRef} className={styles.sheet} role="dialog" aria-modal="true" aria-label={open.name} onClick={(event) => event.stopPropagation()}><button className={styles.close} aria-label={say("닫기", "Close")} onClick={() => setOpenId(null)}><IconClose size={14}/></button><h3 className={styles.popupTitle}><span><IconToolchain size={21}/></span>{open.name}</h3>{error && <p className={styles.error} role="alert">{error}</p>}<details className={styles.description}><summary>{say("기능 설명", "Capability details")}</summary><p className={styles.intro}>{version.contract.description}</p></details><code>{open.id}</code>{generation?.asset.id === open.id && <p className={styles.notice} role="status">{({ reuse: say("기존 기능 재사용", "Existing capability reused"), new_version: say("같은 항목에 새 버전 생성", "New version in the same catalog item"), new_asset: say("새 기능 생성", "New capability created") })[generation.decision]} · v{generation.version}<br/>{generation.rationale}</p>}{effectful && <label className={styles.effectConsent}><input type="checkbox" checked={allowEffectfulValidation} onChange={(event) => setAllowEffectfulValidation(event.target.checked)}/><span>{say("예시 입력을 검토했습니다. 검증 예시는 실제로 실행되며 파일 작성·업로드·전송을 할 수 있습니다.", "I reviewed the example inputs. Validation executes them and may write files, upload or send.")}</span></label>}<div className={styles.sheetActions}><button disabled={busy || open.status === "withdrawn"} onClick={() => edit(open)}>{say("AI로 기능 개선", "Improve capability with AI")}</button><button disabled={busy || open.status === "withdrawn" || (effectful && !allowEffectfulValidation)} onClick={() => void act(() => api.publishVersion({ id: open.id, version: version.version, allowEffectfulValidation }))}>{say("예시 실행·검증 후 호출 등록", "Validate examples & make callable")}</button>{open.status !== "withdrawn" && <button disabled={busy} onClick={() => void act(() => api.withdrawAsset(open.id))}>{say("호출 중단", "Withdraw")}</button>}</div><p className={styles.intro}>{say("호출 중단은 원본 그래프의 예약을 바꾸지 않습니다.", "Withdrawal does not change the source graph schedule.")}</p><label className={styles.field}>{say("버전 (저장된 버전은 변경되지 않습니다)", "Version (saved versions are immutable)")}<select value={version.version} onChange={(event) => setVersionNumber(Number(event.target.value))}>{open.versions.map((item) => <option key={item.version} value={item.version}>v{item.version}{item.version === open.stableVersion ? " · stable" : ""}</option>)}</select></label><details className={styles.description}><summary>{say("입력별 동작", "Behavior by input")}</summary><p>{version.contract.variationStatement}</p></details><p className={version.validation.state === "failed" ? styles.error : styles.intro} role="status">{say("검증 상태", "Validation")}: {version.validation.state}{version.validation.problems.length > 0 ? ` · ${version.validation.problems.join("; ")}` : ""}</p><details><summary>{say("입력·출력·예시·검증 보기", "Inputs, outputs, examples & validation")}</summary><pre className={styles.json}>{pretty({ inputSchema: version.contract.inputSchema, outputSchema: version.contract.outputSchema, examples: version.contract.examples, validation: version.validation })}</pre></details><label className={styles.field}>{say("호출 입력 JSON", "Call input JSON")}<textarea value={args} onChange={(event) => setArgs(event.target.value)}/></label><div className={styles.sheetActions}><button disabled={busy || open.status !== "callable" || version.validation.state !== "passed"} onClick={() => void act(async () => { const receipt = await api.runAsset({ id: open.id, version: version.version, input: JSON.parse(args), requestId: crypto.randomUUID() }); setResult(receipt); setRuns(await api.assetRuns(open.id)); })}>{busy ? say("처리 중…", "Working…") : say("이 버전 호출", "Call this version")}</button><button onClick={() => navigate(`/automation/flow?id=${encodeURIComponent(version.implementation.automationId)}`)}>{say("구현 그래프 보기", "View implementation graph")}</button></div>{result != null && <pre className={styles.json} role="status">{pretty(result)}</pre>}<details><summary>{say("호출 이력", "Call history")} ({runs.length})</summary><pre className={styles.json}>{pretty(runs)}</pre></details></div></div>}
    {form !== null && <div className={styles.backdrop} onClick={() => { if (!busy) setForm(null); }}><div ref={editorRef} className={`${styles.sheet} ${styles.editor}`} role="dialog" aria-modal="true" aria-label={say("AI 툴체인 생성", "Generate toolchain with AI")} onClick={(event) => event.stopPropagation()}><button className={styles.close} disabled={busy} aria-label={say("닫기", "Close")} onClick={() => setForm(null)}><IconClose size={14}/></button><h3 className={styles.popupTitle}><span><IconToolchain size={21}/></span>{revisionOf ? say("AI로 기능 개선", "Improve capability with AI") : say("AI로 재사용 기능 만들기", "Create a reusable capability with AI")}</h3><details className={styles.description}><summary>{say("생성 안내", "Generation details")}</summary><p className={styles.intro}>{revisionOf ? say("이 기능에서 바꾸거나 확장할 내용을 알려 주세요. 개선 버전은 같은 항목에 저장되고 기존 버전은 유지됩니다.", "Describe what to change or extend. An improved version stays in this catalog item and preserves existing versions.") : say("반복해서 사용할 기능과 실행마다 달라지는 입력을 설명해 주세요. AI가 범용 기능·입출력 계약·검증 예시를 설계하고, 같은 기능이 있으면 재사용합니다.", "Describe the capability you will use repeatedly and the inputs that vary. AI designs the generalized capability, input/output contract and validation examples, and reuses an existing capability when it fits.")}</p></details><label className={styles.field}>{say("어떤 기능이 필요한가요?", "What capability do you need?")}<textarea data-toolchain-generation-request rows={7} disabled={busy} value={form} placeholder={say("예: 여러 문서를 받아 원하는 언어로 요약하고, 핵심 항목을 표로 정리하는 기능. 문서·언어·요약 길이는 매번 달라집니다.", "Example: Summarize multiple documents in a requested language and organize key items into a table. Documents, language and summary length vary each time.")} onChange={(event) => setForm(event.target.value)}/></label><p className={styles.intro}>{say("생성 후 계약과 예시를 검토하고 실제 예시 실행으로 검증하세요. 기존 작업 그래프는 가져오지 않습니다.", "Review the generated contract and examples, then validate with real example executions. Existing task graphs are not imported.")}</p><div className={styles.sheetActions}><button disabled={busy || !form.trim()} data-primary="true" onClick={() => void generate()}>{busy ? say("AI가 기능을 설계하는 중…", "AI is designing the capability…") : say("AI로 기능 생성", "Generate capability with AI")}</button><button disabled={busy} onClick={() => setForm(null)}>{say("취소", "Cancel")}</button></div>{error && <p className={styles.error} role="alert">{error}</p>}</div></div>}

  </section>;
}
