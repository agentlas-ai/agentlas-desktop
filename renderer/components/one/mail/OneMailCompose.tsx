"use client";

// Compose / reply / forward sheet for One's mailbox. No confirmation step
// (owner decision): Send sends. Drafts autosave when typing pauses; one sheet
// = one idempotency key, and a draft sends by its server version, so a double
// click is still one email.
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { tFor, type Locale } from "@/lib/i18n";
import { agentMailBareAddress, agentMailDisplayName } from "@shared/agent-mail";
import { OneBottomSheet } from "../OneBottomSheet";
import type { OneMailCompose, OneMailState } from "./useOneMail";
import styles from "./OneMail.module.css";

/** "Kim <k@x>" and "k@x" are one person: keep the first (named) form. */
export function uniqueNames(addresses: string[]): string[] {
  const seen = new Map<string, string>();
  for (const value of addresses) {
    const key = agentMailBareAddress(value);
    const name = agentMailDisplayName(value);
    const prior = seen.get(key);
    if (!prior || (prior === key && name !== key)) seen.set(key, name);
  }
  return [...seen.values()];
}

function recipients(value: string): string[] {
  return value.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean);
}

export function OneMailComposeSheet({ compose, mail, locale, onDone }: {
  compose: OneMailCompose;
  mail: OneMailState;
  locale: Locale;
  onDone: (message: string | null) => void;
}) {
  const api = ipc()?.agentMail;
  const seed = compose.seed;
  const [fields, setFields] = useState({ to: seed.to, cc: seed.cc, bcc: seed.bcc, subject: seed.subject, text: seed.text });
  const [showCc, setShowCc] = useState(Boolean(seed.cc || seed.bcc));
  const [draft, setDraft] = useState<{ id: string | null; version: number | null }>({ id: seed.draftId, version: seed.draftVersion });
  const [basedOn, setBasedOn] = useState<string | null>(seed.basedOnMessageId);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [draftsSupported, setDraftsSupported] = useState(!mail.legacy);
  const dirty = useRef(false);
  const pending = useRef<Promise<void> | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;

  const isReply = Boolean(seed.replyToMessageId);
  const isForward = !isReply && /^fwd?:/i.test(seed.subject);
  const title = isReply ? tFor(locale, "one.mail.compose.title_reply") : isForward ? tFor(locale, "one.mail.compose.title_forward") : tFor(locale, "one.mail.compose");
  const remaining = mail.entitlement?.remainingThisMonth ?? null;
  const count = recipients(fields.to).length + recipients(fields.cc).length + recipients(fields.bcc).length;
  const overLimit = remaining !== null && count > remaining;
  const canSend = Boolean(mail.entitlement?.mailbox.send);
  const signature = typeof mail.mailbox?.signature === "string" && mail.mailbox.signature.trim().length > 0;

  const saveNow = useCallback(async () => {
    if (!api || !draftsSupported || !dirty.current) return;
    dirty.current = false;
    const current = fieldsRef.current;
    setSaveState("saving");
    const res = await api.saveDraft({
      id: draftRef.current.id,
      ...(draftRef.current.version !== null ? { expectedVersion: draftRef.current.version } : {}),
      fields: {
        to: recipients(current.to),
        cc: recipients(current.cc),
        bcc: recipients(current.bcc),
        subject: current.subject,
        text: current.text,
        ...(seed.replyToMessageId ? { replyToMessageId: seed.replyToMessageId } : {}),
        ...(basedOn ? { basedOnMessageId: basedOn } : {}),
        ...(seed.threadId ? { threadId: seed.threadId } : {}),
      },
    }).catch(() => null);
    if (!res) { setSaveState("idle"); return; }
    if (!res.ok) {
      if (res.code === "http_404" || res.code === "http_405") setDraftsSupported(false);
      else if (res.code === "agent_mail_draft_version_conflict" && res.detail && typeof res.detail === "object" && "draft" in res.detail) {
        const server = (res.detail as { draft?: { id: string; version: number } }).draft;
        if (server) setDraft({ id: server.id, version: server.version });
        dirty.current = true;
      }
      setSaveState("idle");
      return;
    }
    setDraft({ id: res.draft.id, version: res.draft.version });
    setSaveState("saved");
  }, [api, draftsSupported, seed.replyToMessageId, seed.threadId, basedOn]);

  // Autosave when typing pauses.
  useEffect(() => {
    if (!dirty.current || !draftsSupported) return;
    const timer = window.setTimeout(() => { pending.current = saveNow(); }, 1_200);
    return () => window.clearTimeout(timer);
  }, [fields, saveNow, draftsSupported]);

  const update = (patch: Partial<typeof fields>) => {
    dirty.current = true;
    setSaveState("idle");
    setFields((prev) => ({ ...prev, ...patch }));
  };

  const close = () => {
    if (dirty.current && draftsSupported && (fieldsRef.current.text.trim() || fieldsRef.current.subject.trim() || fieldsRef.current.to.trim())) void saveNow();
    onDone(null);
  };

  const send = async () => {
    if (!api || sending) return;
    setSending(true);
    setNotice(null);
    if (pending.current) await pending.current.catch(() => undefined);
    if (dirty.current && draftRef.current.id) await saveNow();
    const current = fieldsRef.current;
    const res = draftRef.current.id
      ? await api.sendDraft({ id: draftRef.current.id, ...(draftRef.current.version !== null ? { expectedVersion: draftRef.current.version } : {}) })
      : await api.send({
          to: recipients(current.to),
          cc: recipients(current.cc),
          bcc: recipients(current.bcc),
          subject: current.subject,
          text: current.text,
          ...(seed.replyToMessageId ? { replyToMessageId: seed.replyToMessageId } : {}),
          ...(basedOn ? { basedOnMessageId: basedOn } : {}),
          idempotencyKey: compose.key,
        });
    setSending(false);
    if (!res.ok) {
      if (res.code === "agent_mail_thread_moved") {
        const latest = res.detail && typeof (res.detail as { latestMessageId?: unknown }).latestMessageId === "string"
          ? (res.detail as { latestMessageId: string }).latestMessageId
          : null;
        if (latest) setBasedOn(latest);
        dirty.current = true;
        mail.reloadDetail();
        setNotice({ text: tFor(locale, "one.mail.compose.thread_moved"), error: true });
        return;
      }
      if (res.code === "send_outcome_unknown") {
        setNotice({ text: tFor(locale, "one.mail.compose.outcome_unknown"), error: true });
        return;
      }
      if (res.code === "agent_mail_monthly_limit_reached") {
        setNotice({ text: tFor(locale, "one.mail.compose.over_limit", { count: remaining ?? 0 }), error: true });
        return;
      }
      setNotice({ text: res.message, error: true });
      return;
    }
    if (res.send.status === "uncertain") {
      setNotice({ text: tFor(locale, "one.mail.compose.outcome_unknown"), error: true });
      return;
    }
    void mail.refreshStatus();
    onDone(tFor(locale, "one.mail.compose.sent"));
  };

  const discard = async () => {
    if (api && draftRef.current.id) await api.removeDraft(draftRef.current.id).catch(() => null);
    dirty.current = false;
    mail.refreshList();
    onDone(null);
  };

  const ready = recipients(fields.to).length > 0 && fields.subject.trim().length > 0 && fields.text.trim().length > 0;

  return (
    <OneBottomSheet
      open
      onClose={close}
      closeLabel={tFor(locale, "one.mail.compose.close")}
      ariaLabelledBy="one-mail-compose-title"
      titleId="one-mail-compose-title"
      title={title}
      size="wide"
      closeOnBackdrop={!sending}
      closeOnEscape={!sending}
    >
      <form className={styles.form} data-one-mail-compose onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label className={styles.field}>
          <span>{tFor(locale, "one.mail.field.to")}</span>
          <input value={fields.to} onChange={(event) => update({ to: event.target.value })} autoFocus={!isReply} type="text" inputMode="email" autoComplete="off" />
          {!showCc && <button type="button" className={styles.ghostButton} onClick={() => setShowCc(true)}>{tFor(locale, "one.mail.compose.show_cc")}</button>}
        </label>
        {showCc && (
          <>
            <label className={styles.field}>
              <span>{tFor(locale, "one.mail.field.cc")}</span>
              <input value={fields.cc} onChange={(event) => update({ cc: event.target.value })} type="text" inputMode="email" autoComplete="off" />
            </label>
            <label className={styles.field}>
              <span>{tFor(locale, "one.mail.field.bcc")}</span>
              <input value={fields.bcc} onChange={(event) => update({ bcc: event.target.value })} type="text" inputMode="email" autoComplete="off" />
            </label>
          </>
        )}
        <label className={styles.field}>
          <span>{tFor(locale, "one.mail.field.subject")}</span>
          <input value={fields.subject} onChange={(event) => update({ subject: event.target.value })} type="text" />
        </label>
        <textarea
          className={styles.body}
          aria-label={tFor(locale, "one.mail.field.body")}
          placeholder={tFor(locale, "one.mail.field.body")}
          value={fields.text}
          autoFocus={isReply}
          onChange={(event) => update({ text: event.target.value })}
        />
        {notice && <p className={notice.error ? styles.error : styles.notice} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
        <div className={styles.formFoot}>
          <p>
            {!canSend
              ? tFor(locale, "one.mail.compose.no_send_plan")
              : overLimit
                ? tFor(locale, "one.mail.compose.over_limit", { count: remaining ?? 0 })
                : remaining !== null ? tFor(locale, "one.mail.compose.remaining", { count: remaining.toLocaleString() }) : null}
            {signature && <><br />{tFor(locale, "one.mail.compose.signature_note")}</>}
            {saveState !== "idle" && <><br />{saveState === "saving" ? tFor(locale, "one.mail.compose.saving") : tFor(locale, "one.mail.compose.saved")}</>}
          </p>
          <div className={styles.formActions}>
            {draft.id && <button type="button" className={styles.secondary} disabled={sending} onClick={() => void discard()}>{tFor(locale, "one.mail.compose.discard")}</button>}
            <button type="submit" className={styles.primary} disabled={sending || !canSend || overLimit || !ready}>
              {sending ? tFor(locale, "one.mail.compose.sending") : tFor(locale, "one.mail.compose.send")}
            </button>
          </div>
        </div>
      </form>
    </OneBottomSheet>
  );
}
