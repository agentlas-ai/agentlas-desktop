"use client";

// Settings → Agentlas Reach (owner 2026-10-23). One switch, off until the owner turns it on: while the owner is away the app
// explores the installed desktop apps in the background and turns what it finds into abilities AI can use. Under the switch a quiet
// status line says how many apps are usable. The screen shows the value Main returns, never the value it asked for. The first map
// build has no screen at all.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { ReachStatusDto } from "@shared/reach";
import { ReachConsentDialog } from "./ReachConsentDialog";
import styles from "./ReachPanel.module.css";

const REFRESH_MS = 15_000;

function timeLabel(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }).format(time);
}

export function ReachPanel({ locale }: { locale: string }) {
  const ko = locale === "ko";
  const api = ipc()?.reach;
  const [status, setStatus] = useState<ReachStatusDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [askConsent, setAskConsent] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const helpButtonRef = useRef<HTMLButtonElement | null>(null);
  // Every status read and every switch change takes a number; a read that started before a later one began is dropped.
  const generation = useRef(0);
  const helpId = useId();

  const refresh = useCallback(async () => {
    if (!api) return;
    const mine = ++generation.current;
    try {
      const next = await api.status();
      if (mine === generation.current) setStatus(next);
    } catch { /* the line keeps its last view */ }
  }, [api]);

  useEffect(() => {
    if (!api) return;
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, REFRESH_MS);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); generation.current += 1; };
  }, [api, refresh]);

  // The (?) bubble is a transient explanation: any outside press or Escape closes it.
  useEffect(() => {
    if (!helpOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (anchorRef.current && event.target instanceof Node && !anchorRef.current.contains(event.target)) setHelpOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHelpOpen(false);
      helpButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [helpOpen]);

  if (!api) return null;

  const change = async (enabled: boolean, consent?: boolean) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    generation.current += 1;
    try {
      const result = await api.setExplore(enabled, consent);
      setStatus((current) => (current ? { ...current, enabled: result.enabled === true } : current));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
      setAskConsent(false);
      void refresh();
    }
  };

  const title = ko ? "이 데스크탑의 앱 탐색하기" : "Explore this desktop's apps";
  const helpText = ko
    ? "켜면 사용자가 자리를 비운 동안(전원 연결·화면 유휴) 설치된 앱을 백그라운드에서 살펴보고, AI가 쓸 수 있는 기능으로 만들어 둡니다. 문서·화면 내용·개인 정보는 저장하거나 보내지 않습니다. 검증된 기능 설명(앱 이름, 메뉴 이름, 매개변수)만 익명으로 Agentlas에 보내 모든 앱의 기능 목록을 키우는 데 씁니다. 처음 켤 때 Cua Driver(약 53MB)를 내려받습니다. 끄면 바로 멈춥니다."
    : "When on, while you are away (plugged in, screen idle) Agentlas looks at your installed apps in the background and turns what it finds into abilities AI can use. Documents, screen contents and personal data are never stored or sent. Only verified ability descriptions (app name, menu names, parameters) are sent anonymously to Agentlas to build a shared list of what apps can do. The first time you turn it on it downloads the Cua Driver (about 53 MB). Turning it off stops it immediately.";

  const enabled = status?.enabled ?? false;
  const mapped = timeLabel(status?.mapAt ?? null, locale);
  const showLine = status !== null && (status.enabled || status.apps > 0 || mapped !== null);
  const number = new Intl.NumberFormat(ko ? "ko-KR" : "en-US");
  const line = status === null ? "" : [
    ko
      ? `앱 ${number.format(status.apps)}개 · 쓸 수 있음 ${number.format(status.green)} · 일부 ${number.format(status.amber)} · 아직 못 찾음 ${number.format(status.gray)}`
      : `${number.format(status.apps)} apps · usable ${number.format(status.green)} · partial ${number.format(status.amber)} · not found yet ${number.format(status.gray)}`,
    ...(status.exploring ? [ko ? "탐색 중" : "exploring"] : []),
    ...(mapped ? [ko ? `마지막 탐색 ${mapped}` : `last explored ${mapped}`] : []),
  ].join(" · ");
  const permissionMissing = enabled && (status?.permissions.accessibility === false || status?.permissions.screenRecording === false);

  return (
    <section className={styles.panel} aria-labelledby="reach-title">
      <h2 id="reach-title" className={styles.title}>Agentlas Reach</h2>
      <div className={styles.card}>
        <div className={styles.head}>
          <span className={styles.switchLabel} ref={anchorRef}>
            <span className={styles.rowTitle}>{title}</span>
            <button
              type="button"
              ref={helpButtonRef}
              className={styles.helpButton}
              aria-label={ko ? "설명 보기" : "What is this?"}
              aria-haspopup="dialog"
              aria-expanded={helpOpen}
              aria-controls={helpOpen ? helpId : undefined}
              onClick={() => setHelpOpen((open) => !open)}
            >?</button>
            {helpOpen && (
              <div id={helpId} className={styles.help} role="dialog" aria-label={title} data-reach-help="true">{helpText}</div>
            )}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={title}
            className={styles.switch}
            data-on={enabled ? "true" : "false"}
            disabled={!status || busy}
            onClick={() => { if (enabled) void change(false); else setAskConsent(true); }}
          ><span /></button>
        </div>
        {showLine && <p className={styles.status} aria-live="polite" data-reach-status="true">{line}</p>}
        {permissionMissing && (
          <p className={styles.hint} data-reach-permission-hint="true">
            {ko ? "탐색하려면 손쉬운 사용·화면 기록 권한이 필요합니다." : "Exploring needs Accessibility and Screen Recording permission."}
          </p>
        )}
        {askConsent && <ReachConsentDialog ko={ko} busy={busy} onCancel={() => setAskConsent(false)} onAgree={() => void change(true, true)} />}
        {failed && <p className={styles.notice} role="alert">{ko ? "설정을 바꾸지 못했습니다. 다시 시도해 주세요." : "Could not change this setting. Try again."}</p>}
      </div>
    </section>
  );
}
