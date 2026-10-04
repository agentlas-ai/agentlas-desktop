"use client";

import {
  useCallback,
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
import { OneBottomSheet } from "./OneBottomSheet";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import type { OneDurableMemoryEntryUi } from "@shared/types";
import type { OneMemoryMapSnapshot } from "@shared/one-memory-map";
import { OneMemoryMap, ONE_MEMORY_KIND_COLORS } from "./OneMemoryMap";
import { IconAlertTriangle, IconFileText, IconLayers, IconRoute, IconSearch, IconSparkles, IconTarget, IconTrash, IconUser } from "@/components/Icon";
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

function formatShortDate(value: string, locale: "ko" | "en"): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", { month: "numeric", day: "numeric" });
}

function shortRef(value: string): string {
  return value.length > 22 ? `${value.slice(0, 9)}…${value.slice(-8)}` : value;
}

/** Memory kinds as the owner reads them: an icon, a word, a colour (owner 2026-10-04: visuals, no filler). */
const KIND_ICON: Record<string, typeof IconRoute> = {
  procedure: IconRoute, decision: IconTarget, preference: IconUser, risk: IconAlertTriangle,
  fact: IconFileText, hypothesis: IconSparkles,
};
function kindLabel(kind: string, locale: Locale): string {
  const ko: Record<string, string> = { procedure: "방법", decision: "결정", preference: "선호", risk: "위험", fact: "사실",
    hypothesis: "가설", evidence: "근거", deprecation: "폐기", conflict: "충돌" };
  const en: Record<string, string> = { procedure: "How-to", decision: "Decision", preference: "Preference", risk: "Risk", fact: "Fact",
    hypothesis: "Hypothesis", evidence: "Evidence", deprecation: "Retired", conflict: "Conflict" };
  return (locale === "ko" ? ko : en)[kind] ?? kind;
}
function KindIcon({ kind, size = 14 }: { kind: string; size?: number }) {
  const Icon = KIND_ICON[kind] ?? IconLayers;
  return <span className={styles.kindIcon} style={{ color: ONE_MEMORY_KIND_COLORS[kind] ?? "#8a8d92" }} aria-hidden="true"><Icon size={size} /></span>;
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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useOnceReceipt, setUseOnceReceipt] = useState<OneMemoryUseOnceReceipt | null>(null);
  // What One actually remembers (the rows the memory map is drawn from). Loaded
  // when the sheet opens; the sheet and the map must agree on the count.
  const [durable, setDurable] = useState<OneDurableMemoryEntryUi[] | null>(null);
  const [durableError, setDurableError] = useState(false);
  const [durableRetry, setDurableRetry] = useState(0);
  const [durableQuery, setDurableQuery] = useState("");
  const [durableExpanded, setDurableExpanded] = useState(false);
  const [memoryMap, setMemoryMap] = useState<OneMemoryMapSnapshot | null>(null);
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [selectedMemory, setSelectedMemory] = useState<string | null>(null);
  const durableRequest = useRef(0);
  useEffect(() => {
    const request = ++durableRequest.current;
    // A closed sheet forgets its last read, so reopening shows "loading" instead of the old count for a frame.
    if (!open) { setDurable(null); setMemoryMap(null); setSelectedMemory(null); return; }
    setBusyId(null);
    setDurable(null);
    setDurableError(false);
    const api = ipc();
    if (!api?.oneMemory?.listEntries) {
      setDurableError(true);
      return;
    }
    api.oneMemory.listEntries({ limit: 1000 })
      .then((rows) => {
        if (request !== durableRequest.current) return;
        if (!Array.isArray(rows)) { setDurableError(true); return; }
        setDurable(rows);
      })
      .catch(() => { if (request === durableRequest.current) setDurableError(true); });
    // The map is a picture of the same entries; without it the list still works.
    void api.oneMemory.getMap?.().then((map) => { if (request === durableRequest.current) setMemoryMap(map); }).catch(() => undefined);
    return () => { ++durableRequest.current; };
  }, [open, durableRetry]);
  const forgetDurable = async (entry: OneDurableMemoryEntryUi) => {
    const api = ipc();
    if (!api?.oneMemory?.forgetEntry) return;
    const request = ++durableRequest.current;
    setBusyId(entry.id);
    setMessage(null);
    setError(null);
    try {
      const result = await api.oneMemory.forgetEntry({ memoryId: entry.id });
      if (request !== durableRequest.current) return;
      // Main may revoke several duplicate rows. Replace the complete projection
      // instead of leaving another forgotten row visible until the sheet reopens.
      setDurable(null);
      const rows = await api.oneMemory.listEntries({ limit: 1000 });
      if (request !== durableRequest.current) return;
      setDurable(rows);
      void api.oneMemory.getMap?.().then((map) => { if (request === durableRequest.current) setMemoryMap(map); }).catch(() => undefined);
      if (result.ok) {
        setMessage(locale === "ko" ? "잊었어요. 기억 지도에서도 사라집니다." : "Forgotten. It leaves the memory map too.");
        setError(null);
      }
    } catch (cause) {
      if (request === durableRequest.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === durableRequest.current) setBusyId(null);
    }
  };
  const durableFiltered = useMemo(() => {
    const rows = durable ?? [];
    const query = durableQuery.trim().toLowerCase();
    const ofKind = kindFilter ? rows.filter((row) => row.kind === kindFilter) : rows;
    const filtered = query
      ? ofKind.filter((row) => row.title.toLowerCase().includes(query) || row.content.toLowerCase().includes(query) || (row.projectSlug ?? "").toLowerCase().includes(query) || row.kind.toLowerCase().includes(query))
      : ofKind;
    // The memory picked on the map is always in view, first.
    const picked = selectedMemory ? filtered.find((row) => row.id === selectedMemory) : undefined;
    const ordered = picked ? [picked, ...filtered.filter((row) => row !== picked)] : filtered;
    return durableExpanded || query || kindFilter ? ordered : ordered.slice(0, 8);
  }, [durable, durableQuery, durableExpanded, kindFilter, selectedMemory]);
  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of durable ?? []) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [durable]);
  const describeMemory = useCallback((id: string) => {
    const row = durable?.find((entry) => entry.id === id);
    return row ? { label: kindLabel(row.kind, locale), text: row.content } : null;
  }, [durable, locale]);
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
    <OneBottomSheet
      open={open}
      onClose={onClose}
      closeLabel={tFor(locale, "one.mem.aria.close_memory")}
      ariaLabelledBy="one-memory-title"
      size="wide"
      closeOnBackdrop={!busyId}
      closeOnEscape={!busyId}
      closeDisabled={Boolean(busyId)}
      title={tFor(locale, "one.mem.header.title")}
      titleId="one-memory-title"
    >
        {!state ? (
          <div className={styles.loading} role="status"><span>{tFor(locale, "one.mem.loading")}</span><LoadingEstimate locale={locale} operationKey="one-memory-load" expectedSeconds={[1, 15]} /></div>
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

            <section className={styles.section} aria-labelledby="durable-memory-title" data-one-durable-memory="true">
              <h3 id="durable-memory-title" className={styles.memoryCount}>
                {locale === "ko" ? "기억" : "Memories"} <span>{durable ? durable.length : durableError ? "!" : "…"}</span>
              </h3>
              {memoryMap && memoryMap.nodes.length > 0 && (
                <div className={styles.memoryMap} data-one-memory-sheet-map="true">
                  <OneMemoryMap snapshot={memoryMap} locale={locale === "ko" ? "ko" : "en"} height={232} colorByKind
                    selectedId={selectedMemory} onSelect={setSelectedMemory} describe={describeMemory} />
                </div>
              )}
              {kindCounts.length > 1 && (
                <div className={styles.kindChips} role="group" aria-label={locale === "ko" ? "종류" : "Kind"}>
                  <button type="button" data-hover="own" data-active={kindFilter === null ? "true" : "false"} onClick={() => setKindFilter(null)}>
                    {locale === "ko" ? "전체" : "All"} <small>{durable?.length ?? 0}</small>
                  </button>
                  {kindCounts.map(([kind, count]) => (
                    <button key={kind} type="button" data-hover="own" data-kind={kind} data-active={kindFilter === kind ? "true" : "false"}
                      onClick={() => setKindFilter((current) => current === kind ? null : kind)}>
                      <KindIcon kind={kind} size={13} />{kindLabel(kind, locale)} <small>{count}</small>
                    </button>
                  ))}
                </div>
              )}
              {durable && durable.length > 8 && (
                <label className={styles.memorySearch}>
                  <IconSearch size={14} />
                  <input
                    type="search"
                    value={durableQuery}
                    onChange={(event) => setDurableQuery(event.target.value)}
                    placeholder={locale === "ko" ? "검색" : "Search"}
                    aria-label={locale === "ko" ? "기억 검색" : "Search memories"}
                  />
                </label>
              )}
              <div className={styles.memoryList}>
                {durableError ? (
                  <div>
                    <p className={styles.error} role="alert">{locale === "ko" ? "기억을 불러오지 못했습니다. 다시 시도해 주세요." : "Memories could not be loaded. Try again."}</p>
                    <button type="button" className={styles.secondaryButton} onClick={() => setDurableRetry(value => value + 1)} disabled={Boolean(busyId)}>{locale === "ko" ? "기억 다시 불러오기" : "Retry loading memories"}</button>
                  </div>
                ) : durable === null ? (
                  <p className={styles.empty} role="status">{locale === "ko" ? "기억을 불러오는 중입니다." : "Loading memories."}</p>
                ) : null}
                {durable && durable.length === 0 && (
                  <p className={styles.empty}>{locale === "ko" ? "아직 One이 남긴 기억이 없어요. 대화하고 일을 맡기면 여기에 쌓입니다." : "One has not kept anything yet. It fills up as you talk and delegate work."}</p>
                )}
                {durableFiltered.map((entry) => (
                  <article key={entry.id} className={styles.memoryRow} data-durable-entry="true" data-kind={entry.kind}
                    data-selected={selectedMemory === entry.id ? "true" : undefined}
                    onClick={() => setSelectedMemory((current) => current === entry.id ? null : entry.id)}>
                    <KindIcon kind={entry.kind} />
                    <p title={entry.content}>{entry.title || entry.content}</p>
                    <time dateTime={entry.createdAt}>{formatShortDate(entry.createdAt, locale)}</time>
                    <button type="button" className={styles.forgetIcon} data-hover="own" onClick={(event) => { event.stopPropagation(); void forgetDurable(entry); }}
                      disabled={Boolean(busyId)} aria-label={locale === "ko" ? "잊기" : "Forget"} title={locale === "ko" ? "잊기" : "Forget"}>
                      <IconTrash size={14} />
                    </button>
                    {/* The title is the ticket's line; the memory itself opens under it. */}
                    {selectedMemory === entry.id && entry.title && entry.title !== entry.content && <p className={styles.memoryDetail}>{entry.content}</p>}
                  </article>
                ))}
                {durable && !durableExpanded && !durableQuery.trim() && durable.length > 8 && (
                  <button type="button" className={styles.secondaryButton} onClick={() => setDurableExpanded(true)}>
                    {locale === "ko" ? `${durable.length - 8}개 더 보기` : `Show ${durable.length - 8} more`}
                  </button>
                )}
              </div>
            </section>

            {/* Empty review/saved lists carry no information — hide them (owner 2026-08-16). */}
            {pending.length > 0 && (
              <section className={styles.section} aria-labelledby="memory-candidates-title">
                <div className={styles.sectionHeading}>
                  <div>
                    <h3 id="memory-candidates-title">{tFor(locale, "one.mem.candidates.title", { n: pending.length })}</h3>
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
            )}

            {state.memories.length > 0 && (
              <section className={styles.section} aria-labelledby="saved-memory-title">
                <div className={styles.sectionHeading}>
                  <div>
                    <h3 id="saved-memory-title">{tFor(locale, "one.mem.saved.title", { n: state.memories.length })}</h3>
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
            )}

            {resolved.length > 0 && <section className={styles.section} aria-labelledby="memory-history-title">
              <div className={styles.sectionHeading}>
                <div>
                  <h3 id="memory-history-title">{tFor(locale, "one.mem.history.title")}</h3>
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
    </OneBottomSheet>
  );
}
