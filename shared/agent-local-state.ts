// "이 컴퓨터에만 있는" 에이전트 상태를 가려내는 한 곳. 업로드 패키징, 작업공간 스냅샷, 정의 해시, 복원 걷기가 모두 이 함수를 읽는다.
// 목록 자체의 정본은 웹 카탈로그(upload-scan-catalog.json → shared/upload-scan-catalog.generated.ts)이고 여기서는 다시 적지 않는다.
// Electron 도 node 내장 모듈도 가져오지 않는다(데몬·Main·시험이 같은 파일을 읽는다).
import { AGENT_LOCAL_STATE_DIRECTORIES, AGENT_LOCAL_STATE_PATHS } from "./upload-scan-catalog.generated";

const STATE_DIRECTORIES = new Set<string>(AGENT_LOCAL_STATE_DIRECTORIES.map((name) => name.toLowerCase()));
const STATE_PATHS: string[][] = AGENT_LOCAL_STATE_PATHS.map((entry) => entry.toLowerCase().split("/").filter(Boolean));

function segmentsOf(relativePath: string): string[] {
  // macOS·Windows 의 기본 파일 시스템은 대소문자를 구분하지 않으므로 소문자로 비교한다(`.Agentlas-Local` 도 같은 폴더다).
  // Windows 는 이름 끝의 점·공백을 떼므로 `.agentlas-local.` 도 같은 폴더다.
  return relativePath.replace(/\\/g, "/").toLowerCase().split("/").map((part) => part.replace(/[. ]+$/, "")).filter((part) => part && part !== ".");
}

// 사진의 정본 자리는 `.agentlas-local/one-avatar.*` 이다. 폴더 맨 위에 남은 사진(다른 볼륨·잠김으로 옮기지 못했거나 상태 폴더에 더 새 사진이 이미 있는 경우)도 이 컴퓨터에만
// 있다 — 허브·클라우드 패키지·해시·스냅샷에 들지 않는다(decision, 감사 33-7). 맨 위(깊이 1)만: 패키지가 `docs/one-avatar.png` 를 담는 것은 사용자의 내용이다.
// 웹 카탈로그(upload-scan-catalog.json)에는 이 규칙이 아직 없다 — 웹 쪽 스캔과 같아지려면 거기에도 필요하다.
const TOP_LEVEL_PHOTO = /^one-avatar\.(?:png|jpe?g|webp)$/;

/** 이 상대 경로(파일이든 폴더든)가 에이전트 로컬 상태 안이거나 그 자체인가. 깊이 무관(맨 위 사진만 깊이 1). */
export function isAgentLocalStatePath(relativePath: string): boolean {
  const parts = segmentsOf(relativePath);
  if (parts.length === 1 && TOP_LEVEL_PHOTO.test(parts[0])) return true;
  if (parts.some((part) => STATE_DIRECTORIES.has(part))) return true;
  return STATE_PATHS.some((statePath) => {
    for (let start = 0; start + statePath.length <= parts.length; start += 1) {
      if (statePath.every((segment, offset) => parts[start + offset] === segment)) return true;
    }
    return false;
  });
}

/**
 * 이 폴더가 로컬 상태 경로의 윗길인가(예: `.agentlas` 는 `.agentlas/ledgers` 의 윗길). 엄격한 걷기(복원 검사)가
 * 패키지에 없는 `.agentlas` 폴더를 "모르는 폴더"로 거절하지 않고, 안에서 상태만 건너뛰게 하려고 쓴다.
 */
export function isAgentLocalStateAncestor(relativeDirectory: string): boolean {
  const parts = segmentsOf(relativeDirectory);
  if (parts.length === 0) return false;
  return STATE_PATHS.some((statePath) => {
    for (let length = 1; length < statePath.length; length += 1) {
      if (parts.length >= length && statePath.slice(0, length).every((segment, offset) => parts[parts.length - length + offset] === segment)) return true;
    }
    return false;
  });
}

/**
 * 패키지 파일 목록에서 이 컴퓨터에만 있는 상태 경로를 뺀 것. 패키지에 실려 온 상태(옛 업로드 묶음의 진화 원장 등)는 다른 컴퓨터의 것이므로
 * 디스크에 쓰지도, 디스크와 비교하지도 않는다. 무결성(해시·개수·마커)은 원래 목록으로 검증하고 디스크 쓰기와 비교에만 이 목록을 쓴다.
 */
export function withoutAgentLocalState<T extends { path: string }>(files: readonly T[]): T[] {
  return files.filter((file) => !isAgentLocalStatePath(file.path));
}
