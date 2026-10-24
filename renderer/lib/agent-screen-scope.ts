// The detached screen follows the mounted, validated Work task, never the
// newest active invocation elsewhere in the app.
import { createScopeSelection } from '../../shared/scope-selection';

const selection = createScopeSelection<string>();
export const agentScreenChatId = (): string | null => selection.read();
export function subscribeAgentScreenScope(listener: () => void): () => void {
  return selection.subscribe(listener);
}
export function bindAgentScreenScope(next: string | null): () => void {
  return selection.bind(next);
}
