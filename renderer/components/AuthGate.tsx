// 전역 로그인 게이트.
//   - 로그인 안 됨 → 랜딩(Landing) 첫 화면. CTA로 브라우저 로그인.
//   - 로그인됨 → 앱 본체(children: 온보딩/마켓플레이스/홈 등).
// 세션은 main 메모리에서 1회 조회. 로그인 직후 children으로 전환되며 하위가 새로 마운트된다.
"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ipc } from "@/lib/ipc";
import type { AuthSession } from "@/lib/types";
import { Landing } from "./Landing";
import { useT } from "@/lib/i18n";
import { LoadingEstimate } from "./LoadingEstimate";

// DEV 전용 QA 라우트 — 브라우저(Playwright) 렌더 회귀 검증용으로 게이트를 우회한다.
// 프로덕션 빌드에선 절대 우회하지 않는다. /one 역시 production에서는 계속 인증을 요구한다.
const DEV_QA_ROUTES = ["/one", "/surface-preview"];

export function AuthGate({ children }: { children: React.ReactNode }) {
  // null = 아직 조회 전 (세션 확인 중 — 흰 화면 깜빡임 방지용 다크 스플래시)
  const [session, setSession] = useState<AuthSession | null>(null);
  const { t, locale } = useT();
  const pathname = usePathname();

  useEffect(() => {
    const api = ipc();
    if (!api) {
      // preload 브릿지 없음(순수 웹/미지원) — 로그인 불가 → 랜딩 노출
      setSession({ signedIn: false });
      return;
    }
    let alive = true;
    const timeout = window.setTimeout(() => {
      if (alive) setSession({ signedIn: false });
    }, 10_000);
    const unsubscribeSession = api.auth.onSessionChanged?.((next) => {
      window.clearTimeout(timeout);
      if (alive) setSession(next);
    });
    api.auth
      .getSession()
      .then((s) => {
        window.clearTimeout(timeout);
        if (alive) setSession(s);
      })
      .catch(() => {
        window.clearTimeout(timeout);
        if (alive) setSession({ signedIn: false });
      });
    return () => {
      alive = false;
      window.clearTimeout(timeout);
      unsubscribeSession?.();
    };
  }, []);

  if (process.env.NODE_ENV !== "production" && DEV_QA_ROUTES.some((r) => pathname?.startsWith(r))) {
    return <>{children}</>;
  }

  // 세션 확인 중 — 다크 배경만 (랜딩/앱 어느 쪽으로도 깜빡이지 않게)
  if (session === null) {
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

  if (!session.signedIn) {
    return <Landing onSignedIn={setSession} />;
  }

  return <>{children}</>;
}
