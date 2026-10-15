// 전역 로그인 게이트.
//   - 확인된 로그인 안 됨 → 첫 로그인 화면. 연결 실패는 별도로 표시한다.
//   - 로그인됨 → 앱 본체(children: 온보딩/마켓플레이스/홈 등).
// 세션은 main 메모리에서 1회 조회. 로그인 직후 children으로 전환되며 하위가 새로 마운트된다.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { invalidateIpcCache } from "@/lib/ipc-cache";
import type { AuthSession } from "@/lib/types";
import { FirstRunLogin } from "./first-run/FirstRunLogin";
import { FirstRunGate } from "./first-run/FirstRunOnboarding";
import { useT } from "@/lib/i18n";
import { LoadingEstimate } from "./LoadingEstimate";

// DEV 전용 QA 라우트 — 브라우저(Playwright) 렌더 회귀 검증용으로 게이트를 우회한다.
// 프로덕션 빌드에선 절대 우회하지 않는다. /one 역시 production에서는 계속 인증을 요구한다.
const DEV_QA_ROUTES = ["/one", "/surface-preview"];

type SessionCheck =
  | { kind: "checking" }
  | { kind: "unavailable" }
  | { kind: "resolved"; session: AuthSession };

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [check, setCheck] = useState<SessionCheck>({ kind: "checking" });
  const [recheck, setRecheck] = useState(0);
  const observerEpoch = useRef(0);
  const requestEpoch = useRef(0);
  const mountedObserver = useRef<number | null>(null);
  const { t, locale } = useT();
  const pathname = usePathname();

  const acceptSession = useCallback((next: AuthSession) => {
    if (mountedObserver.current === null) return;
    requestEpoch.current += 1;
    invalidateIpcCache("auth");
    setCheck(typeof next?.signedIn === "boolean"
      ? { kind: "resolved", session: next }
      : { kind: "unavailable" });
  }, []);

  const retryCheck = () => {
    observerEpoch.current += 1;
    requestEpoch.current += 1;
    // A timed-out lookup may still be in flight, or a previous false may be
    // cached. A user recheck must reach the existing native getter again.
    invalidateIpcCache("auth");
    setCheck({ kind: "checking" });
    setRecheck((value) => value + 1);
  };

  useEffect(() => {
    const observer = ++observerEpoch.current;
    const request = ++requestEpoch.current;
    mountedObserver.current = observer;
    let alive = true;
    let timeout: number | undefined;
    let unsubscribeSession: (() => void) | undefined;
    const ownsObserver = () => alive && observerEpoch.current === observer;
    const ownsRequest = () => ownsObserver() && requestEpoch.current === request;
    const unavailable = () => {
      if (ownsRequest()) setCheck({ kind: "unavailable" });
    };
    const cleanup = () => {
      alive = false;
      if (observerEpoch.current === observer) {
        observerEpoch.current += 1;
        requestEpoch.current += 1;
      }
      if (mountedObserver.current === observer) mountedObserver.current = null;
      window.clearTimeout(timeout);
      try { unsubscribeSession?.(); } catch { /* Obsolete subscriptions cannot change the gate. */ }
    };
    setCheck({ kind: "checking" });
    try {
      const api = ipc();
      if (!api || typeof api.auth?.getSession !== "function") {
        unavailable();
        return cleanup;
      }
      timeout = window.setTimeout(unavailable, 10_000);
      unsubscribeSession = api.auth.onSessionChanged?.((next) => {
        if (!ownsObserver()) return;
        window.clearTimeout(timeout);
        acceptSession(next);
      });
      // A subscription may synchronously deliver a newer native session.
      if (ownsRequest()) {
        api.auth.getSession().then((next) => {
          if (!ownsRequest()) return;
          window.clearTimeout(timeout);
          setCheck(typeof next?.signedIn === "boolean"
            ? { kind: "resolved", session: next }
            : { kind: "unavailable" });
        }).catch(() => {
          if (!ownsRequest()) return;
          window.clearTimeout(timeout);
          unavailable();
        });
      }
    } catch {
      window.clearTimeout(timeout);
      unavailable();
    }
    return cleanup;
  }, [recheck, acceptSession]);

  if (process.env.NODE_ENV !== "production" && DEV_QA_ROUTES.some((r) => pathname?.startsWith(r))) {
    return <>{children}</>;
  }

  // 세션 확인 중 — 다크 배경만 (랜딩/앱 어느 쪽으로도 깜빡이지 않게)
  if (check.kind === "checking") {
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--black)",
          color: "var(--white-soft)",
          display: "grid",
          placeItems: "center",
          textAlign: "center",
          padding: 24,
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>{t("auth.checking.title")}</div>
          <div style={{ fontSize: 13, color: "rgba(238,245,242,0.72)", lineHeight: 1.5 }}>
            {t("auth.checking.body")}
          </div>
          <div style={{ marginTop: 10 }}>
            <LoadingEstimate locale={locale} operationKey="desktop-auth-session" expectedSeconds={[1, 10]} inverse />
          </div>
        </div>
      </div>
    );
  }

  if (check.kind === "unavailable") {
    const ko = locale === "ko";
    return (
      <div role="status" aria-live="polite" style={{
        position: "fixed", inset: 0, background: "var(--black)", color: "var(--white-soft)",
        display: "grid", placeItems: "center", textAlign: "center", padding: 24,
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
            {ko ? "앱 연결을 확인하지 못했어요." : "The app connection could not be checked."}
          </div>
          <div style={{ fontSize: 13, color: "rgba(238,245,242,0.72)", lineHeight: 1.5 }}>
            {ko ? "연결 상태를 확인하고 다시 시도해 주세요." : "Check the connection and try again."}
          </div>
          <button type="button" onClick={retryCheck} style={{
            minHeight: 44, marginTop: 16, padding: "8px 16px", borderRadius: 8,
            border: "1px solid currentColor", background: "transparent", color: "inherit", cursor: "pointer",
          }}>
            {ko ? "연결 다시 확인" : "Check connection again"}
          </button>
        </div>
      </div>
    );
  }

  // 2026-09-25 첫 실행 개편: 로그인(01) → 첫 설정(02–08) → One. 첫 설정은 새로 설치한
  // 계정에서만 스스로 열리고, 기존 사용자는 설정에서 다시 열 수 있다(FirstRunGate).
  if (!check.session.signedIn) {
    const loginObserver = observerEpoch.current;
    const loginRequest = requestEpoch.current;
    return <FirstRunLogin onSignedIn={(next) => {
      if (mountedObserver.current !== loginObserver
        || observerEpoch.current !== loginObserver
        || requestEpoch.current !== loginRequest) return;
      acceptSession(next);
    }} />;
  }

  return <FirstRunGate session={check.session}>{children}</FirstRunGate>;
}
