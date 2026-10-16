"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ipc } from "@/lib/ipc";
import { Markdown } from "@/components/Markdown";
import { IconArrowLeft, IconClose, IconLock, IconSearch } from "@/components/Icon";
import type { OneCapabilitiesAPI, OneCapabilityDetail, OneCapabilityItem, OneCapabilityKind, OneCapabilityRole } from "../../../shared/one-capabilities";
import {
  CAPABILITY_KIND_ORDER, capabilityDescription, capabilityTitle, CAPABILITY_PAGE_SIZE, CAPABILITY_SOURCE_ORDER, detailIsMarkdown, filterCapabilities, itemEnabledTotals,
  kindCounts, kindLabel, limitTip, sourceBadge, sourceCounts, sourceLabel, SWITCH_TIMING_TIP, toggleCapability,
  type CapabilityLocale, type CapabilitySourceFilter,
} from "@/lib/one-capabilities-view";
import styles from "./OneCapabilitiesModal.module.css";

export interface OneCapabilitiesInitial {
  items?: OneCapabilityItem[];
  kind?: OneCapabilityKind;
  source?: CapabilitySourceFilter;
  query?: string;
  detail?: OneCapabilityDetail | null;
  detailId?: string | null;
}

export function CapabilitySwitch({ checked, disabled, label, tip, onChange }: { checked: boolean; disabled?: boolean; label: string; tip?: string; onChange(next: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={tip} disabled={disabled}
      className={styles.switch} data-on={checked ? "true" : "false"} data-capability-switch="true"
      onClick={(event) => { event.stopPropagation(); onChange(!checked); }}>
      <span aria-hidden="true" />
    </button>
  );
}

export function OneCapabilitiesModal({ open, locale, onClose, api: apiProp, initial }: {
  open: boolean; locale: CapabilityLocale; onClose(): void; api?: OneCapabilitiesAPI | null; initial?: OneCapabilitiesInitial;
}) {
  const ko = locale === "ko";
  const copy = (a: string, b: string) => (ko ? a : b);
  const [items, setItems] = useState<OneCapabilityItem[]>(initial?.items ?? []);
  const [loaded, setLoaded] = useState(Boolean(initial?.items));
  const [failed, setFailed] = useState(false);
  const [kind, setKind] = useState<OneCapabilityKind>(initial?.kind ?? "skill");
  const [source, setSource] = useState<CapabilitySourceFilter>(initial?.source ?? "all");
  const [query, setQuery] = useState(initial?.query ?? "");
  const [detailId, setDetailId] = useState<string | null>(initial?.detailId ?? initial?.detail?.id ?? null);
  const [detail, setDetail] = useState<OneCapabilityDetail | null>(initial?.detail ?? null);
  const [detailState, setDetailState] = useState<"idle" | "loading" | "missing">("idle");
  const [rowError, setRowError] = useState<string | null>(null);
  const [limit, setLimit] = useState(CAPABILITY_PAGE_SIZE);
  useEffect(() => setLimit(CAPABILITY_PAGE_SIZE), [kind, source, query]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const dialogRef = useRef<HTMLDivElement>(null);
  const api = (): OneCapabilitiesAPI | null => apiProp ?? (ipc() as { oneCapabilities?: OneCapabilitiesAPI } | null)?.oneCapabilities ?? null;

  const load = useCallback(async () => {
    const bridge = api();
    if (!bridge) { setFailed(true); setLoaded(true); return; }
    try { const result = await bridge.list(); setItems(result.items); setFailed(false); } catch { setFailed(true); }
    setLoaded(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiProp]);

  useEffect(() => { if (open && !initial?.items) void load(); }, [open, load, initial?.items]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
  useEffect(() => {
    if (!open || !detailId || detail?.id === detailId) return;
    let live = true;
    setDetailState("loading");
    const bridge = api();
    (bridge ? bridge.detail({ id: detailId }) : Promise.resolve(null))
      .then((value) => { if (!live) return; if (value) { setDetail(value); setDetailState("idle"); } else setDetailState("missing"); })
      .catch(() => { if (live) setDetailState("missing"); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, detailId]);

  const toggle = useCallback(async (id: string, enabled: boolean) => {
    setRowError(null);
    const result = await toggleCapability(api(), itemsRef.current, id, enabled, setItems);
    if (!result.ok && itemsRef.current.find((item) => item.id === id)?.applies) setRowError(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiProp]);

  const visible = useMemo(() => filterCapabilities(items, { kind, source, query, locale }), [items, kind, source, query, locale]);
  const navCounts = useMemo(() => kindCounts(items, source), [items, source]);
  // Only Agentlas's own items are listed (owner 2026-10-14): a kind with nothing in it is not shown, and the screen
  // opens on the first kind that has items instead of an empty list.
  const navKinds = useMemo(() => CAPABILITY_KIND_ORDER.filter((entry) => navCounts[entry] > 0), [navCounts]);
  useEffect(() => { if (navKinds.length && !navKinds.includes(kind)) setKind(navKinds[0]); }, [navKinds, kind]);
  const chipCounts = useMemo(() => sourceCounts(items, kind), [items, kind]);
  const totals = useMemo(() => itemEnabledTotals(items.filter((item) => item.kind === kind)), [items, kind]);
  const openItem = detailId ? items.find((item) => item.id === detailId) ?? null : null;
  const title = copy("능력", "Capabilities");

  if (!open) return null;
  const closeDetail = () => { setDetailId(null); setDetail(null); setDetailState("idle"); };
  // Personal Hope and CEO Hope share one inventory; an item can be kept to one of them (docs native-harness 21 G3).
  const setRole = async (id: string, role: OneCapabilityRole) => {
    const bridge = api();
    if (!bridge?.setRole) return;
    try {
      const next = await bridge.setRole({ id, role });
      if (next) setItems((current) => current.map((item) => (item.id === id ? { ...item, role: next.role ?? role } : item)));
      setRowError(null);
    } catch { setRowError(id); }
  };
  const roleFor = (item: OneCapabilityItem) => item.applies && item.enabled ? (
    <select className={styles.role} value={item.role ?? "both"} aria-label={copy("쓰는 곳", "Used by")}
      title={copy("개인 대화 / CEO(방·조직) / 둘 다", "Personal chat / CEO (rooms, organization) / both")}
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}
      onChange={(event) => void setRole(item.id, event.target.value as OneCapabilityRole)}>
      <option value="both">{copy("둘 다", "Both")}</option>
      <option value="personal">{copy("개인", "Personal")}</option>
      <option value="ceo">CEO</option>
    </select>
  ) : null;
  // No switch where no run can enforce one: a lock with the reason instead (owner 2026-10-12).
  const switchFor = (item: OneCapabilityItem) => item.applies ? (
    <CapabilitySwitch checked={item.enabled} tip={SWITCH_TIMING_TIP[locale]}
      label={`${capabilityTitle(item, locale)} ${item.enabled ? copy("끄기", "Turn off") : copy("켜기", "Turn on")}`}
      onChange={(next) => void toggle(item.id, next)} />
  ) : (
    <span className={styles.locked} role="img" aria-label={limitTip(item, locale)} title={limitTip(item, locale)} data-capability-locked={item.limit ?? "runtime_reads_itself"}>
      <IconLock size={13} />
    </span>
  );

  const node = (
    <div className={styles.scrim} data-one-capabilities-layer="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} data-one-capabilities="true">
        <nav className={styles.nav} aria-label={title}>
          <h2>{title}</h2>
          {navKinds.map((entry) => (
            <button key={entry} type="button" data-kind={entry} aria-current={entry === kind ? "page" : undefined}
              onClick={() => { setKind(entry); closeDetail(); }}>
              <span>{kindLabel(entry, locale)}</span><small>{navCounts[entry]}</small>
            </button>
          ))}
        </nav>
        <section className={styles.pane}>
          <header className={styles.head}>
            {detailId && <button type="button" className={styles.iconButton} aria-label={copy("목록으로", "Back to list")} data-capability-back="true" onClick={closeDetail}><IconArrowLeft size={14} /></button>}
            <ol className={styles.crumbs} aria-label={copy("현재 위치", "Breadcrumb")}>
              <li><button type="button" onClick={closeDetail}>{title}</button></li>
              <li><button type="button" onClick={closeDetail} aria-current={detailId ? undefined : "page"}>{kindLabel(kind, locale)}</button></li>
              {detailId && <li aria-current="page">{openItem ? capabilityTitle(openItem, locale) : detail?.name ?? ""}</li>}
            </ol>
            <button type="button" className={styles.iconButton} aria-label={copy("닫기", "Close")} data-capability-close="true" onClick={onClose}><IconClose size={14} /></button>
          </header>
          {detailId ? (
            <div className={styles.detail} data-capability-detail={detailId}>
              <div className={styles.detailTop}>
                <div className={styles.rowText}>
                  <strong>{openItem ? capabilityTitle(openItem, locale) : detail?.name}</strong>
                  {openItem && capabilityDescription(openItem, locale) && <span>{capabilityDescription(openItem, locale)}</span>}
                </div>
                {openItem && <span className={styles.badge} data-personal={sourceBadge(openItem.source, locale).personal ? "true" : "false"}>{sourceBadge(openItem.source, locale).label}</span>}
                {openItem && switchFor(openItem)}
              </div>
              {detailState === "loading" && <p className={styles.note} role="status">{copy("불러오는 중", "Loading")}</p>}
              {detailState === "missing" && <p className={styles.note} role="status">{copy("파일을 읽지 못했어요", "Could not read this file")}</p>}
              {detail && detail.id === detailId && (
                <>
                  <p className={styles.path} title={detail.path}>{detail.path}</p>
                  {(detail.truncated || detail.redacted) && <p className={styles.note}>{[detail.truncated ? copy("앞부분만 보여요", "Showing the first part") : "", detail.redacted ? copy("비밀 값은 가렸어요", "Secrets are hidden") : ""].filter(Boolean).join(" · ")}</p>}
                  <div className={styles.fileBody} data-format={detailIsMarkdown(detail) ? "markdown" : "code"}>
                    {detailIsMarkdown(detail)
                      ? <Markdown text={detail.text} messageId={`capability:${detail.id}`} />
                      : <pre><code>{detail.text}</code></pre>}
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              <div className={styles.filters}>
                {/* Only Agentlas's own items are listed (owner 2026-10-14), so a source filter shows only when there is a choice. */}
                {CAPABILITY_SOURCE_ORDER.filter((entry) => entry !== "all" && chipCounts[entry] > 0).length > 1 && <div className={styles.chips} role="group" aria-label={copy("출처", "Source")}>
                  {CAPABILITY_SOURCE_ORDER.filter((entry) => entry === "all" || chipCounts[entry] > 0).map((entry) => (
                    <button key={entry} type="button" data-source={entry} aria-pressed={source === entry} onClick={() => setSource(entry)}>
                      {sourceLabel(entry, locale)}<small>{chipCounts[entry]}</small>
                    </button>
                  ))}
                </div>}
                <label className={styles.search}>
                  <IconSearch size={13} />
                  <input type="search" value={query} placeholder={copy("검색", "Search")} aria-label={copy("검색", "Search")} onChange={(event) => setQuery(event.target.value)} />
                </label>
              </div>
              <ul className={styles.list} data-capability-list={kind}>
                {visible.slice(0, limit).map((item) => {
                  const badge = sourceBadge(item.source, locale);
                  return (
                    <li key={item.id} data-capability-id={item.id} data-enabled={item.enabled ? "true" : "false"}>
                      <div className={styles.row} role="button" tabIndex={0} onClick={() => setDetailId(item.id)}
                        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setDetailId(item.id); } }}>
                        <div className={styles.rowText}>
                          <strong>{capabilityTitle(item, locale)}</strong>
                          {capabilityDescription(item, locale) && <span>{capabilityDescription(item, locale)}</span>}
                        </div>
                        <span className={styles.badge} data-personal={badge.personal ? "true" : "false"}>{badge.label}</span>
                        {roleFor(item)}
                        {switchFor(item)}
                      </div>
                      {rowError === item.id && <p className={styles.rowError} role="status">{copy("바꾸지 못했어요. 다시 눌러 주세요.", "Could not change this. Try again.")}</p>}
                    </li>
                  );
                })}
              </ul>
              {visible.length > limit && <button type="button" className={styles.more} data-capability-more="true" onClick={() => setLimit((value) => value + CAPABILITY_PAGE_SIZE)}>{copy(`${visible.length - limit}개 더 보기`, `Show ${visible.length - limit} more`)}</button>}
              {loaded && !visible.length && (
                <p className={styles.note} role="status">{failed ? copy("목록을 읽지 못했어요", "Could not load the list") : query ? copy("찾는 항목이 없어요", "Nothing matches") : copy("항목이 없어요", "Nothing here yet")}</p>
              )}
              {!loaded && <p className={styles.note} role="status">{copy("불러오는 중", "Loading")}</p>}
              {loaded && !failed && totals.total > 0 && <p className={styles.foot}>{copy(`${totals.total}개 중 ${totals.enabled}개 켜짐`, `${totals.enabled} of ${totals.total} on`)}</p>}
            </>
          )}
        </section>
      </div>
    </div>
  );
  return typeof document === "undefined" ? node : createPortal(node, document.body);
}
