"use client";

import { useState } from "react";
import { IconAlertTriangle, IconBrain, IconFileUp, IconLayers, IconShield } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { agentWorkspaceFailure } from "@/lib/agent-workspace-error";
import type { MemoryImportPreviewUi } from "@shared/types";
import styles from "./AgentWorkspace.module.css";
import { PopupAction, PopupDetails, PopupFacts, PopupFrame } from "@/components/Popup";

export function AgentMemoryImportDialog({ preview, agentId, locale, onClose, onImported }: {
  preview: MemoryImportPreviewUi; agentId: string; locale: string; onClose: () => void;
  onImported: (count: number, remainingFiles: number) => Promise<void>;
}) {
  const ko = locale === "ko";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function apply() {
    const api = ipc();
    if (busy || !api?.agentMemory || preview.targetAgentId !== agentId || preview.summary.newCount === 0) return;
    setBusy(true); setError("");
    try { const result = await api.agentMemory.importApply(agentId, preview.sourcePath); await onImported(result.imported, result.truncatedFiles ?? 0); onClose(); }
    catch (failure) { setError(agentWorkspaceFailure(failure, ko)); }
    finally { setBusy(false); }
  }
  return <PopupFrame title={ko ? "메모리 가져오기" : "Import memory"} icon={<IconFileUp size={20} />} closeLabel={ko ? "닫기" : "Close"} onClose={onClose} busy={busy}
    footer={<><PopupAction disabled={busy} onClick={onClose}>{ko ? "취소" : "Cancel"}</PopupAction><PopupAction primary icon={busy ? <span className={styles.loading} /> : <IconBrain size={16} />} disabled={busy || preview.summary.newCount === 0 || preview.targetAgentId !== agentId} onClick={() => void apply()}>{ko ? `${preview.summary.newCount}건 가져오기` : `Import ${preview.summary.newCount}`}</PopupAction></>}>
    {error && <div className={`${styles.banner} ${styles.error}`} role="alert"><IconAlertTriangle size={15} />{error}</div>}
    <div className={styles.importFacts}><PopupFacts items={[{label:ko ? "신규" : "New", value:preview.summary.newCount, icon:<IconBrain size={17} />},{label:ko ? "중복" : "Duplicates",value:preview.summary.duplicateCount, icon:<IconLayers size={17} />},{label:ko ? "개인정보 제외" : "Redacted",value:preview.summary.redactedCount,icon:<IconShield size={17} />},...((preview.summary.forgottenCount ?? 0) > 0 ? [{label:ko ? "잊은 항목" : "Forgotten",value:preview.summary.forgottenCount,icon:<IconShield size={17} />}] : [])]}/></div>
    <p className={styles.popupNote}><IconShield size={16} />{ko ? "메모리로 저장 · 지침 승격은 별도 diff 승인 필요" : "Save as memory · Instruction promotion needs separate diff approval"}</p>
    {(preview.summary.truncatedFiles ?? 0) > 0 && <p className={styles.popupNote}><IconAlertTriangle size={16} />{ko ? `파일 ${preview.summary.truncatedFiles}개는 이번에 포함되지 않았습니다. 가져온 뒤 다시 열면 이어서 가져옵니다.` : `${preview.summary.truncatedFiles} more files are not in this pass. Open the import again afterwards to continue with them.`}</p>}
    <div className={styles.importRows}>{preview.rows.map((row, index) => <div className={styles.importRow} key={`${row.file}:${row.section}:${index}`}><IconFileUp size={17} /><div><strong>{row.section}</strong><small>{row.ownerLabel} · {row.scope} · {row.kind} · {row.status}</small><PopupDetails label={ko ? "원본 파일" : "Source file"}><code>{row.file}</code></PopupDetails></div></div>)}</div>
    <PopupDetails label={ko ? "가져오기 위치" : "Import source"}><code>{preview.sourcePath}</code></PopupDetails>
  </PopupFrame>;
}
