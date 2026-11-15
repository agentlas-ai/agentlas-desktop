"use client";

import { useEffect, useRef } from "react";
import { readViewData } from "@/lib/view-data-cache";
import { recallHomeSnapshot } from "@/lib/home-tree";
import { onNewChatRequest } from "@/lib/new-chat-request";
import { openNewChatStart } from "@/lib/new-chat-start";
import { navigate } from "@/lib/navigation";
import { useFocusedSpaceChatId } from "@/lib/space-store";
import type { Project } from "@/lib/types";

/**
 * Answers a New chat request (lib/new-chat-request) by opening the start screen in the Workspace (F-D6; before it opened the New agent chat dialog).
 * "current" is read from what is already in memory - the focused pane's chat in the last list snapshot and the project list the list already
 * holds - so asking costs no read. The project of nothing on screen is none, which the start screen draws as "Empty project"; the last project
 * used is never the default.
 */
export function NewChatHost(_props: { locale: "ko" | "en" }) {
  const focused = useFocusedSpaceChatId();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  useEffect(() => onNewChatRequest((request) => {
    const projects = readViewData<Project[]>("dashboard.projects")?.value ?? [];
    const nameOf = (id: string | null) => (id ? projects.find((project) => project.id === id)?.name ?? null : null);
    let projectId: string | null;
    if (request.projectId !== "current") projectId = request.projectId;
    else {
      const row = focusedRef.current ? recallHomeSnapshot()?.rows.find((item) => item.id === focusedRef.current) : undefined;
      projectId = row?.projectId ?? null; // a project that no longer exists is dropped by the start screen once it has read the project list
    }
    openNewChatStart({ projectId, projectName: request.projectName ?? nameOf(projectId) });
    if (typeof window !== "undefined" && window.location.pathname.replace(/\/+$/, "") !== "/workspace") navigate("/workspace");
  }), []);
  return null;
}
