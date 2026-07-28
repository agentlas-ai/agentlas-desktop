// 스케줄 표시 문구(순수 함수) — croner에 의존하지 않으므로 메인/렌더러 양쪽이 같은 문구를 쓴다.
// electron/store/schedule.ts에서 분리한 이유: 렌더러가 croner를 import할 수 없어
// 표시 문구를 만들 수단이 없었고, 그래서 ScheduleBuilder가 `spec` 같은 자리표시자를
// scheduleHuman에 저장해 사용자 화면에 그대로 노출되는 결함이 생겼다.
import type { ScheduleSpec } from "./types";

const KO_DOW = ["일", "월", "화", "수", "목", "금", "토"];
const EN_DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 사람이 읽을 스케줄 설명(표시 전용, 파싱 아님). locale=ko|en. */
export function describeSchedule(spec: ScheduleSpec, locale: "ko" | "en" = "en"): string {
  const ko = locale === "ko";
  switch (spec.kind) {
    case "manual":
      return ko ? "수동 실행" : "Manual only";
    case "once": {
      const d = new Date(spec.atIso);
      const when = Number.isNaN(d.getTime()) ? spec.atIso : d.toLocaleString(ko ? "ko-KR" : "en-US");
      return ko ? `1회: ${when}` : `Once: ${when}`;
    }
    case "interval": {
      const min = Math.round(spec.everyMs / 60000);
      const aligned = spec.anchor === "wallclock" ? (ko ? " (정렬)" : " (aligned)") : "";
      if (min % 60 === 0 && min >= 60) {
        const h = min / 60;
        return ko ? `${h}시간마다${aligned}` : `Every ${h}h${aligned}`;
      }
      return ko ? `${min}분마다${aligned}` : `Every ${min}m${aligned}`;
    }
    case "cron": {
      const fields = spec.expr.trim().split(/\s+/);
      if (fields.length === 5) {
        const [mm, hh, dom, , dow] = fields;
        const time = /^\d+$/.test(hh) && /^\d+$/.test(mm)
          ? `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`
          : null;
        if (time && dom === "*" && dow === "*") {
          return ko ? `매일 ${time}` : `Daily at ${time}`;
        }
        if (time && dom === "*" && dow === "1-5") {
          return ko ? `평일 ${time}` : `Weekdays at ${time}`;
        }
        if (time && dom === "*" && /^\d$/.test(dow)) {
          const label = ko ? `매주 ${KO_DOW[Number(dow)]}` : `Every ${EN_DOW[Number(dow)]}`;
          return `${label} ${time}`;
        }
        if (time && /^\d+$/.test(dom) && dow === "*") {
          return ko ? `매월 ${dom}일 ${time}` : `Monthly on day ${dom} at ${time}`;
        }
        if (hh === "*" && /^\d+$/.test(mm)) {
          return ko ? "매시" : "Hourly";
        }
      }
      return ko ? `cron ${spec.expr} (${spec.tz})` : `cron ${spec.expr} (${spec.tz})`;
    }
    default:
      return ko ? "알 수 없음" : "Unknown";
  }
}
