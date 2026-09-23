/*
 * IPC 경계에서 "값이 undefined 인 키" ≡ "키 없음".
 *
 * 2026-09-23 사고(1.2.33~1.2.37): 화면이 `{ ..., acpAgentId: undefined }` 를 보냈고,
 * Electron IPC(V8 structured clone)는 JSON.stringify 와 달리 값이 undefined 인 키를
 * **보존한다**. Main 의 정확한 키 허용 목록(Object.keys)이 그 키를 모르는 키로 보고
 * 고정 모델을 쓴 One 팀/작업 메시지를 전부 invalid_request 로 거절했다.
 *
 * 검사기마다 undefined 를 따로 걸러 주는 대신, 모든 핸들러가 받기 전 한 자리에서
 * 일반 객체의 undefined 값 키를 재귀적으로 지운다. 그러면 어떤 검사기도 다시는
 * "값이 없는 키" 때문에 거절할 수 없다. 값이 **있는** 모르는 키는 그대로 남으므로
 * 보안 검사기의 거절은 약해지지 않는다.
 *
 * 규칙
 *  - 일반 객체(프로토타입이 Object.prototype 또는 null)만 키를 지운다.
 *  - 배열은 길이·순서를 그대로 둔다(undefined 원소도 유지). 원소 안의 객체만 재귀.
 *  - Buffer·TypedArray·Date·Map·Set·Error·클래스 인스턴스는 건드리지 않는다.
 *  - 순환 참조는 한 번만 방문하고, 깊이 상한을 넘으면 그 아래는 손대지 않는다.
 *  - "지우기"를 뜻하려면 undefined 가 아니라 명시적 null 을 보낸다(JSON 과 같은 규칙).
 *
 * 렌더러 쪽 같은 규칙의 사본은 electron/preload.ts 의 normalizeIpcInvokeArgs
 * (샌드박스 preload 는 상대 모듈을 require 할 수 없어 인라인 사본이다).
 */

export const IPC_ARGS_NORMALIZE_MAX_DEPTH = 64;

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stripInPlace(value: unknown, depth: number, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object") return;
  if (depth > IPC_ARGS_NORMALIZE_MAX_DEPTH || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (item !== null && typeof item === "object") stripInPlace(item, depth + 1, seen);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item === undefined) delete value[key];
    else if (item !== null && typeof item === "object") stripInPlace(item, depth + 1, seen);
  }
}

/**
 * Main 전용: IPC 가 방금 역직렬화해 넘긴(핸들러 호출이 소유한) 인자를 제자리에서 정리한다.
 * 같은 배열을 돌려준다. 호출자 소유 객체에는 쓰지 말 것 — 그때는 preload 의 copy-on-write 판처럼 사본을 만든다.
 */
export function normalizeIpcArgsInPlace<T extends unknown[]>(args: T): T {
  const seen = new WeakSet<object>();
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item !== null && typeof item === "object") stripInPlace(item, 0, seen);
  }
  return args;
}
