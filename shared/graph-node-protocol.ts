// 노드가 노드에게 건네는 것 — **agentlas.node-output.v1**.
//
// ─ 왜 필요한가 ────────────────────────────────────────────────────────────
// 지금 이 그래프에서 노드 사이를 건너는 것은 `result.finalText ?? ""` **평문 한 줄**이다.
// 그래서 두 가지가 구조적으로 불가능했다:
//
//  1. 결과와 소음을 가르는 것. 도구 호출·생각·중간 로그가 최종 답과 같은 문자열이라,
//     검증(eval) 노드가 "글 쓰는 노드가 자기 결과 끝에 붙인 '좋음'"을 읽고 통과시켰다.
//  2. 결과가 없다는 것을 말하는 것. `final` 이벤트가 안 오면 노드는 빈 문자열을 들고
//     `Node "…" finished without an assistant result` 라는 사유 없는 에러로 죽었다.
//
// ─ 조사한 것(1차 출처 확인) ────────────────────────────────────────────────
// · **AutoGen(v0.4+)** 이 다섯 중 가장 강하다. `BaseChatMessage`에는 `to_model_message()`가
//   있고 `BaseAgentEvent`에는 **없다** — 그래서 이벤트는 다음 에이전트의 모델 입력이 될 수
//   *없다*. 관례가 아니라 타입이 막는다. 팀 전송에서도 동료 컨테이너는 `chat_message`만
//   버퍼에 담아 이벤트가 구조적으로 제외된다.
// · **CrewAI** 가 정확한 반례다. 태스크 사이를 건너는 것은 `.raw` 문자열을
//   `"\n\n----------\n\n"` 로 이어붙인 것뿐이라, `output_pydantic`을 붙여도 다음 태스크는
//   **직렬화된 JSON 텍스트**를 프롬프트로 받는다. 타입 있는 객체는 파이썬 쪽에만 남는다.
//   지금 우리 모양이 이것이다.
// · **LangGraph** — 노드는 전체 상태가 아니라 **부분 dict**를 돌려주고 키마다 리듀서가
//   합친다. 그리고 `BaseChannel.update` 독스트링이 못 박는다: *"The order of the updates
//   in the sequence is arbitrary."* → 병렬 쓰기의 병합은 도착 순서에 기대면 안 된다.
//   (우리 커널은 이미 선언 순서로 정렬한다 — 이 프로토콜도 같은 규칙을 쓴다.)
// · **Google ADK** — `output_key`가 담는 것은 **str**(또는 `output_schema` 통과 시 dict)이고,
//   `is_final_response()`와 작성자 일치로 게이트해 **도구 잡음이 새지 않게** 한다.
// · **큰 것은 값이 아니라 참조로** — Dagster 문서는 아예 *"A common and recommended approach
//   to passing data between assets is explicitly managing data using external storage"* 라고
//   쓰고, Prefect는 API에 **메타데이터만** 보낸다(`"Only results should be sent to the API."`).
//   Temporal은 여기서 유일하게 강제 수치를 갖는다: 페이로드 2MB·gRPC 4MB, 그리고 파이썬 SDK의
//   외부 저장 오프로드 기본 임계 `payload_size_threshold = 256 * 1024`.
//   ※Airflow의 "XCom 48KB 한도"는 통설이지만 사실이 아니다 — `MAX_XCOM_SIZE = 49344`는
//     프로바이더 오퍼레이터 두 곳에서만 검사되고 XCom 코어는 보지 않는다. 베끼지 않는다.
//
// ─ 그래서 이 프로토콜의 규칙 ───────────────────────────────────────────────
//  R1. `result`와 `notes`는 **다른 칸**이다. 다음 노드로 가는 길은 `result`뿐이고,
//      그 길을 여는 함수(`toDownstreamInput`)는 `notes`를 아예 볼 수 없다.
//  R2. 결과가 없으면 `kind:"none"` + **사유**다. 빈 문자열로 위장하지 않는다.
//  R3. 큰 것은 잘라내지 않는다. 참조(`ref`)로 바꾸거나, 잘랐으면 잘랐다고 적는다.
//      **조용한 절단 금지** — 이 제품이 반복해서 겪은 "그럴듯하게 채워진 오답"의 형태다.
//  R4. 모르는 판(version)은 fail-closed. 최선을 다해 읽지 않는다.
//  R5. 봉투는 값을 **가리지 않는다**. 기존 `{{변수}}`와 조건식은 그대로 값을 본다.

/** 이 봉투의 판. 바뀌면 이름이 바뀐다 — 조용히 뜻이 달라지지 않게. */
export const NODE_OUTPUT_PROTOCOL = "agentlas.node-output.v1";

/** 값이 이보다 크면 값으로 나르지 않는다. Temporal 파이썬 SDK 오프로드 기본값과 같은 수. */
export const RESULT_INLINE_LIMIT_BYTES = 256 * 1024;

export type NodeResult =
  | { kind: "text"; text: string }
  | { kind: "json"; json: unknown }
  /** 값이 너무 커서 자리만 남긴 것. 어디에 있는지와 얼마나 큰지를 반드시 함께 적는다. */
  | { kind: "ref"; uri: string; bytes: number; mediaType?: string; preview?: string }
  /** 결과가 **없다**. 빈 문자열이 아니라 이 모양으로 말한다. */
  | { kind: "none"; reason: string };

/**
 * 사람에게 보이는 기록. 도구 호출·생각·오류 같은 것.
 * ★이 칸은 다음 노드의 모델 입력이 되지 않는다(AutoGen의 그 경계).
 */
export interface NodeNote {
  at: "tool" | "thinking" | "error" | "surface" | "system";
  text: string;
  /** 도구 이름 등 — 화면이 접기/펴기로 보여줄 때 쓴다. */
  name?: string;
}

export interface NodeOutputEnvelope {
  protocol: typeof NODE_OUTPUT_PROTOCOL;
  nodeId: string;
  nodeLabel: string;
  result: NodeResult;
  notes: NodeNote[];
  meta: {
    /** 결과를 어디서 얻었는가. 지어낸 자리에서 얻지 않았음을 남긴다. */
    source: "final" | "partial-accumulated" | "structured" | "declared" | "none";
    runtime?: string;
    tokens?: number;
    /** 잘랐으면 true. **조용히 true가 되는 경로를 만들지 않는다** — 화면이 이걸 읽는다. */
    truncated: boolean;
    /** 잘리기 전 크기(바이트). truncated일 때만 뜻이 있다. */
    originalBytes?: number;
  };
}

function byteLength(text: string): number {
  // TextEncoder는 렌더러·메인·Node 어디에나 있다. Buffer는 렌더러에 없다.
  return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text).length : text.length;
}

/**
 * 노드가 낸 것을 봉투에 담는다.
 *
 * `final`이 없어도 스트리밍으로 쌓인 본문이 있으면 그것이 결과다 — 다만 **어디서 얻었는지**를
 * meta.source에 적는다. 실제로 일을 해 놓고 "결과가 없다"며 죽던 노드가 이 경로로 살아난다.
 */
export function makeNodeEnvelope(input: {
  nodeId: string;
  nodeLabel: string;
  finalText?: string | null;
  accumulatedText?: string | null;
  structured?: unknown;
  notes?: NodeNote[];
  runtime?: string;
  tokens?: number;
  /** 결과가 없을 때 사람에게 할 말. 없으면 기본 문장을 쓴다. */
  emptyReason?: string;
}): NodeOutputEnvelope {
  const notes = input.notes ?? [];
  const base = {
    protocol: NODE_OUTPUT_PROTOCOL as typeof NODE_OUTPUT_PROTOCOL,
    nodeId: input.nodeId,
    nodeLabel: input.nodeLabel || input.nodeId,
    notes,
  };
  if (input.structured !== undefined && input.structured !== null) {
    return {
      ...base,
      result: { kind: "json", json: input.structured },
      meta: { source: "structured", truncated: false, ...runtimeMeta(input) },
    };
  }
  const final = (input.finalText ?? "").trim();
  const accumulated = (input.accumulatedText ?? "").trim();
  const text = final || accumulated;
  if (!text) {
    return {
      ...base,
      result: {
        kind: "none",
        reason: input.emptyReason
          ?? `"${base.nodeLabel}"이(가) 아무 결과도 내지 않았습니다.`,
      },
      meta: { source: "none", truncated: false, ...runtimeMeta(input) },
    };
  }
  const bytes = byteLength(text);
  if (bytes > RESULT_INLINE_LIMIT_BYTES) {
    // ★자르지 않는다. 자리만 남기고 **얼마나 큰지**를 적는다.
    // 조용히 잘라 넘기면 다음 노드는 반쪽짜리를 온전한 것으로 읽는다.
    return {
      ...base,
      result: {
        kind: "ref",
        uri: `agentlas:node-output/${encodeURIComponent(input.nodeId)}`,
        bytes,
        mediaType: "text/plain; charset=utf-8",
        preview: text.slice(0, 2000),
      },
      meta: {
        source: final ? "final" : "partial-accumulated",
        truncated: true,
        originalBytes: bytes,
        ...runtimeMeta(input),
      },
    };
  }
  return {
    ...base,
    result: { kind: "text", text },
    meta: {
      source: final ? "final" : "partial-accumulated",
      truncated: false,
      ...runtimeMeta(input),
    },
  };
}

function runtimeMeta(input: { runtime?: string; tokens?: number }): { runtime?: string; tokens?: number } {
  return {
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(typeof input.tokens === "number" ? { tokens: input.tokens } : {}),
  };
}

/** 선언으로 만든 봉투(시뮬레이션 안내문·판정 결과처럼 모델을 거치지 않은 값). */
export function declaredEnvelope(
  nodeId: string,
  nodeLabel: string,
  value: string | { json: unknown },
): NodeOutputEnvelope {
  return {
    protocol: NODE_OUTPUT_PROTOCOL,
    nodeId,
    nodeLabel: nodeLabel || nodeId,
    result: typeof value === "string" ? { kind: "text", text: value } : { kind: "json", json: value.json },
    notes: [],
    meta: { source: "declared", truncated: false },
  };
}

/**
 * ★다음 노드로 가는 **유일한** 길. 인자가 봉투 하나뿐이고 `notes`를 읽지 않는다 —
 * 그래서 도구 잡음·생각이 다음 노드의 입력이 되는 경로가 아예 없다.
 * 결과가 없으면 null이다. 빈 문자열을 돌려주지 않는다(그건 "빈 답"으로 위장된다).
 */
export function toDownstreamInput(envelope: NodeOutputEnvelope | null | undefined): string | null {
  const result = envelope?.result;
  if (!result) return null;
  switch (result.kind) {
    case "text":
      return result.text;
    case "json":
      return JSON.stringify(result.json);
    case "ref":
      // 참조는 값이 아니다. 다음 노드에게 **값인 척** 넘기지 않는다.
      return null;
    case "none":
      return null;
  }
}

/** 사람에게 보여줄 한 줄. 화면·실행기록이 쓴다(다음 노드가 쓰는 것과 다른 칸이다). */
export function toHumanText(envelope: NodeOutputEnvelope | null | undefined): string {
  const result = envelope?.result;
  if (!result) return "";
  switch (result.kind) {
    case "text":
      return result.text;
    case "json":
      return JSON.stringify(result.json, null, 2);
    case "ref":
      return `${result.preview ?? ""}\n\n[결과가 너무 커서 전부 싣지 않았습니다 — ${Math.round(result.bytes / 1024)}KB]`.trim();
    case "none":
      return "";
  }
}

/** 봉투를 읽는다. **모르는 판은 거절한다** — 최선을 다해 읽지 않는다(R4). */
export function parseNodeEnvelope(raw: unknown): NodeOutputEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<NodeOutputEnvelope>;
  if (value.protocol !== NODE_OUTPUT_PROTOCOL) return null;
  if (typeof value.nodeId !== "string" || !value.nodeId) return null;
  const result = value.result as NodeResult | undefined;
  if (!result || typeof result !== "object") return null;
  const kinds = ["text", "json", "ref", "none"];
  if (!kinds.includes((result as { kind?: string }).kind ?? "")) return null;
  return {
    protocol: NODE_OUTPUT_PROTOCOL,
    nodeId: value.nodeId,
    nodeLabel: typeof value.nodeLabel === "string" && value.nodeLabel ? value.nodeLabel : value.nodeId,
    result,
    notes: Array.isArray(value.notes)
      ? value.notes.filter((note): note is NodeNote => !!note && typeof note === "object" && typeof (note as NodeNote).text === "string")
      : [],
    meta: {
      source: value.meta?.source ?? "declared",
      truncated: value.meta?.truncated === true,
      ...(value.meta?.runtime ? { runtime: value.meta.runtime } : {}),
      ...(typeof value.meta?.tokens === "number" ? { tokens: value.meta.tokens } : {}),
      ...(typeof value.meta?.originalBytes === "number" ? { originalBytes: value.meta.originalBytes } : {}),
    },
  };
}
