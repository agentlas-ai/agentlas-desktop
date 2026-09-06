// 사이드바 하단 계정 칩.
//   - 미로그인: "로그인" 텍스트. 클릭 시 즉시 BrowserWindow 로그인 흐름.
//   - 로그인됨: 아바타 + 이메일. 클릭 시 popover에 "로그아웃".
//
// 세션은 main 메모리에서 가져옴 (cookie는 keytar에). 마운트 시 한 번 조회, 로그인 직후 갱신.
"use client";
import { useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { AuthSession } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { loadViewData, readViewData, writeViewData } from "@/lib/view-data-cache";
import { IconChevronDown } from "./Icon";

export function AccountChip() {
  const { t } = useT();
  const [session, setSession] = useState<AuthSession>(() => (
    readViewData<AuthSession>("shell.auth-session")?.value ?? { signedIn: false }
  ));
  const [busy, setBusy] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // 마운트 시 조회 + 이메일이 아직 안 채워졌으면 재조회.
  // main은 부팅 시 keychain에서 세션을 먼저 복원하고 이메일/이름은 백그라운드로 가져오므로,
  // 1회 조회만 하면 "?" 아바타 + '계정' 라벨로 영영 남는다. 채워질 때까지(최대 2분) 폴링하고
  // 창 포커스 때마다 한 번 더 동기화한다.
  useEffect(() => {
    const api = ipc();
    if (!api) return;
    let stopped = false;
    let attempts = 0;
    const load = async (force = false) => {
      const next = await loadViewData(
        "shell.auth-session",
        () => api.auth.getSession(),
        { maxAgeMs: 60_000, force },
      );
      if (!stopped) setSession(next);
      return next;
    };
    void load();
    const timer = setInterval(() => {
      attempts += 1;
      void load().then((next) => {
        if ((next.signedIn && next.email) || !next.signedIn || attempts >= 24) clearInterval(timer);
      });
    }, 5000);
    const onFocus = () => void load(true);
    const unsubscribeSession = api.auth.onSessionChanged?.((next) => {
      if (stopped) return;
      writeViewData("shell.auth-session", next);
      setSession(next);
      if (!next.signedIn) setPopoverOpen(false);
      announceAuthChanged();
    });
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      clearInterval(timer);
      unsubscribeSession?.();
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // 크레딧 위젯 등 다른 세션 소비자와 상태를 맞추기 위한 브로드캐스트.
  function announceAuthChanged() {
    window.dispatchEvent(new Event("agentlas:auth-changed"));
  }

  useDismissibleLayer({
    open: popoverOpen,
    roots: [rootRef],
    restoreFocusRef: triggerRef,
    onDismiss: () => setPopoverOpen(false),
  });

  async function signIn() {
    const api = ipc();
    if (!api || busy) return;
    setBusy(true);
    try {
      const next = await api.auth.signInWithGoogle();
      writeViewData("shell.auth-session", next);
      setSession(next);
      announceAuthChanged();
    } finally {
      setBusy(false);
    }
  }

  // 이미 로그인된 시스템 브라우저(크롬 등)로 로그인. 미완료(타임아웃/미지원) 시 창 방식으로 폴백.
  async function signInBrowser() {
    const api = ipc();
    if (!api || busy) return;
    setBusy(true);
    try {
      const next = await api.auth.signInWithBrowser();
      if (next.signedIn) {
        writeViewData("shell.auth-session", next);
        setSession(next);
        announceAuthChanged();
        return;
      }
      const fallback = await api.auth.signInWithGoogle();
      writeViewData("shell.auth-session", fallback);
      setSession(fallback);
      announceAuthChanged();
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    const api = ipc();
    if (!api) return;
    await api.auth.signOut();
    const signedOut: AuthSession = { signedIn: false };
    writeViewData("shell.auth-session", signedOut);
    setSession(signedOut);
    setPopoverOpen(false);
    announceAuthChanged();
  }

  const initial = (session.email ?? session.name ?? "?").charAt(0).toUpperCase();
  const display = session.email ?? session.name ?? t("account.signed_in");

  return (
    <div ref={rootRef} className="titlebar-nodrag" style={{ position: "relative" }}>
      {!session.signedIn ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <button
            onClick={() => void signIn()}
            disabled={busy}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "8px 10px",
              background: "var(--paper-2)",
              border: "1px solid var(--paper-edge)",
              borderRadius: 10,
              fontSize: 12,
              fontWeight: 600,
              color: "var(--ink)",
              cursor: busy ? "default" : "pointer",
              textAlign: "left",
            }}
          >
            <GoogleGlyph />
            <span style={{ flex: 1, minWidth: 0 }}>
              {busy ? t("account.signing_in") : t("account.sign_in")}
            </span>
          </button>
          <button
            onClick={() => void signInBrowser()}
            disabled={busy}
            title={t("account.sign_in_browser_hint")}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--muted-deep)",
              fontSize: 11,
              fontWeight: 500,
              cursor: busy ? "default" : "pointer",
              textAlign: "left",
              padding: "0 4px",
            }}
          >
            {t("account.sign_in_browser")}
          </button>
        </div>
      ) : (
        <button
          ref={triggerRef}
          onClick={() => setPopoverOpen((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "6px 8px",
            background: popoverOpen ? "var(--fill-1)" : "transparent",
            border: "none",
            borderRadius: 10,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span
            style={{
              width: 26,
              height: 26,
              borderRadius: "50%",
              background: "var(--paper-edge)",
              color: "var(--ink-soft)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            {initial}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              fontWeight: 600,
              color: "var(--ink)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={display}
          >
            {display}
          </span>
          <IconChevronDown size={12} style={{ color: "var(--muted-deep)" }} />
        </button>
      )}

      {popoverOpen && session.signedIn && (
        <div
          className="glass-lift"
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            right: 0,
            zIndex: 60,
            padding: 6,
            borderRadius: 12,
            boxShadow: "0 8px 24px rgba(11,11,15,0.12)",
          }}
        >
          {session.email && (
            <div
              style={{
                padding: "8px 10px 6px",
                fontSize: 11,
                color: "var(--muted-deep)",
                wordBreak: "break-all",
              }}
            >
              {session.email}
            </div>
          )}
          <button
            onClick={() => void signOut()}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 10px",
              background: "transparent",
              border: "none",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 500,
              color: "var(--red-deep)",
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            {t("account.sign_out")}
          </button>
        </div>
      )}
    </div>
  );
}

function GoogleGlyph() {
  // 작은 Google "G" — 색상 휘장 (브랜드 마크). 사이즈 14.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 48 48"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <path
        fill="var(--info)"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="var(--ok)"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="var(--warn)"
        d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="var(--danger)"
        d="M24 9.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 3.18 29.93 1 24 1 15.4 1 7.96 5.93 4.34 12.12l7.35 5.7C13.42 13.62 18.27 9.75 24 9.75z"
      />
    </svg>
  );
}
