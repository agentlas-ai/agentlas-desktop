/*
 * "아니오, 그리고 대신 이렇게 하세요" 입력칸의 초안 (오너 2026-10-27).
 *
 * 카드는 여러 건이면 "1/3 · 다음" 으로 한 장씩 바뀌고 요청마다 새로 그려진다. 오너가 쓰던 줄이 카드를 넘기거나 결정이 재시도되는 동안
 * 사라지면 안 되므로, 초안은 카드(컴포넌트) 밖에 요청 id 별로 둔다. 결정이 확정된 뒤에만 지운다.
 */

/** Main(runtime/tool-approval-owner-note.ts APPROVAL_OWNER_NOTE_MAX_CHARS)과 같은 값. 화면 입력칸의 maxLength. */
export const APPROVAL_NOTE_MAX_CHARS = 500;

export interface ApprovalNoteDraft {
  text: string;
  open: boolean;
}

const drafts = new Map<string, ApprovalNoteDraft>();
const DRAFT_LIMIT = 50;

export function readApprovalNoteDraft(key: string | undefined): ApprovalNoteDraft {
  return (key ? drafts.get(key) : undefined) ?? { text: "", open: false };
}

export function writeApprovalNoteDraft(key: string | undefined, draft: ApprovalNoteDraft): void {
  if (!key) return;
  if (!draft.text && !draft.open) { drafts.delete(key); return; }
  drafts.delete(key);
  drafts.set(key, draft);
  while (drafts.size > DRAFT_LIMIT) {
    const oldest = drafts.keys().next();
    if (oldest.done) break;
    drafts.delete(oldest.value);
  }
}

export function clearApprovalNoteDraft(key: string | undefined): void {
  if (key) drafts.delete(key);
}

/** 보내기 전 정리: 한 줄로 접고 앞뒤 공백을 뺀다. 비면 undefined(= note 없는 거절). Main 이 한 번 더 같은 규칙으로 정리한다. */
export function cleanApprovalNote(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  const points = Array.from(flat);
  return (points.length > APPROVAL_NOTE_MAX_CHARS ? points.slice(0, APPROVAL_NOTE_MAX_CHARS).join("") : flat).trim() || undefined;
}
