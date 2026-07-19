// 멀티모달 엔진 "실제 가용성" 프로브 + auto 해석.
//  - cli-subscription 엔진(codex / nanobanana=agy): 실행 파일(bin)이 PATH에 있으면 준비됨(키리스).
//  - api-key / cloud-credentials 엔진: 필요한 env 키가 전부 보관함/환경에 있으면 준비됨.
// trex/imagegen.ts가 이미 검증한 키리스-우선 로직을 일반 에이전트 경로로 끌어올린 것.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTO_PROVIDER,
  getMultimodalProvider,
  providerLadder,
  type MultimodalModality,
  type MultimodalProvider,
  type MultimodalSettings,
} from "../../shared/multimodal";
import { hasEnvVar } from "../secrets/vault";

/** cli-subscription provider id → 찾을 실행 파일 이름 + 흔한 설치 경로. */
const CLI_BINS: Record<string, { name: string; extra: string[] }> = {
  "codex-cli-image": {
    name: "codex",
    extra: [
      path.join(os.homedir(), ".local/bin/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ],
  },
  "nanobanana-image": {
    name: "agy",
    extra: [
      path.join(os.homedir(), ".local/bin/agy"),
      "/opt/homebrew/bin/agy",
      "/usr/local/bin/agy",
    ],
  },
  "grok-cli-image": {
    name: "grok",
    extra: [
      ...(process.env.AGENTLAS_GROK_BIN?.trim() ? [process.env.AGENTLAS_GROK_BIN.trim()] : []),
      path.join(os.homedir(), ".grok/bin/grok"),
      path.join(os.homedir(), ".local/bin/grok"),
      path.join(os.homedir(), ".bun/bin/grok"),
      "/opt/homebrew/bin/grok",
      "/usr/local/bin/grok",
    ],
  },
  "grok-cli-video": {
    name: "grok",
    extra: [
      ...(process.env.AGENTLAS_GROK_BIN?.trim() ? [process.env.AGENTLAS_GROK_BIN.trim()] : []),
      path.join(os.homedir(), ".grok/bin/grok"),
      path.join(os.homedir(), ".local/bin/grok"),
      path.join(os.homedir(), ".bun/bin/grok"),
      "/opt/homebrew/bin/grok",
      "/usr/local/bin/grok",
    ],
  },
};

function resolveBin(name: string, extra: string[]): string | null {
  const fromPath = (process.env.PATH || "").split(":").filter(Boolean).map((d) => path.join(d, name));
  for (const c of [...extra, ...fromPath]) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * grok CLI 인증 가용성 — 공식 xAI CLI(grok 0.2.x) 실측 기준.
 *  주 경로: 구독 OAuth 로그인(`grok login`) → ~/.grok/auth.json 에 OIDC 토큰(access+refresh) 저장.
 *           auth_mode "oidc" 이고 만료 안 됐거나 refresh_token 이 있으면 ready(CLI가 자동 갱신).
 *  폴백: GROK_API_KEY(=XAI_API_KEY) env / 앱 볼트(spawn 시 주입) / user-settings.json apiKey.
 *  ⚠ 예전 superagent-ai grok-cli(v1.x)는 API 키만 썼지만, x.ai/cli/install.sh 공식 CLI는 OAuth 우선.
 */
export type GrokAuthSource = "oauth" | "api-key" | "unavailable";

export async function grokAuthSource(): Promise<GrokAuthSource> {
  if (grokOAuthReady()) return "oauth";
  try {
    if (await hasEnvVar("XAI_API_KEY")) return "api-key";
    if (await hasEnvVar("GROK_API_KEY")) return "api-key";
  } catch {
    // A locked or temporarily unavailable OS vault means the API-key-backed
    // provider is not ready. It must not make an unrelated text run fail.
  }
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".grok/user-settings.json"), "utf8");
    const settings = JSON.parse(raw) as { apiKey?: unknown };
    if (typeof settings.apiKey === "string" && settings.apiKey.trim()) return "api-key";
  } catch {
    /* 설정 없음 */
  }
  return "unavailable";
}

export async function grokAuthReady(): Promise<boolean> {
  return (await grokAuthSource()) !== "unavailable";
}

/** ~/.grok/auth.json 에 유효한 OIDC 로그인이 있나? (access 미만료 또는 refresh_token 보유) */
export function grokOAuthReady(
  authPath = process.env.AGENTLAS_GROK_AUTH_FILE || path.join(os.homedir(), ".grok/auth.json"),
  now = Date.now(),
): boolean {
  try {
    const raw = fs.readFileSync(authPath, "utf8");
    const store = JSON.parse(raw) as Record<string, unknown>;
    for (const entry of Object.values(store)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { auth_mode?: unknown; refresh_token?: unknown; expires_at?: unknown; key?: unknown; oidc_issuer?: unknown };
      const isOidc = e.auth_mode === "oidc" || (typeof e.oidc_issuer === "string" && typeof e.key === "string");
      if (!isOidc) continue;
      // refresh_token 이 있으면 access 만료돼도 CLI가 갱신하므로 ready.
      if (typeof e.refresh_token === "string" && e.refresh_token.trim()) return true;
      // refresh 없으면 access 만료 전까지만 ready.
      if (typeof e.expires_at === "string") {
        const exp = Date.parse(e.expires_at);
        if (Number.isFinite(exp) && exp > now) return true;
      }
    }
  } catch {
    /* 로그인 안 됨/파싱 실패 */
  }
  return false;
}

/** 이 provider가 지금 바로 쓸 수 있나? (키리스=bin 존재 / 키필요=키 전부 존재) */
export async function isProviderReady(provider: MultimodalProvider): Promise<boolean> {
  const cli = CLI_BINS[provider.id];
  if (cli) {
    if (!resolveBin(cli.name, cli.extra)) return false;
    if (provider.id === "grok-cli-image" || provider.id === "grok-cli-video") {
      // These catalog rows promise subscription-backed execution. An API key
      // must not silently turn that promise into metered API billing.
      return (await grokAuthSource()) === "oauth";
    }
    return true;
  }
  // 나노바나나는 agy 키리스가 우선이지만 GEMINI_API_KEY 폴백도 허용(trex와 동일).
  if (provider.envKeys.length === 0) return true; // 키 불필요 엔진(이론상 CLI 미등록)
  try {
    const checks = await Promise.all(provider.envKeys.map((key) => hasEnvVar(key)));
    return checks.every(Boolean);
  } catch {
    // Provider availability is optional execution context. Treat a locked or
    // unavailable credential vault exactly like a missing key so plain text
    // conversations and local subscription runtimes can continue.
    return false;
  }
}

export interface ResolvedProvider {
  /** 확정된 엔진. auto인데 가용한 게 하나도 없으면 null. */
  provider: MultimodalProvider | null;
  ready: boolean;
  /** "explicit" = 사용자가 직접 고름, "auto" = 사다리에서 자동 선택. */
  via: "explicit" | "auto";
}

/**
 * 지정된(또는 auto) provider를 실제 가용성 기준으로 확정한다.
 *  - 명시 선택: 그 provider 그대로 반환(+ready 여부). 사용자의 의도를 존중.
 *  - "auto": 사다리(키리스 우선)에서 처음으로 ready인 것을 고른다. 없으면 provider=null, ready=false.
 */
export async function resolveActiveProvider(
  modality: MultimodalModality,
  settings: MultimodalSettings,
): Promise<ResolvedProvider> {
  const selected =
    modality === "image"
      ? settings.imageProvider
      : modality === "video"
        ? settings.videoProvider
        : settings.audioProvider;

  if (selected && selected !== AUTO_PROVIDER) {
    const provider = getMultimodalProvider(selected);
    if (provider) return { provider, ready: await isProviderReady(provider), via: "explicit" };
  }

  // auto (또는 알 수 없는 값): 사다리를 키리스-우선 순서로 걸어 첫 ready를 채택.
  for (const provider of providerLadder(modality)) {
    if (await isProviderReady(provider)) {
      return { provider, ready: true, via: "auto" };
    }
  }
  return { provider: null, ready: false, via: "auto" };
}
