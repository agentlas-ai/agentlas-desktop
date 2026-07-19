"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ipc } from "@/lib/ipc";
import type {
  OneOperatingPrinciple,
  OneOperatingPrincipleScope,
  OneProfile,
} from "@/lib/types";
import styles from "./OneProfileSheet.module.css";

interface OneProfileSheetProps {
  open: boolean;
  profile: OneProfile | null;
  locale: "ko" | "en";
  onClose: () => void;
  onProfileChange: (profile: OneProfile) => void;
}

function scopeLabel(scope: OneOperatingPrincipleScope, ko: boolean): string {
  const labels: Record<OneOperatingPrincipleScope, [string, string]> = {
    personal: ["개인", "Personal"],
    project: ["프로젝트", "Project"],
    agent: ["에이전트", "Agent"],
    team: ["팀", "Team"],
  };
  return labels[scope][ko ? 0 : 1];
}

function formatDate(value: string, locale: "ko" | "en"): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function OneProfileSheet({
  open,
  profile,
  locale,
  onClose,
  onProfileChange,
}: OneProfileSheetProps) {
  const ko = locale === "ko";
  const dialogRef = useRef<HTMLDivElement>(null);
  const hydratedVersionRef = useRef<number | null>(null);
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "One");
  const [role, setRole] = useState(profile?.role ?? "Agentlas One");
  const [profileContext, setProfileContext] = useState(profile?.profileContext ?? "");
  const [newContent, setNewContent] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile || hydratedVersionRef.current === profile.version) return;
    hydratedVersionRef.current = profile.version;
    setDisplayName(profile.displayName);
    setRole(profile.role);
    setProfileContext(profile.profileContext);
    if (editingId && !profile.operatingPrinciples.some((item) => item.id === editingId)) {
      setEditingId(null);
    }
  }, [editingId, profile]);

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    setError(null);
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => dialogRef.current?.querySelector<HTMLElement>("input, textarea, button")?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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

  if (!open) return null;

  const mutate = async (operation: () => Promise<OneProfile>, success: string) => {
    const api = ipc();
    if (!api) {
      setError(ko ? "Desktop 저장소에 연결되지 않았습니다." : "Desktop storage is unavailable.");
      return null;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await operation();
      onProfileChange(next);
      setMessage(success);
      return next;
    } catch (cause) {
      const latest = await api.oneProfile.get().catch(() => null);
      if (latest) onProfileChange(latest);
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    const api = ipc();
    if (!api || !profile) return;
    await mutate(
      () => api.oneProfile.update({
        expectedVersion: profile.version,
        patch: { displayName, role, profileContext },
      }),
      ko ? "One 프로필을 저장했습니다." : "One profile saved.",
    );
  };

  const addPrinciple = async (event: FormEvent) => {
    event.preventDefault();
    const api = ipc();
    if (!api || !profile) return;
    const next = await mutate(
      () => api.oneProfile.addPrinciple({
        expectedVersion: profile.version,
        content: newContent,
        scope: "personal",
        scopeRef: null,
        approvedByUser: true,
      }),
      ko ? "One이 지킬 내용으로 저장했어요." : "Saved as something One should follow.",
    );
    if (next) {
      setNewContent("");
    }
  };

  const beginEdit = (principle: OneOperatingPrinciple) => {
    setEditingId(principle.id);
    setEditContent(principle.content);
    setMessage(null);
    setError(null);
  };

  const savePrinciple = async (event: FormEvent, principle: OneOperatingPrinciple) => {
    event.preventDefault();
    const api = ipc();
    if (!api || !profile) return;
    const next = await mutate(
      () => api.oneProfile.updatePrinciple({
        expectedVersion: profile.version,
        principleId: principle.id,
        content: editContent,
        scope: principle.scope,
        scopeRef: principle.scopeRef,
        approvedByUser: true,
      }),
      ko ? "수정 내용을 다시 승인해 저장했습니다." : "Changes re-approved and saved.",
    );
    if (next) setEditingId(null);
  };

  const togglePrinciple = async (principle: OneOperatingPrinciple) => {
    const api = ipc();
    if (!api || !profile) return;
    await mutate(
      () => api.oneProfile.setPrincipleEnabled({
        expectedVersion: profile.version,
        principleId: principle.id,
        enabled: !principle.enabled,
      }),
      principle.enabled
        ? (ko ? "운영 원칙을 비활성화했습니다." : "Operating principle disabled.")
        : (ko ? "운영 원칙을 다시 활성화했습니다." : "Operating principle enabled."),
    );
  };

  const deletePrinciple = async (principle: OneOperatingPrinciple) => {
    const api = ipc();
    if (!api || !profile) return;
    const confirmed = window.confirm(ko
      ? "이 운영 원칙을 One에서 영구 삭제할까요?"
      : "Permanently delete this operating principle from One?");
    if (!confirmed) return;
    await mutate(
      () => api.oneProfile.deletePrinciple({
        expectedVersion: profile.version,
        principleId: principle.id,
      }),
      ko ? "운영 원칙을 삭제했습니다." : "Operating principle deleted.",
    );
  };

  return (
    <div className={styles.layer}>
      <button
        type="button"
        className={styles.scrim}
        aria-label={ko ? "One 프로필 닫기" : "Close One profile"}
        onClick={() => !busy && onClose()}
      />
      <div
        ref={dialogRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="one-profile-title"
      >
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>{ko ? "ONE 설정" : "ONE SETTINGS"}</p>
            <h2 id="one-profile-title">{ko ? "One이 나를 이해하는 방법" : "How One understands me"}</h2>
            <p>{ko
              ? "여기에 적고 저장한 내용만 다음 대화에도 사용합니다."
              : "Only what you write and save here is used in future conversations."}</p>
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} disabled={busy} aria-label={ko ? "닫기" : "Close"}>×</button>
        </header>

        {!profile ? (
          <div className={styles.loading} role="status">{ko ? "프로필을 불러오고 있어요…" : "Loading profile…"}</div>
        ) : (
          <div className={styles.content}>
            {(message || error) && (
              <p className={error ? styles.error : styles.message} role={error ? "alert" : "status"}>{error ?? message}</p>
            )}

            <form className={styles.section} onSubmit={saveProfile}>
              <div className={styles.sectionHeading}>
                <div>
                  <h3>{ko ? "기본 정보" : "Basics"}</h3>
                  <p>{ko ? "One이 나를 부르는 방법과 답변할 때 참고할 내용을 적어주세요." : "Choose how One addresses you and what it should keep in mind."}</p>
                </div>
              </div>
              <label>
                <span>{ko ? "이름" : "Name"}</span>
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={64} required disabled={busy} />
              </label>
              <label>
                <span>{ko ? "역할" : "Role"}</span>
                <input value={role} onChange={(event) => setRole(event.target.value)} maxLength={120} required disabled={busy} />
              </label>
              <label>
                <span>{ko ? "One이 알아둘 내용" : "What One should know"}</span>
                <textarea value={profileContext} onChange={(event) => setProfileContext(event.target.value)} maxLength={4_000} rows={4} disabled={busy} placeholder={ko ? "예: 나는 소규모 팀을 운영하고, 결론과 근거를 먼저 보고 싶다." : "Example: I run a small team and prefer the conclusion and evidence first."} />
              </label>
              <div className={styles.formActions}>
                <button type="submit" className={styles.primaryButton} disabled={busy}>{ko ? "프로필 저장" : "Save profile"}</button>
              </div>
            </form>

            <section className={styles.section} aria-labelledby="one-principles-title">
              <div className={styles.sectionHeading}>
                <div>
                  <h3 id="one-principles-title">{ko ? "One이 꼭 지킬 것" : "What One should always follow"}</h3>
                  <p>{ko
                    ? "내가 직접 저장한 내용만 들어갑니다. One이 마음대로 추가하지 않습니다."
                    : "Only things you save appear here. One never adds rules on its own."}</p>
                </div>
              </div>

              <form className={styles.principleComposer} onSubmit={addPrinciple}>
                <label className={styles.wideField}>
                  <span>{ko ? "새로 지킬 내용" : "New rule for One"}</span>
                  <textarea value={newContent} onChange={(event) => setNewContent(event.target.value)} maxLength={500} rows={3} required disabled={busy} placeholder={ko ? "예: 비용이 드는 외부 행동은 항상 실행 전에 확인한다." : "Example: Always confirm before an external action that costs money."} />
                </label>
                <div className={styles.formActions}>
                  <button type="submit" className={styles.primaryButton} disabled={busy || !newContent.trim()}>{ko ? "저장" : "Save"}</button>
                </div>
              </form>

              <div className={styles.principleList}>
                {profile.operatingPrinciples.length === 0 && (
                  <p className={styles.empty}>{ko ? "아직 저장한 내용이 없습니다." : "Nothing saved yet."}</p>
                )}
                {profile.operatingPrinciples.map((principle) => (
                  <article key={principle.id} className={styles.principleCard} data-enabled={principle.enabled ? "true" : "false"}>
                    {editingId === principle.id ? (
                      <form onSubmit={(event) => savePrinciple(event, principle)} className={styles.editForm}>
                        <label className={styles.wideField}>
                          <span>{ko ? "지킬 내용" : "Rule"}</span>
                          <textarea value={editContent} onChange={(event) => setEditContent(event.target.value)} maxLength={500} rows={3} required disabled={busy} />
                        </label>
                        <div className={styles.cardActions}>
                          <button type="submit" className={styles.primaryButton} disabled={busy}>{ko ? "저장" : "Save"}</button>
                          <button type="button" className={styles.secondaryButton} onClick={() => setEditingId(null)} disabled={busy}>{ko ? "취소" : "Cancel"}</button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className={styles.principleTop}>
                          <span className={styles.scopeBadge}>{scopeLabel(principle.scope, ko)}{principle.scopeRef ? ` · ${principle.scopeRef}` : ""}</span>
                          <span className={principle.enabled ? styles.enabledBadge : styles.disabledBadge}>{principle.enabled ? (ko ? "사용 중" : "Enabled") : (ko ? "비활성" : "Disabled")}</span>
                        </div>
                        <p className={styles.principleContent}>{principle.content}</p>
                        <p className={styles.approvalMeta}>{ko ? "내가 저장함" : "Saved by me"} · {formatDate(principle.approvedAt, locale)}{principle.updatedAt !== principle.approvedAt ? ` · ${ko ? "수정" : "Updated"} ${formatDate(principle.updatedAt, locale)}` : ""}</p>
                        <div className={styles.cardActions}>
                          <button type="button" className={styles.secondaryButton} onClick={() => beginEdit(principle)} disabled={busy}>{ko ? "수정" : "Edit"}</button>
                          <button type="button" className={styles.secondaryButton} onClick={() => void togglePrinciple(principle)} disabled={busy}>{principle.enabled ? (ko ? "비활성화" : "Disable") : (ko ? "활성화" : "Enable")}</button>
                          <button type="button" className={styles.dangerButton} onClick={() => void deletePrinciple(principle)} disabled={busy}>{ko ? "삭제" : "Delete"}</button>
                        </div>
                      </>
                    )}
                  </article>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
