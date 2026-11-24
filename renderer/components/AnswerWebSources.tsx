"use client";

import { useEffect, useState } from "react";
import type { RunEventUi } from "@shared/types";
import { mergeWebSources, parseWebSources, webSourcesFromTool, type WebSource } from "@shared/web-search/web-sources";
import { ipc } from "@/lib/ipc";
import { WebSourcesButton } from "./WebSourcesButton";
import styles from "./WebSourcesButton.module.css";

/** How many of a run's first events are read (`runLedger.events` answers 500 at most, the window every One screen reads). */
const RUN_EVENT_WINDOW = 500;

/**
 * The web sources of one run from its ledger rows: the structured `toolSources` a tool event kept, or, for a row written before
 * that field existed, the same reader (shared/web-search/web-sources.ts) over the row's stored result preview. Contract order.
 */
export function webSourcesOfRunEvents(events: readonly RunEventUi[]): WebSource[] {
  const lists: WebSource[][] = [];
  for (const event of events) {
    if (event.kind !== "mcp_tool-use") continue;
    const payload = event.payload ?? {};
    if (payload.toolIsError === true) continue;
    const stored = parseWebSources(payload.toolSources);
    if (stored.length > 0) { lists.push(stored); continue; }
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
    const result = typeof payload.toolResultPreview === "string" ? payload.toolResultPreview : undefined;
    if (!toolName || result === undefined) continue;
    lists.push(webSourcesFromTool({ toolName, args: typeof payload.toolArgs === "string" ? payload.toolArgs : undefined, result }));
  }
  return mergeWebSources(...lists);
}

/**
 * "Sources" under a finished answer on the screens that hold only the answer's run (the personal agent's chat, One chats and
 * rooms). The Work chat (Work, Workspace panes, Finance) draws the same button from its own tool steps (ChatStream). Read once the
 * run has ended: a running answer has no sources row yet, and a finished run's ledger does not change.
 */
export function AnswerWebSources({ runId, done, locale }: { runId?: string | null; done: boolean; locale: "ko" | "en" }) {
  const [sources, setSources] = useState<WebSource[]>([]);
  useEffect(() => {
    if (!runId || !done) return;
    let alive = true;
    const api = ipc();
    if (!api?.runLedger?.events) return;
    void api.runLedger.events(runId, RUN_EVENT_WINDOW)
      .then((events) => { if (alive) setSources(webSourcesOfRunEvents(Array.isArray(events) ? events : [])); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [runId, done]);
  if (sources.length === 0) return null;
  return <div className={styles.answerRow} data-testid="answer-web-sources" data-run-id={runId ?? undefined}>
    <WebSourcesButton sources={sources} locale={locale} />
  </div>;
}
