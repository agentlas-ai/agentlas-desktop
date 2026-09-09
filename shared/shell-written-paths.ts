/**
 * Files a shell command created or wrote, read from the command itself.
 *
 * The result rail collects what a turn produced from the typed write/edit tool calls. A model that
 * is refused the write tool does the obvious thing and reaches for the shell instead — and every
 * file it makes that way was invisible. Measured: five files on disk, the rail said "0 outputs", and
 * the one thing it did show was a path taken from the answer's prose that had never been created.
 * Prose won because nothing else was there.
 *
 * This reads only unambiguous, explicit destinations. It is deliberately conservative: a path that
 * merely appears in a command is not a claim that the command wrote it, and a wrong entry in the
 * result rail is worse than a missing one — it sends a person to a file that is not there.
 */

/** A redirection or a writing tool's explicit destination. Never a glob, a variable, or a pipe. */
const REDIRECT_RE = /(?:^|\s|;|&&|\|\|)(?:1)?>{1,2}\s*("([^"]+)"|'([^']+)'|([^\s;|&<>]+))/g;
/** `tee [-a] FILE`, `cp SRC DEST`, `mv SRC DEST`, `install ... DEST`, `touch FILE...` */
const TOOL_DEST_RE = /(?:^|\s|;|&&|\|\|)(tee|cp|mv|touch|install)\s+((?:-[A-Za-z-]+\s+)*)([^\n;|&]+)/g;

function unquote(value: string): string {
  let trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  // A command passed to `sh -c`/`zsh -lc` carries its closing wrapper quote
  // through TOOL_DEST_RE.  It is not part of the destination (for example,
  // `zsh -lc 'cp src /tmp/out'` used to produce `/tmp/out'`).  Only remove an
  // unmatched trailing quote; paired quotes still belong to the operand above.
  const trailing = trimmed.at(-1);
  if ((trailing === "'" || trailing === '"') && [...trimmed].filter((char) => char === trailing).length % 2 === 1) {
    trimmed = trimmed.slice(0, -1).trimEnd();
  }
  return trimmed;
}

/** Split command operands while retaining quote boundaries for `unquote`. */
function shellOperands(value: string): string[] {
  const operands: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = () => {
    if (token) operands.push(token);
    token = "";
  };

  for (const char of value.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      token += char;
      escaped = true;
      continue;
    }
    if (quote) {
      token += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      token += char;
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      push();
      continue;
    }
    token += char;
  }
  push();
  return operands;
}

function usablePath(value: string): boolean {
  const p = unquote(value);
  if (!p || p.length > 4_096) return false;
  // A destination we cannot resolve to one exact file is not evidence of one exact file.
  if (/[*?\[\]$`~]/.test(p)) return false;
  if (/^\/dev\//.test(p)) return false;
  if (p === "-" || p.startsWith("&")) return false;
  return p.includes("/") || /\.[A-Za-z0-9]{1,12}$/.test(p);
}

/**
 * Paths this command explicitly writes to. Order is the order they appear; duplicates removed.
 */
export function shellWrittenPaths(command: string): string[] {
  if (typeof command !== "string" || !command.trim()) return [];
  const found: string[] = [];
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const p = unquote(raw);
    if (!usablePath(p) || found.includes(p)) return;
    found.push(p);
  };

  for (const match of command.matchAll(REDIRECT_RE)) {
    add(match[2] ?? match[3] ?? match[4]);
  }

  for (const match of command.matchAll(TOOL_DEST_RE)) {
    const verb = match[1];
    const operands = shellOperands(match[3] ?? "")
      .map(unquote)
      .filter(Boolean);
    if (operands.length === 0) continue;
    if (verb === "touch") {
      for (const operand of operands) add(operand);
      continue;
    }
    if (verb === "tee") {
      for (const operand of operands) add(operand);
      continue;
    }
    // cp / mv / install: only the final operand is the destination, and only when it is one file.
    if (operands.length >= 2) add(operands[operands.length - 1]);
  }

  return found;
}
