"use client";

/*
 * 칩 하나 = 연결할 것 하나 (오너 2026-09-29).
 *   - 이미 설치 + 로그인이 **살아 있는 확인**으로 확인되면 초록 "설치됨 ✓" + 가린 계정 + 지연.
 *   - 아니면 작은 [연결] 버튼 → 단계 팝업: 확인 중 → 설치 중(로그 꼬리) → 로그인(브라우저) → 확인 중 → 완료.
 *     완료되면 팝업은 알아서 닫히고 칩이 초록으로 바뀐다. 실패는 사유 코드·다시 시도·로그.
 *     취소는 모든 단계에서 되고, 설치 도중 취소면 그 사실을 말한다.
 * 온보딩(FirstRunOnboarding)과 설정 → LLM 연결이 이 한 벌을 같이 쓴다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import type {
  ConnectableRuntime,
  RuntimeAuthProbe,
  RuntimeConnectReasonCode,
  RuntimeConnectSnapshot,
  RuntimeConnectStep,
} from "@shared/runtime-connect";
import styles from "./ConnectChips.module.css";

export interface RuntimeChipSpec {
  kind: ConnectableRuntime;
  name: string;
  sub: string;
  logo: string;
}

export const RUNTIME_CHIPS: readonly RuntimeChipSpec[] = [
  { kind: "codex", name: "Codex", sub: "ChatGPT", logo: "/brand/llm/openai.svg" },
  { kind: "claude-code", name: "Claude Code", sub: "Claude", logo: "/brand/llm/claude.svg" },
  { kind: "antigravity", name: "Antigravity", sub: "Google Gemini", logo: "/brand/llm/googlegemini.svg" },
  { kind: "grok", name: "Grok", sub: "xAI", logo: "/brand/llm/x.svg" },
  { kind: "kimi", name: "Kimi Code", sub: "Moonshot", logo: "/brand/llm/kimi.svg" },
  { kind: "cursor", name: "Cursor", sub: "Cursor Agent", logo: "/brand/llm/cursor.svg" },
];

export function connectCopy(ko: boolean) {
  return ko ? {
    installed: "설치됨", available: "사용 가능", connect: "연결", upgrade: "Upgrade", checking: "확인 중…",
    notInstalled: "설치 안 됨", signedOut: "로그인 필요", unverified: "로그인 확인 불가",
    steps: { checking: "확인 중", installing: "설치 중", login: "로그인", verifying: "확인 중", done: "완료" } as Record<RuntimeConnectStep, string>,
    skipped: "건너뜀",
    title: (n: string) => `${n} 연결`,
    loginNote: "브라우저에서 공식 로그인 페이지를 열었어요. 로그인을 마치면 이 창은 알아서 닫혀요.",
    reopen: "브라우저가 안 열렸나요? 다시 열기",
    installNote: "공식 패키지를 이 기기에 설치하고 있어요.",
    doneNote: "연결됐어요.",
    cancel: "취소", retry: "다시 시도", close: "닫기", showLog: "로그 보기", hideLog: "로그 숨기기",
    cancelled: "취소했어요.",
    partial: "설치 도중 멈췄어요. 설치는 끝나지 않았고, 다음에 연결을 누르면 처음부터 다시 설치해요.",
    reason: {
      install_network: "네트워크 때문에 설치 파일을 받지 못했어요. 인터넷 연결을 확인하고 다시 시도하세요.",
      install_failed: "설치가 실패했어요.",
      install_timeout: "설치가 5분 안에 끝나지 않았어요.",
      install_verify_failed: "설치는 끝났지만 실행 확인이 실패했어요.",
      install_cancelled: "설치를 취소했어요.",
      install_manual_only: "이 AI는 공식 설치 프로그램으로 직접 설치해야 해요.",
      login_spawn_failed: "로그인을 시작하지 못했어요.",
      login_exited: "로그인이 끝나기 전에 로그인 도구가 종료됐어요.",
      login_timeout: "로그인이 제한 시간 안에 확인되지 않았어요.",
      probe_failed: "상태를 확인하지 못했어요.",
      probe_unavailable: "로그인은 끝났지만 이 AI는 로그인 상태를 확인할 방법을 제공하지 않아요.",
      cancelled: "취소했어요.",
    } as Record<RuntimeConnectReasonCode, string>,
    ms: (n: number) => `${n}ms 확인`,
  } : {
    installed: "Installed", available: "Available", connect: "Connect", upgrade: "Upgrade", checking: "Checking…",
    notInstalled: "Not installed", signedOut: "Sign-in needed", unverified: "Sign-in unverified",
    steps: { checking: "Checking", installing: "Installing", login: "Sign in", verifying: "Verifying", done: "Done" } as Record<RuntimeConnectStep, string>,
    skipped: "Skipped",
    title: (n: string) => `Connect ${n}`,
    loginNote: "We opened the official sign-in page in your browser. This closes by itself once you finish.",
    reopen: "Browser didn't open? Open again",
    installNote: "Installing the official package on this computer.",
    doneNote: "Connected.",
    cancel: "Cancel", retry: "Retry", close: "Close", showLog: "Show log", hideLog: "Hide log",
    cancelled: "Cancelled.",
    partial: "Stopped mid-install. The install did not finish; pressing Connect again reinstalls from the start.",
    reason: {
      install_network: "The installer could not reach the network. Check your connection and retry.",
      install_failed: "Install failed.",
      install_timeout: "Install did not finish within 5 minutes.",
      install_verify_failed: "Install finished but the program failed its check.",
      install_cancelled: "Install cancelled.",
      install_manual_only: "This AI needs its official installer run by you.",
      login_spawn_failed: "Could not start sign-in.",
      login_exited: "The sign-in tool exited before sign-in finished.",
      login_timeout: "Sign-in was not confirmed in time.",
      probe_failed: "Could not check the status.",
      probe_unavailable: "Sign-in finished, but this AI offers no way to confirm it.",
      cancelled: "Cancelled.",
    } as Record<RuntimeConnectReasonCode, string>,
    ms: (n: number) => `checked in ${n}ms`,
  };
}

export type ConnectCopy = ReturnType<typeof connectCopy>;

/** 살아 있는 확인 결과 — 앱 시작 캐시를 먼저 읽고, 칩마다 다시 물을 수 있다. */
export function useRuntimeAuth(force = false) {
  const [probes, setProbes] = useState<Partial<Record<ConnectableRuntime, RuntimeAuthProbe>>>({});
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async (kind?: ConnectableRuntime, again = true) => {
    const api = ipc();
    if (!api?.runtime.probeAuth) { setLoaded(true); return; }
    if (kind) {
      const one = await api.runtime.probeAuth(kind, again).catch(() => null);
      if (one) setProbes((prev) => ({ ...prev, [kind]: one }));
      return;
    }
    const all = await api.runtime.probeAuth(null, again).catch(() => null);
    if (all) setProbes(Object.fromEntries(all.map((p) => [p.kind, p])));
    setLoaded(true);
  }, []);
  useEffect(() => { void refresh(undefined, force); }, [refresh, force]);
  return { probes, loaded, refresh };
}

export function ChipGrid({ children, label }: { children: React.ReactNode; label?: string }) {
  return <div className={styles.grid} role="list" aria-label={label}>{children}</div>;
}

export function ConnectChip({
  logo, icon, name, sub, ready, badge, badgeTone, facts, action, busy, secondaryActions,
}: {
  logo?: string;
  icon?: React.ReactNode;
  name: string;
  sub?: string;
  ready: boolean;
  badge: string;
  badgeTone?: "ok" | "warn";
  facts?: string[];
  action?: { label: string; onClick: () => void; variant?: "upgrade" };
  busy?: boolean;
  secondaryActions?: Array<{ label: string; onClick: () => void }>;
}) {
  return (
    <article className={styles.chip} data-state={ready ? "ready" : undefined} role="listitem" aria-label={`${name} — ${badge}`}>
      <div className={styles.top}>
        {icon ?? <img src={logo} alt="" />}
        <div className={styles.names}>
          <strong>{name}</strong>
          {sub && <small>{sub}</small>}
        </div>
      </div>
      <div className={styles.bottom}>
        <div className={styles.facts}>
          <span className={styles.badge} data-tone={badgeTone}>{ready ? `${badge} ✓` : badge}</span>
          {facts?.filter(Boolean).map((line) => <span key={line} title={line}>{line}</span>)}
        </div>
        {action && (
          <button type="button" className={styles.small} data-variant={action.variant} disabled={busy} onClick={action.onClick} aria-label={`${name} — ${action.label}`}>
            {action.label}
          </button>
        )}
      </div>
      {secondaryActions && <div className={styles.secondaryActions}>{secondaryActions.map((item) => <button key={item.label} type="button" className={styles.link} onClick={item.onClick}>{item.label}</button>)}</div>}
    </article>
  );
}

/** 런타임 칩: 초록은 probe.state === "signed-in" 일 때만. */
export function RuntimeChip({
  spec, probe, loaded, copy, onConnect,
}: {
  spec: RuntimeChipSpec;
  probe: RuntimeAuthProbe | undefined;
  loaded: boolean;
  copy: ConnectCopy;
  onConnect: (spec: RuntimeChipSpec) => void;
}) {
  const ready = probe?.state === "signed-in";
  const badge = !probe
    ? (loaded ? copy.notInstalled : copy.checking)
    : probe.state === "signed-in" ? copy.installed
    : probe.state === "not-installed" ? copy.notInstalled
    : probe.state === "signed-out" ? copy.signedOut
    : copy.unverified;
  const facts = ready
    ? [probe?.account ?? probe?.method ?? "", probe?.latencyMs != null ? copy.ms(probe.latencyMs) : ""]
    : [];
  return (
    <ConnectChip
      logo={spec.logo}
      name={spec.name}
      sub={spec.sub}
      ready={ready}
      badge={badge}
      badgeTone={ready ? "ok" : probe?.state === "signed-out" ? "warn" : undefined}
      facts={facts}
      busy={!probe && !loaded}
      action={ready ? undefined : { label: copy.connect, onClick: () => onConnect(spec) }}
    />
  );
}

const STEP_ORDER: RuntimeConnectStep[] = ["checking", "installing", "login", "verifying", "done"];

/**
 * 단계 팝업. 열리면 main 의 연결 세션을 시작하고, 끝나면 알아서 닫는다(onDone).
 * 세션은 main 이 들고 있으므로 팝업을 닫아도 취소를 누르지 않은 한 진행은 계속된다 — 그래서
 * 닫기 버튼은 없고, 나가는 길은 [취소] 하나다(진행을 멈추고 반쯤 남긴 것을 말한다).
 */
export function RuntimeConnectPopup({
  spec, copy, onClose, onDone,
}: {
  spec: RuntimeChipSpec;
  copy: ConnectCopy;
  onClose: () => void;
  onDone: (snapshot: RuntimeConnectSnapshot) => void;
}) {
  const [snap, setSnap] = useState<RuntimeConnectSnapshot | null>(null);
  const [showLog, setShowLog] = useState(false);
  const sawInstall = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const start = useCallback(() => {
    const api = ipc();
    sawInstall.current = false;
    setShowLog(false);
    void api?.runtime.connectStart?.(spec.kind).then((s) => setSnap(s)).catch(() => undefined);
  }, [spec.kind]);

  useEffect(() => {
    const api = ipc();
    const off = api?.runtime.onConnectEvent?.((s) => {
      if (s.kind !== spec.kind) return;
      setSnap((prev) => (prev && prev.sessionId !== s.sessionId && prev.startedAt > s.startedAt ? prev : s));
    });
    start();
    return () => { off?.(); };
  }, [spec.kind, start]);

  if (snap?.step === "installing") sawInstall.current = true;

  useEffect(() => {
    if (snap?.phase !== "done") return;
    const timer = window.setTimeout(() => doneRef.current(snap), 900);
    return () => window.clearTimeout(timer);
  }, [snap]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (snap?.phase === "running") void ipc()?.runtime.connectCancel?.(spec.kind);
      else onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [snap?.phase, spec.kind, onClose]);

  const currentIndex = snap ? STEP_ORDER.indexOf(snap.step) : 0;
  const failed = snap?.phase === "failed";
  const cancelled = snap?.phase === "cancelled";
  const running = !snap || snap.phase === "running";
  const statusOf = (step: RuntimeConnectStep, index: number): string => {
    if (!snap) return index === 0 ? "current" : "todo";
    if (snap.phase === "done") return step === "installing" && !sawInstall.current ? "skipped" : "done";
    if (index < currentIndex) return step === "installing" && !sawInstall.current ? "skipped" : "done";
    if (index === currentIndex) return failed || cancelled ? "failed" : "current";
    return "todo";
  };
  const reasonText = snap?.reasonCode ? copy.reason[snap.reasonCode] : null;
  const logTail = snap?.log ?? [];

  return (
    <div className={styles.scrim} role="presentation">
      <div className={styles.popup} role="dialog" aria-modal="true" aria-labelledby="runtime-connect-title" data-connect-kind={spec.kind} data-connect-phase={snap?.phase ?? "running"} data-connect-step={snap?.step ?? "checking"}>
        <div className={styles.popupHead}>
          <img src={spec.logo} alt="" />
          <h2 id="runtime-connect-title">{copy.title(spec.name)}</h2>
        </div>
        <ol className={styles.steps} aria-live="polite">
          {STEP_ORDER.map((step, index) => {
            const status = statusOf(step, index);
            return (
              <li key={step} data-status={status}>
                <span className={styles.dot} aria-hidden>{status === "done" ? "✓" : status === "failed" ? "!" : ""}</span>
                <span>{copy.steps[step]}{status === "skipped" ? ` · ${copy.skipped}` : ""}</span>
              </li>
            );
          })}
        </ol>

        {running && snap?.step === "installing" && (
          <>
            <p className={styles.note}>{copy.installNote}</p>
            <details className={styles.evidence}><summary>{copy.showLog}</summary><pre className={styles.log} aria-label="install log">{logTail.slice(-6).join("\n") || "…"}</pre></details>
          </>
        )}
        {running && snap?.step === "login" && (
          <p className={styles.note}>
            {copy.loginNote}
            {snap.loginUrl && (
              <>
                <br />
                <button type="button" className={styles.link} onClick={() => window.open(snap.loginUrl!, "_blank", "noopener,noreferrer")}>{copy.reopen}</button>
              </>
            )}
          </p>
        )}
        {snap?.phase === "done" && (
          <p className={styles.note}>
            {copy.doneNote}
            {snap.probe?.account ? ` ${snap.probe.account}` : ""}
            {snap.probe?.latencyMs != null ? ` · ${copy.ms(snap.probe.latencyMs)}` : ""}
          </p>
        )}
        {(failed || cancelled) && (
          <p className={styles.note} data-tone={failed ? "error" : undefined} role="alert">
            {cancelled ? (snap?.partialInstall ? copy.partial : copy.cancelled) : reasonText}
            {failed && snap?.reasonCode && <> <span className={styles.code}>({snap.reasonCode})</span></>}
            {failed && snap?.manualInstall && <><br /><span className={styles.code}>{snap.manualInstall}</span></>}
          </p>
        )}
        {(failed || cancelled) && logTail.length > 0 && (
          <>
            <button type="button" className={styles.link} onClick={() => setShowLog((v) => !v)}>{showLog ? copy.hideLog : copy.showLog}</button>
            {showLog && <pre className={styles.log}>{logTail.join("\n")}</pre>}
          </>
        )}

        <div className={styles.actions}>
          {running ? (
            <button type="button" className={styles.button} onClick={() => void ipc()?.runtime.connectCancel?.(spec.kind)}>{copy.cancel}</button>
          ) : snap?.phase === "done" ? null : (
            <>
              <button type="button" className={styles.button} onClick={onClose}>{copy.close}</button>
              {snap?.reasonCode !== "install_manual_only" && (
                <button type="button" className={styles.button} data-variant="primary" onClick={start}>{copy.retry}</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
