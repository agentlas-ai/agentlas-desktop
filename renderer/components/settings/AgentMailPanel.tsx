"use client";

// Agent mail — minimal mailbox surface. Every number here comes from the web
// server's entitlement; this component never decides eligibility or allowance.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import type {
  AgentMailEntitlement,
  AgentMailMailbox,
  AgentMailMessage,
  AgentMailMessageSummary,
} from "@shared/agent-mail";
import styles from "./AgentMailPanel.module.css";

type View = "inbound" | "outbound" | "compose";

function newKey(): string {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function AgentMailPanel({ locale }: { locale: string }) {
  const ko = locale === "ko";
  const api = ipc()?.agentMail;
  const [loaded, setLoaded] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [entitlement, setEntitlement] = useState<AgentMailEntitlement | null>(null);
  const [mailbox, setMailbox] = useState<AgentMailMailbox | null>(null);
  const [view, setView] = useState<View>("inbound");
  const [messages, setMessages] = useState<AgentMailMessageSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<AgentMailMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNoticeState] = useState<{ text: string; error: boolean } | null>(null);
  const setNotice = (text: string | null, error = true) => setNoticeState(text ? { text, error } : null);
  const [draft, setDraft] = useState({ to: "", subject: "", text: "", key: newKey() });

  const refresh = useCallback(async () => {
    if (!api) return;
    const status = await api.status();
    setLoaded(true);
    if (!status.ok) {
      setNotice(status.message);
      return;
    }
    setSignedIn(status.signedIn);
    setEntitlement(status.entitlement);
    setMailbox(status.mailbox);
  }, [api]);

  const loadMessages = useCallback(async (direction: "inbound" | "outbound", cursor: string | null) => {
    if (!api) return;
    const res = await api.list({ direction, cursor, limit: 25 });
    if (!res.ok) {
      setNotice(res.message);
      return;
    }
    setMessages((prev) => (cursor ? [...prev, ...res.messages] : res.messages));
    setNextCursor(res.nextCursor);
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (mailbox?.status === "active" && view !== "compose") void loadMessages(view, null);
  }, [mailbox?.status, view, loadMessages]);

  const issue = async () => {
    if (!api) return;
    setBusy(true);
    setNotice(null);
    const res = await api.issue({});
    setBusy(false);
    if (!res.ok) {
      setNotice(res.message);
      return;
    }
    setMailbox(res.mailbox);
    if (res.entitlement) setEntitlement(res.entitlement);
  };

  const openMessage = async (id: string) => {
    if (!api) return;
    const res = await api.get(id);
    if (res.ok) setOpen(res.message);
    else setNotice(res.message);
  };

  const send = async () => {
    if (!api) return;
    setBusy(true);
    setNotice(null);
    const res = await api.send({
      to: draft.to.split(/[,;\s]+/).filter(Boolean),
      subject: draft.subject,
      text: draft.text,
      idempotencyKey: draft.key,
    });
    setBusy(false);
    if (!res.ok) {
      // Keep the same key: resubmitting this draft can never send twice.
      setNotice(res.message);
      return;
    }
    setNotice(
      res.send.status === "uncertain"
        ? ko ? "전송 결과를 아직 확인하지 못했습니다. 다시 보내지 말고 보낸 메일함을 확인하세요." : "Send result not confirmed yet. Check Sent before sending again."
        : ko ? "보냈습니다." : "Sent.",
      res.send.status === "uncertain",
    );
    setDraft({ to: "", subject: "", text: "", key: newKey() });
    setEntitlement((prev) => (prev ? { ...prev, remainingThisMonth: res.remainingThisMonth, usedThisMonth: prev.monthlyRecipientLimit - res.remainingThisMonth } : prev));
  };

  const usage = useMemo(() => {
    if (!entitlement || entitlement.monthlyRecipientLimit <= 0) return null;
    const pct = Math.min(100, Math.round((entitlement.usedThisMonth / entitlement.monthlyRecipientLimit) * 100));
    const reset = new Date(entitlement.period.end).toLocaleDateString(ko ? "ko-KR" : "en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    return { pct, reset };
  }, [entitlement, ko]);

  if (!api || !loaded) return null;

  return (
    <section className={styles.panel} aria-labelledby="agent-mail-title">
      <h2 id="agent-mail-title" className={styles.title}>{ko ? "에이전트 메일" : "Agent mail"}</h2>
      <div className={styles.card}>
        {!signedIn ? (
          <p className={styles.muted}>{ko ? "Agentlas에 로그인하면 사용할 수 있습니다." : "Sign in to Agentlas to use agent mail."}</p>
        ) : !entitlement ? (
          <p className={styles.muted}>{ko ? "도입 예정 — Pro 이상 요금제에 에이전트 전용 메일 주소가 제공될 예정입니다." : "Coming soon — Pro and above will include an agent mail address."}</p>
        ) : !mailbox ? (
          <div className={styles.row}>
            <p className={styles.muted}>
              {entitlement.addressLimit > 0
                ? ko ? `에이전트만 쓰는 메일 주소를 받습니다. 이번 달 ${entitlement.monthlyRecipientLimit.toLocaleString()}명까지 보낼 수 있습니다.` : `Get an address only your agent uses. Send to up to ${entitlement.monthlyRecipientLimit.toLocaleString()} recipients this month.`
                : ko ? "에이전트 메일은 Pro·Max·WoW 요금제에 포함됩니다." : "Agent mail is included with Pro, Max and WoW."}
            </p>
            {entitlement.addressLimit > 0 ? (
              <button type="button" className={styles.button} disabled={busy} onClick={() => void issue()}>
                {busy ? (ko ? "만드는 중…" : "Creating…") : ko ? "주소 받기" : "Get address"}
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div className={styles.row}>
              <span className={styles.address} title={mailbox.address}>{mailbox.address}</span>
              <button type="button" className={styles.ghost} onClick={() => void navigator.clipboard?.writeText(mailbox.address)}>
                {ko ? "복사" : "Copy"}
              </button>
            </div>
            {mailbox.status !== "active" ? (
              <div className={styles.row}>
                <p className={styles.muted}>{ko ? "주소 준비가 끝나지 않았습니다." : "The address is not ready yet."}</p>
                <button type="button" className={styles.button} disabled={busy} onClick={() => void issue()}>{ko ? "다시 시도" : "Retry"}</button>
              </div>
            ) : null}
            {usage ? (
              <div>
                <div className={styles.meter} role="progressbar" aria-valuenow={usage.pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className={styles.meterFill} style={{ width: `${usage.pct}%` }} />
                </div>
                <p className={styles.muted}>
                  {ko
                    ? `이번 달 ${entitlement.usedThisMonth.toLocaleString()} / ${entitlement.monthlyRecipientLimit.toLocaleString()}명 · ${usage.reset} 초기화(UTC)`
                    : `${entitlement.usedThisMonth.toLocaleString()} of ${entitlement.monthlyRecipientLimit.toLocaleString()} recipients this month · resets ${usage.reset} (UTC)`}
                </p>
              </div>
            ) : (
              <p className={styles.muted}>{ko ? "현재 요금제에서는 보낼 수 없습니다. 받은 메일은 계속 볼 수 있습니다." : "Sending is not included in your current plan. Received mail stays readable."}</p>
            )}
            <div className={styles.tabs} role="tablist">
              {(["inbound", "outbound", "compose"] as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  className={view === v ? styles.tabActive : styles.tab}
                  disabled={v === "compose" && !entitlement.mailbox.send}
                  onClick={() => { setView(v); setOpen(null); }}
                >
                  {v === "inbound" ? (ko ? "받은 메일" : "Inbox") : v === "outbound" ? (ko ? "보낸 메일" : "Sent") : ko ? "새 메일" : "Compose"}
                </button>
              ))}
            </div>
            {view === "compose" ? (
              <div className={styles.list} style={{ maxHeight: "none" }}>
                <input className={styles.field} placeholder={ko ? "받는 사람 (쉼표로 구분)" : "To (comma separated)"} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
                <input className={styles.field} placeholder={ko ? "제목" : "Subject"} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
                <textarea className={styles.textarea} placeholder={ko ? "내용" : "Message"} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
                <div className={styles.row}>
                  <p className={styles.muted}>{ko ? `남은 수신자 ${entitlement.remainingThisMonth.toLocaleString()}명` : `${entitlement.remainingThisMonth.toLocaleString()} recipients left`}</p>
                  <button type="button" className={styles.button} disabled={busy || !draft.to.trim() || !draft.subject.trim() || !draft.text.trim()} onClick={() => void send()}>
                    {busy ? (ko ? "보내는 중…" : "Sending…") : ko ? "보내기" : "Send"}
                  </button>
                </div>
              </div>
            ) : open ? (
              <div className={styles.list} style={{ maxHeight: "none" }}>
                <div className={styles.itemHead}><span>{open.from}</span><span>{new Date(open.receivedAt).toLocaleString(ko ? "ko-KR" : "en-US")}</span></div>
                <div className={styles.itemSubject}>{open.subject || (ko ? "(제목 없음)" : "(no subject)")}</div>
                <pre className={styles.body}>{open.text || (ko ? "(본문 없음 — HTML 전용 메일)" : "(no plain text — HTML-only message)")}</pre>
                {open.attachments.length ? <p className={styles.muted}>{(ko ? "첨부 " : "Attachments ") + open.attachments.map((a) => a.filename || "file").join(", ")}</p> : null}
                <div className={styles.row}>
                  <button type="button" className={styles.ghost} onClick={() => setOpen(null)}>{ko ? "목록" : "Back"}</button>
                  {entitlement.mailbox.send && open.direction === "inbound" ? (
                    <button
                      type="button"
                      className={styles.button}
                      onClick={() => {
                        setDraft({ to: open.from.match(/<([^>]+)>/)?.[1] ?? open.from, subject: open.subject.startsWith("Re:") ? open.subject : `Re: ${open.subject}`, text: "", key: newKey() });
                        setView("compose");
                        setOpen(null);
                      }}
                    >
                      {ko ? "답장" : "Reply"}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className={styles.list}>
                {messages.length === 0 ? <p className={styles.muted}>{ko ? "메일이 없습니다." : "No messages."}</p> : null}
                {messages.map((m) => (
                  <button key={m.id} type="button" className={styles.item} onClick={() => void openMessage(m.id)}>
                    <span className={styles.itemHead}>
                      <span>{view === "inbound" ? m.from : m.to.join(", ")}</span>
                      <span>{new Date(m.receivedAt).toLocaleDateString(ko ? "ko-KR" : "en-US")}</span>
                    </span>
                    <span className={styles.itemSubject}>{m.subject || (ko ? "(제목 없음)" : "(no subject)")}</span>
                    <span className={styles.muted}>{m.preview}</span>
                  </button>
                ))}
                {nextCursor ? (
                  <button type="button" className={styles.ghost} onClick={() => void loadMessages(view === "outbound" ? "outbound" : "inbound", nextCursor)}>
                    {ko ? "더 보기" : "Load more"}
                  </button>
                ) : null}
              </div>
            )}
          </>
        )}
        {notice ? <p className={notice.error ? styles.error : styles.muted} role={notice.error ? "alert" : "status"}>{notice.text}</p> : null}
      </div>
    </section>
  );
}
