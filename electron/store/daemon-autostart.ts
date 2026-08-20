// 데몬 자동 시작 설정 — meta 테이블 단일 키, 기본 **off**.
//
// ★계약: 앱 첫 기동이 자동 시작을 조용히 설치하는 일은 없다. 사용자 머신의 부팅
// 동작(launchd/시작프로그램/systemd)은 이 값이 명시적으로 켜졌을 때만 바뀐다.
// 배선: main.ts 부팅 경로가 이 값을 읽어 daemon/app-launcher.ts 의
// reconcileDaemonAutostart 로 파일시스템과 정합시킨다(켜짐 → 설치, 꺼짐 → 제거).
//
// TODO(설정 UI): 대시보드/설정 화면 토글은 아직 없다. 토글이 생기면 이 두 함수를
// IPC 로 노출하고, setDaemonAutostartEnabled 직후 reconcileDaemonAutostart 를 다시
// 불러야 한다(설정과 부팅 동작이 다음 재시작까지 어긋난 채 남지 않도록).
import { getMeta, setMeta } from "./meta";

export const DAEMON_AUTOSTART_META_KEY = "daemon_autostart";

/** 켜짐은 정확히 "1" 만 인정한다 — 없는 값·이상한 값은 전부 off(보수적 기본). */
export function getDaemonAutostartEnabled(): boolean {
  return getMeta(DAEMON_AUTOSTART_META_KEY) === "1";
}

export function setDaemonAutostartEnabled(enabled: boolean): void {
  setMeta(DAEMON_AUTOSTART_META_KEY, enabled ? "1" : "0");
}
