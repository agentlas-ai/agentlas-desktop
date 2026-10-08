"use client";

/*
 * The conversation's automations, drawn from the host ledger (Main IPC automations.chatActivity / runDigest /
 * runPage). Three surfaces, One and Work alike:
 *   - AutomationLiveRows       — while an automation that belongs to this chat runs in its hidden session,
 *                                a live row at the bottom of the thread (name, minutes, latest actions).
 *   - AutomationReportSummary  — the automation-report row upgraded to "21:00 자동화 · Threads 답글 3회"
 *                                with site/app logos, expandable to the steps and the report text.
 *   - AutomationRailPanel      — the right-panel "자동화" tab: automations, schedule, next run, live state,
 *                                and a paged, newest-first action timeline.
 *
 * Owner 2026-09-28 (Thread Marketing): the automation was replying on Threads while the room showed a failed
 * turn as its last state, and the only record was the model's sentence. Counts here come from the tool
 * ledger (shared/automation-activity.ts), never from prose.
 *
 * Refresh is event-driven: store:changed {entity:"automation"} (run start, lease, finish) and the automation's
 * own live channel automations:liveRun:<id> (every tool event). No polling; the only timer is the elapsed
 * minutes label of a running row.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { createCoalescedRefresh } from "@/lib/one-refresh-coordinator";
import { automationReportDisplay } from "@/lib/automation-report-display";
import {
  automationActionLine,
  automationRunHeadline,
  siteDisplayName,
  type AutomationActionRow,
  type AutomationRunDigest,
  type AutomationToolFamily,
} from "@shared/automation-activity";
import type { AutomationChatActivityAutomation, AutomationChatActivitySnapshot } from "@shared/automation-activity-ipc";
import { humanizeScheduleLabel } from "@shared/schedule-describe";
import { toolFailureCopy } from "@shared/tool-failure";
import {
  IconChevronDown,
  IconClock,
  IconCode,
  IconFileText,
  IconImage,
  IconMail,
  IconMonitor,
  IconNetwork,
  IconPuzzle,
  IconSearch,
  IconUsers,
} from "@/components/Icon";
import { OneRunComet, oneRunCometHostClass } from "@/components/one/OneRunComet";
import rail from "@/components/workspace/TaskSidePanel.module.css";
import styles from "./AutomationChatActivity.module.css";

type Locale = "ko" | "en";

// ── data ─────────────────────────────────────────────────────────────────

export interface AutomationChatScope { chatId?: string | null; projectId?: string | null }

/**
 * One scope's automations with live digests. Re-reads on store:changed{automation} and merges each running
 * automation's live-channel tool events by re-reading that run's digest (coalesced: one read in flight).
 */
export function useAutomationChatActivity(scope: AutomationChatScope): AutomationChatActivitySnapshot | null {
  const chatId = scope.chatId ?? null;
  const projectId = scope.projectId ?? null;
  const [snapshot, setSnapshot] = useState<AutomationChatActivitySnapshot | null>(null);
  const readSnapshot = useRef<() => void>(() => undefined);

  useEffect(() => {
    setSnapshot(null);
    const api = ipc();
    const read = api?.automations?.chatActivity;
    if (!read || (!chatId && !projectId)) return;
    let disposed = false;
    let inFlight = false;
    let again = false;
    const refresh = () => {
      if (inFlight) { again = true; return; }
      inFlight = true;
      void read({ chatId, projectId }).then((next) => {
        if (!disposed && next) setSnapshot(next);
      }, () => undefined).finally(() => {
        inFlight = false;
        if (again && !disposed) { again = false; refresh(); }
      });
    };
    readSnapshot.current = refresh;
    refresh();
    let off: (() => void) | undefined;
    try {
      off = ipcEvents()?.onStoreChanged?.((change) => {
        if (change?.entity === "automation" || (change?.entity === "chat" && (!change.id || change.id === chatId))) refresh();
      });
    } catch { off = undefined; }
    return () => { disposed = true; off?.(); readSnapshot.current = () => undefined; };
  }, [chatId, projectId]);

  // Live tool events of the running automations → re-read just that run's digest.
  const liveKey = (snapshot?.automations ?? []).filter((item) => item.running && item.liveRun).map((item) => `${item.id}:${item.liveRun!.runId}`).join("|");
  useEffect(() => {
    if (!liveKey) return;
    const api = ipc();
    const events = ipcEvents();
    const digestOf = api?.automations?.runDigest;
    if (!api || !events || !digestOf) return;
    let disposed = false;
    const offs: Array<() => void> = [];
    for (const entry of liveKey.split("|")) {
      const [automationId, runId] = [entry.slice(0, entry.indexOf(":")), entry.slice(entry.indexOf(":") + 1)];
      let inFlight = false;
      let again = false;
      const reread = () => {
        if (inFlight) { again = true; return; }
        inFlight = true;
        void digestOf(runId).then((digest) => {
          if (disposed || !digest) return;
          if (digest.status !== "running") { readSnapshot.current(); return; }
          setSnapshot((current) => current ? {
            ...current,
            automations: current.automations.map((item) => item.id === automationId ? { ...item, liveRun: digest } : item),
          } : current);
        }, () => undefined).finally(() => {
          inFlight = false;
          if (again && !disposed) { again = false; reread(); }
        });
      };
      try {
        const channel = api.automations.liveRunChannel(automationId);
        offs.push(events.on(channel, (ev) => {
          if (ev?.kind === "tool-use" || ev?.nodeState) reread();
        }));
      } catch { /* older preload */ }
    }
    return () => { disposed = true; for (const off of offs) off(); };
  }, [liveKey]);

  return snapshot;
}

const digestCache = new Map<string, AutomationRunDigest>();
const MAX_DIGEST_CACHE_ENTRIES = 128;

/** A finished run's digest (cached — terminal runs do not change). */
export function useAutomationRunDigest(runId: string | null | undefined): AutomationRunDigest | null | undefined {
  const [digest, setDigest] = useState<AutomationRunDigest | null | undefined>(() => (runId ? digestCache.get(runId) : undefined));
  useEffect(() => {
    if (!runId) { setDigest(null); return; }
    const cached = digestCache.get(runId);
    if (cached) { setDigest(cached); return; }
    const read = ipc()?.automations?.runDigest;
    if (!read) { setDigest(null); return; }
    let disposed = false;
    const readDigest = () => read(runId).then((value) => {
      if (disposed) return;
      if (value && value.status !== "running") {
        digestCache.set(runId, value);
        while (digestCache.size > MAX_DIGEST_CACHE_ENTRIES) {
          const oldest = digestCache.keys().next().value;
          if (oldest === undefined) break;
          digestCache.delete(oldest);
        }
      }
      setDigest(value ?? null);
    }, () => { if (!disposed) setDigest(null); });
    const coordinator = createCoalescedRefresh<void>(readDigest, () => undefined);
    const load = () => { void coordinator.request(undefined); };
    load();
    let off: (() => void) | undefined;
    try {
      off = ipcEvents()?.onStoreChanged?.((change) => {
        if (change?.entity === "automation" && !digestCache.has(runId)) load();
      });
    } catch { off = undefined; }
    return () => { disposed = true; coordinator.dispose(); off?.(); };
  }, [runId]);
  return digest;
}

// ── logos ────────────────────────────────────────────────────────────────

const iconCache = new Map<string, Promise<string | null>>();

function siteIcon(host: string): Promise<string | null> {
  const cached = iconCache.get(host);
  if (cached) return cached;
  const read = ipc()?.automations?.siteIcon;
  const next = read ? read(host).catch(() => null) : Promise.resolve(null);
  iconCache.set(host, next);
  return next;
}

export function SiteLogo({ host, size = 14 }: { host: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void siteIcon(host).then((value) => { if (!disposed) setSrc(value); });
    return () => { disposed = true; };
  }, [host]);
  const name = siteDisplayName(host);
  return <span className={styles.logo} data-automation-logo="site" data-host={host} title={host} style={{ width: size, height: size }}>
    {src
      ? <img src={src} alt="" width={size} height={size} />
      : <span className={styles.monogram} aria-hidden="true">{(name[0] ?? "?").toUpperCase()}</span>}
  </span>;
}

const FAMILY_ICON: Record<AutomationToolFamily, (props: { size?: number }) => ReactNode> = {
  browser: IconNetwork,
  computer: IconMonitor,
  shell: IconCode,
  mail: IconMail,
  image: IconImage,
  web: IconSearch,
  time: IconClock,
  file: IconFileText,
  agent: IconUsers,
  other: IconPuzzle,
};

const FAMILY_LABEL: Record<AutomationToolFamily, { ko: string; en: string }> = {
  browser: { ko: "브라우저", en: "Browser" },
  computer: { ko: "컴퓨터 사용", en: "Computer use" },
  shell: { ko: "터미널", en: "Terminal" },
  mail: { ko: "메일", en: "Mail" },
  image: { ko: "이미지 생성", en: "Image generation" },
  web: { ko: "웹 검색", en: "Web search" },
  time: { ko: "시계", en: "Clock" },
  file: { ko: "파일", en: "Files" },
  agent: { ko: "에이전트", en: "Agents" },
  other: { ko: "도구", en: "Tool" },
};

export function ToolLogo({ family, locale, size = 14 }: { family: AutomationToolFamily; locale: Locale; size?: number }) {
  const Icon = FAMILY_ICON[family] ?? IconPuzzle;
  const label = FAMILY_LABEL[family]?.[locale] ?? family;
  return <span className={styles.logo} data-automation-logo="tool" data-family={family} title={label} aria-label={label} role="img" style={{ width: size, height: size }}>
    <Icon size={Math.max(10, size - 3)} />
  </span>;
}

const RUNTIME_LOGOS: Array<[RegExp, string, string]> = [
  [/codex|openai/i, "/brand/llm/openai.svg", "Codex"],
  [/claude|anthropic/i, "/brand/llm/claude.svg", "Claude"],
  [/gemini|antigravity|agy|google/i, "/brand/llm/googlegemini.svg", "Gemini"],
  [/grok|xai/i, "/brand/llm/x.svg", "Grok"],
  [/kimi|moonshot/i, "/brand/llm/kimi.svg", "Kimi"],
  [/cursor/i, "/brand/llm/cursor.svg", "Cursor"],
  [/ollama|local/i, "/brand/llm/ollama.svg", "Local"],
];

function RuntimeLogo({ runtime, size = 14 }: { runtime: { kind: string | null; backend: string | null; model: string | null }; size?: number }) {
  const key = `${runtime.kind ?? ""} ${runtime.backend ?? ""}`;
  const match = RUNTIME_LOGOS.find(([pattern]) => pattern.test(key));
  if (!match) return null;
  const title = runtime.model ? `${match[2]} · ${runtime.model}` : match[2];
  return <span className={styles.logo} data-automation-logo="runtime" data-runtime={runtime.kind ?? runtime.backend ?? ""} title={title} style={{ width: size, height: size }}>
    <img src={match[1]} alt={match[2]} width={size - 2} height={size - 2} />
  </span>;
}

/** Sites first (favicons), then the app/runtime, then tool families. */
export function AutomationLogos({ digest, locale, max = 6 }: { digest: AutomationRunDigest; locale: Locale; max?: number }) {
  const sites = digest.sites.slice(0, 3);
  const runtimes = (digest.runtimes ?? []).slice(0, 1);
  const families = digest.families.filter((item) => item.family !== "time").slice(0, Math.max(0, max - sites.length - runtimes.length));
  return <span className={styles.logos} data-automation-logos="true">
    {sites.map((site) => <SiteLogo key={site.domain} host={site.domain} />)}
    {runtimes.map((runtime) => <RuntimeLogo key={`${runtime.kind}|${runtime.backend}`} runtime={runtime} />)}
    {families.map((item) => <ToolLogo key={item.family} family={item.family} locale={locale} />)}
  </span>;
}

function RowLogo({ row, locale }: { row: AutomationActionRow; locale: Locale }) {
  return row.domain ? <SiteLogo host={row.domain} /> : <ToolLogo family={row.family} locale={locale} />;
}

// ── formatting ───────────────────────────────────────────────────────────

function clock(iso: string | null | undefined, locale: Locale, seconds = false): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  return at.toLocaleTimeString(locale === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false });
}

function minutesSince(iso: string | null | undefined, now: number): number {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 60_000)) : 0;
}

function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function statusWord(status: string, locale: Locale): string {
  const ko = locale === "ko";
  if (status === "running") return ko ? "실행 중" : "Running";
  if (status === "ok") return ko ? "완료" : "Done";
  if (status === "error") return ko ? "실패" : "Failed";
  if (status === "cancelled") return ko ? "취소됨" : "Cancelled";
  if (status === "partial") return ko ? "일부 완료" : "Partly done";
  if (status === "blocked") return ko ? "진행 불가" : "Blocked";
  if (status === "needs_input") return ko ? "입력 필요" : "Needs input";
  if (status === "skipped") return ko ? "건너뜀" : "Skipped";
  return status;
}

function ActionLine({ row, locale, withTime = false }: { row: AutomationActionRow; locale: Locale; withTime?: boolean }) {
  const failure = row.failed > 0 ? (toolFailureCopy(row.failureCode ?? undefined, locale) ?? row.failureCode ?? (locale === "ko" ? "실패" : "failed")) : null;
  const text = automationActionLine(row, locale);
  const link = row.url && (row.outward || row.kind === "navigate") ? row.url : null;
  return <li className={styles.action} data-automation-action={row.kind} data-outward={row.outward ? "true" : "false"} data-failed={row.failed > 0 ? "true" : "false"}>
    {withTime && <time dateTime={row.firstAt}>{clock(row.firstAt, locale, true)}</time>}
    <RowLogo row={row} locale={locale} />
    <span className={styles.actionText} title={row.label ?? undefined}>
      {link ? <a href={link} target="_blank" rel="noreferrer" title={link}>{text}</a> : text}
      {failure && <em className={styles.failure}> · {failure}</em>}
    </span>
  </li>;
}

// ── chat: live rows ──────────────────────────────────────────────────────

export function AutomationLiveRows({ chatId, locale, onOpenTab }: { chatId: string | null | undefined; locale: Locale; onOpenTab?: () => void }) {
  const openTab = onOpenTab ?? (chatId ? () => requestAutomationTab(chatId) : undefined);
  const snapshot = useAutomationChatActivity({ chatId: chatId ?? null });
  const running = (snapshot?.automations ?? []).filter((item) => item.running && item.liveRun);
  const now = useMinuteClock(running.length > 0);
  if (!chatId || running.length === 0) return null;
  return <div className={styles.liveStack} data-automation-live-rows="true">
    {running.map((item) => <AutomationLiveRow key={item.id} item={item} locale={locale} now={now} onOpenTab={openTab} />)}
  </div>;
}

function AutomationLiveRow({ item, locale, now, onOpenTab }: { item: AutomationChatActivityAutomation; locale: Locale; now: number; onOpenTab?: () => void }) {
  const [open, setOpen] = useState(false);
  const digest = item.liveRun!;
  const ko = locale === "ko";
  const minutes = minutesSince(digest.startedAt, now);
  const recent = digest.actions.slice(-3);
  const all = digest.actions.slice(-40);
  const headline = digest.outwardTotal > 0 ? automationRunHeadline(digest, locale) : null;
  return <section className={`${styles.liveRow} ${oneRunCometHostClass}`} data-automation-live-row="true" data-automation-id={item.id} data-run-id={digest.runId} role="status" aria-live="polite">
    <OneRunComet running locale={locale} />
    <header className={styles.liveHeader}>
      <strong>{ko ? "자동화 실행 중" : "Automation running"}</strong>
      <span className={styles.liveName}>· {item.name}</span>
      <span className={styles.liveElapsed} data-automation-elapsed-minutes={minutes}>· {ko ? `${minutes}분째` : `${minutes} min`}</span>
      <AutomationLogos digest={digest} locale={locale} />
    </header>
    {headline && <p className={styles.liveHeadline} data-automation-live-headline="true">{ko ? "지금까지 " : "So far: "}{headline}</p>}
    <ul className={styles.actions} data-automation-live-actions="true">
      {(open ? all : recent).map((row) => <ActionLine key={row.id} row={row} locale={locale} withTime={open} />)}
      {recent.length === 0 && <li className={styles.actionMuted}>{ko ? "시작하는 중" : "Starting"}</li>}
    </ul>
    <footer className={styles.liveFooter}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? (ko ? "접기" : "Collapse") : (ko ? `전체 과정 보기 (${digest.actions.length})` : `Show all steps (${digest.actions.length})`)}
      </button>
      {onOpenTab && <button type="button" onClick={onOpenTab}>{ko ? "자동화 탭" : "Automations tab"}</button>}
      <Link href={`/automation/flow?id=${encodeURIComponent(item.id)}`}>{ko ? "실행 화면 열기" : "Open live run"}</Link>
    </footer>
  </section>;
}

// ── chat: finished report ────────────────────────────────────────────────

/**
 * The automation-report row as "21:00 자동화 · Threads 답글 3회" + logos, with the steps and the report
 * text behind a disclosure. Falls back to the plain row when the digest is unavailable (older Main).
 */
export function AutomationReportSummary({ runId, text, locale, fallback }: { runId: string; text: string; locale: Locale; fallback: ReactNode }) {
  const digest = useAutomationRunDigest(runId);
  const [open, setOpen] = useState(false);
  const display = useMemo(() => automationReportDisplay(text, locale), [text, locale]);
  if (digest === undefined) return <div data-automation-report-pending="true">{fallback}</div>;
  if (!digest) return <>{fallback}</>;
  const ko = locale === "ko";
  const at = clock(digest.endedAt ?? digest.startedAt, locale);
  const headline = automationRunHeadline(digest, locale);
  const outwardRows = digest.actions.filter((row) => row.outward);
  return <section className={styles.report} data-automation-report-summary="true" data-run-id={runId} data-outward-total={digest.outwardTotal} data-status={digest.status}>
    <header className={styles.reportHeader}>
      <time dateTime={digest.endedAt ?? digest.startedAt ?? undefined}>{at}</time>
      <span>{ko ? "자동화" : "Automation"}{display.name ? ` · ${display.name}` : ""}</span>
      {digest.status !== "ok" && <span className={styles.reportStatus} data-status={digest.status}>{statusWord(digest.status, locale)}</span>}
    </header>
    <p className={styles.reportHeadline}>
      <AutomationLogos digest={digest} locale={locale} />
      <strong data-automation-report-headline="true">{headline}</strong>
      {digest.failures > 0 && <span className={styles.reportFailures}>{ko ? ` · 도구 오류 ${digest.failures}건` : ` · ${digest.failures} tool errors`}</span>}
    </p>
    {outwardRows.length > 0 && !open && <ul className={styles.actions}>
      {outwardRows.slice(-3).map((row) => <ActionLine key={row.id} row={row} locale={locale} />)}
    </ul>}
    <button type="button" className={styles.reportToggle} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span>{open ? (ko ? "접기" : "Collapse") : (ko ? `단계 ${digest.actions.length}개와 보고 보기` : `Show ${digest.actions.length} steps and the report`)}</span>
      <IconChevronDown size={12} />
    </button>
    {open && <>
      <ul className={styles.actions} data-automation-report-steps="true">
        {digest.actions.map((row) => <ActionLine key={row.id} row={row} locale={locale} withTime />)}
      </ul>
      <div className={styles.reportProse} data-automation-report-prose="true">{fallback}</div>
    </>}
  </section>;
}

// ── right panel: 자동화 tab ──────────────────────────────────────────────

/** Window event the thread's live row fires to open this chat's "자동화" tab (detail: { chatId }). */
export const AUTOMATION_TAB_OPEN_EVENT = "agentlas:automation-tab-open";

export function requestAutomationTab(chatId: string): void {
  window.dispatchEvent(new CustomEvent(AUTOMATION_TAB_OPEN_EVENT, { detail: { chatId } }));
}

export function AutomationTabLiveDot({ locale }: { locale: Locale }) {
  return <span className={styles.tabLiveDot} data-automation-tab-running="true" role="img" aria-label={locale === "ko" ? "실행 중" : "Running"} />;
}

export function automationTabRunning(snapshot: AutomationChatActivitySnapshot | null): boolean {
  return Boolean(snapshot?.automations.some((item) => item.running));
}

export function AutomationRailPanel({ snapshot, locale }: { snapshot: AutomationChatActivitySnapshot | null; locale: Locale }) {
  const ko = locale === "ko";
  if (!snapshot) return <p className={rail.artifactEmpty}>{ko ? "불러오는 중" : "Loading"}</p>;
  if (snapshot.automations.length === 0) return <p className={rail.artifactEmpty}>{ko ? "이 대화에 걸린 자동화가 없습니다" : "No automations belong to this conversation"}</p>;
  return <div className={styles.railList} data-automation-rail="true">
    {snapshot.automations.map((item) => <AutomationRailItem key={item.id} item={item} locale={locale} />)}
  </div>;
}

function AutomationRailItem({ item, locale }: { item: AutomationChatActivityAutomation; locale: Locale }) {
  const ko = locale === "ko";
  const [runs, setRuns] = useState<AutomationRunDigest[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadFirst = useCallback(async () => {
    const read = ipc()?.automations?.runPage;
    if (!read) return;
    const page = await read(item.id, { limit: 5 });
    setRuns((current) => {
      const fresh = page.runs;
      const older = current.filter((run) => !fresh.some((next) => next.runId === run.runId) && fresh.length > 0 && (run.startedAt ?? "") < (fresh.at(-1)?.startedAt ?? ""));
      return [...fresh, ...older];
    });
    setCursor((current) => current ?? page.nextCursor);
  }, [item.id]);
  // First page on mount, again whenever a run starts or ends (store:changed{automation} reaches us as a new
  // snapshot identity: lastRunAt / running / liveRun.runId change).
  const liveRunId = item.liveRun?.runId ?? null;
  useEffect(() => { void loadFirst().catch(() => undefined); }, [loadFirst, item.running, item.lastRunAt, liveRunId]);
  const loadOlder = async () => {
    const read = ipc()?.automations?.runPage;
    if (!read || !cursor || loading) return;
    setLoading(true);
    try {
      const page = await read(item.id, { limit: 5, before: cursor });
      setRuns((current) => [...current, ...page.runs.filter((run) => !current.some((known) => known.runId === run.runId))]);
      setCursor(page.nextCursor);
    } finally { setLoading(false); }
  };
  const merged = runs.map((run) => (item.liveRun && run.runId === item.liveRun.runId ? item.liveRun : run));
  if (item.liveRun && !merged.some((run) => run.runId === item.liveRun!.runId)) merged.unshift(item.liveRun);
  const schedule = humanizeScheduleLabel(item.scheduleHuman, locale);
  const next = item.enabled && item.nextRunAt ? new Date(item.nextRunAt).toLocaleString(ko ? "ko-KR" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, ...(item.timezone ? { timeZone: item.timezone } : {}) }) : null;
  return <section className={`${rail.artifactSection} ${styles.railItem}`} data-automation-rail-item={item.id} data-running={item.running ? "true" : "false"}>
    <header className={`${styles.railHeader} ${oneRunCometHostClass}`}>
      <OneRunComet running={item.running} locale={locale} />
      <strong>{item.name}</strong>
      <small>
        {schedule}
        {next ? ` · ${ko ? "다음" : "Next"} ${next}` : ""}
        {" · "}
        <span data-automation-state={item.running ? "running" : item.enabled ? "idle" : "off"}>{item.running ? (ko ? "실행 중" : "Running") : item.enabled ? (ko ? "대기" : "Waiting") : (ko ? "꺼짐" : "Off")}</span>
      </small>
    </header>
    <ol className={styles.timeline} data-automation-timeline="true">
      {merged.map((run) => <AutomationRailRun key={run.runId} run={run} locale={locale} />)}
      {merged.length === 0 && <li className={rail.artifactEmpty}>{ko ? "아직 실행 기록이 없습니다" : "No runs yet"}</li>}
    </ol>
    {cursor && <button type="button" className={styles.more} disabled={loading} onClick={() => void loadOlder()} data-automation-more="true">
      {loading ? (ko ? "불러오는 중" : "Loading") : (ko ? "이전 실행 더 보기" : "Older runs")}
    </button>}
  </section>;
}

function AutomationRailRun({ run, locale }: { run: AutomationRunDigest; locale: Locale }) {
  const running = run.status === "running";
  const [open, setOpen] = useState(running);
  useEffect(() => { if (running) setOpen(true); }, [running]);
  const rows = [...run.actions].reverse();
  return <li className={styles.run} data-automation-run={run.runId} data-status={run.status}>
    <button type="button" className={styles.runHeader} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <time dateTime={run.startedAt ?? undefined}>{clock(run.startedAt, locale)}</time>
      <span className={styles.runStatus} data-status={run.status}>{statusWord(run.status, locale)}</span>
      <span className={styles.runHeadline}>{automationRunHeadline(run, locale)}</span>
      <AutomationLogos digest={run} locale={locale} max={4} />
    </button>
    {open && <ul className={styles.actions} data-automation-run-actions="true">
      {rows.map((row) => <ActionLine key={row.id} row={row} locale={locale} withTime />)}
      {rows.length === 0 && <li className={styles.actionMuted}>{locale === "ko" ? "기록된 도구 활동 없음" : "No tool activity recorded"}</li>}
      {run.actionsTruncated && <li className={styles.actionMuted}>{locale === "ko" ? "오래된 단계는 생략됨" : "Older steps omitted"}</li>}
    </ul>}
  </li>;
}
