// 코드 단계가 **어떤 값을 읽는가** — 한 곳에서만 정한다.
//
// 왜 여기 있나(실측 2026-08-05): 커널의 참조 스캐너가 `vars.x` / `vars["x"]`만 알고
// **파이썬 관용구 `vars.get("x")`를 몰랐다.** 파이썬에서 `vars`는 dict라 `.get()`이 표준이고
// AI는 당연히 그렇게 쓴다. 그래서 `consumes`에 적힌 값 하나 말고는 전부 **조용히 빈 값**으로
// 넘어갔고, 코드는 실패하지 않은 채 "(알 수 없음)" 같은 열화된 결과를 만들어 냈다.
// 그 결과를 근거로 채점표가 통과 판정을 냈다 — 빈 답보다 나쁜 거짓 답.
//
// 같은 눈먼 지점이 `unproducedVariables`에도 있었다: 그쪽은 prompt/text/template만 훑어서
// **코드만 읽는 값**은 "밖에서 들어와야 하는 값"으로 잡히지 않았고, 입력 트리거가 값을
// 요구하지 않아 빈 채로 돌았다(말 노드에서 P0로 이미 겪은 함정의 코드판).
//
// ★규칙: 코드가 읽는 값의 판별은 이 함수 하나뿐이다. 정규식을 다른 곳에 복제하지 않는다.

/** `vars`가 dict/객체라서 나오는 메서드 이름 — 값 이름이 아니다. */
const MEMBER_NOISE = new Set([
  "get", "keys", "items", "values", "pop", "popitem", "setdefault", "update",
  "copy", "clear", "has", "hasOwnProperty", "toString", "length",
]);

/**
 * 코드 본문이 읽는 값 이름들. 리터럴로 적힌 것만 뽑는다 — 이름을 계산해서 읽는 코드는
 * 정적으로 알 수 없으므로 여기서 지어내지 않는다(모르면 모른다고 두는 쪽이 맞다).
 */
export function codeReferencedVars(code: string | null | undefined): string[] {
  const text = typeof code === "string" ? code : "";
  if (!text) return [];
  const out: string[] = [];
  const add = (name: string | undefined) => {
    if (!name || MEMBER_NOISE.has(name)) return;
    if (!out.includes(name)) out.push(name);
  };
  // vars.get("x") / vars.get('x') — 파이썬 dict 관용구. 기본값 인자가 붙어도 무관.
  for (const m of text.matchAll(/vars\s*\.\s*(?:get|setdefault|pop)\s*\(\s*["']([^"']+)["']/g)) {
    add(m[1]);
  }
  // vars["x"] / vars['x'] — 파이썬·JS 공통 첨자 접근.
  for (const m of text.matchAll(/vars\s*\[\s*["']([^"']+)["']\s*\]/g)) add(m[1]);
  // vars.x — JS 속성 접근. 파이썬에서는 메서드일 수 있어 위 목록으로 걸러진다.
  for (const m of text.matchAll(/vars\s*\.\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  return out;
}

/**
 * 이 노드가 **바깥을 바꿀 수 있는가** — 재개·재조정·발행이 함께 쓰는 단 하나의 판정.
 *
 * ★실측 2026-08-20. 이 판정이 네 곳에 손으로 복제돼 있었고, 넷 다 같은 목록이었다:
 *     `type === "agent" || type === "action" || type === "output"`
 *   그런데 **`code` 노드가 빠져 있다.** code 노드는 `effect: "mutation"` 으로 파일을 쓰고
 *   메일을 보낸다 — 오늘 만든 자동화는 전부 그 방식이다.
 *
 *   결과: 부수효과를 낸 뒤 실패한 자동화의 그래프를 사람이 고치면, 커널이 "이미 나간 일이
 *   있다"를 **못 보고 그대로 재생**한다. 매트릭스로 재현했다 — 파일이 v1 에서 v2 로 다시
 *   쓰였다. 발송·결제였다면 두 번 나갔다.
 *
 *   그래서 판정을 한 곳으로 올린다. 선언된 효과가 있으면 그것을 믿고, 없으면 노드 종류로
 *   본다(옛 그래프에는 effect 칸이 없다). **모르면 바꿀 수 있는 것으로 센다** — 이 판정의
 *   오탐은 "한 번 더 조심"이고, 누락은 "두 번 발송"이다.
 */
export function nodeCanChangeTheOutsideWorld(node: {
  type?: string;
  config?: Record<string, unknown> | undefined;
}): boolean {
  const declared = typeof node.config?.effect === "string" ? node.config.effect.trim() : "";
  if (declared === "mutation") return true;
  if (declared === "read" || declared === "pure") return false;
  return node.type === "agent" || node.type === "action" || node.type === "output";
}
