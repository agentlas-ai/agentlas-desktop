// 캡처 정본 저장소 — 채팅에 보이는 캡처는 반드시 디스크에 실물이 있어야 한다.
//
// 배경(2026-08-18 오너 제보): 채팅의 화면 캡처가 "빈 이미지"로 렌더되고 원본 파일이
// 아예 없었다. 원인은 캡처 파이프라인 어디에도 파일을 남기는 곳이 없었기 때문이다:
//  - computer-use get_screen 은 base64 인라인만 반환(정본 0개),
//  - playwright/agentlas-browser 스크린샷은 os.tmpdir() 기본 출력 폴더(리핑됨 + 서빙 불가).
// 모델이 답변에 캡처 경로를 참조하는 순간 agentlas://localfile 이 404를 내고
// 렌더러는 빈 박스를 그렸다.
//
// 이 모듈이 그 정본의 단일 홈이다: ~/.agentlas/captures/{screen,browser}.
// agentlas://localfile 의 허용 루트(fs/access.ts)에 이 루트가 포함되어
// One·Work 두 채팅 표면 모두 같은 절대경로로 렌더할 수 있다.
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

/** playwright/agentlas-browser 스크린샷 출력 폴더(--output-dir 로 전달). */
export function browserCaptureDir(): string {
  return path.join(captureArtifactsRoot(), "browser");
}

/** 브라우저 MCP --output-max-size 값(바이트) — playwright 가 스스로 오래된 파일을 비운다. */
export const BROWSER_CAPTURE_MAX_BYTES = 256 * 1024 * 1024;

const MAX_CAPTURE_FILES = 300;
const DATA_URL_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/;

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
    pruneCaptureDir(dir);
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
    const dir = browserCaptureDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = mediaType === "image/png" ? ".png" : ".jpg";
    const filePath = path.join(dir, `browser-${stamp}-${randomUUID().slice(0, 8)}${ext}`);
    fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"), { mode: 0o600 });
    pruneCaptureDir(dir);
    return filePath;
  } catch {
    return null;
  }
}

/** 파일 수 상한으로 무한 성장 방지 — 가장 오래된 것부터 지운다(정리 실패는 무해). */
function pruneCaptureDir(dir: string): void {
  try {
    const entries = fs
      .readdirSync(dir)
      .filter((name) => /\.(png|jpg)$/.test(name))
      .map((name) => {
        const full = path.join(dir, name);
        try {
          return { full, mtimeMs: fs.statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { full: string; mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of entries.slice(MAX_CAPTURE_FILES)) {
      try {
        fs.rmSync(entry.full, { force: true });
      } catch {
        // 남은 파일은 다음 저장 때 다시 시도된다.
      }
    }
  } catch {
    // 폴더가 없거나 읽기 실패 — 저장 경로가 이미 성공했으므로 무시.
  }
}
