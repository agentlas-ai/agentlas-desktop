"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ipc } from "@/lib/ipc";
import type {
  OneMemoryAsset,
  OneMemoryCandidate,
  OneMemoryScope,
  OneMemoryState,
  OneMemoryUseOnceReceipt,
  OneMemoryUseOnceTarget,
} from "@/lib/types";
import styles from "./OneMemorySheet.module.css";

interface OneMemorySheetProps {
  open: boolean;
  state: OneMemoryState | null;
  locale: "ko" | "en";
  useOnceTarget: OneMemoryUseOnceTarget | null;
  onClose: () => void;
  onStateChange: (state: OneMemoryState) => void;
  onUseOnceReady: (receipt: OneMemoryUseOnceReceipt, target: OneMemoryUseOnceTarget) => void;
}

function scopeLabel(scope: OneMemoryScope, ko: boolean): string {
  const labels: Record<OneMemoryScope, [string, string]> = {
    personal: ["개인", "Personal"],
    project: ["프로젝트", "Project"],
    agent: ["에이전트", "Agent"],
    team: ["팀", "Team"],
  };
  return labels[scope][ko ? 0 : 1];
}

function basisLabel(candidate: OneMemoryCandidate, ko: boolean): string {
  if (candidate.source.basis === "explicit_user_statement") return ko ? "내가 직접 말함" : "I stated this";
  if (candidate.source.basis === "user_correction") return ko ? "내 수정에서 제안됨" : "Suggested from my correction";
  return ko ? "One의 제안 · 아직 미승인" : "Suggested by One · not approved";
}

function resolutionLabel(candidate: OneMemoryCandidate, ko: boolean): string {
  if (candidate.status === "saved") return ko ? "기억에 저장됨" : "Saved to memory";
  if (candidate.status === "used_once") return ko ? "한 번만 사용 · 오래 기억하지 않음" : "Used once · not saved long term";
  if (candidate.status === "rejected") return ko ? "거절됨" : "Rejected";
  return ko ? "검토 대기" : "Pending review";
}

function formatDate(value: string, locale: "ko" | "en"): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function shortRef(value: string): string {
  return value.length > 22 ? `${value.slice(0, 9)}…${value.slice(-8)}` : value;
}

export function OneMemorySheet({
  open,
  state,
  locale,
  useOnceTarget,
  onClose,
  onStateChange,
  onUseOnceReady,
}: OneMemorySheetProps) {
  const ko = locale === "ko";
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busyIdRef = useRef<string | null>(null);
  busyIdRef.current = busyId;
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useOnceReceipt, setUseOnceReceipt] = useState<OneMemoryUseOnceReceipt | null>(null);
  const [editingCandidateId, setEditingCandidateId] = useState<string | null>(null);
  const [candidateContent, setCandidateContent] = useState("");
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [memoryContent, setMemoryContent] = useState("");

  const pending = useMemo(
    () => state?.candidates.filter((candidate) => candidate.status === "pending") ?? [],
    [state],
  );
  const resolved = useMemo(
    () => (state?.candidates.filter((candidate) => candidate.status !== "pending") ?? [])
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 12),
    [state],
  );

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    setError(null);
    setUseOnceReceipt(null);
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => dialogRef.current?.querySelector<HTMLElement>("button, textarea, input")?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyIdRef.current) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]",
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
      priorFocus?.focus();
    };
  }, [onClose, open]);

  useEffect(() => {
    if (editingCandidateId && !pending.some((candidate) => candidate.id === editingCandidateId)) {
      setEditingCandidateId(null);
    }
    if (editingMemoryId && !state?.memories.some((memory) => memory.id === editingMemoryId)) {
      setEditingMemoryId(null);
    }
  }, [editingCandidateId, editingMemoryId, pending, state]);

  if (!open) return null;

  const refresh = async () => {
    const api = ipc();
    if (!api) throw new Error(ko ? "이 컴퓨터의 One 기억을 불러올 수 없습니다." : "One's memory on this computer is unavailable.");
    const latest = await api.oneMemory.getState();
    onStateChange(latest);
    return latest;
  };

  const mutate = async (id: string, operation: () => Promise<unknown>, success: string) => {
    setBusyId(id);
    setMessage(null);
    setError(null);
    try {
      const value = await operation();
      await refresh();
      setMessage(success);
      return value;
    } catch (cause) {
      await refresh().catch(() => undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setBusyId(null);
    }
  };

  const beginCandidateEdit = (candidate: OneMemoryCandidate) => {
    setEditingCandidateId(candidate.id);
    setCandidateContent(candidate.normalizedPreview);
    setMessage(null);
    setError(null);
  };

  const saveCandidate = async (candidate: OneMemoryCandidate) => {
    const api = ipc();
    if (!api || !state) return;
    const result = await mutate(candidate.id, () => api.oneMemory.save({
      expectedStoreVersion: state.version,
      candidateId: candidate.id,
      expectedCandidateVersion: candidate.version,
      approvedByUser: true,
    }), ko ? "내가 확인한 내용으로 기억에 저장했습니다." : "Saved to memory with your approval.");
    if (result) setEditingCandidateId(null);
  };

  const editAndSaveCandidate = async (event: FormEvent, candidate: OneMemoryCandidate) => {
    event.preventDefault();
    const api = ipc();
    if (!api || !state) return;
    const result = await mutate(candidate.id, () => api.oneMemory.editAndSave({
      expectedStoreVersion: state.version,
      candidateId: candidate.id,
      expectedCandidateVersion: candidate.version,
      approvedByUser: true,
      content: candidateContent,
      scope: candidate.scope,
      scopeRef: candidate.scopeRef,
    }), ko ? "수정한 내용으로 기억에 저장했습니다." : "Saved the edited version to memory.");
    if (result) setEditingCandidateId(null);
  };

  const useCandidateOnce = async (candidate: OneMemoryCandidate) => {
    const api = ipc();
    if (!api || !state || !useOnceTarget) return;
    const result = await mutate(candidate.id, () => api.oneMemory.useOnce({
      expectedStoreVersion: state.version,
      candidateId: candidate.id,
      expectedCandidateVersion: candidate.version,
      target: useOnceTarget,
      confirmedByUser: true,
    }), ko ? "현재 대화의 다음 요청 1회에만 적용할 준비를 했습니다." : "Ready for the next request in this conversation only.");
    const receipt = result && typeof result === "object" && "value" in result
      ? (result as { value: OneMemoryUseOnceReceipt }).value
      : null;
    setUseOnceReceipt(receipt);
    if (receipt) onUseOnceReady(receipt, useOnceTarget);
  };

  const rejectCandidate = async (candidate: OneMemoryCandidate) => {
    const api = ipc();
    if (!api || !state) return;
    await mutate(candidate.id, () => api.oneMemory.reject({
      expectedStoreVersion: state.version,
      candidateId: candidate.id,
      expectedCandidateVersion: candidate.version,
      rejectedByUser: true,
    }), ko ? "거절했습니다. 같은 제안을 당분간 줄입니다." : "Rejected. Equivalent suggestions will be reduced for a while.");
  };

  const beginMemoryEdit = (memory: OneMemoryAsset) => {
    setEditingMemoryId(memory.id);
    setMemoryContent(memory.content);
    setMessage(null);
    setError(null);
  };

  const saveMemory = async (event: FormEvent, memory: OneMemoryAsset) => {
    event.preventDefault();
    const api = ipc();
    if (!api || !state) return;
    const result = await mutate(memory.id, () => api.oneMemory.updateAsset({
      expectedStoreVersion: state.version,
      memoryId: memory.id,
      expectedMemoryVersion: memory.version,
      content: memoryContent,
      scope: memory.scope,
      scopeRef: memory.scopeRef,
      approvedByUser: true,
    }), ko ? "수정 내용을 다시 승인해 저장했습니다." : "Changes re-approved and saved.");
    if (result) setEditingMemoryId(null);
  };

  const toggleMemory = async (memory: OneMemoryAsset) => {
    const api = ipc();
    if (!api || !state) return;
    await mutate(memory.id, () => api.oneMemory.setAssetEnabled({
      expectedStoreVersion: state.version,
      memoryId: memory.id,
      expectedMemoryVersion: memory.version,
      enabled: !memory.enabled,
      confirmedByUser: true,
    }), memory.enabled
      ? (ko ? "앞으로 이 기억을 사용하지 않습니다." : "One will stop using this memory.")
      : (ko ? "알맞은 다음 일에 이 기억을 다시 사용할 수 있습니다." : "One can use this memory again when it fits."));
  };

  const deleteMemory = async (memory: OneMemoryAsset) => {
    const api = ipc();
    if (!api || !state) return;
    if (!window.confirm(ko ? "이 기억을 One에서 영구 삭제할까요?" : "Permanently delete this memory from One?")) return;
    await mutate(memory.id, () => api.oneMemory.deleteAsset({
      expectedStoreVersion: state.version,
      memoryId: memory.id,
      expectedMemoryVersion: memory.version,
      confirmedByUser: true,
    }), ko ? "기억을 영구 삭제했습니다." : "Memory permanently deleted.");
  };

  const deleteResolvedCandidate = async (candidate: OneMemoryCandidate) => {
    const api = ipc();
    if (!api || !state) return;
    if (!window.confirm(ko ? "이 검토 기록을 영구 삭제할까요?" : "Permanently delete this review record?")) return;
    await mutate(candidate.id, () => api.oneMemory.deleteCandidate({
      expectedStoreVersion: state.version,
      candidateId: candidate.id,
      expectedCandidateVersion: candidate.version,
      confirmedByUser: true,
    }), ko ? "검토 기록을 삭제했습니다." : "Review record deleted.");
  };

  return (
    <div className={styles.layer}>
      <button type="button" className={styles.scrim} aria-label={ko ? "One의 기억 닫기" : "Close One's memory"} onClick={() => !busyId && onClose()} />
      <div ref={dialogRef} className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby="one-memory-title">
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>{ko ? "내가 정하는 기억" : "You stay in control"}</p>
            <h2 id="one-memory-title">{ko ? "One의 기억" : "What One remembers"}</h2>
            <p>{ko
              ? "One은 마음대로 기억하지 않아요. 내가 저장한 내용만 알맞은 다음 일에 사용합니다."
              : "One does not remember things on its own. It only uses items you choose to save, when they fit the next task."}</p>
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} disabled={Boolean(busyId)} aria-label={ko ? "닫기" : "Close"}>×</button>
        </header>

        {!state ? (
          <div className={styles.loading} role="status">{ko ? "기억을 불러오고 있어요…" : "Loading memory…"}</div>
        ) : (
          <div className={styles.content}>
            {(message || error) && <p className={error ? styles.error : styles.message} role={error ? "alert" : "status"}>{error ?? message}</p>}
            {useOnceReceipt && (
              <section className={styles.onceReceipt} aria-label={ko ? "한 번만 사용할 내용" : "One-time memory"}>
                <strong>{ko ? "다음 요청에 1회 적용" : "Applies to the next request once"}</strong>
                <p>{ko ? `만료: ${formatDate(useOnceReceipt.expiresAt, locale)}` : `Expires: ${formatDate(useOnceReceipt.expiresAt, locale)}`}</p>
                <small>{ko
                  ? "오래 기억하지 않습니다. 다음 요청에 한 번 쓰거나, 앱을 다시 켜거나, 시간이 지나면 사라집니다. 실패해도 자동으로 다시 쓰지 않습니다."
                  : "This is not saved long term. It disappears after one use, an app restart, or expiry, and is not reused automatically after a failure."}</small>
              </section>
            )}

            <section className={styles.section} aria-labelledby="memory-candidates-title">
              <div className={styles.sectionHeading}>
                <div>
                  <h3 id="memory-candidates-title">{ko ? `검토할 제안 ${pending.length}` : `Suggestions to review ${pending.length}`}</h3>
                  <p>{ko ? "저장, 수정 후 저장, 한 번만 사용, 거절 중 직접 고르기 전에는 재사용되지 않습니다." : "Nothing is reused until you choose Save, Edit and save, Use once, or Reject."}</p>
                </div>
              </div>
              <div className={styles.cardList}>
                {pending.length === 0 && <p className={styles.empty}>{ko ? "지금 확인할 기억 제안이 없습니다." : "There are no memory suggestions to review."}</p>}
                {pending.map((candidate) => (
                  <article key={candidate.id} className={styles.card}>
                    {editingCandidateId === candidate.id ? (
                      <form className={styles.editForm} onSubmit={(event) => void editAndSaveCandidate(event, candidate)}>
                        <label className={styles.wideField}>
                          <span>{ko ? "저장할 내용" : "Content to save"}</span>
                          <textarea value={candidateContent} onChange={(event) => setCandidateContent(event.target.value)} maxLength={500} rows={4} required disabled={Boolean(busyId)} />
                        </label>
                        <div className={styles.cardActions}>
                          <button type="submit" className={styles.primaryButton} disabled={Boolean(busyId) || !candidateContent.trim()}>{ko ? "수정 승인 후 저장" : "Approve edits and save"}</button>
                          <button type="button" className={styles.secondaryButton} onClick={() => setEditingCandidateId(null)} disabled={Boolean(busyId)}>{ko ? "취소" : "Cancel"}</button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className={styles.cardTop}>
                          <span className={styles.scopeBadge}>{ko ? `${scopeLabel(candidate.scope, ko)}에서 사용할 기억` : `For ${scopeLabel(candidate.scope, ko).toLowerCase()} use`}</span>
                          <span className={styles.pendingBadge}>{basisLabel(candidate, ko)}</span>
                        </div>
                        <p className={styles.cardContent}>{candidate.normalizedPreview}</p>
                        <details className={styles.sourceBox}>
                          <summary>{ko ? "왜 기억하자고 했는지 보기" : "Why One suggested this"}</summary>
                          <span>{ko ? "원래 일" : "Original work"} · {shortRef(candidate.source.sourceTaskId)}</span>
                          <span>{ko ? "확인한 곳" : "Source"} · {shortRef(candidate.source.sourceRef)}</span>
                          <span>{ko ? "확인 기록" : "Check records"} · {candidate.source.evidenceRefs.length}</span>
                          <span>{candidate.source.provenanceStatus === "verified"
                            ? (ko ? "수락 결과와 출처 확인됨" : "Bound to an accepted result")
                            : (ko ? "결과 수락 후 저장 가능" : "Accept the result before saving")}</span>
                          <span>{ko ? "다시 확인 권장" : "Review again after"} · {formatDate(candidate.reviewAfter, locale)}</span>
                        </details>
                        <div className={styles.cardActions}>
                          <button type="button" className={styles.primaryButton} onClick={() => void saveCandidate(candidate)} disabled={Boolean(busyId) || candidate.source.provenanceStatus !== "verified"}>{ko ? "기억에 저장" : "Save to memory"}</button>
                          <button type="button" className={styles.secondaryButton} onClick={() => beginCandidateEdit(candidate)} disabled={Boolean(busyId) || candidate.source.provenanceStatus !== "verified"}>{ko ? "수정 후 저장" : "Edit and save"}</button>
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            onClick={() => void useCandidateOnce(candidate)}
                            disabled={Boolean(busyId) || !useOnceTarget}
                            title={!useOnceTarget ? (ko ? "먼저 대화나 맡긴 일을 열어주세요." : "Open a conversation or delegated task first.") : undefined}
                          >{ko ? "한 번만 사용" : "Use once"}</button>
                          <button type="button" className={styles.dangerButton} onClick={() => void rejectCandidate(candidate)} disabled={Boolean(busyId)}>{ko ? "거절" : "Reject"}</button>
                        </div>
                      </>
                    )}
                  </article>
                ))}
              </div>
            </section>

            <section className={styles.section} aria-labelledby="saved-memory-title">
              <div className={styles.sectionHeading}>
                <div>
                  <h3 id="saved-memory-title">{ko ? `내가 저장한 기억 ${state.memories.length}` : `Memory I saved ${state.memories.length}`}</h3>
                  <p>{ko ? "One은 알맞은 일에서만 이 내용을 참고합니다. 기억을 썼다고 결과가 더 좋아졌다고 단정하지 않습니다." : "One uses these only when they fit. Using a memory does not automatically mean the result improved."}</p>
                </div>
              </div>
              <div className={styles.cardList}>
                {state.memories.length === 0 && <p className={styles.empty}>{ko ? "아직 내가 저장한 기억이 없습니다." : "You have not saved any memory yet."}</p>}
                {state.memories.map((memory) => (
                  <article key={memory.id} className={styles.card} data-enabled={memory.enabled ? "true" : "false"}>
                    {editingMemoryId === memory.id ? (
                      <form className={styles.editForm} onSubmit={(event) => void saveMemory(event, memory)}>
                        <label className={styles.wideField}>
                          <span>{ko ? "기억할 내용" : "What to remember"}</span>
                          <textarea value={memoryContent} onChange={(event) => setMemoryContent(event.target.value)} maxLength={500} rows={4} required disabled={Boolean(busyId)} />
                        </label>
                        <div className={styles.cardActions}>
                          <button type="submit" className={styles.primaryButton} disabled={Boolean(busyId) || !memoryContent.trim()}>{ko ? "다시 승인하고 저장" : "Re-approve and save"}</button>
                          <button type="button" className={styles.secondaryButton} onClick={() => setEditingMemoryId(null)} disabled={Boolean(busyId)}>{ko ? "취소" : "Cancel"}</button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className={styles.cardTop}>
                          <span className={styles.scopeBadge}>{ko ? `${scopeLabel(memory.scope, ko)}에서 사용할 기억` : `For ${scopeLabel(memory.scope, ko).toLowerCase()} use`}</span>
                          <span className={memory.enabled ? styles.enabledBadge : styles.disabledBadge}>{memory.enabled ? (ko ? "필요할 때 사용" : "Available when useful") : (ko ? "사용 안 함" : "Not in use")}</span>
                        </div>
                        <p className={styles.cardContent}>{memory.content}</p>
                        <details className={styles.sourceBox}>
                          <summary>{ko ? "기억의 출처 보기" : "View where this came from"}</summary>
                          <span>{ko ? "내가 승인함" : "Approved by me"} · {formatDate(memory.approvedAt, locale)}</span>
                          <span>{ko ? "원래 일" : "Original work"} · {shortRef(memory.sourceTaskId)}</span>
                          <span>{ko ? "확인 기록" : "Check records"} · {memory.evidenceRefs.length}</span>
                        </details>
                        <div className={styles.cardActions}>
                          <button type="button" className={styles.secondaryButton} onClick={() => beginMemoryEdit(memory)} disabled={Boolean(busyId)}>{ko ? "수정" : "Edit"}</button>
                          <button type="button" className={styles.secondaryButton} onClick={() => void toggleMemory(memory)} disabled={Boolean(busyId)}>{memory.enabled ? (ko ? "비활성화" : "Disable") : (ko ? "활성화" : "Enable")}</button>
                          <button type="button" className={styles.dangerButton} onClick={() => void deleteMemory(memory)} disabled={Boolean(busyId)}>{ko ? "삭제" : "Delete"}</button>
                        </div>
                      </>
                    )}
                  </article>
                ))}
              </div>
            </section>

            {resolved.length > 0 && <section className={styles.section} aria-labelledby="memory-history-title">
              <div className={styles.sectionHeading}>
                <div>
                  <h3 id="memory-history-title">{ko ? "최근 검토 기록" : "Recent review history"}</h3>
                  <p>{ko ? "저장 여부와 거절 상태를 추적하기 위한 기록입니다." : "A review ledger showing what was saved, used once, or rejected."}</p>
                </div>
              </div>
              <div className={styles.historyList}>
                {resolved.map((candidate) => <article key={candidate.id} className={styles.historyRow}>
                  <div>
                    <strong>{resolutionLabel(candidate, ko)}</strong>
                    <span>{candidate.normalizedPreview}</span>
                    <small>{formatDate(candidate.updatedAt, locale)} · {scopeLabel(candidate.scope, ko)}</small>
                  </div>
                  <button type="button" className={styles.textDangerButton} onClick={() => void deleteResolvedCandidate(candidate)} disabled={Boolean(busyId)}>{ko ? "기록 삭제" : "Delete record"}</button>
                </article>)}
              </div>
            </section>}
          </div>
        )}
      </div>
    </div>
  );
}
