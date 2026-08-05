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

/**
 * 이 계층의 네임스페이스. **정본은 `graph/1`**이다
 * (06_Graph_Wire_Protocol_Spec_v1 §2.1 — 네임스페이스 2개: `graph/1`, `agentgraph/1`).
 *
 * ★2026-08-04 교정: 처음 만들 때 정본을 안 읽고 `agentlas.node-output.v1`이라는 이름을
 * 새로 지었다. 이름이 갈라지면 같은 경계에 계약이 두 벌 생기고, 그게 이 저장소가
 * 반복해서 겪은 드리프트의 시작이다. 레지스트리(`shared/graph-registry/`)와
 * 적합성 게이트가 이제 그걸 잡는다.
 */
export const GRAPH_WIRE = "graph/1";
/** 이 봉투의 종류. 06 §4 "노드 간 데이터 프로토콜"의 포트 출력. */
export const NODE_OUTPUT_KIND = "port.output";

/**
 * 값이 이보다 크면 **인라인으로 나르지 않고 외부화**한다.
 * Temporal 파이썬 SDK의 오프로드 기본값(`payload_size_threshold = 256*1024`)과 같은 수다.
 *
 * ★이건 "필드 상한"이 아니다. 06 §4.6은 못박는다 —
 * *"필드 단위 문자 상한은 어디에도 없다"*. 넘으면 자르거나 실행을 세우는 게 아니라
 * 자리에 `$blob` 참조가 남고 `blob_externalized`가 저널에 기록된다(조용한 절단 금지).
 */
export const RESULT_INLINE_LIMIT_BYTES = 256 * 1024;

/**
 * 외부화된 값의 자리표. 06 §4.6의 정본 모양이다.
 * `store`는 어느 보존소인지 — 지금은 실행 단위(`run`)뿐이다.
 */
export interface BlobRef {
  $blob: { digest: string; size: number; mediaType: string; store: "run" };
}

export type NodeResult =
  | { kind: "text"; text: string }
  | { kind: "json"; json: unknown }
  /**
   * 값이 커서 외부화된 것. **자리는 비지 않는다** — 참조와 크기가 남고,
   * 앞부분은 사람이 볼 수 있게 함께 싣는다.
   */
  | { kind: "blob"; ref: BlobRef; preview?: string }
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
  /** 06 §2.1 공통 봉투 필드 — 미지 major는 fail-closed. */
  wire: typeof GRAPH_WIRE;
  kind: typeof NODE_OUTPUT_KIND;
  /** 확장 전용 칸. 소비자는 **must-ignore이되 버리지 않는다**(06 §2.3). */
  ext?: Record<string, unknown>;
  nodeId: string;
  nodeLabel: string;
  result: NodeResult;
  notes: NodeNote[];
  meta: {
    /** 결과를 어디서 얻었는가. 지어낸 자리에서 얻지 않았음을 남긴다. */
    source: "final" | "partial-accumulated" | "structured" | "declared" | "none";
    runtime?: string;
    tokens?: number;
    /**
     * 값이 외부로 나갔는가. **자른 게 아니다** — 원본은 온전히 보존되고 자리에 참조가 남는다.
     * 조용히 true가 되는 경로를 만들지 않는다: 화면과 저널이 이걸 읽는다.
     */
    externalized: boolean;
    /** 외부화된 원본 크기(바이트). externalized일 때만 뜻이 있다. */
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
  /** 외부화 시 자리표에 넣을 내용 지문. 커널이 보관하면서 계산한다. */
  digest?: string;
}): NodeOutputEnvelope {
  const notes = input.notes ?? [];
  const base = {
    wire: GRAPH_WIRE as typeof GRAPH_WIRE,
    kind: NODE_OUTPUT_KIND as typeof NODE_OUTPUT_KIND,
    nodeId: input.nodeId,
    nodeLabel: input.nodeLabel || input.nodeId,
    notes,
  };
  if (input.structured !== undefined && input.structured !== null) {
    return {
      ...base,
      result: { kind: "json", json: input.structured },
      meta: { source: "structured", externalized: false, ...runtimeMeta(input) },
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
      meta: { source: "none", externalized: false, ...runtimeMeta(input) },
    };
  }
  const bytes = byteLength(text);
  if (bytes > RESULT_INLINE_LIMIT_BYTES) {
    // ★자르지 않는다. 자리만 남기고 **얼마나 큰지**를 적는다.
    // 조용히 잘라 넘기면 다음 노드는 반쪽짜리를 온전한 것으로 읽는다.
    return {
      ...base,
      result: {
        kind: "blob",
        ref: {
          $blob: {
            digest: input.digest ?? "",
            size: bytes,
            mediaType: "text/plain; charset=utf-8",
            store: "run",
          },
        },
        preview: text.slice(0, 2000),
      },
      meta: {
        source: final ? "final" : "partial-accumulated",
        externalized: true,
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
      externalized: false,
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
    wire: GRAPH_WIRE,
    kind: NODE_OUTPUT_KIND,
    nodeId,
    nodeLabel: nodeLabel || nodeId,
    result: typeof value === "string" ? { kind: "text", text: value } : { kind: "json", json: value.json },
    notes: [],
    meta: { source: "declared", externalized: false },
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
    case "blob":
      // ★참조는 값이 아니다. 다만 **실행을 세우지도 않는다**(06 §4.6) —
      //   자리표를 그대로 넘기고, 해석은 읽는 쪽이 한다. 해석 실패만 BLOB_UNRESOLVED.
      return JSON.stringify(result.ref);
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
    case "blob":
      return `${result.preview ?? ""}\n\n[결과가 커서 따로 보관했습니다 — ${Math.round(result.ref.$blob.size / 1024)}KB]`.trim();
    case "none":
      return "";
  }
}

/** 봉투를 읽는다. **모르는 판은 거절한다** — 최선을 다해 읽지 않는다(R4). */
export function parseNodeEnvelope(raw: unknown): NodeOutputEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<NodeOutputEnvelope>;
  // 미지 major = fail-closed. 최선을 다해 읽지 않는다(06 §2.3).
  if (value.wire !== GRAPH_WIRE || value.kind !== NODE_OUTPUT_KIND) return null;
  if (typeof value.nodeId !== "string" || !value.nodeId) return null;
  const result = value.result as NodeResult | undefined;
  if (!result || typeof result !== "object") return null;
  const kinds = ["text", "json", "blob", "none"];
  if (!kinds.includes((result as { kind?: string }).kind ?? "")) return null;
  return {
    wire: GRAPH_WIRE,
    kind: NODE_OUTPUT_KIND,
    nodeId: value.nodeId,
    nodeLabel: typeof value.nodeLabel === "string" && value.nodeLabel ? value.nodeLabel : value.nodeId,
    result,
    notes: Array.isArray(value.notes)
      ? value.notes.filter((note): note is NodeNote => !!note && typeof note === "object" && typeof (note as NodeNote).text === "string")
      : [],
    meta: {
      source: value.meta?.source ?? "declared",
      externalized: value.meta?.externalized === true,
      ...(value.meta?.runtime ? { runtime: value.meta.runtime } : {}),
      ...(typeof value.meta?.tokens === "number" ? { tokens: value.meta.tokens } : {}),
      ...(typeof value.meta?.originalBytes === "number" ? { originalBytes: value.meta.originalBytes } : {}),
    },
  };
}

/**
 * 선언이 없을 때 이 노드가 바깥에 하는 일. **커널과 화면이 같은 답을 써야 한다.**
 *
 * ★화면이 `s("effect") || "read"`로 보여 주면서 그 값을 저장하지 않으면, 사람은 "조회"가
 *   골라져 있다고 믿는데 커널은 자기 기본값으로 판단한다. 실제로 캔버스에서 만든 출력 노드가
 *   화면엔 "조회"로 뜨는데 시뮬레이션에서 통째로 차단됐다 — 같은 노드가 화면과 실행에서
 *   다른 것이었다.
 */
export function defaultNodeEffect(nodeType: string): "pure" | "read" | "mutation" {
  // 출력 블록은 "바깥으로 내보내기"다(레지스트리 선언). 안 적혔다고 조회로 보면
  // 시뮬레이션이 실제로 발행하고, 승인도 재시도 정책도 조회 기준으로 돈다.
  return nodeType === "output" ? "mutation" : "read";
}
