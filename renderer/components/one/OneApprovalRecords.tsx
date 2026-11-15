"use client";

/**
 * The one quiet line a conversation keeps where an approval card was (Agentlas 2.0 AL; pictures desktop-impl-gaps-9). The words, the order and the grouping are
 * in lib/approval-record-lines.ts; this draws one slot of the conversation (the lines between the same two messages). It draws a record, never a question: nothing
 * in it answers or cancels an approval. Same lines in the One / Work conversation, a group room (bubbles) and a work session (no bubbles).
 */
import { Fragment, useState } from "react";
import { IconCheck, IconChevronRight, IconClose, IconMonitor, IconSmartphone } from "@/components/Icon";
import {
  APPROVAL_GROUP_PREVIEW,
  approvalMoreWord,
  planApprovalLines,
  type ApprovalAutoGroup,
  type ApprovalLine,
  type ApprovalLineContext,
  type ApprovalLineIcon,
  type ApprovalLineRecord,
} from "@/lib/approval-record-lines";
import s from "./OneApprovalRecords.module.css";

function ExpiredIcon({ size = 17 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M6 6l12 12" /></svg>;
}
function AutoIcon({ size = 17 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 13l4 4L14 8.5" /><path d="M10 15.5l1.5 1.5L21 7" /></svg>;
}
function ResultIcon({ icon, size = 17 }: { icon: ApprovalLineIcon; size?: number }) {
  if (icon === "approved") return <IconCheck size={size} />;
  if (icon === "declined") return <IconClose size={size} />;
  if (icon === "expired") return <ExpiredIcon size={size} />;
  return <AutoIcon size={size} />;
}

function Right({ side, device, time }: { side: string | null; device: ApprovalLine["device"]; time: string }) {
  return (
    <span className={s.right}>
      {device === "desktop" ? <IconMonitor size={14} /> : device === "phone" ? <IconSmartphone size={14} /> : null}
      <span>{[side, time].filter(Boolean).join(" · ")}</span>
      <span className={s.chev} aria-hidden="true"><IconChevronRight size={14} /></span>
    </span>
  );
}

function Line({ line }: { line: ApprovalLine }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={s.row} aria-expanded={open} data-approval-line={line.icon} onClick={() => setOpen((v) => !v)}>
        <span className={s.icon} data-icon={line.icon}><ResultIcon icon={line.icon} /></span>
        <span className={s.left}><span className={s.result}>{line.result}</span>{line.kind ? ` · ${line.kind}` : ""}{` · ${line.target}`}</span>
        <Right side={line.side} device={line.device} time={line.time} />
      </button>
      {open && line.details.length > 0 && (
        <dl className={s.details} data-approval-details="true">
          {line.details.map((row) => <Fragment key={row.label}><dt className={s.dLabel}>{row.label}</dt><dd className={s.dValue} style={{ margin: 0 }}>{row.value}</dd></Fragment>)}
        </dl>
      )}
    </>
  );
}

function Group({ group, lang }: { group: ApprovalAutoGroup; lang: "ko" | "en" }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const shown = all ? group.lines : group.lines.slice(0, APPROVAL_GROUP_PREVIEW);
  const hidden = group.lines.length - shown.length;
  return (
    <>
      <button type="button" className={s.row} aria-expanded={open} data-approval-line="auto-group" onClick={() => setOpen((v) => !v)}>
        <span className={s.icon} data-icon="auto"><AutoIcon /></span>
        <span className={s.left}><span className={s.result}>{group.title}</span>{group.kind ? ` · ${group.kind}` : ""}</span>
        <Right side={group.side} device="always" time={group.time} />
      </button>
      {open && (
        <div className={s.groupLines} data-approval-group-lines="true">
          {shown.map((line) => (
            <div className={s.groupRow} key={line.id}>
              <span className={s.icon} data-icon="auto"><AutoIcon size={15} /></span>
              <span className={s.groupText}>{line.target}</span>
              <span className={s.groupTime}>{line.time}</span>
            </div>
          ))}
          {hidden > 0 && <button type="button" className={s.more} onClick={() => setAll(true)}>{approvalMoreWord(hidden, lang)}</button>}
        </div>
      )}
    </>
  );
}

export function ApprovalRecordLines({ records, ctx }: { records: readonly ApprovalLineRecord[]; ctx: ApprovalLineContext }) {
  if (records.length === 0) return null;
  const items = planApprovalLines(records, ctx);
  return (
    <div className={s.list} data-approval-records="true">
      {items.map((item) => item.type === "line"
        ? <Line key={item.line.id} line={item.line} />
        : <Group key={item.group.id} group={item.group} lang={ctx.lang} />)}
    </div>
  );
}
