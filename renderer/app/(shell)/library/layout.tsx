// Apps 공용 레이아웃 — 사람용 관리 탭만 노출하고 생성 산출물 레지스트리는 숨김 라우트로 둔다.
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n";

export default function LibraryLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const { t } = useT();
  const TABS = [
    { href: "/library/agents", label: t("sidebar.agents") },
    { href: "/library/env", label: t("sidebar.apps_vault") },
    { href: "/library/mcps", label: t("sidebar.apps_engines") },
  ];
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "transparent", overflow: "hidden" }}>
      <header
        className="titlebar-drag glass-thin"
        style={{
          padding: "16px 32px 0",
          borderBottom: "1px solid var(--glass-border)",
          minHeight: 56,
        }}
      >
        <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 17, fontWeight: 700, marginBottom: 10 }}>
          {t("sidebar.apps")}
        </h1>
        <nav className="titlebar-nodrag" style={{ display: "flex", gap: 4 }}>
          {TABS.map((tab) => {
            const active = pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                style={{
                  padding: "8px 14px",
                  fontSize: 13,
                  fontWeight: 600,
                  color: active ? "var(--accent)" : "var(--muted-deep)",
                  borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                  textDecoration: "none",
                  marginBottom: -1,
                }}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <div style={{ flex: 1, overflowY: "auto" }}>{children}</div>
    </div>
  );
}
