/**
 * An empty HTML comment shell (`<!--`, blank lines, `-->`) is not drawn. It is what was left when only a hidden Memory Events
 * block was cut from a reply (fixed at the source ; older answers keep it in storage). Lines inside a code fence and
 * a comment that holds anything are left as they are.
 */
export function withoutEmptyCommentShells(text: string): string {
  if (!text.includes("<!--")) return text;
  const lines = text.split("\n"), kept: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i], marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence ? null : marker;
    if (!fence && /^\s*<!--\s*(-->\s*)?$/.test(line)) {
      let close = /-->\s*$/.test(line) ? i : -1;
      for (let j = i + 1; close < 0 && j < lines.length && /^\s*(-->\s*)?$/.test(lines[j]); j += 1) if (/-->/.test(lines[j])) close = j;
      if (close >= 0) { i = close; continue; }
    }
    kept.push(line);
  }
  return kept.join("\n");
}
