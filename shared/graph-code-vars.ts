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
