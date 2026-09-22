// Last-good model discovery persistence (PRD 2026-08-15 D-2).
//
// Before this, DISCOVERED_CLI_MODELS lived only in process memory: the first
// parse failure after a restart froze the picker empty until the next restart,
// and no one could tell whether "0 models" was new or had always been so.
//
// Now every ok probe is written to <userData>/model-discovery.json as
// { [runtime]: { count, at, models } }. A failed probe is backfilled from that
// file (stale: true) so the picker keeps the last real inventory, and the
// classifier gets `previousCount` to raise a yield warning on sharp drops.
//
// Store path resolution (no Electron needed, so contract tests can run under
// plain node): AGENTLAS_MODEL_DISCOVERY_PATH > Electron userData > tmpdir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyDiscovery, type DiscoveryOutcome, type DiscoverySource } from "../../shared/model-discovery";
import { isPackagedRuntime, userDataPath } from "../runtime-paths";

interface StoredRun {
  count: number;
  at: string;
  models: string[];
  source?: DiscoverySource;
}

interface StoreFile {
  schemaVersion: "agentlas.model-discovery-store.v1";
  runtimes: Record<string, StoredRun>;
  /**
   * 별칭 → 실행에서 관측된 실제 모델 id. 키는 `${kind}:${alias}`.
   *
   * ★왜 (오너 2026-09-07: "버전 바뀌어도 알아서 읽게 해라"). claude-code 는 모델 목록
   *   명령이 없어 별칭 `opus` 만 보낼 수 있고 화면에도 그것만 보였다. 실행 결과는
   *   실제 id(`claude-opus-5`)를 싣고 오므로 그것을 남긴다 — 벤더가 세대를 올리면
   *   다음 실행이 알아서 새 값으로 덮는다. 우리가 적는 값은 하나도 없다.
   *
   * 여기 두는 이유: 앱을 껐다 켜면 아직 한 번도 안 돌린 상태라 화면이 다시 별칭만
   * 보이게 된다. 마지막으로 확인된 사실을 들고 시작하는 편이 정직하다(발견 인벤토리와
   * 같은 규칙 — 위 lastGoodDiscovery).
   */
  resolvedAliases?: Record<string, { model: string; at: string }>;
}

const MAX_MODELS_PERSISTED = 500;

let cachedPath: string | null = null;

export function modelDiscoveryStorePath(): string {
  if (cachedPath) return cachedPath;
  const override = process.env.AGENTLAS_MODEL_DISCOVERY_PATH?.trim();
  if (override) return (cachedPath = override);
  try {
    // The packaged GUI and Node-mode daemon share the same discovered inventory.
    // Development hosts retain their isolated temporary path; QA metadata points
    // only at the explicitly isolated user-data, never the installed product.
    if (isPackagedRuntime()) return (cachedPath = userDataPath("model-discovery.json"));
  } catch {
    /* not inside Electron */
  }
  return (cachedPath = path.join(os.tmpdir(), `agentlas-model-discovery-${process.pid}.json`));
}

/** Test hook: forget the cached path so a new env override is honoured. */
export function resetModelDiscoveryStorePathForTests(): void {
  cachedPath = null;
}

function readStore(): StoreFile {
  try {
    const raw = fs.readFileSync(modelDiscoveryStorePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    if (parsed && parsed.schemaVersion === "agentlas.model-discovery-store.v1" && parsed.runtimes && typeof parsed.runtimes === "object") {
      return {
        schemaVersion: "agentlas.model-discovery-store.v1",
        runtimes: parsed.runtimes as Record<string, StoredRun>,
        // ★읽을 때 안 실으면 다음 쓰기가 통째로 지운다 — 새 칸을 더할 때마다 여기도 같이.
        ...(parsed.resolvedAliases && typeof parsed.resolvedAliases === "object"
          ? { resolvedAliases: parsed.resolvedAliases as StoreFile["resolvedAliases"] }
          : {}),
      };
    }
  } catch {
    /* first run / corrupt → empty (never overwrite a corrupt file until a good write) */
  }
  return { schemaVersion: "agentlas.model-discovery-store.v1", runtimes: {} };
}

function writeStore(store: StoreFile): void {
  const target = modelDiscoveryStorePath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
    fs.renameSync(tmp, target); // atomic replace, never truncate-in-place
  } catch {
    /* persistence is best-effort; discovery itself already succeeded */
  }
}

export function lastGoodDiscovery(runtime: string): StoredRun | null {
  const run = readStore().runtimes[runtime];
  return run && Array.isArray(run.models) && run.models.length > 0 ? run : null;
}

/** Record an ok outcome; failed/unsupported outcomes never overwrite last-good. */
/** 실행이 알려준 실제 모델을 남긴다. 별칭과 같으면 남길 것이 없다. */
export function recordResolvedAlias(runtime: string, alias: string, model: string): void {
  const key = `${runtime}:${alias}`;
  const value = String(model || "").trim();
  // alias === "" 는 **모델 미지정 실행**을 뜻한다(= 이 런타임의 기본 선택이 실제로
  // 무엇으로 풀렸는가). 기본값으로 쓰는 사람이 대다수라 이 칸을 막으면 아무도 못 본다.
  if (!runtime || typeof alias !== "string" || !value || value === alias || value.length > 128) return;
  const file = readStore();
  const current = file.resolvedAliases?.[key];
  if (current?.model === value) return;
  file.resolvedAliases = { ...(file.resolvedAliases ?? {}), [key]: { model: value, at: new Date().toISOString() } };
  writeStore(file);
}

/** 저장된 별칭 해석 전부 — 부팅 시 한 번 읽어 메모리 레지스트리를 채운다. */
export function storedResolvedAliases(): Array<{ runtime: string; alias: string; model: string }> {
  const entries = readStore().resolvedAliases ?? {};
  const out: Array<{ runtime: string; alias: string; model: string }> = [];
  for (const [key, value] of Object.entries(entries)) {
    const separator = key.indexOf(":");
    if (separator <= 0 || !value?.model) continue;  // alias 는 빈 문자열일 수 있다(기본 선택)
    out.push({ runtime: key.slice(0, separator), alias: key.slice(separator + 1), model: value.model });
  }
  return out;
}

export function recordDiscovery(runtime: string, outcome: DiscoveryOutcome): void {
  if (outcome.status !== "ok" || outcome.models.length === 0) return;
  const store = readStore();
  store.runtimes[runtime] = {
    count: outcome.models.length,
    at: outcome.at ?? new Date().toISOString(),
    models: outcome.models.slice(0, MAX_MODELS_PERSISTED),
    ...(outcome.source ? { source: outcome.source } : {}),
  };
  writeStore(store);
}

/**
 * Finish a probe: classify against the last good count, persist if ok, and on
 * failure hand back the last good models marked stale so callers never see an
 * empty menu that they cannot distinguish from "nothing installed".
 */
export function settleDiscovery(
  runtime: string,
  input: { stdout: string; models: readonly string[]; exitCode?: number | null; timedOut?: boolean; source?: DiscoverySource; idRe?: RegExp },
): DiscoveryOutcome {
  const previous = lastGoodDiscovery(runtime);
  const outcome = classifyDiscovery({ ...input, previousCount: previous?.count ?? null });
  outcome.at = new Date().toISOString();
  if (outcome.status === "ok") {
    recordDiscovery(runtime, outcome);
    return outcome;
  }
  if (outcome.status === "failed" && previous) {
    return { ...outcome, models: [...previous.models], stale: true, previousCount: previous.count, at: previous.at };
  }
  return outcome;
}

/** Log a failed/stale discovery once per (runtime, reason) until it changes. */
const lastLogged = new Map<string, string>();
export function reportDiscoveryLoudly(runtime: string, outcome: DiscoveryOutcome, log: (message: string) => void = (m) => console.error(m)): boolean {
  if (outcome.status !== "failed" && !outcome.yieldWarning) {
    lastLogged.delete(runtime);
    return false;
  }
  const signature = `${outcome.status}:${outcome.reason ?? ""}:${outcome.stale ? "stale" : ""}`;
  if (lastLogged.get(runtime) === signature) return false;
  lastLogged.set(runtime, signature);
  const stale = outcome.stale ? ` (showing ${outcome.models.length} stale models from ${outcome.at})` : "";
  log(`[model-discovery] ${runtime}: ${outcome.status} — ${outcome.reason ?? "unknown"} (${outcome.rawLineCount} raw lines)${stale}`);
  return true;
}
