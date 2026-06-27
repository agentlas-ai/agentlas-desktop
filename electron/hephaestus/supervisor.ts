// Stormbreaker 슈퍼바이저 상태.
//
// Stormbreaker는 내부 실행 규율이다. 사용자가 UI에서 켜고 끄는 기능이 아니며,
// 이전 빌드에서 저장된 off 값이 있더라도 현재 빌드에서는 항상 활성으로 취급한다.
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

/** Stormbreaker 슈퍼바이저 활성 여부. 현재는 항상 ON. */
export function isSupervisorEnabled(): boolean {
  return true;
}

export function setSupervisorEnabled(enabled: boolean): { enabled: boolean } {
  persist({ ...load(), supervisorEnabled: true });
  return { enabled: true };
}
