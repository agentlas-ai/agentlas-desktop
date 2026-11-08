"use client";

import { useEffect, useRef, useState } from "react";
import { PROJECT_SETTINGS_EVENT, type ProjectSettingsRequest } from "@/lib/project-settings";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import dynamic from "next/dynamic";
import styles from "./ProjectSettingsModal.module.css";

const ProjectSettingsModal = dynamic(() => import("./ProjectSettingsModal").then((module) => module.ProjectSettingsModal), { ssr: false });

export function ProjectSettingsHost({ onVisibilityChange }: { onVisibilityChange: (open: boolean) => void }) {
  const { locale } = useT();
  const [request, setRequest] = useState<(ProjectSettingsRequest & { key: number }) | null>(null);
  const [backgroundError, setBackgroundError] = useState("");
  const [nextRequest, setNextRequest] = useState<ProjectSettingsRequest | null>(null);
  const active = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const visibility = useRef(onVisibilityChange);
  visibility.current = onVisibilityChange;
  function close() {
    active.current = false;
    setNextRequest(null);
    setRequest(null);
    visibility.current(false);
    const version = ++generation.current;
    requestAnimationFrame(() => {
      const target = opener.current;
      if (generation.current === version && target?.isConnected && !target.closest("[hidden]")) target.focus();
    });
  }
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<ProjectSettingsRequest>).detail;
      if (detail?.mode === "create" || (detail?.mode === "edit" && detail.projectId)) {
        if (active.current) {
          setNextRequest(detail);
          return;
        }
        active.current = true;
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        generation.current += 1;
        visibility.current(true);
        setRequest({ ...detail, key: generation.current });
      }
    };
    window.addEventListener(PROJECT_SETTINGS_EVENT, open);
    return () => window.removeEventListener(PROJECT_SETTINGS_EVENT, open);
  }, []);
  return <>
    {nextRequest && request ? <div className={styles.switchNotice} role="status">
      <span>{locale === "ko" ? "다른 프로젝트 설정을 열까요? 현재 입력은 저장되지 않을 수 있습니다." : "Open the other project settings? Your current entries may not be saved."}</span>
      <button type="button" onClick={() => setNextRequest(null)}>{locale === "ko" ? "계속 편집" : "Keep editing"}</button>
      <button type="button" onClick={() => { generation.current += 1; setRequest({ ...nextRequest, key: generation.current }); setNextRequest(null); }}>{locale === "ko" ? "전환" : "Switch"}</button>
    </div> : null}
    {request ? <ProjectSettingsModal key={request.key} request={request}
      onClose={close}
      onBackgroundError={setBackgroundError}
      onSaved={(project) => {
        close();
        if (request.mode === "create") navigate(`/project/detail?id=${encodeURIComponent(project.id)}`);
      }} /> : null}
    {backgroundError ? <div className={styles.backgroundError} role="alert">
      <span>{backgroundError}</span>
      <button type="button" onClick={() => setBackgroundError("")} aria-label={locale === "ko" ? "알림 닫기" : "Dismiss notification"}>×</button>
    </div> : null}
  </>;
}
