"use client";

import { useEffect, useRef, useState } from "react";
import { IconClose, IconEdit, IconShield, IconTrash } from "@/components/Icon";
import { agentWorkspaceFailure } from "@/lib/agent-workspace-error";
import type { InstalledAgent, InstalledAgentExactBinding } from "@shared/types";
import type { AgentWorkspaceSnapshot } from "@shared/agent-workspace";
import { useWorkspaceDialog } from "./use-workspace-dialog";
import styles from "./AgentWorkspace.module.css";
import { AgentAppearanceEditor } from "./AgentAppearancePicker";

export function AgentWorkspaceInspector({ agent, name, locale, snapshot, binding, onClose, onRename, onRemove }: {
  agent: InstalledAgent; name: string; locale: string; snapshot: AgentWorkspaceSnapshot | null; binding?: InstalledAgentExactBinding | null;
  onClose: () => void; onRename: (name: string) => Promise<void>; onRemove: () => Promise<void>;
}) {
  const ko = locale === "ko";
  const [alias, setAlias] = useState(agent.localDisplayName ?? "");
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
  useEffect(() => { setAlias(agent.localDisplayName ?? ""); }, [agent.localDisplayName]);
  async function action(task: () => Promise<void>) {
    setBusy(true); setError("");
    try { await task(); } catch (failure) { setError(agentWorkspaceFailure(failure, ko)); } finally { setBusy(false); }
  }
  return <aside ref={inspectorRoot} className={styles.inspector} role={overlay ? "dialog" : undefined} aria-modal={overlay || undefined} aria-label={ko ? "에이전트 속성" : "Agent inspector"}>
    <div className={styles.paneHeader}><IconShield size={14} /><strong>{ko ? "속성" : "Inspector"}</strong><button className={styles.iconButton} onClick={onClose} title={ko ? "속성 닫기" : "Close inspector"} aria-label={ko ? "속성 닫기" : "Close inspector"}><IconClose size={15} /></button></div>
    {error && <div className={`${styles.banner} ${styles.error}`} role="alert">{error}</div>}
    <div className={styles.inspectorBody}>
      <AgentAppearanceEditor agentId={agent.id} ko={ko} />
      <h3>{ko ? "표시 이름" : "Display name"}</h3>
      <label className={styles.field}><input value={alias} maxLength={160} placeholder={name} aria-label={ko ? "로컬 표시 이름" : "Local display name"} onChange={(event) => setAlias(event.target.value)} /></label>
      <button className={styles.button} disabled={busy || alias === (agent.localDisplayName ?? "")} onClick={() => void action(() => onRename(alias))}><IconEdit size={12} />{ko ? "저장" : "Save"}</button>
      <p className={styles.meta}>{ko ? "모델은 [모델] 탭에서 정해요." : "Runtime and model are set on the Model tab."}</p>
      <h3>{ko ? "권한 · 식별자" : "Permissions · Identity"}</h3>
      <dl className={styles.definition}>
        <dt>{ko ? "파일 권한" : "Files"}</dt><dd>{snapshot ? (snapshot.writable ? (ko ? "변경 검토·승인" : "Review and approve") : (ko ? "읽기 전용" : "Read only")) : (ko ? "알 수 없음" : "Unknown")}</dd>
        <dt>{ko ? "위치" : "Root"}</dt><dd>{snapshot?.rootPath ?? agent.localPath ?? "—"}</dd>
        <dt>{ko ? "원본" : "Origin"}</dt><dd>{agent.assetSource ?? "local-import"}</dd>
        <dt>MCP</dt><dd>{agent.mcpServers.length ? agent.mcpServers.join(", ") : "—"}</dd>
        <dt>{ko ? "신뢰 등급" : "Trust"}</dt><dd>{agent.trustGrade === "unknown" ? (ko ? "알 수 없음" : "Unknown") : agent.trustGrade}</dd>
      </dl>
      <h3>{ko ? "관리" : "Manage"}</h3>
      <button className={`${styles.button} ${styles.danger}`} disabled={busy} onClick={() => void action(onRemove)}><IconTrash size={12} />{ko ? "에이전트 제거…" : "Remove agent…"}</button>
    </div>
  </aside>;
}
