"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AttentionDot } from "@/components/AttentionDot";
import { IconAlertTriangle, IconClose } from "@/components/Icon";
import { useChatAttention } from "@/lib/attention";
import type { OneOrgMember } from "@shared/one-org";
import type { Chat } from "@shared/types";
import { OneAgentPortrait } from "./OneAgentPortrait";
import { OneRunComet, oneRunCometHostClass } from "./OneRunComet";
import styles from "./OneShell.module.css";

/** 카드 제목에 들어가는 이름 — 원시 시스템 봉투·마크다운·매달린 구두점을 숨기고 짧게 자른다. */
export function briefingSourceName(raw: string, locale: "ko" | "en"): string {
  const trimmed = raw.trim();
  if (/^[{[]/.test(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const candidate = [record.title, record.name, record.label, record.task, record.request]
          .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
        if (candidate) return briefingSourceName(candidate, locale);
      }
      return locale === "ko" ? "현재 작업" : "Current work";
    } catch {
      return locale === "ko" ? "현재 작업" : "Current work";
    }
  }
  const cleaned = trimmed
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>|{}[\]]/g, " ")
    .replace(/\s+([:;,.!?])/g, "$1")
    .replace(/(?:\s*[:;,\-–—|/\\])+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return locale === "ko" ? "현재 작업" : "Current work";
  return cleaned.length > 44 ? `${cleaned.slice(0, 43).trimEnd()}…` : cleaned;
}

export function sessionListTime(iso: string, locale: "ko" | "en"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const difference = Math.floor((start - day) / 86_400_000);
  if (difference <= 0) return date.toLocaleTimeString(locale === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", {
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" as const }),
    month: "numeric",
    day: "numeric",
  });
}

/** What the row reads from a conversation: a real Chat fits, and so does the light row the Workspace menu builds. */
export type ConversationListItem = Pick<Chat, "id" | "title" | "updatedAt" | "seatKind"> & { lastMessagePreview?: string };
export type ConversationListFace = Pick<OneOrgMember, "statusKind" | "icon">;
export type ConversationListGroupFace = Pick<OneOrgMember, "installedAgentId" | "archivedAt" | "statusKind" | "displayName" | "icon">;
/** Extra attributes for the row's main button (drag, context menu, `data-*` marks). Never the click, class, type or title. */
export type ConversationRowButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "className" | "onClick" | "title" | "children">
  & { [attribute: `data-${string}`]: string | undefined };

/**
 * One session-list row: faces (a group's are overlapped), title, time, one-line preview and the delete cross.
 * `buttonProps`, `trailing`, `hideDelete` and `showOne` only add: with none of them the markup is the One Session list's, byte for byte.
 */
export function ConversationListButton({ item, active, locale, onOpen, onRemove, seatLabel, running, spinning = false, unavailable, member = null, groupMembers = [], oneAvatarTone = "character:orange-dino", oneName = "One", buttonProps, trailing, hideDelete = false, showOne = true, plain = false }: {
  item: ConversationListItem;
  active: boolean;
  locale: "ko" | "en";
  onOpen: (chatId: string) => void;
  onRemove: (chatId: string) => Promise<void>;
  seatLabel?: string;
  running?: boolean;
  spinning?: boolean;
  unavailable?: boolean;
  member?: ConversationListFace | null;
  groupMembers?: ConversationListGroupFace[];
  oneAvatarTone?: string;
  oneName?: string;
  buttonProps?: ConversationRowButtonProps;
  /** Drawn at the row's lower right (the pin mark). */
  trailing?: ReactNode;
  hideDelete?: boolean;
  /** A group's overlapped faces start with the personal agent's. A room that has none shows its first three members instead. */
  showOne?: boolean;
  /** Name only: no time and no preview line (the Workspace list, F-D3). Off, the markup is the One Session list's, byte for byte. */
  plain?: boolean;
}) {
  const isGroup = item.seatKind === "group" || groupMembers.length > 0;
  const attention = useChatAttention(item.id);
  const roomTitle = seatLabel?.trim() || briefingSourceName(item.title, locale);
  const unavailableCopy = locale === "ko"
    ? "에이전트가 사라져 세션을 계속할 수 없습니다."
    : "The agent is gone, so this session cannot continue.";
  const preview = unavailable ? unavailableCopy : (item.lastMessagePreview?.trim() || briefingSourceName(item.title, locale));
  return (
    <div className={styles.conversationRow} data-unavailable={unavailable ? "true" : "false"}>
      <button type="button" className={`${styles.taskButton} ${styles.sessionButton} ${oneRunCometHostClass}`} data-active={active ? "true" : "false"} data-plain={plain ? "true" : undefined} data-one-running={spinning ? "true" : "false"} title={roomTitle} onClick={() => onOpen(item.id)} aria-current={active ? "page" : undefined} {...buttonProps}>
        {isGroup ? <span className={styles.sessionGroupAvatar} data-faces={plain ? "group" : undefined} aria-label={roomTitle}>
          {showOne && <OneAgentPortrait status="quiet" label={oneName} tone={oneAvatarTone} size="small" />}
          {groupMembers.slice(0, showOne ? 2 : 3).map((groupMember) => (
            <OneAgentPortrait key={groupMember.installedAgentId} status={groupMember.archivedAt ? "locked" : groupMember.statusKind} label={groupMember.displayName} tone={groupMember.icon} size="small" />
          ))}
        </span> : <OneAgentPortrait
          status={unavailable ? "locked" : member?.statusKind ?? "quiet"}
          label={roomTitle}
          tone={member?.icon ?? oneAvatarTone}
          size="small"
        />}
        <span className={styles.sessionCopy}>
          <span className={styles.sessionTitleLine}>
            <strong>{roomTitle}</strong>
            {plain && running ? <span className={styles.sessionRunningDot} role="img" aria-label={locale === "ko" ? "실행 중" : "Running"} /> : null}
            {/* 화면 밖에서 오너를 기다리는 대화(승인·질문·안 본 결과) — 파란 점(lib/attention). */}
            <AttentionDot counts={attention} locale={locale} className={styles.sessionAttentionDot} />
            {unavailable && <span className={styles.sessionWarning} aria-label={locale === "ko" ? "에이전트 없음" : "Agent unavailable"}><IconAlertTriangle size={14} strokeWidth={2} /></span>}
            {plain ? null : <time dateTime={item.updatedAt}>{sessionListTime(item.updatedAt, locale)}</time>}
          </span>
          {plain ? null : <small>{running && <span className={styles.sessionRunningDot} aria-hidden="true" />}{preview}</small>}
        </span>
        <OneRunComet running={spinning} locale={locale} />
      </button>
      {trailing}
      {hideDelete ? null : <button type="button" className={styles.conversationDelete} onClick={(event) => { event.stopPropagation(); void onRemove(item.id); }} aria-label={locale === "ko" ? "대화 삭제" : "Delete conversation"}><IconClose size={12} /></button>}
    </div>
  );
}
