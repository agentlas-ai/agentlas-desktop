"use client";

import { usePathname } from "next/navigation";
import { navigate } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
import { rulesCopy } from "./copy";
import { IconListCheck } from "./icons";

/** The last row of Workspace's left list (picture desktop-final-pieces A): opens "My rules". */
export function WorkspaceRulesRow() {
  const { locale } = useT();
  const pathname = usePathname() ?? "";
  const active = pathname.startsWith("/workspace/rules");
  return (
    <button type="button" className="project-sidebar-rules" data-workspace-rules-row="true" data-active={active ? "true" : "false"} aria-current={active ? "page" : undefined}
      onClick={() => navigate("/workspace/rules")}>
      <IconListCheck size={16} />{rulesCopy(locale === "ko" ? "ko" : "en").sidebarRow}
    </button>
  );
}
