// Newline-delimited JSON from a child or a file, split on "\n" only.
//
// node:readline also ends a line at U+2028 and U+2029, and JSON carries both unescaped inside strings. One Codex
// thread whose history held 19 U+2028s (text a browser tool copied from Threads) had every thread/resume response
// cut into fragments; each fragment failed JSON.parse, the reader dropped it as a non-JSON log line, and the
// request timed out after 120 s — 17 times in the owner's "Thread Marketing" room (2026-10-03/04). Any
// notification with such text was lost the same way.

import type { Readable } from "node:stream";

const NEWLINE = 0x0a;

function decode(parts: Buffer[]): string {
  const line = (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString("utf8");
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Calls `onLine` for every complete line, and once more for a final line without "\n". */
export function onJsonLines(stream: Readable, onLine: (line: string) => void): void {
  let pending: Buffer[] = [];
  stream.on("data", (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    let start = 0;
    for (let end = bytes.indexOf(NEWLINE, start); end !== -1; end = bytes.indexOf(NEWLINE, start)) {
      pending.push(bytes.subarray(start, end));
      const parts = pending;
      pending = [];
      onLine(decode(parts));
      start = end + 1;
    }
    if (start < bytes.length) pending.push(bytes.subarray(start));
  });
  stream.on("end", () => {
    if (!pending.length) return;
    const parts = pending;
    pending = [];
    onLine(decode(parts));
  });
}

/** The same split as an async iterator (a file read to the end). */
export async function* readJsonLines(stream: Readable): AsyncGenerator<string> {
  let pending: Buffer[] = [];
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk as Buffer;
    let start = 0;
    for (let end = bytes.indexOf(NEWLINE, start); end !== -1; end = bytes.indexOf(NEWLINE, start)) {
      pending.push(bytes.subarray(start, end));
      const parts = pending;
      pending = [];
      yield decode(parts);
      start = end + 1;
    }
    if (start < bytes.length) pending.push(bytes.subarray(start));
  }
  if (pending.length) yield decode(pending);
}
