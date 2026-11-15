/**
 * Words of "My rules" (F-D11): ko and en together so they cannot drift apart. One table for the refusal codes
 * (`WORKSPACE_RULES_CODES`, shared/workspace-rules.ts) and one for the file states. No product name is fixed here.
 * Words marked "check" were not in the confirmed picture (desktop-final-pieces(-2)); they follow the picture's tone.
 */
import type { WorkspaceRulesCode } from "@shared/workspace-rules";

export type RulesLocale = "ko" | "en";

/** What a line offers to do. `retry` = the same write again, `reread` = read the file again, `create` = make the empty file, `clear` = empty it, `pick` = open the pick list. */
export type RulesAction = "retry" | "reread" | "create" | "clear" | "pick";

export interface LineWords { title: string; body: string; action?: { id: RulesAction; label: string } }

interface Words {
  title: string; pick: string; open: string; openFailed: string; clear: string; cancel: string; later: string;
  chips: [string, string, string]; notRead: string;
  saved: string; saving: string; unsaved: string; local: string; noAuto: string;
  placeholder: string; editorLabel: string; sidebarRow: string;
  loading: string; loadFailed: string; retry: string;
  state: {
    off: LineWords; empty: LineWords; missing: LineWords; unreadable: LineWords;
    overflow: (n: number) => string; localModels: (kb: string) => LineWords;
  };
  /** `save_failed` and `save_full` are the screen's own: a call that threw, and a save (not a pick) refused as `rules_full` - the text itself is too long to store. */
  refusal: Record<WorkspaceRulesCode | "save_failed" | "save_full", LineWords>;
  clearConfirm: { title: string; body: string; ok: string };
  dialog: {
    title: string; lead: string; personal: string; heard: string; note: string; hint: (n: number) => string; add: (n: number) => string;
    loading: string; failed: string; none: string; project: (name: string) => string; close: string;
    result: (added: number, alreadyThere: number, unknown: number) => string;
  };
}

const retryLabel = { ko: "다시 시도", en: "Try again" };

const COPY: Record<RulesLocale, Words> = {
  ko: {
    title: "내 규칙", pick: "예전 지시에서 고르기", open: "파일 열기", openFailed: "파일을 열지 못했어요.", clear: "비우기", cancel: "취소", later: "나중에",
    chips: ["작업 세션", "에이전트 대화", "그룹 대화"], notRead: "개인 에이전트 · Finance · Science · Build · 팀 실행은 읽지 않음",
    saved: "저장됨", saving: "저장 중…", unsaved: "저장 전", local: "이 데스크탑에만", noAuto: "여기에는 저절로 쌓이지 않아요",
    placeholder: "한 줄에 하나씩 적어요. 예: 답은 짧게.", editorLabel: "내 규칙 글", sidebarRow: "내 규칙",
    loading: "불러오는 중…", loadFailed: "내 규칙을 불러오지 못했어요", retry: retryLabel.ko,
    state: {
      off: { title: "아직 에이전트에게 실리지 않아요", body: "저장은 됩니다. 업데이트 정리가 끝나면 실려요." },
      empty: { title: "비어 있어요", body: "에이전트에게 가는 규칙이 없습니다." },
      missing: { title: "파일이 없어요", body: "앱 밖에서 지웠다면, 이어 가던 대화는 예전 규칙을 기억할 수 있어요.", action: { id: "create", label: "새로 만들기" } },
      unreadable: { title: "파일을 읽을 수 없어요", body: "대화는 규칙 없이 계속됩니다.", action: { id: "clear", label: "비우기" } },
      overflow: (n) => `아래 ${n}줄은 길어서 실리지 않아요`,
      localModels: (kb) => ({ title: "로컬 모델에는 앞부분만 실려요", body: `창이 작은 실행기는 앞의 ${kb}까지만 읽습니다.` }),
    },
    refusal: {
      rules_changed: { title: "밖에서 고쳐졌어요", body: "밖에서 고쳤거나 계정이 바뀌었어요. 저장하지 않았습니다.", action: { id: "reread", label: "다시 읽기" } },
      rules_readonly: { title: "파일에 쓸 수 없어요", body: "이 폴더가 읽기 전용이에요. 저장하지 않았습니다.", action: { id: "retry", label: retryLabel.ko } },
      rules_disk_full: { title: "디스크에 자리가 없어요", body: "자리를 만든 뒤 다시 시도해 주세요. 저장하지 않았습니다.", action: { id: "retry", label: retryLabel.ko } },
      rules_busy: { title: "파일이 사용 중이에요", body: "다른 프로그램이 파일을 쓰고 있어요. 저장하지 않았습니다.", action: { id: "retry", label: retryLabel.ko } },
      rules_unreadable: { title: "파일을 읽을 수 없어요", body: "대화는 규칙 없이 계속됩니다. 저장하지 않았습니다.", action: { id: "reread", label: "다시 읽기" } },
      rules_full: { title: "더 넣을 자리가 없어요", body: "줄을 지운 뒤에 추가할 수 있어요. 추가한 줄은 없습니다." },
      save_failed: { title: "저장하지 못했어요", body: "저장하지 않았습니다.", action: { id: "retry", label: retryLabel.ko } },
      save_full: { title: "글이 너무 길어요", body: "줄을 지운 뒤에 저장할 수 있어요. 저장하지 않았습니다." },
    },
    clearConfirm: { title: "내 규칙을 비울까요?", body: "파일은 남고 글만 지워져요. 이어 가던 대화에는 규칙이 없다고 전해져요.", ok: "비우기" },
    dialog: {
      title: "예전 지시를 내 규칙에 넣을 수 있어요", lead: "고른 줄만 파일 끝에 붙습니다. 안 고르면 내 규칙은 비어 있어요. 원래 기억은 그대로 남습니다.",
      personal: "개인 에이전트가 기억하는 지시", heard: "에이전트·프로젝트가 들은 지시",
      note: "줄은 줄여 쓴 영어일 수 있어요. 프로젝트 없는 작업 세션에서 한 말은 여기에 나오지 않습니다.",
      hint: (n) => `추가한 뒤: “${n}줄 추가 · 이미 있는 줄은 건너뜀”`, add: (n) => `${n}줄 추가`,
      loading: "불러오는 중…", failed: "목록을 불러오지 못했어요", none: "고를 수 있는 예전 지시가 없어요", project: (name) => `${name} 프로젝트`, close: "닫기",
      result: (added, there, unknown) => [added > 0 ? `${added}줄 추가` : "추가한 줄이 없어요", there > 0 ? "이미 있는 줄은 건너뜀" : "", unknown > 0 ? `목록이 바뀌어 건너뛴 줄 ${unknown}개` : ""].filter(Boolean).join(" · "),
    },
  },
  en: {
    title: "My rules", pick: "Pick from earlier instructions", open: "Open file", openFailed: "The file could not be opened.", clear: "Clear", cancel: "Cancel", later: "Later",
    chips: ["Work sessions", "Agent chats", "Group chats"], notRead: "Not read by your personal agent, Finance, Science, Build or team runs",
    saved: "Saved", saving: "Saving…", unsaved: "Not saved yet", local: "on this computer only", noAuto: "Nothing is added here by itself",
    placeholder: "One rule per line. For example: Answer briefly.", editorLabel: "My rules text", sidebarRow: "My rules",
    loading: "Loading…", loadFailed: "Could not load My rules", retry: retryLabel.en,
    state: {
      off: { title: "Not given to agents yet", body: "It is saved. Agents get it when the update cleanup finishes." },
      empty: { title: "Empty", body: "No rules go to agents." },
      missing: { title: "The file is missing", body: "If it was deleted outside the app, chats already open may still remember the old rules.", action: { id: "create", label: "Create" } },
      unreadable: { title: "The file cannot be read", body: "Chats go on without rules.", action: { id: "clear", label: "Clear" } },
      overflow: (n) => `The ${n} ${n === 1 ? "line" : "lines"} below ${n === 1 ? "is" : "are"} too long to be given`,
      localModels: (kb) => ({ title: "Local models get the first part only", body: `Runners with a small window read the first ${kb}.` }),
    },
    refusal: {
      rules_changed: { title: "It was changed outside", body: "Edited outside or the account changed. Not saved.", action: { id: "reread", label: "Read again" } },
      rules_readonly: { title: "The file cannot be written", body: "This folder is read-only. Not saved.", action: { id: "retry", label: retryLabel.en } },
      rules_disk_full: { title: "The disk is full", body: "Free some space and try again. Not saved.", action: { id: "retry", label: retryLabel.en } },
      rules_busy: { title: "The file is in use", body: "Another program is writing to it. Not saved.", action: { id: "retry", label: retryLabel.en } },
      rules_unreadable: { title: "The file cannot be read", body: "Chats go on without rules. Not saved.", action: { id: "reread", label: "Read again" } },
      rules_full: { title: "No room for more", body: "Remove lines first. Nothing was added." },
      save_failed: { title: "Could not save", body: "Not saved.", action: { id: "retry", label: retryLabel.en } },
      save_full: { title: "The text is too long", body: "Remove lines, then it can be saved. Not saved." },
    },
    clearConfirm: { title: "Clear My rules?", body: "The file stays and only its text is removed. Chats already open are told there are no rules.", ok: "Clear" },
    dialog: {
      title: "You can add earlier instructions to My rules", lead: "Only the lines you tick are added to the end of the file. Tick nothing and My rules stays empty. The original memories stay as they are.",
      personal: "Instructions your personal agent remembers", heard: "Instructions agents and projects were given",
      note: "Lines may be shortened English. Things said in a work session without a project do not appear here.",
      hint: (n) => `After adding: “${n} ${n === 1 ? "line" : "lines"} added · lines already there are skipped”`, add: (n) => `Add ${n} ${n === 1 ? "line" : "lines"}`,
      loading: "Loading…", failed: "Could not load the list", none: "There are no earlier instructions to pick", project: (name) => `${name} project`, close: "Close",
      result: (added, there, unknown) => [added > 0 ? `${added} ${added === 1 ? "line" : "lines"} added` : "No line was added", there > 0 ? "lines already there are skipped" : "", unknown > 0 ? `${unknown} skipped because the list changed` : ""].filter(Boolean).join(" · "),
    },
  },
};

export const rulesCopy = (locale: RulesLocale): Words => COPY[locale];
