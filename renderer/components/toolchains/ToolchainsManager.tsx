// Work › Environment › Toolchains — every automation with a graph, as the owner
// manages it: what One can call (and who made it callable), what repeated runs
// are teaching, and what failed its fresh-session test. Laid out like Computer
// History: one time column, a dotted spine, a card per entry, lanes on top.
//
// Nothing here decides a state. Main owns every transition; this screen shows
// the overview it returns and sends only the owner's narrow decisions.
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  OwnerDecision,
  ToolchainAutomationView,
  ToolchainCrystallizationView,
  ToolchainOverview,
  ToolchainsApi,
} from "@shared/toolchain";
import { IconRefresh, IconSearch, IconShield, IconToolchain } from "@/components/Icon";
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

/**
 * When the owner last saw something change: the contract test or an owner/learner
 * transition. The learner's periodic refresh is not activity — using it would
 * move every entry to "today" once a minute.
 */
function lastActivity(view: ToolchainAutomationView): string | null {
  const stamps = [
    view.interface?.exposedBy?.at,
    view.interface?.coldStart?.at,
    ...view.crystallizations.filter((item) => item.state !== "superseded").map((item) => item.updatedAt),
  ].filter((value): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)));
  return stamps.sort().at(-1) ?? null;
}

function tone(view: ToolchainAutomationView): "ok" | "warn" | "info" | "muted" {
  if (isCallable(view)) return "ok";
  if (view.interface?.state === "deprecated" && !view.interfaceStale) return "muted";
  if (view.interface) return "warn";
  return isLearning(view) ? "info" : "muted";
}

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

function dateTimeLabel(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function matchesQuery(view: ToolchainAutomationView, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const contract = view.interface;
  return [view.automationName, contract?.name, contract?.description, ...(contract?.whenToUse ?? [])]
    .some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(needle));
}

function CrystallizationRow({ item, copy, busy, onDecide }: {
  item: ToolchainCrystallizationView;
  copy: ToolchainCopy;
  busy: boolean;
  onDecide: (item: ToolchainCrystallizationView, decision: OwnerDecision) => void;
}) {
  const reason = item.reasonCode ? copy.reason[item.reasonCode] ?? item.reasonCode : null;
  return (
    <li className={styles.learnedItem} data-state={item.state}>
      <div className={styles.learnedHead}>
        <span>{crystallizationLabel(item, copy)}</span>
        <span className={styles.badge} data-state={item.state}>{copy.state[item.state] ?? item.state}</span>
      </div>
      <span className={styles.metric}>{copy.evidence(item.evidence.share, item.evidence.eligibleEpisodes, item.evidence.quality === "kernel_completed_only")}</span>
      {item.kind === "page_read" && item.state === "candidate"
        && <span className={styles.metric}>{item.cost ? copy.cost(item.cost) : copy.notMeasured}</span>}
      {item.state === "shadow" && <span className={styles.metric}>{copy.shadow(item.shadow.consecutiveMatches, 5, item.shadow.mismatches)}</span>}
      {(item.state === "active" || item.state === "demoted") && item.active.appliedAt && <>
        <span className={styles.metric}>{copy.active(item.active.runs, item.active.rereads, item.active.fallbacks)}</span>
        {item.outcomes.after.judged > 0 && <span className={styles.metric}>{copy.outcomes(item.outcomes.before, item.outcomes.after)}</span>}
      </>}
      {reason && <span className={styles.reason}>{reason}</span>}
      <div className={styles.actions}>
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
  return (
    <details className={styles.contract}>
      <summary>{copy.manager.contract}</summary>
      <div className={styles.contractBody}>
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
          {inputs.length === 0 ? <span className={styles.metric}>{copy.manager.noInputs}</span> : <ul>
            {inputs.map(([key, property]) => <li key={key}>
              <code>{key}</code>{contract.inputSchema.required.includes(key) ? ` · ${copy.manager.required}` : ""} — {property.description}
            </li>)}
          </ul>}
        </section>
        {contract.coldStart?.cases && contract.coldStart.cases.length > 0 && <section>
          <small>{copy.casesTitle}</small>
          <ul className={styles.cases}>
            {contract.coldStart.cases.map((probe, index) => (
              <li key={index} data-kind={probe.kind} data-ok={probe.kind === "positive" ? String(probe.bound) : String(!probe.selected)}>
                <span className={styles.caseVerdict}>{copy.caseKind(probe.kind)} · {copy.caseVerdict(probe)}</span>
                <span className={styles.caseTask}>{probe.task}</span>
              </li>
            ))}
          </ul>
        </section>}
      </div>
    </details>
  );
}

function ToolchainEntry({ view, copy, locale, busy, exposing, focused, onExpose, onWithdraw, onDecide }: {
  view: ToolchainAutomationView;
  copy: ToolchainCopy;
  locale: string;
  busy: boolean;
  exposing: boolean;
  focused: boolean;
  onExpose: () => void;
  onWithdraw: () => void;
  onDecide: (item: ToolchainCrystallizationView, decision: OwnerDecision) => void;
}) {
  const contract = view.interface;
  const at = lastActivity(view);
  const stateLabel = interfaceStateLabel(view, copy);
  const callable = isCallable(view);
  const learned = view.crystallizations.filter((item) => item.state !== "superseded");
  // Strongest observed reads first, each tied to its step (same rule as the One rail).
  const observed = learned.length === 0
    ? view.observations
      .flatMap((observation) => observation.topTargets.slice(0, 1).map((target) => ({
        ...target, nodeId: observation.nodeId, waitingForIdentity: !observation.nodeDigest && target.share >= 0.8,
      })))
      .filter((target) => target.share > 0)
      .sort((left, right) => right.share - left.share)
      .slice(0, 3)
    : [];
  const effects = contract ? [
    contract.effects.readOnlyHint ? copy.manager.effects.readOnly : copy.manager.effects.writes,
    ...(contract.effects.destructiveHint ? [copy.manager.effects.destructive] : []),
    ...(contract.effects.idempotentHint ? [copy.manager.effects.idempotent] : []),
    ...(contract.effects.openWorldHint ? [copy.manager.effects.openWorld] : []),
  ] : [];
  // A test started anywhere (this screen, the One rail, or One's toolchain_publish) shows as running here.
  const testing = exposing || view.testInProgress === true;
  const exposeLabel = testing ? copy.exposing : contract && contract.state !== "deprecated" ? copy.retest : copy.expose;
  return (
    <article
      className={styles.entry}
      id={`toolchain-${view.automationId}`}
      data-toolchain-entry={view.automationId}
      data-tone={tone(view)}
      data-focused={focused ? "true" : undefined}
    >
      <time dateTime={at ?? undefined}>{at ? timeLabel(at, locale) : ""}</time>
      <span className={styles.marker} data-tone={tone(view)} aria-hidden="true" />
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <strong><span className={styles.cardIcon} aria-hidden="true"><IconToolchain size={13} /></span>{contract?.name || view.automationName}</strong>
          <span className={styles.badges}>
            {focused && <span className={styles.chip} data-focus="true">{copy.manager.focused}</span>}
            {stateLabel && <span className={styles.badge} data-tone={tone(view)}>{stateLabel}</span>}
            {contract?.exposedBy && <span className={styles.chip} data-actor={contract.exposedBy.kind}
              title={dateTimeLabel(contract.exposedBy.at, locale)}>
              {contract.exposedBy.kind === "one" ? copy.manager.exposedByOne : copy.manager.exposedByOwner}
            </span>}
            {!view.enabled && <span className={styles.chip}>{copy.manager.paused}</span>}
          </span>
        </div>
        {contract?.description && <p>{contract.description}</p>}
        {contract?.coldStart && <span className={styles.metric}>
          {copy.coldStart(contract.coldStart)} · {copy.manager.tested(dateTimeLabel(contract.coldStart.at, locale), contract.coldStart.model)}
        </span>}
        {contract && <span className={styles.metric} data-usage="true">{copy.usage(contract.usage?.returned ?? 0, contract.usage?.runs ?? 0)}</span>}
        {view.openReports?.length ? <span className={styles.metric} data-toolchain-reports={view.openReports.length}>
          {copy.reported(view.openReports.length, view.openReports[0].problem)}</span> : null}
        {effects.length > 0 && <div className={styles.effects}>{effects.map((label) => <span key={label}>{label}</span>)}</div>}
        <ContractDetails view={view} copy={copy} />
        {learned.length > 0 && <section className={styles.learned} aria-label={copy.manager.learned}>
          <small>{copy.manager.learned}</small>
          <ul>{learned.map((item) => <CrystallizationRow key={item.id} item={item} copy={copy} busy={busy} onDecide={onDecide} />)}</ul>
        </section>}
        {observed.map((target) => <span key={`${target.nodeId}:${target.kind}:${target.target}`} className={styles.observed}>
          {copy.observed(target.nodeId, target.target, target.share, target.waitingForIdentity)}</span>)}
        <div className={styles.actions}>
          {callable && !testing
            ? <button type="button" disabled={busy} onClick={onWithdraw}>{copy.withdraw}</button>
            : <button type="button" data-primary="true" disabled={busy || testing} onClick={onExpose}>{exposeLabel}</button>}
          <button type="button" data-link="true" onClick={() => navigate(`/automation/detail?id=${encodeURIComponent(view.automationId)}`)}>
            {copy.manager.openAutomation}
          </button>
        </div>
      </div>
    </article>
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
  const [loadFailed, setLoadFailed] = useState(false);
  // Busy is per entry: a minutes-long test on one Toolchain must not lock Withdraw on the others.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [exposingId, setExposingId] = useState<string | null>(null);
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

  // A deep link must land on its entry whatever lane or search was active.
  useEffect(() => {
    if (!focusAutomationId) return;
    setLane("all");
    setQuery("");
  }, [focusAutomationId]);
  const focusPresent = Boolean(focusAutomationId && overview?.automations.some((view) => view.automationId === focusAutomationId));
  useEffect(() => {
    if (!focusPresent || !focusAutomationId) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`toolchain-${focusAutomationId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusPresent, focusAutomationId]);

  const views = useMemo(() => overview?.automations ?? [], [overview]);
  const counts = useMemo(() => Object.fromEntries(LANES.map((key) => [key, views.filter((view) => inLane(view, key)).length])) as Record<Lane, number>, [views]);
  const visible = useMemo(() => views.filter((view) => inLane(view, lane) && matchesQuery(view, query)), [views, lane, query]);
  const groups = useMemo(() => {
    const dated = new Map<string, { label: string; at: string; entries: ToolchainAutomationView[] }>();
    const undated: ToolchainAutomationView[] = [];
    for (const view of visible) {
      const at = lastActivity(view);
      if (!at) { undated.push(view); continue; }
      const key = new Date(at).toDateString();
      const group = dated.get(key) ?? { label: dayLabel(at, locale), at, entries: [] };
      group.entries.push(view);
      if (at > group.at) group.at = at;
      dated.set(key, group);
    }
    const ordered = [...dated.values()].sort((left, right) => right.at.localeCompare(left.at));
    for (const group of ordered) group.entries.sort((left, right) => (lastActivity(right) ?? "").localeCompare(lastActivity(left) ?? ""));
    undated.sort((left, right) => left.automationName.localeCompare(right.automationName));
    return [...ordered.map(({ label, entries }) => ({ key: label, label, entries })),
      ...(undated.length ? [{ key: "undated", label: copy.manager.noDate, entries: undated }] : [])];
  }, [visible, locale, copy]);

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
        <div>
          <h2>
            <span className={styles.titleIcon} aria-hidden="true"><IconToolchain size={18} /></span>
            {copy.title}
            <span className={styles.local} title={copy.manager.localOnly} aria-label={copy.manager.localOnly}><IconShield size={11} /></span>
          </h2>
          <p>{copy.manager.subtitle}</p>
        </div>
        <div className={styles.headerActions}>
          <label className={styles.search}>
            <IconSearch size={12} />
            <input type="search" value={query} placeholder={copy.manager.search} aria-label={copy.manager.search}
              onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button type="button" disabled={refreshing} onClick={refreshAll}>
            <IconRefresh size={12} /> {refreshing ? copy.analyzing : copy.analyze}
          </button>
        </div>
      </header>

      <div className={styles.lanes} role="tablist" aria-label={copy.title}>
        {LANES.map((key) => (
          <button key={key} type="button" role="tab" aria-selected={lane === key} data-active={lane === key ? "true" : "false"}
            onClick={() => setLane(key)}>
            {copy.manager.lanes[key]}<span>{overview ? counts[key] : ""}</span>
          </button>
        ))}
      </div>

      {error && <p className={styles.error} role="status">{error}</p>}
      {!overview && !loadFailed && <p className={styles.notice}>{copy.manager.loading}</p>}
      {loadFailed && <p className={styles.error} role="status">{copy.manager.loadFailed}</p>}
      {overview && visible.length === 0 && <div className={styles.laneEmpty}>
        {query.trim() ? copy.manager.noMatch : copy.manager.laneEmpty[lane]}
      </div>}
      {visible.length > 0 && <div className={styles.timeline}>
        {groups.map((group) => <details className={styles.day} key={group.key} open>
          <summary>{group.label}</summary>
          {group.entries.map((view) => <ToolchainEntry key={view.automationId} view={view} copy={copy} locale={locale}
            busy={pending.has(view.automationId)} exposing={exposingId === view.automationId} focused={view.automationId === focusAutomationId}
            onExpose={() => {
              setExposingId(view.automationId);
              void run(view.automationId, () => api.expose(view.automationId)).finally(() => setExposingId(null));
            }}
            onWithdraw={() => void run(view.automationId, () => api.withdraw(view.automationId))}
            onDecide={decide(view)} />)}
        </details>)}
      </div>}
    </section>
  );
}
