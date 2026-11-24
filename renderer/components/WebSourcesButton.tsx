"use client";

import { useEffect, useState } from "react";
import { webSourceSiteOfUrl, type WebSource } from "@shared/web-search/web-sources";
import { ipc } from "@/lib/ipc";
import { PopupFrame } from "./Popup";
import styles from "./WebSourcesButton.module.css";

/**
 * "Sources" under an answer (D2): up to three overlapping round site icons + the word; a click opens a sheet listing every source
 * (site icon and name on one line, the page title in bold below, a hairline between items). An item opens its page through the
 * app's one link path (an anchor with target=_blank: Main's window-open handler hands https to the default browser).
 * Every runtime feeds this the same list (shared/web-search/web-sources.ts), so the button never depends on which model answered.
 */
/** Icons already asked for this session (data: address, or null = the letter): one Main call per site. */
const iconCache = new Map<string, Promise<string | null>>();
function siteIcon(host: string): Promise<string | null> {
  const hit = iconCache.get(host);
  if (hit) return hit;
  const asked = ipc()?.webSources?.favicon(host).catch(() => null) ?? Promise.resolve(null);
  iconCache.set(host, asked);
  return asked;
}

/**
 * A source's round site icon. Main fetches it (electron/web-search/favicon.ts) and hands a data: address only for a real icon:
 * the icon service answers an unknown site with a grey placeholder under HTTP 404, which an <img> here cannot tell apart. Until
 * then, and for any site without one, the first letter of the site is drawn.
 */
export function SourceIcon({ source }: { source: Pick<WebSource, "url" | "site"> }) {
  const host = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(source.site) ? source.site.toLowerCase() : webSourceSiteOfUrl(source.url);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!host) return;
    let alive = true;
    void siteIcon(host).then((value) => { if (alive) setSrc(value); });
    return () => { alive = false; };
  }, [host]);
  const letter = (source.site || "?").trim().charAt(0) || "?";
  return <span className={styles.icon} aria-hidden="true">
    {src ? <img src={src} alt="" width={20} height={20} decoding="async" draggable={false} /> : letter}
  </span>;
}

export function WebSourcesList({ sources }: { sources: readonly WebSource[] }) {
  return <ul className={styles.list} data-testid="web-sources-list">
    {sources.map((source) => <li className={styles.item} key={source.url}>
      <a className={styles.link} href={source.url} target="_blank" rel="noreferrer noopener" data-testid="web-source-item">
        <span className={styles.site}><SourceIcon source={source} /><span className={styles.siteName}>{source.site}</span></span>
        <p className={styles.title}>{source.title}</p>
      </a>
    </li>)}
  </ul>;
}

export function WebSourcesButton({ sources, locale }: { sources: readonly WebSource[]; locale: "ko" | "en" }) {
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  const label = locale === "ko" ? "소스" : "Sources";
  // One icon per distinct site, so three results from one site do not draw three identical circles.
  const seen = new Set<string>();
  const stack = sources.filter((source) => (seen.has(source.site) ? false : (seen.add(source.site), true))).slice(0, 3);
  return <>
    <button type="button" className={styles.button} data-testid="web-sources-button" aria-haspopup="dialog" aria-label={`${label} (${sources.length})`} title={label}
      onClick={() => setOpen(true)}>
      <span className={styles.stack}>{stack.map((source) => <SourceIcon key={source.site} source={source} />)}</span>
      <span className={styles.label}>{label}</span>
    </button>
    {open && <PopupFrame title={label} closeLabel={locale === "ko" ? "닫기" : "Close"} size="compact" onClose={() => setOpen(false)}
      dataAttributes={{ "data-testid": "web-sources-panel" }}>
      <WebSourcesList sources={sources} />
    </PopupFrame>}
  </>;
}
