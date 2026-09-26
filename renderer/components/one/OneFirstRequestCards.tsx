"use client";

import { useState } from "react";
import type { Locale } from "@/lib/i18n";
import { IconCircleDollar, IconMegaphone, IconPlus, IconShoppingBag, IconWand } from "../Icon";
import styles from "./OneFirstRequestCards.module.css";

/*
 * 새 세션 추천 작업 (docs/2026-09-25-onboarding-redesign/PLAN.md §5, 오너 2026-09-26).
 *
 * 추천은 **작성창 바로 위**에 선다 — Codex 가 입력창 위에 제안을 세우듯, 사람이 지금
 * 쓰려는 자리에서 고르게 한다(예전에는 빈 대화 본문 한가운데에 있어 새 세션에서
 * 찾을 수 없었다). 모양은 오너가 준 시안(Aside "Suggested tasks")을 기존 토큰으로 옮겼다:
 * 위는 토큰 색 그라데이션 위의 반투명 타일+흰 기호, 아래는 제목 한 줄·설명 두 줄·
 * "이 프롬프트 사용" 알약 단추.
 *
 * 카드는 **보내지 않는다**. 누르면 프롬프트를 지금 입력창에 채우고, 사람이 고쳐서 보낸다.
 * One 의 세 장은 PLAN 표의 영어 프롬프트(오너 결정 2026-09-25)이고, 좌석 에이전트의 카드는
 * 그 에이전트 패키지가 선언한 defaultPrompts 에서만 온다(하드코딩 없음, 없으면 블록도 없다).
 *
 * 홈·새 One 세션·단톡방·좌석 세션이 **같은 선택 함수**를 쓴다(`oneFirstRequestCardsEntry`).
 * 입구마다 조건을 따로 쓰면 한쪽만 카드가 사라지거나 남는다.
 */
export type OneSuggestionIcon = "megaphone" | "dollar" | "bag" | "wand";

export interface OneSuggestionCard {
  id: string;
  title: string;
  description: string | null;
  prompt: string;
  icon: OneSuggestionIcon;
}

export interface OneFirstRequestCard {
  id: "grow-social" | "stock-newsletter" | "store-homepage";
  title: Record<Locale, string>;
  description: Record<Locale, string>;
  prompt: string;
  icon: OneSuggestionIcon;
}

export const ONE_FIRST_REQUEST_CARDS: readonly OneFirstRequestCard[] = [
  {
    id: "grow-social",
    title: { ko: "SNS를 성장시켜줘", en: "Grow my social media" },
    description: {
      ko: "어떤 플랫폼인지 먼저 묻고, 성장 계획과 첫 게시물까지 준비해요.",
      en: "Asks which platform first, then plans growth and drafts the first posts.",
    },
    prompt: "Help me grow my social media. First, ask me which social platform I want to focus on.",
    icon: "megaphone",
  },
  {
    id: "stock-newsletter",
    title: { ko: "보유 주식 뉴스레터를 보내줘", en: "Email me a stock newsletter" },
    description: {
      ko: "보유 종목·받을 주소·시간을 묻고 매일 아침 뉴스 메일을 보내요.",
      en: "Asks for your holdings, address and time, then emails stock news every morning.",
    },
    prompt: "Set up a daily morning email newsletter with news about the stocks I own. First, ask me for my holdings, delivery address, and preferred morning time and time zone.",
    icon: "dollar",
  },
  {
    id: "store-homepage",
    title: { ko: "쇼핑몰 홈페이지를 만들어줘", en: "Build my store homepage" },
    description: {
      ko: "가게 주소와 브랜드 자료, 원하는 느낌을 묻고 홈페이지를 만들어요.",
      en: "Asks for your store URL, brand assets and style, then builds the homepage.",
    },
    prompt: "Build a beautiful homepage for my online store. First, ask me for the store URL, brand assets, and preferred style.",
    icon: "bag",
  },
] as const;

/** One 의 세 장을 화면 언어의 카드로. */
export function oneFirstRequestSuggestionCards(locale: Locale): OneSuggestionCard[] {
  return ONE_FIRST_REQUEST_CARDS.map((card) => ({
    id: card.id,
    title: card.title[locale],
    description: card.description[locale],
    prompt: card.prompt,
    icon: card.icon,
  }));
}

export type OneFirstRequestEntry = "home" | "session" | "group" | "seat";

/**
 * 네 입구의 단일 판정. "첫 요청 전"은 **이 대화에 아직 아무 말도 없고, 실행·준비
 * 중인 것도 없는** 상태다. 담당이 없는 방(해체·빈 자리·사라진 담당)에는 내지 않는다.
 * 1:1 좌석 방은 "seat" — One 의 카드가 아니라 그 에이전트가 선언한 카드만 쓴다
 * (거기서 SNS 성장 프롬프트는 엉뚱한 사람에게 간다).
 */
export function oneFirstRequestCardsEntry(input: {
  hasSelectedTask: boolean;
  hasConversation: boolean;
  messageCount: number;
  busy: boolean;
  preparing: boolean;
  isGroupRoom: boolean;
  isOneSession: boolean;
  isSeatSession?: boolean;
  sessionUnavailable: boolean;
}): OneFirstRequestEntry | null {
  if (input.hasSelectedTask || input.busy || input.preparing) return null;
  if (!input.hasConversation) return "home";
  if (input.messageCount > 0 || input.sessionUnavailable) return null;
  if (input.isGroupRoom) return "group";
  if (input.isOneSession) return "session";
  if (input.isSeatSession) return "seat";
  return null;
}

const ICONS = {
  megaphone: IconMegaphone,
  dollar: IconCircleDollar,
  bag: IconShoppingBag,
  wand: IconWand,
} as const;

export function OneFirstRequestCards({
  locale,
  entry,
  cards,
  onInsert,
  hasDraft = false,
}: {
  locale: Locale;
  entry: OneFirstRequestEntry;
  cards: readonly OneSuggestionCard[];
  /** "replace" puts the prompt in an empty composer (or over the draft when chosen), "append" adds it after the draft. */
  onInsert: (card: OneSuggestionCard, mode: "replace" | "append") => void;
  /** The composer already holds text the owner typed: never overwrite it silently (EDGE-CASES U3). */
  hasDraft?: boolean;
}) {
  const ko = locale === "ko";
  const [asking, setAsking] = useState<string | null>(null);
  if (cards.length === 0) return null;
  return (
    <section
      className={styles.root}
      data-one-first-request-cards={entry}
      aria-label={ko ? "추천 작업" : "Suggested tasks"}
    >
      <h2 className={styles.heading}>{ko ? "추천 작업" : "Suggested tasks"}</h2>
      <ul className={styles.cards}>
        {cards.map((card, index) => {
          const Icon = ICONS[card.icon];
          return (
            <li key={card.id} className={styles.card} data-one-first-request-card={card.id} data-art={index % 3}>
              <div className={styles.art} aria-hidden="true">
                <span className={styles.tile}><Icon size={20} /></span>
              </div>
              <div className={styles.body}>
                <strong className={styles.title} title={card.title}>{card.title}</strong>
                {card.description && <p className={styles.description} title={card.description}>{card.description}</p>}
                <button
                  type="button"
                  className={styles.use}
                  title={card.prompt}
                  aria-label={ko ? `${card.title} — 이 프롬프트 사용` : `${card.title} — Use this prompt`}
                  aria-expanded={hasDraft ? asking === card.id : undefined}
                  onClick={() => {
                    if (hasDraft) { setAsking((current) => (current === card.id ? null : card.id)); return; }
                    onInsert(card, "replace");
                  }}
                >
                  <span>{ko ? "이 프롬프트 사용" : "Use this prompt"}</span>
                  <span aria-hidden="true">↗</span>
                </button>
                {hasDraft && asking === card.id && (
                  <div className={styles.draftChoice} role="group" data-one-first-request-draft-choice={card.id} aria-label={ko ? "작성 중인 글이 있어요" : "You have text in the composer"}>
                    <span>{ko ? "작성 중인 글이 있어요." : "You already typed something."}</span>
                    <button type="button" className={styles.use} data-choice="append" onClick={() => { setAsking(null); onInsert(card, "append"); }}>
                      {ko ? "뒤에 붙이기" : "Add after it"}
                    </button>
                    <button type="button" className={styles.use} data-choice="replace" onClick={() => { setAsking(null); onInsert(card, "replace"); }}>
                      {ko ? "바꾸기" : "Replace it"}
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 홈에서만: 기존 조직 팀원 추가 시트를 연다. */
export function OneSeatAttachLink({ locale, onAttachSeat }: { locale: Locale; onAttachSeat: () => void }) {
  const ko = locale === "ko";
  return (
    <button type="button" className={styles.seatLink} data-one-first-seat-attach="true" onClick={onAttachSeat}>
      <IconPlus size={13} />
      <span>{ko ? "에이전트 팀원 추가하기" : "Add an agent teammate"}</span>
    </button>
  );
}

/**
 * 머리말의 "새 세션" — One 이면 빈 One 세션, 좌석이면 그 에이전트와 빈 대화를 연다.
 * 예전에는 "…" 메뉴의 "새 대화"만 있었고, 좌석에서 눌러도 One 홈으로 가 버렸다.
 */
export function OneNewSessionButton({ locale, onClick }: { locale: Locale; onClick: () => void }) {
  const ko = locale === "ko";
  return (
    <button type="button" className={styles.newSession} data-one-new-session-header="true" onClick={onClick}>
      <IconPlus size={14} />
      <span>{ko ? "새 세션" : "New session"}</span>
    </button>
  );
}
