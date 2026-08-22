"use client";

import { useMemo, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { isDocumentLikeText } from "@/lib/one-doc-like";
import type { OneOrgMember, OneOrgState, OneOrgStatusKind } from "@shared/one-org";
import type { OneActivityHandoff, OneActivityHandoffMessage, OneActivityState } from "@/lib/one-activity";
import { OneAgentPortrait } from "./OneAgentPortrait";
import styles from "./OneTaskforceConversation.module.css";

type Locale = "ko" | "en";

interface Speaker {
  id: string;
  name: string;
  tone: string;
  status: OneOrgStatusKind;
  one: boolean;
}

interface ConversationMessage {
  message: OneActivityHandoffMessage;
  handoff: OneActivityHandoff;
  speaker: Speaker;
  recipient: Speaker;
  replyTarget?: {
    message: OneActivityHandoffMessage;
    speaker: Speaker;
  };
}

function isOneNode(id: string): boolean {
  return /(?:^|:)borrow-orchestrator$/.test(id) || id === "one" || id === "agentlas-one";
}

function memberForNode(org: OneOrgState | null, nodeId: string): OneOrgMember | undefined {
  return org?.members.find((member) => (
    nodeId === member.installedAgentId
    || nodeId === member.agentSlug
    || nodeId.endsWith(`:${member.agentSlug}`)
    || nodeId.includes(`:${member.agentSlug}:`)
  ));
}

function fallbackNodeName(id: string): string {
  const tail = id.split(":").filter(Boolean).at(-1) ?? id;
  return tail
    .replace(/-[0-9a-f]{8}$/i, "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(" ") || "Agent";
}

function handoffName(handoff: OneActivityHandoff, id: string): string | undefined {
  if (handoff.fromAgentId === id) return handoff.fromAgentName;
  if (handoff.toAgentId === id) return handoff.toAgentName;
  return undefined;
}

function speakerFor(org: OneOrgState | null, handoff: OneActivityHandoff, id: string): Speaker {
  if (isOneNode(id)) {
    return { id, name: "One", tone: "purple", status: "quiet", one: true };
  }
  const member = memberForNode(org, id);
  const unavailable = !member || Boolean(member.archivedAt) || member.statusKind === "locked" || member.statusKind === "failed";
  return {
    id,
    name: member?.displayName || handoffName(handoff, id) || fallbackNodeName(id),
    tone: member?.icon ?? "character:blue-wave-2d",
    status: unavailable ? "locked" : member.statusKind,
    one: false,
  };
}

function timeLabel(value: string, locale: Locale): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  return parsed.toLocaleTimeString(locale === "ko" ? "ko-KR" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function deliveryLabel(handoff: OneActivityHandoff, message: OneActivityHandoffMessage, locale: Locale): string {
  if (handoff.status === "failed") return locale === "ko" ? "전달 실패" : "Delivery failed";
  if (handoff.status === "cancelled") return locale === "ko" ? "중단됨" : "Stopped";
  if (message.direction === "worker-to-orchestrator") return locale === "ko" ? "공유함" : "Shared";
  if (handoff.status === "running") return locale === "ko" ? "작업 중" : "Working";
  return locale === "ko" ? "전달됨" : "Sent";
}

function visibleAgentText(value: string, locale: Locale): string {
  // Machine receipts remain in the run ledger. The group room is for what the
  // teammate said, so strip the explicit receipt appendix without inferring
  // state from prose.
  if (/^Completed peer updates:/i.test(value.trim())) {
    return locale === "ko"
      ? "앞서 완료된 동료들의 작업 결과를 공유했어요. 이어서 검토해 주세요."
      : "I shared the completed teammates' results. Please continue the review.";
  }
  const receiptAt = value.search(/(?:#{1,6}\s*)?HANDOFF FACTS\b/i);
  const withoutReceipt = receiptAt >= 0 ? value.slice(0, receiptAt) : value;
  // These are host/model control envelopes, never words that One said in the
  // room. New events are cleaned before they are emitted; this renderer guard
  // also keeps transcripts recorded by an older build readable.
  const withoutControlEnvelopes = withoutReceipt
    .replace(/\[\s*Host-confirmed facts for this run\s*\][\s\S]*?\[\s*\/\s*Host-confirmed facts for this run\s*\]/gi, "")
    .replace(/\[\s*이번 실행의 호스트 확인 사실\s*\][\s\S]*?\[\s*\/\s*이번 실행의 호스트 확인 사실\s*\]/giu, "")
    .replace(/\[\s*Agentlas One execution boundary\s*\][\s\S]*?\[\s*\/\s*Agentlas One execution boundary\s*\]/gi, "")
    .replace(/\[\s*Agentlas One 실행 경계\s*\][\s\S]*?\[\s*\/\s*Agentlas One 실행 경계\s*\]/giu, "")
    .replace(/\[\s*(?:Host-confirmed facts for this run|이번 실행의 호스트 확인 사실|Agentlas On(?:e)?)[\s\S]*?\[\s*middle omitted\s*\]\s*(?:…|\.\.\.)?\s*/giu, "");
  // Runtime-qualified failure tags belong to the ledger/settings view. In the
  // room the teammate should simply say what went wrong.
  const withoutRuntimeTag = withoutControlEnvelopes.replace(
    /^\s*\[\s*(?:(?:installed|local|cloud|hub):)?[^\]\n]+?\s+(?:error|failed|cancelled)\s*\]\s*/i,
    "",
  );
  // Opaque execution identifiers are useful for Settings > diagnostics, not
  // for the room. Keep them in the typed ledger and remove both dedicated ID
  // lines and inline label/value pairs from the human-facing projection.
  const withoutMachineIds = withoutRuntimeTag
    .split("\n")
    .filter((line) => !/^\s*(?:[-*]\s*)?(?:(?:task|run)(?:\s+id)?|(?:작업|실행)(?:\s*(?:id|아이디)))\s*[:=]\s*\S+\s*$/iu.test(line))
    .join("\n")
    .replace(/\b(?:task|run)(?:\s+id)?\s*[:=]\s*[a-z0-9][a-z0-9._:-]{5,}\b/giu, "")
    .replace(/(?:작업|실행)(?:\s*(?:id|아이디))\s*[:=]\s*[a-z0-9][a-z0-9._:-]{5,}\b/giu, "");
  // A worker can still use infrastructure jargon in otherwise good prose.
  // Translate that jargon to the result the person cares about, while the
  // original typed payload remains untouched in the internal ledger.
  const withoutReceiptJargon = withoutMachineIds
    .replace(/실제\s*호출\s*영수증에\s*근거해/gu, "실제 호출 결과에 근거해")
    .replace(/(?:호출|도구|실행)\s*영수증/gu, "실행 결과")
    .replace(/영수증/gu, "결과")
    .replace(/\b(?:call|tool|execution)\s+receipts?\b/gi, "verified results")
    .replace(/\breceipts?\b/gi, "results");
  // Global agent/skill protocols belong to the worker runtime, not to the
  // shared room. Historical events may already be whitespace-compacted, so
  // remove the short protocol preamble here as well as at event creation.
  const withoutRuntimePreamble = withoutReceiptJargon
    .replace(/^\s*(?:Skills used|사용 스킬)\s*:[^.!?\n]*(?:[.!?]\s+|(?:\r?\n)+)/iu, "")
    .replace(/^\s*(?:Reason|이유)\s*:[^.!?\n]*(?:[.!?]\s+|(?:\r?\n)+)/iu, "")
    .replace(/^\s*(?:I['’]m using|Using)\b.*?\.\s+(?=(?:\*\*)?\[Hope\]|(?:\*\*)?Finding\b|Initial\b|The\b|#)/iu, "")
    .replace(/\*{0,2}\[Hope\]\*{0,2}\s*/giu, "")
    .replace(/\*{0,2}Finding\s*\/\s*result\s*:?\*{0,2}\s*/giu, "")
    .replace(/\s*#{0,6}\s*STATUS\s+(?:COMPLETED|PARTIAL|FAILED)\b[\s\S]*$/iu, "");
  return withoutRuntimePreamble.trim();
}

function visibleCoordinatorText(value: string, locale: Locale): string {
  const cleaned = visibleAgentText(value, locale);
  const unsupportedPastClaim = /\b(?:I|we)\s+(?:have\s+|already\s+)?(?:saved|created|completed|finished|uploaded|published|verified|generated|updated|fixed|built)\b|(?:저장|생성|완료|업로드|게시|검증|수정|빌드)(?:했|됐|해뒀|되었습니다)/iu;
  return (cleaned.match(/[^.!?]+(?:[.!?]+|$)/gu) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !unsupportedPastClaim.test(sentence))
    .join(" ")
    .trim();
}

function MessageText({
  text,
  messageId,
  locale,
  coordinationOnly = false,
}: {
  text: string;
  messageId: string;
  locale: Locale;
  coordinationOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const normalized = coordinationOnly
    ? visibleCoordinatorText(text, locale)
    : visibleAgentText(text, locale);
  const finding = (() => {
    const match = normalized.match(/\bfinding\s*\/\s*result\s*:\s*/i);
    if (!match || match.index == null) return null;
    const rest = normalized.slice(match.index + match[0].length);
    const detailAt = rest.search(/\s+(?:evidence\s*(?:\/\s*(?:reasoning\s*)?basis)?|assumptions?|risks?|LIMITATIONS|STATUS)\s*:/i);
    const summary = (detailAt >= 0 ? rest.slice(0, detailAt) : rest).trim();
    return summary || null;
  })();
  const long = normalized.length > 1_200;
  const collapsible = Boolean(finding) || long;
  const visible = !expanded && finding
    ? finding
    : long && !expanded
      ? `${normalized.slice(0, 1_080).trimEnd()}…`
      : normalized;
  return <>
    <div className={styles.markdown}><Markdown text={visible} messageId={`taskforce:${messageId}`} /></div>
    {collapsible && <button type="button" className={styles.more} onClick={() => setExpanded((value) => !value)}>
      {expanded
        ? (locale === "ko" ? "간단히 보기" : "Show summary")
        : finding
          ? (locale === "ko" ? "작업 근거" : "Work details")
          : (locale === "ko" ? "더 보기" : "Show more")}
    </button>}
  </>;
}

/**
 * Human-facing projection of the typed One ↔ worker message envelopes.
 * Machine execution metadata intentionally remains in the durable ledger.
 */
export function OneTaskforceConversation({
  state,
  org,
  locale,
}: {
  state: OneActivityState;
  org: OneOrgState | null;
  locale: Locale;
}) {
  const messages = useMemo(() => {
    const seen = new Set<string>();
    const rows: ConversationMessage[] = [];
    for (const handoff of state.handoffs) {
      for (const message of handoff.messages) {
        if (seen.has(message.id)) continue;
        const speaker = speakerFor(org, handoff, message.fromAgentId);
        // A machine-only envelope has no place in the shared room. It remains
        // available to the internal ledger without creating an empty or
        // receipt-shaped chat bubble for the user.
        const visibleText = speaker.one && message.direction === "orchestrator-to-worker"
          ? visibleCoordinatorText(message.text, locale)
          : visibleAgentText(message.text, locale);
        if (!visibleText) continue;
        seen.add(message.id);
        rows.push({
          message,
          handoff,
          speaker,
          recipient: speakerFor(org, handoff, message.toAgentId),
        });
      }
    }
    const sorted = rows.sort((left, right) => left.message.observedAt.localeCompare(right.message.observedAt));
    const byMessageId = new Map(sorted.map((row) => [row.message.id, row]));
    return sorted.map((row, index) => {
      const explicitParent = row.message.replyToMessageId
        ? byMessageId.get(row.message.replyToMessageId)
        : undefined;
      if (explicitParent) {
        return { ...row, replyTarget: { message: explicitParent.message, speaker: explicitParent.speaker } };
      }
      // Peer-to-peer messages carry typed sender/recipient identities. When a
      // teammate addresses a peer who already spoke, present that relationship
      // as a Buzz-style comment instead of inventing a second chat protocol.
      if (row.speaker.one || row.recipient.one) return row;
      const parent = sorted.slice(0, index).reverse().find((candidate) => candidate.speaker.id === row.recipient.id);
      return parent ? { ...row, replyTarget: { message: parent.message, speaker: parent.speaker } } : row;
    });
  }, [locale, org, state.handoffs]);

  const threads = useMemo(() => {
    const childrenByParent = new Map<string, typeof messages>();
    const topLevel: typeof messages = [];
    for (const row of messages) {
      const parentId = row.replyTarget?.message.id;
      if (parentId) {
        const list = childrenByParent.get(parentId) ?? [];
        list.push(row);
        childrenByParent.set(parentId, list);
      } else {
        topLevel.push(row);
      }
    }
    return { topLevel, childrenByParent };
  }, [messages]);
  const [expandedThreads, setExpandedThreads] = useState<ReadonlySet<string>>(new Set());

  if (messages.length === 0) return null;

  const renderEntry = (row: (typeof messages)[number]) => {
    const { message, handoff, speaker, recipient, replyTarget } = row;
    const documentLike = isDocumentLikeText(message.text);
    return (
      <article
        key={message.id}
        className={styles.entry}
        data-one-taskforce-message="true"
        data-agent-message-id={message.id}
        data-direction={message.direction}
        data-status={handoff.status}
        data-threaded={replyTarget ? "true" : "false"}
        role="listitem"
      >
        {/* 화자(캐릭터+이름)가 위, 내용이 그 아래 — 캐릭터가 본문 옆에 떠 있지 않게 한다(오너 지시). */}
        <header className={styles.entryHeader}>
          <OneAgentPortrait status={speaker.status} label={speaker.name} tone={speaker.tone} size="small" />
          <strong>{speaker.name}</strong>
          <span className={styles.delivery} data-status={handoff.status}>{deliveryLabel(handoff, message, locale)}</span>
          <time dateTime={message.observedAt}>{timeLabel(message.observedAt, locale)}</time>
        </header>
        {replyTarget && (
          <div className={styles.replyContext} data-reply-to={replyTarget.message.id}>
            <strong>{speaker.one
              ? (locale === "ko" ? `${replyTarget.speaker.name}에게 답장` : `Reply to ${replyTarget.speaker.name}`)
              : (locale === "ko" ? `${replyTarget.speaker.name}의 메시지에 댓글` : `Comment on ${replyTarget.speaker.name}'s message`)}</strong>
            <span>{(replyTarget.speaker.one && replyTarget.message.direction === "orchestrator-to-worker"
              ? visibleCoordinatorText(replyTarget.message.text, locale)
              : visibleAgentText(replyTarget.message.text, locale)).slice(0, 140)}</span>
          </div>
        )}
        <div className={styles.bubble} data-doc={documentLike ? "true" : undefined}>
          {(replyTarget || !recipient.one) && <span className={styles.mention}>@{replyTarget?.speaker.name ?? recipient.name}</span>}
          <MessageText
            text={message.text}
            messageId={message.id}
            locale={locale}
            coordinationOnly={speaker.one && message.direction === "orchestrator-to-worker"}
          />
        </div>
      </article>
    );
  };

  return <div className={styles.conversation} role="list" aria-label={locale === "ko" ? "태스크포스 대화" : "Taskforce conversation"}>
    {threads.topLevel.map((row) => {
      const children = threads.childrenByParent.get(row.message.id) ?? [];
      const open = expandedThreads.has(row.message.id);
      return (
        <div key={row.message.id} className={styles.thread}>
          {renderEntry(row)}
          {children.length > 0 && (
            <button
              type="button"
              className={styles.replies}
              aria-expanded={open}
              onClick={() => setExpandedThreads((current) => {
                const next = new Set(current);
                if (next.has(row.message.id)) next.delete(row.message.id);
                else next.add(row.message.id);
                return next;
              })}
            >
              {open
                ? (locale === "ko" ? "답글 접기" : "Hide replies")
                : (locale === "ko" ? `답글 ${children.length}개 보기` : `+${children.length} ${children.length === 1 ? "reply" : "replies"}`)}
            </button>
          )}
          {open && children.map((child) => renderEntry(child))}
        </div>
      );
    })}
  </div>;
}
