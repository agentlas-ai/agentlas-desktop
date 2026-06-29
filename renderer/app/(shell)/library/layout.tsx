// 공용 레이아웃 — 상단 드래그 영역과 동적 타이틀을 제공합니다.
"use client";
import { usePathname } from "next/navigation";

export default function LibraryLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";

  let title = "Library";
  if (pathname.startsWith("/library/agents")) title = "My Agents";
  else if (pathname.startsWith("/library/env")) title = "Environment Variables";
  else if (pathname.startsWith("/library/mcps")) title = "Plugins & MCPs";

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
      <div style={{ flex: 1, overflowY: "auto" }}>{children}</div>
    </div>
  );
}
