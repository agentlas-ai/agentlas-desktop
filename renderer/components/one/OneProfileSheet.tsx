"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ipc } from "@/lib/ipc";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import { tFor, type Locale } from "@/lib/i18n";
import type {
  OneOperatingPrinciple,
  OneOperatingPrincipleScope,
  OneProfile,
} from "@/lib/types";
import styles from "./OneProfileSheet.module.css";

const PROFILE_SUBTITLE_FALLBACK: Record<Locale, string> = {
  ko: "여기에 적고 저장한 내용만 다음 대화에도 사용합니다.",
  en: "Only what you write and save here is used in future conversations.",
};

function profileSubtitle(locale: Locale): string {
  const key = "one.prof.subtitle" as const;
  const value = tFor(locale, key);
  return value === key ? PROFILE_SUBTITLE_FALLBACK[locale] : value;
}

interface OneProfileSheetProps {
  open: boolean;
  profile: OneProfile | null;
  locale: "ko" | "en";
  onClose: () => void;
  onProfileChange: (profile: OneProfile) => void;
}

function scopeLabel(scope: OneOperatingPrincipleScope, locale: Locale): string {
  const keys = {
    personal: "one.prof.scope.personal",
    project: "one.prof.scope.project",
    agent: "one.prof.scope.agent",
    team: "one.prof.scope.team",
  } as const;
  return tFor(locale, keys[scope]);
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
      requestOneOperationalRecovery("one-profile", new Error("Desktop bridge unavailable"));
      setError(null);
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
      requestOneOperationalRecovery("one-profile", cause);
      setError(null);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    const api = ipc();
    if (!profile) return;
    if (!api) {
      requestOneOperationalRecovery("one-profile", new Error("Desktop bridge unavailable"));
      return;
    }
    await mutate(
      () => api.oneProfile.update({
        expectedVersion: profile.version,
        patch: { displayName, role, profileContext },
      }),
      tFor(locale, "one.prof.msg.profile_saved"),
    );
  };

  const addPrinciple = async (event: FormEvent) => {
    event.preventDefault();
    const api = ipc();
    if (!profile) return;
    if (!api) {
      requestOneOperationalRecovery("one-profile", new Error("Desktop bridge unavailable"));
      return;
    }
    const next = await mutate(
      () => api.oneProfile.addPrinciple({
        expectedVersion: profile.version,
        content: newContent,
        scope: "personal",
        scopeRef: null,
        approvedByUser: true,
      }),
      tFor(locale, "one.prof.msg.principle_added"),
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
    if (!profile) return;
    if (!api) {
      requestOneOperationalRecovery("one-profile", new Error("Desktop bridge unavailable"));
      return;
    }
    const next = await mutate(
      () => api.oneProfile.updatePrinciple({
        expectedVersion: profile.version,
        principleId: principle.id,
        content: editContent,
        scope: principle.scope,
        scopeRef: principle.scopeRef,
        approvedByUser: true,
      }),
      tFor(locale, "one.prof.msg.principle_updated"),
    );
    if (next) setEditingId(null);
  };

  const togglePrinciple = async (principle: OneOperatingPrinciple) => {
    const api = ipc();
    if (!profile) return;
    if (!api) {
      requestOneOperationalRecovery("one-profile", new Error("Desktop bridge unavailable"));
      return;
    }
    await mutate(
      () => api.oneProfile.setPrincipleEnabled({
        expectedVersion: profile.version,
        principleId: principle.id,
        enabled: !principle.enabled,
      }),
      principle.enabled
        ? tFor(locale, "one.prof.msg.principle_disabled")
        : tFor(locale, "one.prof.msg.principle_enabled"),
    );
  };

  const deletePrinciple = async (principle: OneOperatingPrinciple) => {
    const api = ipc();
    if (!profile) return;
    if (!api) {
      requestOneOperationalRecovery("one-profile", new Error("Desktop bridge unavailable"));
      return;
    }
    const confirmed = window.confirm(tFor(locale, "one.prof.confirm.delete"));
    if (!confirmed) return;
    await mutate(
      () => api.oneProfile.deletePrinciple({
        expectedVersion: profile.version,
        principleId: principle.id,
      }),
      tFor(locale, "one.prof.msg.principle_deleted"),
    );
  };

  return (
    <div className={styles.layer}>
      <button
        type="button"
        className={styles.scrim}
        aria-label={tFor(locale, "one.prof.close_aria")}
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
            <p className={styles.eyebrow}>{tFor(locale, "one.prof.eyebrow")}</p>
            <h2 id="one-profile-title">{tFor(locale, "one.prof.title")}</h2>
            <p>{profileSubtitle(locale)}</p>
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} disabled={busy} aria-label={tFor(locale, "one.prof.close")}>×</button>
        </header>

        {!profile ? (
          <div className={styles.loading} role="status">{tFor(locale, "one.prof.loading")}</div>
        ) : (
          <div className={styles.content}>
            {(message || error) && (
              <p className={error ? styles.error : styles.message} role={error ? "alert" : "status"}>{error ?? message}</p>
            )}

            <form className={styles.section} onSubmit={saveProfile}>
              <div className={styles.sectionHeading}>
                <div>
                  <h3>{tFor(locale, "one.prof.basics.title")}</h3>
                  <p>{tFor(locale, "one.prof.basics.desc")}</p>
                </div>
              </div>
              <label>
                <span>{tFor(locale, "one.prof.field.name")}</span>
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={64} required disabled={busy} />
              </label>
              <label>
                <span>{tFor(locale, "one.prof.field.role")}</span>
                <input value={role} onChange={(event) => setRole(event.target.value)} maxLength={120} required disabled={busy} />
              </label>
              <label>
                <span>{tFor(locale, "one.prof.field.context")}</span>
                <textarea value={profileContext} onChange={(event) => setProfileContext(event.target.value)} maxLength={4_000} rows={4} disabled={busy} placeholder={tFor(locale, "one.prof.field.context_ph")} />
              </label>
              <div className={styles.formActions}>
                <button type="submit" className={styles.primaryButton} disabled={busy}>{tFor(locale, "one.prof.save_profile")}</button>
              </div>
            </form>

            <section className={styles.section} aria-labelledby="one-principles-title">
              <div className={styles.sectionHeading}>
                <div>
                  <h3 id="one-principles-title">{tFor(locale, "one.prof.principles.title")}</h3>
                  <p>{tFor(locale, "one.prof.principles.desc")}</p>
                </div>
              </div>

              <form className={styles.principleComposer} onSubmit={addPrinciple}>
                <label className={styles.wideField}>
                  <span>{tFor(locale, "one.prof.new_rule")}</span>
                  <textarea value={newContent} onChange={(event) => setNewContent(event.target.value)} maxLength={500} rows={3} required disabled={busy} placeholder={tFor(locale, "one.prof.new_rule_ph")} />
                </label>
                <div className={styles.formActions}>
                  <button type="submit" className={styles.primaryButton} disabled={busy || !newContent.trim()}>{tFor(locale, "one.prof.save")}</button>
                </div>
              </form>

              <div className={styles.principleList}>
                {profile.operatingPrinciples.length === 0 && (
                  <p className={styles.empty}>{tFor(locale, "one.prof.empty")}</p>
                )}
                {profile.operatingPrinciples.map((principle) => (
                  <article key={principle.id} className={styles.principleCard} data-enabled={principle.enabled ? "true" : "false"}>
                    {editingId === principle.id ? (
                      <form onSubmit={(event) => savePrinciple(event, principle)} className={styles.editForm}>
                        <label className={styles.wideField}>
                          <span>{tFor(locale, "one.prof.rule_label")}</span>
                          <textarea value={editContent} onChange={(event) => setEditContent(event.target.value)} maxLength={500} rows={3} required disabled={busy} />
                        </label>
                        <div className={styles.cardActions}>
                          <button type="submit" className={styles.primaryButton} disabled={busy}>{tFor(locale, "one.prof.save")}</button>
                          <button type="button" className={styles.secondaryButton} onClick={() => setEditingId(null)} disabled={busy}>{tFor(locale, "one.prof.cancel")}</button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className={styles.principleTop}>
                          <span className={styles.scopeBadge}>{scopeLabel(principle.scope, locale)}{principle.scopeRef ? ` · ${principle.scopeRef}` : ""}</span>
                          <span className={principle.enabled ? styles.enabledBadge : styles.disabledBadge}>{principle.enabled ? tFor(locale, "one.prof.badge.enabled") : tFor(locale, "one.prof.badge.disabled")}</span>
                        </div>
                        <p className={styles.principleContent}>{principle.content}</p>
                        <p className={styles.approvalMeta}>{tFor(locale, "one.prof.saved_by_me")} · {formatDate(principle.approvedAt, locale)}{principle.updatedAt !== principle.approvedAt ? ` · ${tFor(locale, "one.prof.updated")} ${formatDate(principle.updatedAt, locale)}` : ""}</p>
                        <div className={styles.cardActions}>
                          <button type="button" className={styles.secondaryButton} onClick={() => beginEdit(principle)} disabled={busy}>{tFor(locale, "one.prof.action.edit")}</button>
                          <button type="button" className={styles.secondaryButton} onClick={() => void togglePrinciple(principle)} disabled={busy}>{principle.enabled ? tFor(locale, "one.prof.action.disable") : tFor(locale, "one.prof.action.enable")}</button>
                          <button type="button" className={styles.dangerButton} onClick={() => void deletePrinciple(principle)} disabled={busy}>{tFor(locale, "one.prof.action.delete")}</button>
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
