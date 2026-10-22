"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconBolt, IconCircleDollar, IconCloud } from "@/components/Icon";
import { ipc, ipcEvents } from "@/lib/ipc";
import {
  oneFrontFallbackCopy,
  oneFrontNoticeCopy,
  type OneFrontView,
  type PersonalAgentFront,
} from "@shared/one-front";
import { OneBottomSheet } from "./OneBottomSheet";
import styles from "./PersonalOneFront.module.css";

type Locale = "ko" | "en";

/**
 * The personal agent's front (shared/one-front.ts): where its conversation turns are processed. Main owns the state and
 * the confirmation; this file only reads it and carries the owner's own choices back. Nothing here sends anything.
 */
export function useOneFront() {
  const [view, setView] = useState<OneFrontView | null>(null);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const api = ipc()?.oneFront;
      if (!api) return;
      const next = await api.getState();
      if (!mounted.current) return;
      setView(next);
      setFailed(false);
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    // The settings page, the personal window and the phone may each change it: follow Main's change event.
    const off = ipcEvents()?.onStoreChanged?.((change) => { if (change.entity === "one-profile") void refresh(); });
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { mounted.current = false; off?.(); window.removeEventListener("focus", focus); };
  }, [refresh]);
  const setFront = useCallback(async (front: PersonalAgentFront) => {
    const api = ipc()?.oneFront;
    if (!api || !view) return false;
    try {
      setView(await api.setFront({ expectedVersion: view.version, front, confirmedByUser: true }));
      setFailed(false);
      return true;
    } catch {
      // A stale version or a refused write: show what Main holds, never what was asked for.
      setFailed(true);
      void refresh();
      return false;
    }
  }, [refresh, view]);
  const answerNotice = useCallback(async (resolution: "confirm" | "keep-own-lane") => {
    const api = ipc()?.oneFront;
    if (!api || !view) return false;
    try {
      setView(await api.acknowledgeNotice({ expectedVersion: view.version, resolution, confirmedByUser: true }));
      setFailed(false);
      return true;
    } catch {
      setFailed(true);
      void refresh();
      return false;
    }
  }, [refresh, view]);
  return { view, failed, setFront, answerNotice, refresh };
}

export type OneFrontController = ReturnType<typeof useOneFront>;

/** Shown while the owner has turned the front on and has not answered the one-time notice. Nothing is sent before then. */
export function pendingOneFrontNotice(view: OneFrontView | null): boolean {
  return Boolean(view && view.front === "agentlas" && view.notice === "unseen");
}

/**
 * The one-time notice. It opens the first time the personal agent is opened with the front turned on; Escape closes it
 * without answering (nothing is sent, and it asks again the next time), and the backdrop does not dismiss it.
 */
export function OneFrontNotice({ controller, locale }: { controller: OneFrontController; locale: Locale }) {
  const { view, failed, answerNotice } = controller;
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDismissed(false);
    const reopen = () => { if (!document.hidden) setDismissed(false); };
    window.addEventListener("focus", reopen);
    document.addEventListener("visibilitychange", reopen);
    return () => {
      window.removeEventListener("focus", reopen);
      document.removeEventListener("visibilitychange", reopen);
    };
  }, [view?.front, view?.notice]);
  const copy = oneFrontNoticeCopy(locale);
  const open = pendingOneFrontNotice(view) && !dismissed;
  // A neutral first focus: a stray Enter keeps the owner's own CLI (nothing leaves the machine) instead of confirming.
  const keepAvailable = Boolean(view?.ownLaneAvailable);
  const answer = async (resolution: "confirm" | "keep-own-lane") => {
    if (busy) return;
    setBusy(true);
    try { await answerNotice(resolution); } finally { setBusy(false); }
  };
  const icons = [<IconBolt key="fast" size={16} />, <IconCloud key="cloud" size={16} />, <IconCircleDollar key="cost" size={16} />];
  return <OneBottomSheet
    open={open}
    onClose={() => setDismissed(true)}
    closeLabel={locale === "ko" ? "나중에 하기" : "Decide later"}
    ariaLabel={copy.title}
    dialogRole="alertdialog"
    size="compact"
    closeOnBackdrop={false}
    hideHeaderClose
    dataAttributes={{ "data-one-front-notice": "true" }}
    title={copy.title}
    titleId="one-front-notice-title"
    ariaDescribedBy="one-front-notice-body"
    footer={<>
      {keepAvailable && <button type="button" className={styles.secondary} data-popup-autofocus="true" disabled={busy} onClick={() => void answer("keep-own-lane")}>{copy.keepOwnLane}</button>}
      <button type="button" className={styles.primary} {...(keepAvailable ? {} : { "data-popup-autofocus": "true" })} disabled={busy} onClick={() => void answer("confirm")}>{copy.confirm}</button>
    </>}
  >
    <ul id="one-front-notice-body" className={styles.rows}>
      {copy.body.map((line, index) => <li key={line}><span className={styles.mark} aria-hidden="true">{icons[index]}</span><span>{line}</span></li>)}
    </ul>
    {failed && <p role="status" className={styles.problem}>{locale === "ko" ? "저장을 확인하지 못했습니다. 다시 눌러 주세요." : "Could not confirm the save. Please try again."}</p>}
  </OneBottomSheet>;
}

/** The settings row: a switch with the same words the notice uses, so turning it on is an informed choice. */
export function OneFrontSetting({ controller, locale, withNotice = false }: { controller: OneFrontController; locale: Locale; withNotice?: boolean }) {
  const { view, failed, setFront } = controller;
  const copy = oneFrontNoticeCopy(locale);
  const [busy, setBusy] = useState(false);
  const on = view?.front === "agentlas";
  const waiting = pendingOneFrontNotice(view);
  const toggle = async () => {
    if (!view || busy) return;
    setBusy(true);
    try { await setFront(on ? "own-lane" : "agentlas"); } finally { setBusy(false); }
  };
  return <div className={styles.setting} data-one-front-setting="true">
    <div className={styles.settingCopy}>
      <strong id="one-front-setting-label">{copy.settingsLabel}</strong>
      <span id="one-front-setting-hint">{copy.settingsHint}</span>
      {waiting && <span role="status" className={styles.pending}>{locale === "ko" ? "확인 안내에서 [확인]을 누르면 적용됩니다." : "It applies once you press OK in the notice."}</span>}
      {failed && <span role="status" className={styles.problem}>{locale === "ko" ? "설정을 확인하지 못했습니다. 다시 시도해 주세요." : "Could not confirm the setting. Please try again."}</span>}
    </div>
    <button type="button" className={styles.switch} role="switch" aria-checked={on} aria-labelledby="one-front-setting-label" aria-describedby="one-front-setting-hint"
      data-on={on ? "true" : "false"} disabled={!view || busy} onClick={() => void toggle()}><span /></button>
    {withNotice && <OneFrontNotice controller={controller} locale={locale} />}
  </div>;
}

/**
 * The composer's model chip while the front is on: the owner does not pick a model for the personal agent then, so the chip
 * is a fixed label (no model name) that opens the setting where it is turned off.
 */
export function OneFrontChip({ locale, onOpenSetting }: { locale: Locale; onOpenSetting: () => void }) {
  const label = locale === "ko" ? "빠른 답변 · Agentlas" : "Fast replies · Agentlas";
  return <button type="button" className={styles.chip} data-one-front-chip="true" onClick={onOpenSetting}
    aria-label={locale === "ko" ? `${label}. 설정 열기` : `${label}. Open setting`}
    title={locale === "ko" ? "개인 에이전트의 빠른 답변은 Agentlas에서 처리됩니다. 눌러서 설정을 바꿀 수 있어요." : "Fast replies are handled on Agentlas. Press to change the setting."}>
    <IconBolt size={14} /><span>{label}</span>
  </button>;
}

/** One quiet line when the newest turn went to the owner's own CLI instead; it goes away when the light model answers again. */
export function OneFrontNote({ view, locale, onOpenSetting }: { view: OneFrontView | null; locale: Locale; onOpenSetting: () => void }) {
  if (!view?.effective || !view.fallback) return null;
  const copy = oneFrontFallbackCopy(view.fallback.cause, locale);
  return <p role="status" className={styles.note} data-one-front-note="true">
    <span>{copy.lead} {copy.next}</span>
    <button type="button" onClick={onOpenSetting}>{locale === "ko" ? "설정" : "Settings"}</button>
  </p>;
}
