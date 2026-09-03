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
    return { id, name: "One", tone: "character:orange-dino", status: "quiet", one: true };
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

/**
 * 이 메시지에 실제로 무슨 일이 있었는가 — **묶음 전체가 아니라 이 줄에 대해.**
 *
 * ★실측 2026-08-26 (오너 화면): 팀원이 답을 다 써서 화면에 떠 있는데 그 줄에도, 그 줄을
 * 부른 One 의 줄에도 "전달 실패" 가 붙어 있었다. 진짜 원인은 한참 뒤 마지막 정리 단계에서
 * 모델 사용량 한도에 걸린 것이었는데(기록: `claude runtime quota`), 그 실패가 묶음 상태로
 * 올라오면서 **이미 도착한 메시지까지 실패로 칠해졌다.**
 *
 * 도착은 되돌릴 수 없는 사실이다. 뒤에 무슨 일이 나든 이미 전달된 것은 전달된 것이고,
 * 사용자는 눈앞의 답변을 보면서 "실패"를 읽게 되면 제품을 믿을 수 없게 된다.
 *
 * 그래서 실패·중단 딱지는 **도착한 증거가 없는 줄에만** 붙인다:
 *  - 팀원이 말한 줄은 그 자체가 도착의 증거다.
 *  - 팀원에게 보낸 줄은, 같은 묶음에 팀원의 답이 있으면 도착한 것이다.
 */
function messageWasDelivered(handoff: OneActivityHandoff, message: OneActivityHandoffMessage): boolean {
  // 팀원이 말했다 = 그 팀원에게 일이 닿았고 돌아왔다.
  if (message.direction === "worker-to-orchestrator") return true;
  // 보낸 줄은 답이 있으면 닿은 것이다. 시각으로 자르지 않는다 — 같은 묶음의 답이면 충분하고,
  // 관측 시각은 런타임마다 흔들려 경계로 쓰면 도착한 줄을 실패로 되돌린다.
  return handoff.messages.some((candidate) => candidate.direction === "worker-to-orchestrator");
}

function deliveryLabel(handoff: OneActivityHandoff, message: OneActivityHandoffMessage, locale: Locale): string {
  const delivered = messageWasDelivered(handoff, message);
  if (!delivered && handoff.status === "failed") return locale === "ko" ? "전달 실패" : "Delivery failed";
  if (!delivered && handoff.status === "cancelled") return locale === "ko" ? "중단됨" : "Stopped";
  if (message.direction === "worker-to-orchestrator") return locale === "ko" ? "공유함" : "Shared";
  if (handoff.status === "running") return locale === "ko" ? "작업 중" : "Working";
  return locale === "ko" ? "전달됨" : "Sent";
}

function visibleAgentText(value: string, locale: Locale, speakerName?: string): string {
  // Machine receipts remain in the run ledger. The group room is for what the
  // teammate said, so strip the explicit receipt appendix without inferring
  // state from prose.
  if (/^Completed peer updates:/i.test(value.trim())) {
    return locale === "ko"
      ? "앞서 완료된 동료들의 작업 결과를 공유했어요. 이어서 검토해 주세요."
      : "I shared the completed teammates' results. Please continue the review.";
  }
  // Records written by an older build were whitespace-flattened, so markdown
  // structure ("## 근거", "---") sat inline as literal text (G-1). Restore the
  // line breaks those markers imply before any line-anchored cleanup below.
  const restored = value.includes("\n")
    ? value
    : value
        .replace(/\s+(#{1,6})\s+(?=\S)/gu, "\n\n$1 ")
        .replace(/\s+---+\s+/gu, "\n\n");
  // The interactive ask fence renders as its own option card; its raw JSON is
  // wire format, not room prose (G-1 — also stripped at event creation).
  const withoutAskFence = restored
    .replace(/(?:```[a-z]*\s*)?<<agentlas-ask>>[\s\S]*?(?:<<\/agentlas-ask>>\s*(?:```)?|$)/giu, "");
  // 헤더가 발화자를 이미 표기한다 — 워커가 스스로 붙인 이름표 머리말
  // ("**[기획자]**")는 프로토콜 잔재다. 정확히 자기 이름일 때만 벗긴다
  // (구버전 기록 호환; 새 이벤트는 emit 시점에 같은 규칙으로 정리된다).
  const withoutSelfTag = speakerName?.trim()
    ? withoutAskFence.replace(
        new RegExp(`^\\s*\\*{0,2}\\[${speakerName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\*{0,2}\\s*[:：]?\\s*`, "u"),
        "",
      )
    : withoutAskFence;
  const receiptAt = withoutSelfTag.search(/(?:#{1,6}\s*)?HANDOFF FACTS\b/i);
  const withoutReceipt = receiptAt >= 0 ? withoutSelfTag.slice(0, receiptAt) : withoutSelfTag;
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
    // Router/persona protocol lines can sit mid-answer, not only at the start
    // ("Skill used:" singular and "Agents used:" are the same family — G-3).
    .replace(/^\s*(?:Skills?\s+used|Agents?\s+used|사용\s*스킬|사용\s*에이전트)\s*:[^.!?\n]*(?:[.!?]\s+|(?:\r?\n)+|[.!?]?\s*$)/gimu, "")
    .replace(/^\s*(?:Reason|이유)\s*:[^.!?\n]*(?:[.!?]\s+|(?:\r?\n)+|[.!?]?\s*$)/gimu, "")
    .replace(/^\s*(?:I['’]m using|Using)\b.*?\.\s+(?=(?:\*\*)?\[Hope\]|(?:\*\*)?Finding\b|Initial\b|The\b|#)/iu, "")
    .replace(/\*{0,2}\[Hope\]\*{0,2}\s*/giu, "")
    // Global-persona name reference beside a teammate name ("기획자(Hope)") —
    // ambient host identity, never room content (G-2).
    .replace(/\(\s*Hope\s*\)/gu, "")
    .replace(/\*{0,2}Finding\s*\/\s*result\s*:?\*{0,2}\s*/giu, "")
    // Worker report appendix (LIMITATIONS → STATUS) is the orchestrator's
    // review payload; the room shows what the teammate said (G-1). LIMITATIONS
    // matches case-sensitively unless it carries a heading marker.
    .replace(/\s*(?:-{3,}\s*)?(?:#{1,6}\s*)?\*{0,2}LIMITATIONS\*{0,2}\s*[:：]?[\s\S]*$/u, "")
    .replace(/\s*(?:-{3,}\s*)?(?:#{1,6}\s*\*{0,2}|\*{1,2})(?:제한\s*사항|한계)\*{0,2}\s*[:：]?[\s\S]*$/u, "")
    .replace(/\s*(?:-{3,}\s*)?(?:#{1,6}\s*)?\*{0,2}STATUS\*{0,2}\s*[:：]?\s*\*{0,2}(?:COMPLETED|PARTIAL|FAILED)\b[\s\S]*$/iu, "")
    // 부록 절단 뒤 고아 구분선/여는 강조 기호 정리(구버전 기록 호환).
    .replace(/\s*-{3,}\s*\*{0,2}\s*$/u, "");
  return withoutRuntimePreamble.trim();
}

function visibleCoordinatorText(value: string, locale: Locale, speakerName?: string): string {
  const cleaned = visibleAgentText(value, locale, speakerName);
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
  speakerName,
}: {
  text: string;
  messageId: string;
  locale: Locale;
  coordinationOnly?: boolean;
  speakerName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const normalized = coordinationOnly
    ? visibleCoordinatorText(text, locale, speakerName)
    : visibleAgentText(text, locale, speakerName);
  const finding = (() => {
    // Korean workers translate the report labels ("발견/결과:", "근거:",
    // "가정:", "리스크:") — the collapse must recognise both languages or the
    // internal report format dumps raw into the bubble (G-1, desktop-103a).
    const match = normalized.match(/(?:\bfinding\s*\/\s*result|발견\s*[/·]?\s*결과|결과\s*[/·]?\s*발견)\s*[:：]\s*/iu);
    if (!match || match.index == null) return null;
    const rest = normalized.slice(match.index + match[0].length);
    const detailAt = rest.search(/\s+(?:#{1,6}\s*)?(?:evidence\s*(?:\/\s*(?:reasoning\s*)?basis)?|assumptions?|risks?|LIMITATIONS|STATUS|근거|가정|리스크|한계|제한\s*사항|권장\s*사항|오케스트레이터[^:：\n]*)\s*[:：]/iu);
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
          ? visibleCoordinatorText(message.text, locale, speaker.name)
          : visibleAgentText(message.text, locale, speaker.name);
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
              ? visibleCoordinatorText(replyTarget.message.text, locale, replyTarget.speaker.name)
              : visibleAgentText(replyTarget.message.text, locale, replyTarget.speaker.name)).slice(0, 140)}</span>
          </div>
        )}
        {/*
          ★"무엇을 써서 일했나" 는 관측된 사실로만 말한다.

          시연 화면의 `Skill used: …` 줄은 제품이 만든 것이 아니라 호스트 인격의 라우터
          템플릿이 답변 본문으로 샌 것이었고, 그래서 양쪽에서 막혔다(G-2/G-3, 2026-08-25).
          사람이 보고 싶어 한 것 자체는 정당하므로, 모델이 쓴 산문 대신 **실제로 부른 도구**
          를 싣는다. 지어낼 수 없는 값이고, 인격이 스밀 자리가 없다.
        */}
        {message.usedTools && message.usedTools.length > 0 && (
          <div className={styles.usedTools} data-used-tools={message.usedTools.length}>
            <strong>{locale === "ko" ? "사용한 도구" : "Tools used"}</strong>
            {message.usedTools.map((tool) => <span key={tool}>{tool}</span>)}
          </div>
        )}
        <div className={styles.bubble} data-doc={documentLike ? "true" : undefined}>
          {(replyTarget || !recipient.one) && <span className={styles.mention}>@{replyTarget?.speaker.name ?? recipient.name}</span>}
          <MessageText
            text={message.text}
            messageId={message.id}
            locale={locale}
            coordinationOnly={speaker.one && message.direction === "orchestrator-to-worker"}
            speakerName={speaker.name}
          />
        </div>
      </article>
    );
  };

  /*
   * ★댓글의 댓글도 그린다.
   *
   * 여기는 뿌리와 **직계 자식**만 그렸다. 그래서 릴레이 3번째 자리에 선 팀원은
   * — 출처가 로컬이든 빌려온 좌석이든 — 자기 이름 말풍선이 화면에서 통째로
   * 사라졌다. 원장에는 멀쩡히 있고, One 종합이 그 몫을 요약해 다시 적기 때문에
   * 턴은 성공으로 끝난다. 그래서 **그 사람이 자기 이름으로 말한 것만** 조용히
   * 없어졌다(실측 2026-08-26: 3자 릴레이 2회, 매번 3번째가 증발).
   *
   * 깊이 상한과 방문 표시를 둔다. 부모 포인터는 원장에서 오므로 이론상 고리가
   * 생길 수 있고, 화면이 무한히 들어가는 것보다 거기서 멈추는 편이 낫다.
   */
  const MAX_THREAD_DEPTH = 8;
  const renderThread = (
    row: (typeof messages)[number],
    depth: number,
    seen: ReadonlySet<string>,
  ): JSX.Element => {
    const children = depth >= MAX_THREAD_DEPTH || seen.has(row.message.id)
      ? []
      : (threads.childrenByParent.get(row.message.id) ?? []);
    const open = expandedThreads.has(row.message.id);
    const nextSeen = new Set(seen).add(row.message.id);
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
        {open && children.map((child) => renderThread(child, depth + 1, nextSeen))}
      </div>
    );
  };

  return <div className={styles.conversation} role="list" aria-label={locale === "ko" ? "태스크포스 대화" : "Taskforce conversation"}>
    {threads.topLevel.map((row) => renderThread(row, 0, new Set<string>()))}
  </div>;
}
