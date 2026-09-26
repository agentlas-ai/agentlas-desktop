"use client";

// PLAN-2 P2.5: opt-in listing in the Agentlas agent directory (off by default,
// like an unlisted phone number). The card follows A2A AgentCard field names;
// the owner writes it, the server checks names (no "Agentlas"/"official"
// look-alikes) and lengths. Turning the listing off takes effect at once.
import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { Locale } from "@/lib/i18n";
import type { AgentMailAgentCardSkill, AgentMailDirectoryEntry, AgentMailLimits, AgentMailMailbox } from "@shared/agent-mail";
import { mailErrorText } from "./mailErrorText";
import { mail2 } from "./mailCopy";
import styles from "./OneMail.module.css";

const LANGUAGE_CHOICES = ["ko", "en", "ja", "zh"] as const;
const LANGUAGE_NAMES: Record<Locale, Record<string, string>> = {
  ko: { ko: "한국어", en: "영어", ja: "일본어", zh: "중국어" },
  en: { ko: "Korean", en: "English", ja: "Japanese", zh: "Chinese" },
};

export function OneMailDirectoryCard({
  locale,
  oneName,
  limits,
  mailbox,
}: {
  locale: Locale;
  oneName: string;
  limits: AgentMailLimits | null;
  mailbox: AgentMailMailbox;
}) {
  const api = ipc()?.agentMail;
  const copy = mail2(locale);
  const [entry, setEntry] = useState<AgentMailDirectoryEntry | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [listed, setListed] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [skills, setSkills] = useState<AgentMailAgentCardSkill[]>([]);
  const [languages, setLanguages] = useState<string[]>([locale]);
  const [unsolicited, setUnsolicited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const adopt = (next: AgentMailDirectoryEntry) => {
    setEntry(next);
    setListed(next.listed);
    setName(next.card?.name ?? oneName);
    setDescription(next.card?.description ?? "");
    setSkills(next.card?.skills?.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description ?? "", tags: skill.tags ?? [] })) ?? []);
    setLanguages(next.card?.languages?.length ? next.card.languages : [locale]);
    setUnsolicited(next.card?.acceptsUnsolicited === true);
  };

  useEffect(() => {
    if (!api?.directoryMe) return;
    let alive = true;
    void api.directoryMe().then((res) => {
      if (!alive) return;
      setLoaded(true);
      if (res.ok) adopt(res);
      else if (res.code !== "agent_mail_mailbox_not_found") setNotice({ text: mailErrorText(locale, res), error: true });
    }).catch(() => setLoaded(true));
    return () => { alive = false; };
  }, [api, mailbox.address]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!api?.directoryMe || !loaded) return null;

  const card = limits?.card;
  const maxSkills = card?.skillsMax ?? null;
  const cleanSkills = skills.filter((skill) => skill.name.trim());

  const save = async (nextListed: boolean) => {
    if (!name.trim()) { setNotice({ text: copy.cardNeedsName, error: true }); return; }
    setBusy(true);
    setNotice(null);
    const res = await api.saveDirectoryMe({
      listed: nextListed,
      card: { name: name.trim(), description: description.trim(), skills: cleanSkills, languages, acceptsUnsolicited: unsolicited },
    });
    setBusy(false);
    if (!res.ok) {
      setNotice({ text: mailErrorText(locale, res), error: true });
      setListed(entry?.listed ?? false);
      return;
    }
    adopt(res);
    setNotice({ text: copy.cardSaved, error: false });
  };

  const toggle = async (next: boolean) => {
    setListed(next);
    // Turning off never needs the card; the server unlists at once.
    if (!next && entry?.card) {
      setBusy(true);
      const res = await api.saveDirectoryMe({ listed: false });
      setBusy(false);
      if (!res.ok) { setListed(true); setNotice({ text: mailErrorText(locale, res), error: true }); return; }
      adopt(res);
    }
  };

  const setSkill = (index: number, patch: Partial<AgentMailAgentCardSkill>) => {
    setSkills((prev) => prev.map((skill, i) => (i === index ? { ...skill, ...patch } : skill)));
  };

  const editing = listed || Boolean(entry?.card);

  return (
    <div className={styles.settings} data-one-mail-directory>
      <label className={styles.toggleRow}>
        <input type="checkbox" checked={listed} disabled={busy} onChange={(event) => void toggle(event.target.checked)} data-one-mail-directory-toggle />
        <span>
          {copy.listToggle}
          <small>{copy.listHint}</small>
        </span>
      </label>
      {editing && (
        <>
          <label className={styles.settingsRow}>
            <span>{copy.cardName}</span>
            <input value={name} maxLength={card?.nameMaxChars ?? 80} onChange={(event) => setName(event.target.value)} data-one-mail-card-name />
          </label>
          <label className={styles.settingsRow}>
            <span>{copy.cardDescription}</span>
            <textarea value={description} rows={2} maxLength={card?.descriptionMaxChars ?? 1000} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <fieldset className={styles.settingsRow} style={{ border: 0, margin: 0, padding: 0 }}>
            <legend style={{ padding: 0, marginBottom: 6 }}>{copy.cardSkills}</legend>
            {skills.map((skill, index) => (
              <div key={skill.id ?? index} className={styles.skillRow}>
                <input aria-label={copy.cardSkillName} placeholder={copy.cardSkillName} value={skill.name} maxLength={card?.skillNameMaxChars ?? 80} onChange={(event) => setSkill(index, { name: event.target.value })} />
                <input aria-label={copy.cardSkillDescription} placeholder={copy.cardSkillDescription} value={skill.description ?? ""} maxLength={card?.skillDescriptionMaxChars ?? 300} onChange={(event) => setSkill(index, { description: event.target.value })} />
                <button type="button" className={styles.ghostButton} onClick={() => setSkills((prev) => prev.filter((_, i) => i !== index))}>{copy.cardSkillRemove}</button>
              </div>
            ))}
            {(maxSkills === null || skills.length < maxSkills) && (
              <div>
                <button type="button" className={styles.ghostButton} onClick={() => setSkills((prev) => [...prev, { name: "", description: "", tags: [] }])}>+ {copy.cardSkillAdd}</button>
              </div>
            )}
          </fieldset>
          <fieldset className={styles.settingsRow} style={{ border: 0, margin: 0, padding: 0 }}>
            <legend style={{ padding: 0, marginBottom: 6 }}>{copy.cardLanguages}</legend>
            <div className={styles.suggestions}>
              {LANGUAGE_CHOICES.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={styles.suggestion}
                  data-selected={languages.includes(tag) ? "true" : undefined}
                  aria-pressed={languages.includes(tag)}
                  onClick={() => setLanguages((prev) => (prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]))}
                >
                  {LANGUAGE_NAMES[locale][tag]}
                </button>
              ))}
            </div>
          </fieldset>
          <label className={styles.toggleRow}>
            <input type="checkbox" checked={unsolicited} onChange={(event) => setUnsolicited(event.target.checked)} />
            <span>
              {copy.cardUnsolicited}
              <small>{copy.cardUnsolicitedHint}</small>
            </span>
          </label>
          <div className={styles.formActions}>
            <button type="button" className={styles.primary} disabled={busy || !name.trim()} onClick={() => void save(listed)} data-one-mail-card-save>{copy.cardSave}</button>
          </div>
        </>
      )}
      {notice && <p className={notice.error ? styles.error : styles.hint} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
    </div>
  );
}
