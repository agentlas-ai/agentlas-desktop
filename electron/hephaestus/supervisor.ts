// Stormbreaker 슈퍼바이저 상태.
//
// 기본값은 ON(안전한 실행 규율). 다만 Settings 토글은 실제로 동작해야 한다 —
// 사용자가 OFF로 두면 존중한다(가짜 토글 금지). 슈퍼바이저 finish 게이트는 매 write턴을
// 지연시키므로, 끄는 선택은 정당한 사용자 트레이드오프다(감사 지적 반영).
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

interface HephaestusSettings {
  supervisorEnabled: boolean;
  /** Stormbreaker 자동 개입(일반 채팅에 루프 프로토콜 자동 주입). 기본 OFF —
   *  2026-07-12 실측: 단순 실작업에서 직접 실행 30s 완료 vs 스톰 라우트 6s 후 실행 0(hub_candidates 데드엔드).
   *  명시 실행(컴포저 Stormbreaker 칩, `stormbreaker` 프리픽스, continuousMode, division 자동화)은 항상 동작. */
  stormbreakerAuto: boolean;
  /** hep-network 자동 개입(자동 Hub 빌림·라우터 에스컬레이션). 기본 OFF —
   *  명시 경로(@멘션 고용, 추천 시트에서 직접 선택, hep-network 프리픽스, 자동화 hubMode)는 항상 동작. */
  networkAuto: boolean;
}

const DEFAULTS: HephaestusSettings = {
  supervisorEnabled: true,
  stormbreakerAuto: false,
  networkAuto: false,
};

let cache: HephaestusSettings | null = null;

function settingsPath(): string {
  return path.join(app.getPath("userData"), "hephaestus-settings.json");
}

function load(): HephaestusSettings {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<HephaestusSettings>;
    cache = { ...DEFAULTS, ...parsed };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function persist(next: HephaestusSettings): void {
  cache = next;
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  } catch {
    // 비치명적 — 메모리 캐시는 갱신됨.
  }
}

/** Stormbreaker 슈퍼바이저 활성 여부. 저장된 사용자 선택을 존중(기본 ON). */
export function isSupervisorEnabled(): boolean {
  return load().supervisorEnabled;
}

export function setSupervisorEnabled(enabled: boolean): { enabled: boolean } {
  persist({ ...load(), supervisorEnabled: enabled });
  return { enabled };
}

export interface EngineAutoToggles {
  stormbreakerAuto: boolean;
  networkAuto: boolean;
}

/** 엔진 자동 개입 토글(대시보드 LLM 연결·사용량 아래 스위치 2개). 기본 둘 다 OFF. */
export function getEngineToggles(): EngineAutoToggles {
  const s = load();
  return { stormbreakerAuto: s.stormbreakerAuto === true, networkAuto: s.networkAuto === true };
}

export function isStormbreakerAutoEnabled(): boolean {
  return load().stormbreakerAuto === true;
}

export function isNetworkAutoEnabled(): boolean {
  return load().networkAuto === true;
}

export function setEngineToggle(id: "stormbreaker" | "network", enabled: boolean): EngineAutoToggles {
  const s = load();
  persist(
    id === "stormbreaker" ? { ...s, stormbreakerAuto: enabled } : { ...s, networkAuto: enabled },
  );
  return getEngineToggles();
}
