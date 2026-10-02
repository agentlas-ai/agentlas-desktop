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

function readableLocalPaths(text: string): string {
  return text.replace(/(?<![\w:/])(?:file:\/\/)?\/(?:Users|home|private|tmp|var)\/[^\s<>`"'()\[\]]+/g,
    (value) => value.split("/").filter(Boolean).pop() ?? "file")
    .replace(/(?<![\w:/])[A-Za-z]:[\\/][^\s<>`"'()\[\]]+/g,
      (value) => value.split(/[\\/]/).filter(Boolean).pop() ?? "file");
}

function readableResultParagraph(paragraph: string): string {
  const value = paragraph.trim();
  const finalStep = /^(마지막 단계 결과|Final step result):\n([\s\S]*)$/.exec(value);
  if (finalStep) return `${finalStep[1]}:\n${readableResultParagraph(finalStep[2])}`;
  if (!value.startsWith("{") || !value.endsWith("}")) return paragraph;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return paragraph;
    const rows: string[] = [];
    let omitted = false;
    const visit = (item: unknown, label: string, depth: number): void => {
      if (rows.length >= 30) { omitted = true; return; }
      if (item && typeof item === "object" && depth < 4) {
        for (const [key, nested] of Object.entries(item)) visit(nested, label ? `${label} · ${key}` : key, depth + 1);
      } else if (item === null || ["string", "boolean", "number"].includes(typeof item)) {
        rows.push(`- ${label.replace(/_/g, " ")}: ${String(item ?? "—").replace(/\n/g, " ")}`);
      } else omitted = true;
    };
    visit(parsed, "", 0);
    return rows.length ? [...rows, ...(omitted ? ["- …"] : [])].join("\n") : paragraph;
  } catch { return paragraph; }
}

export function automationReportDisplay(text: string, locale: "ko" | "en"): AutomationReportDisplay {
  const raw = String(text ?? "").replace(/\r\n/g, "\n").trim();
  const split = raw.indexOf("\n\n");
  const name = split > 0 ? raw.slice(0, split).trim() : null;
  const rest = (split > 0 ? raw.slice(split + 2).replace(/^\n+/, "") : raw)
    // Skill announcements describe the worker, not the owner's result.
    .replace(/^\s*(?:\*\*\[Hope\]\*\*\s*)?사용 스킬:[^\n]*(?:\n|$)/gm, "")
    // Keep artifact names readable without leaking a workstation path in an
    // automation report. The durable message and artifact pane retain links.
    .replace(/\[([^\]\n]+)\]\((?:<)?(?:file:\/\/)?\/(?:Users|home|private|tmp|var)\/[^)\n]*\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\((?:<)?[A-Za-z]:[\\/][^)\n]*\)/g, "$1");
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
  let fence: string | null = /^\s*(`{3,}|~{3,})/.exec(next[first])?.[1][0] ?? null;
  for (let i = first + 1; i < next.length; i += 1) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(next[i]);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fence === fenceMatch[1][0]) fence = null;
      continue;
    }
    if (fence) continue;
    const startsResult = !next[i - 1].trim() || /^(마지막 단계 결과|Final step result):\s*$/.test(next[i - 1].trim());
    const hasHostPrefix = /^\s*(?:\*\*)?\[(?:controller_judged|Hope)\](?:\*\*)?\s*/.test(next[i]);
    if (!startsResult && !hasHostPrefix) continue;
    // Later result paragraphs can carry the same host prefix as the lead.
    // Restrict later code handling to known result markers; ordinary prose
    // and fenced examples retain their brackets and labels.
    let line = next[i].replace(/^\s*(?:\*\*)?\[controller_judged\](?:\*\*)?\s*/, "")
      .replace(/^\s*(?:\*\*)?\[Hope\](?:\*\*)?\s*/, "");
    const marker = /^\s*(NODE_CLAIMED_WITHOUT_TOOLS|NEEDS-INPUT|NEEDS_INPUT):\s*/.exec(line);
    if (marker) {
      line = line.slice(marker[0].length);
      if (NEEDS_INPUT_CODES.has(marker[1])) line = `${locale === "ko" ? "입력이 필요합니다" : "Needs your input"}: ${line}`;
      else code ??= marker[1];
    }
    next[i] = line;
  }
  const body = readableLocalPaths(next.join("\n").trim().split(/\n\s*\n/).map(readableResultParagraph).join("\n\n"));
  return { name, body, code };
}
