// 에이전트 동시 실행 수(스웜 크기) 설정 — 하드코딩 4를 대체한다.
// 에이전트 1명 = 무거운 CLI/모델 자식 프로세스라, 컴 사양(코어/RAM)을 읽어 추천값을 계산하고
// 사용자가 대시보드 슬라이더로 조절한다(게임 그래픽 세팅처럼). 저장은 meta 테이블.
import os from "node:os";
import { getMeta, setMeta } from "./meta";

const META_KEY = "agent_concurrency";
// 슬라이더/설정의 절대 상한 — 단일 머신이 감당 못 하는 값으로 폭주하는 걸 막는 최후 방어선.
export const AGENT_CONCURRENCY_HARD_MAX = 32;

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

/** 컴 사양 기반 추천 동시성. 코어는 2개(OS/앱) 남기고, RAM은 에이전트당 ~2GB + 4GB 여유 가정. */
export function recommendedConcurrency(specs: SystemSpecs = getSystemSpecs()): number {
  const coreBound = Math.max(1, specs.cores - 2);
  const memBound = Math.max(1, Math.floor((specs.totalMemGB - 4) / 2));
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
