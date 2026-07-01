// 렌더러가 넘기는 폴더 경로를 엔진으로 포워딩하기 전, 메인 프로세스 경계에서 검증한다.
// 컴프로마이즈/인젝션된 렌더러(또는 자유 입력)가 임의 디렉터리를 패키지/퍼블리시/스캔하지
// 못하게 막는다. (engine.ts 의 safeCwd 는 작업 디렉터리만 제한하므로 folder 인자 자체는 무방비)
//
// 방어:
//   1) 경로 검증: 반드시 존재하는 "디렉터리"의 realpath 여야 한다(없는 경로/파일/심볼릭 거부).
//   2) off-device 업로드(publish/package)는 사용자 확인 다이얼로그를 강제 — 해석된 절대경로 +
//      목적지(Cloud private-link vs Hub marketplace)를 보여주고 명시적 동의를 받는다.
//      렌더러가 조용히 임의 경로 업로드를 트리거할 수 없다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, dialog } from "electron";

export class PathGuardError extends Error {}

type Locale = "ko" | "en";

/** 존재하는 디렉터리인지 검증하고 realpath(심볼릭 해소) 절대경로를 반환. 아니면 throw. */
export function resolveFolderArg(folder: unknown, locale: Locale = "ko"): string {
  const ko = locale === "ko";
  if (typeof folder !== "string" || !folder.trim()) {
    throw new PathGuardError(ko ? "폴더 경로가 비어 있습니다." : "The folder path is empty.");
  }
  const raw = folder.trim();
  if (raw.startsWith("-")) {
    throw new PathGuardError(ko ? "폴더 경로가 옵션처럼 보입니다." : "The folder path looks like a CLI option.");
  }
  const abs = path.resolve(raw);
  let real: string;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    throw new PathGuardError(ko ? "폴더를 찾을 수 없습니다." : "Could not find the folder.");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new PathGuardError(ko ? "폴더 상태를 확인할 수 없습니다." : "Could not check the folder's status.");
  }
  if (!stat.isDirectory()) {
    throw new PathGuardError(ko ? "폴더(디렉터리)가 아닙니다." : "That path is not a directory.");
  }
  const highRiskRoots = new Set([
    path.parse(real).root,
    os.homedir(),
    path.dirname(os.homedir()),
    "/Applications",
    "/bin",
    "/etc",
    "/Library",
    "/private",
    "/System",
    "/usr",
    "/var",
  ]);
  if (highRiskRoots.has(real)) {
    throw new PathGuardError(
      ko
        ? "너무 넓은 시스템 폴더는 업로드할 수 없습니다. 에이전트 폴더를 선택해 주세요."
        : "System folders this broad can't be uploaded. Choose an agent folder instead.",
    );
  }
  return real;
}

/** off-device 업로드 전 사용자 확인. 거부 시 false. */
export async function confirmUpload(
  resolvedFolder: string,
  destination: "private-link" | "marketplace",
  win: BrowserWindow | null,
  locale: Locale = "ko",
): Promise<boolean> {
  const ko = locale === "ko";
  const destLabel = ko
    ? (destination === "marketplace" ? "Agentlas Hub (공개 마켓플레이스)" : "Agentlas Cloud (비공개 링크)")
    : (destination === "marketplace" ? "Agentlas Hub (public marketplace)" : "Agentlas Cloud (private link)");
  const opts = ko
    ? {
        type: "warning" as const,
        buttons: ["취소", "업로드"],
        defaultId: 0,
        cancelId: 0,
        title: "에이전트 업로드 확인",
        message: "이 폴더의 내용을 외부로 업로드합니다.",
        detail: `폴더:\n${resolvedFolder}\n\n대상: ${destLabel}\n\n이 폴더 안의 텍스트 파일 내용이 ${destLabel}로 전송됩니다. 계속하시겠습니까?`,
      }
    : {
        type: "warning" as const,
        buttons: ["Cancel", "Upload"],
        defaultId: 0,
        cancelId: 0,
        title: "Confirm agent upload",
        message: "This will upload the contents of this folder externally.",
        detail: `Folder:\n${resolvedFolder}\n\nDestination: ${destLabel}\n\nText file contents inside this folder will be sent to ${destLabel}. Continue?`,
      };
  const res = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  return res.response === 1;
}
