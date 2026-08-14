// 실행 중 확인된 프로바이더 상태를 사용량 대시보드와 공유한다.
// 원문 오류·프롬프트·토큰은 저장하지 않고, 허용된 짧은 상태 코드만 원자적으로 기록한다.
import fs from "node:fs";
import path from "node:path";

export type ProviderHealthCode =
  | "grok_quota_exhausted";

export interface ProviderHealthEntry {
  code: ProviderHealthCode;
  updatedAt: number;
}

type ProviderHealthState = Record<string, ProviderHealthEntry>;

const TTL_BY_CODE: Record<ProviderHealthCode, number> = {
  // Grok CLI는 정확한 quota window/reset을 주지 않는다. 상태 영수증만 최대 8일 보존하며
  // 이 TTL을 7일 사용량 창이나 퍼센트로 투영해서는 안 된다.
  grok_quota_exhausted: 8 * 24 * 60 * 60_000,
};

export function providerHealthFile(): string | null {
  const override = process.env.AGENTLAS_PROVIDER_HEALTH_FILE?.trim();
  if (override) return override;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as typeof import("electron");
    return path.join(app.getPath("userData"), "provider-health.json");
  } catch {
    // 헤드리스/테스트 환경은 명시적 override가 없으면 디스크를 건드리지 않는다.
    return null;
  }
}

function isHealthEntry(value: unknown): value is ProviderHealthEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ProviderHealthEntry>;
  return (
    entry.code === "grok_quota_exhausted" &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt)
  );
}

function readState(): ProviderHealthState {
  const file = providerHealthFile();
  if (!file) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const state: ProviderHealthState = {};
    for (const [provider, value] of Object.entries(parsed)) {
      if (isHealthEntry(value)) state[provider] = value;
    }
    return state;
  } catch {
    return {};
  }
}

function writeState(state: ProviderHealthState): void {
  const file = providerHealthFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows 등 chmod 미지원 환경은 원자적 기록 자체는 유지한다.
    }
  } catch {
    // 상태 보조 파일 실패가 채팅 실행을 막으면 안 된다.
  }
}

export function readProviderHealth(
  provider: string,
  now = Date.now(),
): ProviderHealthEntry | null {
  const state = readState();
  const entry = state[provider];
  if (!entry) return null;
  if (now - entry.updatedAt <= TTL_BY_CODE[entry.code]) return entry;
  delete state[provider];
  writeState(state);
  return null;
}

export function recordProviderHealth(
  provider: string,
  code: ProviderHealthCode,
  now = Date.now(),
): void {
  const state = readState();
  state[provider] = { code, updatedAt: now };
  writeState(state);
}

export function clearProviderHealth(provider: string): void {
  const state = readState();
  if (!(provider in state)) return;
  delete state[provider];
  writeState(state);
}
