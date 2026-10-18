// 캡처 정본 저장소 — 채팅에 보이는 캡처는 반드시 디스크에 실물이 있어야 한다.
//
// 배경(2026-08-18 오너 제보): 채팅의 화면 캡처가 "빈 이미지"로 렌더되고 원본 파일이
// 아예 없었다. 원인은 캡처 파이프라인 어디에도 파일을 남기는 곳이 없었기 때문이다:
//  - computer-use get_screen 은 base64 인라인만 반환(정본 0개),
//  - playwright/agentlas-browser 스크린샷은 os.tmpdir() 기본 출력 폴더(리핑됨 + 서빙 불가).
// 모델이 답변에 캡처 경로를 참조하는 순간 agentlas://localfile 이 404를 내고
// 렌더러는 빈 박스를 그렸다.
//
// 이 모듈이 그 정본의 단일 홈이다: ~/.agentlas/captures/{screen,browser-saved}.
// agentlas://localfile 의 허용 루트(fs/access.ts)에 이 루트가 포함되어
// One·Work 두 채팅 표면 모두 같은 절대경로로 렌더할 수 있다.
// 정본은 자동으로 지우지 않는다(오너 D13 영구 보관, docs native-harness 21 G6): 예전의 300개 상한 삭제는
// 대화에 붙은 옛 캡처를 빈 상자로 만들었다.
//
// captures/browser 는 정본 폴더가 아니다. @playwright/mcp 의 --output-dir 이고 --output-max-size
// 예산이 걸려 Playwright 가 넘칠 때마다 그 폴더 전체(하위 포함)에서 오래된 파일부터 지운다.
// 2026-10-18 운영에서 유튜브 업로드 하드링크(uploads/, 약 245MB)가 예산을 채워 그 안의
// 정본 브라우저 캡처 112개가 모두 지워졌다(One 카드 file_missing). 정본은 그 폴더 밖에 둔다.
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
