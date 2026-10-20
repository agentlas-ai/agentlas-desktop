import { validateInlineUiPresentationContent, type InlineUiPresentationContent } from './inline-ui-presentation';
import { inlineVisualRanges } from './inline-visual';
import { parseIntellectUiFence } from './intellect-ui';
import type { UiInstanceView } from './ui-instances';
import type { ChatHistoryEntry } from './types';

/** Existing message DTOs carry validated views to old Mobile clients without DB writes. */
export function inlineUiContentFence(content: unknown): string | null {
  const checked = validateInlineUiPresentationContent(content);
  if (!checked.ok) return null;
  const value = checked.content;
  const language = value.kind === 'native' ? 'agentlas-ui' : value.kind === 'chart' ? 'chart' : 'visual';
  const body = value.kind === 'native' ? JSON.stringify(value.document)
    : value.kind === 'chart' ? JSON.stringify(value.spec) : value.html;
  // HTML can contain Markdown backtick lines. A longer marker keeps it atomic.
  const runs = body.match(/`+/g) ?? [];
  const marker = '`'.repeat(runs.reduce((longest, run) => Math.max(longest, run.length + 1), 3));
  return `${marker}${language}\n${body}\n${marker}`;
}

function existingContentFences(history: readonly ChatHistoryEntry[]): Set<string> {
  const found = new Set<string>();
  for (const message of history) {
    if (message.role !== 'assistant') continue;
    for (const range of inlineVisualRanges(message.text)) {
      const block = message.text.slice(range.start, range.end).replace(/\r?\n$/, '');
      const firstNewline = block.indexOf('\n');
      const lastNewline = block.lastIndexOf('\n');
      if (firstNewline < 0 || lastNewline <= firstNewline) continue;
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(block);
      const closing = /^ {0,3}(`+|~+)[ \t]*\r?$/.exec(block.slice(lastNewline + 1));
      if (!opening || !closing || opening[1][0] !== closing[1][0] || closing[1].length < opening[1].length) continue;
      const language = block.slice(0, firstNewline).trim().replace(/^(`+|~+)/, '').split(/\s+/, 1)[0].toLowerCase();
      const body = block.slice(firstNewline + 1, lastNewline).replace(/\r$/, '');
      let content: unknown;
      try {
        if (language === 'agentlas-ui') content = { kind: 'native', document: parseIntellectUiFence(body).document };
        else if (['chart', 'vega-lite', 'vegalite', 'vega-lite+json', 'vl'].includes(language)) content = { kind: 'chart', spec: JSON.parse(body) };
        else if (['visual', 'html-visual', 'artifact-html'].includes(language)) content = { kind: 'visual', html: body };
        else continue;
        const fence = inlineUiContentFence(content);
        if (fence) found.add(fence);
      } catch { /* Incomplete or invalid provider text never stands in for a validated view. */ }
    }
  }
  return found;
}

export interface InlineUiTranscriptProjection {
  history: ChatHistoryEntry[];
  /** Kept off the wire: only host-validated pseudo rows qualify for atomic projection. */
  fallbackByMessageId: Map<string, string>;
}
export function mergeInlineUiTranscript(
  chatId: string,
  history: readonly ChatHistoryEntry[],
  instances: readonly UiInstanceView[],
  resolvedContents?: ReadonlyMap<string, readonly InlineUiPresentationContent[]>,
): InlineUiTranscriptProjection {
  const merged = [...history];
  const fallbackByMessageId = new Map<string, string>();
  const ids = new Set(history.map(message => message.id));
  const fences = existingContentFences(history);
  for (const instance of instances) {
    if (instance.chatId !== chatId || instance.state === 'closed' || instance.closedAt
      || !/^[A-Za-z0-9_.:-]{1,244}$/.test(instance.instanceId)
      || !Number.isFinite(Date.parse(instance.createdAt))) continue;
    const id = `ui-instance:${instance.instanceId}`;
    if (ids.has(id)) continue;
    const contents = instance.content ? [instance.content] : resolvedContents?.get(instance.instanceId) ?? [];
    if (!contents.length || contents.length > 16) continue;
    const validated = contents.map(inlineUiContentFence);
    if (validated.some(fence => !fence)) continue;
    const fresh = [...new Set(validated as string[])].filter(fence => !fences.has(fence));
    if (!fresh.length) continue;
    const fence = fresh.join('\n\n');
    const fallback = instance.presentation.fallbackText?.trim() || instance.presentation.title?.trim() || 'Interactive result';
    merged.push({ id, role: 'assistant', text: `${fallback}\n\n${fence}`, createdAt: instance.createdAt });
    fallbackByMessageId.set(id, fallback);
    ids.add(id);
    fresh.forEach(value => fences.add(value));
  }
  merged.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  return { history: merged, fallbackByMessageId };
}

/** Wire size includes JSON escaping; never truncate a typed view inside its payload. */
export function fitInlineUiTranscriptText(
  text: string,
  fallback: string,
  maxUtf8Bytes: number,
  maxJsonStringBytes: number,
): string {
  const encoder = new TextEncoder();
  const fits = (value: string) => encoder.encode(value).length <= maxUtf8Bytes
    && encoder.encode(JSON.stringify(value)).length <= maxJsonStringBytes;
  if (fits(text)) return text;
  let safe = '';
  for (const character of fallback) {
    if (!fits(safe + character)) break;
    safe += character;
  }
  return safe;
}
