/**
 * Which surface owns a conversation — the one rule every screen and the phone projection read.
 *
 * `chats.origin_surface` alone decides. A room that belongs to a project (`project_id`) is still an Agent Chat room when it was
 * started from Agent Chat: the project says WHERE it lives in the tree, never WHICH screen opens it. Before this rule the Work
 * screen (TaskCockpit) opened a project room as a Work session without a group UI, while the approval sheet and the phone sent the
 * same room to One.
 *
 * `legacyOneReceipt` is the phone projection's compatibility proof for chats created before `origin_surface` existed.
 */
export function chatBelongsToOne(chat: { originSurface?: string | null }, legacyOneReceipt = false): boolean {
  return chat.originSurface === "one" || legacyOneReceipt;
}
