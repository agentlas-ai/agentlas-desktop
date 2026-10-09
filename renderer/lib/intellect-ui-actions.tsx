"use client";

import { createContext } from "react";

/** A user gesture can prepare a draft only in the conversation that owns it. */
export type IntellectUiFollowup = (prompt: string) => boolean | Promise<boolean>;

/** Match the Markdown fence boundary before choosing the owning reply layout.
 * A typed UI example inside a longer ordinary code fence remains ordinary prose/code.
 * This scan does not parse component JSON on every composer render. */
export function hasIntellectUiFence(text: string): boolean {
  if (!/agentlas-ui/i.test(text)) return false;
  let fence: { marker: string; length: number } | null = null;
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(start, end).replace(/\r$/, "");
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = null;
    } else {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      // Markdown forbids backticks in the header; reject them before regex backtracking.
      const opening = marker && !line.slice(marker[0].length).includes("`")
        ? /^ {0,3}(`{3,}|~{3,})([\w+.-]*)(?:[ \t]+([^`]*?))?\s*$/.exec(line)
        : null;
      if (opening) {
        if (opening[2].toLowerCase() === "agentlas-ui") return true;
        fence = { marker: opening[1][0], length: opening[1].length };
      }
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  return false;
}

export const IntellectUiActions = createContext<{
  prepareFollowup?: IntellectUiFollowup;
  disabled?: boolean;
}>({});
