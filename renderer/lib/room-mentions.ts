/**
 * @mention highlighting for group-room messages: pure text splitting, no React. A mention is `@Name` for a name
 * the room knows (teammates and One), at a word start, so an e-mail address or a stray `@` is never highlighted.
 */
export type MentionPart = string | { mention: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function splitMentions(text: string, names: readonly string[] | undefined): MentionPart[] {
  const known = [...new Set((names ?? []).map((name) => name.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!text.includes("@") || known.length === 0) return [text];
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])@(${known.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  const parts: MentionPart[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[1]!.length;
    if (start > last) parts.push(text.slice(last, start));
    parts.push({ mention: `@${match[2]}` });
    last = start + 1 + match[2]!.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : [text];
}
