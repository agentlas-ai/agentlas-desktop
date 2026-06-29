// 전역 로그인 게이트.
//   - 로그인 안 됨 → 랜딩(Landing) 첫 화면. CTA로 브라우저 로그인.
//   - 로그인됨 → 앱 본체(children: 온보딩/마켓플레이스/홈 등).
// 세션은 main 메모리에서 1회 조회. 로그인 직후 children으로 전환되며 하위가 새로 마운트된다.
"use client";
import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { AuthSession } from "@/lib/types";
import { Landing } from "./Landing";

export function AuthGate({ children }: { children: React.ReactNode }) {
  // null = 아직 조회 전 (세션 확인 중 — 흰 화면 깜빡임 방지용 다크 스플래시)
  const [session, setSession] = useState<AuthSession | null>(null);

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
    };
  }, []);

  // 세션 확인 중 — 다크 배경만 (랜딩/앱 어느 쪽으로도 깜빡이지 않게)
  if (session === null) {
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "fixed",
          inset: 0,
          background: "#06080B",
          color: "#EEF5F2",
          display: "grid",
          placeItems: "center",
          textAlign: "center",
          padding: 24,
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Agentlas</div>
          <div style={{ fontSize: 13, color: "rgba(238,245,242,0.72)", lineHeight: 1.5 }}>
            세션을 확인하고 있습니다. 오래 걸리면 로그인 화면으로 돌아갑니다.
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
