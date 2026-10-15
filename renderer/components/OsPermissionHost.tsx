"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SystemPermissionKey, SystemPermissionNotice, SystemPermissionSnapshot } from "@shared/os-permissions";
import { useT } from "@/lib/i18n";
import { isSystemPermissionSnapshot, systemPermissions } from "@/lib/os-permissions";
import { OneBottomSheet, isTopmostModal } from "./one/OneBottomSheet";
import styles from "./OsPermissionHost.module.css";

const labels: Record<SystemPermissionKey, [string, string]> = {
  accessibility: ["컴퓨터 조작", "Computer control"],
  screen: ["화면 기록", "Screen recording"],
  microphone: ["마이크", "Microphone"],
  camera: ["카메라", "Camera"],
  automation: ["다른 앱 제어", "Control of other apps"],
  "browser-files": ["브라우저 파일 접근", "Browser file access"],
  keychain: ["키체인 접근", "Keychain access"],
};

function description(notice: SystemPermissionNotice, ko: boolean): string {
  if (notice.permission === "screen" && notice.platform === "win32") return ko
    ? "화면 캡처를 완료하지 못했습니다. 현재 권한 상태는 확인되지 않았습니다. 필요하면 Windows 화면 캡처 설정을 확인한 뒤 다시 시도해 주세요."
    : "Screen capture could not be completed. The current permission state is unknown. If needed, review Windows screen capture settings and retry.";
  if (notice.permission === "browser-files") {
    if (notice.platform === "darwin") return ko
      ? "파일 접근이 거부되었습니다. macOS에서 현재 실행 중인 Agentlas의 파일 접근을 확인해 주세요. 환경에 따라 전체 디스크 접근 권한 설정을 확인해야 할 수 있습니다."
      : "File access was denied. Check file access for this running copy of Agentlas in macOS. Depending on your environment, Full Disk Access may need review.";
    return ko ? "브라우저 파일 접근이 거부되었습니다. 파일 접근 제한과 브라우저 상태를 확인해 주세요."
      : "Browser file access was denied. Check file access restrictions and the browser state.";
  }
  if (notice.permission === "keychain") return notice.platform === "darwin"
    ? ko ? "키체인 접근을 확인하지 못했습니다. macOS의 기본 키체인 요청이나 키체인 접근 앱에서 해당 항목의 접근을 확인해 주세요. 손쉬운 사용 권한과는 별개입니다."
      : "Keychain access could not be confirmed. Review the native macOS Keychain request or the item's access in Keychain Access. This is separate from Accessibility."
    : ko ? "보안 저장소 접근을 확인하지 못했습니다. 이 환경에서는 해당 macOS 키체인 설정을 열 수 없습니다."
      : "Secure storage access could not be confirmed. The macOS Keychain setting is unavailable on this system.";
  const name = labels[notice.permission][ko ? 0 : 1];
  return ko ? `${name} 권한이 확인되지 않아 이 기능을 계속할 수 없습니다. 현재 실행 중인 Agentlas의 권한을 확인해 주세요.`
    : `${name} permission is unavailable, so this feature cannot continue. Review permission for this running copy of Agentlas.`;
}

/** One application-root host. Main owns classification, episode deduplication and queue bounds. */
export function OsPermissionHost() {
  const { locale } = useT();
  const ko = locale === "ko";
  const titleId = useId();
  const descriptionId = useId();
  const [snapshot, setSnapshot] = useState<SystemPermissionSnapshot>({ revision: -1, notices: [] });
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [feedback, setFeedback] = useState<{ id: string; kind: "opened" | "failed" | "unresolved" | "check-failed" } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const revision = useRef(-1);
  const epoch = useRef(0);
  const dismissed = useRef(new Set<string>());
  const mounted = useRef(false);
  const busy = useRef<string | null>(null);
  const bridge = systemPermissions();
  const notice = snapshot.notices.find(item => !hidden.has(item.id)) ?? null;
  const currentId = useRef<string | null>(null);
  currentId.current = notice?.id ?? null;

  useEffect(() => {
    mounted.current = true;
    revision.current = -1;
    ++epoch.current;
    setSnapshot({ revision: -1, notices: [] });
    setBusyId(null);
    busy.current = null;
    const accept = (value: unknown) => {
      if (!mounted.current || !isSystemPermissionSnapshot(value) || value.revision <= revision.current) return;
      revision.current = value.revision;
      const present = new Set(value.notices.map(item => item.id));
      for (const id of dismissed.current) if (!present.has(id)) dismissed.current.delete(id);
      setHidden(new Set(dismissed.current));
      setSnapshot(value);
    };
    let active = true;
    const receive = (value: SystemPermissionSnapshot) => { if (active) accept(value); };
    // Live updates must be subscribed before the initial snapshot request.
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = bridge?.subscribe(receive);
      void bridge?.snapshot().then(receive).catch(() => { /* Bridge failure is not OS denial. */ });
    } catch { /* A stale/unavailable preload must not break the application root. */ }
    return () => { active = false; mounted.current = false; ++epoch.current; unsubscribe?.(); };
  }, [bridge]);

  const close = useCallback(() => {
    const id = currentId.current;
    if (!id) return;
    ++epoch.current;
    dismissed.current.add(id);
    setHidden(new Set(dismissed.current));
    busy.current = null;
    setBusyId(null);
    setFeedback(null);
    // Local dismissal never waits for IPC, settings, or the original operation.
    void bridge?.dismiss(id).catch(() => {});
  }, [bridge]);

  useEffect(() => {
    if (!notice) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const dialog = document.querySelector<HTMLElement>('[data-os-permission-dialog="true"]');
      if (!dialog || !isTopmostModal(dialog)) return;
      event.preventDefault();
      // Capture at window before legacy import dialogs' document Escape handlers.
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [notice?.id, close]);

  const act = async (kind: "settings" | "recheck") => {
    const id = currentId.current;
    if (!bridge || !id || busy.current === id) return;
    const operationEpoch = ++epoch.current;
    busy.current = id;
    setBusyId(id);
    setFeedback(null);
    const current = () => mounted.current && operationEpoch === epoch.current && currentId.current === id && !dismissed.current.has(id);
    try {
      if (kind === "settings") {
        const result = await bridge.openSettings(id);
        if (current()) setFeedback({ id, kind: result.ok ? "opened" : "failed" });
      } else {
        const result = await bridge.recheck(id);
        if (current()) {
          if (result.resolved) close();
          else setFeedback({ id, kind: "unresolved" });
        }
      }
    } catch {
      if (current()) setFeedback({ id, kind: kind === "settings" ? "failed" : "check-failed" });
    } finally {
      if (current()) { busy.current = null; setBusyId(null); }
    }
  };

  const message = feedback && notice && feedback.id === notice.id ? ({
    opened: ko ? "설정을 열었습니다. 권한이 허용되었는지는 다시 확인해 주세요." : "Settings opened. Check again to confirm whether permission was granted.",
    failed: ko ? "해당 설정을 열지 못했습니다. 시스템 설정에서 이 권한을 직접 확인해 주세요." : "This setting could not be opened. Review this permission in system settings.",
    unresolved: ko ? "권한이 아직 확인되지 않았습니다. 설정을 확인한 뒤 다시 확인할 수 있습니다." : "Permission is still unconfirmed. Review settings, then check again.",
    "check-failed": ko ? "현재 권한 상태를 확인하지 못했습니다." : "The current permission state could not be checked.",
  }[feedback.kind]) : null;
  const canOpen = notice?.canOpenSettings && !(notice.permission === "keychain" && notice.platform !== "darwin");

  return <OneBottomSheet open={Boolean(notice)} onClose={close} closeLabel={ko ? "닫기" : "Close"}
    size="compact" titleId={titleId} title={ko ? "시스템 권한 확인" : "Check system permission"}
    ariaDescribedBy={descriptionId} dataAttributes={{ "data-os-permission-dialog": "true" }}
    panelClassName="rd" footer={<div className={styles.actions}>
      {canOpen && <button type="button" className="btn" disabled={busyId === notice?.id} onClick={() => void act("settings")}>{ko ? "해당 설정 열기" : "Open this setting"}</button>}
      <button type="button" className="btn" disabled={busyId === notice?.id} onClick={() => void act("recheck")}>{ko ? "권한 다시 확인" : "Check permission again"}</button>
      <button type="button" className="btn primary" onClick={close}>{ko ? "닫기" : "Close"}</button>
    </div>}>
    {notice && <div className={styles.body}>
      <strong>{labels[notice.permission][ko ? 0 : 1]}</strong>
      <p id={descriptionId}>{description(notice, ko)}</p>
      <p className={styles.hint}>{ko ? "설정을 확인한 뒤 원래 화면에서 다시 시도해 주세요." : "After reviewing the setting, retry from the original screen."}</p>
      {message && <p className={styles.feedback} role="status" aria-live="polite">{message}</p>}
    </div>}
  </OneBottomSheet>;
}
