/**
 * 예약 보고(automation-report) 말풍선을 사람이 읽는 첫머리로 바꾼다 — 표시 전용.
 *
 * ★왜 (오너 스크린샷 2026-09-24, 1.2.41 Thread Marketing): 예약 보고 첫 줄이
 *   `[controller_judged] NODE_CLAIMED_WITHOUT_TOOLS: …`, `**[Hope]** NEEDS-INPUT: …` 로
 *   그대로 그려졌다. 저장된 원문은 **바꾸면 안 된다** — 스케줄러가 `[reasonCode]` 를,
 *   분류기가 verbatim 코드(errors.json)를 일부러 남긴다(기계 표식이 사라져 위험한 재실행이
 *   허용됐던 사고가 있다). 그래서 기록은 그대로 두고 **그릴 때만** 첫머리를 고친다:
 *     - 앞머리 판정 꼬리표 `[controller_judged]`·인격 꼬리표 `[Hope]`(굵게 포함) → 지운다.
 *       RunHistoryPanel 의 stripReasonCode 와 같은 규칙이다(사용자가 쓸 수 없는 정보).
 *     - 레지스트리 코드 `NODE_CLAIMED_WITHOUT_TOOLS:` → 첫머리에서 빼고 작은 코드 칩으로.
 *       사람 문장이 앞에 오고 코드는 뒤에 남는다("사유 코드" 선례: invocation-failure.ts).
 *     - 답이 필요하다는 모델 계약 표식 `NEEDS-INPUT:`(runner.ts) → "입력이 필요합니다: ".
 *   첫 문단은 자동화 이름이다(electron/automation-delivery.ts: `${name}\n\n${body}`).
 */

export type AutomationReportDisplay = {
  /** 자동화 이름(첫 문단). 옛 기록처럼 문단이 하나뿐이면 null. */
  name: string | null;
  /** 첫머리를 고친 본문 마크다운. */
  body: string;
  /** 첫머리에서 뺀 기계 코드 — 칩으로만 보인다. */
  code: string | null;
};

// 줄 첫머리의 [꼬리표] — 마크다운 링크 `[글](주소)` 는 건드리지 않는다.
const LEAD_TAG_RE = /^\s*(?:\*\*|__)?\[[A-Za-z][A-Za-z0-9_.:-]{0,63}\](?:\*\*|__)?(?!\()[ \t]*/;
// 줄 첫머리의 기계 코드: NODE_CLAIMED_WITHOUT_TOOLS: / NEEDS-INPUT: / claimed_without_tools:
const LEAD_CODE_RE = /^\s*([A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+):[ \t]*/;
const NEEDS_INPUT_CODES = new Set(["NEEDS-INPUT", "NEEDS_INPUT"]);

function stripLeadTags(line: string): string {
  let current = line;
  for (let i = 0; i < 4; i++) {
    const next = current.replace(LEAD_TAG_RE, "");
    if (next === current) break;
    current = next;
  }
  return current;
}

export function automationReportDisplay(text: string, locale: "ko" | "en"): AutomationReportDisplay {
  const raw = String(text ?? "").replace(/\r\n/g, "\n").trim();
  const split = raw.indexOf("\n\n");
  const name = split > 0 ? raw.slice(0, split).trim() : null;
  const rest = split > 0 ? raw.slice(split + 2).replace(/^\n+/, "") : raw;
  const lines = rest.split("\n");
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first < 0) return { name, body: rest, code: null };
  let lead = stripLeadTags(lines[first]);
  let code: string | null = null;
  const match = LEAD_CODE_RE.exec(lead);
  if (match) {
    lead = stripLeadTags(lead.slice(match[0].length));
    if (NEEDS_INPUT_CODES.has(match[1])) {
      lead = `${locale === "ko" ? "입력이 필요합니다" : "Needs your input"}: ${lead}`.trimEnd();
    } else {
      code = match[1];
      if (!lead.trim()) lead = locale === "ko" ? "예약 실행이 멈췄습니다." : "The scheduled run stopped.";
    }
  }
  const next = [...lines];
  next[first] = lead;
  return { name, body: next.join("\n").trim(), code };
}
