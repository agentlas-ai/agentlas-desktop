"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ipc } from "@/lib/ipc";
import { Markdown } from "@/components/Markdown";
import { IconArrowLeft, IconClose, IconSearch } from "@/components/Icon";
import type { OneCapabilitiesAPI, OneCapabilityDetail, OneCapabilityItem, OneCapabilityKind } from "../../../shared/one-capabilities";
import {
  CAPABILITY_KIND_ORDER, capabilityTitle, CAPABILITY_PAGE_SIZE, CAPABILITY_SOURCE_ORDER, DISABLED_SWITCH_TIP, detailIsMarkdown, filterCapabilities, itemEnabledTotals,
  kindCounts, kindLabel, sourceBadge, sourceCounts, sourceLabel, toggleCapability,
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
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={disabled ? tip : undefined} disabled={disabled}
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

  const visible = useMemo(() => filterCapabilities(items, { kind, source, query }), [items, kind, source, query]);
  const navCounts = useMemo(() => kindCounts(items, source), [items, source]);
  const chipCounts = useMemo(() => sourceCounts(items, kind), [items, kind]);
  const totals = useMemo(() => itemEnabledTotals(items.filter((item) => item.kind === kind)), [items, kind]);
  const openItem = detailId ? items.find((item) => item.id === detailId) ?? null : null;
  const title = copy("능력", "Capabilities");

  if (!open) return null;
  const closeDetail = () => { setDetailId(null); setDetail(null); setDetailState("idle"); };
  const switchFor = (item: OneCapabilityItem) => (
    <CapabilitySwitch checked={item.enabled} disabled={!item.applies} tip={DISABLED_SWITCH_TIP[locale]}
      label={`${capabilityTitle(item)} ${item.enabled ? copy("끄기", "Turn off") : copy("켜기", "Turn on")}`}
      onChange={(next) => void toggle(item.id, next)} />
  );

  const node = (
    <div className={styles.scrim} data-one-capabilities-layer="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} data-one-capabilities="true">
        <nav className={styles.nav} aria-label={title}>
          <h2>{title}</h2>
          {CAPABILITY_KIND_ORDER.map((entry) => (
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
              {detailId && <li aria-current="page">{openItem ? capabilityTitle(openItem) : detail?.name ?? ""}</li>}
            </ol>
            <button type="button" className={styles.iconButton} aria-label={copy("닫기", "Close")} data-capability-close="true" onClick={onClose}><IconClose size={14} /></button>
          </header>
          {detailId ? (
            <div className={styles.detail} data-capability-detail={detailId}>
              <div className={styles.detailTop}>
                <div className={styles.rowText}>
                  <strong>{openItem ? capabilityTitle(openItem) : detail?.name}</strong>
                  {openItem?.description && <span>{openItem.description}</span>}
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
                <div className={styles.chips} role="group" aria-label={copy("출처", "Source")}>
                  {CAPABILITY_SOURCE_ORDER.map((entry) => (
                    <button key={entry} type="button" data-source={entry} aria-pressed={source === entry} onClick={() => setSource(entry)}>
                      {sourceLabel(entry, locale)}<small>{chipCounts[entry]}</small>
                    </button>
                  ))}
                </div>
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
                          <strong>{capabilityTitle(item)}</strong>
                          {item.description && <span>{item.description}</span>}
                        </div>
                        <span className={styles.badge} data-personal={badge.personal ? "true" : "false"}>{badge.label}</span>
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
