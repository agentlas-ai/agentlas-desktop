"use client";

import { useEffect, useState } from "react";
import { PROJECT_SETTINGS_EVENT, type ProjectSettingsRequest } from "@/lib/project-settings";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { ProjectSettingsModal } from "./ProjectSettingsModal";
import styles from "./ProjectSettingsModal.module.css";

export function ProjectSettingsHost() {
  const { locale } = useT();
  const [request, setRequest] = useState<(ProjectSettingsRequest & { key: number }) | null>(null);
  const [backgroundError, setBackgroundError] = useState("");
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<ProjectSettingsRequest>).detail;
      if (detail?.mode === "create" || (detail?.mode === "edit" && detail.projectId)) {
        setRequest({ ...detail, key: Date.now() });
      }
    };
    window.addEventListener(PROJECT_SETTINGS_EVENT, open);
    return () => window.removeEventListener(PROJECT_SETTINGS_EVENT, open);
  }, []);
  return <>
    {request ? <ProjectSettingsModal key={request.key} request={request}
      onClose={() => setRequest(null)}
      onBackgroundError={setBackgroundError}
      onSaved={(project) => {
        setRequest(null);
        if (request.mode === "create") navigate(`/project/detail?id=${encodeURIComponent(project.id)}`);
      }} /> : null}
    {backgroundError ? <div className={styles.backgroundError} role="alert">
      <span>{backgroundError}</span>
      <button type="button" onClick={() => setBackgroundError("")} aria-label={locale === "ko" ? "알림 닫기" : "Dismiss notification"}>×</button>
    </div> : null}
  </>;
}
