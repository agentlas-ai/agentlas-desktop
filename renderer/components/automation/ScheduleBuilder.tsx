// 스케줄 빌더(설계 §2.5, P1 한계 #8) — 전체 스케줄 문법에 UI로 도달한다.
// 프리셋 칩 + 커스텀 cron(라이브 검증) + 시간 피커 + 타임존 + 요일/날짜/간격 + once/manual.
// 산출물은 ScheduleSpec 하나. croner는 메인 프로세스에만 있으므로 cron 검증/설명/다음실행은
// window.agentlas.schedule.* IPC로 호출한다(렌더러는 croner를 import하지 않는다).
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { describeSchedule } from "@shared/schedule-describe";
import type { ScheduleSpec } from "@/lib/types";

type Mode = "preset" | "cron" | "once" | "manual";
type Preset = "daily" | "weekday" | "weekly" | "monthly" | "hourly" | "interval";

export interface ScheduleBuilderValue {
  spec: ScheduleSpec;
  /** 레거시 미러 토큰(scheduleHuman) — 기존 스케줄러가 schedule_json 없을 때 읽는 폴백. */
  legacyToken: string;
}

/**
 * ScheduleSpec + UI 힌트로부터 레거시 미러 토큰을 만든다(가능한 경우).
 *
 * cron/once/manual/interval은 하이픈 토큰 문법이 없다. 예전에는 자리표시자 `spec`을 돌려줬는데,
 * 이 값이 scheduleHuman으로 그대로 automations.schedule 컬럼에 저장돼 목록·상세·플로우 헤더·
 * 대시보드·모바일 투영에 "spec"이라는 내부 토큰이 노출됐다("spec · MyAgent"). scheduleHuman은
 * 계약상 사용자 친화 텍스트(shared/types.ts)이므로, 토큰 문법이 없을 때는 요약줄과 똑같은
 * describeSchedule 문구를 미러링한다. 발사 진실은 schedule_json이라 표시 문자열로 바꿔도
 * 스케줄러 동작은 그대로다(computeNextRun은 schedule_json을 우선 파싱하고, 파싱 불가 토큰의
 * 24h 폴백 경로는 `spec`일 때와 동일).
 */
function toLegacyToken(
  mode: Mode,
  preset: Preset,
  time: string,
  dow: number,
  day: number,
  spec: ScheduleSpec,
  locale: "ko" | "en",
): string {
  if (mode !== "preset") return describeSchedule(spec, locale);
  switch (preset) {
    case "hourly":
      return "hourly";
    case "daily":
      return `daily-${time}`;
    case "weekday":
      return `weekday-${time}`;
    case "weekly":
      return `weekly-${["sun", "mon", "tue", "wed", "thu", "fri", "sat"][dow] ?? "mon"}-${time}`;
    case "monthly":
      return `monthly-${day}-${time}`;
    case "interval":
      // interval 프리셋도 토큰 문법이 없다 — 위와 같은 이유로 사람이 읽을 문구를 저장한다.
      return describeSchedule(spec, locale);
    default:
      return `daily-${time}`;
  }
}

function compilePresetSpec(preset: Preset, time: string, tz: string, dow: number, day: number, everyMin: number, aligned: boolean): ScheduleSpec {
  const [hh, mm] = time.split(":").map((n) => parseInt(n, 10));
  const h = Number.isFinite(hh) ? hh : 9;
  const m = Number.isFinite(mm) ? mm : 0;
  switch (preset) {
    case "hourly":
      return { kind: "cron", expr: `${m} * * * *`, tz };
    case "daily":
      return { kind: "cron", expr: `${m} ${h} * * *`, tz };
    case "weekday":
      return { kind: "cron", expr: `${m} ${h} * * 1-5`, tz };
    case "weekly":
      return { kind: "cron", expr: `${m} ${h} * * ${dow}`, tz };
    case "monthly":
      return { kind: "cron", expr: `${m} ${h} ${day} * *`, tz };
    case "interval":
      return { kind: "interval", everyMs: Math.max(1, everyMin) * 60_000, anchor: aligned ? "wallclock" : "lastRun" };
    default:
      return { kind: "cron", expr: `${m} ${h} * * *`, tz };
  }
}

const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DOW_LABELS_KO = ["일", "월", "화", "수", "목", "금", "토"];
const DOW_LABELS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ScheduleBuilder({
  value,
  onChange,
}: {
  value?: ScheduleSpec | null;
  onChange: (v: ScheduleBuilderValue) => void;
}) {
  const { t, locale } = useT();
  const initialValueRef = useRef(value);
  const [hydrated, setHydrated] = useState(!value);
  const [tz, setTz] = useState("UTC");
  const [mode, setMode] = useState<Mode>("preset");
  const [preset, setPreset] = useState<Preset>("daily");
  const [time, setTime] = useState("09:00");
  const [dow, setDow] = useState(1);
  const [day, setDay] = useState(1);
  const [everyMin, setEveryMin] = useState(30);
  const [aligned, setAligned] = useState(true);
  const [cronExpr, setCronExpr] = useState("*/30 9-18 * * 1-5");
  const [cronValid, setCronValid] = useState<boolean | null>(null);
  const [onceAt, setOnceAt] = useState("");
  const [summary, setSummary] = useState("");
  const [nextRun, setNextRun] = useState<string | null>(null);

  // 초기 tz 기본값(host).
  useEffect(() => {
    if (initialValueRef.current) return;
    const api = ipc();
    if (!api) {
      setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
      return;
    }
    void api.schedule.defaultTz().then((z) => setTz((cur) => (cur === "UTC" ? z : cur)));
  }, []);

  // 기존 spec에서 UI 상태 하이드레이트(편집 모드).
  useEffect(() => {
    if (!value) {
      setHydrated(true);
      return;
    }
    if (value.kind === "manual") setMode("manual");
    else if (value.kind === "once") {
      setMode("once");
      setOnceAt(value.atIso.slice(0, 16));
    } else if (value.kind === "interval") {
      setMode("preset");
      setPreset("interval");
      setEveryMin(Math.max(1, Math.round(value.everyMs / 60_000)));
      setAligned(value.anchor === "wallclock");
    } else if (value.kind === "cron") {
      setTz(value.tz || "UTC");
      // 프리셋 역추론(간단): 표준형이면 프리셋 모드, 아니면 cron 모드.
      // 시(hour)도 순수 숫자 또는 "*"여야 한다 — "0 */2 * * *" 같은 간격 cron이
      // daily로 오판돼 하이드레이트만으로 스케줄이 망가지던 버그.
      const f = value.expr.trim().split(/\s+/);
      if (f.length === 5 && /^\d+$/.test(f[0]) && (/^\d+$/.test(f[1]) || f[1] === "*")) {
        const [m, h, dom, , dw] = f;
        setTime(`${(h === "*" ? 0 : parseInt(h, 10)).toString().padStart(2, "0")}:${parseInt(m, 10).toString().padStart(2, "0")}`);
        if (h === "*") setPreset("hourly");
        else if (dom === "*" && dw === "*") setPreset("daily");
        else if (dom === "*" && dw === "1-5") setPreset("weekday");
        else if (dom === "*" && /^\d$/.test(dw)) {
          setPreset("weekly");
          setDow(parseInt(dw, 10));
        } else if (/^\d+$/.test(dom) && dw === "*") {
          setPreset("monthly");
          setDay(parseInt(dom, 10));
        } else {
          setMode("cron");
          setCronExpr(value.expr);
        }
      } else {
        setMode("cron");
        setCronExpr(value.expr);
      }
    }
    setHydrated(true);
    // 최초 1회만 하이드레이트.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 현재 UI 상태 → ScheduleSpec.
  const spec: ScheduleSpec = useMemo(() => {
    if (mode === "manual") return { kind: "manual" };
    if (mode === "once") {
      const iso = onceAt ? new Date(onceAt).toISOString() : new Date(Date.now() + 3600_000).toISOString();
      return { kind: "once", atIso: iso };
    }
    if (mode === "cron") return { kind: "cron", expr: cronExpr.trim() || "0 9 * * *", tz };
    return compilePresetSpec(preset, time, tz, dow, day, everyMin, aligned);
  }, [mode, onceAt, cronExpr, tz, preset, time, dow, day, everyMin, aligned]);

  // cron 라이브 검증(IPC).
  useEffect(() => {
    if (mode !== "cron") {
      setCronValid(null);
      return;
    }
    const api = ipc();
    if (!api) {
      setCronValid(cronExpr.trim().split(/\s+/).length >= 5);
      return;
    }
    let cancelled = false;
    void api.schedule.validateCron(cronExpr).then((ok) => {
      if (!cancelled) setCronValid(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, cronExpr]);

  // 요약 + 다음 실행(IPC).
  useEffect(() => {
    const api = ipc();
    if (!api) {
      setSummary("");
      setNextRun(null);
      return;
    }
    let cancelled = false;
    void Promise.all([api.schedule.describe(spec, locale === "ko" ? "ko" : "en"), api.schedule.nextRun(spec)]).then(
      ([desc, next]) => {
        if (cancelled) return;
        setSummary(desc);
        setNextRun(next);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [spec, locale]);

  // 부모에 값 전달 — 직렬화 값이 실제로 바뀔 때만 emit(부모 onChange가 인라인이어도 무한루프 방지).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastEmitted = useRef<string>("");
  const suppressHydratedValue = useRef(Boolean(value));
  useEffect(() => {
    if (!hydrated) return;
    const token = toLegacyToken(mode, preset, time, dow, day, spec, locale === "ko" ? "ko" : "en");
    const serialized = JSON.stringify({ spec, token });
    if (suppressHydratedValue.current) {
      suppressHydratedValue.current = false;
      lastEmitted.current = serialized;
      return;
    }
    if (serialized === lastEmitted.current) return;
    lastEmitted.current = serialized;
    onChangeRef.current({ spec, legacyToken: token });
    // locale은 토큰 문구(describeSchedule)에 들어가므로 의존성에 포함한다.
  }, [hydrated, spec, mode, preset, time, dow, day, locale]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(["preset", "cron", "once", "manual"] as Mode[]).map((m) => (
          <Chip key={m} active={mode === m} onClick={() => setMode(m)} label={t(`auto.sched.mode.${m}`)} />
        ))}
      </div>

      {mode === "preset" && (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["daily", "weekday", "weekly", "monthly", "hourly", "interval"] as Preset[]).map((p) => (
              <Chip key={p} active={preset === p} onClick={() => setPreset(p)} label={t(`auto.sched.preset.${p}`)} />
            ))}
          </div>
          {preset !== "hourly" && preset !== "interval" && (
            <Row label={t("auto.sched.time")}>
              <input type="time" lang={locale === "ko" ? "ko" : "en"} value={time} onChange={(e) => setTime(e.target.value)} style={inputStyle} />
            </Row>
          )}
          {preset === "weekly" && (
            <Row label={t("auto.sched.dow")}>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {DOW_KEYS.map((k, i) => (
                  <Chip
                    key={k}
                    active={dow === i}
                    onClick={() => setDow(i)}
                    label={(locale === "ko" ? DOW_LABELS_KO : DOW_LABELS_EN)[i]}
                  />
                ))}
              </div>
            </Row>
          )}
          {preset === "monthly" && (
            <Row label={t("auto.sched.day")}>
              <input
                type="number"
                min={1}
                max={31}
                value={day}
                onChange={(e) => setDay(Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                style={{ ...inputStyle, width: 90 }}
              />
            </Row>
          )}
          {preset === "interval" && (
            <>
              <Row label={t("auto.sched.every")}>
                <input
                  type="number"
                  min={1}
                  value={everyMin}
                  onChange={(e) => setEveryMin(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  style={{ ...inputStyle, width: 90 }}
                />
              </Row>
              <label style={checkboxRow}>
                <input type="checkbox" checked={aligned} onChange={(e) => setAligned(e.target.checked)} />
                {t("auto.sched.aligned")}
              </label>
            </>
          )}
        </>
      )}

      {mode === "cron" && (
        <Row label={t("auto.sched.cron.label")}>
          <input
            value={cronExpr}
            onChange={(e) => setCronExpr(e.target.value)}
            placeholder="*/30 9-18 * * 1-5"
            style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
          />
          {cronValid !== null && (
            <div style={{ fontSize: 11, marginTop: 4, color: cronValid ? "var(--green-deep)" : "var(--red-deep, var(--danger))" }}>
              {cronValid ? t("auto.sched.cron.valid") : t("auto.sched.cron.invalid")}
            </div>
          )}
        </Row>
      )}

      {mode === "once" && (
        <Row label={t("auto.sched.once.at")}>
          <input type="datetime-local" lang={locale === "ko" ? "ko" : "en"} value={onceAt} onChange={(e) => setOnceAt(e.target.value)} style={inputStyle} />
        </Row>
      )}

      {mode !== "manual" && mode !== "once" && (
        <Row label={t("auto.sched.tz")}>
          <input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="Asia/Seoul" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
        </Row>
      )}

      {(summary || nextRun) && (
        <div style={{ fontSize: 11.5, color: "var(--muted-deep)", lineHeight: 1.6, paddingTop: 4, borderTop: "1px solid var(--paper-edge)" }}>
          {summary && (
            <div>
              <strong>{t("auto.sched.summary")}:</strong> {summary}
            </div>
          )}
          {nextRun && (
            <div>
              <strong>{t("auto.sched.next")}:</strong>{" "}
              {new Date(nextRun).toLocaleString(locale === "ko" ? "ko-KR" : "en-US")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Chip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", marginBottom: 5 }}>{label}</div>
      {children}
    </div>
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
