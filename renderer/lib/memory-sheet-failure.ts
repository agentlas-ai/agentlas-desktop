import { failureMessage } from "./invocation-failure";

/**
 * What the Memory sheet does when forgetting, reading, editing or sharing a memory fails. Main throws codes and English text through the
 * IPC wrapper (a locked store, a missing row, a code); none of it is for the owner. Three kinds:
 *  - the memory changed under the sheet (memory_owner_*: its revision moved, its owner or epoch changed, it went inactive): the sheet reloads
 *    itself (`refresh`) and says so, instead of telling the owner to reload. Nothing the owner has to do but open it again;
 *  - the owner's own text cannot be saved (memory_owner_edit_invalid: too long, a control character, or a value that looks like a password or
 *    key) and the memory is protected (memory_owner_edit_restricted): each says what is wrong with the edit, not that the memory "changed";
 *  - anything else: it did not go through, try again.
 */
export interface MemorySheetOutcome { text: string; refresh: boolean }
export function memorySheetOutcome(cause: unknown, locale: "ko" | "en"): MemorySheetOutcome {
  const ko = locale === "ko";
  const message = failureMessage(cause);
  if (message.includes("memory_owner_edit_invalid")) {
    return { refresh: false, text: ko ? "이 내용은 기억으로 저장할 수 없어요. 너무 길거나 비밀번호·키처럼 보이는 값이 들어 있을 수 있어요. 고쳐서 다시 시도해 주세요."
      : "That text can't be saved as a memory. It may be too long or contain something that looks like a password or key. Edit it and try again." };
  }
  if (message.includes("memory_owner_edit_restricted")) {
    return { refresh: false, text: ko ? "이 기억은 보호된 내용이라 여기서 수정할 수 없어요." : "This memory is protected and can't be edited here." };
  }
  if (message.includes("memory_owner_")) {
    return { refresh: true, text: ko ? "그 사이 이 기억이 바뀌어 목록을 새로 불러왔어요. 다시 열어 이어가 주세요."
      : "This memory changed in the meantime, so the list was refreshed. Open it again to continue." };
  }
  return { refresh: false, text: ko ? "기억을 처리하지 못했어요. 다시 불러온 뒤 한 번 더 시도해 주세요." : "The memory could not be processed. Reload it and try again." };
}

/**
 * The words the owner typed into the editor when the memory changed under the sheet (round 5 reloads the list by itself, which closes the
 * editor). They are the owner's work: kept, and put back in the editor of the same memory once it is read again. Only a typed edit that
 * differs from the memory's text, only for the edit action, only when the failure is the "changed" kind.
 */
export interface KeptEdit { memoryId: string; text: string }
export function keptEditAfterRefresh(action: "edit" | "forget" | "share", memory: { memoryId: string; content: string }, typed: string, outcome: MemorySheetOutcome): KeptEdit | null {
  if (action !== "edit" || !outcome.refresh) return null;
  return typed.trim() !== "" && typed !== memory.content ? { memoryId: memory.memoryId, text: typed } : null;
}
/** The notice that tells the owner the typed words are back in the editor of the memory that changed. */
export function memorySheetKeptEditText(locale: "ko" | "en"): string {
  return locale === "ko" ? "그 사이 이 기억이 바뀌어 목록을 새로 불러왔어요. 쓰던 내용은 수정창에 그대로 두었으니 확인하고 다시 저장해 주세요."
    : "This memory changed in the meantime, so the list was refreshed. What you typed is back in the editor; check it and save again.";
}

/** The sentence alone (the durable list's forget error, the detail read). */
export function memorySheetFailureText(cause: unknown, locale: "ko" | "en"): string {
  return memorySheetOutcome(cause, locale).text;
}
