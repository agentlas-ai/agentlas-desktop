// Stormbreaker 슈퍼바이저 상태.
//
// "앱에서 뭘 하든 Stormbreaker 가 자동 실행" — 그 전역 토글의 영속 상태를 관리한다.
// 기본 ON. userData/hephaestus-settings.json 에 저장(다른 설정과 분리, 단순 JSON).
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

/** Stormbreaker 슈퍼바이저(전역 자동 실행) 활성 여부. */
export function isSupervisorEnabled(): boolean {
  return load().supervisorEnabled;
}

export function setSupervisorEnabled(enabled: boolean): { enabled: boolean } {
  persist({ ...load(), supervisorEnabled: enabled });
  return { enabled };
}
