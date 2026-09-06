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
import { buildScanDisposition } from "@/lib/build-scan";
import { IconBuilding, IconCheck, IconStore } from "@/components/Icon";

/**
 * The build page turns engine failures into instructions for a person.  This
 * toast can publish from any dashboard surface too, so it must not print the
 * raw CLI/HTTP body (which may contain status codes, JSON, or internal paths).
 */
function friendlyPublishFailure(raw: unknown, ko: boolean): string {
  const text = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : String(raw ?? "");
  const lower = text.toLowerCase();
  if (lower.includes("cancel") || lower.includes("취소")) {
    return ko ? "업로드를 취소했습니다." : "Upload cancelled.";
  }
  if (lower.includes("unauthorized") || lower.includes("not logged") || lower.includes("sign in") || /\b401\b/.test(lower)) {
    return ko
      ? "Agentlas 로그인이 필요합니다. 로그인한 뒤 같은 폴더로 다시 시도하세요."
      : "Sign in to Agentlas, then retry with the same folder.";
  }
  if (lower.includes("quota") || lower.includes("credit") || lower.includes("cloud_agent_limit_reached") || /\b402\b/.test(lower)) {
    return ko
      ? "계정 한도 또는 크레딧 상태를 확인한 뒤 다시 시도하세요."
      : "Check your account limit or credits, then retry.";
  }
  if (lower.includes("routing_card_required") || lower.includes("routing card")) {
    return ko
      ? "Hub 공개에 필요한 라우팅 카드가 없습니다. 패키지 정보를 보강한 뒤 다시 시도하세요."
      : "Hub publishing needs a routing card. Add the package metadata, then retry.";
  }
  if (lower.includes("unsafe_path") || lower.includes("unsafe path")) {
    return ko
      ? "패키지 밖을 가리키는 파일 경로가 있어 업로드를 멈췄습니다. 경로를 확인하세요."
      : "A file path escapes the package, so upload stopped. Check the package paths.";
  }
  if (lower.includes("manifest_missing") || lower.includes("agentlas.json")) {
    return ko
      ? "패키지 설명 파일을 읽을 수 없습니다. wizard/복구를 실행한 뒤 다시 시도하세요."
      : "The package manifest could not be read. Run the wizard/repair step, then retry.";
  }
  if (lower.includes("offline") || lower.includes("network") || lower.includes("enotfound") || lower.includes("fetch failed") || lower.includes("timed out") || lower.includes("timeout")) {
    return ko
      ? "네트워크 연결을 확인한 뒤 다시 시도하세요. 로컬 파일은 그대로입니다."
      : "Check the network and retry. Your local files are unchanged.";
  }
  if (
    lower.includes("maintenance")
    || lower.includes("service unavailable")
    || lower.includes("registration_commit_failed")
    || lower.includes("cloud_save_commit_failed")
    || lower.includes("workforce_projection_pending")
    || lower.includes("workforce_identity_missing")
    || lower.includes("base_release_materialization_failed")
    || /\b503\b/.test(lower)
  ) {
    return ko
      ? "Agentlas Cloud가 저장을 끝내지 못했습니다. 로컬 파일은 그대로이며 잠시 후 다시 시도하세요."
      : "Agentlas Cloud could not finish saving. Your local files are unchanged; try again shortly.";
  }
  return ko
    ? "Agentlas 쪽에서 업로드를 완료하지 못했습니다. 로컬 파일은 그대로이며 잠시 후 다시 시도하세요."
    : "Agentlas could not finish the upload. Your local files are unchanged; try again shortly.";
}

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
  const readScope = s.result.readScope;
  const scanDisposition = buildScanDisposition(s.result.securityScan);
  const hasSecurityAdvisory = scanDisposition !== "passed";
  const name = workspace.split("/").pop() || "package";

  const upload = async (visibility: "private-link" | "marketplace") => {
    const label = visibility === "marketplace" ? (ko ? "허브" : "Hub") : (ko ? "클라우드" : "Cloud");
    setBusy(true);
    setMsg(ko ? `${label} 업로드 중…` : `Uploading to ${label}…`);
    try {
      const res = await ipc()?.hephaestus.publish({ folder: workspace, scope: readScope, visibility });
      const raw = res?.error ?? res?.stderr ?? "";
      setMsg(
        res?.ok
          ? ko ? `${label} 업로드 완료` : `Uploaded to ${label}`
          : (ko ? `${label} 업로드 실패: ` : `${label} upload failed: `) + friendlyPublishFailure(raw, ko),
      );
    } catch (e) {
      setMsg((ko ? `${label} 업로드 실패: ` : `${label} upload failed: `) + friendlyPublishFailure(e, ko));
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
          {ko ? "Cloud에 비공개 저장" : "Save privately to Cloud"}
        </button>
        <button type="button" disabled={busy} onClick={() => void upload("marketplace")}>
          <IconStore size={12} /> {ko ? "허브 업로드" : "Upload to Hub"}
        </button>
        <button type="button" onClick={() => navigate("/library/agents")}>
          <IconBuilding size={12} /> {ko ? "조직도 열기" : "Open org chart"}
        </button>
      </div>
      {hasSecurityAdvisory && (
        <div className="build-done-toast-msg">
          {ko ? "안전 점검 결과는 참고용이며 설치·업로드를 막지 않습니다." : "Safety findings are advisory and do not block install or upload."}
        </div>
      )}
      {msg && <div className="build-done-toast-msg">{msg}</div>}
    </div>
  );
}
