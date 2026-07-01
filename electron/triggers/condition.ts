// 조건 평가기(설계 §3.3, §6 열린질문 #6) — 트리거 발사 게이트와 그래프 condition 노드가
// 공유하는 단일 순수 함수. TriggerCondition을 변수 백에 대해 평가한다.
//
// left/right는 {{var}} 치환을 거친 뒤 비교한다. 숫자 비교(gt/lt/...)는 양변이 유한 숫자로
// 파싱될 때만 수치로, 아니면 문자열 비교로 폴백한다. changed는 lastSeen 커서와의 차이를 본다.
import type { TriggerCondition } from "../../shared/types";

/** {{var}} 치환 — 변수 백에서 값을 읽어 문자열에 삽입. 미정의는 빈 문자열. */
function subst(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v == null) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

function asNum(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * 조건을 변수 백에 대해 평가한다. lastSeen은 changed 연산자용(직전 관측값).
 * 조건이 없으면(undefined) 항상 true(게이트 없음).
 */
export function evaluateCondition(
  cond: TriggerCondition | undefined | null,
  vars: Record<string, unknown> = {},
  lastSeen?: string,
): boolean {
  if (!cond) return true;
  const left = subst(cond.left ?? "", vars);
  const right = cond.right != null ? subst(cond.right, vars) : "";

  switch (cond.op) {
    case "exists":
      return left.trim().length > 0;
    case "changed":
      return lastSeen === undefined ? true : left !== lastSeen;
    case "eq":
      return left === right;
    case "ne":
      return left !== right;
    case "contains":
      return left.includes(right);
    case "gt":
    case "lt":
    case "gte":
    case "lte": {
      const a = asNum(left);
      const b = asNum(right);
      if (a !== null && b !== null) {
        if (cond.op === "gt") return a > b;
        if (cond.op === "lt") return a < b;
        if (cond.op === "gte") return a >= b;
        return a <= b;
      }
      // 숫자로 안 되면 문자열 사전순 비교로 폴백.
      if (cond.op === "gt") return left > right;
      if (cond.op === "lt") return left < right;
      if (cond.op === "gte") return left >= right;
      return left <= right;
    }
    default:
      return true;
  }
}
