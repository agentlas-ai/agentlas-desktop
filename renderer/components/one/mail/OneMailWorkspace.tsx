"use client";

// Centre of the One screen while the Mail tab is open. A mailbox, not a chat:
// a dense list (one row = one conversation) with a toolbar and pager, and a
// reading pane when a row is opened. Counts, unread and thread membership all
// come from the server through Main.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  IconArchive,
  IconArrowLeft,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconForward,
  IconMail,
  IconMailOpen,
  IconMoreHorizontal,
  IconPaperclip,
  IconRefresh,
  IconReply,
  IconSearch,
  IconSparkles,
  IconTrash,
} from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { mailErrorText } from "./mailErrorText";
import { tFor, type Locale } from "@/lib/i18n";
import {
  agentMailDisplayName,
  type AgentMailDraft,
  type AgentMailError,
  type AgentMailMessage,
  type AgentMailSendStatus,
  type AgentMailThreadSummary,
} from "@shared/agent-mail";
import { OneMailMenu, type OneMailMenuItem } from "./OneMailMenu";
import { ONE_MAIL_VIEW_KEYS, oneMailTime } from "./OneMailRail";
import { OneMailComposeSheet, uniqueNames } from "./OneMailCompose";
import { OneMailSettings } from "./OneMailSettings";
import type { OneMailState } from "./useOneMail";
import styles from "./OneMail.module.css";

const STATUS_KEYS = {
  accepted: "one.mail.status.accepted",
  delivered: "one.mail.status.delivered",
  bounced: "one.mail.status.bounced",
  complained: "one.mail.status.complained",
  rejected: "one.mail.status.rejected",
  uncertain: "one.mail.status.uncertain",
} as const satisfies Record<AgentMailSendStatus, string>;

/** Remote content and scripts are blocked; the frame cannot reach the app. */
function sandboxedHtml(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><base target="_blank"><style>body{margin:12px;font:13px/1.6 -apple-system,system-ui,sans-serif;color:#1c1d1f;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
}

function originLabel(origin: AgentMailThreadSummary["lastOrigin"] | undefined, locale: Locale): string | null {
  if (origin === "one") return tFor(locale, "one.mail.sent_by_one");
  if (origin === "owner") return tFor(locale, "one.mail.sent_by_me");
  if (origin === "automation") return tFor(locale, "one.mail.sent_by_automation");
  return null;
}

type Notice = { text: string; error: boolean } | null;

export function OneMailWorkspace({
  mail,
  locale,
  oneName,
  threadVisible = true,
  onOpenConversation,
}: {
  mail: OneMailState;
  locale: Locale;
  oneName: string;
  /** False while another rail tab is open: only a pending compose sheet shows. */
  threadVisible?: boolean;
  onOpenConversation: (chatId: string) => void;
}) {
  const [notice, setNotice] = useState<Notice>(null);
  const threadId = mail.selection?.kind === "thread" ? mail.selection.id : null;

  const composeSheet = mail.compose ? (
    <OneMailComposeSheet
      key={mail.compose.key}
      compose={mail.compose}
      mail={mail}
      locale={locale}
      onDone={(message) => {
        mail.closeCompose();
        mail.refreshList();
        mail.reloadDetail();
        if (message) setNotice({ text: message, error: false });
      }}
    />
  ) : null;

  if (!threadVisible) return composeSheet;

  return (
    <section className={styles.workspace} data-one-mail-view aria-label={tFor(locale, "one.mail.tab")}>
      <div className={`${styles.dragStrip} titlebar-drag`} aria-hidden="true" />
      {!mail.available ? (
        <MailSetup mail={mail} locale={locale} oneName={oneName} />
      ) : threadId ? (
        <ReadingPane mail={mail} locale={locale} onOpenConversation={onOpenConversation} notice={notice} setNotice={setNotice} />
      ) : (
        <MailList mail={mail} locale={locale} notice={notice} setNotice={setNotice} />
      )}
      {composeSheet}
    </section>
  );
}

/** No address yet: one clear call to action, never an empty fake inbox. */
function MailSetup({ mail, locale, oneName }: { mail: OneMailState; locale: Locale; oneName: string }) {
  return (
    <div className={styles.setup} data-one-mail-setup>
      <div className={styles.setupCard}>
        <span className={styles.setupIcon} aria-hidden="true"><IconMail size={22} /></span>
        <h2>{tFor(locale, "one.mail.setup.title")}</h2>
        <p>{tFor(locale, "one.mail.setup.desc")}</p>
        <OneMailSettings locale={locale} oneName={oneName} onChanged={() => void mail.refreshStatus()} />
      </div>
    </div>
  );
}

function MailList({ mail, locale, notice, setNotice }: {
  mail: OneMailState;
  locale: Locale;
  notice: Notice;
  setNotice: (value: Notice) => void;
}) {
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [query, setQuery] = useState(mail.query);
  useEffect(() => { setQuery(mail.query); }, [mail.query]);
  const drafts = mail.view === "drafts" && !mail.query.trim();
  const rows: Array<{ id: string }> = drafts ? mail.drafts : mail.threads;
  const allChecked = rows.length > 0 && rows.every((row) => mail.checked.has(row.id));
  const someChecked = mail.checked.size > 0;
  const end = mail.pageStart + rows.length - 1;
  const title = mail.query.trim() ? tFor(locale, "one.mail.search_results") : tFor(locale, ONE_MAIL_VIEW_KEYS[mail.view]);
  const address = mail.mailbox?.address ?? null;

  const run = (action: "archive" | "delete" | "read" | "unread") => {
    if (action === "delete" && !window.confirm(tFor(locale, "one.mail.delete_selected_confirm", { count: mail.checked.size }))) return;
    void mail.bulk(action).then((error) => { if (error) setNotice({ text: mailErrorText(locale, error), error: true }); });
  };

  const moreItems: OneMailMenuItem[] = drafts || mail.legacy ? [] : [
    { id: "read", label: tFor(locale, "one.mail.mark_read"), icon: <IconMailOpen size={14} />, disabled: !someChecked, onSelect: () => run("read") },
    { id: "unread", label: tFor(locale, "one.mail.action.mark_unread"), icon: <IconMail size={14} />, disabled: !someChecked, onSelect: () => run("unread") },
  ];

  return (
    <div className={styles.listPane}>
      <form
        className={`${styles.searchBar} titlebar-nodrag`}
        role="search"
        onSubmit={(event) => { event.preventDefault(); mail.setQuery(query); }}
      >
        <IconSearch size={15} />
        <input
          type="search"
          value={query}
          placeholder={tFor(locale, "one.mail.search_ph")}
          aria-label={tFor(locale, "one.mail.search_ph")}
          onChange={(event) => { setQuery(event.target.value); if (!event.target.value) mail.setQuery(""); }}
          data-one-mail-search
        />
      </form>
      <div className={`${styles.toolbar} titlebar-nodrag`} role="toolbar" aria-label={title}>
        <input
          type="checkbox"
          className={styles.check}
          checked={allChecked}
          ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
          onChange={(event) => mail.setAllChecked(event.target.checked)}
          aria-label={tFor(locale, "one.mail.select_all")}
          disabled={rows.length === 0}
        />
        {someChecked ? (
          <>
            {!drafts && !mail.legacy && (
              <button type="button" className={styles.iconButton} onClick={() => run("archive")} aria-label={tFor(locale, mail.view === "archived" ? "one.mail.action.unarchive" : "one.mail.action.archive")} title={tFor(locale, mail.view === "archived" ? "one.mail.action.unarchive" : "one.mail.action.archive")}><IconArchive size={15} /></button>
            )}
            <button type="button" className={styles.iconButton} onClick={() => run("delete")} aria-label={tFor(locale, "one.mail.action.delete")} title={tFor(locale, "one.mail.action.delete")}><IconTrash size={15} /></button>
            <span className={styles.toolbarNote}>{tFor(locale, "one.mail.checked_count", { count: mail.checked.size })}</span>
          </>
        ) : (
          <button type="button" className={styles.iconButton} onClick={() => { mail.refreshList(); void mail.refreshStatus(); }} aria-label={tFor(locale, "one.mail.refresh")} title={tFor(locale, "one.mail.refresh")}><IconRefresh size={15} /></button>
        )}
        {moreItems.length > 0 && (
          <button ref={moreRef} type="button" className={styles.iconButton} aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)} aria-label={tFor(locale, "one.mail.more")} title={tFor(locale, "one.mail.more")}><IconMoreHorizontal size={15} /></button>
        )}
        <span className={styles.toolbarSpacer} />
        {rows.length > 0 && (
          <span className={styles.pageRange} data-one-mail-page-range>
            {tFor(locale, "one.mail.page_range", { start: mail.pageStart, end, total: mail.hasMore ? `${end}+` : end })}
          </span>
        )}
        <button type="button" className={styles.iconButton} disabled={!mail.hasPrev || mail.listLoading} onClick={mail.prevPage} aria-label={tFor(locale, "one.mail.page_prev")} title={tFor(locale, "one.mail.page_prev")}><IconChevronLeft size={15} /></button>
        <button type="button" className={styles.iconButton} disabled={!mail.hasMore || mail.listLoading} onClick={mail.nextPage} aria-label={tFor(locale, "one.mail.page_next")} title={tFor(locale, "one.mail.page_next")}><IconChevronRight size={15} /></button>
      </div>
      {moreOpen && <OneMailMenu anchor={moreRef.current} label={tFor(locale, "one.mail.more")} items={moreItems} onClose={() => setMoreOpen(false)} width={220} />}
      {notice && <p className={notice.error ? styles.error : styles.notice} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
      {mail.listError && <p className={styles.error} role="alert">{mailErrorText(locale, mail.listError)}</p>}
      <div className={styles.rows} role="list" aria-busy={mail.listLoading} data-one-mail-list={mail.view}>
        {rows.length === 0 && !mail.listLoading ? (
          <div className={styles.empty}>
            {mail.query.trim()
              ? tFor(locale, "one.mail.empty.search")
              : mail.view === "inbox" ? tFor(locale, "one.mail.empty.inbox") : tFor(locale, "one.mail.empty.other")}
            {address && mail.view === "inbox" && !mail.query.trim() && <div className={styles.emptyAddress}><code>{address}</code></div>}
          </div>
        ) : drafts ? (
          mail.drafts.map((draft) => <DraftRow key={draft.id} draft={draft} mail={mail} locale={locale} />)
        ) : (
          mail.threads.map((thread) => <ThreadRow key={thread.id} thread={thread} mail={mail} locale={locale} onError={(error) => setNotice({ text: mailErrorText(locale, error), error: true })} />)
        )}
        {mail.listLoading && rows.length === 0 && <p className={styles.notice} role="status">{tFor(locale, "one.mail.loading")}</p>}
      </div>
    </div>
  );
}

function ThreadRow({ thread, mail, locale, onError }: {
  thread: AgentMailThreadSummary;
  mail: OneMailState;
  locale: Locale;
  onError: (error: AgentMailError) => void;
}) {
  const unread = thread.unreadCount > 0;
  const checked = mail.checked.has(thread.id);
  const who = thread.lastDirection === "inbound"
    ? agentMailDisplayName(thread.lastFrom)
    : uniqueNames(thread.participants).join(", ") || agentMailDisplayName(thread.lastFrom);
  const origin = originLabel(thread.lastOrigin, locale);
  const problem = thread.sendProblem === "uncertain"
    ? tFor(locale, "one.mail.status.uncertain")
    : thread.sendProblem ? tFor(locale, "one.mail.status.bounced") : null;
  const open = () => mail.select({ kind: "thread", id: thread.id });
  const act = (event: MouseEvent, action: () => Promise<AgentMailError | null>) => {
    event.stopPropagation();
    void action().then((error) => { if (error) onError(error); });
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
  };
  return (
    <div
      role="listitem"
      tabIndex={0}
      className={styles.row}
      data-unread={unread ? "true" : "false"}
      data-checked={checked ? "true" : "false"}
      data-one-mail-thread={thread.id}
      onClick={open}
      onKeyDown={onKey}
      aria-label={`${who} · ${thread.subject || tFor(locale, "one.mail.no_subject")}`}
    >
      <input
        type="checkbox"
        className={styles.check}
        checked={checked}
        onClick={(event) => event.stopPropagation()}
        onChange={() => mail.toggleChecked(thread.id)}
        aria-label={tFor(locale, "one.mail.select_row", { subject: thread.subject || tFor(locale, "one.mail.no_subject") })}
      />
      <span className={styles.rowSender} title={who}>
        <span>{who}</span>
        {thread.messageCount > 1 && <span className={styles.count}>{thread.messageCount}</span>}
      </span>
      <span className={styles.rowMain}>
        {origin && <span className={thread.lastOrigin === "owner" ? styles.chipOwner : styles.chipOne} data-one-mail-origin={thread.lastOrigin ?? undefined}>{origin}</span>}
        {problem && <span className={styles.chipProblem}>{problem}</span>}
        <span className={styles.rowSubject}>{thread.subject || tFor(locale, "one.mail.no_subject")}</span>
        <span className={styles.rowSnippet}>{thread.snippet ? ` — ${thread.snippet}` : ""}</span>
      </span>
      <span className={styles.rowEnd}>
        {thread.hasAttachments && <IconPaperclip size={13} />}
        <time className={styles.rowTime} dateTime={thread.lastMessageAt}>{oneMailTime(thread.lastMessageAt, locale)}</time>
        {!mail.legacy && (
          <span className={styles.rowActions}>
            <button type="button" className={styles.iconButton} onClick={(event) => act(event, () => mail.archive(thread.id, !thread.archived))} aria-label={tFor(locale, thread.archived ? "one.mail.action.unarchive" : "one.mail.action.archive")} title={tFor(locale, thread.archived ? "one.mail.action.unarchive" : "one.mail.action.archive")}><IconArchive size={14} /></button>
            <button type="button" className={styles.iconButton} onClick={(event) => act(event, async () => (window.confirm(tFor(locale, "one.mail.delete_confirm")) ? mail.removeThread(thread.id) : null))} aria-label={tFor(locale, "one.mail.action.delete")} title={tFor(locale, "one.mail.action.delete")}><IconTrash size={14} /></button>
            <button type="button" className={styles.iconButton} onClick={(event) => act(event, () => mail.markRead(thread.id, unread))} aria-label={tFor(locale, unread ? "one.mail.mark_read" : "one.mail.action.mark_unread")} title={tFor(locale, unread ? "one.mail.mark_read" : "one.mail.action.mark_unread")}>{unread ? <IconMailOpen size={14} /> : <IconMail size={14} />}</button>
          </span>
        )}
      </span>
    </div>
  );
}

function DraftRow({ draft, mail, locale }: { draft: AgentMailDraft; mail: OneMailState; locale: Locale }) {
  const to = draft.to.length ? uniqueNames(draft.to).join(", ") : tFor(locale, "one.mail.draft_to_none");
  const checked = mail.checked.has(draft.id);
  const open = () => mail.openCompose({
    to: draft.to.join(", "),
    cc: draft.cc.join(", "),
    bcc: draft.bcc.join(", "),
    subject: draft.subject,
    text: draft.text,
    replyToMessageId: draft.replyToMessageId,
    basedOnMessageId: draft.basedOnMessageId,
    threadId: draft.threadId,
    draftId: draft.id,
    draftVersion: draft.version,
  });
  return (
    <div
      role="listitem"
      tabIndex={0}
      className={styles.row}
      data-checked={checked ? "true" : "false"}
      data-one-mail-draft={draft.id}
      onClick={open}
      onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(); } }}
    >
      <input type="checkbox" className={styles.check} checked={checked} onClick={(event) => event.stopPropagation()} onChange={() => mail.toggleChecked(draft.id)} aria-label={tFor(locale, "one.mail.select_row", { subject: draft.subject || tFor(locale, "one.mail.no_subject") })} />
      <span className={styles.rowSender}><span className={styles.draftTag}>{tFor(locale, "one.mail.draft_tag")}</span><span>{to}</span></span>
      <span className={styles.rowMain}>
        {draft.origin === "one" && <span className={styles.chipOne}>{tFor(locale, "one.mail.written_by_one")}</span>}
        <span className={styles.rowSubject}>{draft.subject || tFor(locale, "one.mail.no_subject")}</span>
        <span className={styles.rowSnippet}>{draft.text ? ` — ${draft.text.slice(0, 200)}` : ""}</span>
      </span>
      <span className={styles.rowEnd}>
        <time className={styles.rowTime} dateTime={draft.updatedAt}>{oneMailTime(draft.updatedAt, locale)}</time>
        <span className={styles.rowActions}>
          <button type="button" className={styles.iconButton} onClick={(event) => { event.stopPropagation(); void mail.removeDraft(draft.id); }} aria-label={tFor(locale, "one.mail.draft_delete")} title={tFor(locale, "one.mail.draft_delete")}><IconTrash size={14} /></button>
        </span>
      </span>
    </div>
  );
}

function ReadingPane({ mail, locale, onOpenConversation, notice, setNotice }: {
  mail: OneMailState;
  locale: Locale;
  onOpenConversation: (chatId: string) => void;
  notice: Notice;
  setNotice: (value: Notice) => void;
}) {
  const api = ipc()?.agentMail;
  const actionsRef = useRef<HTMLButtonElement | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [delegating, setDelegating] = useState(false);
  const detail = mail.detail;
  const threadId = mail.selection?.kind === "thread" ? mail.selection.id : null;
  const canSend = Boolean(mail.entitlement?.mailbox.send);

  useEffect(() => {
    // Newest message and unread ones start open (conversation view).
    if (!detail) return;
    const open = new Set<string>();
    const last = detail.messages[detail.messages.length - 1];
    if (last) open.add(last.id);
    for (const message of detail.messages) if (message.unread) open.add(message.id);
    setExpanded(open);
  }, [detail?.thread.id, detail?.messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastMessage = detail?.messages[detail.messages.length - 1] ?? null;
  const replyTarget = useMemo(() => {
    if (!detail) return null;
    // Reply to the newest message from someone else; fall back to the newest.
    for (let i = detail.messages.length - 1; i >= 0; i -= 1) if (detail.messages[i].direction === "inbound") return detail.messages[i];
    return lastMessage;
  }, [detail, lastMessage]);

  const fail = (error: AgentMailError | null) => {
    if (error) setNotice({ text: mailErrorText(locale, error), error: true });
  };

  const download = async (message: AgentMailMessage, index: number) => {
    if (!api) return;
    const res = await api.downloadAttachment({ messageId: message.id, index });
    setNotice(res.ok ? { text: tFor(locale, "one.mail.downloaded"), error: false } : { text: mailErrorText(locale, res), error: true });
  };

  const delegate = async () => {
    if (!api || !threadId || delegating) return;
    setDelegating(true);
    const res = await api.delegate({ threadId, locale });
    setDelegating(false);
    if (!res.ok) { fail(res); return; }
    onOpenConversation(res.chatId);
  };

  const removeThread = () => {
    if (!detail || !window.confirm(tFor(locale, "one.mail.delete_confirm"))) return;
    void mail.removeThread(detail.thread.id).then(fail);
  };

  if (!detail) {
    return (
      <p className={mail.detailError ? styles.error : styles.centerState} role={mail.detailError ? "alert" : "status"}>
        {mail.detailError ? mailErrorText(locale, mail.detailError) : tFor(locale, "one.mail.loading")}
      </p>
    );
  }

  const moreItems: OneMailMenuItem[] = [];
  if (replyTarget && canSend) {
    moreItems.push({ id: "reply", label: tFor(locale, "one.mail.action.reply"), icon: <IconReply size={14} />, onSelect: () => mail.openCompose(mail.replySeed(replyTarget, "reply", locale)) });
    moreItems.push({ id: "replyAll", label: tFor(locale, "one.mail.action.reply_all"), icon: <IconReply size={14} />, onSelect: () => mail.openCompose(mail.replySeed(replyTarget, "replyAll", locale)) });
    moreItems.push({ id: "forward", label: tFor(locale, "one.mail.action.forward"), icon: <IconForward size={14} />, onSelect: () => mail.openCompose(mail.replySeed(lastMessage ?? replyTarget, "forward", locale)) });
  }

  return (
    <>
      <div className={`${styles.toolbar} titlebar-nodrag`} role="toolbar" aria-label={tFor(locale, "one.mail.thread_actions")}>
        <button type="button" className={styles.iconButton} onClick={() => mail.select(null)} aria-label={tFor(locale, "one.mail.back")} title={tFor(locale, "one.mail.back")}>
          <IconArrowLeft size={15} />
        </button>
        {!mail.legacy && (
          <button type="button" className={styles.iconButton} onClick={() => { void mail.archive(detail.thread.id, !detail.thread.archived).then(fail); mail.select(null); }} aria-label={tFor(locale, detail.thread.archived ? "one.mail.action.unarchive" : "one.mail.action.archive")} title={tFor(locale, detail.thread.archived ? "one.mail.action.unarchive" : "one.mail.action.archive")}><IconArchive size={15} /></button>
        )}
        <button type="button" className={styles.iconButton} onClick={removeThread} aria-label={tFor(locale, "one.mail.action.delete")} title={tFor(locale, "one.mail.action.delete")}><IconTrash size={15} /></button>
        {!mail.legacy && (
          <button type="button" className={styles.iconButton} onClick={() => { void mail.markRead(detail.thread.id, false).then(fail); mail.select(null); }} aria-label={tFor(locale, "one.mail.action.mark_unread")} title={tFor(locale, "one.mail.action.mark_unread")}><IconMail size={15} /></button>
        )}
        {moreItems.length > 0 && (
          <button
            ref={actionsRef}
            type="button"
            className={styles.iconButton}
            aria-haspopup="menu"
            aria-expanded={actionsOpen}
            aria-label={tFor(locale, "one.mail.more")}
            title={tFor(locale, "one.mail.more")}
            onClick={() => setActionsOpen((open) => !open)}
          >
            <IconMoreHorizontal size={15} />
          </button>
        )}
      </div>
      {actionsOpen && (
        <OneMailMenu anchor={actionsRef.current} label={tFor(locale, "one.mail.thread_actions")} items={moreItems} onClose={() => setActionsOpen(false)} width={220} />
      )}
      <div className={styles.threadBody}>
        <div className={styles.threadColumn}>
          <h2 className={styles.threadSubject} title={detail.thread.subject}>{detail.thread.subject || tFor(locale, "one.mail.no_subject")}</h2>
          {notice && <p className={notice.error ? styles.error : styles.notice} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
          {detail.messages.map((message) => (
            <MessageSection
              key={message.id}
              message={message}
              locale={locale}
              open={expanded.has(message.id)}
              onToggle={() => setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(message.id)) next.delete(message.id); else next.add(message.id);
                return next;
              })}
              onOpenConversation={onOpenConversation}
              onDownload={(index) => void download(message, index)}
            />
          ))}
          <div className={`${styles.replyBar} titlebar-nodrag`}>
            {replyTarget && canSend && (
              <>
                <button type="button" className={styles.secondary} onClick={() => mail.openCompose(mail.replySeed(replyTarget, "reply", locale))}>
                  <IconReply size={14} />{tFor(locale, "one.mail.action.reply")}
                </button>
                {replyTarget.to.length + replyTarget.cc.length > 1 && (
                  <button type="button" className={styles.secondary} onClick={() => mail.openCompose(mail.replySeed(replyTarget, "replyAll", locale))}>
                    <IconReply size={14} />{tFor(locale, "one.mail.action.reply_all")}
                  </button>
                )}
                <button type="button" className={styles.secondary} onClick={() => mail.openCompose(mail.replySeed(lastMessage ?? replyTarget, "forward", locale))}>
                  <IconForward size={14} />{tFor(locale, "one.mail.action.forward")}
                </button>
              </>
            )}
            {!mail.legacy && (
              <button type="button" className={styles.secondary} disabled={delegating} onClick={() => void delegate()} data-one-mail-delegate>
                <IconSparkles size={14} />
                {delegating ? tFor(locale, "one.mail.delegating") : tFor(locale, "one.mail.action.delegate")}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function MessageSection({ message, locale, open, onToggle, onOpenConversation, onDownload }: {
  message: AgentMailMessage;
  locale: Locale;
  open: boolean;
  onToggle: () => void;
  onOpenConversation: (chatId: string) => void;
  onDownload: (index: number) => void;
}) {
  const chatId = message.originRef?.chatId ?? null;
  const status = message.direction === "outbound" && message.sendStatus ? message.sendStatus : null;
  const badStatus = status === "bounced" || status === "complained" || status === "rejected" || status === "uncertain";
  const fromName = agentMailDisplayName(message.from);
  const fromAddress = /<([^>]+)>/.exec(message.from)?.[1] ?? null;
  return (
    <article className={styles.message} data-one-mail-message={message.id} data-direction={message.direction} data-open={open ? "true" : "false"}>
      <button type="button" className={styles.messageHead} onClick={onToggle} aria-expanded={open}>
        <span className={styles.messageFrom}>
          <strong>{fromName}</strong>
          {open && fromAddress && <span>&lt;{fromAddress}&gt;</span>}
        </span>
        <time dateTime={message.receivedAt}>{new Date(message.receivedAt).toLocaleString(locale === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
        {open
          ? <span className={styles.messageTo}>{tFor(locale, "one.mail.to_label", { names: uniqueNames([...message.to, ...message.cc]).join(", ") })}</span>
          : <span className={styles.messagePreview}>{message.preview}</span>}
      </button>
      {(message.origin || status) && (
        <div className={styles.messageMeta}>
          {message.origin === "one" && (
            <span className={styles.chipOne} data-one-mail-origin="one">
              {tFor(locale, "one.mail.sent_by_one")}
              {chatId && <> · <button type="button" className={styles.originLink} onClick={() => onOpenConversation(chatId)}>{tFor(locale, "one.mail.open_conversation")}</button></>}
            </span>
          )}
          {message.origin === "owner" && <span className={styles.chipOwner} data-one-mail-origin="owner">{tFor(locale, "one.mail.sent_by_me")}</span>}
          {message.origin === "automation" && <span className={styles.chipOne} data-one-mail-origin="automation">{tFor(locale, "one.mail.sent_by_automation")}</span>}
          {status && <span className={styles.status} data-tone={badStatus ? "bad" : undefined}>{tFor(locale, STATUS_KEYS[status])}</span>}
        </div>
      )}
      {status === "uncertain" && <p className={styles.uncertain}>{tFor(locale, "one.mail.uncertain_hint")}</p>}
      {open && (
        message.text
          ? <pre className={styles.messageText}>{message.text}</pre>
          : message.html
            ? <iframe className={styles.htmlFrame} title={tFor(locale, "one.mail.html_title")} sandbox="" referrerPolicy="no-referrer" srcDoc={sandboxedHtml(message.html)} />
            : null
      )}
      {open && message.attachments.length > 0 && (
        <div className={styles.chips}>
          {message.attachments.map((attachment, position) => {
            const index = attachment.index ?? position;
            const name = attachment.filename || `attachment-${index + 1}`;
            const downloadable = attachment.downloadable !== false;
            return (
              <button
                key={index}
                type="button"
                className={styles.chip}
                disabled={!downloadable}
                title={downloadable ? tFor(locale, "one.mail.attachment_download", { name }) : tFor(locale, "one.mail.attachment_unavailable")}
                aria-label={downloadable ? tFor(locale, "one.mail.attachment_download", { name }) : tFor(locale, "one.mail.attachment_unavailable")}
                onClick={() => onDownload(index)}
              >
                <IconPaperclip size={12} />
                <span>{name}</span>
                {downloadable && <IconDownload size={12} />}
              </button>
            );
          })}
        </div>
      )}
    </article>
  );
}
