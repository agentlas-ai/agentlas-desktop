"use client";

// One's mail settings, shown inside the One edit places (edit dialog and the
// profile sheet). Only what the server reports is shown: a field the server
// does not return (older server) is hidden rather than faked.
// PLAN-2: the native address is chosen once at creation and is permanent —
// there is no "change address" here; only a verified custom domain (My domain
// section) can change it. Directory listing is opt-in, off by default.
import { useEffect, useState } from "react";
import { IconCopy, IconLock } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { mailErrorText } from "./mailErrorText";
import { tFor, type Locale } from "@/lib/i18n";
import {
  AGENT_MAIL_INBOUND_MODES,
  type AgentMailEntitlement,
  type AgentMailInboundMode,
  type AgentMailLimits,
  type AgentMailMailbox,
  type AgentMailMailboxPatch,
} from "@shared/agent-mail";
import { mail2 } from "./mailCopy";
import { OneMailIdentityPicker } from "./OneMailIdentityPicker";
import { OneMailDirectoryCard } from "./OneMailDirectoryCard";
import { OneMailDomainSettings } from "./OneMailDomainSettings";
import styles from "./OneMail.module.css";

/** Main runs "reply" as "draft" while the plan cannot send (sync.ts effectiveInboundMode). */
const REPLY_DOWNGRADED: Record<Locale, string> = {
  ko: "지금 요금제로는 메일을 보낼 수 없어서, 보내는 대신 답장 초안만 남겨요.",
  en: "Your current plan can't send mail, so One saves reply drafts instead of sending.",
};

const MODE_KEYS = {
  notify: ["one.mail.settings.mode.notify", "one.mail.settings.mode.notify_desc"],
  draft: ["one.mail.settings.mode.draft", "one.mail.settings.mode.draft_desc"],
  reply: ["one.mail.settings.mode.reply", "one.mail.settings.mode.reply_desc"],
} as const satisfies Record<AgentMailInboundMode, readonly [string, string]>;

export function OneMailSettings({
  locale,
  oneName,
  onOpenMailbox,
  onChanged,
  tab,
}: {
  locale: Locale;
  oneName: string;
  /** Which settings tab this renders (One edit / Settings page tabs). Default: mail. */
  tab?: "mail" | "directory" | "domain";
  onOpenMailbox?: () => void;
  /** Told after the server accepted a change (address created, settings saved). */
  onChanged?: () => void;
}) {
  const api = ipc()?.agentMail;
  const copy = mail2(locale);
  const [loaded, setLoaded] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [entitlement, setEntitlement] = useState<AgentMailEntitlement | null>(null);
  const [mailbox, setMailbox] = useState<AgentMailMailbox | null>(null);
  const [limits, setLimits] = useState<AgentMailLimits | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [signature, setSignature] = useState("");
  const [inboundMode, setInboundMode] = useState<AgentMailInboundMode>("notify");
  const [copied, setCopied] = useState(false);

  const adopt = (next: AgentMailMailbox | null) => {
    setMailbox(next);
    setDisplayName(next?.displayName ?? "");
    setSignature(next?.signature ?? "");
    setInboundMode(next?.inboundMode ?? "notify");
  };

  const reload = async () => {
    if (!api) return;
    const status = await api.status().catch(() => null);
    setLoaded(true);
    if (!status) return;
    if (!status.ok) { setNotice({ text: mailErrorText(locale, status), error: true }); return; }
    setSignedIn(status.signedIn);
    setEntitlement(status.entitlement);
    setLimits(status.limits ?? null);
    adopt(status.mailbox);
  };

  useEffect(() => {
    if (!api) { setLoaded(true); return; }
    void reload();
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!api || !loaded) return null;

  const patch = async (value: AgentMailMailboxPatch, quiet = false) => {
    setBusy(true);
    setNotice(null);
    const res = await api.updateMailbox(value);
    setBusy(false);
    if (!res.ok) { setNotice({ text: mailErrorText(locale, res), error: true }); return false; }
    adopt(res.mailbox);
    if (res.entitlement) setEntitlement(res.entitlement);
    if (!quiet) setNotice({ text: tFor(locale, "one.mail.settings.saved"), error: false });
    onChanged?.();
    return true;
  };

  const save = () => {
    if (!mailbox) return;
    const value: AgentMailMailboxPatch = {};
    if (mailbox.displayName !== undefined && (mailbox.displayName ?? "") !== displayName) value.displayName = displayName.trim() || null;
    if (mailbox.signature !== undefined && (mailbox.signature ?? "") !== signature) value.signature = signature.trim() ? signature : null;
    if (mailbox.inboundMode !== undefined && mailbox.inboundMode !== inboundMode) value.inboundMode = inboundMode;
    if (Object.keys(value).length) void patch(value);
  };

  const copyAddress = (address: string) => {
    void navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };

  const created = (next: AgentMailMailbox) => {
    adopt(next);
    void reload();
    onChanged?.();
  };

  const active = mailbox?.status === "active";
  const customDomain = mailbox?.identityKind === "custom_domain";
  const hasSettings = active && (mailbox.displayName !== undefined || mailbox.signature !== undefined || mailbox.inboundMode !== undefined);
  const dirty = Boolean(mailbox) && (
    (mailbox!.displayName !== undefined && (mailbox!.displayName ?? "") !== displayName)
    || (mailbox!.signature !== undefined && (mailbox!.signature ?? "") !== signature)
    || (mailbox!.inboundMode !== undefined && mailbox!.inboundMode !== inboundMode));
  const usage = entitlement && entitlement.monthlyRecipientLimit > 0
    ? tFor(locale, "one.mail.settings.usage", {
        used: entitlement.usedThisMonth.toLocaleString(),
        limit: entitlement.monthlyRecipientLimit.toLocaleString(),
        reset: new Date(entitlement.period.end).toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      })
    : null;
  const entitled = Boolean(entitlement && entitlement.addressLimit > 0);
  const aliasCount = mailbox?.aliases?.length ?? 0;

  const notReady = !signedIn
    ? <p className={styles.hint}>{tFor(locale, "one.mail.settings.no_sign_in")}</p>
    : !entitled
      ? <p className={styles.hint}>{tFor(locale, "one.mail.settings.no_plan")}</p>
      : null;
  const heading = (title: string, desc: string) => (
    <header className={styles.panelHead}>
      <strong>{title}</strong>
      <p>{desc}</p>
    </header>
  );
  const noticeLine = notice && <p className={notice.error ? styles.error : styles.hint} role={notice.error ? "alert" : "status"}>{notice.text}</p>;

  if (tab === "directory") {
    return (
      <div className={styles.settings} data-one-mail-settings="directory">
        {heading(copy.section.directory, copy.directoryDesc)}
        {notReady ?? (active && mailbox
          ? <OneMailDirectoryCard locale={locale} oneName={oneName} limits={limits} mailbox={mailbox} />
          : <p className={styles.hint}>{copy.needAddressFirst}</p>)}
        {noticeLine}
      </div>
    );
  }

  if (tab === "domain") {
    return (
      <div className={styles.settings} data-one-mail-settings="domain">
        {heading(copy.section.domain, copy.domainIntro)}
        {notReady ?? <OneMailDomainSettings locale={locale} oneName={oneName} limits={limits} mailbox={mailbox} onMailboxChanged={created} />}
        {noticeLine}
      </div>
    );
  }

  return (
    <div className={styles.settings} data-one-mail-settings="mail">
      {tab && heading(copy.section.mail, copy.mailDesc)}
      {!signedIn ? (
        <p className={styles.hint}>{tFor(locale, "one.mail.settings.no_sign_in")}</p>
      ) : !entitled ? (
        <p className={styles.hint}>{tFor(locale, "one.mail.settings.no_plan")}</p>
      ) : !mailbox || !active ? (
        <OneMailIdentityPicker locale={locale} oneName={oneName} limits={limits} onCreated={created} />
      ) : (
        <>
          <div className={styles.settingsRow}>
            <span>{tFor(locale, "one.mail.settings.address")}</span>
            <div className={styles.addressLine}>
              <code data-one-mail-address>{mailbox.address}</code>
              <span className={styles.lockChip} data-one-mail-locked={customDomain ? "domain" : "native"}>
                <IconLock size={11} aria-hidden="true" />{customDomain ? copy.domainAddressChip : copy.lockedChip}
              </span>
              <button type="button" className={styles.ghostButton} onClick={() => copyAddress(mailbox.address)}>
                <IconCopy size={12} aria-hidden="true" />{copied ? tFor(locale, "one.mail.copied") : tFor(locale, "one.mail.copy")}
              </button>
            </div>
            <p className={styles.hint}>{customDomain ? copy.domainAddressHint : copy.lockedHint}</p>
            {aliasCount > 0 && <p className={styles.hint}>{copy.aliasesHint(aliasCount)}</p>}
          </div>
          {mailbox.displayName !== undefined && (
            <label className={styles.settingsRow}>
              <span>{tFor(locale, "one.mail.settings.sender")}</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={limits?.displayNameMaxChars ?? 64} placeholder={oneName} />
              <p className={styles.hint}>{tFor(locale, "one.mail.settings.sender_hint")}</p>
            </label>
          )}
          {mailbox.signature !== undefined && (
            <label className={styles.settingsRow}>
              <span>{tFor(locale, "one.mail.settings.signature")}</span>
              <textarea value={signature} onChange={(event) => setSignature(event.target.value)} maxLength={limits?.signatureMaxChars ?? 2000} rows={3} />
            </label>
          )}
          {mailbox.inboundMode !== undefined && (
            <fieldset className={styles.settingsRow} style={{ border: 0, margin: 0 }}>
              <legend style={{ float: "left", width: "100%", padding: 0, marginBottom: 6 }}>{tFor(locale, "one.mail.settings.inbound")}</legend>
              <div className={styles.modes} role="radiogroup">
                {AGENT_MAIL_INBOUND_MODES.map((mode) => (
                  <label key={mode} className={styles.mode} data-selected={inboundMode === mode ? "true" : "false"}>
                    <input type="radio" name="one-mail-inbound-mode" value={mode} checked={inboundMode === mode} onChange={() => setInboundMode(mode)} />
                    <span>
                      {tFor(locale, MODE_KEYS[mode][0])}
                      <small>{tFor(locale, MODE_KEYS[mode][1])}</small>
                    </span>
                  </label>
                ))}
              </div>
              {inboundMode === "reply" && entitlement && !entitlement.mailbox.send && (
                <p className={styles.error} role="status" data-one-mail-reply-downgraded>{REPLY_DOWNGRADED[locale]}</p>
              )}
              <p className={styles.hint}>{tFor(locale, "one.mail.settings.desktop_only")}</p>
            </fieldset>
          )}
          {typeof mailbox.autoSaveContacts === "boolean" && (
            <label className={styles.toggleRow} data-one-mail-autosave>
              <input
                type="checkbox"
                checked={mailbox.autoSaveContacts}
                disabled={busy}
                onChange={(event) => void patch({ autoSaveContacts: event.target.checked })}
              />
              <span>
                {copy.autoSave}
                <small>{copy.autoSaveHint}</small>
              </span>
            </label>
          )}
          {usage ? <p className={styles.hint}>{usage}</p> : <p className={styles.hint}>{tFor(locale, "one.mail.compose.no_send_plan")}</p>}
          <div className={styles.stickyActions}>
            {hasSettings && <button type="button" className={styles.blockPrimary} disabled={busy || !dirty} onClick={save} data-one-mail-save>{tFor(locale, "one.mail.settings.save")}</button>}
            {onOpenMailbox && <button type="button" className={styles.blockSecondary} onClick={onOpenMailbox}>{tFor(locale, "one.mail.settings.open_mailbox")}</button>}
          </div>
        </>
      )}
      {noticeLine}
    </div>
  );
}
