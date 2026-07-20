"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { OneBrandMark } from "./OneBrand";
import styles from "./ProductModeMenu.module.css";

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
  const ko = (localeOverride ?? locale) === "ko";
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissibleLayer({
    open,
    roots: [triggerRef, menuRef],
    onDismiss: () => setOpen(false),
    restoreFocusRef: triggerRef,
  });

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
        title={ko ? "제품 전환" : "Switch product"}
      >
        {compact && (current === "one" ? <OneBrandMark size="medium" /> : <span className={styles.mark} aria-hidden="true">W</span>)}
        <span className={styles.copy}>
          <strong>{current === "one" ? "Agentlas One" : "Agentlas Work"}</strong>
        </span>
        <span className={styles.chevron} aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div id="agentlas-product-mode-menu" ref={menuRef} className={styles.menu} role="menu" aria-label={ko ? "Agentlas 제품" : "Agentlas products"}>
          <Link className={styles.option} href="/one" role="menuitem" onClick={() => setOpen(false)}>
            <span className={styles.optionCopy}>
              <strong>One</strong>
              <small>{ko ? "말하고 맡기면, 결과까지 준비해요" : "Talk, delegate, and get the result"}</small>
            </span>
            {current === "one" && <span className={styles.check} aria-label={ko ? "현재 제품" : "Current product"}>✓</span>}
          </Link>
          <Link className={styles.option} href="/dashboard" role="menuitem" onClick={() => setOpen(false)}>
            <span className={styles.optionCopy}>
              <strong>Work</strong>
              <small>{ko ? "팀과 도구를 직접 다루는 작업공간" : "Workspace for teams and tools"}</small>
            </span>
            {current === "work" && <span className={styles.check} aria-label={ko ? "현재 제품" : "Current product"}>✓</span>}
          </Link>
        </div>
      )}
    </div>
  );
}
