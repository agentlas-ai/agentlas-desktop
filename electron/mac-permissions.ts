// macOS 권한(접근성/화면기록) preflight — 컴퓨터유즈(CUA) 자동화가 권한 부재로
// "부분 실행 후 먹통"되는 걸 막는다. 권한이 없으면 실행 전에 빠르게 감지해
// 대기 상태로 스킵하고(다음 예약에 자동 재시도) 사용자에게 정확한 조치를 안내한다.
import { systemPreferences } from "electron";
import { currentUiLocale } from "./ui-locale";
import { reportSystemPermissionIssue } from "./os-permission-guidance";
import type { SystemPermissionFeature } from "../shared/os-permissions";

export interface MacPermissionState {
  accessibility: boolean;
  screenRecording: boolean;
  /** 컴퓨터유즈에 필수인 접근성 권한이 있는가. */
  ok: boolean;
  /** 사용자에게 보여줄 부족 권한 라벨. */
  missing: string[];
}

/**
 * 컴퓨터유즈에 필요한 macOS 권한 상태.
 * - 접근성(Accessibility): 필수 — 없으면 마우스/키보드 제어 불가 → ok=false.
 * - 화면기록(Screen Recording): 필수 — granted일 때만 화면 접근을 확인한다.
 *   denied/restricted/미확인 상태를 실행 가능으로 바꾸지 않는다.
 * darwin이 아니면 항상 ok(권한 개념 없음).
 */
export function checkComputerUsePermissions(): MacPermissionState {
  if (process.platform !== "darwin") {
    return { accessibility: true, screenRecording: true, ok: true, missing: [] };
  }
  let accessibility = true;
  let screenRecording = true;
  try {
    // prompt=false — 시스템 팝업을 띄우지 않고 조용히 상태만 읽는다(안내는 앱이 직접 한다).
    accessibility = systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    accessibility = false; // Unknown is not evidence that input is permitted.
  }
  try {
    screenRecording = systemPreferences.getMediaAccessStatus("screen") === "granted";
  } catch {
    screenRecording = false;
  }
  const missing: string[] = [];
  const ko = currentUiLocale() === "ko";
  if (!accessibility) missing.push(ko ? "손쉬운 사용(Accessibility)" : "Accessibility");
  if (!screenRecording) missing.push(ko ? "화면 기록(Screen Recording)" : "Screen Recording");
  return { accessibility, screenRecording, ok: accessibility && screenRecording, missing };
}

/** Call on an attempted operation, never from passive status reads. */
export function reportComputerUsePermissionIssues(state: MacPermissionState, feature: SystemPermissionFeature = "computer-use"): void {
  if (process.platform !== "darwin") return;
  if (!state.accessibility) reportSystemPermissionIssue("accessibility", feature);
  if (!state.screenRecording) reportSystemPermissionIssue("screen", feature);
}
