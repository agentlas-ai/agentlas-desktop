"use client";

import { useState } from "react";
import { IconChevronDown, IconRoute } from "@/components/Icon";
import type { OneActivityHandoff } from "@/lib/one-activity";
import styles from "./OneHandoffCard.module.css";

function safeName(name: string | undefined, id: string): string {
  const value = name?.trim();
  return value || id;
}

function statusLabel(status: OneActivityHandoff["status"], locale: "ko" | "en"): string {
  if (status === "completed") return locale === "ko" ? "받음" : "Received";
  if (status === "failed") return locale === "ko" ? "실패" : "Failed";
  if (status === "cancelled") return locale === "ko" ? "중단됨" : "Stopped";
  return locale === "ko" ? "진행 중" : "In progress";
}

function timeLabel(value: string, locale: "ko" | "en"): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  return parsed.toLocaleTimeString(locale === "ko" ? "ko-KR" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function OneHandoffCard({
  handoff,
  taskId,
  runId,
  locale,
  canInterrupt = false,
  onInterrupt,
}: {
  handoff: OneActivityHandoff;
  /** The surrounding durable Task/Run binding — never inferred from copy. */
  taskId?: string | null;
  runId?: string | null;
  locale: "ko" | "en";
  canInterrupt?: boolean;
  onInterrupt?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const from = safeName(handoff.fromAgentName, handoff.fromAgentId);
  const to = safeName(handoff.toAgentName, handoff.toAgentId);
  const messagesLabel = locale === "ko"
    ? `${handoff.messages.length}개 메시지`
    : `${handoff.messages.length} ${handoff.messages.length === 1 ? "message" : "messages"}`;
  const receiptLabel = locale === "ko" ? "영수증" : "Receipt";

  return (
    <section
      className={styles.card}
      data-one-handoff="true"
      data-handoff-id={handoff.id}
      data-handoff-status={handoff.status}
    >
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span className={styles.glyph} aria-hidden="true"><IconRoute size={14} /></span>
        <span className={styles.route}>
          <strong>{from} → {to}</strong>
          <span>{messagesLabel}</span>
        </span>
        <span className={styles.status} data-status={handoff.status}>{statusLabel(handoff.status, locale)}</span>
        <span className={styles.chevron} aria-hidden="true"><IconChevronDown size={12} /></span>
      </button>
      {expanded && (
        <div className={styles.body}>
          {handoff.messages.length > 0 ? handoff.messages.map((message) => (
            <div key={message.id} className={styles.message} data-direction={message.direction}>
              <div className={styles.messageMeta}>
                <span>{safeName(message.fromAgentId === handoff.fromAgentId ? handoff.fromAgentName : handoff.toAgentName, message.fromAgentId)} → {safeName(message.toAgentId === handoff.toAgentId ? handoff.toAgentName : handoff.fromAgentName, message.toAgentId)}</span>
                <time dateTime={message.observedAt}>{timeLabel(message.observedAt, locale)}</time>
              </div>
              <p>{message.text}</p>
              <span className={styles.receipt} data-handoff-receipt="true" title={`${receiptLabel}: ${runId ?? "—"}`}>
                {receiptLabel}
              </span>
            </div>
          )) : (
            <p className={styles.empty}>{locale === "ko" ? "메시지 본문은 아직 도착하지 않았습니다." : "No message body has arrived yet."}</p>
          )}
          <div className={styles.footer}>
            <span>{locale === "ko" ? "읽기 전용" : "Read-only"}</span>
            {taskId && <code data-handoff-task-id={taskId}>Task {taskId}</code>}
            {runId && <code data-handoff-run-id={runId}>Run {runId}</code>}
            {canInterrupt && onInterrupt && (
              <button
                type="button"
                className={styles.interrupt}
                onClick={onInterrupt}
                data-handoff-interrupt="true"
              >
                {locale === "ko" ? "끼어들기" : "Interrupt"}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
