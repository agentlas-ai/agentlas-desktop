import { CHART_FENCE_LANGUAGES } from './chart-spec';

/** Data-bearing languages rendered inline, shared by display projections. */
export const HTML_VISUAL_FENCE_LANGUAGES = ['visual', 'html-visual', 'artifact-html'] as const;
export function isInlineVisualFence(info: string): boolean {
  const language = info.trim().split(/\s+/, 1)[0].toLowerCase();
  return language === 'agentlas-ui' || language === 'mermaid'
    || (CHART_FENCE_LANGUAGES as readonly string[]).includes(language)
    || (HTML_VISUAL_FENCE_LANGUAGES as readonly string[]).includes(language);
}

export function inlineVisualRanges(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let opened: { start: number; marker: string; visual: boolean } | null = null;
  for (let start = 0; start < source.length;) {
    const newline = source.indexOf('\n', start);
    const end = newline < 0 ? source.length : newline + 1;
    const line = source.slice(start, newline < 0 ? source.length : newline).replace(/\r$/, '');
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match && !opened && !(match[1][0] === '`' && match[2].includes('`'))) {
      opened = { start, marker: match[1], visual: isInlineVisualFence(match[2]) };
    } else if (match && opened && match[1][0] === opened.marker[0]
      && match[1].length >= opened.marker.length && !match[2].trim()) {
      if (opened.visual) ranges.push({ start: opened.start, end });
      opened = null;
    }
    start = end;
  }
  if (opened?.visual) ranges.push({ start: opened.start, end: source.length });
  return ranges;
}

/** Prose cleanup must never rewrite, flatten or redact widget wire data. */
export function mapInlineVisualProse(source: string, project: (prose: string) => string): string {
  const ranges = inlineVisualRanges(source);
  if (!ranges.length) return project(source);
  const prose = (text: string): string => {
    const projected = project(text).trim();
    // Cleanup often trims prose. Keep the source's line boundaries so the
    // restored opener remains a Markdown fence, never inline backticks.
    const leading = /^\s*/.exec(text)![0];
    const trailing = /\s*$/.exec(text)![0];
    return text.trim() ? leading + projected + trailing : text;
  };
  let result = '';
  let copied = 0;
  for (const range of ranges) {
    result += prose(source.slice(copied, range.start));
    result += source.slice(range.start, range.end);
    copied = range.end;
  }
  return result + prose(source.slice(copied));
}
