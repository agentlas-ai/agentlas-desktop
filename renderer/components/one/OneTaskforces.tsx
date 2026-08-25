"use client";

import { useEffect, useMemo, useState } from "react";
import { IconCheck, IconClose, IconPlus, IconUsers } from "@/components/Icon";
import type { OneOrgMember, OneOrgState } from "@shared/one-org";
import type { OneTaskforce } from "@shared/one-taskforces";
import { ipc } from "@/lib/ipc";
import { OneAgentPortrait } from "./OneAgentPortrait";
import { OneBottomSheet } from "./OneBottomSheet";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import styles from "./OneTaskforces.module.css";

/** 웹인지 데스크탑인지는 Main 브릿지의 유무로 가른다(웹은 window.agentlas 를 심지 않는다). */
function isWebSurface(): boolean {
  return typeof window !== "undefined" && !(window as { agentlas?: unknown }).agentlas;
}

function memberUnavailable(member: OneOrgMember | undefined): boolean {
  return !member || Boolean(member.archivedAt) || member.statusKind === "locked" || member.statusKind === "failed";
}

function memberStatus(member: OneOrgMember | undefined, locale: "ko" | "en"): string {
  if (!member) return locale === "ko" ? "삭제되었거나 찾을 수 없음" : "Deleted or unavailable";
  if (member.archivedAt) return locale === "ko" ? "조직에서 보관됨" : "Archived from the organisation";
  if (member.statusKind === "locked") return locale === "ko" ? "대여 종료 또는 실행 불가" : "Lease ended or unavailable";
  if (member.statusKind === "failed") return locale === "ko" ? "오류 · 확인 필요" : "Error · review needed";
  if (member.statusKind === "working") return locale === "ko" ? "작업 중" : "Working";
  return locale === "ko" ? member.statusLine : member.statusLineEn;
}

function memberFor(org: OneOrgState | null, agentId: string): OneOrgMember | undefined {
  return org?.members.find((member) => member.installedAgentId === agentId);
}

function TaskforcePortraits({ taskforce, org, oneAvatarIcon }: { taskforce: OneTaskforce; org: OneOrgState | null; oneAvatarIcon?: string }) {
  const visible = taskforce.memberAgentIds.slice(0, 2);
  const overflow = Math.max(0, taskforce.memberAgentIds.length - visible.length);
  return <span className={styles.portraitStack} aria-hidden="true">
    <OneAgentPortrait status="quiet" label="One" tone={oneAvatarIcon?.trim() || "purple"} size="small" />
    {visible.map((agentId) => {
      const member = memberFor(org, agentId);
      return <OneAgentPortrait
        key={agentId}
        status={memberUnavailable(member) ? "locked" : member?.statusKind ?? "locked"}
        label={member?.displayName ?? "Unavailable"}
        tone={member?.icon ?? "blue"}
        size="small"
      />;
    })}
    {overflow > 0 && <span className={styles.portraitOverflow}>+{overflow}</span>}
  </span>;
}

export function OneTaskforceRail({
  taskforces,
  org,
  activeChatId,
  locale,
  onOpen,
  onCreate,
  oneAvatarIcon,
}: {
  taskforces: OneTaskforce[];
  org: OneOrgState | null;
  activeChatId: string | null;
  locale: "ko" | "en";
  onOpen: (taskforce: OneTaskforce) => void;
  onCreate: () => void;
  /** One 이 고른 캐릭터 — 화면마다 다른 얼굴을 보여 주지 않기 위해 함께 내려온다. */
  oneAvatarIcon?: string;
}) {
  return <section className={styles.rail} aria-label="Taskforces">
    <header className={styles.railHeader}>
      <span>Taskforces</span>
      <button type="button" onClick={onCreate} aria-label={locale === "ko" ? "태스크포스 만들기" : "Create Taskforce"}>
        <IconPlus size={14} />
      </button>
    </header>
    <div className={styles.railList}>
      {taskforces.length === 0 && <button type="button" className={styles.emptyRow} onClick={onCreate}>
        <span className={styles.emptyIcon}><IconUsers size={15} /></span>
        <span><strong>{locale === "ko" ? "새 태스크포스" : "New Taskforce"}</strong><small>{locale === "ko" ? "One과 동료들의 그룹 대화" : "A group chat with One and staff"}</small></span>
      </button>}
      {taskforces.map((taskforce) => {
        const unavailable = taskforce.memberAgentIds.filter((id) => memberUnavailable(memberFor(org, id))).length;
        return <button
          key={taskforce.id}
          type="button"
          className={styles.taskforceRow}
          data-active={activeChatId === taskforce.chatId ? "true" : "false"}
          onClick={() => onOpen(taskforce)}
        >
          <TaskforcePortraits taskforce={taskforce} org={org} oneAvatarIcon={oneAvatarIcon} />
          <span className={styles.taskforceCopy}>
            <strong>{taskforce.title}</strong>
            {/*
              영어에서는 하나일 때 단수로 쓴다. "1 members" 는 첫 화면에 그대로 보이는
              문법 오류였다(2026-08-23 실제 화면에서 발견). 한국어는 수에 따라 안 바뀐다.
            */}
            <small>{(() => {
              const people = taskforce.memberAgentIds.length + 1;
              if (locale === "ko") {
                return `One 포함 ${people}명${unavailable ? ` · ${unavailable}명 확인 필요` : ""}`;
              }
              const who = `${people} ${people === 1 ? "member" : "members"} incl. One`;
              const review = unavailable ? ` · ${unavailable} ${unavailable === 1 ? "needs" : "need"} review` : "";
              return `${who}${review}`;
            })()}</small>
          </span>
        </button>;
      })}
    </div>
  </section>;
}

export function OneTaskforceDialog({
  open,
  taskforce,
  org,
  locale,
  busy,
  onClose,
  onCreate,
  onUpdate,
  onRemove,
  oneAvatarIcon,
}: {
  open: boolean;
  taskforce: OneTaskforce | null;
  org: OneOrgState | null;
  locale: "ko" | "en";
  busy: boolean;
  onClose: () => void;
  onCreate: (input: { title: string; description: string; memberAgentIds: string[] }) => Promise<void>;
  onUpdate: (input: { id: string; title: string; description: string; memberAgentIds: string[]; expectedRevision: number }) => Promise<void>;
  onRemove: (input: { id: string; expectedRevision: number }) => Promise<void>;
  oneAvatarIcon?: string;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // 해체 확인 문구의 정확한 수(사전 COUNT) — "대화 N개는 기록으로 남습니다".
  const [preservedSessionCount, setPreservedSessionCount] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    setTitle(taskforce?.title ?? "");
    setDescription(taskforce?.description ?? "");
    setSelected(taskforce?.memberAgentIds ?? []);
    setError(null);
    setConfirmRemove(false);
    setPreservedSessionCount(null);
  }, [open, taskforce]);
  useEffect(() => {
    if (!confirmRemove || !taskforce) return;
    const api = ipc();
    if (!api?.oneTaskforces?.removePreview) return;
    let cancelled = false;
    void api.oneTaskforces.removePreview({ id: taskforce.id })
      .then((preview) => { if (!cancelled) setPreservedSessionCount(preview.sessionCount); })
      .catch(() => { /* 수를 못 세면 수 없는 문구로 낸다 — 지어내지 않는다 */ });
    return () => { cancelled = true; };
  }, [confirmRemove, taskforce]);
  const rows = useMemo(() => {
    const active = org?.members ?? [];
    const known = new Set(active.map((member) => member.installedAgentId));
    return [
      ...active,
      ...selected.filter((id) => !known.has(id)).map((id) => ({
        id: `missing:${id}`,
        agentSlug: id,
        installedAgentId: id,
        displayName: locale === "ko" ? "사용할 수 없는 에이전트" : "Unavailable agent",
        nameEn: "Unavailable agent",
        icon: "blue",
        source: "local" as const,
        sortOrder: 999,
        leaseExpiresAt: null,
        addedAt: "",
        updatedAt: "",
        archivedAt: new Date(0).toISOString(),
        statusKind: "locked" as const,
        statusLine: "사용 불가",
        statusLineEn: "Unavailable",
        lastActivityAt: null,
        pendingCount: 0,
        pendingKind: "review" as const,
        unreadCount: 0,
        creditState: "unknown" as const,
        completionSummary: { produced: [], pending: [] },
        autoSelectTools: false,
        collaborationStyle: "default" as const,
        title: "",
        description: "",
        identityEditable: false,
        runtimeSelection: null,
        revision: 1,
      })),
    ];
  }, [locale, org?.members, selected]);
  const toggle = (agentId: string, unavailable: boolean) => {
    setSelected((current) => current.includes(agentId)
      ? current.filter((id) => id !== agentId)
      : unavailable ? current : [...current, agentId]);
  };
  const submit = async () => {
    const nextTitle = title.replace(/\s+/g, " ").trim();
    if (!nextTitle || busy) return;
    setError(null);
    try {
      if (taskforce) await onUpdate({ id: taskforce.id, title: nextTitle, description: description.trim(), memberAgentIds: selected, expectedRevision: taskforce.revision });
      else await onCreate({ title: nextTitle, description: description.trim(), memberAgentIds: selected });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return <OneBottomSheet
    open={open}
    onClose={() => { if (!busy) onClose(); }}
    closeLabel={locale === "ko" ? "태스크포스 닫기" : "Close Taskforce"}
    closeDisabled={busy}
    closeOnBackdrop={!busy}
    closeOnEscape={!busy}
    size="wide"
    eyebrow="Taskforce"
    title={taskforce ? (locale === "ko" ? "태스크포스 멤버" : "Taskforce members") : (locale === "ko" ? "태스크포스 만들기" : "Create Taskforce")}
    titleId="one-taskforce-dialog-title"
    ariaLabelledBy="one-taskforce-dialog-title"
    description={locale === "ko" ? "One은 항상 참여합니다. 동료를 추가하거나 회색으로 표시된 사용할 수 없는 멤버를 제거할 수 있습니다." : "One always participates. Add staff, or remove unavailable members shown in grey."}
  >
    <div className={styles.dialogBody} aria-busy={busy ? "true" : "false"}>
      <label className={styles.titleField}>{locale === "ko" ? "이름" : "Name"}<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} placeholder={locale === "ko" ? "예: Launch Team" : "e.g. Launch Team"} /></label>
      <label className={styles.descriptionField}>{locale === "ko" ? "설명" : "Description"}<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={600} rows={3} placeholder={locale === "ko" ? "이 팀의 역할, 목적, 협업 방식을 설명하세요." : "Describe this team's purpose, responsibilities, and way of working."} /></label>
      {busy && <div className={styles.busyState} role="status" aria-live="polite"><span aria-hidden="true" /><strong>{taskforce ? (locale === "ko" ? "태스크포스를 업데이트하는 중" : "Updating Taskforce") : (locale === "ko" ? "태스크포스를 만드는 중" : "Creating Taskforce")}</strong><small>{locale === "ko" ? "멤버와 독립 그룹 채팅을 함께 동기화합니다." : "Syncing members with the independent group chat."}</small><LoadingEstimate locale={locale} operationKey="one-taskforce-save" expectedSeconds={[2, 20]} /></div>}
      <section className={styles.memberList} aria-label={locale === "ko" ? "태스크포스 멤버" : "Taskforce members"}>
        <div className={styles.memberRow} data-fixed="true">
          <OneAgentPortrait status="quiet" label="One" tone={oneAvatarIcon?.trim() || "purple"} />
          <span><strong>One</strong><small>{locale === "ko" ? "CEO 오케스트레이터 · 항상 참여" : "CEO orchestrator · Always present"}</small></span>
          <span className={styles.fixedBadge}><IconCheck size={12} />{locale === "ko" ? "고정" : "Pinned"}</span>
        </div>
        {rows.map((member) => {
          const unavailable = memberUnavailable(member);
          const checked = selected.includes(member.installedAgentId);
          return <button
            key={member.id}
            type="button"
            className={styles.memberRow}
            data-unavailable={unavailable ? "true" : "false"}
            aria-pressed={checked}
            onClick={() => toggle(member.installedAgentId, unavailable)}
            disabled={unavailable && !checked}
          >
            <OneAgentPortrait status={unavailable ? "locked" : member.statusKind} label={member.displayName} tone={member.icon} />
            <span><strong>{member.displayName}</strong><small>{memberStatus(member, locale)}</small></span>
            <span className={styles.checkbox} data-checked={checked ? "true" : "false"}>{checked ? <IconCheck size={12} /> : null}</span>
          </button>;
        })}
        {rows.length === 0 && <p className={styles.noStaff}>{locale === "ko" ? "먼저 왼쪽 조직에 동료를 추가하세요." : "Add standing staff to the organisation first."}</p>}
      </section>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {confirmRemove && taskforce && <div className={styles.removeConfirm} role="alert">
        {/* 두 표면의 약속이 각자의 실제 동작과 같아야 한다(좌석 기획 I10 — 계약은 같고
            구조는 각자). 데스크탑은 해체된 방을 읽기 전용 기록으로 남기고, 웹은 소속만
            풀어 One 과의 대화로 이어간다. 어느 쪽이든 **대화는 지워지지 않는다.** */}
        <span><strong>{locale === "ko" ? "이 태스크포스를 삭제할까요?" : "Delete this Taskforce?"}</strong><small>{
          isWebSurface()
            ? (locale === "ko"
              ? "팀은 사라지지만 지금까지의 대화와 메시지는 남아, One과의 대화로 이어집니다."
              : "The team goes away, but its conversations and messages stay and continue with One.")
            : locale === "ko"
              ? (preservedSessionCount !== null
                ? `대화 ${preservedSessionCount}개는 기록으로 남습니다.`
                : "대화는 지워지지 않고 기록으로 남습니다.")
              : (preservedSessionCount !== null
                ? `${preservedSessionCount} conversation${preservedSessionCount === 1 ? "" : "s"} will stay as a read-only archive.`
                : "Conversations are kept as a read-only archive.")
        }</small></span>
        <button type="button" onClick={() => setConfirmRemove(false)} disabled={busy}><IconClose size={12} />{locale === "ko" ? "취소" : "Cancel"}</button>
        <button type="button" className={styles.dangerButton} onClick={() => void onRemove({ id: taskforce.id, expectedRevision: taskforce.revision })} disabled={busy}>{locale === "ko" ? "삭제" : "Delete"}</button>
      </div>}
      <div className={styles.dialogActions}>
        {taskforce && !confirmRemove ? <button type="button" className={styles.removeButton} onClick={() => setConfirmRemove(true)} disabled={busy}>{locale === "ko" ? "태스크포스 삭제" : "Delete Taskforce"}</button> : <span />}
        <button type="button" onClick={onClose} disabled={busy}>{locale === "ko" ? "취소" : "Cancel"}</button>
        <button type="button" className={styles.primaryButton} onClick={() => void submit()} disabled={busy || !title.trim()}>{busy ? (locale === "ko" ? "저장 중…" : "Saving…") : taskforce ? (locale === "ko" ? "저장" : "Save") : (locale === "ko" ? "만들기" : "Create")}</button>
      </div>
    </div>
  </OneBottomSheet>;
}
