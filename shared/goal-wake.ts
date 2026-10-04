/** The Goal's next host wake, as Main reports it (electron/long-run/goal-next-wake.ts). */
export interface GoalNextWake {
  at: string;
  /** The ledger reason behind the time (a retry's blocker, or `wait:<subject kind>`). */
  cause: string;
  /** model = the Goal's own turn asked for that time; monitor = a Toolchain's result changes it; budget = the daily wake cap. */
  requestedBy: "model" | "host" | "monitor" | "budget";
  wakesToday: number;
  budget: number;
}

/** Read the field defensively: the Goal context crosses IPC as plain data. */
export function goalNextWakeOf(context: unknown): GoalNextWake | null {
  const value = context && typeof context === "object" ? (context as { nextWake?: unknown }).nextWake : null;
  if (!value || typeof value !== "object") return null;
  const wake = value as Partial<GoalNextWake>;
  return typeof wake.at === "string" && Number.isFinite(Date.parse(wake.at)) && typeof wake.cause === "string"
    && ["model", "host", "monitor", "budget"].includes(String(wake.requestedBy))
    && Number.isFinite(wake.wakesToday) && Number.isFinite(wake.budget) ? wake as GoalNextWake : null;
}

/** "다음 확인 15:11 · 모델 요청 · 오늘 3회" — the clock is the viewer's local time. */
export function goalNextWakeLabel(wake: GoalNextWake, locale: "ko" | "en", now = Date.now()): string {
  const at = new Date(wake.at);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const sameDay = new Date(now).toDateString() === at.toDateString();
  const when = sameDay ? clock : locale === "ko" ? `${at.getMonth() + 1}월 ${at.getDate()}일 ${clock}` : `${at.getMonth() + 1}/${at.getDate()} ${clock}`;
  const by = locale === "ko"
    ? { model: "모델 요청", host: "자동 재시도", monitor: "감시 결과 변화 시", budget: "하루 한도 도달" }[wake.requestedBy]
    : { model: "requested by the model", host: "automatic retry", monitor: "when the monitor changes", budget: "daily limit reached" }[wake.requestedBy];
  const count = locale === "ko" ? `오늘 ${wake.wakesToday}회` : `${wake.wakesToday} today`;
  return locale === "ko" ? `다음 확인 ${when} · ${by} · ${count}` : `Next check ${when} · ${by} · ${count}`;
}
