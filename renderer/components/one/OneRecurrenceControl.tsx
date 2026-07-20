"use client";

import {
  ONE_RECURRENCE_SELECTION_CONTRACT_VERSION,
  isOneRecurrenceSelectionV1,
  type OneRecurrenceCadence,
  type OneRecurrenceIntentKind,
  type OneRecurrenceSelectionV1,
} from "@shared/one-recurrence";
import type { OneAutomationPermissionPreview } from "@shared/one-suggestions";
import styles from "./OneRecurrenceControl.module.css";

const INTENTS: Array<{ value: OneRecurrenceIntentKind; ko: string; en: string }> = [
  { value: "briefing", ko: "브리핑", en: "Briefing" },
  { value: "research", ko: "리서치", en: "Research" },
  { value: "file_review", ko: "파일 검토", en: "File review" },
  { value: "content_draft", ko: "콘텐츠 초안", en: "Content draft" },
  { value: "status_check", ko: "상태 확인", en: "Status check" },
];

const CADENCES: Array<{ value: OneRecurrenceCadence; ko: string; en: string }> = [
  { value: "daily", ko: "매일", en: "Daily" },
  { value: "weekdays", ko: "평일", en: "Weekdays" },
  { value: "weekly", ko: "매주", en: "Weekly" },
];

const WEEKDAYS = [
  [1, "월요일", "Monday"],
  [2, "화요일", "Tuesday"],
  [3, "수요일", "Wednesday"],
  [4, "목요일", "Thursday"],
  [5, "금요일", "Friday"],
  [6, "토요일", "Saturday"],
  [7, "일요일", "Sunday"],
] as const;

const PERMISSIONS: Array<{ value: OneAutomationPermissionPreview; ko: string; en: string }> = [
  { value: "read_only", ko: "살펴보기만", en: "Look only" },
  { value: "draft_only", ko: "초안 만들기", en: "Make a draft" },
  { value: "approval_before_external_change", ko: "밖으로 보내기 전에 묻기", en: "Ask before sending anything" },
];

function hostTimeZone(): string {
  const candidate = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const sample: OneRecurrenceSelectionV1 = {
    contractVersion: ONE_RECURRENCE_SELECTION_CONTRACT_VERSION,
    intentKind: "briefing",
    cadence: "weekdays",
    weekday: null,
    localTime: "09:00",
    timeZone: candidate,
    startPolicy: "after_review_approval",
    endPolicy: "manual_stop",
    permission: "draft_only",
  };
  return isOneRecurrenceSelectionV1(sample) ? candidate : "UTC";
}

function initialSelection(): OneRecurrenceSelectionV1 {
  return {
    contractVersion: ONE_RECURRENCE_SELECTION_CONTRACT_VERSION,
    intentKind: "briefing",
    cadence: "weekdays",
    weekday: null,
    localTime: "09:00",
    timeZone: hostTimeZone(),
    startPolicy: "after_review_approval",
    endPolicy: "manual_stop",
    permission: "draft_only",
  };
}

export function OneRecurrenceControl({
  locale,
  disabled,
  value,
  onChange,
}: {
  locale: "ko" | "en";
  disabled: boolean;
  value: OneRecurrenceSelectionV1 | null;
  onChange: (value: OneRecurrenceSelectionV1 | null) => void;
}) {
  const ko = locale === "ko";
  const active = value !== null;
  const set = (patch: Partial<OneRecurrenceSelectionV1>) => {
    const next = { ...(value ?? initialSelection()), ...patch };
    if (!isOneRecurrenceSelectionV1(next)) return;
    onChange(next);
  };
  return (
    <section className={styles.control} data-one-recurrence-active={active ? "true" : "false"}>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={active}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked ? initialSelection() : null)}
          aria-label={ko ? "반복 조건 사용" : "Use repeat conditions"}
          aria-describedby={active ? "one-recurrence-explainer" : undefined}
        />
        <span>
          <strong>{ko ? "이 일을 반복하기" : "Repeat this work"}</strong>
          {active && (
            <small>{ko ? "아직 일정은 저장되지 않았어요" : "No schedule has been saved yet"}</small>
          )}
        </span>
      </label>
      {value && (
        <div className={styles.sheet} role="group" aria-label={ko ? "반복 조건" : "Repeat conditions"}>
          <div className={styles.fields}>
            <label>
              <span>{ko ? "작업 종류" : "Work type"}</span>
              <select
                value={value.intentKind}
                disabled={disabled}
                onChange={(event) => set({ intentKind: event.target.value as OneRecurrenceIntentKind })}
              >
                {INTENTS.map((item) => <option key={item.value} value={item.value}>{ko ? item.ko : item.en}</option>)}
              </select>
            </label>
            <label>
              <span>{ko ? "주기" : "Cadence"}</span>
              <select
                value={value.cadence}
                disabled={disabled}
                onChange={(event) => {
                  const cadence = event.target.value as OneRecurrenceCadence;
                  set({ cadence, weekday: cadence === "weekly" ? 1 : null });
                }}
              >
                {CADENCES.map((item) => <option key={item.value} value={item.value}>{ko ? item.ko : item.en}</option>)}
              </select>
            </label>
            {value.cadence === "weekly" && (
              <label>
                <span>{ko ? "요일" : "Weekday"}</span>
                <select
                  value={value.weekday ?? 1}
                  disabled={disabled}
                  onChange={(event) => set({ weekday: Number(event.target.value) })}
                >
                  {WEEKDAYS.map(([weekday, koLabel, enLabel]) => (
                    <option key={weekday} value={weekday}>{ko ? koLabel : enLabel}</option>
                  ))}
                </select>
              </label>
            )}
            <label>
              <span>{ko ? "현지 시각" : "Local time"}</span>
              <input
                type="time"
                step={60}
                value={value.localTime}
                disabled={disabled}
                onChange={(event) => set({ localTime: event.target.value })}
              />
            </label>
            <label>
              <span>{ko ? "시간대" : "Time zone"}</span>
              <input value={value.timeZone} readOnly aria-readonly="true" />
            </label>
            <label>
              <span>{ko ? "One이 할 수 있는 일" : "What One may do"}</span>
              <select
                value={value.permission}
                disabled={disabled}
                onChange={(event) => set({ permission: event.target.value as OneAutomationPermissionPreview })}
              >
                {PERMISSIONS.map((item) => <option key={item.value} value={item.value}>{ko ? item.ko : item.en}</option>)}
              </select>
            </label>
          </div>
          <p className={styles.stop}><strong>{ko ? "중지 조건" : "Stop condition"}</strong>{ko ? "항상 수동 중지 가능" : "Manual stop is always available"}</p>
          <p id="one-recurrence-explainer" className={styles.explainer}>
            {ko
              ? "이건 자동화가 아니에요. 지금은 원하는 반복 방식만 적어 둡니다. 서로 다른 결과 3개를 확인하고 나면 One이 일정으로 만들지 물어봐요. 내가 확인하기 전에는 어떤 일정도 저장되거나 켜지거나 실행되지 않아요."
              : "This is not automation. It only records how you may want the work repeated. After you accept three separate results, One may ask whether to turn it into a schedule. No schedule is saved, enabled, or run until you confirm it."}
          </p>
        </div>
      )}
    </section>
  );
}
