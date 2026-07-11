// Hephaestus 로컬 등록 → 데스크탑 라이브러리 자동 반영.
//
// 계약(엔진 agentlas_cloud/networking/desktop_sync.py와 쌍):
//   - 엔진은 trusted `local/*` 카드를 저장할 때마다
//     ~/.agentlas/networking/desktop-sync/pending/<slug>.json 을 쓴다.
//     (어느 런타임에서 빌드했든 — Claude 플러그인, Codex, 터미널, 데스크탑 벤더 —
//      카드 쓰기는 전부 save_card 단일 관문을 지난다.)
//   - 데스크탑은 시작 시 + pending 디렉토리 감시로 드레인한다: 각 항목의 ref 폴더를
//     importLocalFolder(경로 멱등)로 임포트하고 항목을 done/으로 옮긴다.
//     done 파일의 content_hash를 엔진이 읽어 같은 카드를 재큐잉하지 않는다.
//   - 큐와 무관하게 카드 저장소도 스캔해, 큐 도입 전 엔진이 등록한 완성 카드
//     (trusted local/* + 유효 절대경로 ref)를 소급 반영한다.
//     routing_ready 포지 실험 카드(수백 장 가능)는 절대 자격이 없다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { importLocalFolder } from "./import-local";
import { listRoutes } from "./routes";

const PACKAGE_MARKERS = ["agentlas.json", "AGENT.md", "AGENTS.md", "TEAM.md", "CLAUDE.md"];
const CARD_SUBDIRS = ["agents", "teams"];
const WATCH_DEBOUNCE_MS = 2_000;

function networkingHome(): string {
  const override = process.env.AGENTLAS_NETWORKING_HOME;
  if (override) return override;
  return path.join(os.homedir(), ".agentlas", "networking");
}

function pendingDir(): string {
  return path.join(networkingHome(), "desktop-sync", "pending");
}

function doneDir(): string {
  return path.join(networkingHome(), "desktop-sync", "done");
}

function failedDir(): string {
  return path.join(networkingHome(), "desktop-sync", "failed");
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 엔진 desktop_sync.qualifies_for_desktop과 동일한 규칙 — 변경 시 함께 변경할 것. */
function packageRefFromCard(card: Record<string, unknown>): string | null {
  if (card.stale) return null;
  if (String(card.routing_status ?? "") !== "trusted") return null;
  if (!String(card.id ?? "").startsWith("local/")) return null;
  const type = String(card.type ?? "");
  if (type !== "agent" && type !== "team") return null;
  const source = (card.source ?? {}) as Record<string, unknown>;
  if (String(source.kind ?? "") !== "local_path") return null;
  return validPackageRef(String(source.ref ?? ""));
}

function validPackageRef(raw: string): string | null {
  if (!raw || !path.isAbsolute(raw)) return null;
  try {
    if (!fs.statSync(raw).isDirectory()) return null;
  } catch {
    return null;
  }
  const hasMarker = PACKAGE_MARKERS.some((m) => {
    try {
      return fs.statSync(path.join(raw, m)).isFile();
    } catch {
      return false;
    }
  });
  return hasMarker ? path.resolve(raw) : null;
}

interface SyncItem {
  ref: string;
  /** pending 큐 파일(있으면 처리 후 done/failed로 이동). */
  pendingFile?: string;
  pendingEntry?: Record<string, unknown>;
}

function collectItems(): SyncItem[] {
  const byRef = new Map<string, SyncItem>();

  // 1) 카드 저장소 스캔 — 소급 반영의 원천(큐 도입 전 등록 포함).
  for (const sub of CARD_SUBDIRS) {
    const dir = path.join(networkingHome(), "cards", sub);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      const card = readJson(path.join(dir, f));
      if (!card) continue;
      const ref = packageRefFromCard(card);
      if (ref && !byRef.has(ref)) byRef.set(ref, { ref });
    }
  }

  // 2) pending 큐 — 엔진의 실시간 신호. done 이동으로 재큐잉을 멈추므로 항상 소비한다.
  let pendingFiles: string[] = [];
  try {
    pendingFiles = fs.readdirSync(pendingDir()).filter((f) => f.endsWith(".json"));
  } catch {
    pendingFiles = [];
  }
  for (const f of pendingFiles) {
    const file = path.join(pendingDir(), f);
    const entry = readJson(file);
    const ref = entry ? validPackageRef(String(entry.ref ?? "")) : null;
    if (!ref) {
      // ref가 사라졌거나 손상된 항목 — 재시도 무의미, failed로 치운다.
      moveEntry(file, failedDir(), { ...(entry ?? {}), error: "invalid or missing ref" });
      continue;
    }
    const existing = byRef.get(ref);
    if (existing) {
      existing.pendingFile = file;
      existing.pendingEntry = entry ?? undefined;
    } else {
      byRef.set(ref, { ref, pendingFile: file, pendingEntry: entry ?? undefined });
    }
  }
  return [...byRef.values()];
}

function moveEntry(file: string, targetDir: string, payload: Record<string, unknown>): void {
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, path.basename(file)),
      `${JSON.stringify({ ...payload, drained_at: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    fs.rmSync(file, { force: true });
  } catch (err) {
    console.error("[hephaestus-sync] queue move failed:", err);
  }
}

function alreadyImported(ref: string): boolean {
  try {
    return listRoutes().some((r) => {
      try {
        return path.resolve(r.path) === ref;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export interface HephaestusSyncResult {
  imported: string[];
  skipped: number;
  failed: Array<{ ref: string; error: string }>;
}

let drainInFlight: Promise<HephaestusSyncResult> | null = null;

/** pending 큐 + 카드 저장소를 드레인해 미등록 로컬 패키지를 라이브러리에 반영한다. */
export function drainHephaestusSync(): Promise<HephaestusSyncResult> {
  if (drainInFlight) return drainInFlight;
  const task = drainOnce().finally(() => {
    if (drainInFlight === task) drainInFlight = null;
  });
  drainInFlight = task;
  return task;
}

async function drainOnce(): Promise<HephaestusSyncResult> {
  const result: HephaestusSyncResult = { imported: [], skipped: 0, failed: [] };
  for (const item of collectItems()) {
    try {
      if (alreadyImported(item.ref)) {
        result.skipped += 1;
      } else {
        await importLocalFolder(item.ref);
        result.imported.push(item.ref);
        console.log("[hephaestus-sync] imported:", item.ref);
      }
      if (item.pendingFile) {
        moveEntry(item.pendingFile, doneDir(), { ...(item.pendingEntry ?? {}), status: "imported" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push({ ref: item.ref, error: message });
      console.error("[hephaestus-sync] import failed:", item.ref, message);
      if (item.pendingFile) {
        moveEntry(item.pendingFile, failedDir(), { ...(item.pendingEntry ?? {}), error: message });
      }
    }
  }
  return result;
}

let watcher: fs.FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;

/** 시작 시 1회 드레인 + pending 감시. 실패해도 앱 시작을 막지 않는다. */
export function startHephaestusSync(): void {
  void drainHephaestusSync().catch((err) => console.error("[hephaestus-sync] initial drain failed:", err));
  try {
    fs.mkdirSync(pendingDir(), { recursive: true });
    watcher = fs.watch(pendingDir(), () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void drainHephaestusSync().catch((err) => console.error("[hephaestus-sync] drain failed:", err));
      }, WATCH_DEBOUNCE_MS);
    });
  } catch (err) {
    console.error("[hephaestus-sync] watch failed (startup drain still ran):", err);
  }
}

export function stopHephaestusSync(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  try {
    watcher?.close();
  } catch {
    // ignore
  }
  watcher = null;
}
