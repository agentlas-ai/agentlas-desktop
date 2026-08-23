// 설치 비콘 — "누가 어떤 버전을 쓰고 있나"를 서버가 알게 한다.
//
// 배경(2026-08-23): 1.0.31·1.0.32 가 실행 즉시 죽는 채로 나갔을 때, 영향 범위를 물어보니
// 답할 근거가 GitHub 다운로드 횟수뿐이었다. 앱이 서버에 자기 버전을 보내지 않아서(User-Agent 가
// "agentlas-desktop/1.0" 고정) 사람·기기·버전을 어디에서도 셀 수 없었다.
//
// 계약:
//   · 기기마다 한 번 만든 installId(meta 표)로 식별한다. 계정이 있으면 서버가 쿠키로 붙인다.
//   · 창이 뜬 뒤 한 번, 그 다음은 6시간마다. 실패는 조용히 넘긴다(제품 기능이 아니다).
//   · 보내는 것은 버전·OS·아키텍처·채널뿐. 파일 경로·메모리·대화는 절대 싣지 않는다.
//   · 깨진 설치는 여기까지 못 온다. 그래서 "마지막으로 본 버전이 N 인데 그 뒤 침묵"이 곧 신호다.
import { app } from "electron";
import { randomUUID } from "node:crypto";
import { getMeta, setMeta } from "./store/meta";
import { getSessionCookieHeader, webBaseUrl } from "./auth";

export const INSTALL_ID_META_KEY = "install.id";
export const INSTALL_BEACON_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BEACON_TIMEOUT_MS = 8_000;

export type InstallBeaconPayload = {
  installId: string;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  channel: string;
  launchedAt: string;
};

export function installId(): string {
  const existing = getMeta(INSTALL_ID_META_KEY);
  if (existing) return existing;
  const fresh = randomUUID();
  setMeta(INSTALL_ID_META_KEY, fresh);
  return fresh;
}

export function installBeaconUserAgent(version = app.getVersion()): string {
  return `agentlas-desktop/${version} (${process.platform}; ${process.arch})`;
}

export function buildInstallBeacon(channel: string): InstallBeaconPayload {
  return {
    installId: installId(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    channel,
    launchedAt: new Date().toISOString(),
  };
}

/** 한 번 보낸다. 네트워크·서버 오류는 삼킨다 — 비콘 때문에 제품이 흔들리면 안 된다. */
export async function sendInstallBeacon(channel: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const payload = buildInstallBeacon(channel);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BEACON_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "user-agent": installBeaconUserAgent(payload.version),
      };
      const cookie = getSessionCookieHeader();
      if (cookie) headers.cookie = cookie;
      const res = await fetchImpl(`${webBaseUrl()}/api/desktop/beacon`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

let _timer: NodeJS.Timeout | null = null;

/** 창이 뜬 뒤 호출한다. 즉시 한 번, 이후 6시간마다. 두 번 불려도 타이머는 하나다. */
export function startInstallBeacon(channel: string): void {
  if (_timer) return;
  void sendInstallBeacon(channel);
  _timer = setInterval(() => void sendInstallBeacon(channel), INSTALL_BEACON_INTERVAL_MS);
  _timer.unref?.();
}
