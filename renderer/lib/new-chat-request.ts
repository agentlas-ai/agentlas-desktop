/**
 * "New chat" from the left list. The button in the sidebar's top (ProjectSidebar), the "+" on a project row (HomeTree) and the
 * rail's button all ask for it the same way; one NewChatHost (mounted once in ProjectSidebar, expanded or rail) answers.
 * F-D6 replaces what the host opens (the start screen with its project / session drop-downs); the three callers stay as they are.
 *   projectId: a project id            -> that project (the row's "+")
 *              null                    -> no project: the top button starts where the person pressed it (outside every project), never in the project of
 * whatever pane happens to be focused (a new chat came up inside another chat's project and its
 *                                         files could not be reached). A new chat in a project is the "+" on that project's row.
 *              "current"               -> the project of the conversation on screen, none when there is none (no caller asks for it now)
 */
export type NewChatRequest = { projectId: string | null | "current"; projectName?: string | null };
const EVENT = "agentlas:new-chat-request";

export function requestNewChat(detail: NewChatRequest): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<NewChatRequest>(EVENT, { detail }));
}

export function onNewChatRequest(handler: (request: NewChatRequest) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<NewChatRequest>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
