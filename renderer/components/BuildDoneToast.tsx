"use client";
// 빌드 완료 글로벌 토스트 — 사용자가 대시보드 등 다른 화면에 있어도 빌드가 끝나면
// (1) OS 알림 + (2) 우하단 팝업 카드로 알리고, 그 자리에서 클라우드/허브 업로드와
// 조직도 이동을 바로 실행할 수 있게 한다. 버튼은 여러 번 눌러도 된다(재업로드 허용).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { subscribe as buildSubscribe, getSnapshot as getBuildSnapshot } from "@/lib/build-session";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
import { IconBuilding, IconCheck, IconStore } from "@/components/Icon";

export function BuildDoneToast() {
  const s = useSyncExternalStore(buildSubscribe, getBuildSnapshot, getBuildSnapshot);
  const pathname = usePathname() ?? "/";
  const { locale } = useT();
  const ko = locale === "ko";
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const prevPhase = useRef(s.phase);

  useEffect(() => {
    if (prevPhase.current !== "done" && s.phase === "done" && s.result) {
      const name = s.result.workspace.split("/").pop() || "package";
      // 빌드 화면을 보고 있으면 화면 자체가 결과를 보여주므로 팝업은 생략.
      if (!pathname.startsWith("/build")) {
        setMsg(null);
        setOpen(true);
      }
      try {
        new Notification(ko ? "빌드 완료" : "Build complete", {
          body: ko ? `${name} 패키지가 준비됐습니다.` : `The ${name} package is ready.`,
        });
      } catch {
        // OS가 알림을 막아도 인앱 팝업은 뜬다.
      }
    }
    prevPhase.current = s.phase;
  }, [s.phase, s.result, pathname, ko]);

  if (!open || s.phase !== "done" || !s.result) return null;
  const workspace = s.result.workspace;
  const name = workspace.split("/").pop() || "package";

  const upload = async (visibility: "private-link" | "marketplace") => {
    const label = visibility === "marketplace" ? (ko ? "허브" : "Hub") : (ko ? "클라우드" : "Cloud");
    setBusy(true);
    setMsg(ko ? `${label} 업로드 중…` : `Uploading to ${label}…`);
    try {
      const res = await ipc()?.hephaestus.publish({ folder: workspace, visibility });
      const raw = res?.error ?? res?.stderr ?? "";
      setMsg(
        res?.ok
          ? ko ? `${label} 업로드 완료` : `Uploaded to ${label}`
          : (ko ? `${label} 업로드 실패: ` : `${label} upload failed: `) + String(raw).slice(0, 140),
      );
    } catch (e) {
      setMsg((ko ? `${label} 업로드 실패: ` : `${label} upload failed: `) + String(e).slice(0, 140));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="build-done-toast titlebar-nodrag" role="status">
      <div className="build-done-toast-head">
        <span className="build-done-toast-check"><IconCheck size={14} /></span>
        <strong>{ko ? "빌드 완료" : "Build complete"}</strong>
        <button type="button" className="build-done-toast-x" aria-label={ko ? "닫기" : "Dismiss"} onClick={() => setOpen(false)}>
          ✕
        </button>
      </div>
      <div className="build-done-toast-name" title={workspace}>{name}</div>
      <div className="build-done-toast-actions">
        <button type="button" disabled={busy} onClick={() => void upload("private-link")}>
          {ko ? "클라우드 업로드" : "Upload to Cloud"}
        </button>
        <button type="button" disabled={busy} onClick={() => void upload("marketplace")}>
          <IconStore size={12} /> {ko ? "허브 업로드" : "Upload to Hub"}
        </button>
        <button type="button" onClick={() => navigate("/library/agents")}>
          <IconBuilding size={12} /> {ko ? "조직도 열기" : "Open org chart"}
        </button>
      </div>
      {msg && <div className="build-done-toast-msg">{msg}</div>}
    </div>
  );
}
