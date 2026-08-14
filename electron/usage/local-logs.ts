// 로컬 로그 기반 사용량 — 네트워크 0, rate-limit 0 (ccusage 방식).
//
// Claude Code / Codex CLI는 대화를 로컬 JSONL로 남기고 각 assistant 이벤트에 토큰 usage를
// 기록한다. 이를 파싱하면 서버 usage 엔드포인트를 치지 않고도 "최근 5시간 / 7일 토큰 합"을
// 계산할 수 있다 — 서버 조회가 429/실패할 때의 폴백이자, 평상시 신선한 실시간 값이다.
//
// 한계: 로컬 로그엔 "구독 한도 대비 %"가 없다(플랜 한도는 서버만 앎). 그래서 정확한 리셋 %는
// 서버(usage/*.ts)가, 절대 토큰량·추세는 로컬(여기)이 담당하는 하이브리드로 병합한다.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface LocalWindowTokens {
  /** 5시간 롤링 윈도우 토큰 합(input+output+cache, 지금-5h 이후). */
  fiveHour: number;
  /** 7일 롤링 윈도우 토큰 합. */
  sevenDay: number;
  /** 가장 최근 활동 시각(ms) — 신선도 판단용. null이면 로그 없음. */
  lastActivity: number | null;
}

const FIVE_HOUR_MS = 5 * 60 * 60_000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60_000;
// 파싱 대상: 최근 7일 이내 수정된 파일만(오래된 세션은 윈도우 밖이라 볼 필요 없음).
const FILE_MTIME_WINDOW_MS = SEVEN_DAY_MS + 60 * 60_000;
// usage를 담은 라인만 파싱하려는 프리필터(라인별 JSON.parse 비용 절감).
const USAGE_HINT = '"usage"';
const OUTPUT_HINT = '"output_tokens"';

const TTL_MS = 60_000;
const cache = new Map<string, { value: LocalWindowTokens; at: number }>();

function sumTokens(u: Record<string, unknown>): number {
  const n = (k: string) => {
    const v = Number(u[k]);
    return Number.isFinite(v) ? v : 0;
  };
  // 실제 새 소비 = input + output + cache_creation. cache_read(캐시 재사용)는 사용량 부담이
  // 거의 없어 제외한다 — 넣으면 5시간 합이 실사용의 수 배로 부풀어 리밋 근사가 왜곡된다.
  return n("input_tokens") + n("output_tokens") + n("cache_creation_input_tokens");
}

/** 디렉터리에서 최근 mtime jsonl 파일 경로만 수집(재귀, 상한). */
function recentJsonlFiles(root: string, now: number, limit = 400): string[] {
  const out: string[] = [];
  const stack = [root];
  let guard = 0;
  while (stack.length && out.length < limit && guard < 20_000) {
    guard++;
    const dir = stack.pop();
    if (!dir) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        stack.push(p);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          const st = fs.statSync(p);
          if (now - st.mtimeMs <= FILE_MTIME_WINDOW_MS) out.push(p);
        } catch {
          /* skip */
        }
      }
    }
  }
  return out;
}

/** 한 파일을 스트리밍 없이 읽되, usage 힌트가 있는 라인만 JSON.parse(성능). */
function accumulateFile(
  file: string,
  now: number,
  extract: (line: Record<string, unknown>) => { ts: number; tokens: number } | null,
  acc: { fiveHour: number; sevenDay: number; lastActivity: number | null },
): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line || line.indexOf(USAGE_HINT) === -1 || line.indexOf(OUTPUT_HINT) === -1) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const hit = extract(obj);
    if (!hit || !Number.isFinite(hit.ts) || hit.tokens <= 0) continue;
    const age = now - hit.ts;
    if (age < 0 || age > SEVEN_DAY_MS) continue;
    acc.sevenDay += hit.tokens;
    if (age <= FIVE_HOUR_MS) acc.fiveHour += hit.tokens;
    if (acc.lastActivity == null || hit.ts > acc.lastActivity) acc.lastActivity = hit.ts;
  }
}

/** Claude Code 로컬 로그 → 윈도우 토큰. (~/.claude/projects 하위 .jsonl 재귀) */
export function getClaudeLocalTokens(): LocalWindowTokens {
  return withCache("claude", () => {
    const now = Date.now();
    const root = path.join(os.homedir(), ".claude", "projects");
    const acc = { fiveHour: 0, sevenDay: 0, lastActivity: null as number | null };
    if (!fs.existsSync(root)) return acc;
    for (const file of recentJsonlFiles(root, now)) {
      accumulateFile(file, now, (obj) => {
        const msg = (obj.message ?? null) as Record<string, unknown> | null;
        const usage = (msg?.usage ?? null) as Record<string, unknown> | null;
        const tsRaw = obj.timestamp;
        if (!usage || typeof tsRaw !== "string") return null;
        const ts = Date.parse(tsRaw);
        return Number.isNaN(ts) ? null : { ts, tokens: sumTokens(usage) };
      }, acc);
    }
    return acc;
  });
}

/** Codex CLI 로컬 로그 → 윈도우 토큰. (~/.codex/sessions·archived_sessions 하위 .jsonl 재귀) */
export function getCodexLocalTokens(): LocalWindowTokens {
  return withCache("codex", () => {
    const now = Date.now();
    const acc = { fiveHour: 0, sevenDay: 0, lastActivity: null as number | null };
    for (const sub of ["sessions", "archived_sessions"]) {
      const root = path.join(os.homedir(), ".codex", sub);
      if (!fs.existsSync(root)) continue;
      for (const file of recentJsonlFiles(root, now)) {
        accumulateFile(file, now, (obj) => {
          // Codex rollout 라인은 형태가 다양 — usage/token_usage 어느 쪽이든 총합을 집는다.
          const usage =
            (obj.usage as Record<string, unknown> | undefined) ??
            ((obj.info as Record<string, unknown> | undefined)?.token_usage as Record<string, unknown> | undefined) ??
            ((obj.payload as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined);
          if (!usage) return null;
          const tsRaw = obj.timestamp ?? obj.ts ?? (obj.payload as Record<string, unknown> | undefined)?.timestamp;
          const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : typeof tsRaw === "number" ? tsRaw : NaN;
          if (Number.isNaN(ts)) return null;
          const total = Number(usage.total_tokens);
          const tokens = Number.isFinite(total) && total > 0 ? total : sumTokens(usage);
          return { ts, tokens };
        }, acc);
      }
    }
    return acc;
  });
}

function withCache(key: string, compute: () => LocalWindowTokens): LocalWindowTokens {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = compute();
  cache.set(key, { value, at: now });
  return value;
}

export function localTokensFor(provider: string): LocalWindowTokens | null {
  if (provider === "claude-code") return getClaudeLocalTokens();
  // Codex(rollout 형식 다양·archived 방대해 느림)와 Antigravity(로컬 토큰 로그 없음)는 서버 전용.
  // 서버 usage 조회가 안정적이라 폴백 필요가 낮다 — 후속에 Codex 로컬을 정밀화할 수 있다.
  return null;
}
