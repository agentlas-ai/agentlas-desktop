/**
 * Shell command → what it *did*, the way Codex's TUI folds `sed -n`/`ls`/`rg`
 * calls into one "Explored" cell (`codex-rs/core/src/parse_command.rs`, ported
 * to the subset that matters for a chat timeline).
 *
 * The parse is deliberately shallow: split a command line on the top-level
 * connectors (`&&`, `||`, `;`, `|`), strip the `zsh -lc '…'` wrapper runtimes
 * add, then classify each segment by its first word. Anything unrecognised is
 * an ordinary "run" — never guessed into a read.
 *
 * Only exploratory segments (read/list/search) make a command exploratory as a
 * whole; one `npm test` in the chain turns the whole line into "Ran".
 */

export type ParsedShellSegment =
  | { op: "read"; name: string }
  | { op: "list"; path: string }
  | { op: "search"; query?: string; path?: string; cmd: string }
  | { op: "run"; cmd: string };

const WRAPPER_RE = /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|zsh|sh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/;

/** `/bin/zsh -lc 'ls -la'` → `ls -la`; leaves other commands alone. */
export function stripShellWrapper(command: string): string {
  const trimmed = command.trim();
  const match = WRAPPER_RE.exec(trimmed);
  return match ? match[2].trim() : trimmed;
}

function splitTopLevel(command: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    const next = command[index + 1];
    if (quote) {
      buf += ch;
      if (ch === quote && command[index - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      buf += ch;
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      parts.push(buf);
      buf = "";
      index += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function tokenize(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"\\]|\\.)*"|'[^']*'|\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(segment)) !== null) {
    let token = match[0];
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      token = token.slice(1, -1);
    }
    out.push(token);
  }
  return out;
}

function basename(value: string): string {
  return value.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) || value;
}

function firstPathArg(tokens: string[]): string | undefined {
  for (const token of tokens.slice(1)) {
    if (token.startsWith("-")) continue;
    // sed's script (`-n '1,80p'`) is not a file.
    if (/^\d+(?:,\d+)?p$/.test(token) || /^\d+,\$p$/.test(token)) continue;
    return token;
  }
  return undefined;
}

function classify(segment: string): ParsedShellSegment {
  const tokens = tokenize(segment);
  let head = tokens[0] ?? "";
  // `cd dir && …` prefixes and env assignments (`FOO=1 cmd`) are noise here.
  let cursor = 0;
  while (head && /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
    cursor += 1;
    head = tokens[cursor] ?? "";
  }
  const rest = tokens.slice(cursor);
  const cmd = rest.join(" ") || segment;
  const name = basename(head);
  switch (name) {
    case "cat":
    case "head":
    case "tail":
    case "bat":
    case "less":
    case "more":
    case "nl": {
      const file = firstPathArg(rest);
      return file ? { op: "read", name: basename(file) } : { op: "run", cmd };
    }
    case "sed": {
      // Only `sed -n 'A,Bp' file` is a read; `sed -i` edits.
      if (rest.some((token) => /^-i/.test(token))) return { op: "run", cmd };
      const file = rest.slice(1).filter((token) => !token.startsWith("-") && !/^\d+(?:,\$|,\d+)?p$/.test(token)).at(-1);
      return file ? { op: "read", name: basename(file) } : { op: "run", cmd };
    }
    case "ls":
    case "tree":
    case "exa":
    case "eza": {
      const path = firstPathArg(rest);
      return { op: "list", path: path ?? "." };
    }
    case "rg":
    case "grep":
    case "ag":
    case "ack":
    case "fd":
    case "find": {
      const positional = rest.slice(1).filter((token) => !token.startsWith("-"));
      if (name === "find" || name === "fd") {
        // find PATH -name QUERY
        const nameIndex = rest.findIndex((token) => token === "-name" || token === "-iname");
        const query = nameIndex >= 0 ? rest[nameIndex + 1] : name === "fd" ? positional[0] : undefined;
        const path = name === "fd" ? positional[1] : positional[0];
        return { op: "search", ...(query ? { query } : {}), ...(path ? { path } : {}), cmd };
      }
      const query = positional[0];
      const path = positional[1];
      return { op: "search", ...(query ? { query } : {}), ...(path ? { path } : {}), cmd };
    }
    case "git": {
      if (rest[1] === "grep") {
        const positional = rest.slice(2).filter((token) => !token.startsWith("-"));
        return { op: "search", ...(positional[0] ? { query: positional[0] } : {}), cmd };
      }
      return { op: "run", cmd };
    }
    default:
      return { op: "run", cmd };
  }
}

export function parseShellCommand(command: string): ParsedShellSegment[] {
  const unwrapped = stripShellWrapper(command);
  if (!unwrapped) return [];
  const segments = splitTopLevel(unwrapped);
  const parsed = segments
    .filter((segment) => !/^cd\s/.test(segment) && segment !== "cd")
    .map(classify);
  // `wc -l`, `sort`, `head` after a pipe are still exploration when the chain
  // started as one (`rg foo | head`), so a run segment after an exploratory
  // one is folded into that exploration.
  if (parsed.length > 1 && parsed[0].op !== "run" && parsed.every((segment) => segment.op !== "run" || /^(?:wc|sort|uniq|head|tail|cut|awk|tr|xargs)\b/.test(segment.cmd))) {
    return parsed.filter((segment) => segment.op !== "run");
  }
  return parsed;
}

/** True when the whole command line is reading/listing/searching. */
export function isExploratoryShellCommand(command: string): boolean {
  const parsed = parseShellCommand(command);
  return parsed.length > 0 && parsed.every((segment) => segment.op !== "run");
}
