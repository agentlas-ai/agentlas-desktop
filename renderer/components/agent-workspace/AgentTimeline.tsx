"use client";

// Timeline tab of Manage agents (Agentlas 2.0 F-D8, picture agents-v6-timeline, desktop-states-pieces 1).
// Three kinds of post: something waiting for the owner (a learned skill / change to approve), what the agent remembers (new memory lines
// grouped by day and project) and what changed in the agent (a skill added, the rules changed). Every value comes from the workspace snapshot,
// the memory list and a read of the reviewed change; a post whose values are missing is not drawn.
import { useEffect, useMemo, useState } from "react";
import { IconAlertTriangle, IconBrain, IconCheck, IconClose, IconCloud, IconExternalLink, IconFileText, IconLock, IconSparkles, IconTrash } from "@/components/Icon";
import { IconPin, IconTrendUp } from "./agent-manage-icons";
import type { AgentWorkspaceDiff, AgentWorkspaceProposal, AgentWorkspaceSnapshot } from "@shared/agent-workspace";
import type { DesktopMemoryListEntry } from "@shared/desktop-memory-inspector";
import { plainMemoryTitle } from "@/lib/agent-memory-explain";
import { AgentFace } from "./AgentProfileHead";
import { createdSkillName, evolvedRevisions, memoryGroups, miniDiff, waitingProposals, whenLabel, type EvolvedItem } from "./agent-manage-model";
import styles from "./AgentManage.module.css";

const MAX_MEMORY_POSTS = 3, MAX_EVOLVED_POSTS = 6, MAX_DIFF_READS = 4, MAX_LINES_PER_POST = 6;

export function HiddenItemsLine({ promotion, ko }: { promotion: NonNullable<AgentWorkspaceProposal["skillPromotion"]>; ko: boolean }) {
  const [open, setOpen] = useState(false);
  const kinds = Object.entries(promotion.redactedKinds ?? {}).filter(([, count]) => count > 0);
  if (!promotion.redactedCount) return null;
  const kindWord = (kind: string, count: number) => {
    const ko_: Record<string, string> = { email: "메일 주소", path: "경로", name: "이름", amount: "금액", number: "번호", key: "키" };
    const en: Record<string, [string, string]> = { email: ["email", "emails"], path: ["path", "paths"], name: ["name", "names"], amount: ["amount", "amounts"], number: ["number", "numbers"], key: ["key", "keys"] };
    return ko ? `${ko_[kind] ?? kind} ${count}` : `${count} ${(en[kind] ?? [kind, kind])[count === 1 ? 0 : 1]}`;
  };
  return <>
    <div className={styles.hidden}><IconLock size={16} /><span><b>{ko ? `${promotion.redactedCount}개 비공개` : `${promotion.redactedCount} hidden`}</b>{kinds.length > 0 && ` · ${kinds.map(([kind, count]) => kindWord(kind, count)).join(" · ")}`}</span>
      {kinds.length > 0 && <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? (ko ? "접기" : "Hide") : (ko ? "보기" : "Show")}</button>}</div>
    {open && <ul className={styles.hiddenKinds}>{kinds.map(([kind, count]) => <li key={kind}>{kindWord(kind, count)}</li>)}</ul>}
  </>;
}

function Post({ agentId, name, seedName, slug, at, tag, tagIcon, flag, children }: { agentId: string; name: string; seedName?: string; slug: string; at: string; tag: string; tagIcon: JSX.Element; flag?: string; children: React.ReactNode }) {
  return <article className={styles.tItem}>
    <div className={styles.tFace} style={flag ? { paddingTop: 30 } : undefined}><AgentFace agentId={agentId} name={name} seedName={seedName} size={32} /></div>
    <div style={{ minWidth: 0 }}>
      {flag && <div className={styles.tFlag}><IconPin size={13} />{flag}</div>}
      <div className={styles.tHead}><b>{name}</b><span>@{slug} · {at}</span><span className={styles.tag}>{tagIcon}{tag}</span></div>
      {children}
    </div>
  </article>;
}

export function AgentTimeline({ agentId, name, seedName, slug, ko, snapshot, memory, memoryFailed, onRetryMemory, busy, canWrite, readDiff, onAddSkill, onDismiss, onReview, onOpenMemory, onForget, onUndo }: {
  agentId: string; name: string; seedName?: string; slug: string; ko: boolean; snapshot: AgentWorkspaceSnapshot | null; memory: DesktopMemoryListEntry[] | null; memoryFailed: boolean; onRetryMemory: () => void; busy: boolean; canWrite: boolean;
  readDiff: (proposalId: string) => Promise<AgentWorkspaceDiff>;
  onAddSkill: (proposal: AgentWorkspaceProposal) => void; onDismiss: (proposal: AgentWorkspaceProposal) => void; onReview: (proposal: AgentWorkspaceProposal) => void;
  onOpenMemory: () => void; onForget: (entries: DesktopMemoryListEntry[]) => void; onUndo: (parentRevisionId: string) => void;
}) {
  const now = Date.now();
  const waiting = useMemo(() => waitingProposals(snapshot), [snapshot]);
  const evolved = useMemo(() => evolvedRevisions(snapshot, MAX_EVOLVED_POSTS), [snapshot]);
  const groups = useMemo(() => memoryGroups(memory ?? [], MAX_MEMORY_POSTS), [memory]);
  // What each change of the newest posts was: read once per post (a reviewed change), not on a timer.
  const [diffs, setDiffs] = useState<Record<string, AgentWorkspaceDiff | null>>({});
  useEffect(() => {
    let alive = true;
    for (const item of evolved.slice(0, MAX_DIFF_READS)) {
      const proposalId = item.revision.proposalId;
      if (!proposalId || diffs[proposalId] !== undefined) continue;
      void readDiff(proposalId).then((diff) => { if (alive) setDiffs((current) => ({ ...current, [proposalId]: diff })); }).catch(() => { if (alive) setDiffs((current) => ({ ...current, [proposalId]: null })); });
    }
    return () => { alive = false; };
  }, [evolved, readDiff]); // eslint-disable-line react-hooks/exhaustive-deps
  const learnedRuns = (proposal: AgentWorkspaceProposal): number | null => {
    const runs = (snapshot?.memoryCandidates ?? []).filter((candidate) => proposal.memoryEntryIds.includes(candidate.id)).map((candidate) => candidate.promotion?.runs ?? 0);
    const best = runs.length ? Math.max(...runs) : 0;
    return best > 0 ? best : null;
  };
  const evolvedPost = (item: EvolvedItem) => {
    const proposalId = item.revision.proposalId;
    const diff = proposalId ? diffs[proposalId] : undefined;
    const skill = diff ? createdSkillName(diff.changes) : null;
    const parent = item.revision.parentRevisionIds[0];
    if (skill && diff) {
      const file = diff.changes.find((change) => change.path.startsWith(`skills/${skill}/`))?.path ?? `skills/${skill}`;
      return <Post seedName={seedName} key={item.id} agentId={agentId} name={name} slug={slug} at={whenLabel(item.at, ko, now)} tag={ko ? "진화" : "Evolved"} tagIcon={<IconTrendUp size={14} />}>
        <p className={styles.tText}>{ko ? "새 스킬을 추가했어요: " : "New skill added: "}<b>{skill}</b>.</p>
        <div className={styles.fileRow}><span className={styles.chip}><IconFileText size={13} />{file}</span>
          {snapshot?.cloudId && <span className={styles.chip}><IconCloud size={13} />{ko ? "Cloud에 있음" : "In Cloud"}</span>}
          {canWrite && parent && <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => onUndo(parent)}>{ko ? "추가 취소" : "Undo"}</button>}</div>
      </Post>;
    }
    const change = diff?.changes.find((candidate) => candidate.operation === "modify");
    const rows = change ? miniDiff(change, MAX_LINES_PER_POST) : [];
    // "My rules changed" only when the change really modifies a file; otherwise the host's own one-line summary says what happened.
    const sentence = change ? (ko ? `${change.path}의 규칙이 변경됐어요.` : `My rules changed in ${change.path}.`) : item.revision.summary;
    if (!sentence) return null;
    return <Post seedName={seedName} key={item.id} agentId={agentId} name={name} slug={slug} at={whenLabel(item.at, ko, now)} tag={ko ? "진화" : "Evolved"} tagIcon={<IconTrendUp size={14} />}>
      <p className={styles.tText}>{sentence}</p>
      {rows.length > 0 && <div className={styles.mini}>{rows.map((row, index) => <div key={index} className={row.sign === "+" ? styles.miniAdd : styles.miniDel}>{row.sign} {row.text}</div>)}</div>}
    </Post>;
  };

  // "Nothing here yet" is only said once the memory list was really read; while it is being read or could not be read, nothing is claimed about it.
  const memoryUnread = memory === null;
  const empty = !memoryUnread && waiting.length === 0 && groups.length === 0 && evolved.length === 0;
  return <section className={styles.timeline} aria-label={ko ? "타임라인" : "Timeline"} data-agent-timeline>
    {waiting.map((proposal) => {
      const skill = proposal.skillPromotion?.skills[0];
      const runs = learnedRuns(proposal);
      return <Post seedName={seedName} key={proposal.id} agentId={agentId} name={name} slug={slug} at={whenLabel(proposal.createdAt, ko, now)} tag={ko ? "학습" : "Learned"} tagIcon={<IconSparkles size={14} />} flag={ko ? "확인 대기" : "Waiting for you"}>
        <p className={styles.tText}>{skill ? (ko ? "같은 방식으로 계속 해결하고 있어요. 스킬로 생성할까요?" : "I keep solving this the same way. Should it become a skill?") : proposal.summary}</p>
        <div className={`${styles.card} ${skill && proposal.skillPromotion && (proposal.skillPromotion.redactedCount > 0 || proposal.skillPromotion.mayLeaveThisComputer) ? styles.cardCol : ""}`}>
          {skill && proposal.skillPromotion && (proposal.skillPromotion.redactedCount > 0 || proposal.skillPromotion.mayLeaveThisComputer) ? <>
            <div className={styles.cardMain} style={{ background: "var(--paper-3)", borderRadius: 10, padding: "10px 14px" }}><b>{skill.name}</b><small>{skill.description}{runs ? ` · ${ko ? `${runs}회 실행` : `Worked ${runs} times`}` : ""}</small></div>
            <HiddenItemsLine promotion={proposal.skillPromotion} ko={ko} />
            {proposal.skillPromotion.mayLeaveThisComputer && <div className={styles.cloudNote}><IconCloud size={16} />{ko ? "스킬이 내 Cloud와 다른 데스크탑으로 전송될 수 있어요" : "Skills can go to My Cloud and your other computers"}</div>}
            <div className={styles.cardActs} style={{ justifyContent: "flex-end" }}>
              <button type="button" className={styles.btn} disabled={busy || !canWrite} onClick={() => onDismiss(proposal)}>{ko ? "무시" : "Dismiss"}</button>
              <button type="button" className={`${styles.btn} ${styles.btnPri}`} disabled={busy || !canWrite} onClick={() => onAddSkill(proposal)}><IconCheck size={14} />{ko ? "스킬 추가" : "Add skill"}</button></div>
          </> : <>
            <div className={styles.cardMain}><b>{skill?.name ?? proposal.summary}</b><small>{skill ? `${skill.description}${runs ? ` · ${ko ? `${runs}회 실행` : `Worked ${runs} times`}` : ""}` : `${proposal.changes.length} ${ko ? "개 파일" : proposal.changes.length === 1 ? "file" : "files"}`}</small></div>
            <div className={styles.cardActs}>
              <button type="button" className={styles.btn} disabled={busy || !canWrite} onClick={() => onDismiss(proposal)}>{ko ? "무시" : "Dismiss"}</button>
              {skill ? <button type="button" className={`${styles.btn} ${styles.btnPri}`} disabled={busy || !canWrite} onClick={() => onAddSkill(proposal)}><IconCheck size={14} />{ko ? "스킬 추가" : "Add skill"}</button>
                : <button type="button" className={`${styles.btn} ${styles.btnPri}`} disabled={busy} onClick={() => onReview(proposal)}>{ko ? "검토" : "Review"}</button>}
            </div>
          </>}
        </div>
      </Post>;
    })}
    {groups.map((group) => {
      const project = group.project;
      const shown = group.entries.slice(0, MAX_LINES_PER_POST);
      return <Post seedName={seedName} key={group.key} agentId={agentId} name={name} slug={slug} at={whenLabel(group.at, ko, now)} tag={`${ko ? "기억" : "Memory"}${project ? ` · ${project}` : ""}`} tagIcon={<IconBrain size={14} />}>
        <p className={styles.tText}>{ko ? `${project ? `${project}에서 ` : ""}새로 저장된 기억 ${group.entries.length}개예요.` : `${group.entries.length} new thing${group.entries.length === 1 ? "" : "s"} I remember${project ? ` from ${project}` : ""}.`}</p>
        <ul className={styles.memCols}>{shown.map((entry) => <li key={entry.memoryId}>{plainMemoryTitle(entry.title || entry.content, ko, 90)}</li>)}</ul>
        <div className={styles.tFoot}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><IconLock size={14} />{ko ? "이 데스크탑에만 저장돼요" : "This computer only"}</span>
          <button type="button" onClick={onOpenMemory}><IconExternalLink size={14} />{ko ? "기억에서 열기" : "Open in Memory"}</button>
          <button type="button" disabled={busy} onClick={() => onForget(group.entries)}><IconTrash size={14} />{ko ? "삭제" : "Forget"}</button></div>
      </Post>;
    })}
    {evolved.map((item) => evolvedPost(item))}
    {memoryUnread && memoryFailed && <div className={styles.readFailed} role="alert"><IconAlertTriangle size={14} /><span>{ko ? "기억을 불러오지 못했어요." : "Couldn't read the memory."}</span><button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={onRetryMemory}>{ko ? "재시도" : "Retry"}</button></div>}
    {memoryUnread && !memoryFailed && waiting.length === 0 && evolved.length === 0 && <div className={styles.empty}>{ko ? "기억을 불러오는 중…" : "Reading memory…"}</div>}
    {empty && <div className={styles.empty}><IconClose size={0} /><b>{ko ? "등록된 항목 없음" : "Nothing here yet"}</b></div>}
  </section>;
}
