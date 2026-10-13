"use client";

// Shared pieces of the ChatGPT-style detail column: breadcrumb, header, prompt
// card, list sections and key/value info.
import { useState, type ReactNode } from "react";
import { IconChevronRight, IconMoreHorizontal, IconChevronDown } from "@/components/Icon";
import styles from "./ToolsUi.module.css";

export function IconArrowRightSmall({ size = 13 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
}

export function Breadcrumb({ trail }: { trail: Array<{ label: string; onClick?: () => void }> }) {
  return <nav className={styles.crumbBar} aria-label="breadcrumb">
    {trail.map((item, index) => {
      const last = index === trail.length - 1;
      return <span key={`${index}-${item.label}`} style={{ display: "inline-flex", alignItems: "center", minWidth: 0 }}>
        {index > 0 && <span className={styles.crumbSep}><IconChevronRight size={13} /></span>}
        {last || !item.onClick
          ? <span className={styles.crumbCurrent} aria-current={last ? "page" : undefined}>{item.label}</span>
          : <button type="button" className={styles.crumbLink} onClick={item.onClick}>{item.label}</button>}
      </span>;
    })}
  </nav>;
}

export interface MenuItem { label: string; onClick: () => void; danger?: boolean }

export function MoreMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return <span className={styles.menuWrap}>
    <button type="button" className={styles.iconButton} aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen((value) => !value)}><IconMoreHorizontal size={17} /></button>
    {open && <>
      <button type="button" className={styles.menuDismiss} aria-label={label} onClick={() => setOpen(false)} />
      <div className={styles.menu} role="menu">
        {items.map((item) => <button key={item.label} type="button" role="menuitem" data-danger={item.danger || undefined} onClick={() => { setOpen(false); item.onClick(); }}>{item.label}</button>)}
      </div>
    </>}
  </span>;
}

export function DetailHeader({ icon, name, tagline, actions }: { icon: ReactNode; name: string; tagline?: string; actions?: ReactNode }) {
  return <header>
    <div className={styles.detailIcon}>{icon}</div>
    <div className={styles.titleRow}>
      <h1 className={styles.detailName} title={name}>{name}</h1>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
    {tagline && <p className={styles.detailTagline}>{tagline}</p>}
  </header>;
}

export interface PromptChipData { key: string; text: string; onGo: () => void; goLabel: string }

export function PromptCard({ brand, brandColor, brandIcon, chips }: { brand: string; brandColor?: string; brandIcon?: ReactNode; chips: PromptChipData[] }) {
  if (!chips.length) return null;
  return <div className={styles.promptCard}>
    {chips.slice(0, 3).map((chip) => <div key={chip.key} className={styles.promptChip}>
      <span className={styles.promptChipText}>{brandIcon && <span className={styles.chipMark}>{brandIcon}</span>}<strong style={brandColor ? { color: brandColor } : undefined}>{brand}</strong>{chip.text}</span>
      <button type="button" className={styles.promptArrow} onClick={chip.onGo} aria-label={chip.goLabel} title={chip.goLabel}><IconArrowRightSmall /></button>
    </div>)}
  </div>;
}

export function Section({ title, count, children, id }: { title: string; count?: number; children: ReactNode; id?: string }) {
  return <section className={styles.section} id={id}>
    <h2 className={styles.sectionTitle}>{title}{typeof count === "number" && <span>{count}</span>}</h2>
    {children}
  </section>;
}

export interface RowData { key: string; icon: ReactNode; name: string; sub?: string; meta?: ReactNode; onClick?: () => void; highlight?: boolean }

/** Five rows, then "… 외 N개 보기" like the ChatGPT skills list. */
export function CollapsedRows({ rows, ko, limit = 5 }: { rows: RowData[]; ko: boolean; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, limit);
  const rest = rows.slice(limit);
  return <div className={styles.rows}>
    {shown.map((row) => {
      const body = <>
        <span className={styles.rowIcon}>{row.icon}</span>
        <span className={styles.rowText}><span className={styles.rowName}>{row.name}</span>{row.sub && <span className={styles.rowSub}>{row.sub}</span>}</span>
        {row.meta && <span className={styles.rowMeta}>{row.meta}</span>}
      </>;
      return row.onClick
        ? <button key={row.key} type="button" id={`row-${row.key}`} className={styles.row} data-highlight={row.highlight || undefined} onClick={row.onClick}>{body}</button>
        : <div key={row.key} id={`row-${row.key}`} className={styles.row} data-highlight={row.highlight || undefined}>{body}</div>;
    })}
    {!expanded && rest.length > 0 && <button type="button" className={`${styles.row} ${styles.moreRow}`} onClick={() => setExpanded(true)}>
      <span className={styles.stackIcons}><IconChevronDown size={15} /></span>
      <span className={styles.rowSub} style={{ flex: 1 }}>{rest.slice(0, 2).map((row) => row.name).join(", ")}{ko ? ` 외 ${Math.max(rest.length - 2, 0)}개 보기` : ` and ${Math.max(rest.length - 2, 0)} more`}</span>
    </button>}
  </div>;
}

export function InfoRows({ rows }: { rows: Array<[string, ReactNode]> }) {
  const present = rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (!present.length) return null;
  return <dl className={styles.info}>{present.map(([key, value]) => <InfoPair key={key} label={key} value={value} />)}</dl>;
}

function InfoPair({ label, value }: { label: string; value: ReactNode }) {
  return <><dt>{label}</dt><dd>{value}</dd></>;
}

export function GlyphSkill({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 3h8l4 4v14H7z" /><path d="M15 3v4h4M10 12h6M10 16h6" /></svg>;
}

export function GlyphTool({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" /></svg>;
}

export function GlyphConnector({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5" /></svg>;
}
