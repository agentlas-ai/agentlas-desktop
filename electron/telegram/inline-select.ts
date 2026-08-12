import { randomBytes } from "node:crypto";

/**
 * 인라인 선택 목록(프로젝트 · 자동화).
 *
 * 텔레그램 callback_data 는 **64바이트 하드 한도**다. 원시 UUID를 실어 보내면
 * 지금은 겨우 들어가지만 검색어·페이지가 붙는 순간 넘어간다. 그래서 실제 id 는
 * 메인 프로세스가 들고, 버튼에는 짧은 세션 키와 인덱스만 싣는다.
 *
 * 세션은 바인딩당 하나다. 새 목록을 보내면 이전 목록은 즉시 만료된다 — 만료된
 * 버튼을 눌렀을 때 조용히 아무 일도 안 일어나는 게 최악이라, 호출부는 반드시
 * "만료됐으니 다시 보내라"고 답한다.
 */
export const INLINE_SELECT_PAGE_SIZE = 8;
const SESSION_TTL_MS = 10 * 60 * 1000;
/** 텔레그램 규격. 넘으면 sendMessage 자체가 400으로 떨어진다. */
export const CALLBACK_DATA_MAX_BYTES = 64;

export type InlineSelectKind = "project" | "graph" | "graphRun";

export interface InlineSelectOption {
  readonly id: string;
  readonly label: string;
}

interface InlineSelectSession {
  sess: string;
  kind: InlineSelectKind;
  options: InlineSelectOption[];
  offset: number;
  /** 만료 안내에서 "다시 보내세요"라고 말할 명령 이름. */
  command: string;
  expiresAt: number;
}

const sessions = new Map<string, InlineSelectSession>();

function nowMs(): number {
  return Date.now();
}

export function buildCallbackData(action: "p" | "n" | "x", sess: string, value = 0): string {
  return `1|${action}|${sess}|${value}`;
}

/** 버튼에 실릴 수 있는 라벨 길이. 프로젝트·자동화 이름은 사용자가 정하므로 무제한이다. */
export const INLINE_BUTTON_LABEL_MAX = 48;

/**
 * 긴 이름을 그대로 버튼에 실으면 키보드가 화면을 잡아먹는다(실측: 300자 라벨이
 * 그대로 통과). 텔레그램은 잘라 주지 않으므로 여기서 자른다.
 */
export function boundInlineLabel(label: string): string {
  const flat = label.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  if (chars.length <= INLINE_BUTTON_LABEL_MAX) return flat || "—";
  return `${chars.slice(0, INLINE_BUTTON_LABEL_MAX - 1).join("")}…`;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface InlineSelectRender {
  markup: InlineKeyboardMarkup;
  /** 전체 쪽수. 1쪽이면 호출부가 페이지 표시를 생략한다. */
  totalPages: number;
  currentPage: number;
}

/** 이 바인딩의 선택 세션을 갈아끼우고 첫 쪽 키보드를 만든다. */
export function openInlineSelect(
  bindingId: string,
  input: {
    kind: InlineSelectKind;
    command: string;
    options: InlineSelectOption[];
    labels: { prev: string; next: string; close: string };
  },
): InlineSelectRender {
  const sess = randomBytes(4).toString("hex");
  sessions.set(bindingId, {
    sess,
    kind: input.kind,
    options: input.options,
    offset: 0,
    command: input.command,
    expiresAt: nowMs() + SESSION_TTL_MS,
  });
  return renderInlineSelect(bindingId, 0, input.labels)!;
}

export function renderInlineSelect(
  bindingId: string,
  offset: number,
  labels: { prev: string; next: string; close: string },
): InlineSelectRender | null {
  const session = sessions.get(bindingId);
  if (!session) return null;
  const total = session.options.length;
  const clamped = Math.max(0, Math.min(offset, Math.max(0, total - 1)));
  const start = Math.floor(clamped / INLINE_SELECT_PAGE_SIZE) * INLINE_SELECT_PAGE_SIZE;
  session.offset = start;
  session.expiresAt = nowMs() + SESSION_TTL_MS;
  const page = session.options.slice(start, start + INLINE_SELECT_PAGE_SIZE);
  const rows = page.map((option, index) => [
    { text: boundInlineLabel(option.label), callback_data: buildCallbackData("p", session.sess, start + index) },
  ]);
  const totalPages = Math.max(1, Math.ceil(total / INLINE_SELECT_PAGE_SIZE));
  if (totalPages > 1) {
    const nav: Array<{ text: string; callback_data: string }> = [];
    if (start > 0) {
      nav.push({
        text: labels.prev,
        callback_data: buildCallbackData("n", session.sess, start - INLINE_SELECT_PAGE_SIZE),
      });
    }
    if (start + INLINE_SELECT_PAGE_SIZE < total) {
      nav.push({
        text: labels.next,
        callback_data: buildCallbackData("n", session.sess, start + INLINE_SELECT_PAGE_SIZE),
      });
    }
    if (nav.length) rows.push(nav);
  }
  rows.push([{ text: labels.close, callback_data: buildCallbackData("x", session.sess) }]);
  return {
    markup: { inline_keyboard: rows },
    totalPages,
    currentPage: Math.floor(start / INLINE_SELECT_PAGE_SIZE) + 1,
  };
}

export type InlineSelectEvent =
  | { kind: "expired"; command: string | null }
  | { kind: "picked"; select: InlineSelectKind; option: InlineSelectOption }
  | { kind: "page"; offset: number }
  | { kind: "closed" };

/** 버튼 콜백 해석. 세션이 없거나 다른 세션이면 전부 "만료"로 접는다. */
export function readInlineSelectCallback(bindingId: string, data: string): InlineSelectEvent {
  const session = sessions.get(bindingId);
  const parts = data.split("|");
  const [version, action, sess, rawValue] = parts;
  if (session && session.expiresAt <= nowMs()) {
    sessions.delete(bindingId);
    return { kind: "expired", command: session.command };
  }
  if (version !== "1" || !session || session.sess !== sess) {
    return { kind: "expired", command: session?.command ?? null };
  }
  if (action === "x") {
    sessions.delete(bindingId);
    return { kind: "closed" };
  }
  const value = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isInteger(value) || value < 0) return { kind: "expired", command: session.command };
  if (action === "n") return { kind: "page", offset: value };
  if (action === "p") {
    const option = session.options[value];
    if (!option) return { kind: "expired", command: session.command };
    sessions.delete(bindingId);
    return { kind: "picked", select: session.kind, option };
  }
  return { kind: "expired", command: session.command };
}

export function clearInlineSelect(bindingId: string): void {
  sessions.delete(bindingId);
}
