// 에이전트 동시 실행 수(스웜 크기) 설정 — 하드코딩 4를 대체한다.
// 에이전트 1명 = 무거운 CLI/모델 자식 프로세스라, 컴 사양(코어/RAM)을 읽어 추천값을 계산하고
// 사용자가 대시보드 슬라이더로 조절한다(게임 그래픽 세팅처럼). 저장은 meta 테이블.
import os from "node:os";
import { getMeta, setMeta } from "./meta";

const META_KEY = "agent_concurrency";
// 슬라이더/설정의 절대 상한 — 단일 머신이 감당 못 하는 값으로 폭주하는 걸 막는 최후 방어선.
// basis: 정한 값 — 근거 없음(이번 묶음은 값을 바꾸지 않았다). 닿으면: 설정·슬라이더 값이 32로 잘린다(조용히 — clamp). 새 상한이 아니라 있던 상한.
export const AGENT_CONCURRENCY_HARD_MAX = 32;

/*
 * 추천 동시 수의 식 (Agentlas 2.0 S5, 오너). 이 값은 "막는 값"이다: 사용자가 슬라이더를 건드리지 않았으면 getAgentConcurrency가 곧
 * 이 추천값이고, run-slots.ts 가 그 수만큼만 CLI 자식 프로세스를 동시에 띄운다(넘는 요청은 거절이 아니라 FIFO 대기열 — 화면에 대기로 보인다).
 * 슬라이더로 저장한 값(userSet)은 이 식과 무관하게 그대로 쓴다.
 *
 *   추천 = min(코어 − 2, floor((RAM GiB − RESERVE_GIB) / PER_AGENT_GIB), AGENT_CONCURRENCY_HARD_MAX)
 *
 * 측정(arm64 16코어 48 GiB Mac, 턴이 도는 동안 프로세스 나무 전체 RSS 최대값을 0.12초마다 재서. ps 기준이라 공유 페이지를 프로세스마다 센 상한이다. 한 줄 프롬프트 한 턴과
 * 셸 도구 한 번(sleep 6)을 쓴 턴. 사람의 개인 MCP 서버가 섞이지 않게 제품의 격리 홈 모양을 따랐다: claude `--setting-sources "" --strict-mcp-config`, codex `--ignore-user-config`,
 * antigravity·grok 는 링크만으로 만든 격리 홈 — 증거 docs/Agentlas2.0/evidence/desktop-values-s56/):
 *   claude-code 260~272 MiB(1~3개 프로세스) · codex 410~446 MiB(3~5) · antigravity(agy) 228~290 MiB(2) · grok 457~495 MiB(3)
 *   kimi·cursor·github-copilot-cli: 이 Mac에 설치돼 있지 않아 못 잼. API 실행기(byok·agentlas 서빙)는 Main 안의 HTTP라 자식 프로세스가 없고 이 풀에 들지 않는다.
 * 큰 저장소를 읽는 긴 턴은 더 크다(한 줄 턴만 쟀다). 데스크탑 자신(설치된 앱, 3일 켜 둔 상태): Main 0.39 + 데몬 0.74(기록은 세션 중 1.1) + 렌더러 0.13 + 헬퍼 0.05 = 약 1.3 GiB.
 *   가장 큰 측정값은 grok 도구 턴의 495 MiB → CLI 하나의 몫은 0.5 GiB로 올림.
 */
/** basis: 측정 — 구독 CLI 4종의 턴 중 나무 RSS 최대 495 MiB(grok). 닿으면(이보다 큰 CLI가 오면): 추천이 낙관적이 되어 대기열이 덜 생기고 메모리가 빠듯해질 수 있다(슬라이더는 그대로 존중). */
export const AGENT_CLI_TREE_GIB = 0.5;
/** basis: 정한 값 — 근거 없음. 에이전트가 시작하는 도구(빌드·테스트 등)의 몫으로 CLI 몫과 같게 잡았다; 큰 빌드는 이를 넘을 수 있다. 닿으면: 메모리가 모자랄 때 OS가 스왑하거나 CLI를 죽이고, 사람에게는 "응답이 끝나기 전에 멈춤" 카드가 보인다. */
export const AGENT_TOOL_ALLOWANCE_GIB = 0.5;
/** 에이전트 한 명(실행 칸 하나)이 쓸 것으로 잡는 RAM. 이전 값은 2 GiB(측정 근거 없음, 같은 앱의 상주 정리 주석은 쉬는 CLI 150~300 MiB). */
export const AGENT_PER_SLOT_GIB = AGENT_CLI_TREE_GIB + AGENT_TOOL_ALLOWANCE_GIB;
/** basis: 데스크탑 자신 1.5(측정: 위 1.3 GiB, 데몬이 세션 중 1.1 GiB까지 간 기록을 더해 올림) + 운영체제와 사용자의 다른 앱 2.5(정한 값 — 근거 없음). 합 4는 이전 값 그대로. */
export const AGENT_RAM_RESERVE_GIB = 1.5 + 2.5;

export interface SystemSpecs {
  cores: number;
  totalMemGB: number;
}

export function getSystemSpecs(): SystemSpecs {
  let cores = 4;
  let totalMemGB = 8;
  try {
    cores = Math.max(1, os.cpus().length);
  } catch {
    // fall back
  }
  try {
    totalMemGB = os.totalmem() / 1024 ** 3;
  } catch {
    // fall back
  }
  return { cores, totalMemGB };
}

/**
 * 컴 사양 기반 추천 동시성. 코어는 2개(OS/앱) 남기고, RAM은 AGENT_RAM_RESERVE_GIB를 뺀 나머지를 에이전트당 AGENT_PER_SLOT_GIB로 나눈다(식과 측정은 위).
 * 사양을 못 읽으면 getSystemSpecs()의 대체값(코어 4·RAM 8 GiB)이라 2가 된다. 최소 1.
 */
export function recommendedConcurrency(specs: SystemSpecs = getSystemSpecs()): number {
  const coreBound = Math.max(1, specs.cores - 2);
  const memBound = Math.max(1, Math.floor((specs.totalMemGB - AGENT_RAM_RESERVE_GIB) / AGENT_PER_SLOT_GIB));
  return Math.max(1, Math.min(coreBound, memBound, AGENT_CONCURRENCY_HARD_MAX));
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return recommendedConcurrency();
  return Math.max(1, Math.min(Math.floor(n), AGENT_CONCURRENCY_HARD_MAX));
}

/** 현재 동시성 — 사용자가 설정했으면 그 값(범위 클램프), 아니면 사양 기반 추천값. */
export function getAgentConcurrency(): number {
  const raw = getMeta(META_KEY);
  if (raw === null || raw === "") return recommendedConcurrency();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return recommendedConcurrency();
  return clamp(parsed);
}

export function setAgentConcurrency(value: number): number {
  const clamped = clamp(value);
  setMeta(META_KEY, String(clamped));
  return clamped;
}

/** 대시보드/설정 UI용 — 사양 + 추천 + 현재값 + 상한을 한 번에. */
export interface AgentConcurrencyInfo {
  cores: number;
  totalMemGB: number;
  recommended: number;
  current: number;
  hardMax: number;
  /** 사용자가 명시 설정했는지(추천값을 그냥 쓰는 중이면 false) */
  userSet: boolean;
}

export function getAgentConcurrencyInfo(): AgentConcurrencyInfo {
  const specs = getSystemSpecs();
  const raw = getMeta(META_KEY);
  const userSet = raw !== null && raw !== "";
  return {
    cores: specs.cores,
    totalMemGB: Math.round(specs.totalMemGB * 10) / 10,
    recommended: recommendedConcurrency(specs),
    current: getAgentConcurrency(),
    hardMax: AGENT_CONCURRENCY_HARD_MAX,
    userSet,
  };
}

// 로컬 추론(Ollama/LM Studio/MLX) 동시성 — 위 agent_concurrency와 별개의 예산이다.
// CLI 자식 프로세스는 주로 원격 API를 기다리며 로컬 자원을 거의 안 쓰지만, 로컬
// 추론은 정확히 반대다: 요청 1건이 이미 코어 대부분/GPU·통합메모리 대역폭을 쓴다.
// 그래서 "코어-2, RAM/2"였던 CLI 공식을 그대로 재사용하면 과다 산정된다 — 훨씬
// 보수적인 별도 공식과 훨씬 낮은 상한을 둔다.
const LOCAL_INFERENCE_META_KEY = "local_inference_concurrency";
// basis: 정한 값 — 근거 없음(이번 묶음은 값을 바꾸지 않았다; 로컬 추론의 RSS는 모델 크기에 달려 재지 않았다). 닿으면: 설정값이 4로 잘린다(조용히 — clamp).
export const LOCAL_INFERENCE_CONCURRENCY_HARD_MAX = 4;

/** 로컬 추론 추천 동시성 — 코어 8개당, 여유 RAM 8GB당 겨우 1건씩만 추가로 허용. */
export function recommendedLocalInferenceConcurrency(specs: SystemSpecs = getSystemSpecs()): number {
  const coreBound = Math.max(1, Math.floor(specs.cores / 8));
  const memBound = Math.max(1, Math.floor((specs.totalMemGB - 8) / 8) + 1);
  return Math.max(1, Math.min(coreBound, memBound, LOCAL_INFERENCE_CONCURRENCY_HARD_MAX));
}

function clampLocalInference(n: number): number {
  if (!Number.isFinite(n)) return recommendedLocalInferenceConcurrency();
  return Math.max(1, Math.min(Math.floor(n), LOCAL_INFERENCE_CONCURRENCY_HARD_MAX));
}

export function getLocalInferenceConcurrency(): number {
  const raw = getMeta(LOCAL_INFERENCE_META_KEY);
  if (raw === null || raw === "") return recommendedLocalInferenceConcurrency();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return recommendedLocalInferenceConcurrency();
  return clampLocalInference(parsed);
}

export function setLocalInferenceConcurrency(value: number): number {
  const clamped = clampLocalInference(value);
  setMeta(LOCAL_INFERENCE_META_KEY, String(clamped));
  return clamped;
}

export interface LocalInferenceConcurrencyInfo {
  cores: number;
  totalMemGB: number;
  recommended: number;
  current: number;
  hardMax: number;
  userSet: boolean;
}

export function getLocalInferenceConcurrencyInfo(): LocalInferenceConcurrencyInfo {
  const specs = getSystemSpecs();
  const raw = getMeta(LOCAL_INFERENCE_META_KEY);
  const userSet = raw !== null && raw !== "";
  return {
    cores: specs.cores,
    totalMemGB: Math.round(specs.totalMemGB * 10) / 10,
    recommended: recommendedLocalInferenceConcurrency(specs),
    current: getLocalInferenceConcurrency(),
    hardMax: LOCAL_INFERENCE_CONCURRENCY_HARD_MAX,
    userSet,
  };
}
