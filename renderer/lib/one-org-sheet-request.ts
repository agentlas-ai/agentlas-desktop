/**
 * A request to open a staff sheet (tools / replace) from the unified edit dialog is handled once.
 *
 * Production 2026-10-04 (owner screenshot, Youtube launch room): the "조직원 설정 · motion grap" sheet kept opening by
 * itself. OneOrgChart handled the request in an effect keyed on the request and the org members; while a room runs,
 * the members list is re-read on every store change, so the same old request re-opened the sheet each time. A request
 * now opens its sheet once — when its member is present — and is spent after that.
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
