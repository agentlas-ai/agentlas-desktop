"use client";

// Skills and Memory tabs and the forget dialog of Manage agents (Agentlas 2.0 F-D9; pictures agents-v6-skills, agents-v6-memory,
// desktop-states-pieces 2, desktop-final-pieces-2 H). Values only from the host: a column that has no value (the date of a skill, "seen in",
// "what it produced last time", "learned in") is not drawn. "Forget all" removes only this agent's lines through the same per-line forget.
import { useEffect, useMemo, useState } from "react";
import { IconCheck, IconClose, IconCloud, IconFileText, IconFilter, IconLock, IconSearch, IconSparkles, IconTarget, IconTrash, IconUser, IconFileUp, IconAlertTriangle, IconClock } from "@/components/Icon";
import type { AgentWorkspaceDiff, AgentWorkspaceFile, AgentWorkspaceProposal } from "@shared/agent-workspace";
import type { DesktopMemoryListEntry, DesktopMemoryQueryResult } from "@shared/desktop-memory-inspector";
import { plainMemoryTitle } from "@/lib/agent-memory-explain";
import { skillFiles } from "./AgentWorkspaceTabs";
import { HiddenItemsLine } from "./AgentTimeline";
import { IconDisk, IconGlobe, IconRuler } from "./agent-manage-icons";
import { shortDate } from "./agent-manage-model";
import type { StoreSkipCode } from "./useAgentMemory";
import styles from "./AgentManage.module.css";

// ---- Skills ---------------------------------------------------------------------------------------------------------------------------------

/** The numbered steps of a skill file (what it does is the host's description). */
export function skillSteps(markdown: string): string[] {
  return markdown.split("\n").map((line) => /^\s*\d+[.)]\s+(.+)$/.exec(line)?.[1]?.trim() ?? "").filter(Boolean).slice(0, 12);
}

export function AgentSkillsTab({ ko, files, proposals, writable, busy, cloudLinked, readDiff, onAddSkill, onDismiss, onReview, onOpenFile, lessons, onPrepare, autoEvolution, onAutoEvolution }: {
  ko: boolean; files: AgentWorkspaceFile[]; proposals: AgentWorkspaceProposal[]; writable: boolean; busy: boolean; cloudLinked: boolean;
  readDiff: (proposalId: string) => Promise<AgentWorkspaceDiff>;
  onAddSkill: (proposal: AgentWorkspaceProposal) => void; onDismiss: (proposal: AgentWorkspaceProposal) => void; onReview: (proposal: AgentWorkspaceProposal) => void; onOpenFile: (path: string) => void;
  lessons: Array<{ key: string; ids: string[]; text: string }>; onPrepare: (ids: string[]) => void;
  autoEvolution: { enabled: boolean } | undefined; onAutoEvolution: (enabled: boolean) => void;
}) {
  const waiting = proposals.filter((proposal) => proposal.status === "review_ready");
  const dismissed = proposals.filter((proposal) => proposal.status === "rejected" && proposal.skillPromotion).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const skills = skillFiles(files);
  const [pickedId, setPickedId] = useState("");
  const picked = waiting.find((proposal) => proposal.id === pickedId) ?? waiting[0] ?? null;
  const [steps, setSteps] = useState<{ id: string; list: string[] } | null>(null);
  useEffect(() => {
    if (!picked?.skillPromotion) { setSteps(null); return; }
    let alive = true;
    void readDiff(picked.id).then((diff) => {
      const skill = diff.changes.find((change) => /^skills\/[^/]+\/SKILL\.md$/i.test(change.path) && change.operation !== "delete");
      if (alive) setSteps({ id: picked.id, list: skill ? skillSteps(skill.afterContent) : [] });
    }).catch(() => { if (alive) setSteps({ id: picked.id, list: [] }); });
    return () => { alive = false; };
  }, [picked?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const promoted = picked?.skillPromotion?.skills[0];
  return <div className={styles.cols} data-agent-skills-tab>
    <div className={styles.colLeft} style={{ width: 380 }}>
      {waiting.length + lessons.length > 0 && <><div className={styles.secHead}>{ko ? "학습 내용 · 확인 대기" : "Learned — waiting for you"}<small>{waiting.length + lessons.length}</small></div>
        {lessons.map((lesson) => <div key={lesson.key} className={styles.rowBlock}><b>{plainMemoryTitle(lesson.text, ko, 90)}</b><small>{ko ? "지침에 반영할 수 있어요" : "Ready to add to its instructions"}</small><div className={styles.rowActs}><button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || !writable} onClick={() => onPrepare(lesson.ids)}>{ko ? "변경안 생성" : "Prepare change"}</button></div></div>)}
        {waiting.map((proposal) => {
          const skill = proposal.skillPromotion?.skills[0];
          return <div key={proposal.id} className={`${styles.rowBlock} ${picked?.id === proposal.id ? styles.rowBlockOn : ""}`} role="button" tabIndex={0} onClick={() => setPickedId(proposal.id)} onKeyDown={(event) => { if (event.key === "Enter") setPickedId(proposal.id); }}>
            <b>{skill?.name ?? proposal.summary}</b><small>{skill?.description ?? `${proposal.changes.length} ${ko ? "개 파일" : "files"}`}</small>
            <div className={styles.rowActs}>
              <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || !writable} onClick={(event) => { event.stopPropagation(); onDismiss(proposal); }}>{ko ? "무시" : "Dismiss"}</button>
              {skill ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPri}`} disabled={busy || !writable} onClick={(event) => { event.stopPropagation(); onAddSkill(proposal); }}><IconCheck size={13} />{ko ? "스킬 추가" : "Add skill"}</button>
                : <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPri}`} disabled={busy} onClick={(event) => { event.stopPropagation(); onReview(proposal); }}>{ko ? "검토" : "Review"}</button>}
            </div></div>;
        })}</>}
      <div className={styles.secHead}>{ko ? "스킬" : "Skills"}<small>{skills.length}</small></div>
      {skills.length === 0 && <div className={styles.empty} style={{ padding: "28px 20px" }}>{ko ? "승인된 스킬 없음" : "No approved skills"}</div>}
      {skills.map((skill) => <button key={skill.path} type="button" className={styles.row} onClick={() => onOpenFile(skill.path)}><IconFileText size={18} /><b>{skill.name}</b><span /></button>)}
      {dismissed.length > 0 && <><div className={styles.secHead}>{ko ? "무시한 항목" : "Dismissed"}<small>{dismissed.length}</small></div>
        {dismissed.map((proposal) => <div key={proposal.id} className={`${styles.row} ${styles.rowDim}`}><IconSparkles size={16} /><b>{proposal.skillPromotion?.skills[0]?.name ?? proposal.summary}</b><span className={styles.rowDate}>{shortDate(proposal.createdAt)}</span></div>)}</>}
      {autoEvolution && <label className={styles.switchRow} style={{ marginTop: "auto" }} title={ko ? "안전한 학습 내용은 자동 반영하고, 결과가 나빠지면 복원해요." : "Safe procedure lessons are applied automatically and rolled back if results get worse."}>
        <input type="checkbox" checked={autoEvolution.enabled} disabled={!writable || busy} onChange={(event) => onAutoEvolution(event.target.checked)} />{ko ? "자동 진화" : "Auto-evolve"}</label>}
    </div>
    <div className={styles.colRight}>
      {picked ? <>
        <div className={styles.detailHead}><b>{promoted?.name ?? picked.summary}</b>
          <button type="button" className={styles.btn} disabled={busy || !writable} onClick={() => onDismiss(picked)}>{ko ? "무시" : "Dismiss"}</button>
          {promoted ? <button type="button" className={`${styles.btn} ${styles.btnPri}`} disabled={busy || !writable} onClick={() => onAddSkill(picked)}><IconCheck size={14} />{ko ? "스킬 추가" : "Add skill"}</button>
            : <button type="button" className={`${styles.btn} ${styles.btnPri}`} disabled={busy} onClick={() => onReview(picked)}>{ko ? "검토" : "Review"}</button>}</div>
        <div className={styles.detail}>
          <div className={styles.dLab}>{ko ? "기능" : "What it does"}</div>
          <p className={styles.dText}>{promoted?.description ?? picked.summary}</p>
          {steps?.id === picked.id && steps.list.length > 0 && <><div className={styles.dLab}>{ko ? "단계" : "Steps"}</div><ol className={styles.dText} style={{ paddingLeft: 22, margin: 0 }}>{steps.list.map((step, index) => <li key={index}>{step}</li>)}</ol></>}
          {picked.skillPromotion && <><div style={{ height: 14 }} /><HiddenItemsLine promotion={picked.skillPromotion} ko={ko} /></>}
          {promoted && <><div className={styles.dLab}>{ko ? "추가 시" : "After you add it"}</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}><span className={styles.chip}><IconFileText size={13} />{promoted.path}</span><span className={styles.chip}>{cloudLinked ? <IconCloud size={13} /> : <IconLock size={13} />}{cloudLinked ? (ko ? "다음 동기화 때 저장돼요" : "Saved with the next Sync") : (ko ? "이 데스크탑에 저장돼요" : "Stays on this computer")}</span></div></>}
        </div></> : <div className={styles.empty}><IconSparkles size={22} /><b>{ko ? "확인할 항목 없음" : "Nothing to review"}</b></div>}
    </div>
  </div>;
}

// ---- Memory ---------------------------------------------------------------------------------------------------------------------------------

const KIND_GROUPS: Array<{ id: string; kinds: string[]; en: string; ko: string; cls: string }> = [
  { id: "fact", kinds: ["fact"], en: "Fact", ko: "사실", cls: styles.kFact },
  { id: "decision", kinds: ["decision", "preference"], en: "Decision · preference", ko: "결정 · 선호", cls: styles.kDecision },
  { id: "procedure", kinds: ["procedure"], en: "Procedure", ko: "절차", cls: styles.kProcedure },
  { id: "risk", kinds: ["risk"], en: "Risk", ko: "주의", cls: styles.kRisk },
];
const groupOfKind = (kind: string) => KIND_GROUPS.find((group) => group.kinds.includes(kind));

function MemoryIcon({ kind }: { kind: string }) {
  return kind === "preference" ? <IconUser size={17} /> : kind === "decision" || kind === "procedure" ? <IconTarget size={17} /> : <IconFileText size={17} />;
}

/** The lines the curator did not keep, in words (codes only come from the host: desktop-states-pieces 2). */
export function NotKeptLines({ codes, ko, onReview }: { codes: StoreSkipCode[]; ko: boolean; onReview: () => void }) {
  const rows = codes.filter((item) => item.code.startsWith("curation_dropped:")).map((item) => item.code.slice("curation_dropped:".length));
  const unique = [...new Set(rows)];
  if (unique.length === 0) return null;
  const copy: Record<string, { icon: JSX.Element; title: [string, string]; sub: [string, string]; action?: boolean }> = {
    store_full: { icon: <IconDisk />, title: ["저장하지 못했어요 · 기억이 가득 찼어요", "Not saved · memory is full"], sub: ["공간을 확보하려면 기억 몇 개를 삭제해 주세요", "Remove some to make room"], action: true },
    too_long: { icon: <IconRuler />, title: ["저장하지 못했어요 · 너무 길어요", "Not saved · too long"], sub: ["더 짧게 줄여서 다시 말해 주세요", "Shorten it and say it again"] },
    kept_session: { icon: <IconClock size={17} />, title: ["이 대화에만 저장했어요", "Kept for this chat only"], sub: ["장기 기억으로는 저장하지 않았어요", "Not saved as a lasting memory"] },
  };
  return <div className={styles.notKept} role="status" data-agent-memory-not-kept>
    {unique.filter((code) => copy[code]).map((code) => { const c = copy[code]; return <div key={code}><span>{c.icon}</span><div><b>{c.title[ko ? 0 : 1]}</b><small>{c.sub[ko ? 0 : 1]}</small></div>{c.action && <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={onReview}>{ko ? "검토" : "Review"}</button>}</div>; })}
  </div>;
}

export function AgentMemoryTab({ ko, result, failed, skipped, onForget, onImport, onRetry }: {
  ko: boolean; result: DesktopMemoryQueryResult | null; failed: boolean; skipped: StoreSkipCode[]; onForget: (entries: DesktopMemoryListEntry[], all?: boolean) => void; onImport: (() => void) | null; onRetry: () => void;
}) {
  const [project, setProject] = useState("");
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const entries = result?.entries ?? [];
  const shown = useMemo(() => entries.filter((entry) => (!project || (entry.projectSlug ?? "") === (project === "*" ? "" : project)) && (!kind || groupOfKind(entry.kind)?.id === kind)
    && (!query.trim() || `${entry.title} ${entry.content}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))), [entries, project, kind, query]);
  const projects = useMemo(() => [...new Set((result?.map.nodes ?? []).map((node) => node.projectSlug ?? ""))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b))), [result]);
  const nodesBy = (slug: string) => (result?.map.nodes ?? []).filter((node) => (node.projectSlug ?? "") === slug);
  const counts = KIND_GROUPS.map((group) => ({ group, n: entries.filter((entry) => group.kinds.includes(entry.kind)).length })).filter((item) => item.n > 0);
  const maxCount = Math.max(1, ...counts.map((item) => item.n));
  if (failed && !result) return <div className={styles.empty} role="alert"><IconAlertTriangle size={22} /><b>{ko ? "기억을 불러오지 못했어요" : "Couldn't read the memory"}</b><button type="button" className={styles.btn} onClick={onRetry}>{ko ? "재조회" : "Try again"}</button></div>;
  if (!result) return <div className={styles.empty}>{ko ? "기억을 불러오는 중…" : "Reading memory…"}</div>;
  return <div className={styles.cols} data-agent-memory-tab>
    <div className={styles.colLeft} style={{ width: 339 }}>
      <div className={styles.filters}>
        <label className={styles.pill}><IconFilter size={14} /><select className={styles.pillSel} style={{ border: 0, padding: 0, height: 24, background: "transparent" }} aria-label={ko ? "프로젝트" : "Project"} value={project} onChange={(event) => setProject(event.target.value)}>
          <option value="">{ko ? "모든 프로젝트" : "All projects"}</option>{projects.map((slug) => <option key={slug} value={slug === "" ? "*" : slug}>{slug === "" ? (ko ? "프로젝트 없음" : "No project") : slug}</option>)}</select></label>
        <select className={styles.pillSel} aria-label={ko ? "종류" : "Kind"} value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="">{ko ? "모든 종류" : "All kinds"}</option>{KIND_GROUPS.map((group) => <option key={group.id} value={group.id}>{ko ? group.ko : group.en}</option>)}</select>
      </div>
      {projects.map((slug) => { const nodes = nodesBy(slug); return <div className={styles.proj} key={slug || "*"}>
        <div className={styles.projHead}>{slug ? <IconFileText size={16} /> : <IconGlobe size={16} />}{slug || (ko ? "모든 프로젝트" : "All projects")}<small>{nodes.length}</small></div>
        <div className={styles.dots} aria-hidden>{nodes.map((node) => <i key={node.id} className={`${styles.dotCell} ${groupOfKind(node.kind)?.cls ?? styles.kOther}`} />)}</div></div>; })}
      {counts.length > 0 && <div className={styles.bars}><h4>{ko ? "종류" : "Kinds"}</h4>{counts.map(({ group, n }) => <div className={styles.barRow} key={group.id}><span>{ko ? group.ko : group.en}</span><i style={{ ["--w" as string]: `${Math.round((n / maxCount) * 100)}%`, ["--c" as string]: group.id === "fact" ? "#6b6e52" : group.id === "decision" ? "#c4ad77" : group.id === "procedure" ? "#6fa8a4" : "#b88478" } as React.CSSProperties} /><b>{n}</b></div>)}</div>}
      <div className={styles.leftFoot}><span className={styles.lockChip}><IconLock size={13} />{ko ? "이 데스크탑에만 저장돼요" : "This computer only"}</span>
        {entries.length > 0 && <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnForget}`} data-agent-forget-all onClick={() => onForget(entries, true)}><IconTrash size={13} />{ko ? "기억 전체 삭제…" : "Remove all memory…"}</button>}</div>
    </div>
    <div className={styles.colRight}>
      <div className={styles.detailHead}>{searching ? <input autoFocus className={styles.input} style={{ height: 36, fontSize: 14, flex: 1 }} value={query} placeholder={ko ? "기억 검색" : "Search memories"} aria-label={ko ? "기억 검색" : "Search memories"} onChange={(event) => setQuery(event.target.value)} onBlur={() => { if (!query) setSearching(false); }} />
        : <b>{ko ? `기억 ${result.total}개` : `${result.total} memories`}{result.truncated ? (ko ? ` · 최근 ${entries.length}개` : ` · newest ${entries.length}`) : ""}</b>}
        {onImport && <button type="button" className={styles.ib} aria-label={ko ? "기존 메모리 가져오기" : "Import existing memory"} onClick={onImport}><IconFileUp size={16} /></button>}
        <button type="button" className={styles.ib} aria-label={ko ? "기억 검색" : "Search memories"} onClick={() => setSearching((value) => !value)}><IconSearch size={16} /></button></div>
      <NotKeptLines codes={skipped} ko={ko} onReview={() => setKind("")} />
      {shown.map((entry) => <div className={styles.mRow} key={entry.memoryId}><MemoryIcon kind={entry.kind} /><div><b>{plainMemoryTitle(entry.title || entry.content, ko, 140)}</b><small>{`${entry.projectSlug ?? (ko ? "모든 프로젝트" : "All projects")} · ${(groupOfKind(entry.kind) ? (ko ? groupOfKind(entry.kind)!.ko : entry.kind) : entry.kind)} · ${shortDate(entry.createdAt)}`}</small></div>
        <button type="button" className={styles.ib} aria-label={ko ? "기억 삭제" : "Forget this memory"} onClick={() => onForget([entry])}><IconTrash size={15} /></button></div>)}
      {shown.length === 0 && <div className={styles.empty}><b>{entries.length === 0 ? (ko ? "저장된 기억이 없어요" : "Nothing remembered yet") : (ko ? "일치하는 기억이 없어요" : "No matching memories")}</b></div>}
    </div>
  </div>;
}

// ---- Forget dialog (desktop-final-pieces-2 H) --------------------------------------------------------------------------------------------------

export function ForgetDialog({ ko, agentName, entries, total, busy, failed, onCancel, onConfirm }: { ko: boolean; agentName: string; entries: DesktopMemoryListEntry[]; /** "Forget all": the number of lines the agent has (more than the list when it was cut). */ total?: number; busy: boolean; failed: boolean; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onCancel(); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [busy, onCancel]);
  // Skills the lines made, read before forgetting; absent = not known (no claim either way).
  const skills = [...new Set(entries.flatMap((entry) => (entry.derivedSkills ?? []).map((skill) => skill.skillName)))];
  const one = entries.length === 1 && total === undefined;
  const count = Math.max(total ?? 0, entries.length);
  return <div className={styles.scrim} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <div className={styles.dialog} style={{ width: "min(440px, calc(100vw - 36px))" }} role="dialog" aria-modal="true" aria-label={ko ? "기억 삭제" : "Remove from memory"} data-agent-forget-dialog>
      <h2>{one ? (ko ? `${agentName}의 기억을 삭제할까요?` : `Remove this from ${agentName}'s memory?`) : (ko ? `${agentName}의 기억 ${count}개를 삭제할까요?` : `Remove these ${count} lines from ${agentName}'s memory?`)}</h2>
      {one ? <p className={styles.dialogP}>“{plainMemoryTitle(entries[0].title || entries[0].content, ko, 140)}”</p>
        : <ul className={styles.dialogP} style={{ paddingLeft: 18 }}>{entries.slice(0, 4).map((entry) => <li key={entry.memoryId}>{plainMemoryTitle(entry.title || entry.content, ko, 100)}</li>)}{count > 4 && <li>{ko ? `외 ${count - 4}개` : `and ${count - 4} more`}</li>}</ul>}
      {skills.length > 0 && <div className={styles.skillBox}><IconSparkles size={18} /><span>{ko ? "이 기억으로 생성된 스킬 ·" : "A skill came from this line ·"}</span><b>{skills.join(", ")}</b><small>{ko ? "스킬은 유지돼요" : "The skill stays"}</small></div>}
      <p className={styles.dialogP}>{ko ? "해당 내용이 오간 대화와 다른 에이전트·프로젝트의 같은 기억은 남아요." : "The chats where it was said and the same memory in other agents or projects remain."}</p>
      {failed && <p className={styles.dialogErr} role="alert">{ko ? "삭제하지 못했어요. 다시 시도해 주세요." : "Couldn't remove it. Try again."}</p>}
      <div className={styles.dialogActs}><button type="button" className={styles.btn} disabled={busy} onClick={onCancel}>{ko ? "취소" : "Cancel"}</button><button type="button" className={`${styles.btn} ${styles.btnForget}`} disabled={busy} onClick={onConfirm}><IconClose size={0} />{ko ? "기억 삭제" : "Remove from memory"}</button></div>
    </div>
  </div>;
}
