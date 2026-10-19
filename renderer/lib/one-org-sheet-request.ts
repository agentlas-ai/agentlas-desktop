/**











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
