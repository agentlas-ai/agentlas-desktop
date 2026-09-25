"use client";

import type { Locale } from "@/lib/i18n";
import { IconPlus, IconSparkles } from "../Icon";
import styles from "./OneFirstRequestCards.module.css";

/*
 * One 첫 요청 카드 (docs/2026-09-25-onboarding-redesign/PLAN.md §5).
 *
 * 카드는 **보내지 않는다**. 누르면 영어 프롬프트를 지금 입력창에 채우고, 사람이
 * 고쳐서 보낸다. 프롬프트가 영어인 것은 오너 결정(2026-09-25)이다 — 제목만 화면
 * 언어를 따른다. 첫 질문(어떤 SNS인지, 보유 종목·주소·시각, 가게 주소·자산)은
 * 프롬프트가 모델에게 먼저 묻게 시킨다. 모델이 플랫폼을 추정하지 않게 하는 것이
 * 이 카드의 검증 기준이다.
 *
 * 홈·새 One 세션·단톡방 세 입구가 **같은 선택 함수**를 쓴다(`oneFirstRequestCardsEntry`).
 * 입구마다 조건을 따로 쓰면 한쪽만 카드가 사라지거나 남는다.
 */
export interface OneFirstRequestCard {
  id: "grow-social" | "stock-newsletter" | "store-homepage";
  title: Record<Locale, string>;
  prompt: string;
}

export const ONE_FIRST_REQUEST_CARDS: readonly OneFirstRequestCard[] = [
  {
    id: "grow-social",
    title: { ko: "SNS를 성장시켜줘", en: "Grow my social media" },
    prompt: "Help me grow my social media. First, ask me which social platform I want to focus on.",
  },
  {
    id: "stock-newsletter",
    title: { ko: "보유 주식 뉴스레터를 보내줘", en: "Email me a stock newsletter" },
    prompt: "Set up a daily morning email newsletter with news about the stocks I own. First, ask me for my holdings, delivery address, and preferred morning time and time zone.",
  },
  {
    id: "store-homepage",
    title: { ko: "쇼핑몰 홈페이지를 만들어줘", en: "Build my store homepage" },
    prompt: "Build a beautiful homepage for my online store. First, ask me for the store URL, brand assets, and preferred style.",
  },
] as const;

export type OneFirstRequestEntry = "home" | "session" | "group";

/**
 * 세 입구의 단일 판정. "첫 요청 전"은 **이 대화에 아직 아무 말도 없고, 실행·준비
 * 중인 것도 없는** 상태다. 담당이 없는 방(해체·빈 자리·사라진 담당)과 One 이 아닌
 * 1:1 좌석 방에는 내지 않는다 — 거기서 SNS 성장 프롬프트는 엉뚱한 사람에게 간다.
 */
export function oneFirstRequestCardsEntry(input: {
  hasSelectedTask: boolean;
  hasConversation: boolean;
  messageCount: number;
  busy: boolean;
  preparing: boolean;
  isGroupRoom: boolean;
  isOneSession: boolean;
  sessionUnavailable: boolean;
}): OneFirstRequestEntry | null {
  if (input.hasSelectedTask || input.busy || input.preparing) return null;
  if (!input.hasConversation) return "home";
  if (input.messageCount > 0 || input.sessionUnavailable) return null;
  if (input.isGroupRoom) return "group";
  if (input.isOneSession) return "session";
  return null;
}

export function OneFirstRequestCards({
  locale,
  entry,
  onInsert,
  onAttachSeat,
}: {
  locale: Locale;
  entry: OneFirstRequestEntry;
  onInsert: (card: OneFirstRequestCard) => void;
  /** 홈에서만: 기존 조직 좌석 추가 시트를 연다. */
  onAttachSeat?: () => void;
}) {
  const ko = locale === "ko";
  return (
    <section
      className={styles.root}
      data-one-first-request-cards={entry}
      aria-label={ko ? "첫 요청 예시" : "First request examples"}
    >
      <ul className={styles.cards}>
        {ONE_FIRST_REQUEST_CARDS.map((card) => (
          <li key={card.id}>
            <button
              type="button"
              className={styles.card}
              data-one-first-request-card={card.id}
              title={card.prompt}
              onClick={() => onInsert(card)}
            >
              <IconSparkles size={14} />
              <strong>{card.title[locale]}</strong>
            </button>
          </li>
        ))}
      </ul>
      <p className={styles.hint}>{ko ? "누르면 입력창에 채워져요. 고친 뒤 보내세요." : "Tap to fill the composer. Edit, then send."}</p>
      {onAttachSeat && (
        <button type="button" className={styles.seatLink} data-one-first-seat-attach="true" onClick={onAttachSeat}>
          <IconPlus size={13} />
          <span>{ko ? "에이전트를 좌석에 붙이기" : "Add an agent to a seat"}</span>
        </button>
      )}
    </section>
  );
}
