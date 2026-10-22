'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ipc } from '../lib/ipc';
import type { BusinessSession } from '../../shared/business/context';
import type { BusinessCompanyMailAPI, BusinessCompanyMailColleague } from '../../shared/business/company-mail';
import { agentMailBareAddress, type AgentMailMailbox, type AgentMailSendInput, type AgentMailThreadDetail, type AgentMailThreadSummary } from '../../shared/agent-mail';
import { IconBolt, IconEdit, IconInbox, IconLock, IconMail, IconRefresh, IconReply, IconSend } from '../components/Icon';
import { OsAvatar, OsBusy, OsButton, OsCard, OsChip, OsCount, OsEmpty, OsField, OsInput, OsNotice, OsRoot, OsTextarea, osStyles as os } from './org-share-kit';
import type { OsTone } from './org-share-kit';
import { useBusinessCopy } from './use-business-copy';

type Note = { tone: OsTone; text: string } | null;
/** "Name <addr>" → Name, 그 밖에는 주소 그대로. */
const senderName = (from: string) => { const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(from); return m?.[1]?.trim() || agentMailBareAddress(from) || from; };
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
function bucketOf(iso: string): 'today' | 'yesterday' | 'week' | 'earlier' {
  const time = Date.parse(iso); if (!Number.isFinite(time)) return 'earlier';
  const days = Math.round((dayStart(new Date()) - dayStart(new Date(time))) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 7 ? 'week' : 'earlier';
}

/** Company-only inbox. Every operation carries the displayed session as an
 * expected-context fence; Main owns authentication and the selected Mail scope.
 * 화면: 받은 대화(날짜 묶음 · 보낸 사람 · 시간 · 안 읽음) + 읽기/쓰기 창. 쓰기는 "새 메일"·답장일 때만 열린다. */
export function BusinessCompanyMail({ session }: { session: BusinessSession | null }) {
  const { copy, locale } = useBusinessCopy();
  const api = (ipc() as unknown as { companyMail?: BusinessCompanyMailAPI } | null)?.companyMail;
  const [mailbox, setMailbox] = useState<AgentMailMailbox | null>(null), [threads, setThreads] = useState<AgentMailThreadSummary[]>([]), [detail, setDetail] = useState<AgentMailThreadDetail | null>(null);
  const [colleagues, setColleagues] = useState<BusinessCompanyMailColleague[]>([]), [to, setTo] = useState<string[]>([]), [subject, setSubject] = useState(''), [text, setText] = useState(''), [localPart, setLocalPart] = useState('');
  const [reply, setReply] = useState<{ replyToMessageId: string; basedOnMessageId: string } | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState<Note>(null), [pending, setPending] = useState<AgentMailSendInput | null>(null);
  const [composing, setComposing] = useState(false), [filter, setFilter] = useState('');
  const generation = useRef(0), sessionKey = JSON.stringify(session), reader = useRef<HTMLElement | null>(null);
  useEffect(() => { if (detail) reader.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [detail?.thread.id]);
  const refresh = useCallback(async () => {
    if (!api || !session) return; const stamp = generation.current;
    const status = await api.status(session); if (stamp !== generation.current) return;
    if (!status.ok) throw Error(status.code); setMailbox(status.mailbox);
    if (!status.mailbox) return;
    const list = await api.threads({ session, input: { view: 'all', limit: 50 } }); if (stamp !== generation.current) return;
    if (!list.ok) throw Error(list.code); setThreads(list.threads);
    const addresses = await api.colleagues(session); if (stamp !== generation.current) return;
    if (!addresses.ok) throw Error(addresses.code); setColleagues(addresses.colleagues);
    const original = await api.pending(session); if (stamp !== generation.current) return;
    if (original.ok) setPending(original.pending);
  }, [api, sessionKey]);
  useEffect(() => {
    generation.current++; let active = true; setMailbox(null); setThreads([]); setDetail(null); setTo([]); setSubject(''); setText(''); setReply(null); setNotice(null); setPending(null); setComposing(false); setFilter('');
    void refresh().catch(() => { if (active) setNotice({ tone: 'warn', text: copy('현재 회사 Mail 접근 권한을 확인해 주세요.', 'Check current company Mail access.') }); });
    return () => { active = false; generation.current++; };
  }, [refresh, copy]);
  async function act(work: () => Promise<void>) { if (busy) return; setBusy(true); setNotice(null); try { await work(); } catch { setNotice({ tone: 'danger', text: copy('현재 회사 세션과 권한을 다시 확인해 주세요.', 'Check the current company session and permissions.') }); } finally { setBusy(false); } }
  async function open(threadId: string) { if (!api || !session) return; const stamp = generation.current, result = await api.thread({ session, input: { threadId } }); if (stamp !== generation.current) return; if (!result.ok) throw Error(result.code); setDetail(result); setComposing(false); }
  async function sendOriginal() {
    if (!api || !session) return; const stamp = generation.current;
    const original = pending ?? { to, subject, text, ...reply, idempotencyKey: crypto.randomUUID() };
    if (!original.to.length || !original.subject.trim() || !original.text.trim()) return;
    setPending(original);
    const result = await api.send({ session, input: original }); if (stamp !== generation.current) return;
    if (!result.ok) { setNotice({ tone: 'warn', text: copy('발송 결과를 확인하지 못했습니다. 같은 원래 요청으로 다시 확인할 수 있습니다.', 'The send outcome could not be confirmed. Retry the same original request.') }); return; }
    setPending(null); setText(''); setSubject(''); setTo([]); setReply(null); setComposing(false);
    setNotice({ tone: 'ok', text: copy('회사 내부 Mail을 전달했습니다.', 'Company Mail delivered.') }); await refresh();
  }
  if (!session || !api) return <OsRoot><OsEmpty icon={<IconLock size={20} />} title={copy('회사 계정으로 먼저 로그인하세요.', 'Sign in to the company account first.')} /></OsRoot>;
  const dateLocale = locale === 'ko' ? 'ko-KR' : 'en-US';
  const stamp = (iso: string) => { const d = new Date(iso); if (!Number.isFinite(d.getTime())) return ''; return bucketOf(iso) === 'today' ? d.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(dateLocale, { month: 'numeric', day: 'numeric' }); };
  const bucketLabel = { today: copy('오늘', 'Today'), yesterday: copy('어제', 'Yesterday'), week: copy('이번 주', 'This week'), earlier: copy('이전', 'Earlier') };
  const unread = threads.reduce((sum, thread) => sum + (thread.unreadCount > 0 ? 1 : 0), 0);
  const people = filter.trim() ? colleagues.filter(person => `${person.displayName ?? ''} ${person.address}`.toLowerCase().includes(filter.trim().toLowerCase())) : colleagues;
  const toggle = (address: string) => setTo(previous => previous.includes(address) ? previous.filter(value => value !== address) : [...previous, address]);
  const showCompose = composing, draft = !composing && !pending && !!(to.length || subject.trim() || text.trim());
  const sendBlocked = busy || !pending && (!to.length || !subject.trim() || !text.trim());
  const rows: Array<{ kind: 'group'; key: string; label: string } | { kind: 'thread'; key: string; thread: AgentMailThreadSummary }> = [];
  let last = '';
  for (const thread of threads) { const bucket = bucketOf(thread.lastMessageAt); if (bucket !== last) { rows.push({ kind: 'group', key: `g-${bucket}`, label: bucketLabel[bucket] }); last = bucket; } rows.push({ kind: 'thread', key: thread.id, thread }); }
  return <OsRoot>
    <OsBusy active={busy} />
    <div className={os.pageHead}>
      <div className={os.page}><h2 className={os.pageTitle}>{copy('회사 내부 Mail', 'Company internal Mail')}</h2>{mailbox && <p className={os.addr}>{mailbox.address}</p>}</div>
      {mailbox && <div className={os.actions}><OsButton variant="secondary" icon={<IconRefresh size={16} />} disabled={busy} onClick={() => void act(refresh)}>{copy('새로 확인', 'Refresh')}</OsButton><OsButton variant="primary" icon={<IconEdit size={16} />} disabled={busy} onClick={() => { setComposing(true); }}>{draft ? copy('쓰던 메일 이어쓰기', 'Resume draft') : copy('새 메일', 'New message')}</OsButton></div>}
    </div>
    {notice && <OsNotice tone={notice.tone}>{notice.text}</OsNotice>}
    {mailbox && pending && !composing && <OsNotice tone="warn" action={<OsButton variant="primary" disabled={busy} onClick={() => setComposing(true)}>{copy('원래 발송 확인', 'Confirm original send')}</OsButton>}>{copy('결과를 확인하지 못한 발송이 있습니다. 다시 보내지 말고 같은 원래 요청으로 확인하세요.', 'A send is waiting for confirmation. Do not send again; confirm the same original request.')}</OsNotice>}
    {!mailbox
      ? <OsCard icon={<IconMail size={16} />} title={copy('회사 Mail 주소 만들기', 'Create your company address')} description={copy('회사 안에서 메일을 주고받고, 내 회사 에이전트에 일을 맡기려면 먼저 주소가 필요합니다.', 'You need an address to exchange mail inside your company and delegate work to your company agent.')}>
        <form onSubmit={event => { event.preventDefault(); void act(async () => { const r = await api.issue({ session, input: { localPart } }); if (!r.ok) throw Error(r.code); await refresh(); }); }}>
          <OsField label={copy('회사 Mail 주소 이름', 'Company mailbox name')} action={<OsButton type="submit" variant="primary" disabled={busy || !localPart.trim()}>{copy('회사 주소 만들기', 'Create company address')}</OsButton>}><OsInput required value={localPart} maxLength={64} onChange={event => setLocalPart(event.target.value)} /></OsField>
        </form>
      </OsCard>
      : <div className={os.mail}>
        <div className={os.mailList} role="group" aria-label={copy('대화', 'Conversations')}>
          <div className={os.mailListHead}><span className={os.groupTitle}>{copy('대화', 'Conversations')}<OsCount>{threads.length}</OsCount></span>{unread > 0 && <span className={os.hint}>{copy(`안 읽음 ${unread}`, `${unread} unread`)}</span>}</div>
          {threads.length === 0
            ? <OsEmpty icon={<IconInbox size={20} />} title={copy('아직 받은 대화가 없습니다', 'No conversations yet')} body={copy('동료가 보낸 내부 메일이나 회사 에이전트의 보고가 여기에 모입니다.', 'Internal mail from colleagues and reports from company agents collect here.')} />
            : rows.map(row => row.kind === 'group' ? <div key={row.key} className={os.mailGroup}>{row.label}</div>
              : <button key={row.key} type="button" className={os.thread} data-unread={row.thread.unreadCount > 0 ? 'true' : 'false'} aria-current={detail?.thread.id === row.thread.id ? 'true' : undefined} disabled={busy} onClick={() => void act(() => open(row.thread.id))}>
                <OsAvatar name={senderName(row.thread.lastFrom)} />
                <span className={os.threadCopy}><span className={os.threadFrom}>{row.thread.unreadCount > 0 && <span className={os.dot} role="img" aria-label={copy('안 읽음', 'Unread')} />}{senderName(row.thread.lastFrom)}</span><span className={os.threadSubject}>{row.thread.subject || row.thread.snippet || copy('제목 없음', 'No subject')}</span></span>
                <span className={os.threadTime}>{stamp(row.thread.lastMessageAt)}</span>
              </button>)}
        </div>
        {showCompose
          ? <form className={os.reader} onSubmit={event => { event.preventDefault(); void act(sendOriginal); }} aria-label={pending ? copy('원래 발송 확인', 'Confirm original send') : copy('내부 Mail 쓰기', 'Compose internal Mail')}>
            <h3 className={os.readerSubject}>{pending ? copy('원래 발송 확인', 'Confirm original send') : reply ? copy('답장 쓰기', 'Write reply') : copy('내부 Mail 쓰기', 'Compose internal Mail')}</h3>
            {pending
              ? <>
                <div className={os.kv}><span className={os.kvLabel}>{copy('받는 직원', 'Recipients')}</span><span className={os.kvValue}>{pending.to.join(', ')}</span></div>
                <div className={os.kv}><span className={os.kvLabel}>{copy('제목', 'Subject')}</span><span className={os.kvValue}>{pending.subject}</span></div>
                <div className={os.msgBody}>{pending.text}</div>
              </>
              : <>
                <div className={os.field}>
                  <span className={os.label}>{copy('받는 직원', 'Recipients')} <OsCount>{to.length}</OsCount></span>
                  {colleagues.length > 8 && <OsInput aria-label={copy('직원 찾기', 'Find colleague')} placeholder={copy('이름이나 주소로 찾기', 'Search by name or address')} value={filter} onChange={event => setFilter(event.target.value)} />}
                  <div className={os.chips} role="group" aria-label={copy('받는 직원', 'Recipients')}>
                    {people.length === 0 ? <span className={os.hint}>{copy('보낼 수 있는 직원이 없습니다.', 'No colleagues to send to.')}</span> : people.map(person => <OsChip key={person.principalId} name={person.displayName || person.address} pressed={to.includes(person.address)} disabled={busy} onClick={() => toggle(person.address)}>{person.displayName || person.address}</OsChip>)}
                  </div>
                </div>
                <OsField label={copy('제목', 'Subject')}><OsInput required value={subject} maxLength={998} onChange={event => setSubject(event.target.value)} /></OsField>
                <OsField label={copy('업무 내용', 'Work details')}><OsTextarea required rows={9} value={text} onChange={event => setText(event.target.value)} /></OsField>
              </>}
            <div className={os.actions} data-split="true">
              {pending ? <span /> : <OsButton variant="quiet" disabled={busy} onClick={() => setComposing(false)}>{copy('닫기', 'Close')}</OsButton>}
              <OsButton type="submit" variant="primary" icon={<IconSend size={16} />} disabled={sendBlocked}>{pending ? copy('같은 원래 요청 확인', 'Retry original request') : copy('회사 내부로 보내기', 'Send internally')}</OsButton>
            </div>
          </form>
          : detail
            ? <article className={os.reader} ref={reader}>
              <h3 className={os.readerSubject}>{detail.thread.subject || copy('제목 없음', 'No subject')}</h3>
              {detail.messages.map(message => <div key={message.id} className={os.group}>
                <div className={os.msgMeta}><strong>{senderName(message.from)}</strong><span>{message.direction === 'inbound' ? copy('받음', 'Received') : copy('보냄', 'Sent')}</span><span>{new Date(message.receivedAt).toLocaleString(dateLocale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
                <div className={os.msgBody}>{message.text || copy('텍스트 본문이 없습니다.', 'No text body.')}</div>
              </div>)}
              <div className={os.actions} data-align="start">
                <OsButton variant="primary" icon={<IconReply size={16} />} disabled={busy || !!pending} onClick={() => { const target = [...detail.messages].reverse().find(m => m.direction === 'inbound'); const latest = detail.messages.at(-1); if (target && latest) { setTo([agentMailBareAddress(target.from)]); setSubject(/^re:/i.test(target.subject) ? target.subject : 'Re: ' + target.subject); setReply({ replyToMessageId: target.id, basedOnMessageId: latest.id }); setComposing(true); } }}>{copy('답장 쓰기', 'Write reply')}</OsButton>
                <OsButton variant="secondary" icon={<IconBolt size={16} />} disabled={busy} onClick={() => void act(async () => { const result = await api.delegate({ session, input: { threadId: detail.thread.id, locale: locale === 'ko' ? 'ko' : 'en' } }); if (!result.ok) throw Error(result.code); setNotice({ tone: 'ok', text: copy('승인된 회사 에이전트가 이 대화의 업무를 시작했습니다.', 'The approved company agent started this conversation’s work.') }); })}>{copy('내 회사 에이전트로 실행', 'Run with my company agent')}</OsButton>
              </div>
            </article>
            : <div className={os.reader} data-empty="true"><OsEmpty icon={<IconInbox size={20} />} title={copy('대화를 선택하세요', 'Select a conversation')} body={copy('왼쪽에서 대화를 고르면 여기에서 읽고 답장하거나 회사 에이전트에 맡길 수 있습니다.', 'Pick a conversation on the left to read it here, reply, or hand it to your company agent.')} /></div>}
      </div>}
  </OsRoot>;
}
