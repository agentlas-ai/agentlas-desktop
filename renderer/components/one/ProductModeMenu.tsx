"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { tFor, useT } from "@/lib/i18n";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { OneBrandMark } from "./OneBrand";
import { IconApps, IconBrain, IconChevronDown, IconDownload, IconPower } from "@/components/Icon";
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
  const keyboardOpenRef = useRef(false);
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
  useEffect(() => {
    if (!open || !keyboardOpenRef.current) return;
    keyboardOpenRef.current = false;
    requestAnimationFrame(() => {
      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
      const activeItem = menuRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"]');
      (activeItem ?? items?.[0])?.focus();
    });
  }, [open]);
  const productName = current === "one" ? "Agentlas One" : current === "science" ? "Agentlas Science" : "Agentlas Work";

  const navigate = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, activate: () => void) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(event.currentTarget);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  const toggleMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const nextOpen = !open;
    keyboardOpenRef.current = nextOpen && event.detail === 0;
    setOpen(nextOpen);
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
        aria-label={`${productName}, ${tFor(activeLocale, "one.mode.switch_title")}`}
        onClick={toggleMenu}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            keyboardOpenRef.current = true;
            setOpen(true);
          } else if ((event.key === "Enter" || event.key === " ") && !open) {
            keyboardOpenRef.current = true;
          }
        }}
        title={tFor(activeLocale, "one.mode.switch_title")}
      >
        {compact && (current === "one" ? <OneBrandMark size="small" /> : current === "science" ? <span className={styles.mark} aria-hidden="true"><IconBrain size={16} /></span> : <span className={styles.mark} aria-hidden="true"><IconApps size={15} /></span>)}
        <span className={styles.copy}>
          <strong>{productName}</strong>
        </span>
        <span className={styles.chevron} aria-hidden="true"><IconChevronDown size={13} /></span>
      </button>
      {open && (
        <div id="agentlas-product-mode-menu" ref={menuRef} className={styles.menu} role="menu" aria-label={tFor(activeLocale, "one.mode.menu_aria")}>
          <button
            id="agentlas-product-mode-one"
            className={styles.option}
            type="button"
            role="menuitem"
            aria-label="One"
            aria-describedby="agentlas-product-mode-one-help"
            aria-current={current === "one" ? "page" : undefined}
            onClick={() => navigate(oneHref)}
            onKeyDown={(event) => handleOptionKeyDown(event, () => navigate(oneHref))}
          >
            <span className={styles.optionIcon} aria-hidden="true"><OneBrandMark size="small" className={styles.optionOneMark} /></span>
            <span className={styles.optionCopy}><strong>One</strong><small id="agentlas-product-mode-one-help">{tFor(activeLocale, "one.mode.one_sub")}</small></span>
            {current === "one" && <span className={styles.check} aria-hidden="true">✓</span>}
          </button>
          <button
            id="agentlas-product-mode-work"
            className={styles.option}
            type="button"
            role="menuitem"
            aria-label="Work"
            aria-describedby="agentlas-product-mode-work-help"
            aria-current={current === "work" ? "page" : undefined}
            onClick={() => navigate("/dashboard")}
            onKeyDown={(event) => handleOptionKeyDown(event, () => navigate("/dashboard"))}
          >
            <span className={styles.optionIcon} aria-hidden="true"><IconApps size={18} /></span>
            <span className={styles.optionCopy}><strong>Work</strong><small id="agentlas-product-mode-work-help">{tFor(activeLocale, "one.mode.work_sub")}</small></span>
            {current === "work" && <span className={styles.check} aria-hidden="true">✓</span>}
          </button>
          {(scienceAvailable || SCIENCE_INSTALL_DISCOVERY_ENABLED) && (
            <button
              id="agentlas-product-mode-science"
              className={styles.option}
              type="button"
              role="menuitem"
              aria-label="Science"
              aria-describedby="agentlas-product-mode-science-help"
              aria-current={current === "science" ? "page" : undefined}
              onClick={openScience}
              onKeyDown={(event) => handleOptionKeyDown(event, openScience)}
            >
              <span className={styles.optionIcon} aria-hidden="true"><IconBrain size={18} /></span>
              <span className={styles.optionCopy}>
                <strong>Science</strong>
                <small id="agentlas-product-mode-science-help">
                  {scienceAvailable
                    ? tFor(activeLocale, "one.mode.science_sub")
                    : scienceInstalled
                      ? (activeLocale === "ko" ? "켜기 필요" : "Enable required")
                      : (activeLocale === "ko" ? "다운로드 필요" : "Download required")}
                </small>
              </span>
              {current === "science"
                ? <span className={styles.check} aria-hidden="true">✓</span>
                : !scienceAvailable && (
                  <span className={styles.statusIcon} aria-hidden="true">
                    {scienceInstalled ? <IconPower size={14} /> : <IconDownload size={14} />}
                  </span>
                )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
