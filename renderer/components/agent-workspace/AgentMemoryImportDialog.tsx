"use client";

import { useRef, useState } from "react";
import { IconAlertTriangle, IconClose, IconFileUp } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { detailForUser } from "@/lib/invocation-failure";
import type { MemoryImportPreviewUi } from "@shared/types";
import styles from "./AgentWorkspace.module.css";
import { useWorkspaceDialog } from "./use-workspace-dialog";

export function AgentMemoryImportDialog({ preview, agentId, locale, onClose, onImported }: {
  preview: MemoryImportPreviewUi; agentId: string; locale: string; onClose: () => void;
  onImported: (count: number) => Promise<void>;
}) {
  const ko = locale === "ko";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useWorkspaceDialog(true, root, () => { if (!busy) onClose(); });
  async function apply() {
    const api = ipc();
    if (!api?.agentMemory || preview.targetAgentId !== agentId) return;
    setBusy(true); setError("");
    try { const result = await api.agentMemory.importApply(agentId, preview.sourcePath); await onImported(result.imported); onClose(); }
    catch (failure) { setError(detailForUser(failure)); }
    finally { setBusy(false); }
  }
  return <div ref={root} className={styles.modalBackdrop} onClick={() => { if (!busy) onClose(); }}>
    <div className={styles.modal} role="dialog" aria-modal="true" aria-label={ko ? "메모리 가져오기 검토" : "Review memory import"} onClick={(event) => event.stopPropagation()}>
      <div className={styles.paneHeader}><IconFileUp size={15} /><strong>{ko ? "메모리 가져오기" : "Import memory"}</strong><button className={styles.iconButton} disabled={busy} aria-label={ko ? "닫기" : "Close"} onClick={onClose}><IconClose size={14} /></button></div>
      <div className={styles.banner}>{ko ? "기억으로 저장합니다. 지침 승격은 별도 diff를 승인해야 합니다." : "Save as memory. Instruction promotion requires a separate diff approval."}</div>
      {error && <div className={`${styles.banner} ${styles.error}`} role="alert"><IconAlertTriangle size={13} />{error}</div>}
      <div className={styles.meta} style={{ padding: 12 }}><span>{ko ? "신규" : "New"} {preview.summary.newCount}</span><span>{ko ? "중복" : "Duplicates"} {preview.summary.duplicateCount}</span><span>{ko ? "개인정보 제외" : "Redacted"} {preview.summary.redactedCount}</span></div>
      <div className={styles.listRows}>{preview.rows.map((row, index) => <div className={styles.revisionBody} key={`${row.file}:${row.section}:${index}`}><strong style={{ fontSize: 12 }}>{row.section}</strong><div className={styles.meta}>{row.ownerLabel} · {row.scope} · {row.kind} · {row.status}</div><code className={styles.meta}>{row.file}</code></div>)}</div>
      <div className={styles.footerActions}><button className={`${styles.button} ${styles.primary}`} disabled={busy || preview.summary.newCount === 0 || preview.targetAgentId !== agentId} onClick={() => void apply()}>{busy && <span className={styles.loading} />}{ko ? `${preview.summary.newCount}건 가져오기` : `Import ${preview.summary.newCount}`}</button><button className={styles.button} disabled={busy} onClick={onClose}>{ko ? "취소" : "Cancel"}</button></div>
    </div>
  </div>;
}
