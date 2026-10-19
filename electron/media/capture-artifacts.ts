


















import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** 캡처 정본 루트 — agentlas://localfile 허용 목록과 반드시 함께 움직인다. */
export function captureArtifactsRoot(): string {
  return path.join(os.homedir(), ".agentlas", "captures");
}

/** computer-use(전체 화면) 캡처 정본 폴더. */
export function screenCaptureDir(): string {
  return path.join(captureArtifactsRoot(), "screen");
}

/** playwright/agentlas-browser 출력 폴더(--output-dir 로 전달). Playwright 가 예산을 넘으면 지운다. */
export function browserCaptureDir(): string {
  return path.join(captureArtifactsRoot(), "browser");
}

/** 브라우저 도구가 인라인으로 돌려준 스크린샷의 정본 폴더 — Playwright 출력 예산 밖. */
export function savedBrowserCaptureDir(): string {
  return path.join(captureArtifactsRoot(), "browser-saved");
}

const DATA_URL_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/;

/**
 * 앱 기능(app.call)이 답한 이미지의 관측 폴더(app-control/service.ts saveResultImages). 모델이 본 관측일 뿐 실행 산출물도
 * 채팅 이미지도 아니다 — 정산된 실행의 도구 호출 상세와 같은 기간(오너 결정 2026-10-16, 3일) 뒤 저장 공간 패스가 지운다
 * (storage-maintenance.ts pruneObservationCaptures). 위의 정본 폴더(screen·browser-saved)와 섞지 않는다.
 */
export function observationCaptureDir(): string {
  return path.join(captureArtifactsRoot(), "observations");
}

/** 관측 이미지 dataUrl 을 관측 폴더에 저장하고 절대경로를 반환한다. 실패는 null(호출자는 잘린 문자열 대신 원래 값을 둔다). */
export function saveObservationCaptureArtifact(dataUrl: string | null | undefined): string | null {
  if (typeof dataUrl !== "string") return null;
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return null;
  try {
    const dir = observationCaptureDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(dir, `observation-${stamp}-${randomUUID().slice(0, 8)}${match[1] === "png" ? ".png" : ".jpg"}`);
    fs.writeFileSync(filePath, Buffer.from(match[2], "base64"), { mode: 0o600 });
    return filePath;
  } catch {
    return null;
  }
}

/**
 * 화면 캡처 dataUrl을 정본 PNG/JPG로 저장하고 절대경로를 반환한다.
 * 저장 실패는 캡처 자체를 막지 않는다(경로 없이 base64 인라인만 반환) — null.
 */
export function saveScreenCaptureArtifact(dataUrl: string | null | undefined): string | null {
  if (typeof dataUrl !== "string") return null;
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return null;
  try {
    const dir = screenCaptureDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = match[1] === "png" ? ".png" : ".jpg";
    const filePath = path.join(dir, `screen-${stamp}-${randomUUID().slice(0, 8)}${ext}`);
    fs.writeFileSync(filePath, Buffer.from(match[2], "base64"), { mode: 0o600 });
    return filePath;
  } catch {
    return null;
  }
}

/**
 * 브라우저 MCP 가 인라인 base64 로 돌려준 스크린샷을 정본 파일로 남기고 절대경로를 반환한다.
 *
 * 배경(2026-09-03 실측): "이 사이트 화면 한 장 찍어줘" 를 실행하면 도구는 이미지를
 * 돌려주고 모델도 그 이미지를 보는데, 저장하는 곳이 없어 사용자에게는 아무것도 남지
 * 않았다(산출물 0 · 레일 이미지 0 · 채팅 이미지 0). 이 모듈 상단이 브라우저 캡처 폴더를
 * 이미 정본으로 선언해 두었으나 거기에 쓰는 함수가 없었다.
 *
 * 저장 실패는 도구 호출 자체를 막지 않는다 — 경로 없이 null.
 */
export function saveBrowserCaptureArtifact(
  mediaType: "image/png" | "image/jpeg",
  base64Data: string | null | undefined,
): string | null {
  if (typeof base64Data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(base64Data)) return null;
  try {
    const dir = savedBrowserCaptureDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = mediaType === "image/png" ? ".png" : ".jpg";
    const filePath = path.join(dir, `browser-${stamp}-${randomUUID().slice(0, 8)}${ext}`);
    fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"), { mode: 0o600 });
    return filePath;
  } catch {
    return null;
  }
}
