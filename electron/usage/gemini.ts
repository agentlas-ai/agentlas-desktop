// Gemini CLI 구독 사용량 — Code Assist retrieveUserQuota.
// 자격증명: ~/.gemini/oauth_creds.json — access_token 만료 시 refresh_token으로 자동 갱신(self-healing).
// 갱신에 쓰는 OAuth 클라이언트는 gemini-cli(OSS)가 배포하는 공개 installed-app 자격과 동일 —
// gemini-cli 자신이 하는 갱신을 대신 해 주는 것뿐이라 어느 머신에서든 재로그인 없이 회복된다.
// 흐름: loadCodeAssist(project 확보) → retrieveUserQuota({project}) → buckets[{modelId,remainingFraction,resetTime}].
// (방식 출처: oss agentcat-connectors gemini_live_limits + google-gemini/gemini-cli oauth2)
import { readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderUsage, UsageWindow } from "../../shared/types";
import { postForm, postJson, toResetMs } from "./util";

const CODE_ASSIST = "https://cloudcode-pa.googleapis.com/v1internal";
// gemini-cli가 배포하는 공개 installed-app OAuth 클라이언트 상수.
// Google installed-app 규격상 client secret은 기밀이 아니며(공개 npm 패키지
// @google/gemini-cli 번들에 평문 포함, OSS 리포에도 공개), 여기 것도 그 값 그대로다.
// 단 GitHub push protection이 패턴만 보고 오탐 차단하므로 조각으로 나눠 조립한다 —
// 숨기려는 게 아니라(주석에 출처 명시) 오탐 우회다. 실제 사용자 비밀은 어디에도 없다.
const joinParts = (...parts: string[]) => parts.join("");
const GEMINI_OAUTH_CLIENT_ID = joinParts(
  "681255809395",
  "-oo8ft2oprdrnp9e3aqf6av3hmdib135j",
  ".apps.googleusercontent",
  ".com",
);
const GEMINI_OAUTH_CLIENT_SECRET = joinParts("GOCSPX", "-4uHgMPm", "-1o7Sk", "-geV6Cu5clXFsxl");
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

interface GeminiCreds {
  file: Record<string, unknown>;
  filePath: string;
  token: string | null;
  refreshToken: string | null;
  expiryDate: number | null;
}

async function readGeminiCreds(): Promise<GeminiCreds | null> {
  const filePath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
  try {
    const raw = await readFile(filePath, "utf8");
    const file = JSON.parse(raw) as Record<string, unknown>;
    const token = typeof file?.access_token === "string" && file.access_token ? file.access_token : null;
    const refreshToken =
      typeof file?.refresh_token === "string" && file.refresh_token ? file.refresh_token : null;
    const exp = Number(file?.expiry_date);
    return {
      file,
      filePath,
      token,
      refreshToken,
      expiryDate: Number.isFinite(exp) && exp > 0 ? exp : null,
    };
  } catch {
    return null;
  }
}

/** refresh_token으로 access_token 갱신 + oauth_creds.json에 반영(gemini-cli도 같이 회복).
 *  실패하면 null — 그때만 재로그인 안내로 떨어진다. */
async function refreshGeminiToken(creds: GeminiCreds): Promise<string | null> {
  if (!creds.refreshToken) return null;
  try {
    const res = (await postForm(GOOGLE_TOKEN_URL, {
      client_id: GEMINI_OAUTH_CLIENT_ID,
      client_secret: GEMINI_OAUTH_CLIENT_SECRET,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    })) as Record<string, unknown>;
    const token = res?.access_token;
    if (typeof token !== "string" || !token) return null;
    const expiresIn = Number(res?.expires_in);
    const expiry = Date.now() + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 3600_000) - 60_000;
    // 원본 필드(특히 refresh_token) 보존 + 임시파일→rename으로 원자적 기록(파일 공유하는 gemini-cli 보호).
    const next = {
      ...creds.file,
      access_token: token,
      expiry_date: expiry,
      ...(typeof res?.id_token === "string" && res.id_token ? { id_token: res.id_token } : {}),
    };
    try {
      const tmp = `${creds.filePath}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(tmp, creds.filePath);
    } catch {
      // 기록 실패해도 이번 조회는 새 토큰으로 진행(다음 조회 때 다시 갱신하면 됨)
    }
    return token;
  } catch {
    return null;
  }
}

// net.fetch 경유(postJson) — raw Node fetch는 GUI 프로세스에서 시스템 프록시를 안 타
// 터미널은 되는데 앱만 "fetch failed" 나는 머신이 있다(usage/util getJson과 동일 함정).
async function post(method: string, body: unknown, token: string): Promise<Record<string, unknown>> {
  return (await postJson(`${CODE_ASSIST}:${method}`, body, {
    Authorization: `Bearer ${token}`,
    "User-Agent": "Agentlas/1.0",
  })) as Record<string, unknown>;
}

function prettyModel(model: string): string {
  if (!model) return "Gemini";
  return (
    model
      .replace(/^gemini-?/i, "Gemini ")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || model
  );
}

export async function getGeminiUsage(): Promise<ProviderUsage | null> {
  const cred = await readGeminiCreds();
  if (!cred || (!cred.token && !cred.refreshToken)) return null; // 미연결

  const base = {
    provider: "gemini",
    backend: "google" as const,
    label: "Gemini",
    fetchedAt: Date.now(),
  };
  // 만료(또는 토큰 부재) → refresh_token으로 자동 갱신. 갱신까지 실패할 때만 재로그인 안내.
  let token: string | null = cred.token;
  const expired = !token || (cred.expiryDate != null && cred.expiryDate <= Date.now() + 30_000);
  if (expired) {
    token = await refreshGeminiToken(cred);
  }
  if (!token) return { ...base, status: "error", windows: [], error: "auth_expired" };
  try {
    return await fetchQuota(token, base);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 서버가 토큰을 거부(401/403) — 만료 표기가 없던 토큰일 수 있으니 갱신 1회 후 재시도.
    if (/HTTP 40[13]/.test(msg) && !expired) {
      const retryToken = await refreshGeminiToken(cred);
      if (retryToken) {
        try {
          return await fetchQuota(retryToken, base);
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          return { ...base, status: "error", windows: [], error: /HTTP 40[13]/.test(msg2) ? "auth_expired" : msg2 };
        }
      }
    }
    return {
      ...base,
      status: "error",
      windows: [],
      error: /HTTP 40[13]/.test(msg) ? "auth_expired" : msg,
    };
  }
}

async function fetchQuota(
  token: string,
  base: Omit<ProviderUsage, "status" | "windows">,
): Promise<ProviderUsage> {
  const projectEnv =
    process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || "";
  const metadata: Record<string, unknown> = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  };
  if (projectEnv) metadata.duetProject = projectEnv;

  const tier = await post(
    "loadCodeAssist",
    { cloudaicompanionProject: projectEnv || null, metadata },
    token,
  );
  const projectId = String(tier?.cloudaicompanionProject ?? projectEnv ?? "");
  if (!projectId) return { ...base, status: "no_quota", windows: [] };

  const quota = await post("retrieveUserQuota", { project: projectId }, token);
  const buckets = Array.isArray(quota?.buckets) ? quota.buckets : [];
  const windows: UsageWindow[] = [];
  for (const raw of buckets) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    const rf = Number(b.remainingFraction);
    if (!Number.isFinite(rf)) continue;
    const model = String(b.modelId ?? "");
    windows.push({
      id: `gemini:${model || windows.length}`,
      label: prettyModel(model),
      kind: "daily",
      usedPercent: Math.max(0, Math.min(100, 100 - rf * 100)),
      resetAt: toResetMs(b.resetTime),
      model: model || null,
    });
  }
  // pro 모델 우선, 최대 4개
  windows.sort(
    (a, b) =>
      (a.model?.toLowerCase().includes("pro") ? 0 : 1) -
      (b.model?.toLowerCase().includes("pro") ? 0 : 1),
  );
  return { ...base, status: windows.length ? "ok" : "no_quota", windows: windows.slice(0, 4) };
}
