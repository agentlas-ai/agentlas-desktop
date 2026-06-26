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
    api.auth
      .getSession()
      .then((s) => {
        if (alive) setSession(s);
      })
      .catch(() => {
        if (alive) setSession({ signedIn: false });
      });
    return () => {
      alive = false;
    };
  }, []);

  // 세션 확인 중 — 다크 배경만 (랜딩/앱 어느 쪽으로도 깜빡이지 않게)
  if (session === null) {
    return (
      <div
        style={{ position: "fixed", inset: 0, background: "#06080B" }}
        aria-hidden
      />
    );
  }

  if (!session.signedIn) {
    return <Landing onSignedIn={setSession} />;
  }

  return <>{children}</>;
}
