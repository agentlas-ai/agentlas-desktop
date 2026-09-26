/*
 * What's New deck (feature-intro version 2, 2026-09).
 *
 * The version key lives in ONE place: ONE_FEATURE_INTRO_CURRENT_VERSION
 * (shared/one-feature-intro.ts). Main owns who has seen which version, per
 * account. This file only owns the slide list; nothing else counts slides.
 *
 * Research (owner rule: look before building):
 *   - NN/g "Mobile-App Onboarding" / "Onboarding Tutorials vs. Contextual Help":
 *     deck-of-cards tutorials strain memory — if used, keep few cards, one
 *     concept per card, and a highly visible Skip.
 *   - Linear changelog: each update = one headline, one visual, one short note,
 *     framed as what you can do now.
 *   - Apple "What's New" sheets / Notion release popups: shown once after an
 *     update, dismissible, reachable again later.
 */

export type WhatsNewAction = "mail" | "delegate" | "newSession" | "addTeammate" | "work" | "mobile";

export interface WhatsNewSlide {
  id: WhatsNewAction;
  kicker: { ko: string; en: string };
  title: { ko: string; en: string };
  /** ≤ 2 lines at the card width. */
  body: { ko: string; en: string };
  /** Primary action label. Absent = the button just moves to the next slide. */
  cta?: { ko: string; en: string };
  /** Feature illustration in the packaged renderer assets. */
  image: string;
}

export const WHATS_NEW_SLIDES: readonly WhatsNewSlide[] = [
  {
    id: "mail",
    kicker: { ko: "새 기능 · One 메일함", en: "NEW · ONE MAILBOX" },
    title: { ko: "에이전트 전용 메일 주소가 생겼어요", en: "Your agent now has its own email address" },
    body: {
      ko: "받은·보낸·임시보관함을 지메일처럼 씁니다. 주소는 한 번 정하면 바뀌지 않아요.",
      en: "Inbox, Sent, and Drafts work like Gmail. Once you pick the address, it stays yours.",
    },
    cta: { ko: "메일 주소 만들기", en: "Create an address" },
    image: "/feature-updates/one-whats-new-mail.webp",
  },
  {
    id: "delegate",
    kicker: { ko: "새 기능 · 팀원에게 맡기기", en: "NEW · DELEGATION" },
    title: { ko: "One이 팀원에게 일을 맡겨요", en: "One hands work to your teammates" },
    body: {
      ko: "One이 팀원 세션을 열어 일을 맡기고, 끝나면 결과를 받아 와서 알려 줍니다.",
      en: "One opens a teammate's session, hands off the task, and brings the result back to you.",
    },
    image: "/feature-updates/one-whats-new-delegate.webp",
  },
  {
    id: "newSession",
    kicker: { ko: "새 기능 · 새 세션", en: "NEW · SESSIONS" },
    title: { ko: "새 세션과 추천 작업 카드", en: "New sessions with suggested tasks" },
    body: {
      ko: "새 세션을 열면 지금 하기 좋은 작업이 카드로 떠요. 눌러서 바로 시작하세요.",
      en: "Open a new session and the tasks worth doing now appear as cards. Tap one to start.",
    },
    cta: { ko: "새 세션 열기", en: "Open a new session" },
    image: "/feature-updates/one-whats-new-new-session.webp",
  },
  {
    id: "addTeammate",
    kicker: { ko: "새 기능 · 팀원 추가", en: "NEW · TEAMMATES" },
    title: { ko: "에이전트 팀원을 추가하세요", en: "Add agent teammates" },
    body: {
      ko: "필요한 역할의 에이전트를 팀원으로 앉히면 One이 함께 일을 나눕니다.",
      en: "Seat an agent in the role you need, and One shares the work with it.",
    },
    cta: { ko: "팀원 추가하기", en: "Add a teammate" },
    image: "/feature-updates/one-whats-new-add-teammate.webp",
  },
  {
    id: "work",
    kicker: { ko: "새 기능 · Work", en: "NEW · WORK" },
    title: { ko: "Work가 팀을 알아서 꾸려요", en: "Work builds the team for you" },
    body: {
      ko: "목표만 말하면 Work가 자동으로 팀을 구성합니다. Work 에이전트는 무료예요.",
      en: "Describe the goal and Work assembles the team. Work agents are free.",
    },
    cta: { ko: "Work 열기", en: "Open Work" },
    image: "/feature-updates/one-whats-new-work.webp",
  },
  {
    id: "mobile",
    kicker: { ko: "새 기능 · 모바일", en: "NEW · MOBILE" },
    title: { ko: "모바일에서도 메일함과 One 설정", en: "Mailbox and One settings on mobile" },
    body: {
      ko: "휴대폰에서 메일함을 확인하고 One의 이름·말투 같은 설정을 바꿀 수 있어요.",
      en: "Check the mailbox and change One's name, tone, and other settings from your phone.",
    },
    cta: { ko: "모바일 연결하기", en: "Connect mobile" },
    image: "/feature-updates/one-whats-new-mobile.webp",
  },
];

/** Settings → "새 기능 다시 보기": ask One to open the deck (same window). */
export const WHATS_NEW_OPEN_EVENT = "agentlas:whats-new-open";
/** Survives the route change from Settings to One (sessionStorage, one shot). */
export const WHATS_NEW_REPLAY_FLAG = "agentlas.whatsNew.replay";

export function requestWhatsNewReplay(): void {
  try { window.sessionStorage.setItem(WHATS_NEW_REPLAY_FLAG, "1"); } catch { /* event still covers a mounted One */ }
  window.dispatchEvent(new Event(WHATS_NEW_OPEN_EVENT));
}

export function takeWhatsNewReplayRequest(): boolean {
  try {
    if (window.sessionStorage.getItem(WHATS_NEW_REPLAY_FLAG) !== "1") return false;
    window.sessionStorage.removeItem(WHATS_NEW_REPLAY_FLAG);
    return true;
  } catch {
    return false;
  }
}
