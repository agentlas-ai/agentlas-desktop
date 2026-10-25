// Chat answers never show account names or absolute local paths: a path becomes its file name, a local
// file link becomes its label (ChatStream.tsx). Image references are handled by the caller (kept whole).
//
// Windows audit 2026-10-24 (ui.md #6): the rule matched only macOS `/Users/…`. On Windows every answer that
// named the Work folder showed `C:\Users\<account>\AppData\Roaming\Agentlas\…` in full (Linux: `/home/…`),
// and a markdown link `[hello.txt](file:///C:/Users/…/hello.txt)` was rewritten to `file:///C:hello.txt`,
// a broken link. Home roots covered here: `/Users/` (macOS), `/home/` (Linux), `X:\Users\` and `X:/Users/`
// (Windows, also inside file:///X:/Users/…).
//
// Directory segments may hold single spaces (macOS "Application Support", Windows "Program Files"); the last
// (file name) segment may not, so a sentence after the path is not eaten.

const SEGMENT = "[^\\s\\\\/)\\]}>`,]+";
const DIR = `(?:${SEGMENT}(?: ${SEGMENT})*[\\\\/])`;
/** A home root: macOS /Users/, Linux /home/ (not inside a URL path), Windows drive:\Users\ or drive:/Users/. */
const HOME_ROOT = "(?:\\/Users\\/|(?<![\\w.\\-/:])\\/home\\/|(?<![A-Za-z])[A-Za-z]:[\\\\/]Users[\\\\/])";
const FILE_SCHEME = "(?:file:\\/\\/\\/?)?";

const LOCAL_LINK = new RegExp(`\\[([^\\]]+)\\]\\(${FILE_SCHEME}${HOME_ROOT}[^)\\n]+\\)`, "g");
const LOCAL_PATH = new RegExp(`${FILE_SCHEME}${HOME_ROOT}${DIR}*${SEGMENT}`, "g");

/** Replace local paths under a home folder with their last segment; local file links with their label. */
export function shortenLocalPaths(chunk: string): string {
  return chunk
    .replace(LOCAL_LINK, "$1")
    .replace(LOCAL_PATH, (match) => match.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
}

/** The last name in a local path, whichever separator the OS used (`C:\a\b` and `/a/b` both give `b`). */
export function localPathBaseName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}
