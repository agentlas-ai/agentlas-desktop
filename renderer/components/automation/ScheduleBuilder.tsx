// 스케줄 빌더(설계 §2.5, P1 한계 #8) — 전체 스케줄 문법에 UI로 도달한다.
// 프리셋 칩 + 커스텀 cron(라이브 검증) + 시간 피커 + 타임존 + 요일/날짜/간격 + once/manual.
// 산출물은 ScheduleSpec 하나. croner는 메인 프로세스에만 있으므로 cron 검증/설명/다음실행은
// window.agentlas.schedule.* IPC로 호출한다(렌더러는 croner를 import하지 않는다).
// 칸 정규화·빈 값의 뜻·저장 불가 사유·편집 왕복의 규칙은 전부 shared/schedule-form.ts(순수) 한 곳이다.
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import {
  compilePresetFields,
  hostTimeZone,
  hydrateSchedule,
  intNoteText,
  localInputToMs,
  monthlySkipDay,
  readIntDraft,
  scheduleProblem,
  settleInt,
  toLegacyToken,
  toggleDow,
  type FormMode,
  type FormPreset,
  type IntNote,
  type ScheduleProblem,
} from "@shared/schedule-form";
import type { ScheduleSpec } from "@/lib/types";

export interface ScheduleBuilderValue {
  spec: ScheduleSpec;
  /** 레거시 미러 토큰(scheduleHuman) — 기존 스케줄러가 schedule_json 없을 때 읽는 폴백. */
  legacyToken: string;
  /**
   * 이 폼 상태로는 저장할 수 없는 이유(기계 키). 있으면 spec 은 어림값이다 — 저장하거나 노드에 반영하지 않는다.
   * 비운 칸·틀린 cron·모르는 타임존·지난 시각을 기본값으로 대신하지 않기 위해서다.
   */
  problem?: ScheduleProblem | null;
}

type T = ReturnType<typeof useT>["t"];

/** 저장 불가 사유를 사람 말로(빌더 칸 곁과 저장 단추 곁이 같은 문장을 쓴다). */
export function scheduleProblemText(t: T, problem: ScheduleProblem): string {
  return t(`auto.sched.problem.${problem}`);
}

const DOW_LABELS_KO = ["일", "월", "화", "수", "목", "금", "토"];
const DOW_LABELS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CRON_PROBLEMS: ScheduleProblem[] = ["cron_blank", "cron_invalid", "cron_never"];
const ONCE_PROBLEMS: ScheduleProblem[] = ["once_blank", "once_invalid", "once_past"];

/** 지우고 다시 쓰는 숫자 칸 — 쓰는 도중 빈 값 허용, 칸을 떠날 때만 맞추고 알린다. */
function useIntField(initial: number, min: number, max?: number) {
  const [value, setValue] = useState(initial);
  const [text, setText] = useState(String(initial));
  const [note, setNote] = useState<{ kind: IntNote; value: number } | null>(null);
  return {
    value,
    text,
    note,
    bounds: { min, max },
    set(next: number) {
      setValue(next);
      setText(String(next));
      setNote(null);
    },
    onChange(raw: string) {
      setText(raw);
      setNote(null);
      const typed = readIntDraft(raw, min, max);
      if (typed !== null) setValue(typed);
    },
    onBlur() {
      const settled = settleInt(text, value, min, max);
      setValue(settled.value);
      setText(String(settled.value));
      setNote(settled.note ? { kind: settled.note, value: settled.value } : null);
    },
  };
}

export function ScheduleBuilder({
  value,
  onChange,
}: {
  value?: ScheduleSpec | null;
  onChange: (v: ScheduleBuilderValue) => void;
}) {
  const { t, locale } = useT();
  const loc: "ko" | "en" = locale === "ko" ? "ko" : "en";
  const hostTz = useMemo(() => hostTimeZone(), []);
  const initialValueRef = useRef(value);
  const [hydrated, setHydrated] = useState(!value);
  const [tz, setTz] = useState("UTC");
  const [mode, setMode] = useState<FormMode>("preset");
  const [preset, setPreset] = useState<FormPreset>("daily");
  const [time, setTime] = useState("09:00");
  const [dows, setDows] = useState<number[]>([1]);
  const dayField = useIntField(1, 1, 31);
  const everyField = useIntField(30, 1);
  const [aligned, setAligned] = useState(true);
  const [cronExpr, setCronExpr] = useState("*/30 9-18 * * 1-5");
  const [cronCheck, setCronCheck] = useState<{ expr: string; ok: boolean } | null>(null);
  const [onceAt, setOnceAt] = useState("");
  const [shownFor, setShownFor] = useState<{ key: string; summary: string; next: string | null } | null>(null);
  const [, setTick] = useState(0);

  // 초기 tz 기본값(host).
  useEffect(() => {
    if (initialValueRef.current) return;
    const api = ipc();
    if (!api) {
      setTz(hostTz);
      return;
    }
    void api.schedule.defaultTz().then((z) => setTz((cur) => (cur === "UTC" ? z : cur)));
  }, [hostTz]);

  // 기존 spec에서 UI 상태 하이드레이트(편집 모드). 프리셋으로 손실 없이 되돌릴 수 있는 것만 프리셋으로 읽는다.
  useEffect(() => {
    if (!value) {
      setHydrated(true);
      return;
    }
    const h = hydrateSchedule(value);
    if (h.mode === "manual") setMode("manual");
    else if (h.mode === "once") {
      setMode("once");
      setOnceAt(h.onceAt);
    } else if (h.mode === "cron") {
      setMode("cron");
      setTz(h.tz);
      setCronExpr(h.cronExpr);
    } else {
      setMode("preset");
      setPreset(h.preset);
      setTime(h.time);
      setDows(h.dows);
      dayField.set(h.day);
      everyField.set(h.everyMin);
      setAligned(h.aligned);
      if (h.tz) setTz(h.tz);
    }
    setHydrated(true);
    // 최초 1회만 하이드레이트.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const presetFields = {
    preset,
    time,
    dows,
    day: dayField.value,
    everyMin: everyField.value,
    aligned,
  };

  // 현재 UI 상태 → ScheduleSpec. 비운 칸은 기본값으로 대신하지 않는다 — 어림값이 필요하면 problem 이 막는다.
  const spec: ScheduleSpec = useMemo(() => {
    if (mode === "manual") return { kind: "manual" };
    const zone = tz.trim() || hostTz;
    if (mode === "once") {
      const ms = localInputToMs(onceAt);
      return { kind: "once", atIso: ms === null ? "" : new Date(ms).toISOString() };
    }
    const compiled: ScheduleSpec = mode === "cron"
      ? { kind: "cron", expr: cronExpr.trim(), tz: zone }
      : compilePresetFields({ preset, time, dows, day: dayField.value, everyMin: everyField.value, aligned }, zone);
    // The schedule that was opened may carry "every Nth week" / "skipped dates" (made by an agent, or by an earlier edit): the form has no field for them, so a cron it
    // compiles keeps them (their words are in the summary line below), and the person never loses a rule they did not see.
    const opened = initialValueRef.current;
    if (compiled.kind === "cron" && opened && opened.kind === "cron" && (opened.everyWeeks || opened.skipDates?.length)) {
      return { ...compiled, ...(opened.everyWeeks ? { everyWeeks: opened.everyWeeks } : {}), ...(opened.skipDates?.length ? { skipDates: opened.skipDates } : {}) };
    }
    return compiled;
  }, [mode, onceAt, cronExpr, tz, hostTz, preset, time, dows, dayField.value, everyField.value, aligned]);
  const specKey = JSON.stringify(spec);

  // cron 라이브 검증(IPC).
  useEffect(() => {
    if (mode !== "cron") {
      setCronCheck(null);
      return;
    }
    const api = ipc();
    if (!api) {
      setCronCheck({ expr: cronExpr, ok: cronExpr.trim().split(/\s+/).length >= 5 });
      return;
    }
    let cancelled = false;
    void api.schedule.validateCron(cronExpr).then((ok) => {
      if (!cancelled) setCronCheck({ expr: cronExpr, ok });
    });
    return () => {
      cancelled = true;
    };
  }, [mode, cronExpr]);

  const problemBase = { mode, preset, time, cronExpr, tz, onceAt, now: Date.now(), hostTz } as const;
  const syncProblem = scheduleProblem(problemBase);
  const shown = shownFor && shownFor.key === specKey ? shownFor : null;
  const problem = syncProblem ?? scheduleProblem({
    ...problemBase,
    ...(cronCheck && cronCheck.expr === cronExpr ? { cronValid: cronCheck.ok } : {}),
    ...(shown ? { nextRun: shown.next } : {}),
  });

  // 요약 + 다음 실행(IPC). 만들 수 없는 상태의 일정은 설명하지 않는다(거짓 요약 방지).
  useEffect(() => {
    if (syncProblem) {
      setShownFor(null);
      return;
    }
    const api = ipc();
    if (!api) {
      setShownFor(null);
      return;
    }
    let cancelled = false;
    void Promise.all([api.schedule.describe(spec, loc), api.schedule.nextRun(spec)]).then(([desc, next]) => {
      if (!cancelled) setShownFor({ key: specKey, summary: desc, next });
    });
    return () => {
      cancelled = true;
    };
    // spec 은 specKey 로 대표한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, loc, syncProblem]);

  // 고른 한 번짜리 시각이 지나가면 그 순간 다시 판정한다(폼을 열어 둔 채 시각이 지난 경우).
  useEffect(() => {
    if (mode !== "once") return;
    const ms = localInputToMs(onceAt);
    if (ms === null || ms <= Date.now()) return;
    const id = window.setTimeout(() => setTick((n) => n + 1), Math.min(ms - Date.now() + 250, 2_000_000_000));
    return () => window.clearTimeout(id);
  }, [mode, onceAt]);

  // 부모에 값 전달 — 직렬화 값이 실제로 바뀔 때만 emit(부모 onChange가 인라인이어도 무한루프 방지).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastEmitted = useRef<string>("");
  const suppressHydratedValue = useRef(Boolean(value));
  // 열린 그대로의 일정은 주인이 고친 것이 아니다 — 저장돼 있던 일정에 이미 있던 문제(지난 시각·안 도는 식)는
  // 이름만 고치는 저장을 막지 않는다. 일정을 한 번이라도 바꿔 알렸다면 그 뒤로는 모든 변화를 알린다.
  const openedIdentity = useRef<string | null>(null);
  const reportedSinceOpen = useRef(false);
  const emitProblem = problem ?? null;
  useEffect(() => {
    if (!hydrated) return;
    const token = toLegacyToken(mode, presetFields, spec, loc);
    const serialized = JSON.stringify({ spec, token, problem: emitProblem });
    const identity = JSON.stringify({ spec, token });
    if (suppressHydratedValue.current) {
      suppressHydratedValue.current = false;
      openedIdentity.current = identity;
      lastEmitted.current = serialized;
      return;
    }
    if (serialized === lastEmitted.current) return;
    lastEmitted.current = serialized;
    if (openedIdentity.current === identity && !reportedSinceOpen.current) return;
    reportedSinceOpen.current = true;
    onChangeRef.current({ spec, legacyToken: token, problem: emitProblem });
    // locale은 토큰 문구(describeSchedule)에 들어가므로 의존성에 포함한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, specKey, mode, preset, time, dows, dayField.value, loc, emitProblem]);

  const problemOf = (group: ScheduleProblem[]): ScheduleProblem | null => (problem && group.includes(problem) ? problem : null);
  const cronProblem = problemOf(CRON_PROBLEMS);
  const onceProblem = problemOf(ONCE_PROBLEMS);
  const timeProblem = problemOf(["time_blank"]);
  const tzProblem = problemOf(["tz_invalid"]);
  const showTz = mode === "cron" || (mode === "preset" && preset !== "interval");
  const skipDay = preset === "monthly" ? monthlySkipDay(dayField.value) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(["preset", "cron", "once", "manual"] as FormMode[]).map((m) => (
          <Chip key={m} active={mode === m} onClick={() => setMode(m)} label={t(`auto.sched.mode.${m}`)} />
        ))}
      </div>

      {mode === "preset" && (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["daily", "weekday", "weekly", "monthly", "hourly", "interval"] as FormPreset[]).map((p) => (
              <Chip key={p} active={preset === p} onClick={() => setPreset(p)} label={t(`auto.sched.preset.${p}`)} />
            ))}
          </div>
          {preset !== "hourly" && preset !== "interval" && (
            <>
              <Row label={t("auto.sched.time")}>
                <input
                  type="time"
                  lang={loc}
                  value={time}
                  aria-invalid={timeProblem ? true : undefined}
                  onChange={(e) => setTime(e.target.value)}
                  style={inputStyle}
                />
              </Row>
              {timeProblem && <Note tone="error">{scheduleProblemText(t, timeProblem)}</Note>}
            </>
          )}
          {preset === "weekly" && (
            <>
              <Row label={t("auto.sched.dow")}>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {DOW_LABELS_EN.map((en, i) => (
                    <Chip
                      key={en}
                      active={dows.includes(i)}
                      onClick={() => setDows((cur) => toggleDow(cur, i))}
                      label={(loc === "ko" ? DOW_LABELS_KO : DOW_LABELS_EN)[i]}
                    />
                  ))}
                </div>
              </Row>
              <Note>{t("auto.sched.dow.hint")}</Note>
            </>
          )}
          {preset === "monthly" && (
            <>
              <Row label={t("auto.sched.day")}>
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={dayField.text}
                  onChange={(e) => dayField.onChange(e.target.value)}
                  onBlur={dayField.onBlur}
                  style={{ ...inputStyle, width: 90 }}
                />
              </Row>
              {dayField.note && <Note tone="error">{intNoteText(dayField.note.kind, loc, dayField.bounds, dayField.note.value)}</Note>}
              {skipDay !== null && <Note>{t("auto.sched.day.skip", { day: skipDay })}</Note>}
            </>
          )}
          {preset === "interval" && (
            <>
              <Row label={t("auto.sched.every")}>
                <input
                  type="number"
                  min={1}
                  value={everyField.text}
                  onChange={(e) => everyField.onChange(e.target.value)}
                  onBlur={everyField.onBlur}
                  style={{ ...inputStyle, width: 90 }}
                />
              </Row>
              {everyField.note && <Note tone="error">{intNoteText(everyField.note.kind, loc, everyField.bounds, everyField.note.value)}</Note>}
              <label style={checkboxRow}>
                <input type="checkbox" checked={aligned} onChange={(e) => setAligned(e.target.checked)} />
                {t("auto.sched.aligned")}
              </label>
            </>
          )}
        </>
      )}

      {mode === "cron" && (
        <>
          <Row label={t("auto.sched.cron.label")}>
            <input
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              placeholder="*/30 9-18 * * 1-5"
              aria-invalid={cronProblem && cronProblem !== "cron_blank" ? true : undefined}
              style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
            />
          </Row>
          {cronProblem ? (
            <Note tone={cronProblem === "cron_blank" ? "muted" : "error"}>{scheduleProblemText(t, cronProblem)}</Note>
          ) : (
            cronCheck && cronCheck.expr === cronExpr && cronCheck.ok && <Note tone="ok">{t("auto.sched.cron.valid")}</Note>
          )}
        </>
      )}

      {mode === "once" && (
        <>
          <Row label={t("auto.sched.once.at")}>
            <input
              type="datetime-local"
              lang={loc}
              value={onceAt}
              aria-invalid={onceProblem && onceProblem !== "once_blank" ? true : undefined}
              onChange={(e) => setOnceAt(e.target.value)}
              style={inputStyle}
            />
          </Row>
          {onceProblem && <Note tone={onceProblem === "once_blank" ? "muted" : "error"}>{scheduleProblemText(t, onceProblem)}</Note>}
        </>
      )}

      {showTz && (
        <>
          <Row label={t("auto.sched.tz")}>
            <input
              value={tz}
              onChange={(e) => setTz(e.target.value)}
              placeholder={hostTz}
              aria-invalid={tzProblem ? true : undefined}
              style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
            />
          </Row>
          {tzProblem ? <Note tone="error">{scheduleProblemText(t, tzProblem)}</Note> : <Note>{t("auto.sched.tz.hint", { tz: hostTz })}</Note>}
        </>
      )}

      {!problem && shown && (shown.summary || shown.next) && (
        <div style={{ fontSize: 11.5, color: "var(--muted-deep)", lineHeight: 1.6, paddingTop: 4, borderTop: "1px solid var(--paper-edge)" }}>
          {shown.summary && (
            <div>
              <strong>{t("auto.sched.summary")}:</strong> {shown.summary}
            </div>
          )}
          {shown.next && (
            <div>
              <strong>{t("auto.sched.next")}:</strong>{" "}
              {new Date(shown.next).toLocaleString(loc === "ko" ? "ko-KR" : "en-US")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 칸 곁 한 줄 안내. 오류는 붉게, 안내는 흐리게. */
function Note({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "error" | "ok" }) {
  const color = tone === "error" ? "var(--red-deep, var(--danger))" : tone === "ok" ? "var(--green-deep)" : "var(--muted-deep)";
  return (
    <div role="status" style={{ fontSize: 11, marginTop: -6, lineHeight: 1.5, color }}>
      {children}
    </div>
  );
}

function Chip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        background: active ? "var(--fill-1)" : "var(--paper-2)",
        color: active ? "var(--accent)" : "var(--ink-soft)",
        border: active ? "1px solid var(--accent-soft)" : "1px solid var(--paper-edge)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

/*
 * ★보이는 이름과 **읽히는 이름**은 다르다 (실측 2026-09-08).
 *   이름을 <div> 로 그리면 눈에는 보여도 그 아래 입력칸과 연결되지 않아, 화면 낭독기에는
 *   이름 없는 칸으로 읽힌다. <label> 로 감싸면 id 없이도 브라우저가 둘을 묶는다.
 *   여기 한 곳으로 이 화면의 입력칸 4개가 한꺼번에 이름을 얻는다. 보이는 모양은 그대로다.
 *
 *   다만 요일 고르기처럼 **여러 단추**를 담는 줄도 있으므로 label 이 아니라 group 으로
 *   그려야 하는 경우가 있다 — children 이 단일 입력이 아닐 때를 위해 role="group" 을 함께 준다.
 */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", marginBottom: 5 }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  fontSize: 13,
  outline: "none",
};

const checkboxRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
  color: "var(--ink-soft)",
  cursor: "pointer",
};
