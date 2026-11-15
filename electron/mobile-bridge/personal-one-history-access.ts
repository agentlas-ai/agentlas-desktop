/** Captures exactly the authenticated account and personal One that own a transcript read. */
export interface PersonalOneHistoryAuthority {
  oneId: string;
  userId: string;
  workspaceId: string;
}

export function requirePersonalOneHistoryAuthority(input: {
  activeOneId: string | null;
  chatOneId: string | null;
  actor: { userId: string; workspaceId: string } | null;
  paired: boolean;
}): PersonalOneHistoryAuthority {
  const { activeOneId, chatOneId, actor, paired } = input;
  if (!paired || !activeOneId || chatOneId !== activeOneId || !actor?.userId || !actor.workspaceId) {
    throw new Error('account_mismatch');
  }
  return { oneId: activeOneId, userId: actor.userId, workspaceId: actor.workspaceId };
}

export function assertPersonalOneHistoryUnchanged(
  expected: PersonalOneHistoryAuthority,
  current: PersonalOneHistoryAuthority,
): void {
  if (expected.oneId !== current.oneId || expected.userId !== current.userId || expected.workspaceId !== current.workspaceId) {
    throw new Error('account_mismatch');
  }
}
