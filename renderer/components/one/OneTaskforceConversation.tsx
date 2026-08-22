"use client";

import { useMemo, useState } from "react";
import { Markdown } from "@/components/Markdown";
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
  // Runtime-qualified failure tags belong to the ledger/settings view. In the
  // room the teammate should simply say what went wrong.
  const withoutRuntimeTag = withoutReceipt.replace(
    /^\s*\[\s*(?:(?:installed|local|cloud|hub):)?[^\]\n]+?\s+(?:error|failed|cancelled)\s*\]\s*/i,
    "",
  );
  // A worker can still use infrastructure jargon in otherwise good prose.
  // Translate that jargon to the result the person cares about, while the
  // original typed payload remains untouched in the internal ledger.
  const withoutReceiptJargon = withoutRuntimeTag
    .replace(/실제\s*호출\s*영수증에\s*근거해/gu, "실제 호출 결과에 근거해")
    .replace(/(?:호출|도구|실행)\s*영수증/gu, "실행 결과")
    .replace(/영수증/gu, "결과")
    .replace(/\b(?:call|tool|execution)\s+receipts?\b/gi, "verified results")
    .replace(/\breceipts?\b/gi, "results");
  return withoutReceiptJargon.trim();
}

function MessageText({ text, messageId, locale }: { text: string; messageId: string; locale: Locale }) {
  const [expanded, setExpanded] = useState(false);
  const normalized = visibleAgentText(text, locale);
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
        // A machine-only envelope has no place in the shared room. It remains
        // available to the internal ledger without creating an empty or
        // receipt-shaped chat bubble for the user.
        if (!visibleAgentText(message.text, locale)) continue;
        seen.add(message.id);
        rows.push({
          message,
          handoff,
          speaker: speakerFor(org, handoff, message.fromAgentId),
          recipient: speakerFor(org, handoff, message.toAgentId),
        });
      }
    }
    return rows.sort((left, right) => left.message.observedAt.localeCompare(right.message.observedAt));
  }, [locale, org, state.handoffs]);

  if (messages.length === 0) return null;

  return <div className={styles.conversation} role="list" aria-label={locale === "ko" ? "태스크포스 대화" : "Taskforce conversation"}>
    {messages.map(({ message, handoff, speaker, recipient }) => (
      <article
        key={message.id}
        className={styles.entry}
        data-one-taskforce-message="true"
        data-agent-message-id={message.id}
        data-direction={message.direction}
        data-status={handoff.status}
        role="listitem"
      >
        <OneAgentPortrait status={speaker.status} label={speaker.name} tone={speaker.tone} size="small" />
        <div className={styles.content}>
          <header>
            <strong>{speaker.name}</strong>
            <span className={styles.delivery} data-status={handoff.status}>{deliveryLabel(handoff, message, locale)}</span>
            <time dateTime={message.observedAt}>{timeLabel(message.observedAt, locale)}</time>
          </header>
          <div className={styles.bubble}>
            {!recipient.one && <span className={styles.mention}>@{recipient.name}</span>}
            <MessageText text={message.text} messageId={message.id} locale={locale} />
          </div>
        </div>
      </article>
    ))}
  </div>;
}
