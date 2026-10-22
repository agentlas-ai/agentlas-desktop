'use client';
import { cloneElement, forwardRef, isValidElement, useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, KeyboardEvent, ReactElement, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { IconAlertTriangle, IconCheck, IconChevronDown, IconChevronRight } from '../components/Icon';
import s from './org-share-kit.module.css';

/**
 * 조직 공유 화면 공용 조각 — One 설정 시트와 회사 창이 같이 쓴다. 보여 주는 일만 하고, 승인·검증·IPC 는 호출하는 쪽이 한다.
 * 규칙: 카드 하나 = 일 하나(번호 + 제목 + 한 줄 설명 + 상태 알약), 주 버튼은 카드당 하나, 위험 동작은 인라인 확인,
 * 결과는 일어난 카드 안에 톤으로, 선택은 선택 카드, 진행은 트래커, 빈 상태는 아이콘 + 한 문장 + 다음 행동.
 */
export type OsTone = 'idle' | 'ok' | 'warn' | 'danger' | 'info';
export type OsStepState = 'done' | 'current' | 'todo' | 'failed';
const cx = (...v: Array<string | false | null | undefined>) => v.filter(Boolean).join(' ');

export function OsRoot({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(s.os, className)}>{children}</div>;
}

export function OsPill({ tone = 'idle', children }: { tone?: OsTone | 'plain'; children: ReactNode }) {
  return <span className={s.pill} data-tone={tone}>{children}</span>;
}

/** 페이지 위쪽에 얇게 흐르는 진행 줄(카드가 없는 화면용). */
export function OsBusy({ active }: { active: boolean }) {
  return <div className={s.busy} data-active={active ? 'true' : 'false'} aria-hidden="true" />;
}

export function OsCount({ children }: { children: ReactNode }) {
  return <span className={s.count}>{children}</span>;
}

export function OsCard({ step, done, icon, title, description, status, tone = 'idle', end, busy, children }: {
  step?: number; done?: boolean; icon?: ReactNode; title: ReactNode; description?: ReactNode; status?: ReactNode; tone?: OsTone; end?: ReactNode; busy?: boolean; children?: ReactNode;
}) {
  const id = useId();
  return <section className={s.card} aria-labelledby={id} aria-busy={busy ? true : undefined} data-busy={busy ? 'true' : undefined}>
    <header className={s.head}>
      {icon
        ? <span className={s.tile} aria-hidden="true">{icon}</span>
        : <span className={s.badge} data-done={done ? 'true' : 'false'} aria-hidden="true">{done ? <IconCheck size={14} strokeWidth={2.4} /> : step}</span>}
      <div className={s.headCopy}><h3 id={id} className={s.title}>{title}</h3>{description && <p className={s.desc}>{description}</p>}</div>
      {(status || end) && <div className={s.headEnd}>{status && <OsPill tone={tone}>{status}</OsPill>}{end}</div>}
    </header>
    <div className={s.body}>{children}</div>
  </section>;
}

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'dangerSolid';
export const OsButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: ReactNode; block?: boolean; iconOnly?: boolean }>(
  function OsButton({ variant = 'secondary', icon, block, iconOnly, className, children, ...rest }, ref) {
    return <button type="button" {...rest} ref={ref} className={cx(s.btn, s[variant], block && s.block, iconOnly && s.icon, className)}>{icon}{children}</button>;
  });

/** 라벨 + 입력(+ 같은 줄 끝의 주 버튼) + 도움말. 입력은 id 와 설명 연결을 자동으로 받는다. */
export function OsField({ label, hint, action, children }: { label: ReactNode; hint?: ReactNode; action?: ReactNode; children: ReactElement<{ id?: string; 'aria-describedby'?: string }> }) {
  const id = useId(), hintId = `${id}-hint`;
  const control = isValidElement(children) ? cloneElement(children, { id, ...(hint ? { 'aria-describedby': hintId } : {}) }) : children;
  return <div className={s.field}>
    <label className={s.label} htmlFor={id}>{label}</label>
    {action ? <div className={s.fieldRow}>{control}{action}</div> : control}
    {hint && <span id={hintId} className={s.hint}>{hint}</span>}
  </div>;
}

export function OsInput({ mono, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input autoComplete="off" {...rest} className={s.input} data-mono={mono ? 'true' : undefined} />;
}
export function OsTextarea({ mono, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea {...rest} className={s.textarea} data-mono={mono ? 'true' : undefined} />;
}
export function OsSelect({ children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <span className={s.selectWrap}><select {...rest} className={s.select}>{children}</select><IconChevronDown size={16} /></span>;
}
export function OsCheck({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return <label className={s.check} data-checked={checked ? 'true' : 'false'}><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /><span className={s.mono}>{children}</span></label>;
}
export function OsChecks({ children }: { children: ReactNode }) { return <div className={s.checks}>{children}</div>; }

const InfoGlyph = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.6h.01" /></svg>;

/** 결과·안내. tone 이 danger 면 alert, 그 밖에는 status 로 읽힌다. */
export function OsNotice({ tone = 'info', action, role, children }: { tone?: OsTone; action?: ReactNode; role?: 'status' | 'alert'; children: ReactNode }) {
  return <div className={s.notice} data-tone={tone} role={role ?? (tone === 'danger' ? 'alert' : 'status')}>
    <span className={s.noticeIcon} aria-hidden="true">{tone === 'ok' ? <IconCheck size={16} strokeWidth={2.2} /> : tone === 'warn' || tone === 'danger' ? <IconAlertTriangle size={16} /> : <InfoGlyph />}</span>
    <div className={s.noticeBody}><p>{children}</p>{action && <div className={s.actions} data-align="start">{action}</div>}</div>
  </div>;
}

/** 단일 선택 카드(라디오). 방향키·Home/End 로 옮기고 Tab 은 그룹 하나로 친다. */
export function OsChoiceGroup({ label, value, onChange, items, disabled }: { label: string; value: string; onChange: (value: string) => void; items: ReadonlyArray<{ value: string; title: ReactNode; meta?: ReactNode }>; disabled?: boolean }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = items.findIndex(item => item.value === value);
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const n = items.length;
    const next = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? (index + 1) % n : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? (index - 1 + n) % n : event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(items[next].value);
    refs.current[next]?.focus();
  };
  return <div className={s.choices} role="radiogroup" aria-label={label}>
    {items.map((item, index) => <button key={item.value} ref={el => { refs.current[index] = el; }} type="button" role="radio" aria-checked={item.value === value} tabIndex={selected === -1 ? (index === 0 ? 0 : -1) : (index === selected ? 0 : -1)} disabled={disabled} className={s.choice} onClick={() => onChange(item.value)} onKeyDown={event => onKey(event, index)}>
      <span className={s.radio} aria-hidden="true" />
      <span className={s.choiceCopy}><span className={s.choiceTitle}>{item.title}</span>{item.meta && <span className={s.choiceMeta}>{item.meta}</span>}</span>
    </button>)}
  </div>;
}

/** 목록에서 하나를 고르는 카드(누름 상태). 내용은 호출하는 쪽이 채운다. */
export function OsPickCard({ pressed, disabled, onClick, children }: { pressed: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={s.choice} aria-pressed={pressed} disabled={disabled} onClick={onClick}><span className={s.radio} aria-hidden="true" /><span className={s.choiceCopy}>{children}</span></button>;
}

export function OsTracker({ ko, steps }: { ko: boolean; steps: ReadonlyArray<{ label: ReactNode; state: OsStepState }> }) {
  const words: Record<OsStepState, string> = ko ? { done: '완료', current: '진행 중', todo: '대기', failed: '실패' } : { done: 'done', current: 'in progress', todo: 'waiting', failed: 'failed' };
  return <ol className={s.track} style={{ '--steps': steps.length } as CSSProperties}>
    {steps.map((step, index) => <li key={index} data-state={step.state}><span>{step.label}</span><span className={s.sr}>{words[step.state]}</span></li>)}
  </ol>;
}

export function OsEmpty({ icon, title, body, action }: { icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return <div className={s.empty}>{icon && <span className={s.emptyIcon} aria-hidden="true">{icon}</span>}<strong className={s.emptyTitle}>{title}</strong>{body && <p className={s.emptyBody}>{body}</p>}{action}</div>;
}

export function OsDisclosure({ title, onToggle, children }: { title: ReactNode; onToggle?: (open: boolean) => void; children: ReactNode }) {
  return <details className={s.disclosure} onToggle={onToggle ? event => onToggle(event.currentTarget.open) : undefined}><summary><IconChevronRight size={14} />{title}</summary><div className={s.disclosureBody}>{children}</div></details>;
}

/** 위험 동작: 평소에는 설명 한 줄 + 빨강 윤곽 버튼. 누르면 결과 한 문장 + [취소 · 동작명] 으로 바뀌고 초점은 취소에 간다. Esc 는 이 확인만 닫는다. */
export function OsDangerZone({ ko, title, description, actionLabel, confirmTitle, consequence, confirmLabel, disabled, bare, onConfirm }: {
  ko: boolean; title: ReactNode; description: ReactNode; actionLabel: ReactNode; confirmTitle: string; consequence: ReactNode; confirmLabel: ReactNode; disabled?: boolean; bare?: boolean; onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null), opener = useRef<HTMLButtonElement>(null), wasOpen = useRef(false);
  useEffect(() => {
    if (open) cancel.current?.focus();
    else if (wasOpen.current) opener.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return <div className={s.zone} data-open={open ? 'true' : 'false'} data-bare={bare ? 'true' : undefined} onKeyDown={event => { if (open && event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}>
    {open
      ? <div className={s.zoneCopy} role="group" aria-label={confirmTitle}>
        <h4 className={s.zoneTitle}>{confirmTitle}</h4><p className={s.hint}>{consequence}</p>
        <div className={s.actions} data-align="start" style={{ marginTop: 8 }}>
          <OsButton ref={cancel} variant="secondary" onClick={() => setOpen(false)}>{ko ? '취소' : 'Cancel'}</OsButton>
          <OsButton variant="dangerSolid" disabled={disabled} onClick={() => { setOpen(false); onConfirm(); }}>{confirmLabel}</OsButton>
        </div>
      </div>
      : <div className={s.zoneRow}>
        <div className={s.zoneCopy}><h4 className={s.zoneTitle}>{title}</h4><p className={s.hint}>{description}</p></div>
        <OsButton ref={opener} variant="danger" disabled={disabled} onClick={() => setOpen(true)}>{actionLabel}</OsButton>
      </div>}
  </div>;
}

/** 받는 사람 선택 칩(누름 상태). */
export function OsChip({ pressed, disabled, onClick, name, children }: { pressed: boolean; disabled?: boolean; onClick: () => void; name: string; children: ReactNode }) {
  return <button type="button" className={s.chip} aria-pressed={pressed} disabled={disabled} onClick={onClick}><OsAvatar name={name} />{children}</button>;
}

/** 이름 머리글자 아바타(메일 목록·받는 사람 칩). */
export function OsAvatar({ name }: { name: string }) {
  const text = name.trim();
  return <span className={s.avatar} aria-hidden="true">{(Array.from(text)[0] ?? '·').toUpperCase()}</span>;
}

export const osStyles = s;
