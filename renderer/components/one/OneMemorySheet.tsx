"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ipc } from "@/lib/ipc";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import { tFor, type Locale } from "@/lib/i18n";
import type {
  OneExperienceReuseRecord,
  OneImprovementProofRecord,
  OneImprovementReusedAssetV1,
  OneMemoryAsset,
  OneMemoryCandidate,
  OneMemoryScope,
  OneMemoryState,
  OneMemoryUseOnceReceipt,
  OneMemoryUseOnceTarget,
  OneValueClosureRecord,
  OneValueClosureState,
} from "@/lib/types";
import { OneValueClosureCard } from "./OneValueClosureCard";
import { OneExperienceReuseCard } from "./OneExperienceReuseCard";
import { OneImprovementProofCard } from "./OneImprovementProofCard";
import styles from "./OneMemorySheet.module.css";

interface OneMemorySheetProps {
  open: boolean;
  state: OneMemoryState | null;
  locale: "ko" | "en";
  useOnceTarget: OneMemoryUseOnceTarget | null;
  onClose: () => void;
  onStateChange: (state: OneMemoryState) => void;
  onUseOnceReady: (receipt: OneMemoryUseOnceReceipt, target: OneMemoryUseOnceTarget) => void;
  /**
   * REQ-019 / REQ-023: compounding records stay out of the beginner-facing One
   * result, but they must still be openable and manageable somewhere. This
   * sheet is that place — it is already where `onManageExperience` points.
   */
  valueClosure?: OneValueClosureRecord | null;
  experienceReuse?: OneExperienceReuseRecord | null;
  improvementProof?: OneImprovementProofRecord | null;
  valueClosureState?: OneValueClosureState | null;
  onValueClosureStateChange?: (state: OneValueClosureState) => void;
  onManageImprovementAsset?: (asset: OneImprovementReusedAssetV1) => void;
}

function scopeLabel(scope: OneMemoryScope, locale: Locale): string {
  if (scope === "personal") return tFor(locale, "one.mem.scope.personal");
  if (scope === "project") return tFor(locale, "one.mem.scope.project");
  if (scope === "agent") return tFor(locale, "one.mem.scope.agent");
  return tFor(locale, "one.mem.scope.team");
}

function basisLabel(candidate: OneMemoryCandidate, locale: Locale): string {
  if (candidate.source.basis === "explicit_user_statement") return tFor(locale, "one.mem.basis.explicit");
  if (candidate.source.basis === "user_correction") return tFor(locale, "one.mem.basis.correction");
  return tFor(locale, "one.mem.basis.suggested");
}

function resolutionLabel(candidate: OneMemoryCandidate, locale: Locale): string {
  if (candidate.status === "saved") return tFor(locale, "one.mem.resolution.saved");
  if (candidate.status === "used_once") return tFor(locale, "one.mem.resolution.used_once");
  if (candidate.status === "rejected") return tFor(locale, "one.mem.resolution.rejected");
  return tFor(locale, "one.mem.resolution.pending");
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
  valueClosure = null,
  experienceReuse = null,
  improvementProof = null,
  valueClosureState = null,
  onValueClosureStateChange,
  onManageImprovementAsset,
}: OneMemorySheetProps) {
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
    if (!api) throw new Error(tFor(locale, "one.mem.err.unavailable"));
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
      requestOneOperationalRecovery("one-memory", cause);
      setError(null);
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
    if (!state) return;
    if (!api) {
      requestOneOperationalRecovery("one-memory", new Error("Desktop bridge unavailable"));
      return;
    }
    const result = await mutate(candidate.id, () => api.oneMemory.save({
      expectedStoreVersion: state.version,
      candidateId: candidate.id,
      expectedCandidateVersion: candidate.version,
      approvedByUser: true,
    }), tFor(locale, "one.mem.msg.saved_approved"));
    if (result) setEditingCandidateId(null);
  };

  const editAndSaveCandidate = async (event: FormEvent, candidate: OneMemoryCandidate) => {
    event.preventDefault();
    const api = ipc();
    if (!state) return;
    if (!api) {
      requestOneOperationalRecovery("one-memory", new Error("Desktop bridge unavailable"));
      return;
    }
    const result = await mutate(candidate.id, () => api.oneMemory.editAndSave({
      expectedStoreVersion: state.version,
      candidateId: candidate.id,
      expectedCandidateVersion: candidate.version,
      approvedByUser: true,
      content: candidateContent,
      scope: candidate.scope,
      scopeRef: candidate.scopeRef,
    }), tFor(locale, "one.mem.msg.saved_edited"));
    if (result) setEditingCandidateId(null);
  };

  const useCandidateOnce = async (candidate: OneMemoryCandidate) => {
    const api = ipc();
    if (!state || !useOnceTarget) return;
    if (!api) {
      requestOneOperationalRecovery("one-memory", new Error("Desktop bridge unavailable"));
      return;
    }
    const result = await mutate(candidate.id, () => api.oneMemory.useOnce({
      expectedStoreVersion: state.version,
      candidateId: candidate.id,
      expectedCandidateVersion: candidate.version,
      target: useOnceTarget,
      confirmedByUser: true,
    }), tFor(locale, "one.mem.msg.use_once_ready"));
    const receipt = result && typeof result === "object" && "value" in result
      ? (result as { value: OneMemoryUseOnceReceipt }).value
      : null;
    setUseOnceReceipt(receipt);
    if (receipt) onUseOnceReady(receipt, useOnceTarget);
  };

  const rejectCandidate = async (candidate: OneMemoryCandidate) => {
    const api = ipc();
    if (!state) return;
    if (!api) {
      requestOneOperationalRecovery("one-memory", new Error("Desktop bridge unavailable"));
      return;
    }
    await mutate(candidate.id, () => api.oneMemory.reject({
      expectedStoreVersion: state.version,
      candidateId: candidate.id,
      expectedCandidateVersion: candidate.version,
      rejectedByUser: true,
    }), tFor(locale, "one.mem.msg.rejected"));
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
    if (!state) return;
    if (!api) {
      requestOneOperationalRecovery("one-memory", new Error("Desktop bridge unavailable"));
      return;
    }
    const result = await mutate(memory.id, () => api.oneMemory.updateAsset({
      expectedStoreVersion: state.version,
      memoryId: memory.id,
      expectedMemoryVersion: memory.version,
      content: memoryContent,
      scope: memory.scope,
      scopeRef: memory.scopeRef,
      approvedByUser: true,
    }), tFor(locale, "one.mem.msg.reapproved"));
    if (result) setEditingMemoryId(null);
  };

  const toggleMemory = async (memory: OneMemoryAsset) => {
    const api = ipc();
    if (!state) return;
    if (!api) {
      requestOneOperationalRecovery("one-memory", new Error("Desktop bridge unavailable"));
      return;
    }
    await mutate(memory.id, () => api.oneMemory.setAssetEnabled({
      expectedStoreVersion: state.version,
      memoryId: memory.id,
      expectedMemoryVersion: memory.version,
      enabled: !memory.enabled,
      confirmedByUser: true,
    }), memory.enabled
      ? tFor(locale, "one.mem.msg.disabled")
      : tFor(locale, "one.mem.msg.enabled"));
  };

  const deleteMemory = async (memory: OneMemoryAsset) => {
    const api = ipc();
    if (!state) return;
    if (!api) {
      requestOneOperationalRecovery("one-memory", new Error("Desktop bridge unavailable"));
      return;
    }
    if (!window.confirm(tFor(locale, "one.mem.confirm.delete_memory"))) return;
    await mutate(memory.id, () => api.oneMemory.deleteAsset({
      expectedStoreVersion: state.version,
      memoryId: memory.id,
      expectedMemoryVersion: memory.version,
      confirmedByUser: true,
    }), tFor(locale, "one.mem.msg.memory_deleted"));
  };

  const deleteResolvedCandidate = async (candidate: OneMemoryCandidate) => {
    const api = ipc();
    if (!state) return;
    if (!api) {
      requestOneOperationalRecovery("one-memory", new Error("Desktop bridge unavailable"));
      return;
    }
    if (!window.confirm(tFor(locale, "one.mem.confirm.delete_record"))) return;
    await mutate(candidate.id, () => api.oneMemory.deleteCandidate({
      expectedStoreVersion: state.version,
      candidateId: candidate.id,
      expectedCandidateVersion: candidate.version,
      confirmedByUser: true,
    }), tFor(locale, "one.mem.msg.record_deleted"));
  };

  return (
    <div className={styles.layer}>
      <button type="button" className={styles.scrim} aria-label={tFor(locale, "one.mem.aria.close_memory")} onClick={() => !busyId && onClose()} />
      <div ref={dialogRef} className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby="one-memory-title">
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>{tFor(locale, "one.mem.header.eyebrow")}</p>
            <h2 id="one-memory-title">{tFor(locale, "one.mem.header.title")}</h2>
            <p>{tFor(locale, "one.mem.header.body")}</p>
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} disabled={Boolean(busyId)} aria-label={tFor(locale, "one.mem.aria.close")}>×</button>
        </header>

        {!state ? (
          <div className={styles.loading} role="status">{tFor(locale, "one.mem.loading")}</div>
        ) : (
          <div className={styles.content}>
            {(message || error) && <p className={error ? styles.error : styles.message} role={error ? "alert" : "status"}>{error ?? message}</p>}
            {useOnceReceipt && (
              <section className={styles.onceReceipt} aria-label={tFor(locale, "one.mem.once.aria")}>
                <strong>{tFor(locale, "one.mem.once.title")}</strong>
                <p>{tFor(locale, "one.mem.once.expires", { date: formatDate(useOnceReceipt.expiresAt, locale) })}</p>
                <small>{tFor(locale, "one.mem.once.note")}</small>
              </section>
            )}

            {valueClosure && (
              <section className={styles.section} aria-labelledby="memory-compounding-title">
                <div className={styles.sectionHeading}>
                  <div>
                    <h3 id="memory-compounding-title">{tFor(locale, "one.mem.compounding.title")}</h3>
                    <p>{tFor(locale, "one.mem.compounding.body")}</p>
                  </div>
                </div>
                <div className={styles.cardList}>
                  {valueClosureState && onValueClosureStateChange && (
                    <OneValueClosureCard
                      record={valueClosure}
                      state={valueClosureState}
                      locale={locale}
                      onStateChange={onValueClosureStateChange}
                    />
                  )}
                  {experienceReuse && (
                    <OneExperienceReuseCard record={experienceReuse} locale={locale} onManage={onClose} />
                  )}
                  {improvementProof && onManageImprovementAsset && (
                    <OneImprovementProofCard
                      record={improvementProof}
                      locale={locale}
                      onManageAsset={onManageImprovementAsset}
                    />
                  )}
                </div>
              </section>
            )}

            <section className={styles.section} aria-labelledby="memory-candidates-title">
              <div className={styles.sectionHeading}>
                <div>
                  <h3 id="memory-candidates-title">{tFor(locale, "one.mem.candidates.title", { n: pending.length })}</h3>
                  <p>{tFor(locale, "one.mem.candidates.body")}</p>
                </div>
              </div>
              <div className={styles.cardList}>
                {pending.length === 0 && <p className={styles.empty}>{tFor(locale, "one.mem.candidates.empty")}</p>}
                {pending.map((candidate) => (
                  <article key={candidate.id} className={styles.card}>
                    {editingCandidateId === candidate.id ? (
                      <form className={styles.editForm} onSubmit={(event) => void editAndSaveCandidate(event, candidate)}>
                        <label className={styles.wideField}>
                          <span>{tFor(locale, "one.mem.field.content_to_save")}</span>
                          <textarea value={candidateContent} onChange={(event) => setCandidateContent(event.target.value)} maxLength={500} rows={4} required disabled={Boolean(busyId)} />
                        </label>
                        <div className={styles.cardActions}>
                          <button type="submit" className={styles.primaryButton} disabled={Boolean(busyId) || !candidateContent.trim()}>{tFor(locale, "one.mem.action.approve_edits_save")}</button>
                          <button type="button" className={styles.secondaryButton} onClick={() => setEditingCandidateId(null)} disabled={Boolean(busyId)}>{tFor(locale, "one.mem.action.cancel")}</button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className={styles.cardTop}>
                          <span className={styles.scopeBadge}>{tFor(locale, "one.mem.scope.for_use", { scope: locale === "ko" ? scopeLabel(candidate.scope, locale) : scopeLabel(candidate.scope, locale).toLowerCase() })}</span>
                          <span className={styles.pendingBadge}>{basisLabel(candidate, locale)}</span>
                        </div>
                        <p className={styles.cardContent}>{candidate.normalizedPreview}</p>
                        <details className={styles.sourceBox}>
                          <summary>{tFor(locale, "one.mem.candidate.why_summary")}</summary>
                          <span>{tFor(locale, "one.mem.label.original_work")} · {shortRef(candidate.source.sourceTaskId)}</span>
                          <span>{tFor(locale, "one.mem.label.source")} · {shortRef(candidate.source.sourceRef)}</span>
                          <span>{tFor(locale, "one.mem.label.check_records")} · {candidate.source.evidenceRefs.length}</span>
                          <span>{candidate.source.provenanceStatus === "verified"
                            ? tFor(locale, "one.mem.provenance.verified")
                            : tFor(locale, "one.mem.provenance.unverified")}</span>
                          <span>{tFor(locale, "one.mem.label.review_again")} · {formatDate(candidate.reviewAfter, locale)}</span>
                        </details>
                        <div className={styles.cardActions}>
                          <button type="button" className={styles.primaryButton} onClick={() => void saveCandidate(candidate)} disabled={Boolean(busyId) || candidate.source.provenanceStatus !== "verified"}>{tFor(locale, "one.mem.action.save_to_memory")}</button>
                          <button type="button" className={styles.secondaryButton} onClick={() => beginCandidateEdit(candidate)} disabled={Boolean(busyId) || candidate.source.provenanceStatus !== "verified"}>{tFor(locale, "one.mem.action.edit_and_save")}</button>
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            onClick={() => void useCandidateOnce(candidate)}
                            disabled={Boolean(busyId) || !useOnceTarget}
                            title={!useOnceTarget ? tFor(locale, "one.mem.use_once_title") : undefined}
                          >{tFor(locale, "one.mem.action.use_once")}</button>
                          <button type="button" className={styles.dangerButton} onClick={() => void rejectCandidate(candidate)} disabled={Boolean(busyId)}>{tFor(locale, "one.mem.action.reject")}</button>
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
                  <h3 id="saved-memory-title">{tFor(locale, "one.mem.saved.title", { n: state.memories.length })}</h3>
                  <p>{tFor(locale, "one.mem.saved.body")}</p>
                </div>
              </div>
              <div className={styles.cardList}>
                {state.memories.length === 0 && <p className={styles.empty}>{tFor(locale, "one.mem.saved.empty")}</p>}
                {state.memories.map((memory) => (
                  <article key={memory.id} className={styles.card} data-enabled={memory.enabled ? "true" : "false"}>
                    {editingMemoryId === memory.id ? (
                      <form className={styles.editForm} onSubmit={(event) => void saveMemory(event, memory)}>
                        <label className={styles.wideField}>
                          <span>{tFor(locale, "one.mem.field.what_to_remember")}</span>
                          <textarea value={memoryContent} onChange={(event) => setMemoryContent(event.target.value)} maxLength={500} rows={4} required disabled={Boolean(busyId)} />
                        </label>
                        <div className={styles.cardActions}>
                          <button type="submit" className={styles.primaryButton} disabled={Boolean(busyId) || !memoryContent.trim()}>{tFor(locale, "one.mem.action.reapprove_save")}</button>
                          <button type="button" className={styles.secondaryButton} onClick={() => setEditingMemoryId(null)} disabled={Boolean(busyId)}>{tFor(locale, "one.mem.action.cancel")}</button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className={styles.cardTop}>
                          <span className={styles.scopeBadge}>{tFor(locale, "one.mem.scope.for_use", { scope: locale === "ko" ? scopeLabel(memory.scope, locale) : scopeLabel(memory.scope, locale).toLowerCase() })}</span>
                          <span className={memory.enabled ? styles.enabledBadge : styles.disabledBadge}>{memory.enabled ? tFor(locale, "one.mem.status.available") : tFor(locale, "one.mem.status.not_in_use")}</span>
                        </div>
                        <p className={styles.cardContent}>{memory.content}</p>
                        <details className={styles.sourceBox}>
                          <summary>{tFor(locale, "one.mem.memory.source_summary")}</summary>
                          <span>{tFor(locale, "one.mem.label.approved_by_me")} · {formatDate(memory.approvedAt, locale)}</span>
                          <span>{tFor(locale, "one.mem.label.original_work")} · {shortRef(memory.sourceTaskId)}</span>
                          <span>{tFor(locale, "one.mem.label.check_records")} · {memory.evidenceRefs.length}</span>
                        </details>
                        <div className={styles.cardActions}>
                          <button type="button" className={styles.secondaryButton} onClick={() => beginMemoryEdit(memory)} disabled={Boolean(busyId)}>{tFor(locale, "one.mem.action.edit")}</button>
                          <button type="button" className={styles.secondaryButton} onClick={() => void toggleMemory(memory)} disabled={Boolean(busyId)}>{memory.enabled ? tFor(locale, "one.mem.action.disable") : tFor(locale, "one.mem.action.enable")}</button>
                          <button type="button" className={styles.dangerButton} onClick={() => void deleteMemory(memory)} disabled={Boolean(busyId)}>{tFor(locale, "one.mem.action.delete")}</button>
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
                  <h3 id="memory-history-title">{tFor(locale, "one.mem.history.title")}</h3>
                  <p>{tFor(locale, "one.mem.history.body")}</p>
                </div>
              </div>
              <div className={styles.historyList}>
                {resolved.map((candidate) => <article key={candidate.id} className={styles.historyRow}>
                  <div>
                    <strong>{resolutionLabel(candidate, locale)}</strong>
                    <span>{candidate.normalizedPreview}</span>
                    <small>{formatDate(candidate.updatedAt, locale)} · {scopeLabel(candidate.scope, locale)}</small>
                  </div>
                  <button type="button" className={styles.textDangerButton} onClick={() => void deleteResolvedCandidate(candidate)} disabled={Boolean(busyId)}>{tFor(locale, "one.mem.action.delete_record")}</button>
                </article>)}
              </div>
            </section>}
          </div>
        )}
      </div>
    </div>
  );
}
