"use client";

import { IconAlertTriangle, IconCheck, IconClose } from "@/components/Icon";
import type { AgentWorkspaceRecovery } from "@shared/agent-workspace";
import { AgentWorkspaceDiff } from "./AgentWorkspaceDiff";
import styles from "./AgentWorkspace.module.css";

export function AgentWorkspaceRecoveryReview({ recovery, locale, busy, dirty, onClose, onRetain }: {
  recovery: AgentWorkspaceRecovery; locale: string; busy: boolean; dirty: boolean;
  onClose: () => void; onRetain: () => void;
}) {
  const ko = locale === "ko";
  return <div className={styles.reviewPane} data-testid="agent-workspace-recovery">
    <div className={styles.reviewSummary}><IconAlertTriangle size={16} /><div><strong>{ko ? "중단된 변경 · 현재 파일 확인" : "Interrupted change · Review current files"}</strong><div className={styles.meta}><span>{recovery.changes.length}{ko ? "개 파일" : " files"}</span><code title={recovery.currentTreeDigest}>{recovery.currentTreeDigest.slice(0, 12)}</code></div></div><button className={styles.iconButton} aria-label={ko ? "복구 검토 닫기" : "Close recovery review"} onClick={onClose}><IconClose size={14} /></button></div>
    <div className={styles.banner}>{ko ? "승인하면 지금 관찰한 파일을 유지하고 실행 잠금을 해제합니다." : "Approval retains the files shown here and releases the execution lock."}</div>
    <AgentWorkspaceDiff files={recovery.changes} locale={locale} beforeLabel={ko ? "중단 전 파일" : "Files before interruption"} afterLabel={ko ? "현재 관찰한 파일" : "Currently observed files"} />
    <div className={styles.reviewFooter}><span>{dirty ? (ko ? "열린 파일 초안을 먼저 저장하거나 버리세요." : "Save or discard the open file draft first.") : (ko ? "검토한 파일 해시에 승인 결합" : "Approval is bound to the reviewed file hash")}</span><button className={`${styles.button} ${styles.primary}`} disabled={busy || dirty || !recovery.reviewToken} onClick={onRetain}>{busy ? <span className={styles.loading} /> : <IconCheck size={13} />}{ko ? "현재 파일 유지·잠금 해제" : "Retain files · Unlock"}</button></div>
  </div>;
}
