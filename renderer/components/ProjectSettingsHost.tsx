"use client";

import { useEffect, useState } from "react";
import { PROJECT_SETTINGS_EVENT, type ProjectSettingsRequest } from "@/lib/project-settings";
import { navigate } from "@/lib/navigation";
import { ProjectSettingsModal } from "./ProjectSettingsModal";

export function ProjectSettingsHost() {
  const [request, setRequest] = useState<(ProjectSettingsRequest & { key: number }) | null>(null);
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
  return request ? <ProjectSettingsModal key={request.key} request={request}
    onClose={() => setRequest(null)}
    onSaved={(project) => {
      setRequest(null);
      if (request.mode === "create") navigate(`/project/detail?id=${encodeURIComponent(project.id)}`);
    }} /> : null;
}
