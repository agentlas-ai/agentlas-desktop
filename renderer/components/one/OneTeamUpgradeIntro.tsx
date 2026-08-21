import { useEffect, useState } from "react";
import styles from "./OneTeamUpgradeIntro.module.css";

const COPY = {
  ko: "Agentlas One이 Agentlas One Team으로 업그레이드 되었습니다. 이제 One이 CEO 오케스트레이터가 되어 팀을 배차하고, 결과를 브리핑합니다.",
  en: "Agentlas One is now Agentlas One Team. One coordinates the staff as CEO orchestrator and briefs you on the result.",
};

export function OneTeamUpgradeIntro({ visible, locale, onDismiss }: { visible: boolean; locale: string; onDismiss: () => void }) {
  const [count, setCount] = useState(0);
  const copy = locale === "ko" ? COPY.ko : COPY.en;
  useEffect(() => {
    if (!visible) return;
    setCount(0);
    const timer = window.setInterval(() => setCount((value) => Math.min(copy.length, value + 2)), 18);
    return () => window.clearInterval(timer);
  }, [copy, visible]);
  if (!visible) return null;
  return <section className={styles.root} aria-live="polite"><div><span className={styles.eyebrow}>ONE TEAM</span><p>{copy.slice(0, count)}<span className={styles.cursor} /></p><button type="button" onClick={onDismiss}>{locale === "ko" ? "확인" : "Got it"}</button></div></section>;
}
