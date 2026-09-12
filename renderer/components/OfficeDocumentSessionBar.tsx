"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  OfficeCapabilities,
  OfficeDocumentSession,
  OfficeEditIntent,
  OfficeTaskSelection,
} from "@/lib/office-document-session";
import { officeSelectionValue } from "@/lib/office-document-session";
import { createOfficeEditIntent } from "@/lib/office-document-session";
import styles from "./OfficeDocumentSessionBar.module.css";

const CAPABILITY_KEYS = ["read", "structure", "render", "edit", "calculate", "export", "nativeApp"] as const;

function selectionLabel(selection: OfficeTaskSelection, locale: "ko" | "en"): string {
  const anchor = selection.anchor;
  if (anchor.kind === "cell") return `${anchor.sheetName || (locale === "ko" ? "시트" : "Sheet")}!${anchor.address}`;
  if (anchor.kind === "page") return locale === "ko" ? `${anchor.pageNumber}쪽` : `Page ${anchor.pageNumber}`;
  if (anchor.kind === "slide") return locale === "ko" ? `${anchor.slideNumber}번 슬라이드` : `Slide ${anchor.slideNumber}`;
  return anchor.text;
}

function statusLabel(status: string, locale: "ko" | "en"): string {
  const labels = locale === "ko"
    ? { verified: "확인됨", available: "사용 가능", unverified: "미검증", unsupported: "지원 안 함" }
    : { verified: "Verified", available: "Available", unverified: "Unverified", unsupported: "Unsupported" };
  return labels[status as keyof typeof labels] ?? status;
}

function capabilityLabel(key: typeof CAPABILITY_KEYS[number], locale: "ko" | "en"): string {
  const ko = { read: "읽기", structure: "구조", render: "화면", edit: "원본 편집", calculate: "계산", export: "내보내기", nativeApp: "외부 앱" };
  const en = { read: "Read", structure: "Structure", render: "Render", edit: "File edit", calculate: "Calculate", export: "Export", nativeApp: "Native app" };
  return (locale === "ko" ? ko : en)[key];
}

export function OfficeDocumentSessionBar({
  locale,
  session,
  capabilities,
  formatReason,
  onDraftChange,
  onClearDraft,
  onDiscardDraftAndLoad,
  onSendSelection,
  onSendEdit,
}: {
  locale: "ko" | "en";
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
  const selection = session.selection;
  const editableValue = officeSelectionValue(selection);
  const pending = session.pendingEdit;
  const draftValue = pending?.replacementValue ?? editableValue ?? "";
  const canonical = Boolean(selection?.artifactRevision);
  const selectionCanSend = Boolean(selection && canonical && onSendSelection);
  const editCanSend = Boolean(pending && !session.conflict && pending.delivery !== "sending" && onSendEdit);
  const detail = useMemo(() => selection ? selectionLabel(selection, locale) : null, [locale, selection]);
  const ko = locale === "ko";

  useEffect(() => {
    setSelectionDelivery("idle");
  }, [selection?.selectionSequence, selection?.artifactRevision?.sha256]);

  const sendSelection = async () => {
    if (!selection || !selectionCanSend || !onSendSelection) return;
    setSelectionDelivery("sending");
    try {
      await onSendSelection(selection);
      setSelectionDelivery("sent");
    } catch {
      setSelectionDelivery("failed");
    }
  };

  return <section className={styles.bar} data-office-document-session="true" data-format={session.format ?? "unresolved"}>
    <div className={styles.summary}>
      <span className={styles.format}>{session.format?.toUpperCase() ?? (ko ? "형식 확인 필요" : "Format unresolved")}</span>
      <span className={styles.selection} title={detail ?? undefined}>{detail ?? (ko ? "페이지·셀·문장을 선택하세요" : "Select a page, cell, slide, or sentence")}</span>
      {selection ? <button type="button" onClick={() => void sendSelection()} disabled={!selectionCanSend || selectionDelivery === "sending"}>
        {selectionDelivery === "sending" ? (ko ? "전달 중…" : "Sending…") : (ko ? "현재 작업에 전달" : "Send to current task")}
      </button> : null}
      <details className={styles.capabilities}>
        <summary>{ko ? "기능 상태" : "Capabilities"}</summary>
        <div data-office-capabilities="true">
          {CAPABILITY_KEYS.map((key) => <span key={key} data-capability={key} data-status={capabilities[key].status} title={capabilities[key].reason}>
            {capabilityLabel(key, locale)} · {statusLabel(capabilities[key].status, locale)}
          </span>)}
          {formatReason && formatReason !== "resolved" ? <small>{formatReason}</small> : null}
        </div>
      </details>
    </div>

    {session.format === "xlsx" ? <p className={styles.calculation} data-office-calculation="unverified">
      {ko ? "수식과 저장된 값을 표시합니다. 이 화면에서는 수식을 다시 계산하지 않아 계산 결과는 미검증입니다." : "Formulas and stored values are shown. This viewer does not recalculate formulas, so calculation results are unverified."}
    </p> : null}

    {editableValue !== null && canonical ? <div className={styles.editRow} data-office-edit-boundary="true">
      <label>
        <span>{ko ? "편집 요청 초안" : "Edit request draft"}</span>
        <input value={draftValue} onChange={(event) => onDraftChange(event.currentTarget.value)} disabled={Boolean(session.conflict)} />
      </label>
      {pending ? <>
        <button type="button" onClick={onClearDraft}>{ko ? "초안 지우기" : "Clear draft"}</button>
        <button type="button" disabled={!editCanSend} onClick={() => {
          if (!onSendEdit) return;
          const operationId = window.crypto?.randomUUID ? window.crypto.randomUUID() : `office-${Date.now().toString(36)}`;
          const intent = createOfficeEditIntent(session, operationId);
          if (intent) void onSendEdit(intent);
        }}>{ko ? "현재 작업에 편집 요청" : "Request edit in current task"}</button>
      </> : null}
      <small>{ko ? "요청을 보내도 원본 파일이 저장된 것은 아닙니다. 새 원본이 저장됐는지 확인해야 합니다." : "Sending a request does not save the file. The saved source must be checked before the edit is complete."}</small>
    </div> : null}

    {session.conflict ? <div className={styles.conflict} role="alert" data-office-revision-conflict="true">
      <strong>{ko ? "원본이 바뀌었습니다. 편집 초안을 보존했습니다." : "The source changed. Your edit draft was preserved."}</strong>
      <p>{ko ? `내 초안: ${pending?.replacementValue ?? ""}` : `Your draft: ${pending?.replacementValue ?? ""}`}</p>
      <button type="button" onClick={onDiscardDraftAndLoad}>{ko ? "초안을 버리고 새 원본 열기" : "Discard draft and open new source"}</button>
      <details>
        <summary>{ko ? "기술 세부정보" : "Technical details"}</summary>
        <span>{session.conflict.base.sha256.slice(0, 12)} → {session.conflict.incoming.sha256.slice(0, 12)}</span>
      </details>
    </div> : null}

    {!canonical && selection ? <p className={styles.notice} role="status">
      {ko ? "원본 파일의 버전을 확인한 뒤 전달할 수 있습니다." : "This selection can be sent after the source file version is verified."}
    </p> : null}
    {selectionDelivery === "sent" || selectionDelivery === "failed" ? <span className={styles.delivery} role="status" data-status={selectionDelivery}>
      {selectionDelivery === "sent" ? (ko ? "선택을 전달했습니다" : "Selection sent") : (ko ? "선택을 전달하지 못했습니다" : "Selection failed")}
    </span> : null}
  </section>;
}
