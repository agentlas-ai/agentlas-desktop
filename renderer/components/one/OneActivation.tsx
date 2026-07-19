"use client";

import { useState } from "react";
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
  const ko = locale === "ko";
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
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "completed") {
    return (
      <section className={styles.card} data-one-activation-stage="first-value" aria-labelledby="one-activation-value-title">
        <p className={styles.eyebrow}>{ko ? "첫 번째 일 완료" : "First task complete"}</p>
        <h2 id="one-activation-value-title">{ko ? "첫 결과를 언제든 다시 볼 수 있어요." : "You can return to your first result anytime."}</h2>
        <p className={styles.body}>{ko
          ? "이 일과 확인된 결과는 다음에 다시 열 수 있어요. 휴대폰에서도 이어보려면 Desktop 연결 설정을 열 수 있습니다. 연결하지 않아도 One은 계속 사용할 수 있어요."
          : "This work and its confirmed result can be reopened later. Open Desktop settings to continue on mobile, or keep using One without pairing."}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void act(() => onResolveMobile("opened_settings"))}>
            {ko ? "모바일 연결 설정 열기" : "Open mobile connection settings"}
          </button>
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => void act(() => onResolveMobile("continued_without_pairing"))}>
            {ko ? "연결 없이 계속" : "Continue without pairing"}
          </button>
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </section>
    );
  }

  const concernResolved = state.concern.status === "resolved";
  return (
    <section className={styles.card} data-one-activation-stage={concernResolved ? "awaiting-value" : "concern"} aria-labelledby="one-activation-title">
      <p className={styles.eyebrow}>{ko ? "ONE 시작하기" : "START WITH ONE"}</p>
      <h2 id="one-activation-title">{concernResolved
        ? (ko ? "같은 대화에서 첫 번째 결과를 확인해보세요." : "Keep going in the same conversation toward a first result.")
        : (ko ? "지금 신경 쓰이는 일 한 가지를 말해주세요." : "Tell One one thing that is on your mind.")}</h2>
      <p className={styles.body}>{concernResolved
        ? (ko
            ? "같은 대화에서 계속 말해보세요. 실제 결과가 준비되면 확인하고 마무리할 수 있습니다."
            : "Keep talking in the same conversation. When a real result is ready, you can review it and finish the work.")
        : (ko
            ? "아래 입력창에 평소처럼 적어보세요. One이 먼저 살펴보기만 하고, 파일 변경이나 외부 전송은 시작 전에 꼭 물어봅니다."
            : "Use the box below as usual. One looks first and always asks before changing files or sending anything outside.")}</p>
      <p className={styles.distinction}>{ko
        ? "One은 무엇을 맡길지 함께 정하고, Work는 같은 일의 팀·파일·도구를 깊게 다루는 곳입니다."
        : "One helps decide what to delegate; Work is where you operate the same work's team, files, and tools in depth."}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => void act(onOpenWork)}>{ko ? "Work로 직접 가기" : "Go directly to Work"}</button>
        <button type="button" className={styles.textButton} disabled={busy} onClick={() => void act(onSkip)}>{ko ? "소개 건너뛰기" : "Skip introduction"}</button>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  );
}
