"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconAlertTriangle, IconArrowUp, IconCheck, IconClose, IconEdit, IconMoreHorizontal } from "@/components/Icon";
import type {
  OfficeCapabilities,
  OfficeDocumentSession,
  OfficeEditIntent,
  OfficeTaskSelection,
} from "@/lib/office-document-session";
import { officeSelectionValue } from "@/lib/office-document-session";
import { createOfficeEditIntent } from "@/lib/office-document-session";
import styles from "./OfficeDocumentSessionBar.module.css";
import menu from "./PanelPopover.module.css";

function selectionLabel(selection: OfficeTaskSelection, locale: "ko" | "en"): string {
  const anchor = selection.anchor;
  if (anchor.kind === "cell") return `${anchor.sheetName || (locale === "ko" ? "시트" : "Sheet")}!${anchor.address}`;
  if (anchor.kind === "page") return locale === "ko" ? `${anchor.pageNumber}쪽` : `Page ${anchor.pageNumber}`;
  if (anchor.kind === "slide") return locale === "ko" ? `${anchor.slideNumber}번 슬라이드` : `Slide ${anchor.slideNumber}`;
  return anchor.text;
}

export function OfficeDocumentSessionBar({
  locale,
  name,
  session,
  capabilities,
  onDraftChange,
  onClearDraft,
  onDiscardDraftAndLoad,
  onSendSelection,
  onSendEdit,
}: {
  locale: "ko" | "en";
  name?: string;
  session: OfficeDocumentSession;
  capabilities: OfficeCapabilities;
  formatReason?: string;
  onDraftChange: (value: string) => void;
  onClearDraft: () => void;
  onDiscardDraftAndLoad: () => void;
  onSendSelection?: (selection: OfficeTaskSelection) => void | Promise<void>;
  onSendEdit?: (intent: OfficeEditIntent) => void | Promise<void>;
}) {
  const [selectionDelivery, setSelectionDelivery] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [popup, setPopup] = useState<"edit" | "info" | "conflict" | null>(null);
  const barRef = useRef<HTMLElement>(null);
  const popupButton = useRef<HTMLButtonElement | null>(null);
  const selection = session.selection;
  const selectionKey = `${selection?.artifactRevision?.sha256 ?? ""}:${selection?.selectionSequence ?? ""}`;
  const selectionKeyRef = useRef(selectionKey); selectionKeyRef.current = selectionKey;
  const editableValue = officeSelectionValue(selection);
  const pending = session.pendingEdit;
  const draftValue = pending?.replacementValue ?? editableValue ?? "";
  const canonical = Boolean(selection?.artifactRevision);
  const selectionCanSend = Boolean(selection && canonical && onSendSelection);
  const editCanSend = Boolean(pending && !session.conflict && pending.delivery !== "sending" && onSendEdit);
  const detail = useMemo(() => selection ? selectionLabel(selection, locale) : null, [locale, selection]);
  const ko = locale === "ko";
  const unboundSelectionReason = ko ? "이 파일에서는 선택 전달을 사용할 수 없습니다" : "Selection sharing is unavailable for this file";

  useEffect(() => {
    setSelectionDelivery("idle");
  }, [selection?.selectionSequence, selection?.artifactRevision?.sha256]);
  useEffect(() => {
    if (!popup) return;
    if (popup === "edit") barRef.current?.querySelector<HTMLInputElement>("[data-office-edit-boundary] input")?.focus();
    const outside = (event: PointerEvent) => { if (!barRef.current?.contains(event.target as Node)) setPopup(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setPopup(null); popupButton.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [popup]);

  const sendSelection = async () => {
    if (!selection || !selectionCanSend || !onSendSelection) return;
    const sentKey = selectionKeyRef.current;
    setSelectionDelivery("sending");
    try {
      await onSendSelection(selection);
      if (selectionKeyRef.current === sentKey) setSelectionDelivery("sent");
    } catch {
      if (selectionKeyRef.current === sentKey) setSelectionDelivery("failed");
    }
  };

  return <section ref={barRef} className={styles.bar} data-office-document-session="true" data-format={session.format ?? "unresolved"} data-office-render={capabilities.render.status} data-office-edit={capabilities.edit.status} data-office-calculate={capabilities.calculate.status}>
    <div className={styles.summary}>
      <span className={styles.format}>{session.format?.toUpperCase() ?? (ko ? "형식 확인 필요" : "Format unresolved")}</span>
      <span className={styles.selection} title={detail ?? name}>{detail ?? name ?? (ko ? "페이지·셀·문장을 선택하세요" : "Select a page, cell, slide, or sentence")}</span>
      {selection ? <button type="button" title={selectionDelivery === "failed" ? (ko ? "전달 실패 · 다시 시도" : "Sharing failed · Retry") : !canonical ? unboundSelectionReason : ko ? "현재 작업에 전달" : "Send to current task"} aria-label={ko ? "현재 작업에 전달" : "Send to current task"} onClick={() => void sendSelection()} disabled={!selectionCanSend || selectionDelivery === "sending"}>
        {selectionDelivery === "failed" ? <IconAlertTriangle size={15} /> : selectionDelivery === "sent" ? <IconCheck size={15} /> : <IconArrowUp size={15} />}
      </button> : null}
      {editableValue !== null && canonical ? <button type="button" title={pending?.delivery === "failed" ? (ko ? "편집 요청 실패 · 다시 시도" : "Edit request failed · Retry") : ko ? "선택한 내용 편집 요청" : "Edit selected content"} aria-label={ko ? "선택한 내용 편집 요청" : "Edit selected content"} aria-expanded={popup === "edit"} onClick={event => { popupButton.current = event.currentTarget; setPopup(value => value === "edit" ? null : "edit"); }}>{pending?.delivery === "failed" ? <IconAlertTriangle size={15} /> : <IconEdit size={15} />}</button> : null}
      <button type="button" title={ko ? "문서 메뉴" : "Document menu"} aria-label={ko ? "문서 메뉴" : "Document menu"} aria-expanded={popup === "info"} aria-haspopup="dialog" onClick={event => { popupButton.current = event.currentTarget; setPopup(value => value === "info" ? null : "info"); }}><IconMoreHorizontal size={17} /></button>
      {session.conflict ? <button type="button" className={styles.conflictIndicator} title={ko ? "편집 충돌 · 초안 확인" : "Edit conflict · Review draft"} aria-label={ko ? "편집 충돌 · 초안 확인" : "Edit conflict · Review draft"} aria-expanded={popup === "conflict"} onClick={event => { popupButton.current = event.currentTarget; setPopup(value => value === "conflict" ? null : "conflict"); }}><IconAlertTriangle size={15} /></button> : null}
      {popup === "info" && <div className={`${menu.panelPopover} ${styles.capabilities}`} role="dialog" aria-label={ko ? "문서 메뉴" : "Document menu"}>
        <span className={menu.panelMenuLabel}>{name ?? session.format?.toUpperCase()}</span>
        <button type="button" className={menu.panelMenuRow} disabled={!selectionCanSend || selectionDelivery === "sending"} title={!canonical ? unboundSelectionReason : undefined} onClick={() => { setPopup(null); void sendSelection(); }}><IconArrowUp size={15} />{ko ? "선택 전달" : "Share selection"}</button>
        <button type="button" className={menu.panelMenuRow} disabled={editableValue === null || !canonical || !onSendEdit || Boolean(session.conflict)} onClick={() => setPopup("edit")}><IconEdit size={15} />{ko ? "편집 요청" : "Request edit"}</button>
        {pending && !session.conflict ? <button type="button" className={menu.panelMenuRow} onClick={() => { onClearDraft(); setPopup(null); }}><IconClose size={15} />{ko ? "초안 지우기" : "Clear draft"}</button> : null}
        {session.format === "xlsx" ? <span className={menu.panelMenuLabel} data-office-calculation="unverified" title={ko ? "파일에 저장된 계산 결과를 표시합니다. 다시 계산하지 않습니다." : "Shows the calculation results saved in the file without recalculating."}>{ko ? "저장된 계산 결과" : "Saved calculation results"}</span> : null}
      </div>}

    </div>

    {popup === "edit" && editableValue !== null && canonical ? <div className={`${menu.panelPopover} ${styles.editRow}`} data-office-edit-boundary="true" role="dialog" aria-label={ko ? "편집 요청" : "Edit request"}>
      <label>
        <span>{pending?.selection ? selectionLabel(pending.selection, locale) : detail}</span>
        <input value={draftValue} onChange={(event) => onDraftChange(event.currentTarget.value)} disabled={Boolean(session.conflict)} />
      </label>
      {pending ? <>
        <button type="button" onClick={onClearDraft}>{ko ? "초안 지우기" : "Clear draft"}</button>
        <button type="button" disabled={!editCanSend} onClick={() => {
          if (!onSendEdit) return;
          const operationId = window.crypto?.randomUUID ? window.crypto.randomUUID() : `office-${Date.now().toString(36)}`;
          const intent = createOfficeEditIntent(session, operationId);
          if (intent) void (async () => {
            try { await onSendEdit(intent); }
            catch { /* The document session preserves the failed draft for retry. */ }
          })();
        }}>{ko ? "현재 작업에 편집 요청" : "Request edit in current task"}</button>
      </> : null}
    </div> : null}

    {session.conflict && popup === "conflict" ? <div className={`${menu.panelPopover} ${styles.conflict}`} role="dialog" aria-label={ko ? "초안 확인" : "Review draft"} data-office-revision-conflict="true">
      <p>{ko ? "파일이 변경됐습니다. 초안은 보존했습니다." : "The file changed. Your draft is preserved."}</p>
      <p className={styles.conflictDraft}>{pending?.replacementValue ?? ""}</p>
      <button type="button" className={menu.panelMenuRow} onClick={() => setPopup(null)}>{ko ? "초안 유지" : "Keep draft"}</button>
      <button type="button" className={menu.panelMenuRow} onClick={() => { onDiscardDraftAndLoad(); setPopup(null); }}>{ko ? "초안을 지우고 파일 열기" : "Discard draft and open file"}</button>
    </div> : null}

  </section>;
}
