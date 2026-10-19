/**














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
