"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OfficeEditIntent, OfficeTaskSelection } from "@shared/office-document";
import type { OfficeTaskContextReceipt, OfficeTaskContextRequest } from "@shared/office-task-context";
import { ipc } from "./ipc";

type Submission = { request: OfficeTaskContextRequest; pending?: Promise<void>; acknowledged: boolean };

/** A renderer acknowledgement belongs to the chat that requested it, including
 * when the user leaves that chat and returns before its response arrives. */
export function useOfficeTaskContext(chatId: string | null | undefined) {
  const scope = useRef({ chatId, revision: null as number | null, submissions: new Map<string, Submission>() });
  if (scope.current.chatId !== chatId) scope.current = { chatId, revision: null, submissions: new Map() };
  const [view, setView] = useState<{ scope: typeof scope.current; context: OfficeTaskContextReceipt | null; error: boolean } | null>(null);

  useEffect(() => {
    const owner = scope.current;
    let active = true;
    if (chatId) void ipc()?.officeTaskContext?.get(chatId).then(value => {
      if (!active || scope.current !== owner) return;
      if (value.context && value.context.chatId !== chatId) return;
      owner.revision = value.revision;
      setView({ scope: owner, context: value.context, error: false });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [chatId]);

  const send = useCallback(async (selection: OfficeTaskSelection, edit?: OfficeEditIntent) => {
    const owner = scope.current;
    const api = ipc()?.officeTaskContext;
    if (!api || !chatId || owner.chatId !== chatId || owner.revision === null) throw new Error("office_context_unavailable");
    const key = JSON.stringify([selection, edit && [edit.draftSequence, edit.originalValue, edit.replacementValue]]);
    let submission = owner.submissions.get(key);
    if (submission?.acknowledged) return;
    if (submission?.pending) return submission.pending;
    if (!submission) {
      const operationId = edit?.operationId ?? window.crypto.randomUUID();
      submission = { request: { operationId, chatId, expectedContextRevision: owner.revision,
        selection, ...(edit ? { edit: { ...edit, operationId } } : {}) }, acknowledged: false };
      owner.submissions.set(key, submission);
    }
    const current = submission;
    current.pending = api.submit(current.request).then(result => {
      if (!result.ok) {
        if (scope.current === owner && result.reasonCode === "office_context_revision_conflict" && result.currentRevision !== undefined) {
          owner.revision = result.currentRevision;
          owner.submissions.delete(key);
        }
        throw new Error(result.reasonCode);
      }
      const receipt = result.receipt;
      if (receipt.chatId !== chatId || receipt.operationId !== current.request.operationId || receipt.status !== "acknowledged") throw new Error("office_context_receipt_mismatch");
      current.acknowledged = true;
      if (scope.current !== owner) return;
      owner.revision = receipt.revision;
      setView({ scope: owner, context: receipt, error: false });
    }).finally(() => { current.pending = undefined; });
    return current.pending;
  }, [chatId]);

  const clear = useCallback(async () => {
    const owner = scope.current;
    const api = ipc()?.officeTaskContext;
    if (!api || !chatId || owner.chatId !== chatId || owner.revision === null) return;
    try {
      const result = await api.clear({ chatId, expectedContextRevision: owner.revision });
      if (scope.current !== owner) return;
      owner.revision = result.revision;
      owner.submissions.clear();
      setView({ scope: owner, context: null, error: false });
    } catch {
      if (scope.current === owner) setView(previous => ({ scope: owner, context: previous?.scope === owner ? previous.context : null, error: true }));
    }
  }, [chatId]);

  return { context: view?.scope === scope.current ? view.context : null, error: view?.scope === scope.current && view.error, send, clear };
}
