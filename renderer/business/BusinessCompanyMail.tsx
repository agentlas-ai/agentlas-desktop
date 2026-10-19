'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ipc } from '../lib/ipc';
import type { BusinessSession } from '../../shared/business/context';
import type { BusinessCompanyMailAPI, BusinessCompanyMailColleague } from '../../shared/business/company-mail';
import { agentMailBareAddress, type AgentMailMailbox, type AgentMailSendInput, type AgentMailThreadDetail, type AgentMailThreadSummary } from '../../shared/agent-mail';
import { useBusinessCopy } from './use-business-copy';
import styles from './BusinessCompanyMail.module.css';

/** Company-only inbox. Every operation carries the displayed session as an
 * expected-context fence; Main owns authentication and the selected Mail scope. */
export function BusinessCompanyMail({ session }: { session: BusinessSession | null }) {
  const { copy, locale } = useBusinessCopy();
  const api = (ipc() as unknown as { companyMail?: BusinessCompanyMailAPI } | null)?.companyMail;
  const [mailbox, setMailbox] = useState<AgentMailMailbox | null>(null), [threads, setThreads] = useState<AgentMailThreadSummary[]>([]), [detail, setDetail] = useState<AgentMailThreadDetail | null>(null);
  const [colleagues, setColleagues] = useState<BusinessCompanyMailColleague[]>([]), [to, setTo] = useState<string[]>([]), [subject, setSubject] = useState(''), [text, setText] = useState(''), [localPart, setLocalPart] = useState('');
  const [reply, setReply] = useState<{ replyToMessageId: string; basedOnMessageId: string } | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null), [pending, setPending] = useState<AgentMailSendInput | null>(null);
  const generation = useRef(0), sessionKey = JSON.stringify(session);
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
    generation.current++; let active = true; setMailbox(null); setThreads([]); setDetail(null); setTo([]); setSubject(''); setText(''); setReply(null); setNotice(null); setPending(null);
    void refresh().catch(() => { if (active) setNotice(copy('현재 회사 Mail 접근 권한을 확인해 주세요.', 'Check current company Mail access.')); });
    return () => { active = false; generation.current++; };
  }, [refresh, copy]);
  async function act(work: () => Promise<void>) { if (busy) return; setBusy(true); setNotice(null); try { await work(); } catch { setNotice(copy('현재 회사 세션과 권한을 다시 확인해 주세요.', 'Check the current company session and permissions.')); } finally { setBusy(false); } }
  async function open(threadId: string) { if (!api || !session) return; const stamp = generation.current, result = await api.thread({ session, input: { threadId } }); if (stamp !== generation.current) return; if (!result.ok) throw Error(result.code); setDetail(result); }
  async function sendOriginal() {
    if (!api || !session) return; const stamp = generation.current;
    const original = pending ?? { to, subject, text, ...reply, idempotencyKey: crypto.randomUUID() };
    if (!original.to.length || !original.subject.trim() || !original.text.trim()) return;
    setPending(original);
    const result = await api.send({ session, input: original }); if (stamp !== generation.current) return;
    if (!result.ok) { setNotice(copy('발송 결과를 확인하지 못했습니다. 같은 원래 요청으로 다시 확인할 수 있습니다.', 'The send outcome could not be confirmed. Retry the same original request.')); return; }
    setPending(null); setText(''); setSubject(''); setTo([]); setReply(null);
    setNotice(copy('회사 내부 Mail을 전달했습니다.', 'Company Mail delivered.')); await refresh();
  }
  if (!session || !api) return <p>{copy('회사 계정으로 먼저 로그인하세요.', 'Sign in to the company account first.')}</p>;
  return <section className={styles.panel} aria-label={copy('회사 내부 Mail', 'Company internal Mail')}>
    <header className={styles.header}><div><h2>{copy('회사 내부 Mail', 'Company internal Mail')}</h2>{mailbox && <p>{mailbox.address}</p>}</div><button type="button" disabled={busy} onClick={() => void act(refresh)}>{copy('새로 확인', 'Refresh')}</button></header>
    {notice && <p role="status">{notice}</p>}
    {!mailbox ? <form onSubmit={event => { event.preventDefault(); void act(async () => { const r = await api.issue({ session, input: { localPart } }); if (!r.ok) throw Error(r.code); await refresh(); }); }}>
      <label>{copy('회사 Mail 주소 이름', 'Company mailbox name')}<input required value={localPart} maxLength={64} onChange={event => setLocalPart(event.target.value)} /></label><button disabled={busy || !localPart.trim()}>{copy('회사 주소 만들기', 'Create company address')}</button>
    </form> : <div className={styles.columns}>
      <div><h3>{copy('대화', 'Conversations')}</h3><ul className={styles.threads}>{threads.map(thread => <li key={thread.id}><button type="button" disabled={busy} onClick={() => void act(() => open(thread.id))}>{thread.subject || copy('제목 없음', 'No subject')}</button></li>)}</ul>
        {detail && <article className={styles.reading}><h3>{detail.thread.subject}</h3>{detail.messages.map(message => <div key={message.id}><p>{message.from}</p><pre>{message.text || copy('텍스트 본문이 없습니다.', 'No text body.')}</pre></div>)}
          <div className={styles.actions}><button type="button" disabled={busy || !!pending} onClick={() => { const target = [...detail.messages].reverse().find(m => m.direction === 'inbound'); const latest = detail.messages.at(-1); if (target && latest) { setTo([agentMailBareAddress(target.from)]); setSubject(/^re:/i.test(target.subject) ? target.subject : 'Re: ' + target.subject); setReply({ replyToMessageId: target.id, basedOnMessageId: latest.id }); } }}>{copy('답장 쓰기', 'Write reply')}</button>
            <button type="button" disabled={busy} onClick={() => void act(async () => { const result = await api.delegate({ session, input: { threadId: detail.thread.id, locale: locale === 'ko' ? 'ko' : 'en' } }); if (!result.ok) throw Error(result.code); setNotice(copy('승인된 회사 에이전트가 이 대화의 업무를 시작했습니다.', 'The approved company agent started this conversation’s work.')); })}>{copy('내 회사 에이전트로 실행', 'Run with my company agent')}</button></div>
        </article>}
      </div>
      <form onSubmit={event => { event.preventDefault(); void act(sendOriginal); }}><h3>{pending ? copy('원래 발송 확인', 'Confirm original send') : copy('내부 Mail 쓰기', 'Compose internal Mail')}</h3>
        {pending ? <><p>{pending.to.join(', ')}</p><strong>{pending.subject}</strong><pre>{pending.text}</pre></> : <>
          <label>{copy('받는 직원', 'Recipients')}<select multiple required value={to} onChange={event => setTo(Array.from(event.target.selectedOptions, option => option.value))}>{colleagues.map(person => <option key={person.principalId} value={person.address}>{person.displayName || person.address}</option>)}</select></label>
          <label>{copy('제목', 'Subject')}<input required value={subject} maxLength={998} onChange={event => setSubject(event.target.value)} /></label>
          <label>{copy('업무 내용', 'Work details')}<textarea required rows={8} value={text} onChange={event => setText(event.target.value)} /></label>
        </>}
        <button disabled={busy || !pending && (!to.length || !subject.trim() || !text.trim())}>{pending ? copy('같은 원래 요청 확인', 'Retry original request') : copy('회사 내부로 보내기', 'Send internally')}</button>
      </form>
    </div>}
  </section>;
}
