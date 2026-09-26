"use client";

// PLAN-2 4.1/4.2: One's mail address is chosen when the mailbox is created and
// never changes (native Agentlas address). One component for first-run step 08
// and the One edit dialog. The server suggests addresses from One's name and
// judges availability; nothing here reserves or decides an address. No extra
// confirmation dialog (owner decision): the button itself says it is permanent.
import { useEffect, useRef, useState } from "react";
import { IconLock } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import type { Locale } from "@/lib/i18n";
import type { AgentMailLimits, AgentMailMailbox } from "@shared/agent-mail";
import { mailErrorText } from "./mailErrorText";
import { mail2 } from "./mailCopy";
import styles from "./OneMail.module.css";

/** Live availability check waits this long after the last keystroke. */
const CHECK_DEBOUNCE_MS = 350;

type Check =
  | { state: "idle" }
  | { state: "checking"; localPart: string }
  | { state: "done"; localPart: string; available: boolean; address: string; code: string | null; currentAddress: string | null };

export function OneMailIdentityPicker({
  locale,
  oneName,
  limits,
  onCreated,
  compact = false,
}: {
  locale: Locale;
  /** One's name (step 07 / edit dialog) — the server romanizes it for suggestions. */
  oneName: string;
  limits: AgentMailLimits | null;
  onCreated: (mailbox: AgentMailMailbox) => void;
  compact?: boolean;
}) {
  const api = ipc()?.agentMail;
  const copy = mail2(locale);
  const [localPart, setLocalPart] = useState("");
  const [touched, setTouched] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{ localPart: string; address: string }>>([]);
  const [domain, setDomain] = useState<string | null>(null);
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const [revive, setRevive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);

  // Server suggestions from One's name; the first one pre-fills the field until the owner types.
  useEffect(() => {
    if (!api?.suggestAddresses) return;
    let alive = true;
    void api.suggestAddresses(oneName || "").then((res) => {
      if (!alive || !res.ok) return;
      setSuggestions(res.suggestions);
      const first = res.suggestions[0];
      if (first) {
        setDomain((current) => current ?? first.address.split("@")[1] ?? null);
        setLocalPart((current) => (current || touched ? current : first.localPart));
      }
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [api, oneName]); // eslint-disable-line react-hooks/exhaustive-deps

  const clean = localPart.trim().toLowerCase();
  const rule = limits?.localPart;
  let pattern: RegExp | null = null;
  try { pattern = rule?.pattern ? new RegExp(rule.pattern) : null; } catch { pattern = null; }
  const formatOk = Boolean(clean)
    && (!pattern || pattern.test(clean))
    && (!rule || (clean.length >= rule.minLength && clean.length <= rule.maxLength))
    && !clean.includes("..");

  // Live availability (debounced). Only the last answer counts.
  useEffect(() => {
    if (!api || !clean || !formatOk) { setCheck({ state: "idle" }); return; }
    const mine = ++token.current;
    setCheck({ state: "checking", localPart: clean });
    const timer = window.setTimeout(() => {
      void api.checkAddress(clean).then((res) => {
        if (mine !== token.current) return;
        if (!res.ok) { setCheck({ state: "idle" }); setError(mailErrorText(locale, res)); return; }
        setError(null);
        if (res.address.includes("@")) setDomain(res.address.split("@")[1] ?? null);
        setCheck({ state: "done", localPart: res.localPart, available: res.available, address: res.address, code: res.code, currentAddress: res.currentAddress ?? null });
        if (res.code === "agent_mail_address_retired" && res.currentAddress) setRevive(res.currentAddress);
      }).catch(() => { if (mine === token.current) setCheck({ state: "idle" }); });
    }, CHECK_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [api, clean, formatOk, locale]);

  if (!api) return null;

  const available = check.state === "done" && check.localPart === clean && check.available;

  const create = async (withLocalPart: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.issue({ displayName: oneName || undefined, ...(withLocalPart ? { localPart: clean } : {}) });
      if (!res.ok) {
        if (res.code === "agent_mail_address_retired" && typeof res.detail?.address === "string") setRevive(res.detail.address);
        setError(mailErrorText(locale, res));
        return;
      }
      onCreated(res.mailbox);
    } catch (err) {
      setError(mailErrorText(locale, { code: err instanceof Error && err.name === "AbortError" ? "timeout" : "network" }));
    } finally {
      setBusy(false);
    }
  };

  if (revive) {
    return (
      <div className={styles.identity} data-one-mail-identity="revive">
        <strong className={styles.identityTitle}>{copy.revivedTitle}</strong>
        <p className={styles.hint}>{copy.revivedBody(revive)}</p>
        <div className={styles.identityPreview}><IconLock size={13} aria-hidden="true" /><code>{revive}</code></div>
        <div className={styles.formActions}>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void create(false)} data-one-mail-revive>
            {busy ? copy.addressCreating : copy.revivedAction}
          </button>
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>
    );
  }

  const reason = check.state === "done" && check.localPart === clean && !check.available
    ? (check.code && copy.addressReason[check.code]) || mailErrorText(locale, { code: check.code })
    : null;

  return (
    <div className={styles.identity} data-one-mail-identity="native" data-compact={compact ? "true" : undefined}>
      {!compact && <strong className={styles.identityTitle}>{copy.addressTitle}</strong>}
      <label className={styles.settingsRow}>
        <span>{copy.addressLabel}</span>
        <div className={styles.pickRow}>
          <input
            value={localPart}
            onChange={(event) => { setTouched(true); setLocalPart(event.target.value.replace(/\s+/g, "").toLowerCase()); }}
            maxLength={rule?.maxLength ?? 64}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(clean) && (!formatOk || Boolean(reason))}
            aria-describedby="one-mail-permanent"
            data-one-mail-local-part
          />
          {domain && <span>@{domain}</span>}
        </div>
      </label>
      {suggestions.length > 0 && (
        <div className={styles.suggestions} aria-label={copy.addressSuggestions}>
          <span>{copy.addressSuggestions}</span>
          {suggestions.map((item) => (
            <button
              key={item.localPart}
              type="button"
              className={styles.suggestion}
              data-selected={item.localPart === clean ? "true" : undefined}
              onClick={() => { setTouched(true); setLocalPart(item.localPart); }}
            >
              {item.localPart}
            </button>
          ))}
        </div>
      )}
      {clean && (
        <div className={styles.identityPreview} data-one-mail-preview>
          <IconLock size={13} aria-hidden="true" />
          <code>{clean}{domain ? `@${domain}` : ""}</code>
          {check.state === "checking" && <span className={styles.hint}>{copy.addressChecking}</span>}
          {available && <span className={`${styles.hint} ${styles.ok}`} role="status" data-one-mail-available>{copy.addressAvailable}</span>}
        </div>
      )}
      {clean && !formatOk && rule && <p className={styles.error} role="status">{copy.addressInvalid(rule.minLength, rule.maxLength)}</p>}
      {reason && <p className={styles.error} role="status" data-one-mail-unavailable>{reason}</p>}
      <p id="one-mail-permanent" className={styles.permanent}>{copy.addressPermanent}</p>
      <div className={styles.formActions}>
        <button type="button" className={styles.primary} disabled={busy || !available} onClick={() => void create(true)} data-one-mail-create>
          {busy ? copy.addressCreating : copy.addressCreate}
        </button>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}
