"use client";
import Link from "next/link";
import { INSTALLED_APPS } from "@/lib/apps";
import { pickLocalized, useT } from "@/lib/i18n";
import { IconApps, IconChevronRight, IconKey, IconSparkles, IconStore, IconWand } from "@/components/Icon";

const SUPPORT_LINKS = [
  { href: "/marketplace", labelKo: "Apps Store", labelEn: "Apps Store", descKo: "운영자/클라우드에서 동기화되는 설치 소스", descEn: "Install source synced from operator and cloud manifests", icon: "store" },
  { href: "/library/env", labelKo: "Apps Vault", labelEn: "Apps Vault", descKo: "Apps가 쓰는 자격증명과 환경변수", descEn: "Credentials and environment keys used by Apps", icon: "vault" },
  { href: "/library/mcps", labelKo: "Apps Engines", labelEn: "Apps Engines", descKo: "MCP, 브라우저, 백엔드 커넥터", descEn: "MCP, browser, and backend connectors", icon: "engine" },
];

export default function AppsPage() {
  const { locale } = useT();
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--paper)" }}>
      <header
        className="titlebar-drag glass-thin"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "16px 32px 14px 90px",
          borderBottom: "1px solid var(--glass-border)",
          minHeight: 64,
        }}
      >
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            background: "var(--paper)",
            border: "1px solid var(--paper-edge)",
            boxShadow: "var(--neu-raised)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--accent)",
          }}
        >
          <IconApps size={18} />
        </div>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 20, lineHeight: 1.15 }}>Apps</h1>
          <p style={{ margin: "3px 0 0", color: "var(--muted-deep)", fontSize: 12.5 }}>
            {locale === "en"
              ? "Apps open inside Agentlas; vault keys, assets, and engines support them."
              : "Apps는 Agentlas 안에서 열리고, Vault·자산·엔진은 Apps를 구동하는 장치입니다."}
          </p>
        </div>
      </header>

      <main style={{ padding: 32, display: "grid", gap: 28 }}>
        <section>
          <h2 style={sectionTitle}>{locale === "en" ? "Installed Apps" : "설치된 Apps"}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12 }}>
            {INSTALLED_APPS.map((app) => {
              const loc = pickLocalized(app, locale);
              return (
                <Link key={app.id} href={app.route} className="glass-strong" style={appTile}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                    <div style={appIcon}>
                      <IconApps size={22} />
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <strong style={{ display: "block", color: "var(--ink)", fontSize: 15 }}>{loc.name}</strong>
                      <span style={{ display: "block", color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.45, marginTop: 3 }}>
                        {loc.tagline}
                      </span>
                    </div>
                    <IconChevronRight size={14} style={{ color: "var(--muted-deep)", flexShrink: 0, marginTop: 3 }} />
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 14 }}>
                    {app.artifacts.map((artifact) => (
                      <span key={artifact} style={pill}>{artifact}</span>
                    ))}
                  </div>
                </Link>
              );
            })}
          </div>
        </section>

        <section>
          <h2 style={sectionTitle}>{locale === "en" ? "Support Surfaces" : "서브 메뉴"}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 10 }}>
            {SUPPORT_LINKS.map((item) => (
              <Link key={item.href} href={item.href} className="neu" style={supportTile}>
                {item.icon === "store" ? <IconStore size={16} /> : item.icon === "vault" ? <IconKey size={16} /> : <IconWand size={16} />}
                <span style={{ minWidth: 0, flex: 1 }}>
                  <strong style={{ display: "block", color: "var(--ink)", fontSize: 13 }}>{locale === "en" ? item.labelEn : item.labelKo}</strong>
                  <span style={{ display: "block", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.4 }}>
                    {locale === "en" ? item.descEn : item.descKo}
                  </span>
                </span>
                <IconChevronRight size={12} style={{ color: "var(--muted)" }} />
              </Link>
            ))}
          </div>
        </section>

        <section className="glass-strong" style={{ borderRadius: 10, padding: 16, display: "flex", gap: 12, alignItems: "center" }}>
          <IconSparkles size={18} style={{ color: "var(--accent)" }} />
          <div style={{ minWidth: 0, flex: 1, color: "var(--ink-soft)", fontSize: 12.5, lineHeight: 1.55 }}>
            {locale === "en"
              ? "Apps Generate in chat now routes goals as App packages. Document Studio is the first concrete proof surface."
              : "채팅의 Apps Generate는 목표를 App 패키지로 라우팅합니다. 문서 스튜디오가 첫 번째 실제 검증용 App입니다."}
          </div>
        </section>
      </main>
    </div>
  );
}

const sectionTitle: React.CSSProperties = {
  margin: "0 0 10px",
  fontFamily: "var(--font-head)",
  fontSize: 15,
  color: "var(--ink)",
};

const appTile: React.CSSProperties = {
  minHeight: 162,
  borderRadius: 10,
  padding: 16,
  textDecoration: "none",
  color: "inherit",
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
};

const appIcon: React.CSSProperties = {
  width: 46,
  height: 46,
  borderRadius: 10,
  background: "linear-gradient(135deg, var(--accent), var(--peach))",
  color: "white",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  boxShadow: "var(--neu-raised-strong)",
  flexShrink: 0,
};

const pill: React.CSSProperties = {
  padding: "3px 7px",
  borderRadius: 999,
  background: "var(--fill-1)",
  color: "var(--accent)",
  fontSize: 10.5,
  fontWeight: 700,
};

const supportTile: React.CSSProperties = {
  padding: 12,
  borderRadius: 8,
  display: "flex",
  alignItems: "center",
  gap: 10,
  textDecoration: "none",
  color: "var(--ink-soft)",
};
