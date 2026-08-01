"use client";

import { useState } from "react";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import { tFor } from "@/lib/i18n";
import type {
  OneActivationMobileResolution,
  OneActivationState,
} from "@shared/one-activation";
import styles from "./OneActivation.module.css";

export function OneActivation({
  state,
  locale,
  blocked,
  onSkip,
  onOpenWork,
  onResolveMobile,
}: {
  state: OneActivationState | null;
  locale: "ko" | "en";
  blocked: boolean;
  onSkip: () => Promise<void> | void;
  onOpenWork: () => Promise<void> | void;
  onResolveMobile: (resolution: OneActivationMobileResolution) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (
    !state
    || blocked
    || state.eligibility !== "eligible_first_use"
    || state.status === "skipped"
    || state.status === "ineligible"
    || (state.status === "completed" && state.mobileConnection.status !== "offered")
  ) return null;

  const act = async (action: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      requestOneOperationalRecovery("one-activation", cause);
      setError(null);
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "completed") {
    return (
      <section className={styles.card} data-one-activation-stage="first-value" aria-labelledby="one-activation-value-title">
        <p className={styles.eyebrow}>{tFor(locale, "one.act.first_done")}</p>
        <h2 id="one-activation-value-title">{tFor(locale, "one.act.value_title")}</h2>
        <p className={styles.body}>{tFor(locale, "one.act.value_body")}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void act(() => onResolveMobile("opened_settings"))}>
            {tFor(locale, "one.act.open_mobile")}
          </button>
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => void act(() => onResolveMobile("continued_without_pairing"))}>
            {tFor(locale, "one.act.continue_no_pair")}
          </button>
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </section>
    );
  }

  const concernResolved = state.concern.status === "resolved";
  return (
    <section className={styles.card} data-one-activation-stage={concernResolved ? "awaiting-value" : "concern"} aria-labelledby="one-activation-title">
      <p className={styles.eyebrow}>{tFor(locale, "one.act.start_eyebrow")}</p>
      <h2 id="one-activation-title">{concernResolved
        ? tFor(locale, "one.act.title_resolved")
        : tFor(locale, "one.act.title_concern")}</h2>
      <p className={styles.body}>{concernResolved
        ? tFor(locale, "one.act.body_resolved")
        : tFor(locale, "one.act.body_concern")}</p>
      <p className={styles.distinction}>{tFor(locale, "one.act.distinction")}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => void act(onOpenWork)}>{tFor(locale, "one.act.go_work")}</button>
        <button type="button" className={styles.textButton} disabled={busy} onClick={() => void act(onSkip)}>{tFor(locale, "one.act.skip_intro")}</button>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  );
}
