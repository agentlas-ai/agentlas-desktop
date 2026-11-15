/**
 * Words for the personal agent's home screens (F-D15 / F-D16). One table per kind of word, keyed by the contract's closed codes
 * (contracts/one-home-desktop.md §3, §7, §13.3; one-home-move.md §5). The screen never parses a server sentence: an unknown code gets the
 * generic line, and every "no" carries what the owner does next. A closed word is never printed on a screen; it only picks the sentence.
 * Names are never fixed words: the personal agent's name comes from the profile and is passed in.
 */
export type Lang = "ko" | "en";
export type Pair = { ko: string; en: string };
export const t2 = (lang: Lang, p: Pair): string => p[lang];

/** The refusal of a button, one line each. The same code reads the same on every screen. */
export const REFUSAL: Record<string, Pair> = {
  screen_control_active: { ko: "화면 조작 종료 후 다시 눌러 주세요.", en: "Press again after screen control ends." },
  confirm_window_unavailable: { ko: "확인 창을 열 수 없어요. 앱을 다시 시작해 주세요.", en: "The confirm window cannot open. Restart the app." },
  device_proof_unavailable: { ko: "잠시 후 다시 시도해 주세요.", en: "Try again in a moment." },
  one_home_unavailable: { ko: "연결 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.", en: "Connection details could not be loaded. Try again in a moment." },
  sign_in_required: { ko: "로그인이 필요해요.", en: "Sign in first." },
  no_such_request: { ko: "요청이 변경됐어요. 확인 번호를 다시 비교해 주세요.", en: "The request changed. Check the number again." },
  request_changed: { ko: "요청이 변경됐어요. 확인 번호를 다시 비교해 주세요.", en: "The request changed. Check the number again." },
  no_such_move: { ko: "요청이 변경됐어요. 확인 번호를 다시 비교해 주세요.", en: "The request changed. Check the number again." },
  not_found: { ko: "항목을 찾을 수 없어요.", en: "Item not found." },
  not_eligible: { ko: "QR 코드로 다시 연결해야 등록할 수 있어요.", en: "Pair again with the QR code to register it." },
  register_first: { ko: "폰에서 다시 로그인하면 확인 번호가 생겨요.", en: "Sign in again on the phone to get a number." },
  owner_press_needed: { ko: "폰의 확인 번호를 비교한 뒤 이 데스크탑에서 등록해 주세요.", en: "Check the number on the phone, then register here." },
  home_is_server: { ko: "연결된 데스크탑이 없어요. [이 데스크탑에 연결]을 선택해 주세요.", en: "There is no connected desktop. Choose [Connect here]." },
  home_unconfirmed: { ko: "새 데스크탑을 먼저 확정하거나 복원해 주세요.", en: "Confirm or revert the new desktop first." },
  key_storage_unavailable: { ko: "보안 저장소를 사용할 수 없어요. 시스템 키체인을 확인해 주세요.", en: "Secure storage is unavailable. Check the system keychain." },
  server_fence_failed: { ko: "잠시 후 다시 시도해 주세요.", en: "Try again in a moment." },
  server_fence_unavailable: { ko: "잠시 후 다시 시도해 주세요.", en: "Try again in a moment." },
  window_not_shown: { ko: "창을 연 뒤 다시 시도해 주세요.", en: "Open the window and try again." },
  window_not_visible: { ko: "창을 연 뒤 다시 시도해 주세요.", en: "Open the window and try again." },
  already_committed: { ko: "이미 변경돼 취소할 수 없어요.", en: "Already changed, so it cannot be cancelled." },
  cleanup_incomplete: { ko: "취소했지만 임시 파일이 남았어요. 다시 취소해 주세요.", en: "Cancelled, but temporary files remain. Cancel again." },
  no_question: { ko: "확인할 질문이 없어요.", en: "Nothing to ask." },
  engine_too_old: { ko: "앱을 업데이트한 뒤 다시 시도해 주세요.", en: "Update the app and try again." },
  ask_unseen: { ko: "새 데스크탑이 확인되면 다시 물어봐요.", en: "It asks again when the new desktop appears." },
  ask_unconfirmed: { ko: "새 데스크탑을 확정한 뒤 다시 시도해 주세요.", en: "Confirm the new desktop, then try again." },
  invalid_args: { ko: "화면을 다시 열어 주세요.", en: "Open the screen again." },
  // The unified device disconnect (the key and the direct connection are cut together). The confirmation window draws the first two as a RESULT (title + one sentence, lib/one-home-confirm-copy.ts `CUT_RESULT`); these lines are the same words for any other place that names the code.
  phone_cut_failed: { ko: "기기 연결을 해제하지 못했어요.", en: "The device could not be disconnected." },
  phone_cut_key_waits: { ko: "기기 연결을 해제했어요. 보안 키는 서버에 연결되면 자동으로 해제돼요.", en: "The device is disconnected. Its security key is removed automatically once the server is reachable." },
  phone_cut_key_elsewhere: { ko: "기기 연결을 해제했어요. 보안 키는 연결된 데스크탑에서 해제할 수 있어요.", en: "The device is disconnected. Its security key can be removed from the connected desktop." },
  // A press the server turned back for a sign-in that Main did not keep (a press Main keeps is shown as "held", never as a refusal): it did not run, and signing in again is what makes it run.
  reauth_required: { ko: "재로그인이 필요해요. 로그인한 뒤 다시 시도해 주세요.", en: "Sign in again, then try once more." },
  signin_after_change_required: { ko: "재로그인이 필요해요. 로그인한 뒤 다시 시도해 주세요.", en: "Sign in again, then try once more." },
  // The server's "no" to [Yes, it was me] / [Revert] (home-move-phone-card R5): this desktop's key is not one the server lets decide (`device_not_trusted`; `DEVICE_NOT_TRUSTED` below tells the one reason that has its own sentence), or the connection was confirmed meanwhile (`not_unconfirmed`).
  device_not_trusted: { ko: "이전 데스크탑이나 신뢰하는 기기에서 확인해 주세요.", en: "Confirm it on the previous desktop or a trusted device." },
  not_unconfirmed: { ko: "연결이 이미 확정됐어요.", en: "The connection is already confirmed." },
  // the owner said "it was not me" about this desktop's earlier request (a revert, a refused request): the server refuses its key for good, so "try again" would be false. / The home changed between the owner's look and the press.
  key_rejected: { ko: "복원으로 연결이 취소된 데스크탑이라 다시 연결할 수 없어요.", en: "This desktop's connection was reverted, so it can't connect again." },
  stale_epoch: { ko: "요청이 변경됐어요.", en: "The request changed." },
};
/** `device_not_trusted` by the server's closed `reason`. Any other reason reads as the plain `device_not_trusted` line. */
export const DEVICE_NOT_TRUSTED: Record<string, Pair> = {
  strong_signin_required: { ko: "Google 또는 Apple로 재로그인한 뒤 다시 시도해 주세요.", en: "Sign in again with Google or Apple, then try again." },
};
/** `startMoveHere` → `not_ready` carries the one readiness code in `detail`. */
export const NOT_READY: Record<string, Pair> = {
  rules_switch_off: { ko: "작업 공간 규칙을 켠 뒤 다시 시도해 주세요.", en: "Turn on workspace rules, then try again." },
  migration_not_classified: { ko: "기억 정리가 끝난 뒤 다시 시도해 주세요.", en: "Try again after the memory cleanup finishes." },
  // Every other word the readiness check of [Connect here] gives (home-move.ts `readiness`, bundle.ts `readyOne`): one sentence, and the one thing the owner does.
  cloud_computer: { ko: "클라우드 컴퓨터에서는 연결할 수 없어요. 로컬 데스크탑에서 시도해 주세요.", en: "A cloud computer cannot be connected. Try on a local desktop." },
  no_host_id: { ko: "이 데스크탑을 확인하지 못했어요. 앱을 다시 시작해 주세요.", en: "This desktop could not be identified. Restart the app." },
  no_runtime: { ko: "연결된 모델이 없어요. 모델을 연결한 뒤 다시 시도해 주세요.", en: "No model is connected. Connect a model, then try again." },
  // The transfer switch belongs to the build (an operator switch; the app has no setting for it), so the sentence names the one thing a person can do: update.
  first_run_migration_off: { ko: "앱 업데이트 후 데스크탑 연결을 변경할 수 있어요.", en: "The connected desktop can be changed after the app is updated." },
  first_run_agent_folder_missing: { ko: "에이전트 폴더를 찾을 수 없어요. 폴더가 있는 드라이브를 연결한 뒤 다시 시도해 주세요.", en: "The agent folder cannot be found. Connect the drive that holds it, then try again." },
  first_run_migration_stopped: { ko: "기존 데이터 이전이 완료되지 않았어요. 앱을 다시 시작해 주세요.", en: "The data transfer did not finish. Restart the app." },
  first_run_labels_running: { ko: "기억 정리가 진행 중이에요. 끝난 뒤 다시 시도해 주세요.", en: "Memory cleanup is running. Try again after it finishes." },
  disk_space: { ko: "디스크 공간이 부족해요. 공간을 확보한 뒤 다시 시도해 주세요.", en: "Not enough disk space. Free some space, then try again." },
  disk_unknown: { ko: "디스크 공간을 확인하지 못했어요. 앱을 다시 시작해 주세요.", en: "Disk space could not be checked. Restart the app." },
  pointer_unavailable: { ko: "연결 정보를 불러오지 못했어요. 로그인 상태를 확인한 뒤 다시 시도해 주세요.", en: "Connection details could not be loaded. Check you are signed in, then try again." },
  owner_unbound: { ko: "계정 연결을 확인하지 못했어요. 로그인 상태를 확인한 뒤 앱을 다시 시작해 주세요.", en: "The account link could not be checked. Check you are signed in, then restart the app." },
  engines_not_confirmed: { ko: "열려 있는 Claude Code나 Codex 창을 닫은 뒤 다시 시도해 주세요.", en: "Close any open Claude Code or Codex window, then try again." },
};
export const GENERIC_REFUSAL: Pair = { ko: "실패했어요. 잠시 후 다시 시도해 주세요.", en: "That did not work. Try again in a moment." };

export function refusalLine(lang: Lang, code: string, detail?: string): { text: string; code: string } {
  if (code === "not_ready" && detail && NOT_READY[detail]) return { text: NOT_READY[detail][lang], code: detail };
  // A not-ready word that is also a plain refusal word (a locked key store, a missing sign-in) reads as that word's sentence.
  if (code === "not_ready" && detail && REFUSAL[detail]) return { text: REFUSAL[detail][lang], code: detail };
  if (code === "device_not_trusted" && detail && DEVICE_NOT_TRUSTED[detail]) return { text: DEVICE_NOT_TRUSTED[detail][lang], code: detail };
  const row = REFUSAL[code];
  return { text: (row ?? GENERIC_REFUSAL)[lang], code };
}

/** Sign in again: the five states under the button (picture L). */
export const REAUTH: Record<string, { title: Pair; body: Pair }> = {
  reauth_required: { title: { ko: "재로그인이 필요해요", en: "A fresh sign-in is needed" }, body: { ko: "브라우저에서 로그인하면 이어져요.", en: "Sign in in the browser and it continues." } },
  reauth_cancelled: { title: { ko: "로그인이 끝나지 않았어요", en: "The sign-in did not finish" }, body: { ko: "3분 안에 로그인하지 않았어요. 다시 시도해 주세요.", en: "No sign-in within 3 minutes. Try again." } },
  account_changed: { title: { ko: "다른 계정으로 로그인했어요", en: "You signed in with a different account" }, body: { ko: "처음 사용한 계정으로 로그인해 주세요.", en: "Sign in with the account you started with." } },
  reauth_failed: { title: { ko: "로그인을 확인하지 못했어요", en: "The sign-in could not be confirmed" }, body: { ko: "잠시 후 다시 시도해 주세요.", en: "Try again in a moment." } },
  action_expired: { title: { ko: "시간이 지나 취소됐어요", en: "It took too long and was cancelled" }, body: { ko: "처음부터 다시 시도해 주세요.", en: "Start again from the first button." } },
};
export const REAUTH_BUTTON: Pair = { ko: "재로그인", en: "Sign in again" };
/** Both closed words the server may use for "sign in again, then confirm" lead to the same single button. */
export const isReauthCode = (code: string | undefined): boolean => code === "reauth_required" || code === "signin_after_change_required";

/** A move that waits (`move.waiting`, contract §13.3): what it waits for and what the owner does. */
export const WAITING: Record<string, Pair> = {
  waiting_approval: { ko: "폰이나 다른 데스크탑에서 승인해 주세요.", en: "Approve it on your phone or another desktop." },
  waiting_sender: { ko: "이전 데스크탑에서 [변경 승인]을 선택해 주세요.", en: "Choose [Approve] on the previous desktop." },
  waiting_owner: { ko: "확인 번호를 비교한 뒤 [변경 승인]을 선택해 주세요.", en: "Compare the number, then choose [Approve]." },
  waiting_receiver: { ko: "새 데스크탑에서 앱을 열어 주세요.", en: "Open the app on the new desktop." },
  waiting_import: { ko: "새 데스크탑에서 앱을 열어 주세요.", en: "Open the app on the new desktop." },
  waiting_blank_confirm: { ko: "삭제할 기억 수를 확인해 주세요.", en: "Check how many memories will be removed." },
  waiting_redeposit: { ko: "이전 데스크탑을 켜 주세요.", en: "Turn on the previous desktop." },
  home_unconfirmed: { ko: "먼저 그 데스크탑을 확정하거나 복원해 주세요.", en: "Confirm or revert that desktop first." },
  home_key_changed: { ko: "그 데스크탑의 보안 키가 변경됐어요.", en: "That desktop's security key has changed." },
  import_pending: { ko: "새 데스크탑에서 가져오기를 끝내 주세요.", en: "Finish the import on the new desktop." },
  stale_epoch: { ko: "연결이 변경돼 다시 확인하는 중", en: "Connection changed, checking again" },
  commit_not_seen: { ko: "잠시 후 이어져요.", en: "It continues in a moment." },
  new_home_not_trusted: { ko: "새 데스크탑의 보안 키가 저장된 키와 달라요.", en: "The new desktop's security key does not match the saved one." },
  mirror_unavailable: { ko: "기억 폴더를 확인해 주세요.", en: "Check the memory folder." },
  server_unreachable: { ko: "서버에 연결되면 이어져요.", en: "It continues once the server is reachable." },
  request_timeout: { ko: "서버 응답 지연 · 자동 재시도", en: "Server is slow · retrying" },
  disk_space_short: { ko: "저장 공간 부족", en: "Not enough disk space" },
  reauth_required: { ko: "재로그인이 필요해요.", en: "A fresh sign-in is needed." },
};
/** the one completion card after the owner's own successful [Revert] / [This wasn't me] (same words as the phone's). */
export const ANSWER_DONE: Record<"restored" | "declined", { title: Pair; body: Pair }> = {
  restored: { title: { ko: "연결 복원 완료", en: "Connection restored" }, body: { ko: "본인이 변경하지 않았다면 웹 계정 화면에서 모든 기기를 로그아웃해 주세요.", en: "If you didn't make this change, sign out of all devices on the web account page." } },
  declined: { title: { ko: "요청 거절 완료", en: "Request declined" }, body: { ko: "계정 보호를 위해 웹 계정 화면에서 모든 기기를 로그아웃해 주세요.", en: "To protect your account, sign out of all devices on the web account page." } },
};
export const ANSWER_OPEN: Pair = { ko: "계정 화면 열기", en: "Open account page" };
export const ANSWER_CLOSE: Pair = { ko: "닫기", en: "Close" };

/** Ends (`lastMove.code`, contract §13.3): what the move ended with and what to do. */
export const ENDED: Record<string, Pair> = {
  engines_not_confirmed: { ko: "기억은 업데이트 정리가 끝나면 이동해요.", en: "Memory moves after the update cleanup finishes." },
  purge_expired: { ko: "30일 안에 새 데스크탑이 수신하지 않았어요.", en: "The new desktop did not receive it within 30 days." },
  writes_closed: { ko: "잠시 후 연결 변경을 다시 시도해 주세요.", en: "Try changing the connection again in a moment." },
  move_expired: { ko: "요청이 만료됐어요.", en: "The request expired." },
  request_gone: { ko: "요청이 종료됐어요.", en: "The request has ended." },
  request_changed: { ko: "요청이 변경됐어요.", en: "The request changed." },
  sender_changed: { ko: "이전 데스크탑의 보안 키가 변경됐어요.", en: "The previous desktop's security key has changed." },
  bundle_hash_mismatch: { ko: "전송 데이터가 올바르지 않아요.", en: "The transferred data is not valid." },
  bundle_size_invalid: { ko: "전송 데이터가 올바르지 않아요.", en: "The transferred data is not valid." },
  bundle_too_large: { ko: "전송 데이터가 너무 커요.", en: "The transferred data is too large." },
  box_key_lost: { ko: "전송 데이터를 열 수 없어요.", en: "The transferred data cannot be opened." },
  home_unconfirmed: { ko: "이전 데스크탑이 확정되지 않았어요.", en: "The previous desktop is not confirmed." },
  home_key_changed: WAITING.home_key_changed,
};
export const STOPPED_GENERIC: Pair = { ko: "대화와 기억은 그대로예요.", en: "Chats and memory are unchanged." };
export const WAITING_GENERIC: Pair = { ko: "대기 중", en: "Waiting" };

/** What the counts of a finished move are called (only the keys the contract's status carries; any other key is not drawn). */
export const COUNT_LABELS: Array<{ key: string; label: Pair; note?: Pair }> = [
  { key: "messages", label: { ko: "이동한 대화", en: "Messages moved" } },
  { key: "factsWritten", label: { ko: "이동한 기억", en: "Memories moved" } },
  { key: "notPacked", label: { ko: "미포함 항목", en: "Not included" }, note: { ko: "이전 데스크탑에 남아요", en: "stay on the previous desktop" } },
  { key: "factsRejected", label: { ko: "수신 제외 기억", en: "Memories not received" } },
  { key: "rejected", label: { ko: "수신 제외 항목", en: "Items not received" } },
  { key: "photoOnlySkipped", label: { ko: "사진만 있는 메시지", en: "Photo-only messages" }, note: { ko: "미포함", en: "left out" } },
];

/**
 * Korean particles after a name the owner chose (the name is never a fixed word): a name read with a final consonant takes the first form, otherwise the second.
 * Hangul: the last syllable. Latin letters and digits: how the last one is usually read in a Korean loanword (Mac -> 맥, Book -> 북, 3 -> 삼); a guess for names, never for a word the app owns.
 */
const hasFinal = (name: string): boolean => {
  const trimmed = name.trim();
  const last = trimmed.charAt(trimmed.length - 1);
  const c = last.charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 !== 0;
  if (/[0136-8]/.test(last)) return true;
  return /[lmnrkcptbg]/i.test(last);
};
export const josaIga = (name: string): string => (hasFinal(name) ? "이" : "가");
export const josaEun = (name: string): string => (hasFinal(name) ? "은" : "는");
export const josaEul = (name: string): string => (hasFinal(name) ? "을" : "를");
