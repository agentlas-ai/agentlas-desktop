"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import type { AgentMailStatus } from "@shared/agent-mail";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import { tFor, type Locale } from "@/lib/i18n";
import type {
  OneOperatingPrinciple,
  OneOperatingPrincipleScope,
  OneProfile,
} from "@/lib/types";
import { OneBottomSheet } from "./OneBottomSheet";
import { LoadingEstimate } from "@/components/LoadingEstimate";
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
  }, [onClose, open]);

  // One's own mail address lives on the server (agentMail.status); this sheet
  // only shows it and links to the mailbox, so name and address sit together.
  const router = useRouter();
  const ko = locale === "ko";
  const [mail, setMail] = useState<AgentMailStatus | null>(null);
  const [mailBusy, setMailBusy] = useState(false);
  const [mailNotice, setMailNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void ipc()?.agentMail?.status().then((next) => { if (alive) setMail(next); }).catch(() => undefined);
    return () => { alive = false; };
  }, [open]);

  if (!open) return null;

  const mailOk = mail && mail.ok ? mail : null;
  const mailAddress = mailOk?.mailbox?.status === "active" ? mailOk.mailbox.address : null;
  const issueMail = async () => {
    const api = ipc()?.agentMail;
    if (!api || mailBusy) return;
    setMailBusy(true);
    setMailNotice(null);
    try {
      const res = await api.issue({ displayName: profile?.displayName });
      if (!res.ok) setMailNotice(res.message || res.code);
      setMail(await api.status());
    } catch (cause) {
      setMailNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMailBusy(false);
    }
  };

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
    <OneBottomSheet
      open={open}
      onClose={onClose}
      closeLabel={tFor(locale, "one.prof.close_aria")}
      ariaLabelledBy="one-profile-title"
      size="wide"
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
      eyebrow={tFor(locale, "one.prof.eyebrow")}
      title={tFor(locale, "one.prof.title")}
      titleId="one-profile-title"
      description={profileSubtitle(locale)}
    >
        {!profile ? (
          <div className={styles.loading} role="status"><span>{tFor(locale, "one.prof.loading")}</span><LoadingEstimate locale={locale} operationKey="one-profile-load" expectedSeconds={[1, 15]} /></div>
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

            <section className={styles.section} aria-labelledby="one-mail-title" data-one-profile-mail>
              <div className={styles.sectionHeading}>
                <div>
                  <h3 id="one-mail-title">{ko ? "메일 주소" : "Mail address"}</h3>
                  <p>{ko ? "이 주소로 메일을 받고 보냅니다." : "Mail is received and sent from this address."}</p>
                </div>
              </div>
              {mailAddress ? (
                <p className={styles.principleContent} data-one-profile-mail-address>{mailAddress}</p>
              ) : mailOk && !mailOk.signedIn ? (
                <p className={styles.empty}>{ko ? "Agentlas에 로그인하면 사용할 수 있습니다." : "Sign in to Agentlas to use agent mail."}</p>
              ) : mailOk?.entitlement?.available ? (
                <p className={styles.empty}>{ko ? "아직 주소가 없습니다." : "No address yet."}</p>
              ) : mailOk ? (
                <p className={styles.empty}>{ko ? "에이전트 메일은 Pro·Max·WoW 요금제에 포함됩니다." : "Agent mail is included with Pro, Max and WoW."}</p>
              ) : null}
              {mailNotice && <p className={styles.error} role="alert">{mailNotice}</p>}
              <div className={styles.formActions}>
                {mailAddress ? (
                  <button type="button" className={styles.secondaryButton} onClick={() => void navigator.clipboard?.writeText(mailAddress)}>{ko ? "복사" : "Copy"}</button>
                ) : mailOk?.entitlement?.available ? (
                  <button type="button" className={styles.primaryButton} disabled={mailBusy} onClick={() => void issueMail()}>{mailBusy ? (ko ? "만드는 중…" : "Creating…") : ko ? "주소 받기" : "Get address"}</button>
                ) : null}
                <button type="button" className={styles.secondaryButton} onClick={() => { onClose(); router.push("/settings"); }}>{ko ? "메일함 열기" : "Open mailbox"}</button>
              </div>
            </section>

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
    </OneBottomSheet>
  );
}
