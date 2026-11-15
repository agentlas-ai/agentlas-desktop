// Windows `cmd.exe /d /s /c "<line>"` argument quoting — pure functions, no I/O, no platform check.
//
// Two parsers read the same line, and each needs its own escaping (qntm.org/cmd; Microsoft "Parsing C command-line
// arguments"):
//  1. the program's own argv split (MSVCRT / CommandLineToArgvW): an argument is wrapped in `"`; a run of N backslashes
//     before a `"` (or before the closing quote at the end) is written as 2N backslashes, and the `"` itself as `\"`.
//  2. cmd.exe: every metacharacter, including every `"`, is prefixed with `^`, so cmd never sees a quote and never
//     splits or expands anything. A batch file that forwards `%*` makes cmd parse the arguments a second time, so the
//     `^` escaping is applied twice for it.
//
// cross-spawn 7.0.6 (lib/util/escape.js) does layer 2 the same way but gets layer 1 wrong for a run of two or more
// backslashes: its `(?=(\\+?)?)\1"` captures one backslash lazily, so `\\"` becomes four backslashes and a delimiting
// quote instead of five and a literal one. A value that ends in `\\"` (codex `-c shell_environment_policy.set.TMPDIR=
// "C:\\...\\"`, sandbox-tool-cache.ts) then swallowed the arguments after it (Windows VM 2nd run). The
// backslash scan here is linear and has no regex to backtrack.

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Layer 1: the MSVCRT-safe form of one argument, always quoted (an empty argument stays `""`). */
export function quoteMsvcrtArgument(value: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") { backslashes++; continue; }
    quoted += character === '"'
      ? "\\".repeat(backslashes * 2 + 1) + '"'
      : "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

/** Layers 1 + 2 for one argument. `doubleEscape` is for a batch file that re-parses `%*`. */
export function escapeWindowsCmdArgument(value: string, doubleEscape: boolean): string {
  let escaped = quoteMsvcrtArgument(`${value}`).replace(CMD_META, "^$1");
  if (doubleEscape) escaped = escaped.replace(CMD_META, "^$1");
  return escaped;
}

/** Layer 2 for the program or batch path (never quoted: cmd's own caret escaping carries spaces). */
export function escapeWindowsCmdCommand(command: string): string {
  return command.replace(CMD_META, "^$1");
}

/** The text between the outer quotes of `cmd.exe /d /s /c "…"`. */
export function windowsCmdLine(command: string, args: readonly string[], doubleEscape: boolean): string {
  return [escapeWindowsCmdCommand(command), ...args.map((arg) => escapeWindowsCmdArgument(arg, doubleEscape))].join(" ");
}

/** The argv for spawning cmd.exe with `windowsVerbatimArguments: true`. */
export function windowsCmdSpawnArgs(command: string, args: readonly string[], doubleEscape: boolean): string[] {
  return ["/d", "/s", "/c", `"${windowsCmdLine(command, args, doubleEscape)}"`];
}

/**
 * The same functions as plain JavaScript text, for a generated stand-alone script that cannot import this module
 * (the MCP child wrapper, mcp-tools/mcp-config.ts). Built from the functions above with Function.prototype.toString, so
 * there is one source; they call each other by plain name and use only CMD_META, which keeps this valid for tsc output.
 */
export function windowsCmdQuoteWrapperSource(): string {
  return [
    `const CMD_META = ${CMD_META.toString()};`,
    quoteMsvcrtArgument,
    escapeWindowsCmdArgument,
    escapeWindowsCmdCommand,
    windowsCmdLine,
    windowsCmdSpawnArgs,
  ].map((part) => (typeof part === "string" ? part : part.toString())).join("\n");
}
