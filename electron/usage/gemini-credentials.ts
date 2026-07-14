// Gemini OAuth 파일은 외부 CLI와 공유된다. 일부 비정상 종료에서 정상 JSON 뒤에 바이트가
// 붙을 수 있으므로, 첫 번째 완전한 JSON 객체만 안전하게 복구하고 원본은 별도 백업한다.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface GeminiCredentialFile {
  file: Record<string, unknown>;
  filePath: string;
  token: string | null;
  refreshToken: string | null;
  expiryDate: number | null;
}

export type GeminiCredentialResult =
  | { status: "missing"; filePath: string }
  | { status: "corrupt"; filePath: string }
  | { status: "ok"; credentials: GeminiCredentialFile; recovered: boolean; backupPath?: string };

export function defaultGeminiCredentialPath(): string {
  return path.join(os.homedir(), ".gemini", "oauth_creds.json");
}

/** 문자열/escape를 고려해 raw의 첫 완전한 최상위 JSON 객체 범위를 찾는다. */
export function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

function normalizeCredential(filePath: string, file: Record<string, unknown>): GeminiCredentialFile | null {
  const access = file.access_token;
  const refresh = file.refresh_token;
  if (access != null && typeof access !== "string") return null;
  if (refresh != null && typeof refresh !== "string") return null;
  const token = typeof access === "string" && access ? access : null;
  const refreshToken = typeof refresh === "string" && refresh ? refresh : null;
  const exp = Number(file.expiry_date);
  return {
    file,
    filePath,
    token,
    refreshToken,
    expiryDate: Number.isFinite(exp) && exp > 0 ? exp : null,
  };
}

function parseCredential(filePath: string, raw: string): GeminiCredentialFile | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return normalizeCredential(filePath, parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

export async function writeGeminiCredentialsAtomic(
  filePath: string,
  file: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, filePath);
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // chmod 미지원 환경
  }
}

const repairInFlight = new Map<string, Promise<GeminiCredentialResult>>();

async function repairGeminiCredentialFileOnce(
  filePath: string,
  retry = 0,
): Promise<GeminiCredentialResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { status: code === "ENOENT" ? "missing" : "corrupt", filePath };
  }

  const strict = parseCredential(filePath, raw);
  if (strict) return { status: "ok", credentials: strict, recovered: false };

  const first = extractFirstJsonObject(raw);
  const recovered = first ? parseCredential(filePath, first) : null;
  if (!recovered || (!recovered.token && !recovered.refreshToken)) {
    return { status: "corrupt", filePath };
  }

  // Gemini CLI가 같은 OAuth 파일을 갱신했으면 낡은 snapshot으로 덮어쓰지 않고 새 원본을 재평가한다.
  try {
    if ((await fs.readFile(filePath, "utf8")) !== raw) {
      return retry < 3
        ? repairGeminiCredentialFileOnce(filePath, retry + 1)
        : { status: "corrupt", filePath };
    }
  } catch {
    return retry < 3
      ? repairGeminiCredentialFileOnce(filePath, retry + 1)
      : { status: "corrupt", filePath };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.corrupt-${stamp}-${process.pid}-${randomUUID().slice(0, 8)}.bak`;
  try {
    await fs.writeFile(backupPath, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // 백업을 쓰는 사이 외부 CLI가 정상 토큰을 저장했을 수도 있다. 커밋 직전 다시 비교한다.
    if ((await fs.readFile(filePath, "utf8")) !== raw) {
      return retry < 3
        ? repairGeminiCredentialFileOnce(filePath, retry + 1)
        : { status: "corrupt", filePath };
    }
    await writeGeminiCredentialsAtomic(filePath, recovered.file);
    return { status: "ok", credentials: recovered, recovered: true, backupPath };
  } catch {
    // 안전한 백업 또는 원자적 교체가 실패하면 원본을 그대로 두고 실패로 표면화한다.
    return { status: "corrupt", filePath };
  }
}

export function repairGeminiCredentialFile(
  filePath = defaultGeminiCredentialPath(),
): Promise<GeminiCredentialResult> {
  const resolved = path.resolve(filePath);
  const active = repairInFlight.get(resolved);
  if (active) return active;
  const task = repairGeminiCredentialFileOnce(resolved).finally(() => {
    if (repairInFlight.get(resolved) === task) repairInFlight.delete(resolved);
  });
  repairInFlight.set(resolved, task);
  return task;
}
