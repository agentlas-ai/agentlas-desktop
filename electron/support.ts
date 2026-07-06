// 버그 신고 — main 프로세스에서 세션 쿠키로 웹(agentlas.cloud) 버그 신고 API를 호출한다.
// prompts-hub.ts / billing.ts와 동일 패턴: agentlas_session 쿠키 재첨부 + 변이(POST)는
// CSRF 미들웨어의 same-origin 가드를 통과하도록 Origin 헤더를 사이트 오리진으로 보낸다.
// 신고는 웹 API가 MongoDB(collection "bug_reports")에 적재한다. 로그인은 선택이지만
// 데스크탑은 보통 로그인 상태라 신고자(userId/workspace/email)가 서버에서 자동 첨부된다.
import { app } from "electron";
import { getSessionCookieHeader, webBaseUrl } from "./auth";
import type { BugReportInput, BugReportResult } from "../shared/types";

const TIMEOUT_MS = 10_000;

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** POST /api/bug-report — 신고 본문 + 앱 컨텍스트(버전/플랫폼/페이지/로케일)를 함께 보낸다. */
export async function submitBugReport(input: BugReportInput): Promise<BugReportResult> {
  const message = (input?.message ?? "").trim();
  if (!message) return { ok: false, code: "message_required" };

  const base = webBaseUrl();
  const cookie = getSessionCookieHeader();
  const headers: Record<string, string> = { "content-type": "application/json", origin: base };
  if (cookie) headers.cookie = cookie;

  const payload = {
    message,
    title: (input.title ?? "").trim() || undefined,
    severity: input.severity ?? "medium",
    email: (input.email ?? "").trim() || undefined,
    appVersion: app.getVersion(),
    platform: `${process.platform} ${process.arch}`,
    page: (input.page ?? "").trim() || undefined,
    locale: (input.locale ?? "").trim() || undefined,
  };

  try {
    const res = await timedFetch(`${base}/api/bug-report`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        code: typeof json.code === "string" ? json.code : `http_${res.status}`,
        error: typeof json.error === "string" ? json.error : undefined,
      };
    }
    return { ok: true, id: typeof json.id === "string" ? json.id : undefined };
  } catch {
    return { ok: false, code: "network" };
  }
}
