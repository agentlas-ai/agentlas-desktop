"use client";

// PLAN-2 P2.6: My domain (SES domain identity + MX). The only path where the
// mail address may change. Records come from the server (SES tokens); nothing
// is hardcoded here. Status is re-read after the server's pollAfterMs.
import { useEffect, useRef, useState } from "react";
import { IconCopy, IconRefresh, IconTrash } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import type { Locale } from "@/lib/i18n";
import type { AgentMailDomain, AgentMailLimits, AgentMailMailbox } from "@shared/agent-mail";
import { mailErrorText } from "./mailErrorText";
import { mail2 } from "./mailCopy";
import styles from "./OneMail.module.css";

export function OneMailDomainSettings({
  locale,
  oneName,
  limits,
  mailbox,
  onMailboxChanged,
}: {
  locale: Locale;
  oneName: string;
  limits: AgentMailLimits | null;
  mailbox: AgentMailMailbox | null;
  onMailboxChanged: (mailbox: AgentMailMailbox) => void;
}) {
  const api = ipc()?.agentMail;
  const copy = mail2(locale);
  const [domains, setDomains] = useState<AgentMailDomain[] | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    if (!api?.domains) return;
    let alive = true;
    void api.domains().then((res) => {
      if (!alive) return;
      if (res.ok) setDomains(res.domains);
      else { setDomains([]); setNotice({ text: mailErrorText(locale, res), error: true }); }
    }).catch(() => setDomains([]));
    return () => { alive = false; };
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!api?.domains || domains === null) return null;

  const replace = (next: AgentMailDomain) => setDomains((prev) => {
    const list = prev ?? [];
    return list.some((item) => item.id === next.id) ? list.map((item) => (item.id === next.id ? next : item)) : [...list, next];
  });

  const add = async () => {
    const domain = input.trim().toLowerCase();
    if (!domain || busy) return;
    setBusy(true);
    setNotice(null);
    const res = await api.addDomain(domain);
    setBusy(false);
    if (!res.ok) { setNotice({ text: mailErrorText(locale, res), error: true }); return; }
    replace(res.domain);
    setInput("");
  };

  const max = limits?.domainsPerWorkspaceMax ?? null;
  const canAdd = max === null || domains.length < max;

  return (
    <div className={styles.settings} data-one-mail-domains>
      {domains.length === 0 && <p className={styles.hint}>{copy.domainNoneYet}</p>}
      {domains.map((domain) => (
        <DomainCard
          key={domain.id}
          domain={domain}
          locale={locale}
          oneName={oneName}
          mailbox={mailbox}
          limits={limits}
          onChange={replace}
          onRemoved={() => setDomains((prev) => (prev ?? []).filter((item) => item.id !== domain.id))}
          onMailboxChanged={onMailboxChanged}
        />
      ))}
      {canAdd && (
        <div className={styles.settingsRow}>
          <span>{copy.domainInput}</span>
          <div className={styles.pickRow}>
            <input
              value={input}
              placeholder="agent.example.com"
              autoComplete="off"
              spellCheck={false}
              maxLength={253}
              onChange={(event) => setInput(event.target.value.replace(/\s+/g, ""))}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void add(); } }}
              data-one-mail-domain-input
            />
            <button type="button" className={styles.secondary} disabled={busy || !input.trim()} onClick={() => void add()} data-one-mail-domain-add>
              {busy ? copy.domainAdding : copy.domainAdd}
            </button>
          </div>
          <p className={styles.hint}>{copy.domainSubdomain}</p>
        </div>
      )}
      {notice && <p className={notice.error ? styles.error : styles.hint} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
    </div>
  );
}

function DomainCard({
  domain,
  locale,
  oneName,
  mailbox,
  limits,
  onChange,
  onRemoved,
  onMailboxChanged,
}: {
  domain: AgentMailDomain;
  locale: Locale;
  oneName: string;
  mailbox: AgentMailMailbox | null;
  limits: AgentMailLimits | null;
  onChange: (domain: AgentMailDomain) => void;
  onRemoved: () => void;
  onMailboxChanged: (mailbox: AgentMailMailbox) => void;
}) {
  const api = ipc()?.agentMail;
  const copy = mail2(locale);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [localPart, setLocalPart] = useState("");
  const [changing, setChanging] = useState(false);
  // Records stay open until they were copied once; after that they fold behind "Show records".
  const copiedFlag = `agentlas.oneMail.domainRecordsCopied.${domain.id}`;
  const [showRecords, setShowRecords] = useState(() => {
    try { return window.localStorage.getItem(copiedFlag) !== "1"; } catch { return true; }
  });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // Follow the server's poll hint while verification is pending.
  useEffect(() => {
    if (!api || domain.pollAfterMs === null || domain.pollAfterMs === undefined) return;
    const timer = window.setTimeout(() => {
      void api.domain({ id: domain.id }).then((res) => {
        if (alive.current && res.ok) onChange(res.domain);
      }).catch(() => undefined);
    }, Math.max(domain.pollAfterMs, 1_000));
    return () => window.clearTimeout(timer);
  }, [api, domain.id, domain.pollAfterMs, domain.nextCheckAt, domain.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!api) return null;

  const run = async <T,>(task: () => Promise<({ ok: true } & T) | { ok: false; code: string }>, then: (value: T) => void) => {
    setBusy(true);
    setNotice(null);
    const res = await task().catch(() => ({ ok: false as const, code: "network" }));
    if (!alive.current) return;
    setBusy(false);
    if (!res.ok) { setNotice({ text: mailErrorText(locale, res), error: true }); return; }
    then(res as unknown as T);
  };

  const copyValue = (key: string, value: string) => {
    try { window.localStorage.setItem(copiedFlag, "1"); } catch { /* best effort */ }
    void navigator.clipboard?.writeText(value).then(() => {
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1500);
    }).catch(() => undefined);
  };

  const onThisDomain = Boolean(mailbox?.address && mailbox.address.toLowerCase().endsWith(`@${domain.domain.toLowerCase()}`));
  const verified = domain.status === "verified";
  const deadline = domain.dkimDeadline ? new Date(domain.dkimDeadline).toLocaleString(locale === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  const rule = limits?.localPart;
  let pattern: RegExp | null = null;
  try { pattern = rule?.pattern ? new RegExp(rule.pattern) : null; } catch { pattern = null; }
  const clean = localPart.trim().toLowerCase();
  const localOk = Boolean(clean) && (!pattern || pattern.test(clean)) && (!rule || (clean.length >= rule.minLength && clean.length <= rule.maxLength));

  return (
    <section className={styles.domainCard} data-one-mail-domain={domain.domain} data-status={domain.status}>
      <header className={styles.domainHead}>
        <code>{domain.domain}</code>
        <span className={styles.domainStatus} data-status={domain.status}>{copy.domainStatus[domain.status] ?? domain.status}</span>
        {onThisDomain && <span className={styles.lockChip}>{copy.domainCurrent}</span>}
        <span className={styles.toolbarSpacer} />
        {!verified && (
          <button type="button" className={styles.ghostButton} disabled={busy} onClick={() => void run<{ domain: AgentMailDomain }>(() => api.domain({ id: domain.id, check: true }), (value) => onChange(value.domain))}>
            <IconRefresh size={12} aria-hidden="true" />{copy.domainCheckNow}
          </button>
        )}
        {!onThisDomain && (
          <button
            type="button"
            className={styles.ghostButton}
            disabled={busy}
            onClick={() => { if (window.confirm(copy.domainRemoveConfirm)) void run<{ deleted: true }>(() => api.removeDomain(domain.id), () => onRemoved()); }}
            aria-label={copy.domainRemove}
            title={copy.domainRemove}
          >
            <IconTrash size={12} aria-hidden="true" />
          </button>
        )}
      </header>
      {/* Refusals (delete / check / restart / address) show right under the header, where the owner just clicked. */}
      {notice && <p className={notice.error ? styles.cardAlert : styles.cardStatus} role={notice.error ? "alert" : "status"} data-one-mail-domain-notice={notice.error ? "error" : "ok"}>{notice.text}</p>}
      {domain.warnings.map((warning) => (
        <p key={warning} className={styles.warn} role="status" data-one-mail-domain-warning={warning}>{copy.domainWarning[warning] ?? warning}</p>
      ))}
      {domain.status === "pending" && deadline && <p className={styles.hint}>{copy.domainPendingHint(deadline)}</p>}
      {domain.status === "failed" && (
        <p className={styles.hint}>
          {copy.domainFailedHint}{" "}
          <button type="button" className={styles.ghostButton} disabled={busy} onClick={() => void run<{ domain: AgentMailDomain }>(() => api.restartDomain(domain.id), (value) => onChange(value.domain))}>{copy.domainRestart}</button>
        </p>
      )}
      {domain.status === "unverified" && <p className={styles.hint}>{copy.domainUnverifiedHint}</p>}
      {!verified && (
        <>
          {showRecords ? (
            <>
              <p className={styles.hint}>{copy.domainRecordsHint}</p>
              <ul className={styles.recordList} aria-label={copy.domainRecords}>
                {domain.records.map((record, index) => {
                  const key = `${index}`;
                  return (
                    <li key={key} className={styles.recordCard} data-purpose={record.purpose}>
                      <div className={styles.recordTop}>
                        <span className={styles.recordType}>{record.type}</span>
                        <span className={styles.recordPurpose}>{copy.domainPurpose[record.purpose] ?? record.purpose}</span>
                        <span className={styles.recordTag} data-required={record.required ? "true" : "false"}>{record.required ? copy.domainRequired : copy.domainOptional}</span>
                      </div>
                      <div className={styles.recordField}>
                        <span>{copy.domainHost}</span>
                        <code title={record.host}>{record.host}</code>
                        <button type="button" className={styles.copyButton} onClick={() => copyValue(`${key}h`, record.host)} aria-label={`${copy.domainCopy} ${copy.domainHost}`}>
                          <IconCopy size={11} aria-hidden="true" />{copiedKey === `${key}h` ? copy.domainCopied : copy.domainCopy}
                        </button>
                      </div>
                      <div className={styles.recordField}>
                        <span>{copy.domainValue}</span>
                        <code title={record.value}>{record.value}</code>
                        <button type="button" className={styles.copyButton} onClick={() => copyValue(`${key}v`, record.value)} aria-label={`${copy.domainCopy} ${copy.domainValue}`} data-one-mail-copy-record>
                          <IconCopy size={11} aria-hidden="true" />{copiedKey === `${key}v` ? copy.domainCopied : copy.domainCopy}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <button type="button" className={styles.ghostButton} onClick={() => setShowRecords(false)} data-one-mail-records-toggle>{copy.recordsHide}</button>
            </>
          ) : (
            <button type="button" className={styles.blockSecondary} onClick={() => setShowRecords(true)} data-one-mail-records-toggle>{copy.recordsShow(domain.records.length)}</button>
          )}
          <p className={styles.hint}>{domain.mx.found.length ? copy.domainMx(domain.mx.found.join(", ")) : copy.domainMxNone}</p>
        </>
      )}
      {verified && (!onThisDomain || changing) && (
        <div className={styles.settingsRow}>
          <span>{copy.domainPickAddress}</span>
          <div className={styles.pickRow}>
            <input value={localPart} onChange={(event) => setLocalPart(event.target.value.replace(/\s+/g, "").toLowerCase())} maxLength={rule?.maxLength ?? 64} autoComplete="off" spellCheck={false} />
            <span>@{domain.domain}</span>
            <button
              type="button"
              className={styles.primary}
              disabled={busy || !localOk}
              onClick={() => void run<{ mailbox: AgentMailMailbox }>(
                () => api.setDomainAddress({ id: domain.id, localPart: clean, displayName: mailbox?.displayName ?? oneName }),
                (value) => { setChanging(false); setLocalPart(""); setNotice({ text: copy.domainAddressSet, error: false }); onMailboxChanged(value.mailbox); },
              )}
            >
              {copy.domainUseAddress}
            </button>
          </div>
        </div>
      )}
      {verified && onThisDomain && !changing && (
        <div className={styles.formActions}>
          <button type="button" className={styles.secondary} onClick={() => setChanging(true)}>{copy.domainChangeAddress}</button>
        </div>
      )}
    </section>
  );
}
