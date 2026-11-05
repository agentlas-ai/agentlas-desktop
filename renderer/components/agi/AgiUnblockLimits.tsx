"use client";

/**
 * AGI unblock token limits (owner decision D1, 2026-09-28: "토큰 한도 커스터마이즈 되야지").
 * Per unblock attempt (default 60K) and per goal per day (default 200K); both are also deducted from the AGI grant.
 * Shown inside the AGI popover's token-limit view.
 */
import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { AgiTokenLimitsView } from "@shared/agi";
import { IconLock } from "../Icon";
import styles from "./AgiBugReport.module.css";

const toK = (value: number) => String(Math.round(value / 1_000));

export function AgiUnblockLimits({ locale }: { locale: "ko" | "en" }) {
  const ko = locale === "ko";
  const [limits, setLimits] = useState<AgiTokenLimitsView | null>(null);
  const [attempt, setAttempt] = useState("");
  const [daily, setDaily] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const api = ipc()?.agi;
    if (!api) return;
    void api.getTokenLimits().then((view) => { setLimits(view); setAttempt(toK(view.attemptTokenLimit)); setDaily(toK(view.dailyGoalTokenLimit)); })
      .catch(() => setLimits(null));
  }, []);
  if (!limits) return null;
  const save = async (key: "attemptTokenLimit" | "dailyGoalTokenLimit", text: string) => {
    const value = Math.round(Number(text) * 1_000);
    if (!Number.isFinite(value) || value === limits[key]) return;
    try {
      const view = await ipc()!.agi.setTokenLimits({ [key]: value });
      setLimits(view); setAttempt(toK(view.attemptTokenLimit)); setDaily(toK(view.dailyGoalTokenLimit)); setError(null);
    } catch {
      setError(ko ? `${toK(limits.min)}K~${toK(limits.max)}K 사이, 1회 한도는 하루 한도 이하로 적어 주세요.`
        : `Use ${toK(limits.min)}K–${toK(limits.max)}K, and keep the per-attempt limit at or below the daily one.`);
      setAttempt(toK(limits.attemptTokenLimit)); setDaily(toK(limits.dailyGoalTokenLimit));
    }
  };
  const field = (label: string, value: string, set: (v: string) => void, key: "attemptTokenLimit" | "dailyGoalTokenLimit") =>
    <label className={styles.limitRow}>
      <span>{label}</span>
      <span className={styles.limitField}>
        <input type="number" inputMode="numeric" min={Math.round(limits.min / 1_000)} step={10} value={value}
          aria-label={label} data-agi-limit={key}
          onChange={(event) => set(event.target.value)} onBlur={() => { void save(key, value); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void save(key, value); } }} />
        <span aria-hidden="true">K</span>
      </span>
    </label>;
  return <div className={styles.limits} data-agi-unblock-limits="true">
    <strong style={{ display: "flex", alignItems: "center", gap: 8 }}><IconLock size={15} />{ko ? "막힘 해제 한도" : "Unblocking limits"}</strong>
    <p className={styles.muted}>{ko ? "목표 막힘 해제에 쓴 양을 기록합니다. 한 번 시도 한도는 AGI에게 기준으로 알려 주고, 쓴 양은 이 목표의 Alive 한도에서 차감됩니다(Alive 한도를 다 쓰면 Alive가 쉽니다). 이 한도를 넘었다고 막힘 해제나 작업이 멈추지는 않습니다."
      : "Records what stuck goal recovery spends. The per-attempt limit is given to AGI as a guide, and spending counts toward this goal's Alive limit (Alive rests when that runs out). Going over these limits does not stop recovery or the work."}</p>
    {field(ko ? "한 번 시도" : "Per attempt", attempt, setAttempt, "attemptTokenLimit")}
    {field(ko ? "목표당 하루" : "Per goal per day", daily, setDaily, "dailyGoalTokenLimit")}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>;
}
