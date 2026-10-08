"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconClose, IconEdit, IconShield, IconTrash } from "@/components/Icon";
import { runtimeEngineLabel } from "@/components/dashboard/RuntimeModelPicker";
import { ipc } from "@/lib/ipc";
import { detailForUser } from "@/lib/invocation-failure";
import { effortOptions } from "@/lib/effort-label";
import { runtimeIdentityKey, runtimeSupportsAgentOverride, selectionForRuntime } from "@shared/runtime-selection";
import { runtimeUsesEngineModelSetting } from "@shared/models";
import type { AgentRuntimeOverride, AgentRuntimeOverrideScope, InstalledAgent, InstalledAgentExactBinding, InstalledFirm, ResolvedOrg, RuntimeStatus } from "@shared/types";
import type { AgentWorkspaceSnapshot } from "@shared/agent-workspace";
import { useWorkspaceDialog } from "./use-workspace-dialog";
import styles from "./AgentWorkspace.module.css";

function canAssignRuntime(runtime: RuntimeStatus): boolean {
  return runtime.kind !== "ollama" && runtimeSupportsAgentOverride(runtime);
}

export function AgentWorkspaceInspector({ agent, name, locale, snapshot, firm, org, binding, runtimes, overrides, onClose, onRename, onRemove, onOverridesChange, onNotice }: {
  agent: InstalledAgent; name: string; locale: string; snapshot: AgentWorkspaceSnapshot | null;
  firm?: InstalledFirm | null; org?: ResolvedOrg | null; binding?: InstalledAgentExactBinding | null;
  runtimes: RuntimeStatus[]; overrides: AgentRuntimeOverride[];
  onClose: () => void; onRename: (name: string) => Promise<void>; onRemove: () => Promise<void>;
  onOverridesChange: (overrides: AgentRuntimeOverride[]) => void; onNotice: (message: string) => void;
}) {
  const ko = locale === "ko";
  const [alias, setAlias] = useState(agent.localDisplayName ?? "");
  const [scopeKey, setScopeKey] = useState(`agent:${agent.id}`);
  const [runtimeKey, setRuntimeKey] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [overlay, setOverlay] = useState(false);
  const inspectorRoot = useRef<HTMLElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1439px)");
    const update = () => setOverlay(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useWorkspaceDialog(overlay, inspectorRoot, onClose);
  const targets = useMemo(() => {
    const result: Array<{ key: string; scope: AgentRuntimeOverrideScope; targetId: string; label: string }> = [{ key: `agent:${agent.id}`, scope: "agent", targetId: agent.id, label: name }];
    const division = org?.divisions.find((item) => item.agentId === agent.id || item.specialists.some((specialist) => specialist.agentId === agent.id));
    if (firm && division) result.push({ key: `division:${firm.id}:${division.id}`, scope: "division", targetId: `${firm.id}:${division.id}`, label: division.name });
    if (firm) result.push({ key: `firm:${firm.id}`, scope: "firm", targetId: firm.id, label: ko ? `${firm.name} 전체` : `${firm.nameEn || firm.name} team` });
    return result;
  }, [agent.id, name, firm, org, ko]);
  const target = targets.find((item) => item.key === scopeKey) ?? targets[0];
  const override = overrides.find((item) => item.scope === target.scope && item.targetId === target.targetId);
  const options = useMemo(() => runtimes.filter((item) => canAssignRuntime(item) || (override?.selection.kind === item.kind && (!override.selection.backend || override.selection.backend === item.backend))), [runtimes, override]);
  const runtime = options.find((item) => runtimeIdentityKey(item) === runtimeKey) ?? null;
  const efforts = effortOptions(runtime?.allocationModelProfiles?.[model]?.efforts?.map((id) => ({ id })) ?? runtime?.efforts, locale);
  useEffect(() => { setAlias(agent.localDisplayName ?? ""); }, [agent.localDisplayName]);
  useEffect(() => {
    const matching = override ? options.find((item) => item.kind === override.selection.kind && (!override.selection.backend || item.backend === override.selection.backend)) : undefined;
    const selected = matching ?? options.find((item) => item.active) ?? options[0];
    setRuntimeKey(selected ? runtimeIdentityKey(selected) : "");
    setModel(override?.selection.model ?? selected?.model ?? "");
    setEffort(override?.selection.effort ?? selected?.effort ?? "");
  }, [override, options]);
  useEffect(() => {
    let cancelled = false;
    if (!runtime || !canAssignRuntime(runtime)) { setModels([]); return; }
    const api = ipc();
    void api?.runtime.listModels({ kind: runtime.kind, backend: runtime.backend, availableModels: runtime.availableModels }).then((items) => {
      if (cancelled) return;
      setModels(items);
      if (!runtimeUsesEngineModelSetting(runtime.kind)) setModel((current) => current || runtime.model || items[0]?.id || "");
    }).catch((failure) => { if (!cancelled) { setModels([]); setError(detailForUser(failure)); } });
    return () => { cancelled = true; };
  }, [runtime]);
  async function action(task: () => Promise<void>) {
    setBusy(true); setError("");
    try { await task(); } catch (failure) { setError(detailForUser(failure)); } finally { setBusy(false); }
  }
  async function saveRuntime() {
    const api = ipc();
    if (!api || !runtime || !canAssignRuntime(runtime)) return;
    if (!runtimeUsesEngineModelSetting(runtime.kind) && !model) throw new Error(ko ? "모델을 선택하세요." : "Choose a model.");
    await api.agentRuntime.set({ scope: target.scope, targetId: target.targetId, label: target.label,
      selection: selectionForRuntime(runtime, { model: model || null, effort: efforts.some((item) => item.id === effort) ? effort : null }) });
    onOverridesChange(await api.agentRuntime.list());
    onNotice(ko ? "다음 실행의 런타임을 저장했습니다." : "Runtime saved for the next run.");
  }
  return <aside ref={inspectorRoot} className={styles.inspector} role={overlay ? "dialog" : undefined} aria-modal={overlay || undefined} aria-label={ko ? "에이전트 속성" : "Agent inspector"}>
    <div className={styles.paneHeader}><IconShield size={14} /><strong>{ko ? "속성" : "Inspector"}</strong><button className={styles.iconButton} onClick={onClose} title={ko ? "속성 닫기" : "Close inspector"} aria-label={ko ? "속성 닫기" : "Close inspector"}><IconClose size={15} /></button></div>
    {error && <div className={`${styles.banner} ${styles.error}`} role="alert">{error}</div>}
    <div className={styles.inspectorBody}>
      <h3>{ko ? "표시 이름" : "Display name"}</h3>
      <label className={styles.field}><input value={alias} maxLength={160} placeholder={name} aria-label={ko ? "로컬 표시 이름" : "Local display name"} onChange={(event) => setAlias(event.target.value)} /></label>
      <button className={styles.button} disabled={busy || alias === (agent.localDisplayName ?? "")} onClick={() => void action(() => onRename(alias))}><IconEdit size={12} />{ko ? "저장" : "Save"}</button>
      <h3>{ko ? "실행 환경" : "Runtime"}</h3>
      {options.length > 0 ? <>
        <label className={styles.field}>{ko ? "적용 범위" : "Scope"}<select value={target.key} onChange={(event) => setScopeKey(event.target.value)}>{targets.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select></label>
        <label className={styles.field}>{ko ? "런타임" : "Runtime"}<select value={runtimeKey} onChange={(event) => { setRuntimeKey(event.target.value); setModel(""); setEffort(""); }} disabled={busy}>{options.map((item) => <option key={runtimeIdentityKey(item)} value={runtimeIdentityKey(item)} disabled={!canAssignRuntime(item)}>{runtimeEngineLabel(item)}</option>)}</select></label>
        {runtime && !canAssignRuntime(runtime) && <div className={styles.banner}>{ko ? "현재 런타임 지정은 지원되지 않습니다. 다시 선택하거나 지정 해제하세요." : "This runtime override is unsupported. Choose another runtime or reset it."}</div>}
        <label className={styles.field}>{ko ? "모델" : "Model"}<select value={model} onChange={(event) => { setModel(event.target.value); setEffort(""); }} disabled={busy}>
          <option value="">{runtime && runtimeUsesEngineModelSetting(runtime.kind) ? (ko ? "엔진 설정" : "Engine default") : (ko ? "모델 선택" : "Select model")}</option>
          {model && !models.some((item) => item.id === model) && <option value={model}>{model}</option>}
          {models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>
        {efforts.length > 1 && <label className={styles.field}>{ko ? "추론 수준" : "Reasoning"}<select value={effort} onChange={(event) => setEffort(event.target.value)} disabled={busy}><option value="">{ko ? "기본값" : "Default"}</option>{efforts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
        <div className={styles.inspectorActions}><button className={`${styles.button} ${styles.primary}`} disabled={busy || !runtime || !canAssignRuntime(runtime) || (!runtimeUsesEngineModelSetting(runtime.kind) && !model)} onClick={() => void action(saveRuntime)}>{ko ? "다음 실행에 적용" : "Use next run"}</button>
          {override && <button className={styles.button} disabled={busy} onClick={() => void action(async () => { const api = ipc(); if (!api) return; await api.agentRuntime.remove(target.scope, target.targetId); onOverridesChange(await api.agentRuntime.list()); })}>{ko ? "지정 해제" : "Reset"}</button>}</div>
      </> : <span className={styles.meta}>{ko ? "사용 가능한 런타임 없음" : "No available runtime"}</span>}
      <h3>{ko ? "권한 · 식별자" : "Permissions · Identity"}</h3>
      <dl className={styles.definition}>
        <dt>{ko ? "파일 권한" : "Files"}</dt><dd>{snapshot ? (snapshot.writable ? (ko ? "변경 검토·승인" : "Review and approve") : (ko ? "읽기 전용" : "Read only")) : (ko ? "미확인" : "Unknown")}</dd>
        <dt>{ko ? "설치 ID" : "Install"}</dt><dd><code>{agent.id}</code></dd>
        <dt>{ko ? "정의 ID" : "Definition"}</dt><dd><code>{binding?.agentDefinitionId ?? "—"}</code></dd>
        <dt>{ko ? "릴리스 ID" : "Release"}</dt><dd><code>{binding?.agentReleaseId ?? "—"}</code></dd>
        <dt>{ko ? "리비전" : "Revision"}</dt><dd><code>{snapshot?.currentRevisionId ?? "—"}</code></dd>
        <dt>{ko ? "트리 해시" : "Tree"}</dt><dd><code>{snapshot?.treeDigest ?? "—"}</code></dd>
        <dt>{ko ? "위치" : "Root"}</dt><dd>{snapshot?.rootPath ?? agent.localPath ?? "—"}</dd>
        <dt>{ko ? "원본" : "Origin"}</dt><dd>{agent.assetSource ?? "local-import"}</dd>
        <dt>MCP</dt><dd>{agent.mcpServers.length ? agent.mcpServers.join(", ") : "—"}</dd>
        <dt>{ko ? "신뢰 등급" : "Trust"}</dt><dd>{agent.trustGrade === "unknown" ? (ko ? "미확인" : "Unknown") : agent.trustGrade}</dd>
      </dl>
      <h3>{ko ? "관리" : "Manage"}</h3>
      <button className={`${styles.button} ${styles.danger}`} disabled={busy} onClick={() => void action(onRemove)}><IconTrash size={12} />{ko ? "에이전트 제거…" : "Remove agent…"}</button>
    </div>
  </aside>;
}
