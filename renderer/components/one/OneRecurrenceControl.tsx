"use client";

import {
  ONE_RECURRENCE_SELECTION_CONTRACT_VERSION,
  isOneRecurrenceSelectionV1,
  type OneRecurrenceCadence,
  type OneRecurrenceIntentKind,
  type OneRecurrenceSelectionV1,
} from "@shared/one-recurrence";
import type { OneAutomationPermissionPreview } from "@shared/one-suggestions";
import { tFor } from "@/lib/i18n";
import styles from "./OneRecurrenceControl.module.css";

type RecurrenceFallbackKey = "one.rec.sheet.aria" | "one.rec.explainer";

const RECURRENCE_FALLBACKS: Record<RecurrenceFallbackKey, Record<"ko" | "en", string>> = {
  "one.rec.sheet.aria": { ko: "반복 조건", en: "Repeat conditions" },
  "one.rec.explainer": {
    ko: "이건 자동화가 아니에요. 지금은 원하는 반복 방식만 적어 둡니다. 서로 다른 결과 3개를 확인하고 나면 One이 일정으로 만들지 물어봐요. 내가 확인하기 전에는 어떤 일정도 저장되거나 켜지거나 실행되지 않아요.",
    en: "This is not automation. It only records how you may want the work repeated. After you accept three separate results, One may ask whether to turn it into a schedule. No schedule is saved, enabled, or run until you confirm it.",
  },
};

function recurrenceCopy(locale: "ko" | "en", key: RecurrenceFallbackKey): string {
  const value = tFor(locale, key);
  return value === key ? RECURRENCE_FALLBACKS[key][locale] : value;
}

const INTENTS = [
  { value: "briefing", labelKey: "one.rec.intent.briefing" },
  { value: "research", labelKey: "one.rec.intent.research" },
  { value: "file_review", labelKey: "one.rec.intent.file_review" },
  { value: "content_draft", labelKey: "one.rec.intent.content_draft" },
  { value: "status_check", labelKey: "one.rec.intent.status_check" },
] as const satisfies ReadonlyArray<{ value: OneRecurrenceIntentKind; labelKey: string }>;

const CADENCES = [
  { value: "daily", labelKey: "one.rec.cadence.daily" },
  { value: "weekdays", labelKey: "one.rec.cadence.weekdays" },
  { value: "weekly", labelKey: "one.rec.cadence.weekly" },
] as const satisfies ReadonlyArray<{ value: OneRecurrenceCadence; labelKey: string }>;

const WEEKDAYS = [
  [1, "one.rec.weekday.mon"],
  [2, "one.rec.weekday.tue"],
  [3, "one.rec.weekday.wed"],
  [4, "one.rec.weekday.thu"],
  [5, "one.rec.weekday.fri"],
  [6, "one.rec.weekday.sat"],
  [7, "one.rec.weekday.sun"],
] as const;

const PERMISSIONS = [
  { value: "read_only", labelKey: "one.rec.perm.read_only" },
  { value: "draft_only", labelKey: "one.rec.perm.draft_only" },
  { value: "approval_before_external_change", labelKey: "one.rec.perm.approval" },
] as const satisfies ReadonlyArray<{ value: OneAutomationPermissionPreview; labelKey: string }>;

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
          aria-label={tFor(locale, "one.rec.toggle.aria")}
          aria-describedby={active ? "one-recurrence-explainer" : undefined}
        />
        <span>
          <strong>{tFor(locale, "one.rec.toggle.title")}</strong>
          {active && (
            <small>{tFor(locale, "one.rec.toggle.unsaved")}</small>
          )}
        </span>
      </label>
      {value && (
        <div className={styles.sheet} role="group" aria-label={recurrenceCopy(locale, "one.rec.sheet.aria")}>
          <div className={styles.fields}>
            <label>
              <span>{tFor(locale, "one.rec.field.intent")}</span>
              <select
                value={value.intentKind}
                disabled={disabled}
                onChange={(event) => set({ intentKind: event.target.value as OneRecurrenceIntentKind })}
              >
                {INTENTS.map((item) => <option key={item.value} value={item.value}>{tFor(locale, item.labelKey)}</option>)}
              </select>
            </label>
            <label>
              <span>{tFor(locale, "one.rec.field.cadence")}</span>
              <select
                value={value.cadence}
                disabled={disabled}
                onChange={(event) => {
                  const cadence = event.target.value as OneRecurrenceCadence;
                  set({ cadence, weekday: cadence === "weekly" ? 1 : null });
                }}
              >
                {CADENCES.map((item) => <option key={item.value} value={item.value}>{tFor(locale, item.labelKey)}</option>)}
              </select>
            </label>
            {value.cadence === "weekly" && (
              <label>
                <span>{tFor(locale, "one.rec.field.weekday")}</span>
                <select
                  value={value.weekday ?? 1}
                  disabled={disabled}
                  onChange={(event) => set({ weekday: Number(event.target.value) })}
                >
                  {WEEKDAYS.map(([weekday, labelKey]) => (
                    <option key={weekday} value={weekday}>{tFor(locale, labelKey)}</option>
                  ))}
                </select>
              </label>
            )}
            <label>
              <span>{tFor(locale, "one.rec.field.local_time")}</span>
              <input
                type="time"
                step={60}
                value={value.localTime}
                disabled={disabled}
                onChange={(event) => set({ localTime: event.target.value })}
              />
            </label>
            <label>
              <span>{tFor(locale, "one.rec.field.time_zone")}</span>
              <input value={value.timeZone} readOnly aria-readonly="true" />
            </label>
            <label>
              <span>{tFor(locale, "one.rec.field.permission")}</span>
              <select
                value={value.permission}
                disabled={disabled}
                onChange={(event) => set({ permission: event.target.value as OneAutomationPermissionPreview })}
              >
                {PERMISSIONS.map((item) => <option key={item.value} value={item.value}>{tFor(locale, item.labelKey)}</option>)}
              </select>
            </label>
          </div>
          <p className={styles.stop}><strong>{tFor(locale, "one.rec.stop.title")}</strong>{tFor(locale, "one.rec.stop.body")}</p>
          <p id="one-recurrence-explainer" className={styles.explainer}>
            {recurrenceCopy(locale, "one.rec.explainer")}
          </p>
        </div>
      )}
    </section>
  );
}
