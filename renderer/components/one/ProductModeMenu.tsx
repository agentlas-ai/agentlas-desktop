"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { tFor, useT } from "@/lib/i18n";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { OneBrandMark } from "./OneBrand";
import styles from "./ProductModeMenu.module.css";

const ONE_RETURN_ROUTE_KEY = "agentlas.one.return-route.v1";

function safeOneReturnRoute(value: string | null): string {
  if (!value || value.length > 2_048 || !/^\/one(?:\?(?:task|conversation)=[A-Za-z0-9._:%-]+)?$/.test(value)) return "/one";
  return value;
}

export function ProductModeMenu({
  current,
  compact = false,
  darkText = false,
  locale: localeOverride,
}: {
  current: "one" | "work";
  compact?: boolean;
  darkText?: boolean;
  locale?: "ko" | "en";
}) {
  const { locale } = useT();
  const activeLocale = localeOverride ?? locale;
  const [open, setOpen] = useState(false);
  const [oneHref, setOneHref] = useState("/one");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissibleLayer({
    open,
    roots: [triggerRef, menuRef],
    onDismiss: () => setOpen(false),
    restoreFocusRef: triggerRef,
  });
  useEffect(() => {
    if (current === "one") {
      const route = safeOneReturnRoute(`${window.location.pathname}${window.location.search}`);
      window.sessionStorage.setItem(ONE_RETURN_ROUTE_KEY, route);
      setOneHref(route);
      return;
    }
    setOneHref(safeOneReturnRoute(window.sessionStorage.getItem(ONE_RETURN_ROUTE_KEY)));
  }, [current]);

  return (
    <div className={`${styles.root} ${compact ? styles.compact : ""} ${darkText ? styles.dark : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="agentlas-product-mode-menu"
        onClick={() => setOpen((value) => !value)}
        title={tFor(activeLocale, "one.mode.switch_title")}
      >
        {compact && (current === "one" ? <OneBrandMark size="medium" /> : <span className={styles.mark} aria-hidden="true">W</span>)}
        <span className={styles.copy}>
          <strong>{current === "one" ? "Agentlas One" : "Agentlas Work"}</strong>
        </span>
        <span className={styles.chevron} aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div id="agentlas-product-mode-menu" ref={menuRef} className={styles.menu} role="menu" aria-label={tFor(activeLocale, "one.mode.menu_aria")}>
          <Link className={styles.option} href={oneHref} role="menuitem" onClick={() => setOpen(false)}>
            <span className={styles.optionCopy}>
              <strong>One</strong>
              <small>{tFor(activeLocale, "one.mode.one_sub")}</small>
            </span>
            {current === "one" && <span className={styles.check} aria-label={tFor(activeLocale, "one.mode.current_aria")}>✓</span>}
          </Link>
          <Link className={styles.option} href="/dashboard" role="menuitem" onClick={() => setOpen(false)}>
            <span className={styles.optionCopy}>
              <strong>Work</strong>
              <small>{tFor(activeLocale, "one.mode.work_sub")}</small>
            </span>
            {current === "work" && <span className={styles.check} aria-label={tFor(activeLocale, "one.mode.current_aria")}>✓</span>}
          </Link>
        </div>
      )}
    </div>
  );
}
