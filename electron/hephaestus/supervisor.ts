// Stormbreaker 슈퍼바이저 상태.
//
// 기본값은 ON(안전한 실행 규율). 다만 Settings 토글은 실제로 동작해야 한다 —
// 사용자가 OFF로 두면 존중한다(가짜 토글 금지). 슈퍼바이저 finish 게이트는 매 write턴을
// 지연시키므로, 끄는 선택은 정당한 사용자 트레이드오프다(감사 지적 반영).
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { userDataPath } from "../runtime-paths";

interface HephaestusSettings {
  supervisorEnabled: boolean;
  /** Stormbreaker 자동 개입(일반 채팅에 루프 프로토콜 자동 주입). 기본 OFF —
   *  2026-07-12 실측: 단순 실작업에서 직접 실행 30s 완료 vs 스톰 라우트 6s 후 실행 0(hub_candidates 데드엔드).
   *  명시 실행(컴포저 Stormbreaker 칩, `stormbreaker` 프리픽스, continuousMode, division 자동화)은 항상 동작. */
  stormbreakerAuto: boolean;
  /** hep-network 자동 개입(자동 Hub Workforce 구성). 신규 설치 기본 ON —
   *  저장 파일에 이미 true/false가 있으면 그 값을 그대로 보존하고, 명시 경로
   *  (@멘션 고용, 추천 시트에서 직접 선택, hep-network 프리픽스, 자동화 hubMode)는 항상 동작. */
  networkAuto: boolean;
}

const DEFAULTS: HephaestusSettings = {
  supervisorEnabled: true,
  stormbreakerAuto: false,
  networkAuto: true,
};

let cache: HephaestusSettings | null = null;

function settingsPath(): string {
  return userDataPath("hephaestus-settings.json");
}

function load(): HephaestusSettings {
  if (cache) return cache;
  const file = settingsPath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<HephaestusSettings>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid Hephaestus settings object");
    }
    const hasStoredNetworkChoice = Object.prototype.hasOwnProperty.call(parsed, "networkAuto");
    cache = {
      ...DEFAULTS,
      ...parsed,
      // A stored boolean is authoritative. Invalid legacy values fail closed;
      // a valid older file with no network key receives the new-install default.
      networkAuto: hasStoredNetworkChoice ? parsed.networkAuto === true : DEFAULTS.networkAuto,
    };
  } catch {
    // ENOENT means a genuinely fresh install. A present but unreadable/corrupt
    // file is an existing user's state, so paid/remote auto-engagement fails closed.
    cache = fs.existsSync(file) ? { ...DEFAULTS, networkAuto: false } : { ...DEFAULTS };
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

/** 엔진 자동 개입 토글. 신규 설치는 Stormbreaker OFF, Network Workforce ON이다.
 *  DEFAULTS 뒤에 저장 JSON을 병합하므로 기존 true/false 선택은 변경하지 않는다. */
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
