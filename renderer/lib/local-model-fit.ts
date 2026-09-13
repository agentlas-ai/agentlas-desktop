/*
 * 탐색 표의 "추천" 칸 — 이 컴퓨터 사양 대비 한 모델의 추정 적합도 (오너 2026-09-13: 원활·주의·위험 세 단계).
 *
 * 기준은 총 메모리(오너 결정)이며 순간 가용량이 아니다. Hugging Face 목록은 파일 크기를 주지 않으므로
 * 저장소 이름의 파라미터 수("4B", "27B", "30B-A3B" 의 30B)로 Q4 기준 크기를 추정한다. 추정은 추정이라고
 * 마우스 안내에 적고, 정확한 값은 파일 팝업에서 파일별로 다시 잰다(그 팝업은 실제 바이트를 안다).
 * 엔진 쪽 estimateLocalModelFit(electron/local-model-hub/hardware.ts) 과 같은 예비량 규칙을 쓴다.
 */
import type { LocalHardwareProfile } from "@shared/local-model-hub";

export type LocalModelFitLevel = "smooth" | "caution" | "risky" | "unknown";
export type LocalModelRole = "chat" | "reasoning" | "coding" | "vision" | "embedding";

const GIB = 1024 ** 3;
/** Q4_K_M ≈ 4.5 bit/param → 0.56 byte/param; 토크나이저·메타 10% 여유. */
const Q4_BYTES_PER_PARAM = 0.56 * 1.1;

export function parseParameterCount(repository: string): number | null {
  const name = repository.split("/").at(-1) ?? repository;
  // "30B-A3B" 는 총 30B 가 메모리를 차지한다 — A3B(활성)는 건너뛴다.
  const matches = [...name.matchAll(/(?<![A-Za-z0-9.])(\d+(?:\.\d+)?)[bB](?![A-Za-z0-9])/g)];
  const first = matches[0]?.[1];
  const value = first ? Number(first) : NaN;
  return Number.isFinite(value) && value > 0 && value < 5000 ? value * 1e9 : null;
}

export function estimateModelBytes(repository: string): number | null {
  const params = parseParameterCount(repository);
  return params ? Math.round(params * Q4_BYTES_PER_PARAM) : null;
}

export function classifyModelRole(repository: string, tags: readonly string[] = []): LocalModelRole {
  const name = repository.toLowerCase();
  const tagSet = new Set(tags.map(tag => tag.toLowerCase()));
  if (tagSet.has("image-text-to-text") || tagSet.has("image-to-text") || /-vl\b|vision|llava|minicpm-v|-vlm/.test(name)) return "vision";
  if (tagSet.has("sentence-similarity") || tagSet.has("feature-extraction") || /embed|bge-|e5-|gte-/.test(name)) return "embedding";
  if (/coder|code|codestral|starcoder|deepseek-coder/.test(name) || tagSet.has("code")) return "coding";
  if (/reason|thinking|-r1\b|r1-|o1-|qwq|deepseek-r1|math/.test(name) || tagSet.has("reasoning")) return "reasoning";
  return "chat";
}

export function roleLabel(role: LocalModelRole, ko: boolean): string {
  switch (role) {
    case "vision": return ko ? "이미지" : "Vision";
    case "embedding": return ko ? "임베딩" : "Embedding";
    case "coding": return ko ? "코딩" : "Coding";
    case "reasoning": return ko ? "추론" : "Reasoning";
    default: return ko ? "대화" : "Chat";
  }
}

export interface LocalModelFitEstimate {
  level: LocalModelFitLevel;
  /** 판정용: 모델 파일 + 작업 메모리 + OS 예비량(총 메모리의 15%). */
  requiredBytes: number | null;
  /** 표시용: 모델 파일 + 작업 메모리. 예비량을 섞으면 1.7GiB 모델이 "9.9GiB 필요"로 보인다(실측 2026-09-13). */
  memoryBytes: number | null;
  reason: string;
}

/** `exact` = 실제 파일 크기(팝업의 파일 행), 아니면 이름에서 추정한 크기. */
export function estimateFit(hardware: LocalHardwareProfile | null | undefined, bytes: number | null, ko: boolean, exact = false): LocalModelFitEstimate {
  if (!hardware) return { level: "unknown", requiredBytes: null, memoryBytes: null, reason: ko ? "컴퓨터 사양을 아직 읽지 못했습니다" : "This computer's specs are not known yet" };
  if (bytes === null) return { level: "unknown", requiredBytes: null, memoryBytes: null, reason: ko ? "이름에서 크기를 알 수 없습니다. 파일을 열어 보면 파일별로 판정합니다" : "Size is not in the name. Open the files to judge each one" };
  const runtimeReserve = Math.max(GIB, Math.ceil(hardware.totalMemoryBytes * 0.15));
  const kvAndScratch = GIB;
  const requiredBytes = bytes + runtimeReserve + kvAndScratch;
  const memoryBytes = bytes + kvAndScratch;
  const total = hardware.totalMemoryBytes;
  const gpu = hardware.acceleratorEvidence !== "not-observed" && hardware.accelerator !== "unknown" && hardware.accelerator !== "cpu";
  const basis = ko ? (exact ? "파일 크기" : "이름에서 추정한 Q4 크기") : (exact ? "file size" : "Q4 size estimated from the name");
  const need = `${(memoryBytes / GIB).toFixed(1)} GiB`;
  const have = `${(total / GIB).toFixed(0)} GiB`;
  if (hardware.diskAvailableBytes !== null && hardware.diskAvailableBytes < bytes * 1.1) {
    return { level: "risky", requiredBytes, memoryBytes, reason: ko ? `저장 공간 부족 · 파일 ${(bytes / GIB).toFixed(1)} GiB` : `Not enough disk · file ${(bytes / GIB).toFixed(1)} GiB` };
  }
  if (requiredBytes > total) {
    return { level: "risky", requiredBytes, memoryBytes, reason: ko ? `메모리 ${have} 인데 ${need} + 시스템 예비량이 필요 (${basis})` : `Needs ${need} plus system headroom but this computer has ${have} (${basis})` };
  }
  if (requiredBytes > total * 0.75) {
    return { level: "caution", requiredBytes, memoryBytes, reason: ko ? `메모리 ${have} 중 ${need} 사용 · 다른 앱과 겹치면 느려짐 (${basis})` : `Uses ${need} of ${have} · slows down next to other apps (${basis})` };
  }
  if (!gpu) {
    return { level: "caution", requiredBytes, memoryBytes, reason: ko ? `메모리는 충분(${need}/${have}) · GPU 가속이 확인되지 않아 느릴 수 있음` : `Memory is fine (${need}/${have}) · no GPU acceleration observed, may be slow` };
  }
  return { level: "smooth", requiredBytes, memoryBytes, reason: ko ? `메모리 ${need}/${have} · GPU 가속 (${basis})` : `Memory ${need}/${have} · GPU accelerated (${basis})` };
}

export function fitLabel(level: LocalModelFitLevel, ko: boolean): string {
  switch (level) {
    case "smooth": return ko ? "원활" : "Smooth";
    case "caution": return ko ? "주의" : "Caution";
    case "risky": return ko ? "위험" : "Risky";
    default: return ko ? "확인" : "Check";
  }
}
