"use client";

// Top underline tabs for One's settings (owner design 2026-09-26): each concern
// on its own tab instead of one long scroll — profile · mail · directory · domain.
import { useState, type KeyboardEvent } from "react";
import type { Locale } from "@/lib/i18n";
import { OneMailSettings } from "./OneMailSettings";
import styles from "./OneMail.module.css";

export type OneEditTab = "profile" | "mail" | "directory" | "domain";
export type OneMailTab = Exclude<OneEditTab, "profile">;

const LABELS: Record<Locale, Record<OneEditTab, string>> = {
  ko: { profile: "프로필", mail: "메일", directory: "디렉터리", domain: "내 도메인" },
  en: { profile: "Profile", mail: "Mail", directory: "Directory", domain: "My domain" },
};

function Tabs<T extends OneEditTab>({ locale, items, value, onChange, label }: {
  locale: Locale;
  items: readonly T[];
  value: T;
  onChange: (tab: T) => void;
  label: string;
}) {
  // Roving tabindex (WAI-ARIA tabs): one Tab stop for the row, arrows/Home/End move
  // and select (QA 2026-09-27: arrows did nothing and Tab walked every tab).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.indexOf(value);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onChange(items[next]);
    const tabs = event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]");
    tabs[next]?.focus();
    // The profile panel mounts with an autoFocus field; keep focus on the tab row.
    requestAnimationFrame(() => tabs[next]?.focus());
  };
  return (
    <div className={styles.topTabs} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item) => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={value === item}
          tabIndex={value === item ? 0 : -1}
          data-active={value === item ? "true" : "false"}
          data-one-edit-tab={item}
          onClick={() => onChange(item)}
        >
          {LABELS[locale][item]}
        </button>
      ))}
    </div>
  );
}

const EDIT_TABS: readonly OneEditTab[] = ["profile", "mail", "directory", "domain"];
const MAIL_TABS: readonly OneMailTab[] = ["mail", "directory", "domain"];

export function OneEditTabs({ locale, value, onChange }: { locale: Locale; value: OneEditTab; onChange: (tab: OneEditTab) => void }) {
  return <Tabs locale={locale} items={EDIT_TABS} value={value} onChange={onChange} label={locale === "ko" ? "One 설정" : "One settings"} />;
}

/** Settings page: mail · directory · domain, each on its own tab. */
export function OneMailSettingsTabs({ locale, oneName, onOpenMailbox }: { locale: Locale; oneName: string; onOpenMailbox?: () => void }) {
  const [tab, setTab] = useState<OneMailTab>("mail");
  return (
    <div className={styles.tabbed}>
      <Tabs locale={locale} items={MAIL_TABS} value={tab} onChange={setTab} label={locale === "ko" ? "메일 설정" : "Mail settings"} />
      <div role="tabpanel">
        <OneMailSettings key={tab} locale={locale} oneName={oneName} tab={tab} onOpenMailbox={onOpenMailbox} />
      </div>
    </div>
  );
}
