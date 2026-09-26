"use client";

// Agent mail — summary only. The mailbox itself (read, reply, drafts, search)
// lives in One (rail "Mail" tab) so there is one list, not two; address and
// mail settings are edited in One's edit window. Every number comes from the
// web server's entitlement.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { tFor, type Locale } from "@/lib/i18n";
import type { AgentMailEntitlement, AgentMailMailbox } from "@shared/agent-mail";
import { OneMailSettings } from "@/components/one/mail/OneMailSettings";
import { mailErrorText } from "@/components/one/mail/mailErrorText";
import { useOnePersonaName } from "@/lib/one-persona-name";
import styles from "./AgentMailPanel.module.css";

/** Same key OneShell reads for the rail tab it opens on. */
const ONE_RAIL_MODE_KEY = "agentlas.one.railMode";

export function AgentMailPanel({ locale }: { locale: string }) {
  const lang: Locale = locale === "ko" ? "ko" : "en";
  const router = useRouter();
  const api = ipc()?.agentMail;
  const [loaded, setLoaded] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [entitlement, setEntitlement] = useState<AgentMailEntitlement | null>(null);
  const [mailbox, setMailbox] = useState<AgentMailMailbox | null>(null);
  const [error, setError] = useState<{ code: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const oneName = useOnePersonaName();

  const refresh = useCallback(async () => {
    if (!api) return;
    const status = await api.status();
    setLoaded(true);
    if (!status.ok) { setError(status); return; }
    setSignedIn(status.signedIn);
    setEntitlement(status.entitlement);
    setMailbox(status.mailbox);
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const usage = useMemo(() => {
    if (!entitlement || entitlement.monthlyRecipientLimit <= 0) return null;
    const pct = Math.min(100, Math.round((entitlement.usedThisMonth / entitlement.monthlyRecipientLimit) * 100));
    const reset = new Date(entitlement.period.end).toLocaleDateString(lang === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    return { pct, text: tFor(lang, "one.mail.settings.usage", { used: entitlement.usedThisMonth.toLocaleString(), limit: entitlement.monthlyRecipientLimit.toLocaleString(), reset }) };
  }, [entitlement, lang]);

  const openOneMailbox = () => {
    try { window.localStorage.setItem(ONE_RAIL_MODE_KEY, "mail"); } catch { /* One still opens */ }
    router.push("/one");
  };

  if (!api || !loaded) return null;
  const active = mailbox?.status === "active";

  return (
    <section className={styles.panel} aria-labelledby="agent-mail-title">
      <h2 id="agent-mail-title" className={styles.title}>{tFor(lang, "one.mail.settings.title")}</h2>
      <div className={styles.card}>
        {!signedIn ? (
          <p className={styles.muted}>{tFor(lang, "one.mail.settings.no_sign_in")}</p>
        ) : !entitlement || entitlement.addressLimit <= 0 ? (
          <p className={styles.muted}>{tFor(lang, "one.mail.settings.no_plan")}</p>
        ) : !mailbox ? (
          // No address yet: the same "create address" control as One's edit window.
          <OneMailSettings locale={lang} oneName={oneName} />
        ) : (
          <>
            {mailbox && (
              <div className={styles.row}>
                <span className={styles.address} title={mailbox.address}>{mailbox.address}</span>
                <button type="button" className={styles.ghost} onClick={() => void navigator.clipboard?.writeText(mailbox.address).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>
                  {copied ? tFor(lang, "one.mail.copied") : tFor(lang, "one.mail.copy")}
                </button>
              </div>
            )}
            {mailbox && !active && <p className={styles.muted}>{tFor(lang, "one.mail.settings.not_ready")}</p>}
            {usage ? (
              <div>
                <div className={styles.meter} role="progressbar" aria-valuenow={usage.pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className={styles.meterFill} style={{ width: `${usage.pct}%` }} />
                </div>
                <p className={styles.muted}>{usage.text}</p>
              </div>
            ) : mailbox ? (
              <p className={styles.muted}>{tFor(lang, "one.mail.compose.no_send_plan")}</p>
            ) : null}
            <p className={styles.muted}>{tFor(lang, "one.mail.settings.moved")}</p>
            <div className={styles.row}>
              <button type="button" className={styles.button} onClick={openOneMailbox} data-agent-mail-open-one>
                {tFor(lang, "one.mail.settings.open_mailbox")}
              </button>
            </div>
          </>
        )}
        {error ? <p className={styles.error} role="alert">{mailErrorText(lang, error)}</p> : null}
      </div>
    </section>
  );
}
