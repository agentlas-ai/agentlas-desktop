import { useMemo } from "react";
import type { ComputerHistoryEntry, ComputerHistoryState } from "@shared/computer-history";
import { IconApps, IconChat, IconChevronDown, IconShield } from "@/components/Icon";
import styles from "./OneComputerHistory.module.css";

function dayLabel(iso: string, locale: string): string {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  if (sameDay) return locale === "ko" ? "오늘" : "Today";
  return date.toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", { month: "long", day: "numeric", weekday: "short" });
}

function timeLabel(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale === "ko" ? "ko-KR" : "en-US", { hour: "numeric", minute: "2-digit" });
}

function previewHistoryState(): ComputerHistoryState {
  const now = new Date();
  const at = (hour: number, minute: number) => {
    const value = new Date(now);
    value.setHours(hour, minute, 0, 0);
    return value.toISOString();
  };
  return {
    schemaVersion: 1,
    consent: "on",
    generatedAt: now.toISOString(),
    entries: [
      {
        id: "preview:agentlas-planning",
        occurredAt: at(21, 10),
        title: "Agentlas MCP Setup And One Planning",
        body: "You reviewed the One CEO-orchestrator plan, checked the local product references, and connected the design decisions to the current Desktop implementation.",
        apps: ["com.openai.codex", "com.anthropic.claude", "ai.agentlas.desktop", "com.github.copilot"],
        source: "10min",
        recommendation: null,
      },
      {
        id: "preview:soulin-build",
        occurredAt: at(16, 25),
        title: "Soulin Build And Agentlas Planning",
        body: "You advanced a Soulin web build from reference images, then returned to One planning and repeated the same screenshot-to-implementation review workflow.",
        apps: ["com.google.Chrome", "com.openai.codex", "ai.agentlas.desktop", "com.github.copilot", "com.anthropic.claude"],
        source: "6h",
        recommendation: {
          id: "preview:reference-agent",
          kind: "agent",
          title: "Reference-image web recreation agent",
          body: "Turn the repeated process for attaching reference screenshots, matching desktop/mobile layouts, and running visual QA into a reusable agent draft.",
          evidence: [{ entryId: "preview:soulin-build", label: "6h memory summary with cited events.jsonl", occurredAt: at(16, 25), source: "6h" }],
          status: "draft",
        },
      },
      {
        id: "preview:maintenance",
        occurredAt: at(10, 5),
        title: "Agentlas Maintenance And Soulin Prep",
        body: "You checked the Desktop runtime, prepared the product workspace, and reviewed the next implementation steps before beginning the design pass.",
        apps: ["ai.agentlas.desktop", "com.openai.codex"],
        source: "10min",
        recommendation: null,
      },
    ],
  };
}

function AppMark({ app }: { app: string }) {
  const value = app.toLocaleLowerCase();
  const image = value.includes("codex") || value.includes("openai") || value.includes("chatgpt")
    ? "/brand/llm/openai.svg"
    : value.includes("claude") || value.includes("anthropic")
      ? "/brand/llm/claude.svg"
      : value.includes("github") && value.includes("copilot")
        ? "/brand/llm/githubcopilot.svg"
        : value.includes("agentlas") || value.includes("electron")
          ? "/brand/agentlas-one-mark.png"
          : null;
  return <span className={styles.appMark} title={app} data-app={value.replace(/[^a-z0-9]+/g, "-")}>
    {image ? <img src={image} alt="" /> : <IconApps size={13} strokeWidth={1.8} />}
  </span>;
}

function RecommendationBlock({ entry, locale, onReview }: { entry: ComputerHistoryEntry; locale: string; onReview?: (entry: ComputerHistoryEntry) => void }) {
  const recommendation = entry.recommendation;
  if (!recommendation) return null;
  const label = recommendation.kind === "plugin"
    ? (locale === "ko" ? "추천 플러그인 초안" : "Suggested plugin draft")
    : recommendation.kind === "graph"
      ? (locale === "ko" ? "추천 그래프 초안" : "Suggested graph draft")
      : (locale === "ko" ? "추천 에이전트 초안" : "Suggested agent draft");
  return <section className={styles.recommendation} aria-label={locale === "ko" ? "추천 초안" : "Draft recommendation"}>
    <small>{label}</small>
    <span>{recommendation.body}</span>
    <button type="button" onClick={() => onReview?.(entry)}>{recommendation.title} · {locale === "ko" ? "초안 검토" : "Review draft"}</button>
  </section>;
}

export function OneComputerHistory({
  state,
  locale,
  onConsent,
  onClear,
  onAsk,
  onReviewRecommendation,
  previewWhenUnavailable = false,
  compact = false,
}: {
  state: ComputerHistoryState | null;
  locale: string;
  onConsent: (enabled: boolean) => Promise<void>;
  onClear: () => void;
  onAsk: () => void;
  onReviewRecommendation?: (entry: ComputerHistoryEntry) => void;
  /** Browser-only visual fixture; the Desktop bridge always supplies real state. */
  previewWhenUnavailable?: boolean;
  /** Embedded lower-right pane inside a task output rail. */
  compact?: boolean;
}) {
  const viewState = useMemo(() => state ?? (previewWhenUnavailable ? previewHistoryState() : null), [previewWhenUnavailable, state]);
  const groups = useMemo(() => {
    const map = new Map<string, ComputerHistoryEntry[]>();
    for (const entry of viewState?.entries || []) {
      const key = new Date(entry.occurredAt).toDateString();
      const list = map.get(key) || [];
      list.push(entry);
      map.set(key, list);
    }
    return [...map.values()];
  }, [viewState?.entries]);
  const enabled = viewState?.consent === "on";
  const copy = locale === "ko" ? {
    title: "기록",
    localOnly: "원본은 로컬에만 보관됩니다",
    subtitle: "컴퓨터에서 관찰한 작업의 요약",
    clear: "기록 지우기",
    ask: "기록에 대해 물어보기",
    /* ko 명칭은 웹 "컴퓨터 사용 기록" 과 통일(A3/D-9). */
    offTitle: "컴퓨터 사용 기록이 꺼져 있어요.",
    offBody: "명시적으로 켜면 10분 사실과 6시간 요약만 로컬에 저장합니다. 원본은 7일 후 자동 삭제됩니다.",
    enable: "기록 켜기",
    empty: "아직 기록이 없습니다. 기록이 쌓이면 이곳에서 확인할 수 있어요.",
  } : {
    title: "History",
    localOnly: "Original activity stays on this computer",
    subtitle: "Summaries of work observed on this computer",
    clear: "Clear history",
    ask: "Ask about history",
    offTitle: "Computer History is off.",
    offBody: "Turn it on to keep only 10-minute facts and 6-hour summaries locally. Original activity is deleted automatically after 7 days.",
    enable: "Turn on history",
    empty: "No history yet. Observed work will appear here.",
  };
  return (
    <section className={styles.root} aria-label="Computer History" data-compact={compact ? "true" : "false"}>
      <header className={styles.header}>
        <div><h2>{copy.title} <span title={copy.localOnly} aria-label={copy.localOnly}><IconShield size={10} /></span></h2><p>{copy.subtitle}</p></div>
        <div className={styles.headerActions}>
          <button type="button" onClick={onClear} disabled={!state?.entries.length}>{copy.clear} <IconChevronDown size={10} /></button>
          <button type="button" onClick={onAsk}><IconChat size={12} /> {copy.ask}</button>
        </div>
      </header>
      {!enabled ? <div className={styles.consent}><strong>{copy.offTitle}</strong><span>{copy.offBody}</span><button type="button" onClick={() => void onConsent(true)}>{copy.enable}</button></div> : (
        groups.length === 0 ? <div className={styles.empty}>{copy.empty}</div> : <div className={styles.timeline}>
          {groups.map((entries) => <details className={styles.day} key={entries[0].id} open>
            <summary>{dayLabel(entries[0].occurredAt, locale)}</summary>
            {entries.map((entry) => <article className={styles.entry} key={entry.id}>
              <time>{timeLabel(entry.occurredAt, locale)}</time>
              <span className={styles.marker} />
              <div className={styles.card}>
                <strong>{entry.title}</strong>
                <small className={styles.provenance} data-evidence="computer history">Computer History · {entry.source}</small>
                <p>{entry.body}</p>
                {entry.apps.length > 0 && <div className={styles.apps}>{entry.apps.map((app) => <AppMark key={app} app={app} />)}</div>}
                <RecommendationBlock entry={entry} locale={locale} onReview={onReviewRecommendation} />
              </div>
            </article>)}
          </details>)}
        </div>
      )}
    </section>
  );
}
