"use client";

// PLAN-2 4.3: contacts inside the One mail tab (Gmail-contacts-like). One list
// row per contact (most recent conversation first), a detail card with the
// owner's note (editable) and One's note (shown apart, read-only), the other
// agent's own description as plain text, and a directory search to find
// listed Agentlas agents. The "Agentlas agent" badge comes from the server only.
import { useEffect, useRef, useState } from "react";
import { IconArrowLeft, IconChevronLeft, IconChevronRight, IconMail, IconPlus, IconSearch, IconTrash, IconUsers } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { tFor, type Locale } from "@/lib/i18n";
import type { AgentMailAgentCard, AgentMailContact } from "@shared/agent-mail";
import { mailErrorText } from "./mailErrorText";
import { mail2 } from "./mailCopy";
import { oneMailTime } from "./OneMailRail";
import type { OneMailState } from "./useOneMail";
import styles from "./OneMail.module.css";

type Mode = { kind: "list" } | { kind: "detail"; id: string } | { kind: "add" } | { kind: "directory" };
type Notice = { text: string; error: boolean } | null;

export function AgentBadge({ locale, listed = false }: { locale: Locale; listed?: boolean }) {
  const copy = mail2(locale);
  return (
    <span className={styles.chipAgent} title={copy.agentBadgeTitle} data-one-mail-agent-badge>
      <span className={styles.agentDot} aria-hidden="true" />{copy.agentBadge}
      {listed && <span className={styles.agentListed}>· {copy.listedBadge}</span>}
    </span>
  );
}

export function OneMailContacts({ mail, locale }: { mail: OneMailState; locale: Locale }) {
  const api = ipc()?.agentMail;
  const copy = mail2(locale);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [contacts, setContacts] = useState<AgentMailContact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [stack, setStack] = useState<Array<string | null>>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [nonce, setNonce] = useState(0);
  const token = useRef(0);

  useEffect(() => {
    if (!api?.contacts) return;
    const mine = ++token.current;
    setLoading(true);
    void api.contacts({ q: applied || undefined, cursor }).then((res) => {
      if (mine !== token.current) return;
      setLoading(false);
      if (!res.ok) { setNotice({ text: mailErrorText(locale, res), error: true }); return; }
      setContacts(res.contacts);
      setNextCursor(res.nextCursor);
    }).catch(() => { if (mine === token.current) setLoading(false); });
  }, [api, applied, cursor, nonce, mail.contactsNonce, locale]);

  if (!api?.contacts) return null;

  const refresh = () => setNonce((n) => n + 1);
  const known = new Set(contacts.map((contact) => contact.address.toLowerCase()));

  if (mode.kind === "detail") {
    return (
      <ContactDetail
        id={mode.id}
        locale={locale}
        mail={mail}
        onBack={() => { setMode({ kind: "list" }); refresh(); }}
      />
    );
  }
  if (mode.kind === "add") {
    return <ContactAdd locale={locale} onBack={() => setMode({ kind: "list" })} onSaved={(contact) => { refresh(); setMode({ kind: "detail", id: contact.id }); }} />;
  }
  if (mode.kind === "directory") {
    return <DirectorySearch locale={locale} mail={mail} known={known} onBack={() => { setMode({ kind: "list" }); refresh(); }} />;
  }

  return (
    <div className={styles.listPane} data-one-mail-contacts>
      <form className={`${styles.searchBar} titlebar-nodrag`} role="search" onSubmit={(event) => { event.preventDefault(); setCursor(null); setStack([]); setApplied(query.trim()); }}>
        <IconSearch size={15} />
        <input
          type="search"
          value={query}
          placeholder={copy.contactsSearch}
          aria-label={copy.contactsSearch}
          onChange={(event) => { setQuery(event.target.value); if (!event.target.value) { setCursor(null); setStack([]); setApplied(""); } }}
          data-one-mail-contacts-search
        />
      </form>
      <div className={`${styles.toolbar} titlebar-nodrag`} role="toolbar" aria-label={copy.contacts}>
        <strong className={styles.toolbarTitle}>{copy.contacts}</strong>
        <button type="button" className={styles.secondary} onClick={() => setMode({ kind: "add" })} data-one-mail-contact-add>
          <IconPlus size={14} aria-hidden="true" />{copy.contactAdd}
        </button>
        <button type="button" className={styles.secondary} onClick={() => setMode({ kind: "directory" })} data-one-mail-directory-open>
          <IconUsers size={14} aria-hidden="true" />{copy.directory}
        </button>
        <span className={styles.toolbarSpacer} />
        <button type="button" className={styles.iconButton} disabled={!stack.length || loading} onClick={() => { const prev = stack[stack.length - 1] ?? null; setStack((s) => s.slice(0, -1)); setCursor(prev); }} aria-label={mailPrev(locale)} title={mailPrev(locale)}><IconChevronLeft size={15} /></button>
        <button type="button" className={styles.iconButton} disabled={!nextCursor || loading} onClick={() => { setStack((s) => [...s, cursor]); setCursor(nextCursor); }} aria-label={mailNext(locale)} title={mailNext(locale)}><IconChevronRight size={15} /></button>
      </div>
      {notice && <p className={notice.error ? styles.error : styles.notice} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
      <div className={styles.rows} role="list" aria-busy={loading} data-one-mail-contact-list>
        {contacts.length === 0 && !loading ? (
          <div className={styles.empty}>{applied ? copy.contactsEmptySearch : copy.contactsEmpty}</div>
        ) : contacts.map((contact) => (
          <div
            key={contact.id}
            role="listitem"
            tabIndex={0}
            className={styles.contactRow}
            data-one-mail-contact={contact.address}
            onClick={() => setMode({ kind: "detail", id: contact.id })}
            onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setMode({ kind: "detail", id: contact.id }); } }}
          >
            <span className={styles.contactAvatar} aria-hidden="true">{initial(contact)}</span>
            <span className={styles.contactMain}>
              <strong>{contact.displayName || contact.address}</strong>
              {contact.displayName && <small>{contact.address}</small>}
            </span>
            <span className={styles.contactBadges}>
              {contact.agentlasAgent && <AgentBadge locale={locale} listed={contact.agent?.listed === true} />}
              {contact.createdBy === "one" && <span className={styles.chipOne}>{copy.addedByOne}</span>}
            </span>
            <time className={styles.rowTime} dateTime={contact.lastInteractionAt ?? contact.updatedAt}>
              {contact.lastInteractionAt ? oneMailTime(contact.lastInteractionAt, locale) : ""}
            </time>
          </div>
        ))}
        {loading && contacts.length === 0 && <p className={styles.notice} role="status">{tFor(locale, "one.mail.loading")}</p>}
      </div>
    </div>
  );
}

function mailPrev(locale: Locale) { return tFor(locale, "one.mail.page_prev"); }
function mailNext(locale: Locale) { return tFor(locale, "one.mail.page_next"); }

function initial(contact: AgentMailContact): string {
  const source = (contact.displayName || contact.address).trim();
  return (Array.from(source)[0] ?? "?").toUpperCase();
}

function sourceLabel(contact: AgentMailContact, locale: Locale): string | null {
  const copy = mail2(locale);
  if (contact.createdBy === "one" || contact.source === "one") return copy.addedByOne;
  if (contact.source === "directory") return copy.fromDirectory;
  if (contact.source === "interaction") return copy.autoSaved;
  return null;
}

function ContactDetail({ id, locale, mail, onBack }: { id: string; locale: Locale; mail: OneMailState; onBack: () => void }) {
  const api = ipc()?.agentMail;
  const copy = mail2(locale);
  const [contact, setContact] = useState<AgentMailContact | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const adopt = (next: AgentMailContact) => {
    setContact(next);
    setName(next.displayName ?? "");
    setNote(next.ownerNote ?? "");
  };

  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api.contact(id).then((res) => {
      if (!alive) return;
      if (res.ok) adopt(res.contact);
      else setNotice({ text: mailErrorText(locale, res), error: true });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [api, id, mail.contactsNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!api) return null;

  const save = async () => {
    if (!contact) return;
    setBusy(true);
    setNotice(null);
    const res = await api.saveContact({
      id: contact.id,
      displayName: name.trim() || null,
      ownerNote: note.trim() || null,
      expectedVersion: contact.version,
    });
    setBusy(false);
    if (!res.ok) {
      if (res.code === "agent_mail_contact_version_conflict" && res.detail && typeof res.detail.contact === "object" && res.detail.contact) {
        adopt(res.detail.contact as AgentMailContact);
        setNotice({ text: copy.contactConflict, error: true });
        return;
      }
      setNotice({ text: mailErrorText(locale, res), error: true });
      return;
    }
    adopt(res.contact);
    setNotice({ text: copy.contactSaved, error: false });
  };

  const remove = async () => {
    if (!contact || !window.confirm(copy.contactDeleteConfirm)) return;
    const res = await api.removeContact(contact.id);
    if (!res.ok) { setNotice({ text: mailErrorText(locale, res), error: true }); return; }
    onBack();
  };

  const noteMax = mail.limits?.contactNoteMaxChars ?? 1000;
  const dirty = Boolean(contact) && ((contact!.displayName ?? "") !== name || (contact!.ownerNote ?? "") !== note);
  const card = contact?.agent?.card ?? null;
  const source = contact ? sourceLabel(contact, locale) : null;
  const canSend = Boolean(mail.entitlement?.mailbox.send);

  return (
    <div className={styles.contactDetail} data-one-mail-contact-detail>
      <div className={`${styles.toolbar} titlebar-nodrag`} role="toolbar">
        <button type="button" className={styles.iconButton} onClick={onBack} aria-label={copy.back} title={copy.back}><IconArrowLeft size={15} /></button>
        <span className={styles.toolbarSpacer} />
        {contact && canSend && (
          <button type="button" className={styles.secondary} onClick={() => mail.openCompose({ to: contact.address })} data-one-mail-contact-write>
            <IconMail size={14} aria-hidden="true" />{copy.writeMail}
          </button>
        )}
        {contact && <button type="button" className={styles.iconButton} onClick={() => void remove()} aria-label={copy.contactDelete} title={copy.contactDelete}><IconTrash size={15} /></button>}
      </div>
      {!contact ? (
        <p className={notice?.error ? styles.error : styles.centerState} role="status">{notice?.text ?? "…"}</p>
      ) : (
        <div className={styles.threadBody}>
          <div className={styles.threadColumn}>
            <header className={styles.contactHeader}>
              <span className={styles.contactAvatarLarge} aria-hidden="true">{initial(contact)}</span>
              <div>
                <h2 className={styles.threadSubject}>{contact.displayName || contact.address}</h2>
                <div className={styles.addressLine}><code>{contact.address}</code></div>
                <div className={styles.contactBadges}>
                  {contact.agentlasAgent && <AgentBadge locale={locale} listed={contact.agent?.listed === true} />}
                  {source && <span className={contact.createdBy === "one" ? styles.chipOne : styles.chipOwner}>{source}</span>}
                  {contact.updatedBy === "one" && contact.createdBy !== "one" && <span className={styles.chipOne}>{copy.editedByOne}</span>}
                </div>
                <p className={styles.hint}>
                  {contact.lastInteractionAt ? `${copy.lastInteraction(oneMailTime(contact.lastInteractionAt, locale))} · ` : ""}
                  {copy.interactions(contact.interactionCount, contact.receivedCount ?? 0)}
                </p>
              </div>
            </header>
            {card && (
              <section className={styles.cardBox} data-one-mail-their-card>
                <strong>{copy.theirCard}</strong>
                <small className={styles.hint}>{copy.theirCardHint}</small>
                {/* Written by the other agent: plain text only, never markdown or links. */}
                <p className={styles.plain}>{card.name}</p>
                {card.description && <p className={styles.plain}>{card.description}</p>}
                {card.skills.length > 0 && (
                  <>
                    <strong>{copy.skills}</strong>
                    <ul className={styles.skillList}>
                      {card.skills.map((skill, index) => (
                        <li key={skill.id ?? index}><span className={styles.plain}>{skill.name}</span>{skill.description ? <small className={styles.plain}> — {skill.description}</small> : null}</li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            )}
            <div className={styles.settings}>
              <label className={styles.settingsRow}>
                <span>{copy.contactName}</span>
                <input value={name} maxLength={mail.limits?.displayNameMaxChars ?? 200} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className={styles.settingsRow}>
                <span>{copy.ownerNote}</span>
                <textarea value={note} rows={3} maxLength={noteMax} onChange={(event) => setNote(event.target.value)} data-one-mail-owner-note />
              </label>
              <div className={styles.settingsRow} data-one-mail-one-note>
                <span>{copy.oneNote}</span>
                <p className={styles.oneNote}>{contact.oneNote || copy.oneNoteEmpty}</p>
                <p className={styles.hint}>{copy.oneNoteHint}</p>
              </div>
              <div className={styles.formActions}>
                <button type="button" className={styles.primary} disabled={busy || !dirty} onClick={() => void save()} data-one-mail-contact-save>{copy.contactSave}</button>
              </div>
              {notice && <p className={notice.error ? styles.error : styles.hint} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ContactAdd({ locale, onBack, onSaved }: { locale: Locale; onBack: () => void; onSaved: (contact: AgentMailContact) => void }) {
  const api = ipc()?.agentMail;
  const copy = mail2(locale);
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!api) return null;
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address.trim());
  const save = async () => {
    setBusy(true);
    setError(null);
    const res = await api.saveContact({ address: address.trim(), ...(name.trim() ? { displayName: name.trim() } : {}), ...(note.trim() ? { ownerNote: note.trim() } : {}) });
    setBusy(false);
    if (!res.ok) { setError(mailErrorText(locale, res)); return; }
    onSaved(res.contact);
  };
  return (
    <div className={styles.contactDetail} data-one-mail-contact-new>
      <div className={`${styles.toolbar} titlebar-nodrag`} role="toolbar">
        <button type="button" className={styles.iconButton} onClick={onBack} aria-label={copy.back} title={copy.back}><IconArrowLeft size={15} /></button>
        <strong className={styles.toolbarTitle}>{copy.contactAdd}</strong>
      </div>
      <div className={styles.threadBody}>
        <div className={`${styles.threadColumn} ${styles.settings}`}>
          <label className={styles.settingsRow}>
            <span>{copy.contactAddress}</span>
            <input type="email" value={address} maxLength={320} onChange={(event) => setAddress(event.target.value)} autoComplete="off" spellCheck={false} data-one-mail-new-address />
          </label>
          <label className={styles.settingsRow}>
            <span>{copy.contactName}</span>
            <input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className={styles.settingsRow}>
            <span>{copy.ownerNote}</span>
            <textarea value={note} rows={3} maxLength={1000} onChange={(event) => setNote(event.target.value)} />
          </label>
          <div className={styles.formActions}>
            <button type="button" className={styles.primary} disabled={busy || !valid} onClick={() => void save()}>{copy.contactSave}</button>
          </div>
          {error && <p className={styles.error} role="alert">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function DirectorySearch({ locale, mail, known, onBack }: { locale: Locale; mail: OneMailState; known: ReadonlySet<string>; onBack: () => void }) {
  const api = ipc()?.agentMail;
  const copy = mail2(locale);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AgentMailAgentCard[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  if (!api) return null;
  const min = mail.limits?.directoryQueryMinChars ?? 2;

  const search = async (cursor: string | null) => {
    const q = query.trim();
    if (Array.from(q).length < min) { setNotice({ text: copy.directorySearchMin(min), error: true }); return; }
    setBusy(true);
    setNotice(null);
    const res = await api.directorySearch({ q, cursor });
    setBusy(false);
    if (!res.ok) { setNotice({ text: mailErrorText(locale, res), error: true }); return; }
    setResults((prev) => (cursor && prev ? [...prev, ...res.results] : res.results));
    setNextCursor(res.nextCursor);
  };

  const add = async (card: AgentMailAgentCard) => {
    const res = await api.saveContact({ address: card.address, displayName: card.name, source: "directory" });
    if (!res.ok) { setNotice({ text: mailErrorText(locale, res), error: true }); return; }
    setAdded((prev) => new Set(prev).add(card.address.toLowerCase()));
  };

  return (
    <div className={styles.listPane} data-one-mail-directory-search>
      <div className={`${styles.toolbar} titlebar-nodrag`} role="toolbar">
        <button type="button" className={styles.iconButton} onClick={onBack} aria-label={copy.back} title={copy.back}><IconArrowLeft size={15} /></button>
        <strong className={styles.toolbarTitle}>{copy.directory}</strong>
      </div>
      <form className={`${styles.searchBar} titlebar-nodrag`} role="search" onSubmit={(event) => { event.preventDefault(); void search(null); }}>
        <IconSearch size={15} />
        <input type="search" value={query} placeholder={copy.directorySearchPh} aria-label={copy.directory} onChange={(event) => setQuery(event.target.value)} data-one-mail-directory-query />
      </form>
      {notice && <p className={notice.error ? styles.error : styles.notice} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
      <div className={styles.rows} role="list" aria-busy={busy}>
        {results && results.length === 0 && <div className={styles.empty}>{copy.directoryEmpty}</div>}
        {results?.map((card) => {
          const inContacts = known.has(card.address.toLowerCase()) || added.has(card.address.toLowerCase());
          return (
            <div key={card.address} role="listitem" className={styles.directoryRow} data-one-mail-directory-result={card.address}>
              <span className={styles.contactAvatar} aria-hidden="true">{(Array.from(card.name)[0] ?? "?").toUpperCase()}</span>
              <span className={styles.contactMain}>
                <strong className={styles.plain}>{card.name}</strong>
                <small>{card.address}</small>
                {card.description && <small className={styles.plain}>{card.description}</small>}
                {card.skills.length > 0 && <small className={styles.plain}>{card.skills.map((skill) => skill.name).join(" · ")}</small>}
              </span>
              <AgentBadge locale={locale} listed />
              <button type="button" className={styles.secondary} disabled={inContacts} onClick={() => void add(card)} data-one-mail-directory-add>
                {inContacts ? copy.directoryAdded : copy.directoryAdd}
              </button>
            </div>
          );
        })}
        {nextCursor && (
          <div className={styles.formActions} style={{ margin: 12 }}>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => void search(nextCursor)}>{copy.more}</button>
          </div>
        )}
      </div>
    </div>
  );
}
