// 고용(빌림) 로스터 — 사이드바 "고용 중" 섹션의 데이터 소스.
//
// 두 로컬 소스를 합친다 (둘 다 Hephaestus 엔진이 쓰는 파일, 우리는 읽기만):
//   1. ~/.agentlas/networking/leases.json — 24h 리스 표시 캐시
//      (허브 서버가 과금 권위, 이 파일은 hub_invocation이 갱신하는 표시용 사본)
//   2. ~/.agentlas/networking/hub-agents/<slug>/memory/ — 빌린 에이전트별 기억 둥지
//      (invocation-ledger.jsonl mtime = 마지막으로 같이 일한 시각)
//
// routing-cards.ts와 같은 안전 규칙: 지정 경로 밖은 절대 읽지 않고, 깨진 JSON은
// 조용히 건너뛰고, 30초 캐시로 디스크 재읽기를 막는다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HiredRosterItem } from "../../shared/types";
import { findCardForAgent } from "./routing-cards";

const CACHE_TTL_MS = 30_000;
let cache: { loadedAt: number; items: HiredRosterItem[] } | null = null;

/**
 * Agentlas-OS/Hephaestus 내부 시스템 에이전트인가.
 * Stormbreaker·route·hep-network 가 사용자 요청을 처리하며 자기 인프라 에이전트
 * (감사·리서치 코퍼스)를 후보로 빌리면 networking/hub-agents 에 둥지가 생긴다.
 * 이들은 마켓플레이스 제품이 아니라 엔진 내부 부품이므로 사용자용 "고용 중"
 * 로스터에 노출하면 안 된다.
 *   - researcher-<번호>-*        : Agentlas-OS 리서치/감사 코퍼스(001~NNN)
 *   - research-intelligence-desk : 그 코퍼스의 오케스트레이터
 *   - hephaestus-*               : Hephaestus 엔진 인프라
 */
export function isInternalAgentSlug(slug: string): boolean {
  const s = String(slug || "").toLowerCase();
  return /^researcher-\d+/.test(s) || s === "research-intelligence-desk" || s.startsWith("hephaestus-");
}

function networkingRoot(): string {
  return path.join(os.homedir(), ".agentlas", "networking");
}

function readLeaseCache(): Record<string, { leased_until?: unknown; active?: unknown }> {
  try {
    const raw = fs.readFileSync(path.join(networkingRoot(), "leases.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, { leased_until?: unknown; active?: unknown }>;
  } catch {
    return {};
  }
}

function listMemoryNests(): Map<string, { lastWorkedAt?: string }> {
  const nests = new Map<string, { lastWorkedAt?: string }>();
  const root = path.join(networkingRoot(), "hub-agents");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return nests;
  }
  for (const slug of entries) {
    if (!slug || slug.startsWith(".")) continue;
    const memoryDir = path.join(root, slug, "memory");
    try {
      if (!fs.statSync(memoryDir).isDirectory()) continue;
    } catch {
      continue;
    }
    let lastWorkedAt: string | undefined;
    try {
      lastWorkedAt = fs.statSync(path.join(memoryDir, "invocation-ledger.jsonl")).mtime.toISOString();
    } catch {
      // 원장이 아직 없으면 시각 없이 둥지만 표시
    }
    nests.set(slug, { lastWorkedAt });
  }
  return nests;
}

/** 리스 캐시 + 기억 둥지를 합쳐 고용 로스터를 만든다. 활성 리스 우선, 그다음 최근 협업순. */
export function listHiredAgents(): HiredRosterItem[] {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.items;

  const leases = readLeaseCache();
  const nests = listMemoryNests();
  const slugs = new Set<string>([...Object.keys(leases), ...nests.keys()]);

  const items: HiredRosterItem[] = [];
  for (const slug of slugs) {
    if (isInternalAgentSlug(slug)) continue; // 엔진 내부 에이전트는 사용자 로스터에서 숨김
    const lease = leases[slug];
    const leasedUntil = typeof lease?.leased_until === "string" ? lease.leased_until : undefined;
    const leaseActive = Boolean(leasedUntil && Date.parse(leasedUntil) > now);
    const nest = nests.get(slug);
    const card = findCardForAgent(slug, "");
    items.push({
      slug,
      name: typeof card?.name === "string" ? card.name : undefined,
      nameKo: typeof card?.name_ko === "string" ? card.name_ko : undefined,
      leasedUntil,
      leaseActive,
      hasMemory: Boolean(nest),
      lastWorkedAt: nest?.lastWorkedAt,
    });
  }

  items.sort((a, b) => {
    if (a.leaseActive !== b.leaseActive) return a.leaseActive ? -1 : 1;
    const aT = Date.parse(a.lastWorkedAt ?? a.leasedUntil ?? "") || 0;
    const bT = Date.parse(b.lastWorkedAt ?? b.leasedUntil ?? "") || 0;
    return bT - aT;
  });

  cache = { loadedAt: now, items };
  return items;
}

/** 테스트용 — 캐시 무효화. */
export function invalidateHiredAgentsCache(): void {
  cache = null;
}
