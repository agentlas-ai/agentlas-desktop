"use client";

// Sync tab of Manage agents (Agentlas 2.0 F-D9, picture agents-v6-sync): three boxes (this computer / My Cloud / Agent Hub), the changes of the
// chosen direction with their diff, and the history. The boxes only choose what to compare; the change itself still needs the owner's approval
// below the diff (same reviewed-hash flow as before). Only values from the host are drawn: no invented "last saved" time.
import { useEffect, useState } from "react";
import Link from "next/link";
import { IconAlertTriangle, IconCheck, IconCloud, IconDownload, IconFileText, IconLock, IconMonitor, IconRefresh, IconSend, IconSparkles, IconEdit } from "@/components/Icon";
import type { AgentWorkspaceComparison, AgentWorkspaceChange, AgentWorkspaceSnapshot } from "@shared/agent-workspace";
import { AgentWorkspaceDiff } from "./AgentWorkspaceDiff";
import { IconGlobe, IconCloudOff } from "./agent-manage-icons";
import { diffLines } from "./line-diff";
import { shortDateTime } from "./agent-manage-model";
import styles from "./AgentManage.module.css";

/** "~/.agentlas/agents/x" from an absolute path of this computer (both separators); the rest of the path is not shown. */
export function homeRelative(path: string | undefined | null): string {
  if (!path) return "";
  const at = path.search(/[\\/]\.agentlas[\\/]/);
  return at >= 0 ? `~${path.slice(at).replace(/\\/g, "/")}` : path;
}
function lineCounts(change: AgentWorkspaceChange): { add: number; del: number } {
  if (change.operation === "create") return { add: change.afterContent ? change.afterContent.split("\n").length - (change.afterContent.endsWith("\n") ? 1 : 0) : 0, del: 0 };
  let add = 0, del = 0;
  for (const row of diffLines(change.beforeContent, change.afterContent)) { if (row.kind === "add") add++; else if (row.kind === "remove") del++; }
  return { add, del };
}

export function AgentSyncTab({ ko, locale, agentId, parentId, snapshot, comparison, loading, compareFailed, target, direction, onTarget, onDirection, files, skills, memoryTotal, busy, dirty, canApprove, comparisonReason, onRefresh, onApprove, onOpenProposal, onSignIn }: {
  ko: boolean; locale: string; agentId: string; parentId: string; snapshot: AgentWorkspaceSnapshot; comparison: AgentWorkspaceComparison | null; loading: boolean; compareFailed: boolean;
  target: "cloud" | "hub"; direction: "receive" | "send"; onTarget: (value: "cloud" | "hub") => void; onDirection: (value: "receive" | "send") => void;
  files: number; skills: number; memoryTotal: number | null; busy: boolean; dirty: boolean; canApprove: boolean; comparisonReason: string | null;
  onRefresh: () => void; onApprove: () => void; onOpenProposal: (id: string) => void; onSignIn: () => void;
}) {
  const current = comparison && comparison.agentId === agentId && comparison.target === target && comparison.direction === direction ? comparison : null;
  const unread = compareFailed && !current && !loading; // a failed comparison says nothing about the changes: no count, no "nothing changed"
  const changes: AgentWorkspaceChange[] = current ? (direction === "send" ? current.outgoingChanges ?? [] : current.changes) : [];
  const [pathOpen, setPathOpen] = useState<string | null>(null);
  useEffect(() => { setPathOpen(changes[0]?.path ?? null); }, [current?.reviewedHash, changes.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const history = [...snapshot.history].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const cloudLinked = Boolean(snapshot.cloudId);
  const waitingToSave = cloudLinked && target === "cloud" && direction === "send" ? changes.length : null;
  const operationIcon = (operation: string) => operation === "sync" ? <IconCloud size={17} /> : operation === "rollback" ? <IconRefresh size={17} /> : operation === "apply" ? <IconSparkles size={17} /> : <IconEdit size={17} />;
  const operationLabel = (summary: string, operation: string) => summary || (({ sync: ko ? "동기화" : "Synced", apply: ko ? "변경 적용" : "Change applied", external_edit: ko ? "직접 수정" : "Edited outside", rollback: ko ? "복원" : "Rolled back", baseline: ko ? "초기 상태" : "First version" } as Record<string, string>)[operation] ?? "");
  return <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0 }} data-agent-sync-tab>
    <div className={styles.syncTop}>
      <section className={styles.sBox} aria-label={ko ? "이 데스크탑" : "This computer"}>
        <h3><IconMonitor size={18} />{ko ? "이 데스크탑" : "This computer"}</h3>
        <p title={snapshot.rootPath}>{homeRelative(snapshot.rootPath)}</p>
        <p>{ko ? `파일 ${files}개 · 스킬 ${skills}개` : `${files} files · ${skills} skills`}</p>
        <div className={styles.lockRow}>{memoryTotal !== null && <span className={styles.lockChip}><IconLock size={12} />{ko ? `기억 ${memoryTotal}` : `Memory ${memoryTotal}`}</span>}<span className={styles.lockChip}><IconLock size={12} />{ko ? "사진" : "Photo"}</span></div>
      </section>
      <section className={styles.sBox} aria-label="My Cloud">
        <h3><IconCloud size={18} />My Cloud</h3>
        {cloudLinked ? <>
          {waitingToSave !== null && waitingToSave > 0 ? <p className={styles.sWarn}><IconAlertTriangle size={14} />{ko ? `미저장 변경 ${waitingToSave}개` : `${waitingToSave} change${waitingToSave === 1 ? "" : "s"} not saved`}</p>
            : current && target === "cloud" && current.state === "in_sync" ? <p><IconCheck size={13} /> {ko ? "Cloud와 동일" : "Same as Cloud"}</p> : <p>{ko ? "Cloud에 저장됨" : "Saved to Cloud"}</p>}
          <div className={styles.sBtns}>
            <button type="button" className={styles.btn} disabled={busy} onClick={() => { onTarget("cloud"); onDirection("receive"); }}><IconDownload size={14} />{ko ? "수신" : "Receive"}</button>
            <button type="button" className={styles.btn} disabled={busy} onClick={() => { onTarget("cloud"); onDirection("send"); }}>{ko ? (waitingToSave ? `저장 ${waitingToSave}` : "저장") : (waitingToSave ? `Save ${waitingToSave}` : "Save")}</button></div>
        </> : <><p className={styles.sWarn} style={{ color: "var(--muted-deep)" }}><IconCloudOff size={14} />{ko ? "Cloud에 아직 저장되지 않았어요" : "Not saved to Cloud yet"}</p>
          <div className={styles.sBtns}><Link className={styles.btn} href={`/cloud?agent=${encodeURIComponent(parentId || agentId)}`}>{ko ? "Cloud에 처음 저장…" : "First Cloud save…"}</Link></div></>}
      </section>
      <section className={styles.sBox} aria-label="Agent Hub">
        <h3><IconGlobe size={18} />Agent Hub</h3>
        <p>{snapshot.hubRef ? (ko ? "게시됨" : "Published") : (ko ? "미게시" : "Not published")}</p>
        <div className={styles.sBtns}>{cloudLinked ? <button type="button" className={styles.btn} disabled={busy} onClick={() => { onTarget("hub"); onDirection("send"); }}><IconSend size={14} />{ko ? "게시…" : "Publish…"}</button>
          : <span style={{ fontSize: 12.5, color: "var(--muted-deep)" }}>{ko ? "Cloud에 먼저 저장하면 게시할 수 있어요" : "Save to Cloud first to publish"}</span>}</div>
        <Link href="/library/agents?view=published" style={{ fontSize: 12.5, color: "var(--muted-deep)", marginTop: 6 }}>{ko ? "내 게시 항목" : "My published assets"}</Link>
      </section>
    </div>
    {current?.reason && <div className={styles.reasonLine} role="status"><IconAlertTriangle size={14} /><span style={{ flex: 1 }}>{comparisonReason}</span>
      {current.reason === "sign_in_required" && <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={onSignIn}>{ko ? "로그인" : "Sign in"}</button>}
      {(current.reason === "sync_outcome_pending" || current.reason === "remote_unavailable") && <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={loading || busy} onClick={onRefresh}>{ko ? "재확인" : "Check again"}</button>}
      {current.reason === "cloud_publish_base_required" && <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => { onTarget("cloud"); onDirection("send"); }}>{ko ? "Cloud 저장 검토" : "Review Cloud save"}</button>}
    </div>}
    <div className={styles.syncBody}>
      <div className={styles.sChanges}>
        <div className={styles.secHead}>{direction === "send" ? (target === "hub" ? (ko ? "미게시 변경" : "To publish") : (ko ? "미저장 변경" : "Changes")) : (ko ? "수신할 변경" : "To receive")}{!unread && <small>{changes.length}</small>}
          <button type="button" className={styles.ib} style={{ width: 24, height: 24 }} aria-label={ko ? "원격 상태 재조회" : "Refresh remote state"} disabled={loading || busy} onClick={onRefresh}><IconRefresh size={13} /></button></div>
        {changes.map((change) => { const { add, del } = lineCounts(change); return <button type="button" key={change.path} className={`${styles.chRow} ${pathOpen === change.path ? styles.chOn : ""}`} onClick={() => setPathOpen(change.path)}>
          <span style={{ fontWeight: 700, color: change.operation === "create" ? "var(--ok)" : change.operation === "delete" ? "var(--danger)" : "var(--warn)" }}>{change.operation === "create" ? "+" : change.operation === "delete" ? "−" : "M"}</span><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{change.path}</span><small style={{ color: "var(--muted-deep)" }}>{change.operation === "create" ? `+${add}` : `+${add} −${del}`}</small></button>; })}
        {unread && <div className={styles.readFailed} role="alert"><IconAlertTriangle size={14} /><span>{ko ? "변경 내용을 불러오지 못했어요." : "Couldn't read the changes."}</span><button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={onRefresh}>{ko ? "재시도" : "Retry"}</button></div>}
        {!unread && changes.length === 0 && <div className={styles.empty} style={{ padding: "26px 20px" }}>{loading ? (ko ? "비교하는 중…" : "Comparing…") : (ko ? "변경 내용이 없어요" : "Nothing changed")}</div>}
        <div className={styles.secHead}>{ko ? "기록" : "History"}<small>{history.length}</small></div>
        {history.map((revision) => <div className={styles.hRow} key={revision.id}>{operationIcon(revision.operation)}<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{operationLabel(revision.summary, revision.operation)}</span><small>{shortDateTime(revision.createdAt)}</small></div>)}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {changes.length > 0 ? <AgentWorkspaceDiff fit files={changes} locale={locale} activePath={pathOpen} onPathChange={setPathOpen} beforeLabel={direction === "send" ? `${target === "hub" ? "Hub" : "Cloud"} · ${ko ? "지금" : "Current"}` : `${ko ? "이 데스크탑" : "Local"} · ${ko ? "지금" : "Current"}`} afterLabel={direction === "send" ? (ko ? "전송 후" : "After transfer") : (ko ? "적용 후" : "After local apply")} />
          : <div className={styles.empty}><IconFileText size={22} /></div>}
        <div className={styles.noticeLine} style={{ padding: "12px 22px", borderTop: "1px solid var(--paper-edge)", justifyContent: "flex-end", gap: 10 }}>
          <span style={{ flex: 1 }}>{target === "hub" && direction === "send" ? (ko ? "검토한 공개용 파일만 게시해요." : "Only the reviewed public files are published.") : (ko ? "검토한 파일만 동기화해요." : "Only the reviewed files are synced.")}</span>
          {current?.proposalId && <button type="button" className={styles.btn} onClick={() => onOpenProposal(current.proposalId!)}>{ko ? "변경안 검토" : "Review proposal"}</button>}
          <button type="button" className={`${styles.btn} ${styles.btnPri}`} disabled={!canApprove || busy || dirty || (direction === "receive" && !snapshot.writable) || snapshot.activation === "recovery_required"} onClick={onApprove}>
            {direction === "send" ? (target === "hub" ? (ko ? "승인하고 Hub에 게시" : "Approve · Publish to Hub") : (ko ? "승인하고 Cloud에 저장" : "Approve · Save to Cloud")) : (ko ? "승인하고 이 데스크탑에 적용" : "Approve · Apply locally")}</button>
        </div>
        {dirty && <div className={styles.noticeLine} style={{ paddingBottom: 10 }}>{ko ? "열린 파일 초안을 먼저 변경안으로 저장해 주세요." : "Save the open file draft as a proposal first."}</div>}
      </div>
    </div>
  </div>;
}
