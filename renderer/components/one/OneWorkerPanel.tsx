"use client";

import { useEffect, useMemo, useState } from "react";
import { Markdown } from "../Markdown";
import { parseWorkerReport, type WorkerReport } from "@shared/worker-report";
import type { OneActivityHandoffMessage } from "@/lib/one-activity";
import { IconArrowLeft, IconSparkles } from "../Icon";
import { buildOneWorkPresentation, groupOneWorkerWork } from "@/lib/one-turn-work";
import { oneWorkerPanelFeed, ONE_WORKER_FEED_LIMIT, type OneWorkerPanelRun, type OneWorkerPanelSelection } from "@/lib/one-worker-panel";
import type { OneActivityItem } from "@/lib/one-activity";
import { OneWorkerWorkDetails } from "./OneTurnWork";
import styles from "../workspace/TaskSidePanel.module.css";

function WorkerToolOriginal({ item, locale }: { item: OneActivityItem; locale: "ko" | "en" }) {
  const [open, setOpen] = useState(false);
  if (!item.tool || (!item.tool.args && !item.tool.result)) return null;
  return <details className={styles.workerOriginal} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{locale === "ko" ? "도구 원문" : "Tool details"}</summary>
    {open && <>
      {item.tool.args && <pre>{item.tool.args}</pre>}
      {item.tool.result && <pre>{item.tool.result}</pre>}
    </>}
  </details>;
}

function WorkerRequestOriginal({ text, locale }: { text: string; locale: "ko" | "en" }) {
  const [open, setOpen] = useState(false);
  return <details className={styles.workerOriginal} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{locale === "ko" ? "전달받은 요청" : "Received request"}</summary>
    {open && <pre>{text}</pre>}
  </details>;
}

function WorkerReportBody({ selection, message, locale }: { selection: OneWorkerPanelSelection; message: OneActivityHandoffMessage; locale: "ko" | "en" }) {
  const scopeKey = JSON.stringify([selection.chatId, selection.runId, selection.agentId, message.id]);
  const [loaded, setLoaded] = useState<{ key: string; report: WorkerReport | null } | null>(null);
  useEffect(() => {
    let current = true;
    const scope = { chatId: selection.chatId, runId: selection.runId, agentId: selection.agentId, messageId: message.id };
    const read = window.agentlas?.invoke.workerReport;
    if (!message.reportAvailable || !read) { setLoaded({ key: scopeKey, report: null }); return; }
    void read(scope).then(value => {
      const report = parseWorkerReport(JSON.stringify(value));
      const exact = report && report.chatId === scope.chatId && report.runId === scope.runId
        && report.agentId === scope.agentId && report.messageId === scope.messageId ? report : null;
      if (current) setLoaded({ key: scopeKey, report: exact });
    }).catch(() => { if (current) setLoaded({ key: scopeKey, report: null }); });
    return () => { current = false; };
  }, [scopeKey, message.reportAvailable, selection.chatId, selection.runId, selection.agentId, message.id]);
  const report = loaded?.key === scopeKey ? loaded.report : null;
  const text = report?.text ?? message.text.replace(/…?\[middle omitted\]…?/g, "\n\n…\n\n");
  return <>
    <small>{report ? (report.truncated
      ? (locale === "ko" ? "보고서 · 저장 크기 제한으로 뒷부분 생략" : "Report · remainder exceeds storage limit")
      : (locale === "ko" ? "에이전트 보고" : "Agent report"))
      : (locale === "ko" ? "요약 기록" : "Summary record")}</small>
    <Markdown chatId={selection.chatId} messageId={message.id} text={text} />
  </>;
}

/** Mounted only for the open worker tab; uses the already-loaded exact run. */
export function OneWorkerPanel({ selection, run, locale, onBack }: {
  selection: OneWorkerPanelSelection;
  run: OneWorkerPanelRun | null;
  locale: "ko" | "en";
  onBack: () => void;
}) {
  const feed = useMemo(() => oneWorkerPanelFeed(selection, run), [selection, run]);
  return <section className={styles.workerPanel} aria-label={locale === "ko" ? "서브에이전트 활동" : "Subagent activity"}
    data-worker-chat-id={selection.chatId} data-worker-run-id={selection.runId} data-worker-agent-id={selection.agentId}>
    <header className={styles.workerPanelHeader}>
      <button type="button" onClick={onBack} aria-label={locale === "ko" ? "이전 출력으로 돌아가기" : "Back to outputs"}><IconArrowLeft size={16} /></button>
      <IconSparkles size={16} /><strong>{selection.name || (locale === "ko" ? "서브에이전트" : "Subagent")}</strong>
    </header>
    <div className={styles.workerPanelFeed}>
      {feed.length === 0 && <p className={styles.workerPanelEmpty}>{locale === "ko" ? "이 실행의 에이전트 기록이 아직 없습니다." : "No agent activity is available for this run yet."}</p>}
      {feed.length >= ONE_WORKER_FEED_LIMIT && <p className={styles.workerPanelEmpty}>{locale === "ko" ? `최근 ${ONE_WORKER_FEED_LIMIT}개 기록` : `Latest ${ONE_WORKER_FEED_LIMIT} records`}</p>}
      {feed.map((entry) => {
        if (entry.kind === "message" && entry.message.fromAgentId !== selection.agentId) {
          return <WorkerRequestOriginal key={entry.id} text={entry.message.text} locale={locale} />;
        }
        if (entry.kind === "message") return <article key={entry.id} className={styles.workerReport}>
          <WorkerReportBody selection={selection} message={entry.message} locale={locale} />
        </article>;
        const state = { items: [entry.item], artifacts: [], sources: [], handoffs: [], lastSequence: 0 };
        const group = groupOneWorkerWork(buildOneWorkPresentation(state, locale, run?.state.cwd ?? null).cells)[0];
        return <div key={entry.id} className={styles.workerFeedItem}>
          {group && <OneWorkerWorkDetails group={group} locale={locale} />}
          <WorkerToolOriginal item={entry.item} locale={locale} />
        </div>;
      })}
    </div>
  </section>;
}
