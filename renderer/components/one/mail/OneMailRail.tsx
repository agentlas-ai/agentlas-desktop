"use client";

// One rail while the Mail tab is open: a mini mailbox nav (account, Compose,
// folders with counts). The list itself lives in the centre (OneMailWorkspace).
// The account block is a slot: today it holds One's own Agentlas address; a
// connected external account would be a second entry here.
import type { ReactNode } from "react";
import { IconArchive, IconClock, IconFileText, IconInbox, IconPlus, IconSend } from "@/components/Icon";
import { tFor, type Locale } from "@/lib/i18n";
import { ONE_MAIL_VIEWS, type OneMailState, type OneMailView } from "./useOneMail";
import styles from "./OneMail.module.css";

export const ONE_MAIL_VIEW_KEYS = {
  inbox: "one.mail.view.inbox",
  waiting: "one.mail.view.waiting",
  sent: "one.mail.view.sent",
  drafts: "one.mail.view.drafts",
  archived: "one.mail.view.archived",
} as const satisfies Record<OneMailView, string>;

const VIEW_ICONS: Record<OneMailView, ReactNode> = {
  inbox: <IconInbox size={15} />,
  waiting: <IconClock size={15} />,
  sent: <IconSend size={15} />,
  drafts: <IconFileText size={15} />,
  archived: <IconArchive size={15} />,
};

export function oneMailTime(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString(locale === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", {
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
    month: "short",
    day: "numeric",
  });
}

export function OneMailRail({ mail, locale }: { mail: OneMailState; locale: Locale }) {
  const address = mail.mailbox?.status === "active" ? mail.mailbox.address : null;
  const canSend = Boolean(mail.entitlement?.mailbox.send);
  const counts: Partial<Record<OneMailView, number | null>> = {
    inbox: mail.unread?.inbox ?? null,
    drafts: mail.draftCount,
  };
  // An older server has no thread views beyond inbox/sent.
  const views = mail.legacy ? ONE_MAIL_VIEWS.filter((view) => view === "inbox" || view === "sent") : ONE_MAIL_VIEWS;

  return (
    <nav className={styles.nav} aria-label={tFor(locale, "one.mail.nav_aria")} data-one-mail-rail>
      <div className={styles.account} aria-label={tFor(locale, "one.mail.account_aria")} data-one-mail-account="agentlas">
        <span className={styles.accountMark} aria-hidden="true">@</span>
        <span className={styles.accountAddress} title={address ?? undefined}>{address ?? tFor(locale, "one.mail.tab_disabled_aria")}</span>
      </div>
      {address && canSend && (
        <button type="button" className={styles.composeButton} onClick={() => mail.openCompose()} data-one-mail-compose-button>
          <IconPlus size={15} aria-hidden="true" />{tFor(locale, "one.mail.compose")}
        </button>
      )}
      {address && (
        <ul className={styles.navList}>
          {views.map((view) => {
            const count = counts[view];
            const active = mail.view === view && !mail.query.trim();
            return (
              <li key={view}>
                <button
                  type="button"
                  className={styles.navItem}
                  data-active={active ? "true" : "false"}
                  aria-current={active ? "page" : undefined}
                  data-one-mail-nav={view}
                  onClick={() => { mail.setQuery(""); mail.setView(view); }}
                >
                  <span className={styles.navIcon} aria-hidden="true">{VIEW_ICONS[view]}</span>
                  <span className={styles.navLabel}>{tFor(locale, ONE_MAIL_VIEW_KEYS[view])}</span>
                  {typeof count === "number" && count > 0 && <span className={styles.navCount} data-strong={view === "inbox" ? "true" : undefined}>{count > 999 ? "999+" : count}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
