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
}

const DEFAULTS: HephaestusSettings = {
  supervisorEnabled: true,
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
