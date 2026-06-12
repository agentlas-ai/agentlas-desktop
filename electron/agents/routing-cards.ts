// Hephaestus Network 라우팅 카드 — ~/.agentlas/networking/cards/{agents,teams,plugins}/*.json
// 설치된 에이전트의 자동 라우팅 점수에 trigger/anti-trigger 보정을 제공한다.
//
// 설계:
//   - 카드 디렉토리(루트 + agents/teams/plugins)만 스캔한다. 다른 경로는 절대 읽지 않는다.
//   - 깨진/형식이 다른 JSON 파일은 조용히 건너뛴다.
//   - 30초 모듈 캐시 — 라우팅 호출마다 디스크를 다시 읽지 않는다.
//   - routing_status가 routing_ready/trusted이고 stale이 아닌 카드만 점수에 영향
//     (그 미만 등급 카드는 자동 라우팅에 절대 개입하지 않는다 — card_lint 게이트).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RoutingCardTriggerExample {
  text: string;
  locale?: "ko" | "en";
}

export interface RoutingCard {
  id: string;
  name?: string;
  name_ko?: string | null;
  trigger_examples?: RoutingCardTriggerExample[];
  anti_triggers?: RoutingCardTriggerExample[];
  routing_status?: string;
  stale?: boolean;
  [key: string]: unknown;
}

const CARD_SUBDIRS = ["agents", "teams", "plugins"];
const CACHE_TTL_MS = 30_000;
const TRIGGER_TOKEN_OVERLAP = 2;
const TRIGGER_BONUS = 8;
const ANTI_TRIGGER_PENALTY = -8;
const ROUTABLE_STATUSES = new Set(["routing_ready", "trusted"]);

let cache: { loadedAt: number; cards: RoutingCard[] } | null = null;

// auto-router.ts의 STOP_WORDS / tokenize()와 동일한 동작의 포팅본.
// 카드 trigger 텍스트와 프롬프트 토큰을 같은 규칙으로 비교하기 위함 — 변경 시 함께 변경할 것.
const CARD_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "make",
  "build",
  "create",
  "agent",
  "agents",
  "please",
  "좀",
  "해주세요",
  "해줘",
  "만들어",
  "붙여",
  "연결",
  "작업",
  "요청",
]);

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_/]+/g, "-");
}

export function tokenizeCardText(value: string): string[] {
  const normalized = normalize(value);
  const matches = normalized.match(/[a-z0-9][a-z0-9-]{1,}|[가-힣]{2,}/g) ?? [];
  const expanded = matches.flatMap((term) => term.split("-").filter(Boolean).concat(term));
  return [...new Set(expanded.filter((term) => term.length >= 2 && !CARD_STOP_WORDS.has(term)))];
}

function cardsRoot(): string {
  return path.join(os.homedir(), ".agentlas", "networking", "cards");
}

function readCardFile(file: string): RoutingCard | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const card = parsed as RoutingCard;
    if (typeof card.id !== "string" || !card.id.trim()) return null;
    return card;
  } catch {
    return null; // 깨진 카드 파일은 조용히 무시
  }
}

function collectCardFiles(dir: string, cards: RoutingCard[]): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const card = readCardFile(path.join(dir, entry));
    if (card) cards.push(card);
  }
}

export function loadRoutingCards(): RoutingCard[] {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.cards;

  const cards: RoutingCard[] = [];
  try {
    const root = cardsRoot();
    if (fs.existsSync(root)) {
      collectCardFiles(root, cards);
      for (const sub of CARD_SUBDIRS) {
        collectCardFiles(path.join(root, sub), cards);
      }
    }
  } catch {
    // 카드 루트 접근 실패 — 라우팅은 카드 없이 계속 동작
  }
  cache = { loadedAt: now, cards };
  return cards;
}

function idTail(id: string): string {
  const idx = id.lastIndexOf("/");
  return idx >= 0 ? id.slice(idx + 1) : id;
}

export function findCardForAgent(slug: string, name: string): RoutingCard | null {
  const wantSlug = (slug || "").trim().toLowerCase();
  const wantName = (name || "").trim().toLowerCase();
  if (!wantSlug && !wantName) return null;

  const cards = loadRoutingCards();
  if (wantSlug) {
    const bySlug = cards.find((card) => idTail(card.id).trim().toLowerCase() === wantSlug);
    if (bySlug) return bySlug;
  }
  if (wantName) {
    const byName = cards.find((card) =>
      [card.name, card.name_ko].some(
        (candidate) => typeof candidate === "string" && candidate.trim().toLowerCase() === wantName,
      ),
    );
    if (byName) return byName;
  }
  return null;
}

function anyTriggerOverlaps(
  promptTokens: Set<string>,
  triggers: RoutingCardTriggerExample[] | undefined,
): boolean {
  if (!Array.isArray(triggers)) return false;
  return triggers.some((trigger) => {
    if (!trigger || typeof trigger.text !== "string") return false;
    let shared = 0;
    for (const token of tokenizeCardText(trigger.text)) {
      if (promptTokens.has(token)) {
        shared += 1;
        if (shared >= TRIGGER_TOKEN_OVERLAP) return true;
      }
    }
    return false;
  });
}

export function cardScoreAdjustment(
  promptTokens: string[] | Set<string>,
  card: RoutingCard,
): number {
  if (!ROUTABLE_STATUSES.has(card.routing_status ?? "")) return 0;
  if (card.stale === true) return 0;

  const tokens = promptTokens instanceof Set ? promptTokens : new Set(promptTokens);
  let adjustment = 0;
  if (anyTriggerOverlaps(tokens, card.trigger_examples)) adjustment += TRIGGER_BONUS;
  if (anyTriggerOverlaps(tokens, card.anti_triggers)) adjustment += ANTI_TRIGGER_PENALTY;
  return adjustment;
}
