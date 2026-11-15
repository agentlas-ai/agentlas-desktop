/**
 * What the Main-owned confirmation window says, one plan per kind of request (the kinds electron/one/home*.ts hands to the gate in home-confirm.ts).
 * Pictures: desktop-home-trust-1 J (trust a phone, remove a device, screen-control line, two minutes), -2 M / N / O / P-2 (move, show the number, a home that wants to
 * become the home, revert), -3. A kind with no picture gets the same frame and the shortest honest words; each is listed in RESULT.md ("no picture").
 * The page draws a plan and nothing else: words and numbers come from here, the closed words of a refusal from one-home-copy.ts (the same line on every screen).
 * Names are never fixed words: a computer or phone is named by what the view carries, and "the personal agent" is the only name used for the agent.
 */
import { DEVICE_NOT_TRUSTED, REAUTH, refusalLine, type Lang, type Pair } from "./one-home-copy";
import { ONE_HOME_CONFIRM_TOO_EARLY } from "../../shared/one-home-confirm";

export interface ConfirmPlan {
  kind: string;
  title: string;
  /** The small line under the title: what is being asked about (icon + text). */
  who: { icon: "phone" | "computer" | "cloud"; text: string } | null;
  /** The six digits as "482 913", or null. */
  code: string | null;
  codeCaption: string | null;
  /** The one sentence under the title (the frame holds one). */
  lines: string[];
  /** The one caution, drawn as a single bordered line (no color fill), or null. */
  warn: string | null;
  items: string[];
  /** The primary button, or null for a window that only shows (its only button is [Close]). */
  yes: string | null;
  /** "This wasn't me" next to the yes: the request's own refusal (home-confirm.ts `alt`). */
  not: string | null;
  /** The other button: cancel, or close when there is no yes. */
  no: string;
  known: boolean;
}

const P = (ko: string, en: string): Pair => ({ ko, en });
export const WORDS = {
  cancel: P("취소", "Cancel"),
  close: P("닫기", "Close"),
  notMe: P("본인이 아니에요", "This wasn't me"),
  sameNumber: P("두 화면의 확인 번호가 같은지 확인해 주세요", "Check that both screens show the same number"),
  otherNumber: P("다른 기기의 확인 번호와 같은지 확인해 주세요", "Check that it matches the number on the other device"),
  phone: P("폰", "phone"),
  computer: P("데스크탑", "desktop"),
  connected: P("연결된 데스크탑", "connected desktop"),
  onServer: P("현재 서버에서 실행 중", "Running on the server now"),
  thisComputer: P("이 데스크탑", "this desktop"),
  anotherComputer: P("다른 데스크탑", "Another desktop"),
  /** The line while the screen is operated (picture J, in every window that has a yes). */
  screenBusy: P("화면 조작 종료 후 다시 눌러 주세요", "Press again after screen control ends"),
  /** Two minutes passed (picture J). */
  expired: P("2분이 지나 닫혔어요. 설정에서 다시 시도해 주세요.", "Closed after 2 minutes. Try again in Settings."),
  /** The window is a few seconds old: the press did not count; nothing was used up. */
  tooEarly: P("잠시 후 다시 눌러 주세요", "Press again in a moment"),
  loading: P("확인 창 여는 중", "Opening"),
  /** The window cannot read its request (it is gone, or this is not the confirm window). */
  gone: P("종료된 요청", "This request has ended"),
  done: P("완료", "Done"),
};

/**
 * The window after a disconnect that was done here and whose security key is not cut yet: it turns into a RESULT (the asking title and the first sentence do not stay under a finished thing).
 * `phone_cut_key_waits`: the key is cut by this desktop once the server answers (Main kept the confirmed cut). `phone_cut_key_elsewhere`: this desktop may not cut that key; the connected desktop can.
 */
export const CUT_RESULT: Record<string, { title: Pair; line: Pair }> = {
  phone_cut_key_waits: { title: P("기기 연결을 해제했어요", "Device disconnected"), line: P("보안 키는 서버에 연결되면 자동으로 해제돼요.", "Its security key is removed automatically once the server is reachable.") },
  phone_cut_key_elsewhere: { title: P("기기 연결을 해제했어요", "Device disconnected"), line: P("보안 키는 연결된 데스크탑에서 해제할 수 있어요.", "Its security key can be removed from the connected desktop.") },
};
export function resultPlan(word: string | null, lang: Lang): { title: string; line: string } | null {
  const r = word ? CUT_RESULT[word] : undefined;
  return r ? { title: r.title[lang], line: r.line[lang] } : null;
}

/**
 * The window after the server refused [Revert] or [Yes, it was me] (`device_not_trusted`, `not_unconfirmed`): it turns into a RESULT like the disconnect one (title + the device line + one sentence + [Close]); the asking title and the first sentence
 * do not stay under a refused thing. The sentence of a closed word is the one table of one-home-copy.ts; only the plain "decide elsewhere" sentence says the verb of the button that was pressed.
 */
export function refusalResult(kind: string, word: string | null, detail: string | undefined, lang: Lang): { title: string; line: string } | null {
  if ((kind !== "revertHome" && kind !== "confirmHome") || (word !== "device_not_trusted" && word !== "not_unconfirmed")) return null;
  const ko = lang === "ko";
  // The connection was confirmed meanwhile: not a failure of [Yes, it was me] (the owner wanted exactly that: a title and [Close], no sentence), a reason [Revert] cannot be done.
  if (word === "not_unconfirmed") return kind === "confirmHome" ? { title: ko ? "이미 확정된 연결이에요" : "The connection is already confirmed", line: "" }
    : { title: ko ? "복원하지 못했어요" : "Could not revert", line: ko ? "연결이 이미 확정돼 복원할 수 없어요." : "The connection is already confirmed, so it cannot be reverted." };
  const plain = !(detail && DEVICE_NOT_TRUSTED[detail]);
  return {
    title: kind === "revertHome" ? (ko ? "복원하지 못했어요" : "Could not revert") : (ko ? "확정하지 못했어요" : "Could not confirm"),
    line: plain && kind === "revertHome" ? (ko ? "이전 데스크탑이나 신뢰하는 기기에서 복원해 주세요." : "Revert it on the previous desktop or a trusted device.") : refusalLine(lang, word, detail).text,
  };
}

/**
 * A press that is HELD, not refused: the server wants a sign-in from the last 15 minutes (`reauth_required`) and Main kept the press (it carries the held action's id); the owner signs in again and the SAME call is made again
 * (contracts/one-home-desktop.md section 7). The window says so, in the words the owner screens use for that state, and never the line of a failure: the press goes on, and it can end as a success a moment later.
 */
export const isHeldPress = (out: { code?: unknown; actionId?: unknown }): boolean => out.code === "reauth_required" && typeof out.actionId === "string" && out.actionId.length > 0;
export const heldLine = (lang: Lang): string => `${REAUTH.reauth_required.title[lang]}. ${REAUTH.reauth_required.body[lang]}`;

/** The page's phases. `settled` ones are a press on its way or over: a late read or the two-minutes signal never draws over them. */
export type ConfirmPhase = "loading" | "ready" | "busy" | "held" | "refused" | "done" | "expired" | "gone";
export const phaseSettled = (p: ConfirmPhase): boolean => p === "busy" || p === "held" || p === "refused" || p === "done";
/** Where one answer of Main leaves the page. A `too_early` gives the press back (nothing was used up); every other end is final for this request. */
export type PressEnd = { phase: "done" } | { phase: "ready"; word: string; detail?: string } | { phase: "held" } | { phase: "refused"; word: string; screenBusy: boolean; detail?: string };
export function pressEnd(out: { ok?: unknown; code?: unknown; actionId?: unknown; retry?: unknown; detail?: unknown }): PressEnd {
  if (out.ok === true) return { phase: "done" };
  const code = typeof out.code === "string" ? out.code : "confirm_run_failed";
  if (code === ONE_HOME_CONFIRM_TOO_EARLY) return { phase: "ready", word: code };
  // A yes that did nothing and may be pressed again (Main kept the request: home-confirm.ts `retry`): the same window stays, with the one caution line, and the same button.
  const detail = typeof out.detail === "string" && /^[a-z_]{1,48}$/.test(out.detail) ? { detail: out.detail } : {};   // the server's closed reason (home.ts `closedReason`): it only picks the sentence
  if (out.retry === true) return { phase: "ready", word: code, ...detail };
  if (isHeldPress(out)) return { phase: "held" };
  return { phase: "refused", word: code, screenBusy: code === "screen_control_active", ...detail };
}

const code6 = (v: unknown): string | null => (typeof v === "string" && /^\d{6}$/.test(v) ? `${v.slice(0, 3)} ${v.slice(3)}` : null);
const text = (v: unknown, max = 80): string => (typeof v === "string" ? Array.from(v.replace(/\s+/g, " ").trim()).slice(0, max).join("") : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const day = (v: unknown): string | null => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  const d = new Date(v < 1e11 ? v * 1000 : v);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
/** "today 14:02" / "11/12" from a time (ms or seconds); null when there is none. */
const when = (v: unknown, ko: boolean): string | null => {
  const ms = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? (v < 1e11 ? v * 1000 : v) : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms), n = new Date();
  if (d.toDateString() === n.toDateString()) {
    const hm = d.toLocaleTimeString(ko ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    return ko ? `오늘 ${hm}` : `today ${hm}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
const kb = (bytes: number): string => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** The kinds this window knows, in the order the gate's callers define them. A kind not listed here is drawn with `unknownPlan` (cancel only, no yes). */
export const CONFIRM_KINDS = ["trustPhone", "revokeKey", "approveMove", "approveClaim", "rejectClaim", "confirmHome", "revertHome", "takeover", "showCode", "sendLeftover", "mergeLeftover", "acceptHomeKey", "reviewWaiting"] as const;

export function confirmPlan(kind: string, view: Record<string, unknown>, lang: Lang): ConfirmPlan {
  const w = (p: Pair): string => p[lang];
  const ko = lang === "ko";
  const base = { kind, who: null, code: null, codeCaption: null, lines: [] as string[], warn: null as string | null, items: [] as string[], yes: null as string | null, not: null as string | null, no: w(WORDS.cancel), known: true };
  const label = text(view.label) || text(view.computer);
  const named = label || w(WORDS.anotherComputer);
  const desk = (text: string | null, extra?: string | null): ConfirmPlan["who"] => ({ icon: "computer", text: [text || named, w(WORDS.computer), extra].filter(Boolean).join(" · ") });
  switch (kind) {
    case "trustPhone": {
      const name = text(view.name);
      return { ...base, title: ko ? "이 폰을 신뢰하는 기기로 등록할까요?" : "Trust this phone?", who: { icon: "phone", text: name ? `${name} · ${w(WORDS.phone)}` : w(WORDS.phone) },
        code: code6(view.confirmCode), codeCaption: w(WORDS.sameNumber), yes: ko ? "신뢰하는 기기로 등록" : "Trust this phone" };
    }
    case "revokeKey": {
      const name = text(view.name);
      const dk = view.deviceKind === "phone" ? w(WORDS.phone) : view.deviceKind === "desktop" || view.deviceKind === "computer" ? w(WORDS.computer) : "";
      const at = day(view.registeredAt);
      const parts = [name, dk, at ? (ko ? `${at} 등록` : `registered ${at}`) : ""].filter(Boolean);
      return { ...base, title: ko ? "이 기기의 연결을 해제할까요?" : "Disconnect this device?", who: parts.length ? { icon: view.deviceKind === "phone" ? "phone" : "computer", text: parts.join(" · ") } : null,
        // A phone this computer paired: one disconnect cuts the key and the direct connection, and the one sentence says what the owner does to use it again.
        lines: [view.alsoPairing === true && view.keyElsewhere === true ? (ko ? "이 데스크탑과의 연결만 해제되고, 보안 키는 연결된 데스크탑에서 해제할 수 있어요." : "Only this desktop's connection ends, and the security key can be removed from the connected desktop.")
          : view.alsoPairing === true ? (ko ? "해제한 기기는 다시 연결해야 사용할 수 있어요." : "A disconnected device has to be connected again before it can be used.")
          : (ko ? "해제하면 이 기기로는 데스크탑 연결을 변경하거나 승인할 수 없어요." : "After this, the device cannot move or confirm the connected desktop.")], yes: ko ? "연결 해제" : "Disconnect" };
    }
    case "approveMove": {
      const work = num(view.activeWork);
      return { ...base, title: ko ? "데스크탑 연결 변경을 승인할까요?" : "Approve moving the connected desktop?", who: desk(label), code: code6(view.confirmCode), codeCaption: w(WORDS.sameNumber),
        lines: work > 0 ? [ko ? `진행 중인 작업 ${work}개` : `${work} ${work === 1 ? "task is" : "tasks are"} running`] : [], yes: ko ? "변경 승인" : "Approve", not: w(WORDS.notMe) };
    }
    case "approveClaim":
      return { ...base, title: ko ? "데스크탑 연결 변경을 승인할까요?" : "Approve moving the connected desktop?", who: desk(label, when(view.at, ko)), code: code6(view.confirmCode), codeCaption: w(WORDS.sameNumber),
        yes: ko ? "변경 승인" : "Approve", not: w(WORDS.notMe) };
    case "rejectClaim":
      return { ...base, title: ko ? "연결 변경 요청을 거절할까요?" : "Decline this request to move?", who: desk(label, when(view.at, ko)), code: code6(view.confirmCode), codeCaption: code6(view.confirmCode) ? w(WORDS.sameNumber) : null,
        lines: [ko ? "연결된 데스크탑은 변경되지 않아요." : "Your connected desktop does not change."], yes: ko ? "본인이 아니에요" : "This wasn't me" };
    case "confirmHome": {
      const at = when(view.at, ko);
      return { ...base, title: ko ? "이 연결을 확정할까요?" : "Confirm this connection?", who: label ? desk(label, at ? (ko ? `${at} 변경` : `moved ${at}`) : null) : null,
        lines: [ko ? "본인이 변경한 경우에만 확정해 주세요." : "Confirm only if you made the move."], yes: ko ? "본인이에요" : "Yes, it was me" };
    }
    case "revertHome": {
      // On the desktop the change came from (`fromHere`) the connection goes back HERE and what piled up is on the new home (`label`). On the new desktop it goes back to the previous desktop (`fromLabel`, when the server names it)
      // and what piled up is on THIS desktop: the device line is the one that is restored, the sentence says "this desktop" (the view's `label` is this desktop's own name there).
      if (view.fromHere === true) return { ...base, title: ko ? "이 데스크탑으로 복원할까요?" : "Go back to this desktop?", who: label ? desk(label) : null,
        lines: [ko ? `그동안 ${label || "그 데스크탑"}에 쌓인 기록은 가져오지 않아요.` : `What piled up on ${label || "that desktop"} meanwhile is not brought back.`], yes: ko ? "복원" : "Revert" };
      const before = text(view.fromLabel);
      return { ...base, title: ko ? "이전 데스크탑으로 복원할까요?" : "Go back to the previous desktop?", who: before ? desk(before) : null,
        lines: [ko ? "그동안 이 데스크탑에 쌓인 기록은 가져오지 않아요." : "What piled up on this desktop meanwhile is not brought back."], yes: ko ? "복원" : "Revert" };
    }
    case "takeover":
      return { ...base, title: ko ? "이 데스크탑에 연결할까요?" : "Connect to this desktop?",
        who: label ? { icon: "computer", text: `${label} · ${w(WORDS.connected)}` } : { icon: "cloud", text: w(WORDS.onServer) },
        lines: [label ? (ko ? "개인 에이전트를 이 데스크탑에 연결해요." : "The personal agent is connected to this desktop.") : (ko ? "서버의 대화와 기억을 이 데스크탑으로 가져와요." : "Chats and memory on the server are brought to this desktop.")], yes: ko ? "이 데스크탑에 연결" : "Connect here" };
    case "showCode":
      return { ...base, title: ko ? "이 데스크탑의 확인 번호" : "This desktop's number", who: { icon: "computer", text: `${label ? label + " · " : ""}${w(WORDS.thisComputer)}` }, code: code6(view.confirmCode), codeCaption: w(WORDS.otherNumber), no: w(WORDS.close) };
    case "sendLeftover":
      return { ...base, title: ko ? "이 데스크탑의 기록을 전송할까요?" : "Send this desktop's records?", who: label ? { icon: "computer", text: `${label} · ${w(WORDS.connected)}` } : null,
        lines: [ko ? "이 데스크탑의 대화와 기억을 연결된 데스크탑으로 전송해요." : "Chats and memory on this desktop go to the connected desktop."],
        warn: view.unconfirmed === true ? (ko ? "연결된 데스크탑이 확인 대기 상태예요." : "The connected desktop is not confirmed yet.") : null, yes: ko ? "전송" : "Send" };
    case "mergeLeftover": {
      const bytes = num(view.bytes);
      return { ...base, title: ko ? "다른 데스크탑의 기록을 병합할까요?" : "Merge another desktop's records?", who: desk(label),
        lines: [bytes > 0 ? (ko ? `${named}의 기록 ${kb(bytes)}를 이 데스크탑에 병합해요.` : `${kb(bytes)} of records from ${named} are merged into this desktop.`) : (ko ? `${named}의 기록을 이 데스크탑에 병합해요.` : `Records from ${named} are merged into this desktop.`)], yes: ko ? "병합" : "Merge" };
    }
    case "acceptHomeKey":
      return { ...base, title: ko ? "새 보안 키를 수락할까요?" : "Accept the new security key?", who: label ? { icon: "computer", text: `${label} · ${w(WORDS.connected)}` } : null,
        lines: [ko ? `${label || "연결된 데스크탑"}의 보안 키가 변경됐어요.` : `${label ? `${label}'s` : "The connected desktop's"} security key has changed.`],
        warn: ko ? "해당 데스크탑이 확실한 경우에만 수락해 주세요." : "Accept only if you are sure it is that desktop.", yes: ko ? "수락" : "Accept" };
    case "reviewWaiting": {
      // The one window for what waits (pictures desktop-impl-gaps-6 AI-3 / AI-4): its list, selection and answers are drawn by OneHomeWaitingReview (lib/waiting-review.ts has its words); this plan is what the generic frame
      // shows only when that page cannot (a request that is over): a title, and no yes.
      const n = num(view.waiting);
      return { ...base, title: n > 0 ? (ko ? `확인 대기 ${n}건` : `${n} to review`) : (ko ? "확인 대기" : "To review"), no: w(WORDS.close) };
    }
    default:
      return { ...base, known: false, title: ko ? "확인할 수 없는 요청" : "This request cannot be shown", lines: [ko ? "앱 업데이트 필요" : "Update the app"] };
  }
}
