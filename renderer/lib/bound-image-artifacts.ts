import { isOneArtifactBindingRequestV1 } from '@shared/one-artifacts';
import type { OneActivityArtifact } from './one-activity';

export function boundArtifactKey(item: OneActivityArtifact): string {
  const b = item.binding;
  return JSON.stringify([b.chatId, b.runId, b.taskId, b.taskVersion, b.manifestId, b.artifactRef]);
}

export function scopedBoundImages(items: readonly OneActivityArtifact[], chatId: string | null | undefined, runId?: string | null): OneActivityArtifact[] {
  if (!chatId) return [];
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.kind !== 'image' || !isOneArtifactBindingRequestV1(item.binding)
      || item.binding.chatId !== chatId || (runId != null && item.binding.runId !== runId)) return false;
    const key = boundArtifactKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
