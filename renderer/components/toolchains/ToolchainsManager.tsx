"use client";
import { useCallback, useEffect, useState } from "react";
import type { ToolchainsApi } from "@shared/toolchain";
import { requiredExecutionPermission } from "@shared/graph-node-protocol";
import type { Automation } from "@/lib/types";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { IconClose, IconPlus, IconRefresh, IconToolchain } from "@/components/Icon";
import styles from "./ToolchainsManager.module.css";

type Asset = Awaited<ReturnType<ToolchainsApi["listAssets"]>>[number];
type Version = Asset["versions"][number];
type Form = { source: string; node: string; name: string; description: string; use: string; avoid: string; varies: string; input: string; output: string; examples: string; format: "json" | "text" };
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const initialForm = (): Form => ({ source: "", node: "", name: "", description: "", use: "", avoid: "", varies: "", input: pretty({ type: "object", properties: { topic: { type: "string" }, count: { type: "integer", minimum: 1 } }, required: ["topic", "count"], additionalProperties: false }), output: pretty({ type: "object", properties: {}, additionalProperties: true }), examples: pretty([{ input: { topic: "first", count: 1 }, expectedOutput: {} }, { input: { topic: "second", count: 2 }, expectedOutput: {} }]), format: "json" });

export function ToolchainsManager({ api, locale, focusAssetId = null, focusVersionNumber = null, focusAutomationId = null }: { api: ToolchainsApi | null | undefined; locale: string; focusAssetId?: string | null; focusVersionNumber?: number | null; focusAutomationId?: string | null }) {
  const ko = locale === "ko";
  const say = (kr: string, en: string) => ko ? kr : en;
  const [assets, setAssets] = useState<Asset[]>([]);
  const [graphs, setGraphs] = useState<Automation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [lane, setLane] = useState("all");
  const [openId, setOpenId] = useState<string | null>(focusAssetId);
  const [allowEffectfulValidation, setAllowEffectfulValidation] = useState(false);
  const [versionNumber, setVersionNumber] = useState<number | null>(focusVersionNumber);
  const [form, setForm] = useState<Form | null>(null);
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
  const edit = async (asset?: Asset, previous?: Version) => {
    const list = await ipc()?.automations.list() ?? [];
    setGraphs(list.filter((row) => (row.graph?.nodes.length ?? 0) > 0));
    setRevisionOf(asset?.id ?? null);
    if (previous) {
      const contract = previous.contract;
      setForm({ source: previous.provenance.sourceAutomationId, node: previous.implementation.outputBinding.nodeId, name: contract.name, description: contract.description, use: contract.whenToUse.join("\n"), avoid: contract.whenNotToUse.join("\n"), varies: contract.variationStatement, input: pretty(contract.inputSchema), output: pretty(contract.outputSchema), examples: pretty(contract.examples), format: previous.implementation.outputBinding.format });
    } else setForm(initialForm());
  };
  const save = async () => {
    if (!api || !form) return;
    await act(async () => {
      const inputSchema = JSON.parse(form.input); const outputSchema = JSON.parse(form.output); const examples = JSON.parse(form.examples);
      if (!form.source || !form.node || !form.name.trim() || !form.description.trim() || !form.varies.trim()) throw new Error(say("원본·출력 단계·이름·용도·달라지는 입력을 채워 주세요.", "Fill source, output step, name, purpose and varying inputs."));
      if (inputSchema.type !== "object" || !Array.isArray(examples) || examples.length < 2) throw new Error(say("입력은 object 스키마이고, 서로 다른 입력 예시가 2개 이상 필요합니다.", "Input must be an object schema, with at least two distinct input examples."));
      const contract = { name: form.name.trim(), description: form.description.trim(), whenToUse: form.use.split("\n").filter(Boolean), whenNotToUse: form.avoid.split("\n").filter(Boolean), variationStatement: form.varies.trim(), inputSchema, outputSchema, examples };
      const data = { sourceAutomationId: form.source, contract, outputBinding: { nodeId: form.node, format: form.format } };
      const asset = revisionOf ? await api.addVersion({ ...data, id: revisionOf }) : await api.createAsset(data);
      setOpenId(asset.id); setVersionNumber(asset.versions.at(-1)?.version ?? null); setForm(null);
    });
  };
  const visible = assets.filter((asset) => (lane === "all" || asset.status === lane) && `${asset.name} ${asset.versions.at(-1)?.contract.description ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  if (!api) return <p className={styles.notice}>{say("이 화면에서는 툴체인을 불러올 수 없습니다.", "Toolchains are unavailable here.")}</p>;
  return <section className={styles.root} data-toolchains-manager="true">
    <header className={styles.header}><h2>{say("툴체인", "Toolchains")}</h2><input className={styles.search} aria-label={say("툴체인 검색", "Search toolchains")} placeholder={say("이름·용도로 찾기", "Find by name or purpose")} value={query} onChange={(event) => setQuery(event.target.value)} /><button className={styles.refresh} aria-label={say("새로고침", "Refresh")} onClick={() => void load()}><IconRefresh size={16}/></button><button className={styles.create} onClick={() => void edit()}><IconPlus size={14}/>{say("새 툴체인", "New toolchain")}</button></header>
    <p className={styles.intro}>{say("입력·출력 계약과 검증된 버전을 가진 재사용 도구입니다. 그래프 단계에서 ID와 버전을 지정해 부를 수 있습니다.", "Reusable tools with input/output contracts and verified versions. Graph steps call them by asset ID and version.")}</p>
    {focusAutomationId && <p className={styles.notice}>{say("이전 그래프 출처 링크입니다.", "This is a legacy graph source link.")} <button onClick={() => navigate(`/automation/flow?id=${encodeURIComponent(focusAutomationId)}`)}>{say("원본 그래프 열기", "Open source graph")}</button></p>}
    <details className={styles.legacy}><summary>{say("이전 호출형 그래프에서 가져오기", "Import legacy callable graphs")}</summary><p className={styles.intro}>{say("실제 호출 계약이 있는 그래프만 독립 초안으로 복사합니다. 새 입력 예시로 검증해야 호출할 수 있습니다.", "Only graphs with actual callable contracts are copied as independent drafts. Validate new input examples before enabling calls.")}</p><button disabled={busy} onClick={() => void act(async () => { const migration = await api.migrateLegacy(); setResult(migration); })}>{say("초안 가져오기", "Import drafts")}</button>{result != null && !open && <pre className={styles.json} role="status">{pretty(result)}</pre>}</details>
    <div className={styles.lanes}>{["all", "callable", "draft", "withdrawn"].map((key) => <button key={key} data-active={lane === key} onClick={() => setLane(key)}>{({ all: say("전체", "All"), callable: say("호출 가능", "Callable"), draft: say("초안", "Draft"), withdrawn: say("호출 중단", "Withdrawn") })[key]}</button>)}</div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {!loaded ? <p className={styles.notice}>{say("불러오는 중…", "Loading…")}</p> : visible.length === 0 ? <p className={styles.notice}>{say("등록된 툴체인이 없습니다. 그래프에서 재사용할 기능을 추출해 추가하세요.", "No registered toolchains. Extract a reusable capability from a graph to add one.")}</p> : <div className={styles.grid}>{visible.map((asset) => <button key={asset.id} className={styles.tile} data-toolchain-entry={asset.id} onClick={() => { setOpenId(asset.id); setVersionNumber(null); }}><span className={styles.assetIcon}><IconToolchain size={30}/></span><span className={styles.tileName}>{asset.name}</span><span className={styles.pill} title={asset.id}>{asset.id.slice(-8)} · {asset.status} · {asset.stableVersion ? `v${asset.stableVersion}` : say("미검증", "Unverified")}</span></button>)}</div>}
    {open && !version && <p className={styles.error} role="status">{say("요청한 버전을 찾지 못했습니다.", "The requested version could not be found.")} <button onClick={() => setVersionNumber(null)}>{say("현재 버전 보기", "View current version")}</button></p>}
    {open && version && !form && <div className={styles.backdrop} onClick={() => setOpenId(null)}><div className={styles.sheet} role="dialog" aria-modal="true" aria-label={open.name} onClick={(event) => event.stopPropagation()}><button className={styles.close} aria-label={say("닫기", "Close")} onClick={() => setOpenId(null)}><IconClose size={14}/></button><h3>{open.name}</h3>{error && <p className={styles.error} role="alert">{error}</p>}<p className={styles.intro}>{version.contract.description}</p><code>{open.id}</code>{effectful && <label className={styles.effectConsent}><input type="checkbox" checked={allowEffectfulValidation} onChange={(event) => setAllowEffectfulValidation(event.target.checked)}/><span>{say("예시 입력을 검토했습니다. 검증 예시는 실제로 실행되며 파일 작성·업로드·전송을 할 수 있습니다.", "I reviewed the example inputs. Validation executes them and may write files, upload or send.")}</span></label>}<div className={styles.sheetActions}><button disabled={busy} onClick={() => void edit(open.status === "withdrawn" ? undefined : open, version)}>{open.status === "withdrawn" ? say("새 자산으로 추출", "Extract as new asset") : say("새 버전 만들기", "Create new version")}</button><button disabled={busy || open.status === "withdrawn" || (effectful && !allowEffectfulValidation)} onClick={() => void act(() => api.publishVersion({ id: open.id, version: version.version, allowEffectfulValidation }))}>{say("예시 실행·검증 후 호출 등록", "Validate examples & make callable")}</button>{open.status !== "withdrawn" && <button disabled={busy} onClick={() => void act(() => api.withdrawAsset(open.id))}>{say("호출 중단", "Withdraw")}</button>}</div><p className={styles.intro}>{say("호출 중단은 원본 그래프의 예약을 바꾸지 않습니다.", "Withdrawal does not change the source graph schedule.")}</p><label className={styles.field}>{say("버전 (저장된 버전은 변경되지 않습니다)", "Version (saved versions are immutable)")}<select value={version.version} onChange={(event) => setVersionNumber(Number(event.target.value))}>{open.versions.map((item) => <option key={item.version} value={item.version}>v{item.version}{item.version === open.stableVersion ? " · stable" : ""}</option>)}</select></label><p>{version.contract.variationStatement}</p><p className={version.validation.state === "failed" ? styles.error : styles.intro} role="status">{say("검증 상태", "Validation")}: {version.validation.state}{version.validation.problems.length > 0 ? ` · ${version.validation.problems.join("; ")}` : ""}</p><details><summary>{say("입력·출력·예시·검증 보기", "Inputs, outputs, examples & validation")}</summary><pre className={styles.json}>{pretty({ inputSchema: version.contract.inputSchema, outputSchema: version.contract.outputSchema, examples: version.contract.examples, validation: version.validation })}</pre></details><label className={styles.field}>{say("호출 입력 JSON", "Call input JSON")}<textarea value={args} onChange={(event) => setArgs(event.target.value)}/></label><div className={styles.sheetActions}><button disabled={busy || open.status !== "callable" || version.validation.state !== "passed"} onClick={() => void act(async () => { const receipt = await api.runAsset({ id: open.id, version: version.version, input: JSON.parse(args), requestId: crypto.randomUUID() }); setResult(receipt); setRuns(await api.assetRuns(open.id)); })}>{busy ? say("처리 중…", "Working…") : say("이 버전 호출", "Call this version")}</button><button onClick={() => navigate(`/automation/flow?id=${encodeURIComponent(version.provenance.sourceAutomationId)}`)}>{say("추출 원본 보기", "View extraction source")}</button></div>{result != null && <pre className={styles.json} role="status">{pretty(result)}</pre>}<details><summary>{say("호출 이력", "Call history")} ({runs.length})</summary><pre className={styles.json}>{pretty(runs)}</pre></details></div></div>}
    {form && <div className={styles.backdrop} onClick={() => setForm(null)}><div className={`${styles.sheet} ${styles.editor}`} role="dialog" aria-modal="true" aria-label={say("툴체인 계약 작성", "Author toolchain contract")} onClick={(event) => event.stopPropagation()}><button className={styles.close} aria-label={say("닫기", "Close")} onClick={() => setForm(null)}><IconClose size={14}/></button><h3>{revisionOf ? say("새 불변 버전", "New immutable version") : say("재사용 기능 추출", "Extract reusable capability")}</h3><p className={styles.intro}>{say("원본 그래프를 복사해 독립 버전으로 저장합니다. 입력 바인딩은 코드의 vars 또는 {{필드명}}을 사용하세요.", "The source graph is copied into an independent version. Bind input fields through vars in code or {{field}} templates.")}</p><label className={styles.field}>{say("추출할 그래프", "Source graph")}<select value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value, node: "" })}><option value="">—</option>{graphs.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><button className={styles.create} onClick={() => navigate("/automation/new")}>{say("재사용 그래프 작성하기", "Author a reusable graph")}</button><label className={styles.field}>{say("출력 단계", "Output step")}<select value={form.node} onChange={(event) => setForm({ ...form, node: event.target.value })}><option value="">—</option>{graphs.find((row) => row.id === form.source)?.graph?.nodes.filter((node) => node.type !== "trigger").map((node) => <option key={node.id} value={node.id}>{node.label || node.id} · {node.type}</option>)}</select></label><label className={styles.field}>{say("출력 형식", "Output format")}<select value={form.format} onChange={(event) => setForm({ ...form, format: event.target.value as "json" | "text" })}><option value="json">JSON</option><option value="text">Text</option></select></label>{([ ["name", say("이름", "Name")], ["description", say("재사용할 기능·용도", "Reusable capability & purpose")], ["use", say("사용할 때 (한 줄에 하나)", "Use when (one per line)")], ["avoid", say("사용하지 않을 때", "Do not use when")], ["varies", say("실행마다 달라지는 입력·상황", "Inputs and conditions that vary")], ["input", say("입력 JSON Schema (여러 필드 지원)", "Input JSON Schema (multiple fields)")], ["output", say("출력 JSON Schema", "Output JSON Schema")], ["examples", say("서로 다른 입력·예상 출력 예시 2개 이상", "At least 2 distinct inputs & expected outputs")] ] as Array<[keyof Form, string]>).map(([key, label]) => <label className={styles.field} key={key}>{label}<textarea data-contract-field={key} rows={["input", "output", "examples"].includes(key) ? 7 : 2} value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })}/></label>)}<div className={styles.sheetActions}><button disabled={busy} data-primary="true" onClick={() => void save()}>{say("독립 초안 저장", "Save independent draft")}</button><button onClick={() => setForm(null)}>{say("취소", "Cancel")}</button></div>{error && <p className={styles.error} role="alert">{error}</p>}</div></div>}
  </section>;
}
