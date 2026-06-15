// Oberon — 로컬 영속화 (localStorage). 데스크탑 셸은 정적 export라 서버 없음.
// 실제 백엔드 연결 시 이 모듈만 IPC/DB로 교체하면 된다.

import type { FilmProduction } from "./types";

const INDEX_KEY = "oberon.productions.index";
const ITEM_PREFIX = "oberon.production.";

export interface ProductionMeta {
  id: string;
  title: string;
  format: string;
  shotCount: number;
  createdAtMs: number;
}

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // sandbox/quota — 무시 (메모리 상태로만 동작)
  }
}

export function listProductions(): ProductionMeta[] {
  const raw = safeGet(INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ProductionMeta[];
  } catch {
    return [];
  }
}

export function saveProduction(prod: FilmProduction): void {
  safeSet(`${ITEM_PREFIX}${prod.id}`, JSON.stringify(prod));
  const meta: ProductionMeta = {
    id: prod.id,
    title: prod.brief.title,
    format: prod.brief.format,
    shotCount: prod.stats.shotCount,
    createdAtMs: prod.createdAtMs,
  };
  const index = listProductions().filter((m) => m.id !== prod.id);
  index.unshift(meta);
  safeSet(INDEX_KEY, JSON.stringify(index.slice(0, 30)));
}

export function loadProduction(id: string): FilmProduction | null {
  const raw = safeGet(`${ITEM_PREFIX}${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FilmProduction;
  } catch {
    return null;
  }
}

export function deleteProduction(id: string): void {
  try {
    window.localStorage.removeItem(`${ITEM_PREFIX}${id}`);
  } catch {
    // ignore
  }
  const index = listProductions().filter((m) => m.id !== id);
  safeSet(INDEX_KEY, JSON.stringify(index));
}
