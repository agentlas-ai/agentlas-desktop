"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { tFor, useT } from "@/lib/i18n";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { OneBrandMark } from "./OneBrand";
import { IconBrain } from "@/components/Icon";
import { requestScienceInstall, SCIENCE_INSTALL_DISCOVERY_ENABLED } from "@/lib/science-install-entry";
import { useScienceSuiteStatus } from "@/lib/use-science-suite-status";
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
  current: "one" | "work" | "science";
  compact?: boolean;
  darkText?: boolean;
  locale?: "ko" | "en";
}) {
  const { locale } = useT();
  const router = useRouter();
  const activeLocale = localeOverride ?? locale;
  const [open, setOpen] = useState(false);
  const [oneHref, setOneHref] = useState("/one");
  const scienceSuite = useScienceSuiteStatus();
  const scienceAvailable = current === "science" || Boolean(
    scienceSuite?.installed && scienceSuite.enabled && scienceSuite.phase === "installed",
  );
  const scienceInstalled = current === "science" || Boolean(scienceSuite?.installed);
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
  const productName = current === "one" ? "Agentlas One" : current === "science" ? "Agentlas Science" : "Agentlas Work";

  const navigate = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const navigateFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, href: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    navigate(href);
  };

  const openScience = () => {
    setOpen(false);
    if (scienceAvailable) {
      router.push("/science");
      return;
    }
    requestScienceInstall();
  };

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
        {compact && (current === "one" ? <OneBrandMark size="medium" /> : current === "science" ? <span className={styles.mark} aria-hidden="true"><IconBrain size={16} /></span> : <span className={styles.mark} aria-hidden="true">W</span>)}
        <span className={styles.copy}>
          <strong>{productName}</strong>
        </span>
        <span className={styles.chevron} aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div id="agentlas-product-mode-menu" ref={menuRef} className={styles.menu} role="menu" aria-label={tFor(activeLocale, "one.mode.menu_aria")}>
          <button className={styles.option} type="button" role="menuitem" onClick={() => navigate(oneHref)} onKeyDown={(event) => navigateFromKeyboard(event, oneHref)}>
            <span className={styles.optionCopy}>
              <strong>One</strong>
              <small>{tFor(activeLocale, "one.mode.one_sub")}</small>
            </span>
            {current === "one" && <span className={styles.check} aria-label={tFor(activeLocale, "one.mode.current_aria")}>✓</span>}
          </button>
          <button className={styles.option} type="button" role="menuitem" onClick={() => navigate("/dashboard")} onKeyDown={(event) => navigateFromKeyboard(event, "/dashboard")}>
            <span className={styles.optionCopy}>
              <strong>Work</strong>
              <small>{tFor(activeLocale, "one.mode.work_sub")}</small>
            </span>
            {current === "work" && <span className={styles.check} aria-label={tFor(activeLocale, "one.mode.current_aria")}>✓</span>}
          </button>
          {(scienceAvailable || SCIENCE_INSTALL_DISCOVERY_ENABLED) && <button className={styles.option} type="button" role="menuitem" onClick={openScience} onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openScience();
          }}>
            <span className={styles.optionCopy}>
              <strong>Science</strong>
              <small>{scienceAvailable
                ? tFor(activeLocale, "one.mode.science_sub")
                : scienceInstalled
                  ? (activeLocale === "ko" ? "켜기 필요" : "Enable required")
                  : (activeLocale === "ko" ? "다운로드 필요" : "Download required")}</small>
            </span>
            {current === "science" && <span className={styles.check} aria-label={tFor(activeLocale, "one.mode.current_aria")}>✓</span>}
          </button>}
        </div>
      )}
    </div>
  );
}
