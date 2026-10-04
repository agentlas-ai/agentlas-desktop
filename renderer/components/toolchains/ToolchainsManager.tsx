// Work › Environment › Toolchains, laid out like the Mac's app folder (owner 2026-10-05: "툴체인별 로고 만들어서 …
// 앱 형태로 만들고 각 앱 누르면 최대한 글자 적게 요약한 히스토리"). A grid of app icons; opening one shows what it
// does in a line, its controls, and how it became a tool — who ran it, when, how often — in as few words as possible.
//
// Nothing here decides a state. Main owns every transition; this screen shows the overview it returns and sends
// only the owner's narrow decisions.
"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  OwnerDecision,
  ToolchainAutomationView,
  ToolchainCrystallizationView,
  ToolchainHistoryEvent,
  ToolchainOverview,
  ToolchainsApi,
} from "@shared/toolchain";
import {
  IconAlertTriangle,
  IconBolt,
  IconChat,
  IconClose,
  IconPower,
  IconRefresh,
  IconPlus,
  IconSearch,
  IconToolchain,
  IconWand,
} from "@/components/Icon";
import { navigate } from "@/lib/navigation";
import {
  crystallizationLabel,
  interfaceStateLabel,
  toolchainCopy,
  toolchainErrorText,
  type ToolchainCopy,
} from "./toolchain-copy";
import styles from "./ToolchainsManager.module.css";

type Lane = "all" | "callable" | "learning" | "draft" | "unregistered";
const LANES: Lane[] = ["all", "callable", "learning", "draft", "unregistered"];
const OPEN_STATES = new Set(["candidate", "shadow", "ready", "active", "demoted"]);

function isCallable(view: ToolchainAutomationView): boolean {
  return view.interface?.state === "callable" && !view.interfaceStale;
}

function isLearning(view: ToolchainAutomationView): boolean {
  return view.crystallizations.some((item) => OPEN_STATES.has(item.state))
    || view.observations.some((observation) => observation.eligibleEpisodes > 0 && observation.topTargets.length > 0);
}

function inLane(view: ToolchainAutomationView, lane: Lane): boolean {
  if (lane === "all") return true;
  if (lane === "callable") return isCallable(view);
  if (lane === "learning") return isLearning(view);
  if (lane === "draft") return Boolean(view.interface) && !isCallable(view);
  return !view.interface && !isLearning(view);
}

/** What changed last: the test or an owner/learner transition (the periodic refresh is not activity). */
function lastActivity(view: ToolchainAutomationView): string {
  const stamps = [
    view.interface?.exposedBy?.at,
    view.interface?.coldStart?.at,
    ...view.crystallizations.filter((item) => item.state !== "superseded").map((item) => item.updatedAt),
  ].filter((value): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)));
  return stamps.sort().at(-1) ?? "";
}

function tone(view: ToolchainAutomationView): "ok" | "warn" | "info" | "muted" {
  if (isCallable(view)) return "ok";
  if (view.interface?.state === "deprecated" && !view.interfaceStale) return "muted";
  if (view.interface) return "warn";
  return isLearning(view) ? "info" : "muted";
}

function displayName(view: ToolchainAutomationView): string {
  return view.interface?.name || view.automationName;
}

/** The first sentence of what it does: the line under the name. */
function oneLine(view: ToolchainAutomationView): string {
  const text = (view.interface?.description ?? "").replace(/\s+/g, " ").trim();
  return text.split(/(?<=[.!?。])\s/)[0] ?? "";
}

function matchesQuery(view: ToolchainAutomationView, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const contract = view.interface;
  return [view.automationName, contract?.name, contract?.description, ...(contract?.whenToUse ?? [])]
    .some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(needle));
}

function hue(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** The drawn icon, or a monogram until one is drawn (or when no image model is available). */
function AppIcon({ view, logo, size }: { view: ToolchainAutomationView; logo: string | undefined; size: number }) {
  const name = displayName(view);
  const h = hue(view.automationId);
  return (
    <span className={styles.icon} style={{ width: size, height: size }} data-tone={tone(view)} data-off={view.enabled ? undefined : "true"}>
      {logo
        ? <img src={logo} alt="" draggable={false} />
        : <span className={styles.monogram} style={{ background: `linear-gradient(145deg, hsl(${h} 70% 62%), hsl(${(h + 40) % 360} 65% 44%))`, fontSize: size * 0.42 }}>
          {Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "·"}
        </span>}
    </span>
  );
}

function when(iso: string, locale: string): string {
  const date = new Date(iso);
  return date.toLocaleString(locale === "ko" ? "ko-KR" : "en-US", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function span(from: string, to: string, locale: string): string {
  const a = new Date(from), b = new Date(to);
  const time = (date: Date) => date.toLocaleTimeString(locale === "ko" ? "ko-KR" : "en-US", { hour: "numeric", minute: "2-digit" });
  // Within one minute it is one moment.
  if (Math.abs(b.getTime() - a.getTime()) < 60_000) return when(from, locale);
  const day = (date: Date) => date.toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", { month: "numeric", day: "numeric" });
  if (a.toDateString() !== b.toDateString()) return `${day(a)}–${day(b)}`;
  // "오후 4:55–6:29", "4:55–6:29 PM": the period once.
  let start = time(a), end = time(b);
  const period = /^(오전|오후) /.exec(start)?.[1];
  if (period && end.startsWith(`${period} `)) end = end.slice(period.length + 1);
  else if (!period && /[AP]M$/.test(start) && start.slice(-2) === end.slice(-2)) start = start.slice(0, -3);
  return `${day(a)} ${start}–${end}`;
}

function HistoryRow({ event, copy, locale }: { event: ToolchainHistoryEvent; copy: ToolchainCopy; locale: string }) {
  const h = copy.manager.history;
  const row = (icon: ReactNode, at: string, text: string, kind: string, title?: string) => (
    <li data-history={kind} title={title}>
      <span className={styles.historyIcon} data-kind={kind} aria-hidden="true">{icon}</span>
      <span className={styles.historyText}>{text}</span>
      <time>{at}</time>
    </li>
  );
  switch (event.kind) {
    case "made": return row(<IconPlus size={12} />, when(event.at, locale), h.made(event.by), "made");
    case "ran": return row(<IconBolt size={12} />, span(event.from, event.to, locale), h.ran(event.count, event.by), "ran");
    case "tool": return row(<IconToolchain size={12} />, when(event.at, locale), h.tool(event.passed, event.tested, event.by), event.passed ? "tool" : "draft");
    case "called": return row(<IconChat size={12} />, span(event.from, event.to, locale), h.called(event.count, event.caller), "called");
    case "reported": return row(<IconAlertTriangle size={12} />, when(event.at, locale), h.reported, "reported", event.problem);
    case "repaired": return row(<IconWand size={12} />, when(event.at, locale), h.repaired, "repaired");
    case "withdrawn": return row(<IconPower size={12} />, when(event.at, locale), h.withdrawn, "withdrawn");
  }
}

function CrystallizationRow({ item, copy, busy, onDecide }: {
  item: ToolchainCrystallizationView;
  copy: ToolchainCopy;
  busy: boolean;
  onDecide: (item: ToolchainCrystallizationView, decision: OwnerDecision) => void;
}) {
  const reason = item.reasonCode ? copy.reason[item.reasonCode] ?? item.reasonCode : null;
  return (
    <li className={styles.learnedItem} data-state={item.state} title={reason ?? undefined}>
      <span>{crystallizationLabel(item, copy)}</span>
      <span className={styles.pill} data-state={item.state}>{copy.state[item.state] ?? item.state}</span>
      <div className={styles.learnedActions}>
        {item.state === "ready" && <>
          <button type="button" data-primary="true" disabled={busy} onClick={() => onDecide(item, "approve")}>{copy.approve}</button>
          <button type="button" disabled={busy} onClick={() => onDecide(item, "dismiss")}>{copy.dismiss}</button>
        </>}
        {item.state === "active" && <button type="button" disabled={busy} onClick={() => onDecide(item, "demote")}>{copy.demote}</button>}
        {(item.state === "demoted" || item.state === "blacklisted") && item.kind === "state_file_read"
          && <button type="button" disabled={busy} onClick={() => onDecide(item, "retry")}>{copy.retry}</button>}
        {item.state === "demoted" && <button type="button" disabled={busy} onClick={() => onDecide(item, "dismiss")}>{copy.dismiss}</button>}
      </div>
    </li>
  );
}

function ContractDetails({ view, copy }: { view: ToolchainAutomationView; copy: ToolchainCopy }) {
  const contract = view.interface;
  if (!contract) return null;
  const inputs = Object.entries(contract.inputSchema.properties);
  const effects = [
    contract.effects.readOnlyHint ? copy.manager.effects.readOnly : copy.manager.effects.writes,
    ...(contract.effects.destructiveHint ? [copy.manager.effects.destructive] : []),
    ...(contract.effects.openWorldHint ? [copy.manager.effects.openWorld] : []),
  ];
  return (
    <details className={styles.contract}>
      <summary>{copy.manager.contract}</summary>
      <div className={styles.contractBody}>
        {contract.description && <p>{contract.description}</p>}
        <div className={styles.effects}>{effects.map((label) => <span key={label}>{label}</span>)}</div>
        {contract.whenToUse.length > 0 && <section>
          <small>{copy.manager.whenToUse}</small>
          <ul>{contract.whenToUse.map((line, index) => <li key={index}>{line}</li>)}</ul>
        </section>}
        {contract.whenNotToUse.length > 0 && <section>
          <small>{copy.manager.whenNotToUse}</small>
          <ul>{contract.whenNotToUse.map((line, index) => <li key={index}>{line}</li>)}</ul>
        </section>}
        <section>
          <small>{copy.manager.inputs}</small>
          {inputs.length === 0 ? <span>{copy.manager.noInputs}</span> : <ul>
            {inputs.map(([key, property]) => <li key={key}>
              <code>{key}</code>{contract.inputSchema.required.includes(key) ? ` · ${copy.manager.required}` : ""} — {property.description}
            </li>)}
          </ul>}
        </section>
      </div>
    </details>
  );
}

function ToolchainSheet({ view, logo, history, copy, locale, busy, testing, onClose, onExpose, onWithdraw, onDecide }: {
  view: ToolchainAutomationView;
  logo: string | undefined;
  history: ToolchainHistoryEvent[] | null;
  copy: ToolchainCopy;
  locale: string;
  busy: boolean;
  testing: boolean;
  onClose: () => void;
  onExpose: () => void;
  onWithdraw: () => void;
  onDecide: (item: ToolchainCrystallizationView, decision: OwnerDecision) => void;
}) {
  const contract = view.interface;
  const stateLabel = interfaceStateLabel(view, copy);
  const callable = isCallable(view);
  const learned = view.crystallizations.filter((item) => item.state !== "superseded");
  const exposeLabel = testing ? copy.exposing : contract && contract.state !== "deprecated" ? copy.retest : copy.expose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className={styles.backdrop} onClick={onClose} data-toolchain-sheet={view.automationId}>
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={displayName(view)} onClick={(event) => event.stopPropagation()}>
        <button type="button" className={styles.close} onClick={onClose} aria-label={copy.manager.close}><IconClose size={14} /></button>
        <div className={styles.sheetHead}>
          <AppIcon view={view} logo={logo} size={64} />
          <div>
            <h3>{displayName(view)}</h3>
            {oneLine(view) && <p>{oneLine(view)}</p>}
            <div className={styles.pills}>
              {stateLabel && <span className={styles.pill} data-tone={tone(view)}>{stateLabel}</span>}
              {!view.enabled && <span className={styles.pill}>{copy.manager.paused}</span>}
            </div>
          </div>
        </div>
        <div className={styles.sheetActions}>
          {callable && !testing
            ? <button type="button" disabled={busy} onClick={onWithdraw}>{copy.withdraw}</button>
            : <button type="button" data-primary="true" disabled={busy || testing} onClick={onExpose}>{exposeLabel}</button>}
          <button type="button" onClick={() => navigate(`/automation/detail?id=${encodeURIComponent(view.automationId)}`)}>
            {copy.manager.openAutomation}
          </button>
        </div>
        <ol className={styles.history} aria-label={copy.manager.lanes.all}>
          {history === null ? null : history.length === 0
            ? <li data-history="empty"><span className={styles.historyText}>{copy.manager.history.empty}</span></li>
            : history.map((event, index) => <HistoryRow key={index} event={event} copy={copy} locale={locale} />)}
        </ol>
        {learned.length > 0 && <ul className={styles.learned} aria-label={copy.manager.learned}>
          {learned.map((item) => <CrystallizationRow key={item.id} item={item} copy={copy} busy={busy} onDecide={onDecide} />)}
        </ul>}
        <ContractDetails view={view} copy={copy} />
      </div>
    </div>
  );
}

export function ToolchainsManager({ api, locale, focusAutomationId = null }: {
  api: ToolchainsApi | null | undefined;
  locale: string;
  /** `?automation=<id>`: opened from an answer's toolchain source chip. */
  focusAutomationId?: string | null;
}) {
  const copy = useMemo(() => toolchainCopy(locale), [locale]);
  const [overview, setOverview] = useState<ToolchainOverview | null>(null);
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [loadFailed, setLoadFailed] = useState(false);
  // Busy is per entry: a minutes-long test on one Toolchain must not lock Withdraw on the others.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [exposingId, setExposingId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [history, setHistory] = useState<ToolchainHistoryEvent[] | null>(null);
  // Every read and action takes a ticket; a response older than the newest one applied is dropped,
  // so the 60 s poll can no longer overwrite the overview an action just returned.
  const issued = useRef(0);
  const applied = useRef(0);
  const apply = useCallback((ticket: number, next: ToolchainOverview) => {
    if (ticket < applied.current) return;
    applied.current = ticket;
    setOverview(next);
    setLoadFailed(false);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [lane, setLane] = useState<Lane>("all");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    if (!api) return;
    const ticket = ++issued.current;
    try {
      apply(ticket, await api.overview());
    } catch {
      // A failed read is not an empty list; say so instead of drawing "nothing yet".
      if (ticket >= applied.current) setLoadFailed(true);
    }
    // Icons are drawn in the background; pick up whatever exists now.
    try { setLogos(await api.logos?.() ?? {}); } catch { /* monograms stay */ }
  }, [api, apply]);

  const run = useCallback(async (key: string, action: () => Promise<ToolchainOverview>) => {
    setPending((current) => new Set(current).add(key));
    setError(null);
    const ticket = ++issued.current;
    try {
      apply(ticket, await action());
    } catch (cause) {
      setError(toolchainErrorText(cause, copy));
      // A refused action may mean the state moved underneath; show the current truth.
      void load();
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  }, [apply, copy, load]);

  useEffect(() => {
    if (!api) return;
    void load();
    const timer = setInterval(() => void load(), 60_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [api, load]);

  // A deep link opens its Toolchain whatever lane or search was active.
  useEffect(() => {
    if (!focusAutomationId) return;
    setLane("all");
    setQuery("");
    setOpenId(focusAutomationId);
  }, [focusAutomationId]);

  const views = useMemo(() => overview?.automations ?? [], [overview]);
  const counts = useMemo(() => Object.fromEntries(LANES.map((key) => [key, views.filter((view) => inLane(view, key)).length])) as Record<Lane, number>, [views]);
  // Callable first, then by last activity, then by name: the tools in use lead, like a Dock.
  const visible = useMemo(() => views.filter((view) => inLane(view, lane) && matchesQuery(view, query))
    .sort((left, right) => Number(isCallable(right)) - Number(isCallable(left))
      || lastActivity(right).localeCompare(lastActivity(left)) || displayName(left).localeCompare(displayName(right))), [views, lane, query]);
  const open = openId ? views.find((view) => view.automationId === openId) ?? null : null;

  // The history of the open Toolchain, re-read when its state changes.
  const openMarker = open ? `${open.automationId}|${open.interface?.updatedAt ?? ""}|${open.interface?.usage?.runs ?? 0}|${open.openReports?.length ?? 0}` : "";
  useEffect(() => {
    if (!api || !openMarker) { setHistory(null); return; }
    let cancelled = false;
    const id = openMarker.split("|")[0];
    void (api.history?.(id) ?? Promise.resolve([])).then((events) => { if (!cancelled) setHistory(events); }).catch(() => { if (!cancelled) setHistory([]); });
    return () => { cancelled = true; };
  }, [api, openMarker]);

  const decide = (view: ToolchainAutomationView) => (item: ToolchainCrystallizationView, decision: OwnerDecision) =>
    void run(view.automationId, () => api!.decide({ automationId: view.automationId, crystallizationId: item.id, decision }));
  const refreshAll = () => {
    setRefreshing(true);
    void run("*refresh", () => api!.refresh()).finally(() => setRefreshing(false));
  };

  if (!api) {
    return <section className={styles.root} aria-label={copy.title}><p className={styles.notice}>{copy.unavailable}</p></section>;
  }

  return (
    <section className={styles.root} aria-label={copy.title} data-toolchains-manager="true">
      <header className={styles.header}>
        <h2>{copy.title}</h2>
        <label className={styles.search}>
          <IconSearch size={14} />
          <input type="search" value={query} placeholder={copy.manager.search} aria-label={copy.manager.search}
            onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="button" className={styles.refresh} disabled={refreshing} onClick={refreshAll}
          aria-label={refreshing ? copy.analyzing : copy.analyze} title={refreshing ? copy.analyzing : copy.analyze} data-busy={refreshing ? "true" : undefined}>
          <IconRefresh size={14} />
        </button>
      </header>

      <div className={styles.lanes} role="tablist" aria-label={copy.title}>
        {LANES.map((key) => (
          <button key={key} type="button" role="tab" aria-selected={lane === key} data-active={lane === key ? "true" : "false"}
            onClick={() => setLane(key)}>
            {copy.manager.lanes[key]}{overview && counts[key] > 0 ? <span>{counts[key]}</span> : null}
          </button>
        ))}
      </div>

      {error && <p className={styles.error} role="status">{error}</p>}
      {!overview && !loadFailed && <p className={styles.notice}>{copy.manager.loading}</p>}
      {loadFailed && <p className={styles.error} role="status">{copy.manager.loadFailed}</p>}
      {overview && visible.length === 0 && <p className={styles.notice}>
        {query.trim() ? copy.manager.noMatch : copy.manager.laneEmpty[lane]}
      </p>}
      {visible.length > 0 && <div className={styles.grid}>
        {visible.map((view) => (
          <button key={view.automationId} type="button" className={styles.tile} id={`toolchain-${view.automationId}`}
            data-toolchain-entry={view.automationId} data-tone={tone(view)}
            data-testing={exposingId === view.automationId || view.testInProgress ? "true" : undefined}
            data-reported={view.openReports?.length ? "true" : undefined}
            title={oneLine(view) || displayName(view)} onClick={() => setOpenId(view.automationId)}>
            <AppIcon view={view} logo={logos[view.automationId]} size={60} />
            <span className={styles.tileName}>{displayName(view)}</span>
          </button>
        ))}
      </div>}

      {open && <ToolchainSheet view={open} logo={logos[open.automationId]} history={history} copy={copy} locale={locale}
        busy={pending.has(open.automationId)} testing={exposingId === open.automationId || open.testInProgress === true}
        onClose={() => setOpenId(null)}
        onExpose={() => {
          setExposingId(open.automationId);
          void run(open.automationId, () => api.expose(open.automationId)).finally(() => setExposingId(null));
        }}
        onWithdraw={() => void run(open.automationId, () => api.withdraw(open.automationId))}
        onDecide={decide(open)} />}
    </section>
  );
}
