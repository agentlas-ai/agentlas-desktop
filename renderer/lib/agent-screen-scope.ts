// The detached screen follows the mounted, validated Work task, never the
// newest active invocation elsewhere in the app.
let chatId: string | null = null;
let generation = 0;
const listeners = new Set<() => void>();
export const agentScreenChatId = (): string | null => chatId;
export function subscribeAgentScreenScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function bindAgentScreenScope(next: string | null): () => void {
  const binding = ++generation;
  chatId = next;
  for (const listener of listeners) listener();
  return () => {
    if (generation !== binding) return;
    chatId = null;
    for (const listener of listeners) listener();
  };
}
