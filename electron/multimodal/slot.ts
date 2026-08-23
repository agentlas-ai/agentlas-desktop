// 멀티모달 슬롯 → 실제 생성 엔진.
//
// 대화 런타임(orchestrator/worker)이 프롬프트를 쓰고, 이 슬롯에 앉은 CLI 가 헤드리스로
// 그린다. 그래서 orchestrator 가 claude 여도 슬롯이 codex 면 codex 의 image_gen 이 그린다.
//
// ★비어 있으면 비어 있다고 말한다. 슬롯이 없을 때 아무 CLI 로나 대신 그리면, 사용자가
// 고르지 않은 엔진이 결과물을 만든다 — 그건 조용한 대체이지 폴백이 아니다.
import { getResolvedModelRole } from "../store/model-roles";
import { detectRuntimes } from "./../runtime/detect";
import type { ImageModel } from "./image";
import type { RuntimeKind } from "../../shared/types";

/**
 * 런타임 종류별로 "이 CLI 가 그림을 그릴 수 있는가".
 *
 * Record 라서 새 런타임이 생기면 여기서 컴파일 에러가 난다 — 답하지 않은 런타임이
 * 조용히 "못 그림"으로 취급되는 일을 막는다.
 */
const IMAGE_ENGINE_BY_RUNTIME: Record<RuntimeKind, ImageModel | null> = {
  // codex CLI 는 image_gen 을 내장한다(키 없이 구독 인증으로 동작).
  codex: "codex",
  // Antigravity(agy) 는 나노바나나(Gemini image)를 CLI 안에서 부른다.
  antigravity: "gemini",
  // 아래는 그리는 능력이 없다. "auto" 로 몰래 떨어뜨리지 않는다.
  "claude-code": null,
  grok: null,
  kimi: null,
  cursor: null,
  byok: null,
  ollama: null,
  lmstudio: null,
  mlx: null,
  acp: null,
  // 서빙 실행은 글자만 다룬다. 그림은 다른 창구(멀티모달)가 맡는다.
  agentlas: null,
};

export interface MultimodalImageSlot {
  model: ImageModel;
  /** 이 결과를 실제로 그리는 런타임 — 영수증과 화면이 같은 이름을 말해야 한다. */
  runtimeKind: RuntimeKind;
}

/**
 * 지금 이미지 생성을 맡은 슬롯. 배정이 없거나 그 런타임이 그림을 못 그리면 `null`.
 *
 * `null` 이면 `generate_image` 내장 도구는 모델의 도구 목록에 **아예 뜨지 않는다**
 * (shared/builtin-tools.ts). 있는데 못 쓰는 도구는 함정이다.
 */
export function multimodalImageSlot(): MultimodalImageSlot | null {
  const assigned = getResolvedModelRole("multimodal");
  if (!assigned?.selection?.kind) return null;
  const kind = assigned.selection.kind as RuntimeKind;
  const model = IMAGE_ENGINE_BY_RUNTIME[kind] ?? null;
  return model ? { model, runtimeKind: kind } : null;
}

/** 화면이 "왜 못 그리는지" 말할 수 있도록, 슬롯이 빈 이유를 구분해 준다. */
export async function multimodalImageSlotDiagnosis(): Promise<
  { state: "ready"; slot: MultimodalImageSlot }
  | { state: "unassigned" }
  | { state: "runtime-cannot-draw"; runtimeKind: RuntimeKind }
  | { state: "runtime-missing"; runtimeKind: RuntimeKind }
> {
  const assigned = getResolvedModelRole("multimodal");
  if (!assigned?.selection?.kind) return { state: "unassigned" };
  const kind = assigned.selection.kind as RuntimeKind;
  const model = IMAGE_ENGINE_BY_RUNTIME[kind] ?? null;
  if (!model) return { state: "runtime-cannot-draw", runtimeKind: kind };
  const runtimes = await detectRuntimes();
  const present = runtimes.some((r) => r.kind === kind);
  if (!present) return { state: "runtime-missing", runtimeKind: kind };
  return { state: "ready", slot: { model, runtimeKind: kind } };
}
