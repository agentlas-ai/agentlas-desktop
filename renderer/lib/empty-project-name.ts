/*
 * The name of the "Empty project" a conversation starts with. The project is made together with its first message (never before), and the sidebar
 * groups conversations under the project's name: every one named "New project" left four identical headings that told nothing apart. The
 * first message is what the person said about the work, so a short form of its first line names the project; the fixed name is the
 * fallback for a message that has no words in it. The name is only a name - the person renames the project in its settings.
 */
export const EMPTY_PROJECT_NAME_MAX = 32;

export function emptyProjectName(message: string, fallback: string, max: number = EMPTY_PROJECT_NAME_MAX): string {
  const firstLine = (message ?? "").split(/\r?\n/).find((line) => line.trim()) ?? "";
  // Marks a message may open with (a quote, a list bullet, a heading) are not part of its subject.
  const text = firstLine.replace(/^[\s>#*\-•]+/u, "").replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return fallback;
  // A first line that is only a file path ("/tmp/work/a.xlsx") is not a name for a project.
  if (!/\s/.test(text) && /^(?:[~.]?[\\/]|[A-Za-z]:[\\/])/.test(text)) return fallback;
  const letters = Array.from(text);
  if (letters.length <= max) return text;
  // Cut at a word boundary when one sits in the last third; otherwise at the limit.
  const cut = letters.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const kept = space >= Math.floor(max * 0.66) ? cut.slice(0, space) : cut;
  return `${kept.join("").trimEnd()}…`;
}
