/**
 * 작업 제목의 자리표시자를 가려낸다.
 *
 * ★왜 이 파일이 있나 (실측 2026-09-08, QA: "New task 가 한국어 화면에 그대로 뜬다").
 *
 * 새 작업은 **엔진이 영어 문자열 "New task" 를 제목으로 저장한다**
 * (electron/ipc.ts 의 `tasks:createProject`). 그래서 화면에서
 *
 *     {task.title || (ko ? "새 작업" : "New task")}
 *
 * 처럼 쓰면 폴백이 **영원히 안 걸린다** — "New task" 는 빈 문자열이 아니기 때문이다.
 * 한국어 사용자는 아직 이름 없는 작업마다 영어를 본다. 소스만 보면 번역돼 있는
 * 것처럼 보이는 것이 이 결함이 오래 남은 이유다.
 *
 * 그래서 "비었는가"가 아니라 **"아직 이름이 없는가"**를 묻는 함수 하나를 둔다.
 */

/** 엔진과 화면이 새 작업에 붙이는 자리표시자들. 어느 언어로 저장됐든 이름이 없는 것이다. */
const PLACEHOLDER_TITLES = ["", "새 채팅", "New chat", "새 작업", "New task", "New conversation"];

export function isPlaceholderTaskTitle(value: string | null | undefined): boolean {
  return PLACEHOLDER_TITLES.includes((value ?? "").trim());
}

/** 화면에 쓸 제목 — 아직 이름이 없으면 그 화면의 언어로 말한다. */
export function taskTitleForDisplay(value: string | null | undefined, ko: boolean): string {
  return isPlaceholderTaskTitle(value) ? (ko ? "새 작업" : "New task") : (value ?? "").trim();
}
