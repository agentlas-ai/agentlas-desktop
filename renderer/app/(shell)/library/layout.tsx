// 공용 레이아웃 — 상단 드래그 영역과 동적 타이틀을 제공합니다.
"use client";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n";

export default function LibraryLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const { t } = useT();

  let title = t("sidebar.library");
  // The agents page owns a two-pane layout (roster + detail) that scrolls each
  // pane independently. It must receive a height-bounded flex container, not an
  // outer scroll wrapper — otherwise the whole page scrolls as one unit and the
  // two panes move together. Every other library page has no inner scroll and
  // relies on this layout's outer scroll, so keep that for them.
  const ownsInnerScroll = pathname.startsWith("/library/agents");
  if (pathname.startsWith("/library/agents")) title = t("nav.agent");
  else if (pathname.startsWith("/library/agent-groups")) title = t("nav.agent_group");
  else if (pathname.startsWith("/library/env")) title = t("nav.env_keys");
  else if (pathname.startsWith("/library/mcps")) title = t("nav.mcp_tools");

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "transparent", overflow: "hidden" }}>
      <header
        className="titlebar-drag glass-thin"
        style={{
          padding: "16px 32px 16px",
          borderBottom: "1px solid var(--glass-border)",
          minHeight: 56,
          display: "flex",
          alignItems: "center"
        }}
      >
        <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 17, fontWeight: 700 }}>
          {title}
        </h1>
      </header>
      <div
        style={
          ownsInnerScroll
            ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }
            : { flex: 1, overflowY: "auto" }
        }
      >
        {children}
      </div>
    </div>
  );
}
