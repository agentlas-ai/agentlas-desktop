"use client";

/*
 * First-run screen 01 — Agentlas sign-in. Not skippable: every later step writes to
 * this account (plan, entitlements) or this machine's One profile.
 *
 * Sign-in keeps the exact path the old Landing used: the default browser (already
 * signed in to Google, usually) first, then the in-app window as a fallback. The
 * web login page creates an account on first Google sign-in, so "Create account"
 * runs the same flow — it is not a separate sign-up form we do not have.
 */
import { useCallback, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { AuthSession } from "@/lib/types";
import styles from "./FirstRun.module.css";

export function FirstRunLogin({ onSignedIn }: { onSignedIn: (session: AuthSession) => void }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const cancelled = useRef(false);

  const signIn = useCallback(async () => {
    if (busy) return;
    const api = ipc();
    if (!api) {
      setNotice(ko ? "데스크탑 앱 안에서 열어야 로그인할 수 있어요." : "Open this inside the desktop app to sign in.");
      return;
    }
    setBusy(true);
    setNotice(null);
    cancelled.current = false;
    try {
      const next = await api.auth.signInWithBrowser();
      if (next.signedIn) { onSignedIn(next); return; }
      if (cancelled.current) return;
      const fallback = await api.auth.signInWithGoogle();
      if (fallback.signedIn) onSignedIn(fallback);
      else if (!cancelled.current) {
        setNotice(fallback.error || next.error || (ko ? "로그인이 끝나지 않았어요. 브라우저 창을 확인하고 다시 시도해 주세요." : "Sign-in did not finish. Check the browser window and try again."));
      }
    } catch (error) {
      if (!cancelled.current) setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [busy, ko, onSignedIn]);

  const cancel = () => {
    cancelled.current = true;
    setBusy(false);
    setNotice(null);
  };

  return (
    <div className={styles.root} role="main" aria-labelledby="first-run-login-title">
      <div className={styles.drag}>
        <span className={styles.brand}><img src="/brand/agentlas-one-mark.png" alt="" />Agentlas</span>
      </div>
      <div className={styles.stage}>
        <header className={styles.head}>
          <h1 id="first-run-login-title">{ko ? "Agentlas에 오신 걸 환영해요." : "Welcome to Agentlas."}</h1>
          <p>{ko ? "계정으로 로그인하고 나만의 에이전트를 설정하세요." : "Sign in and set up your own agent."}</p>
        </header>
        <section className={styles.body}>
          <img className={styles.loginMark} src="/brand/agentlas-one-mark.png" alt="" />
          <div className={styles.loginActions}>
            <button type="button" className={styles.primary} onClick={() => void signIn()} disabled={busy} aria-busy={busy}>
              {busy ? (ko ? "브라우저에서 로그인해 주세요…" : "Finish signing in in your browser…") : (ko ? "Agentlas 계정으로 로그인" : "Sign in with Agentlas")}
            </button>
            {busy
              ? <button type="button" className={styles.secondary} onClick={cancel}>{ko ? "로그인 취소" : "Cancel sign-in"}</button>
              : <button type="button" className={styles.secondary} onClick={() => void signIn()}>{ko ? "계정 만들기" : "Create an account"}</button>}
          </div>
          {notice && <p className={styles.error} role="status">{notice}</p>}
          <p className={styles.hint}>{ko ? "브라우저에서 로그인하면 자동으로 이어져요." : "Signing in happens in your browser and continues here automatically."}</p>
        </section>
      </div>
    </div>
  );
}
