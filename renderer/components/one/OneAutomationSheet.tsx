"use client";

// One 안 자동화 직접 생성 시트 — 칩 ③에서 열리고, `automations:create` IPC를
// 직접 호출한다(딥링크 폴백 없음). 생성 파라미터는 이 시트의 명시적 입력만으로
// 결정적으로 구성된다: 트리거 클릭 컨텍스트에서 절대 유도하지 않는다
// (과거 트리거클릭 유래 파라미터가 daily cron 설정을 파괴한 사고의 재발 방지).
// 실패는 오류 그대로 보여주고 재시도를 제안한다 — 조용한 폴백 없음.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ipc } from "@/lib/ipc";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import { tFor } from "@/lib/i18n";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import type { Automation, AutomationCreateInput } from "@/lib/types";
import { OneBottomSheet } from "./OneBottomSheet";
import styles from "./OneAutomationSheet.module.css";

/** One 실행을 맡는 기본 로컬 에이전트 슬러그 — chats fallback과 같은 대상. */
const ONE_DEFAULT_RUNNER_SLUG = "agentlas-orchestrator";

type Cadence = "daily" | "weekday" | "weekly" | "hourly";
type Dow = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

const DOW_ORDER: Dow[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const DOW_KEYS = {
  mon: "one.autosheet.dow_mon",
  tue: "one.autosheet.dow_tue",
  wed: "one.autosheet.dow_wed",
  thu: "one.autosheet.dow_thu",
  fri: "one.autosheet.dow_fri",
  sat: "one.autosheet.dow_sat",
  sun: "one.autosheet.dow_sun",
} as const;

/**
 * 시트 입력 → 레거시 스케줄 토큰. Main의 parseLegacyToken(6종 계약)과 정확히
 * 일치하는 문자열만 만든다. 여기서 만들어질 수 없는 형태는 존재하지 않는다.
 */
export function oneAutomationScheduleToken(cadence: Cadence, time: string, dow: Dow): string {
  if (cadence === "hourly") return "hourly";
  if (cadence === "weekly") return `weekly-${dow}-${time}`;
  return `${cadence}-${time}`;
}

interface OneAutomationSheetProps {
  open: boolean;
  locale: "ko" | "en";
  onClose: () => void;
  onOpenAutomation: (automationId: string) => void;
}

function formatNextRun(value: string | null, locale: "ko" | "en"): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function OneAutomationSheet({ open, locale, onClose, onOpenAutomation }: OneAutomationSheetProps) {
  const busyRef = useRef(false);
  const [name, setName] = useState("");
  const [cadence, setCadence] = useState<Cadence>("daily");
  const [time, setTime] = useState("09:00");
  const [dow, setDow] = useState<Dow>("mon");
  const [what, setWhat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Automation | null>(null);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setCreated(null);
  }, [onClose, open]);

  const submit = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    if (busyRef.current) return;
    const trimmedName = name.trim();
    const trimmedWhat = what.trim();
    if (!trimmedName) {
      setError(tFor(locale, "one.autosheet.name_required"));
      return;
    }
    if (!trimmedWhat) {
      setError(tFor(locale, "one.autosheet.what_required"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const api = ipc();
      if (!api) throw new Error(tFor(locale, "one.shell.composer.not_connected"));
      const agents = await api.team.list();
      const runner = agents.find((agent) => agent.slug === ONE_DEFAULT_RUNNER_SLUG);
      if (!runner) throw new Error(tFor(locale, "one.autosheet.error_target"));
      // 결정적·명시적 파라미터만 사용한다. 스케줄은 이 시트의 입력에서만 나오고,
      // 실행 대상은 One의 기본 로컬 러너로 고정된다(로컬 전용, 그래프 없음).
      const input: AutomationCreateInput = {
        name: trimmedName,
        scheduleHuman: oneAutomationScheduleToken(cadence, time, dow),
        targetType: "agent",
        targetId: runner.id,
        promptTemplate: trimmedWhat,
        toolMode: "auto",
        hubMode: "local-only",
        triggerType: "schedule",
        trigger: { kind: "schedule" },
      };
      const automation = await api.automations.create(input);
      setCreated(automation);
    } catch (cause) {
      requestOneOperationalRecovery("one-automation-create", cause);
      setError(null);
    } finally {
      setBusy(false);
    }
  }, [cadence, dow, locale, name, time, what]);

  if (!open) return null;

  const nextRunLabel = created ? formatNextRun(created.nextRunAt, locale) : null;

  return (
    <OneBottomSheet
      open={open}
      onClose={onClose}
      closeLabel={tFor(locale, "one.autosheet.close")}
      ariaLabelledBy="one-automation-sheet-title"
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
      title={created ? tFor(locale, "one.autosheet.success_title") : tFor(locale, "one.autosheet.title")}
      titleId="one-automation-sheet-title"
      description={created ? undefined : tFor(locale, "one.autosheet.body")}
    >
      <div className={styles.content}>
        {created ? (
          <div className={styles.success} data-one-automation-created="true">
            <p className={styles.successName}>{created.name}</p>
            <p className={styles.successNext}>
              {nextRunLabel
                ? tFor(locale, "one.autosheet.success_next", { time: nextRunLabel })
                : tFor(locale, "one.autosheet.success_none")}
            </p>
            <div className={styles.actions}>
              <button type="button" className={styles.primary} onClick={() => onOpenAutomation(created.id)}>
                {tFor(locale, "one.autosheet.open_detail")}
              </button>
              <button type="button" className={styles.ghost} onClick={onClose}>
                {tFor(locale, "one.autosheet.close")}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <label className={styles.field}>
              <span>{tFor(locale, "one.autosheet.name")}</span>
              <input
                type="text"
                value={name}
                maxLength={80}
                placeholder={tFor(locale, "one.autosheet.name_placeholder")}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className={styles.row}>
              <label className={styles.field}>
                <span>{tFor(locale, "one.autosheet.cadence")}</span>
                <select value={cadence} onChange={(event) => setCadence(event.target.value as Cadence)}>
                  <option value="daily">{tFor(locale, "one.autosheet.cadence_daily")}</option>
                  <option value="weekday">{tFor(locale, "one.autosheet.cadence_weekday")}</option>
                  <option value="weekly">{tFor(locale, "one.autosheet.cadence_weekly")}</option>
                  <option value="hourly">{tFor(locale, "one.autosheet.cadence_hourly")}</option>
                </select>
              </label>
              {cadence === "weekly" && (
                <label className={styles.field}>
                  <span>{tFor(locale, "one.autosheet.dow")}</span>
                  <select value={dow} onChange={(event) => setDow(event.target.value as Dow)}>
                    {DOW_ORDER.map((day) => (
                      <option key={day} value={day}>{tFor(locale, DOW_KEYS[day])}</option>
                    ))}
                  </select>
                </label>
              )}
              {cadence !== "hourly" && (
                <label className={styles.field}>
                  <span>{tFor(locale, "one.autosheet.time")}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    required
                    maxLength={5}
                    pattern="(?:[01]\\d|2[0-3]):[0-5]\\d"
                    placeholder="09:00"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                  />
                </label>
              )}
            </div>
            <label className={styles.field}>
              <span>{tFor(locale, "one.autosheet.what")}</span>
              <textarea
                value={what}
                rows={3}
                maxLength={2000}
                placeholder={tFor(locale, "one.autosheet.what_placeholder")}
                onChange={(event) => setWhat(event.target.value)}
              />
            </label>
            {error && <p className={styles.error} role="alert">{error}</p>}
            {busy && <div className={styles.busyState} role="status" aria-live="polite">
              <span aria-hidden="true" />
              <div>
                <strong>{tFor(locale, "one.autosheet.creating")}</strong>
                <LoadingEstimate locale={locale} operationKey="one-automation-create" expectedSeconds={[1, 20]} />
              </div>
            </div>}
            <div className={styles.actions}>
              <button type="submit" className={styles.primary} disabled={busy}>
                {busy
                  ? tFor(locale, "one.autosheet.creating")
                  : error
                    ? tFor(locale, "one.autosheet.retry")
                    : tFor(locale, "one.autosheet.create")}
              </button>
              <button type="button" className={styles.ghost} disabled={busy} onClick={onClose}>
                {tFor(locale, "one.autosheet.close")}
              </button>
            </div>
          </form>
        )}
      </div>
    </OneBottomSheet>
  );
}
