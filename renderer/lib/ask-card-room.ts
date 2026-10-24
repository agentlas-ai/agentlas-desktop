/*
 * 묻는 카드가 작성창 위에서 얼마나 클 수 있는가.
 *
 * 카드는 작성창과 같은 푸터 안(결정 슬롯)에 서서 자기 높이만큼 푸터를 키운다. 푸터는 대화 열(flex 열) 안에서
 * 줄어들지 않으므로, 열이 낮으면 카드와 작성창이 열을 다 먹고 대화 영역은 0px 로 잘렸다. 높이 상한(--ask-card-max-height =
 * min(46dvh, 480px))은 창 높이 기준이라 대화 열 위에 제 몫의 겉틀이 많은 화면에서는 모자랐다: Finance 탭은 창 700px 일 때 대화
 * 열이 478px 이고 카드 322 + 작성창 144 + 머리 47 = 513px 가 들어가, 보유 검토 카드의 Save 가 있는 대화 영역이 통째로 사라졌다
 * (조정 세션 F42, 2026-10-21 실앱 측정: 820px 는 안 가리고 700·620px 에서 펼치면 가림).
 *
 * 그래서 상한을 창이 아니라 **카드가 실제로 앉은 열**에서 구한다: 열 높이 − (열 안의 다른 모든 것) − 대화 영역이 남겨야 할 최소.
 * 이 모듈의 계산(askCardPlan)은 DOM 을 모르는 순수 함수다 — 측정 코드(measureAskCardRoom)가 숫자를 읽어 넣는다.
 */

/** 카드가 펼쳐져 있어도 대화 영역이 남겨야 하는 최소 높이. 대화 스크롤 상자는 안쪽 여백(24+24)만으로 이만큼이라, 단추 하나(38px)가 스크롤로 들어올 수 있다. */
export const ASK_THREAD_MIN_PX = 48;
/** 카드가 줄어도 보기 목록이 이만큼은 보인다(보기 한 줄 = --ask-option-height 44px). 이보다 좁으면 카드는 접힌 채로 시작한다. */
export const ASK_OPTION_PEEK_PX = 44;
/** 사용자가 좁은 열에서 일부러 펼쳐도 카드가 이보다 작아지지 않는다(머리 + 한 줄). 그 아래는 카드 안에서 스크롤한다. */
export const ASK_CARD_FLOOR_PX = 160;
/** 카드를 펼친 채 재 본 적이 없어 줄어들지 않는 부분의 높이를 모를 때의 어림(머리·입력 줄·동작 줄·여백, 2026-10-21 실측 198px). */
export const ASK_CARD_FIXED_FALLBACK_PX = 200;

export interface AskCardRoomMetrics {
  /** 대화 열(카드가 앉은 flex 열)의 안쪽 높이. */
  columnHeight: number;
  /** 열 안에서 대화 영역과 이 카드를 뺀 모든 것(머리·알림·작성창·다른 카드)의 높이. */
  otherHeight: number;
  /** 줄어들지 않는 카드 부분(머리·입력 줄·동작 줄·여백)의 높이. */
  cardFixedHeight: number;
  /** 줄어드는 카드 부분(보기 목록·본문)의 자연 높이. */
  shrinkableHeight: number;
}

export interface AskCardPlan {
  /** 대화 영역에 최소를 남기고 카드가 쓸 수 있는 높이(음수일 수 있다). */
  room: number;
  /** 이 이하로 줄이면 카드가 쓸모없다: 줄어들지 않는 부분 + 보기 한 줄. */
  minHeight: number;
  /** 열이 이 카드를 쓸 만하게 펼쳐 둘 만큼 높지 않다 — 접힌 채로 시작한다. */
  tight: boolean;
  /** 펼쳤을 때의 높이 상한(px). 넉넉하면 room, 좁으면 사용자가 일부러 펼친 경우라 FLOOR 와 room 중 큰 값. */
  maxHeight: number;
}

export function askCardPlan(metrics: AskCardRoomMetrics): AskCardPlan {
  const room = Math.floor(metrics.columnHeight - metrics.otherHeight - ASK_THREAD_MIN_PX);
  const minHeight = Math.ceil(metrics.cardFixedHeight + Math.min(metrics.shrinkableHeight, ASK_OPTION_PEEK_PX));
  const tight = room < minHeight;
  return { room, minHeight, tight, maxHeight: tight ? Math.max(room, ASK_CARD_FLOOR_PX) : room };
}

export function sameAskCardPlan(a: AskCardPlan | null, b: AskCardPlan | null): boolean {
  return a === b || Boolean(a && b && a.room === b.room && a.minHeight === b.minHeight && a.tight === b.tight && a.maxHeight === b.maxHeight);
}

/** 카드가 앉은 대화 열: 결정 슬롯에서 위로 올라가며 처음 만나는, 대화 영역(flex-grow 자식)을 거느린 flex 열. */
export interface AskCardColumn {
  element: HTMLElement;
  /** 열의 자식 중 대화 영역(늘어나는 자식). */
  grow: HTMLElement;
}

export function findAskCardColumn(card: HTMLElement): AskCardColumn | null {
  const slot = card.closest<HTMLElement>("[data-composer-decisions]");
  if (!slot) return null;
  let branch: HTMLElement = slot;
  for (let element = slot.parentElement, depth = 0; element && element !== document.body && depth < 8; branch = element, element = element.parentElement, depth += 1) {
    const style = getComputedStyle(element);
    if (!style.display.includes("flex") || !style.flexDirection.startsWith("column")) continue;
    const grow = Array.from(element.children).find((child): child is HTMLElement =>
      child !== branch && child instanceof HTMLElement && Number.parseFloat(getComputedStyle(child).flexGrow) > 0);
    if (grow) return { element, grow };
  }
  return null;
}

const px = (value: string) => Number.parseFloat(value) || 0;

/** 열의 안쪽 높이와, 대화 영역·이 카드를 뺀 나머지 자식들의 높이를 읽는다. */
export function measureAskCardColumn(card: HTMLElement, column: AskCardColumn): { columnHeight: number; otherHeight: number } {
  const style = getComputedStyle(column.element);
  const columnHeight = column.element.clientHeight - px(style.paddingTop) - px(style.paddingBottom);
  let other = 0;
  for (const child of Array.from(column.element.children)) {
    if (child === column.grow || !(child instanceof HTMLElement)) continue;
    const childStyle = getComputedStyle(child);
    if (childStyle.display === "none" || childStyle.position === "absolute" || childStyle.position === "fixed") continue;
    other += child.getBoundingClientRect().height + px(childStyle.marginTop) + px(childStyle.marginBottom);
  }
  // 이 카드의 지금 높이는 자식(푸터) 안에 들어 있다 — 카드가 쓸 몫을 구하려면 뺀다.
  other -= card.getBoundingClientRect().height;
  return { columnHeight, otherHeight: Math.max(0, other) };
}

/**
 * 펼쳐진 카드에서 줄어들지 않는 부분과 줄어드는 부분(보기 목록·본문)의 높이를 읽는다. 접힌 카드에서는 null.
 * 줄어드는 부분은 스크롤 상자라 scrollHeight 가 자연 높이다.
 */
export function measureAskCardParts(card: HTMLElement): { fixed: number; shrinkable: number } | null {
  const options = card.querySelector<HTMLElement>("[data-ask-options]");
  if (!options) return null;
  const body = card.querySelector<HTMLElement>("[data-ask-body]");
  const shrinkable = options.scrollHeight + (body ? body.scrollHeight : 0);
  const fixed = card.getBoundingClientRect().height - options.clientHeight - (body ? body.clientHeight : 0);
  return { fixed: Math.max(0, Math.round(fixed)), shrinkable: Math.round(shrinkable) };
}
