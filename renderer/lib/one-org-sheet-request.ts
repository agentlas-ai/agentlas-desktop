/**
 * A request to open a staff sheet (tools / replace) from the unified edit dialog is handled once.
 *
 * Production 2026-10-04 (owner screenshot, Youtube launch room): the "조직원 설정 · motion grap" sheet kept opening by
 * itself. OneOrgChart handled the request in an effect keyed on the request and the org members; while a room runs,
 * the members list is re-read on every store change, so the same old request re-opened the sheet each time. A request
 * now opens its sheet once — when its member is present — and is spent after that.
 *
 * Production again, 2026-10-04 (owner: "저번에 한 번 내가 수정한 이후로" the edit sheet keeps popping up): the
 * handled token lived inside OneOrgChart, which mounts only on the Agents tab. Every return to that tab mounted a fresh
 * chart with handled 0, and the request still held by OneShell opened the sheet again. The owner of the request now
 * clears it once taken (`spentOrgSheetRequest`), and tokens come from a counter that never restarts.
 */
export interface OrgSheetRequest { token: number; kind: "tools" | "replace"; memberId: string }

export function takeOrgSheetRequest<M extends { id: string }>(
  request: OrgSheetRequest | null | undefined,
  handledToken: number,
  members: readonly M[] | null | undefined,
): { member: M; kind: OrgSheetRequest["kind"]; token: number } | null {
  if (!request?.token || request.token === handledToken) return null;
  // Not spent while the member is not loaded yet: the next members read opens it.
  const member = members?.find((row) => row.id === request.memberId);
  return member ? { member, kind: request.kind, token: request.token } : null;
}

/** OneShell's side: the request a chart took is cleared, so a later mount cannot open it again. A newer request stays. */
export function spentOrgSheetRequest(current: OrgSheetRequest | null, takenToken: number): OrgSheetRequest | null {
  return current?.token === takenToken ? null : current;
}
