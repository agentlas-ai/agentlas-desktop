// 폴 소스 + 적응형 폴 매니저(설계 §3.3, §3.4 Tier 1) — 폴링 강제 트리거 전용.
//
// 핵심 원칙(설계 §3.1): 폴링은 유일한 실질 비용이므로 두 가지로 통제한다.
//   (1) 단일 공유 매니저 — 새 타이머를 만들지 않고 기존 60초 틱(automation-scheduler)에
//       runPollDue(now)를 얹어, "지금 due한 폴 트리거"만 골라 검사한다. per-automation 타이머 금지.
//   (2) 적응형 간격 — 값이 안 변하면 지수 백오프(min→2배→…→max), 변하거나 임계 근접하면
//       다시 min으로 조인다. 시장 데이터(stock)는 MARKET_STATUS로 게이팅해 장 마감/야간엔 더 늘린다.
//   + dedup 커서(lastSeen) — 같은 값이면 재발사 안 함. 조건 통과 시에만 기존 실행 경로로 합류.
//
// 실행 엔진은 손대지 않는다 — 폴 매니저는 "언제 fire하나"만 결정하고, fire는 트리거 매니저의
// RunFn(automation-scheduler.runAutomationFromTrigger)으로 위임한다.
//
// nextPollAt/currentInterval은 프로세스 인메모리 상태다(앱 꺼지면 폴도 정지 — 설계 §3.1의
// 안전장치). lastSeen 커서만 trigger_json에 영속화해 재기동 후에도 중복 발사를 막는다.
import type { Automation, PollSource, Trigger } from "../../shared/types";
import { listEnabledByTrigger, updateAutomation } from "../store/automations";
import { evaluateCondition } from "./condition";
import { callServerTool } from "../mcp-tools/client";
import { getServer } from "../mcp-tools/registry";

// ── 적응형 폴 상태(인메모리, 자동화 id 키) ─────────────────────────────
interface PollState {
  /** 다음 폴 예정 시각(ms epoch). 60초 틱이 이 값 <= now인 것만 검사. */
  nextPollAt: number;
  /** 현재 폴 간격(ms). 값 불변이면 2배씩 증가(max 상한), 변하면 min으로 리셋. */
  currentIntervalMs: number;
  /** 직전 관측값(dedup + changed 조건용). trigger.lastSeen에서 하이드레이트. */
  lastSeen: string | undefined;
}

const states = new Map<string, PollState>();

/** stock 소스 게이팅용 시장 상태 캐시 — MARKET_STATUS는 자주 안 바뀌므로 5분 캐시. */
let marketOpenCache: { open: boolean; at: number } | null = null;
const MARKET_CACHE_MS = 5 * 60 * 1000;

/**
 * poll 트리거를 가진 enabled 자동화 중 nextPollAt<=now인 것만 폴한다.
 * 기존 60초 틱에서 호출된다(새 타이머 없음, 설계 §3.3).
 */
export async function runPollDue(now: Date = new Date()): Promise<void> {
  let autos: Automation[];
  try {
    autos = listEnabledByTrigger("poll");
  } catch (err) {
    console.error("[poll] listEnabledByTrigger failed:", err);
    return;
  }
  const nowMs = now.getTime();
  for (const a of autos) {
    if (!a.trigger || a.trigger.kind !== "poll") continue;
    const st = ensureState(a);
    if (st.nextPollAt > nowMs) continue; // 아직 due 아님(적응형 간격이 늘려놓음)
    await pollOne(a, a.trigger, st, now);
  }
}

/** 인메모리 상태를 준비(없으면 trigger에서 하이드레이트). */
function ensureState(a: Automation): PollState {
  let st = states.get(a.id);
  if (!st) {
    const trig = a.trigger && a.trigger.kind === "poll" ? a.trigger : null;
    st = {
      nextPollAt: 0, // 즉시 첫 폴(0 <= now)
      currentIntervalMs: trig ? Math.max(30_000, trig.minIntervalMs) : 60_000,
      lastSeen: trig?.lastSeen,
    };
    states.set(a.id, st);
  }
  return st;
}

/** 자동화가 삭제/토글off되면 상태를 버린다(트리거 매니저 재동기화에서 호출). */
export function forgetPollState(automationId: string): void {
  states.delete(automationId);
}

/** 모든 폴 상태 초기화(앱 종료/테스트). */
export function clearPollStates(): void {
  states.clear();
}

/**
 * 한 자동화를 폴한다: 소스 값 관측 → 조건 평가 → (통과+변화면) fire → 적응형 간격 갱신.
 * 시장 게이팅: stock 소스이고 장 마감이면 간격을 강제로 max로 늘린다(설계 §3.3).
 */
async function pollOne(a: Automation, trigger: Extract<Trigger, { kind: "poll" }>, st: PollState, now: Date): Promise<void> {
  const min = Math.max(30_000, trigger.minIntervalMs);
  const max = Math.max(min, trigger.maxIntervalMs);
  let observed: string | null = null;
  try {
    observed = await fetchPollValue(trigger.source);
  } catch (err) {
    console.error(`[poll] fetch failed (${a.name}):`, err);
    // 소스 오류 시 백오프를 늘려 폭주 방지(장애난 소스를 30초마다 두드리지 않는다).
    st.currentIntervalMs = Math.min(max, st.currentIntervalMs * 2);
    st.nextPollAt = now.getTime() + st.currentIntervalMs;
    return;
  }

  // 관측 불가(자격증명 미충족 등) — 다음 폴을 min으로 잡되 발사는 안 함.
  if (observed == null) {
    st.nextPollAt = now.getTime() + min;
    return;
  }

  const changed = st.lastSeen === undefined ? true : observed !== st.lastSeen;

  // 조건 평가 — 관측값을 {{value}}로, changed 여부를 lastSeen 인자로 넘긴다.
  const pass = evaluateCondition(trigger.cond, { value: observed }, st.lastSeen);

  // dedup: 값이 그대로면(변화 없음) 발사하지 않는다(설계 §3.3 커서). changed 연산자는 위에서 처리됨.
  if (pass && changed) {
    fire(a.id);
  }

  // 적응형 간격: 변했으면 min으로 조이고, 아니면 2배로 늘린다(max 상한). 시장 마감 게이팅.
  let nextInterval = changed ? min : Math.min(max, st.currentIntervalMs * 2);
  if (trigger.source.kind === "stock" && (trigger.source.gateMarket ?? true)) {
    const open = await isMarketOpen(now);
    if (!open) nextInterval = max; // 장 마감/야간엔 최대 간격
  }
  st.currentIntervalMs = nextInterval;
  st.nextPollAt = now.getTime() + nextInterval;

  // lastSeen 커서 갱신 + 영속화(재기동 후 중복 발사 방지). 값이 바뀐 경우에만 write.
  if (changed) {
    st.lastSeen = observed;
    persistCursor(a, trigger, observed);
  }
}

/** fire — 트리거 매니저가 주입한 RunFn(스케줄러)으로 위임. 클레임 없이 즉시 1회 실행. */
type RunFn = (automationId: string) => Promise<void>;
let runFn: RunFn | null = null;
/** 폴 매니저에 실행 함수 주입(트리거 매니저 기동 시). */
export function setPollRunFn(fn: RunFn): void {
  runFn = fn;
}
function fire(automationId: string): void {
  if (!runFn) return;
  void runFn(automationId).catch(() => {
    /* 실행 오류는 스케줄러가 run_history에 기록 */
  });
}

/** lastSeen 커서를 trigger_json에 영속화(updateAutomation 경유). best-effort. */
function persistCursor(a: Automation, trigger: Extract<Trigger, { kind: "poll" }>, value: string): void {
  try {
    updateAutomation(a.id, { trigger: { ...trigger, lastSeen: value } });
  } catch (err) {
    console.error("[poll] persist cursor failed:", err);
  }
}

// ── 소스별 값 관측 ─────────────────────────────────────────────────
// 각 소스는 스칼라/문자열 하나를 관측한다. 기존 stdio MCP 서버(catalog)를 callServerTool로
// 단발 호출한다. 서버 미설치/자격증명 미충족이면 null(폴 스킵). 서버 id는 well-known 관례.

/** 소스 → 관측값 문자열. null=관측 불가(스킵). */
async function fetchPollValue(source: PollSource): Promise<string | null> {
  switch (source.kind) {
    case "stock":
      return fetchStock(source);
    case "github":
      return fetchGithub(source);
    case "slack":
      return fetchSlack(source);
    case "notion":
      return fetchNotion(source);
    default:
      return null;
  }
}

/**
 * stock — 주가/지표. well-known 서버 id("stock" 또는 "alphavantage")를 찾아 GLOBAL_QUOTE류
 * 툴을 호출한다. metric=price면 현재가, 그 외면 해당 지표 원문. 서버 미설치면 null.
 * TODO(P2+): 서버별 툴 스키마 차이를 카탈로그 메타로 흡수(지금은 GLOBAL_QUOTE 관례).
 */
async function fetchStock(source: Extract<PollSource, { kind: "stock" }>): Promise<string | null> {
  const server = getServer("alphavantage") ?? getServer("stock");
  if (!server) return null;
  const metric = source.metric ?? "price";
  const toolName = metric === "price" ? "GLOBAL_QUOTE" : metric.toUpperCase();
  const raw = await callServerTool(server, toolName, { symbol: source.symbol });
  if (raw == null) return null;
  return extractStockValue(raw, metric);
}

/**
 * GLOBAL_QUOTE JSON에서 관측값 추출. Alpha Vantage GLOBAL_QUOTE는 "05. price" 필드에
 * 현재가를 담는다. 파싱 실패 시 원문을 그대로 반환(문자열 비교 폴백).
 */
export function extractStockValue(raw: string, metric: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const quote = (parsed["Global Quote"] ?? parsed) as Record<string, unknown>;
    if (metric === "price") {
      const price = quote["05. price"] ?? quote["price"] ?? quote["c"];
      if (price != null) return String(price);
    }
    const v = quote[metric] ?? parsed[metric];
    if (v != null) return String(v);
  } catch {
    /* JSON 아니면 원문 폴백 */
  }
  return raw.trim();
}

/** MARKET_STATUS 게이팅 — 미국 장 개장 여부. 5분 캐시. 서버 없거나 실패하면 "열림"으로 간주(폴 유지). */
async function isMarketOpen(now: Date): Promise<boolean> {
  if (marketOpenCache && now.getTime() - marketOpenCache.at < MARKET_CACHE_MS) {
    return marketOpenCache.open;
  }
  const server = getServer("alphavantage") ?? getServer("stock");
  if (!server) {
    marketOpenCache = { open: true, at: now.getTime() };
    return true;
  }
  try {
    const raw = await callServerTool(server, "MARKET_STATUS", {});
    // "open"이 응답에 있으면 개장으로 간주(정밀 파싱은 지역별로 상이하므로 러프 게이트).
    const open = raw ? /"current_status"\s*:\s*"open"|\bopen\b/i.test(raw) : true;
    marketOpenCache = { open, at: now.getTime() };
    return open;
  } catch {
    marketOpenCache = { open: true, at: now.getTime() };
    return true;
  }
}

/**
 * github — 이슈/PR 최신 항목의 식별자(id/number)를 관측. lastSeen 커서와 다르면 "새 항목".
 * catalog "github" 서버(server-github)의 list 툴을 호출한다. 서버 미설치/미인증이면 null.
 */
async function fetchGithub(source: Extract<PollSource, { kind: "github" }>): Promise<string | null> {
  const server = getServer("github");
  if (!server) return null;
  const [owner, repo] = source.repo.split("/");
  if (!owner || !repo) return null;
  const resource = source.resource ?? "issues";
  const toolName = resource === "pulls" ? "list_pull_requests" : "list_issues";
  const raw = await callServerTool(server, toolName, { owner, repo, state: "open", perPage: 1 });
  if (raw == null) return null;
  return newestGithubId(raw);
}

/** GitHub list 응답에서 가장 최신 항목의 id/number 추출(커서). 파싱 실패 시 원문 앞부분. */
export function newestGithubId(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { items?: unknown[] }).items)
        ? (parsed as { items: unknown[] }).items
        : [];
    const first = arr[0] as Record<string, unknown> | undefined;
    if (first) {
      const id = first["id"] ?? first["number"] ?? first["node_id"];
      if (id != null) return String(id);
    }
  } catch {
    /* 원문 폴백 */
  }
  return raw.slice(0, 200).trim();
}

/**
 * slack — 채널 최신 메시지 ts(타임스탬프)를 관측. catalog "slack" 서버의 history 툴 호출.
 * TODO(P2+): server-slack의 정확한 툴명/파라미터는 버전에 따라 다르다. webhook(§webhook-server)이
 *   있으면 폴링보다 그쪽을 우선(설계 §3.2 "webhook 있으면 공짜"). 서버 미설치/미인증이면 null.
 */
async function fetchSlack(source: Extract<PollSource, { kind: "slack" }>): Promise<string | null> {
  const server = getServer("slack");
  if (!server) return null;
  try {
    const raw = await callServerTool(server, "slack_get_channel_history", {
      channel_id: source.channel,
      limit: 1,
    });
    if (raw == null) return null;
    return newestSlackTs(raw);
  } catch {
    return null; // 툴명 불일치 등은 조용히 스킵(needsCredential/미설치와 동일 취급)
  }
}

/** Slack history 응답에서 최신 메시지 ts 추출(커서). */
export function newestSlackTs(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const msgs = (parsed["messages"] ?? []) as Array<Record<string, unknown>>;
    const first = msgs[0];
    if (first && first["ts"] != null) return String(first["ts"]);
  } catch {
    /* 원문 폴백 */
  }
  return raw.slice(0, 200).trim();
}

/**
 * notion — 데이터베이스 최신 페이지 id를 관측. catalog "notion" 서버 query 툴 호출.
 * TODO(P2+): @notionhq/notion-mcp-server 툴 스키마 확정 필요(현재 관례적 이름). 미설치/미인증이면 null.
 */
async function fetchNotion(source: Extract<PollSource, { kind: "notion" }>): Promise<string | null> {
  const server = getServer("notion");
  if (!server) return null;
  try {
    const raw = await callServerTool(server, "notion_query_database", {
      database_id: source.databaseId,
      page_size: 1,
      sorts: [{ timestamp: "created_time", direction: "descending" }],
    });
    if (raw == null) return null;
    return newestNotionId(raw);
  } catch {
    return null;
  }
}

/** Notion query 응답에서 최신 페이지 id 추출(커서). */
export function newestNotionId(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const results = (parsed["results"] ?? []) as Array<Record<string, unknown>>;
    const first = results[0];
    if (first && first["id"] != null) return String(first["id"]);
  } catch {
    /* 원문 폴백 */
  }
  return raw.slice(0, 200).trim();
}
