"use client";

// One's mail settings, shown inside the One edit places (edit dialog and the
// profile sheet). Only what the server reports is shown: a field the server
// does not return (older server) is hidden rather than faked.
import { useEffect, useState } from "react";
import { IconCopy } from "@/components/Icon";
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
import styles from "./OneMail.module.css";

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
}: {
  locale: Locale;
  oneName: string;
  onOpenMailbox?: () => void;
  /** Told after the server accepted a change (address created, settings saved). */
  onChanged?: () => void;
}) {
  const api = ipc()?.agentMail;
  const [loaded, setLoaded] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [entitlement, setEntitlement] = useState<AgentMailEntitlement | null>(null);
  const [mailbox, setMailbox] = useState<AgentMailMailbox | null>(null);
  const [limits, setLimits] = useState<AgentMailLimits | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [localPart, setLocalPart] = useState("");
  const [check, setCheck] = useState<{ localPart: string; available: boolean; address: string } | null>(null);
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

  useEffect(() => {
    if (!api) { setLoaded(true); return; }
    let alive = true;
    void api.status().then((status) => {
      if (!alive) return;
      setLoaded(true);
      if (!status.ok) { setNotice({ text: mailErrorText(locale, status), error: true }); return; }
      setSignedIn(status.signedIn);
      setEntitlement(status.entitlement);
      setLimits(status.limits ?? null);
      adopt(status.mailbox);
    }).catch(() => setLoaded(true));
    return () => { alive = false; };
  }, [api]);

  if (!api || !loaded) return null;

  const pattern = limits?.localPart?.pattern ? new RegExp(limits.localPart.pattern) : null;
  const cleanLocal = localPart.trim().toLowerCase();
  const localValid = !cleanLocal || (!pattern || pattern.test(cleanLocal))
    && (!limits?.localPart || (cleanLocal.length >= limits.localPart.minLength && cleanLocal.length <= limits.localPart.maxLength));

  const issue = async () => {
    setBusy(true);
    setNotice(null);
    const res = await api.issue({ displayName: oneName, ...(cleanLocal ? { localPart: cleanLocal } : {}) });
    setBusy(false);
    if (!res.ok) { setNotice({ text: mailErrorText(locale, res), error: true }); return; }
    adopt(res.mailbox);
    if (res.entitlement) setEntitlement(res.entitlement);
    setLocalPart("");
    onChanged?.();
  };

  const runCheck = async () => {
    if (!cleanLocal) return;
    const res = await api.checkAddress(cleanLocal);
    if (!res.ok) { setNotice({ text: mailErrorText(locale, res), error: true }); return; }
    setCheck({ localPart: res.localPart, available: res.available, address: res.address });
  };

  const patch = async (value: AgentMailMailboxPatch) => {
    setBusy(true);
    setNotice(null);
    const res = await api.updateMailbox(value);
    setBusy(false);
    if (!res.ok) { setNotice({ text: mailErrorText(locale, res), error: true }); return false; }
    adopt(res.mailbox);
    if (res.entitlement) setEntitlement(res.entitlement);
    setNotice({ text: tFor(locale, "one.mail.settings.saved"), error: false });
    onChanged?.();
    return true;
  };

  const choose = async () => {
    if (!cleanLocal || !localValid) return;
    if (await patch({ localPart: cleanLocal })) { setLocalPart(""); setCheck(null); }
  };

  const save = () => {
    if (!mailbox) return;
    const value: AgentMailMailboxPatch = {};
    if (mailbox.displayName !== undefined && (mailbox.displayName ?? "") !== displayName) value.displayName = displayName.trim() || null;
    if (mailbox.signature !== undefined && (mailbox.signature ?? "") !== signature) value.signature = signature.trim() ? signature : null;
    if (mailbox.inboundMode !== undefined && mailbox.inboundMode !== inboundMode) value.inboundMode = inboundMode;
    if (Object.keys(value).length) void patch(value);
  };

  const copy = (address: string) => {
    void navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };

  const active = mailbox?.status === "active";
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
  const domain = mailbox?.address.split("@")[1] ?? entitlement?.address?.split("@")[1] ?? null;

  const picker = (onSubmit: () => void, submitLabel: string, requireLocal: boolean) => (
    <div className={styles.settingsRow}>
      <span>{tFor(locale, "one.mail.settings.pick_label")}</span>
      <div className={styles.pickRow}>
        <input
          value={localPart}
          onChange={(event) => { setLocalPart(event.target.value); setCheck(null); }}
          maxLength={limits?.localPart?.maxLength ?? 64}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!localValid}
          aria-describedby="one-mail-pick-once"
        />
        {domain && <span>@{domain}</span>}
        <button type="button" className={styles.secondary} disabled={busy || !cleanLocal || !localValid} onClick={() => void runCheck()}>{tFor(locale, "one.mail.settings.check")}</button>
      </div>
      {check && check.localPart === cleanLocal && (
        <p className={check.available ? `${styles.hint} ${styles.ok}` : styles.error} role="status">
          {check.available ? `${tFor(locale, "one.mail.settings.available")} · ${check.address}` : tFor(locale, "one.mail.settings.unavailable")}
        </p>
      )}
      <p id="one-mail-pick-once" className={styles.hint}>{tFor(locale, "one.mail.settings.pick_once")}</p>
      <div className={styles.formActions}>
        <button type="button" className={styles.primary} disabled={busy || !localValid || (requireLocal && !cleanLocal)} onClick={onSubmit}>{submitLabel}</button>
      </div>
    </div>
  );

  return (
    <div className={styles.settings} data-one-mail-settings>
      {!signedIn ? (
        <p className={styles.hint}>{tFor(locale, "one.mail.settings.no_sign_in")}</p>
      ) : !entitlement || entitlement.addressLimit <= 0 ? (
        <p className={styles.hint}>{tFor(locale, "one.mail.settings.no_plan")}</p>
      ) : !mailbox ? (
        <>
          <p className={styles.hint}>{tFor(locale, "one.mail.settings.pick_random")}</p>
          {picker(() => void issue(), busy ? tFor(locale, "one.mail.settings.creating") : tFor(locale, "one.mail.settings.get_address"), false)}
        </>
      ) : (
        <>
          <div className={styles.settingsRow}>
            <span>{tFor(locale, "one.mail.settings.address")}</span>
            <div className={styles.addressLine}>
              <code data-one-mail-address>{mailbox.address}</code>
              <button type="button" className={styles.ghostButton} onClick={() => copy(mailbox.address)}>
                <IconCopy size={12} aria-hidden="true" />{copied ? tFor(locale, "one.mail.copied") : tFor(locale, "one.mail.copy")}
              </button>
            </div>
            {mailbox.addressChosen && <p className={styles.hint}>{tFor(locale, "one.mail.settings.chosen")}</p>}
            {!active && (
              <p className={styles.hint}>
                {tFor(locale, "one.mail.settings.not_ready")}{" "}
                <button type="button" className={styles.ghostButton} disabled={busy} onClick={() => void issue()}>{tFor(locale, "one.mail.settings.retry")}</button>
              </p>
            )}
          </div>
          {active && mailbox.canChooseAddress && picker(() => void choose(), tFor(locale, "one.mail.settings.choose"), true)}
          {active && mailbox.displayName !== undefined && (
            <label className={styles.settingsRow}>
              <span>{tFor(locale, "one.mail.settings.sender")}</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={limits?.displayNameMaxChars ?? 64} placeholder={oneName} />
              <p className={styles.hint}>{tFor(locale, "one.mail.settings.sender_hint")}</p>
            </label>
          )}
          {active && mailbox.signature !== undefined && (
            <label className={styles.settingsRow}>
              <span>{tFor(locale, "one.mail.settings.signature")}</span>
              <textarea value={signature} onChange={(event) => setSignature(event.target.value)} maxLength={limits?.signatureMaxChars ?? 2000} rows={3} />
            </label>
          )}
          {active && mailbox.inboundMode !== undefined && (
            <fieldset className={styles.settingsRow} style={{ border: 0, margin: 0, padding: 0 }}>
              <legend style={{ padding: 0, marginBottom: 6 }}>{tFor(locale, "one.mail.settings.inbound")}</legend>
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
              <p className={styles.hint}>{tFor(locale, "one.mail.settings.desktop_only")}</p>
            </fieldset>
          )}
          {usage ? <p className={styles.hint}>{usage}</p> : active ? <p className={styles.hint}>{tFor(locale, "one.mail.compose.no_send_plan")}</p> : null}
          <div className={styles.formActions}>
            {onOpenMailbox && active && <button type="button" className={styles.secondary} onClick={onOpenMailbox}>{tFor(locale, "one.mail.settings.open_mailbox")}</button>}
            {hasSettings && <button type="button" className={styles.primary} disabled={busy || !dirty} onClick={save}>{tFor(locale, "one.mail.settings.save")}</button>}
          </div>
        </>
      )}
      {notice && <p className={notice.error ? styles.error : styles.hint} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
    </div>
  );
}
