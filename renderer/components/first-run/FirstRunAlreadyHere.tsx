"use client";

/**
 * First run, "your personal agent is already with you" (picture desktop-onboarding-instinct, the added screen). Shown at the very start of the
 * first-run flow, once, only when the personal agent's home is the server (`oneHome.status` says `legacy` with a server home and nothing is moving).
 * [Bring it here] is `oneHome.startMoveHere` (the number and yes are the app's own confirm window); [Not now] goes on to the normal steps.
 * The counts of the picture (chats, memory lines) are not in the status before a move starts, so only the three names are drawn, with what happens to each.
 */
import { useEffect, useState } from "react";
import { IconCloud, IconMonitor } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { homeKindOf } from "@/lib/one-home-view";
import { useHomeActions, useOneHome } from "@/lib/use-one-home";
import { ReauthRow, RefusalNote } from "@/components/one/OneHomeParts";
import styles from "./FirstRun.module.css";

export function useAlreadyHere(active: boolean): { show: boolean; notNow: () => void } {
  const { status } = useOneHome();
  const [dismissed, setDismissed] = useState(false);
  const show = active && !dismissed && Boolean(status?.available) && Boolean(status) && homeKindOf(status!) === "server" && !status!.move;
  return { show, notNow: () => setDismissed(true) };
}

export function FirstRunAlreadyHere({ ko, onNotNow, onBrought }: { ko: boolean; onNotNow: () => void; onBrought: () => void }) {
  const { reload } = useOneHome();
  const actions = useHomeActions(reload);
  const lang = ko ? "ko" : "en";
  const api = ipc()?.oneHome;
  const busy = Boolean(actions.busy);
  // Escape does what [Not now] does, and is held while a press is in flight like that button.
  useEffect(() => {
    if (busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      onNotNow();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onNotNow]);
  return (
    <div className={styles.root} role="dialog" aria-modal="true" aria-labelledby="first-run-title" data-first-run-already-here="true">
      <div className={styles.drag}><span className={styles.brand}><img src="/brand/agentlas-one-mark.png" alt="" />Agentlas</span></div>
      <div className={styles.stage}>
        <div className={styles.frame}>
          <header className={styles.head}>
            <span className={styles.stepMark} aria-hidden="true"><IconMonitor size={24} /></span>
            <h1 id="first-run-title">{ko ? "개인 에이전트가 이미 함께 있어요." : "Your personal agent is already with you."}</h1>
            <p>{ko ? "이 데스크탑에 연결하면 하나로 병합돼 이 데스크탑에서 실행돼요." : "Connecting merges them, and it runs on this desktop."}</p>
          </header>
          <section className={styles.body}>
            <div className={styles.setupCard}>
              <IconCloud size={30} />
              <div className={styles.setupCopy}>
                <strong>{ko ? "폰에서 만든 개인 에이전트" : "The personal agent you made on your phone"}</strong>
                <small>{ko ? "Agentlas 서버에서 실행 중" : "Running on the Agentlas server"}</small>
              </div>
              <span className={styles.status}>{ko ? "Agentlas에 있음" : "On Agentlas"}</span>
            </div>
            {/* What comes along (picture row 1): the names only. The server's counts are not known to this window before a move starts, so no number is drawn. */}
            <ul className={styles.carryList} data-first-run-carry="true">
              <li><span>{ko ? "대화" : "Chats"}</span><small>{ko ? "하나로 합쳐져요" : "Merged into one"}</small></li>
              <li><span>{ko ? "기억" : "Memory"}</span><small>{ko ? "하나로 합쳐져요" : "Merged into one"}</small></li>
              <li><span>{ko ? "사진" : "Photos"}</span><small>{ko ? "이전 대화에 남아요" : "Stay in the old chat"}</small></li>
            </ul>
            <RefusalNote line={actions.line} lang={lang} />
            <ReauthRow actions={actions} lang={lang} />
          </section>
        </div>
      </div>
      <footer className={styles.foot}>
        <span />
        <span />
        <div className={styles.footActions}>
          <button type="button" className={styles.quiet} onClick={onNotNow} disabled={Boolean(actions.busy)}>{ko ? "나중에" : "Not now"}</button>
          <button type="button" className={styles.primary} disabled={Boolean(actions.busy) || !api}
            onClick={() => void actions.press("startMoveHere", async () => { const out = await api!.startMoveHere(); if (out?.ok) onBrought(); return out; })}>
            {ko ? "이 데스크탑에 연결" : "Connect here"}
          </button>
        </div>
      </footer>
    </div>
  );
}
