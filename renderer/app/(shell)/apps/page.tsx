"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { INSTALLED_APPS } from "@/lib/apps";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import type { AppFactoryAppRecord } from "@/lib/types";
import { sanitizePublicAppCopy } from "@shared/brand-safety";
import { IconApps, IconChevronRight, IconKey, IconTrash, IconWand } from "@/components/Icon";

const SUPPORT_LINKS = [
  { href: "/library/env", labelKo: "전역 Env", labelEn: "Global Env", descKo: "모든 에이전트와 앱이 공유하는 자격증명과 환경변수", descEn: "Credentials and environment keys shared by every agent and app", icon: "vault" },
  { href: "/library/mcps", labelKo: "Plugins", labelEn: "Plugins", descKo: "MCP, 브라우저, 백엔드 커넥터", descEn: "MCP, browser, and backend connectors", icon: "engine" },
];

export default function AppsPage() {
  const { locale } = useT();
  const [generatedApps, setGeneratedApps] = useState<AppFactoryAppRecord[]>([]);
  const [deletingAppId, setDeletingAppId] = useState<string | null>(null);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    let cancelled = false;
    void api.appFactory.listApps().then((apps) => {
      if (!cancelled) setGeneratedApps(apps.filter((app) => app.status !== "archived"));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function deleteGeneratedApp(app: AppFactoryAppRecord) {
    const api = ipc();
    if (!api || deletingAppId) return;
    const title = sanitizePublicAppCopy(app.appName || app.manifest.app?.name || app.manifest.title, "Generated App");
    const ok = window.confirm(
      locale === "en"
        ? `Delete ${title} from Apps? It will be kept as a reversible archive.`
        : `${title}을 Apps에서 삭제할까요? 복원 가능한 archive로 보관됩니다.`,
    );
    if (!ok) return;
    setDeletingAppId(app.id);
    try {
      await api.appFactory.archive({ rootPath: app.rootPath });
      setGeneratedApps((apps) => apps.filter((item) => item.id !== app.id));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingAppId(null);
    }
  }

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
              ? "Apps open inside Agentlas; Global Env and Plugins support them."
              : "Apps는 Agentlas 안에서 열리고, 전역 Env·Plugins가 실행을 보조합니다."}
          </p>
        </div>
      </header>

      <main style={pageMain}>
        <section>
          <h2 style={sectionTitle}>{locale === "en" ? "Installed Apps" : "설치된 Apps"}</h2>
          <div style={appList}>
            {INSTALLED_APPS.map((app) => {
              const loc = pickLocalized(app, locale);
              return (
                <Link key={app.id} href={app.route} className="glass-strong" style={appTile}>
                  <div style={appIcon}>
                    <IconApps size={20} />
                  </div>
                  <div style={appBody}>
                    <div style={appTitleLine}>
                      <strong style={appName}>{loc.name}</strong>
                      <span style={appKind}>{locale === "en" ? "Installed" : "설치됨"}</span>
                    </div>
                    <span style={appDescription} title={loc.tagline}>
                      {loc.tagline}
                    </span>
                    <div style={pillRow}>
                      {app.artifacts.map((artifact) => (
                        <span key={artifact} style={pill}>{artifact}</span>
                      ))}
                    </div>
                  </div>
                  <IconChevronRight size={14} style={chevronStyle} />
                </Link>
              );
            })}
          </div>
        </section>

        {generatedApps.length > 0 && (
          <section>
            <h2 style={sectionTitle}>{locale === "en" ? "Generated Apps" : "생성된 Apps"}</h2>
            <div style={appList}>
              {generatedApps.map((app) => {
                const title = sanitizePublicAppCopy(app.appName || app.manifest.app?.name || app.manifest.title, "Generated App");
                const description = app.manifest.description;
                const tagline = sanitizePublicAppCopy(
                  app.manifest.app?.valueProp ||
                  (typeof description === "string" ? description : "") ||
                  (locale === "en" ? "Agent-made App inside Agentlas" : "Agentlas 안에서 실행되는 에이전트 생성 App"),
                  locale === "en" ? "Agent-made App inside Agentlas" : "Agentlas 안에서 실행되는 에이전트 생성 App",
                );
                const artifacts = [
                  sanitizePublicAppCopy(app.status, app.status),
                  `${app.scaffold.files.length} files`,
                  sanitizePublicAppCopy(app.manifest.domain || app.manifest.layout, app.manifest.layout),
                ].filter(Boolean);
                return (
                  <div key={app.id} className="glass-strong" style={{ ...appTile, position: "relative", paddingRight: 58 }}>
                    <Link href={`/apps/generated?id=${app.id}`} style={appTileLink}>
                      <div style={{ ...appIcon, background: "linear-gradient(135deg, var(--green), var(--accent))" }}>
                        <IconWand size={20} />
                      </div>
                      <div style={appBody}>
                        <div style={appTitleLine}>
                          <strong style={appName}>{title}</strong>
                          <span style={appKind}>{locale === "en" ? "Generated" : "생성됨"}</span>
                        </div>
                        <span style={appDescription} title={tagline}>
                          {tagline}
                        </span>
                        <div style={pillRow}>
                          {artifacts.map((artifact) => (
                            <span key={artifact} style={pill}>{artifact}</span>
                          ))}
                        </div>
                      </div>
                    </Link>
                    <button
                      type="button"
                      onClick={() => void deleteGeneratedApp(app)}
                      disabled={deletingAppId === app.id}
                      aria-label={locale === "en" ? `Delete ${title}` : `${title} 삭제`}
                      title={locale === "en" ? "Delete App" : "App 삭제"}
                      style={deleteButton}
                    >
                      <IconTrash size={14} />
                    </button>
                    <IconChevronRight size={14} style={chevronStyle} />
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section>
          <h2 style={sectionTitle}>{locale === "en" ? "Runtime Support" : "실행 보조"}</h2>
          <div style={supportGrid}>
            {SUPPORT_LINKS.map((item) => (
              <Link key={item.href} href={item.href} className="neu" style={supportTile}>
                {item.icon === "vault" ? <IconKey size={16} /> : <IconWand size={16} />}
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
      </main>
    </div>
  );
}

const pageMain: React.CSSProperties = {
  width: "100%",
  maxWidth: 1040,
  padding: "30px 32px 44px",
  display: "grid",
  gap: 26,
};

const sectionTitle: React.CSSProperties = {
  margin: "0 0 10px",
  fontFamily: "var(--font-head)",
  fontSize: 15,
  color: "var(--ink)",
};

const appList: React.CSSProperties = {
  width: "100%",
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(340px, 100%), 1fr))",
  gap: 10,
};

const appTile: React.CSSProperties = {
  width: "100%",
  minHeight: 92,
  height: "100%",
  borderRadius: 8,
  padding: 14,
  textDecoration: "none",
  color: "inherit",
  display: "flex",
  alignItems: "flex-start",
  gap: 13,
};

const appTileLink: React.CSSProperties = {
  minWidth: 0,
  flex: 1,
  display: "flex",
  alignItems: "flex-start",
  gap: 13,
  color: "inherit",
  textDecoration: "none",
};

const appIcon: React.CSSProperties = {
  width: 42,
  height: 42,
  borderRadius: 8,
  background: "linear-gradient(135deg, var(--accent), var(--peach))",
  color: "white",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  boxShadow: "var(--neu-raised-strong)",
  flexShrink: 0,
};

const appBody: React.CSSProperties = {
  minWidth: 0,
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const appTitleLine: React.CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "baseline",
  gap: 8,
};

const appName: React.CSSProperties = {
  minWidth: 0,
  display: "block",
  color: "var(--ink)",
  fontSize: 14.5,
  lineHeight: 1.25,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const appKind: React.CSSProperties = {
  flexShrink: 0,
  color: "var(--muted)",
  fontSize: 11,
  fontWeight: 700,
};

const appDescription: React.CSSProperties = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  overflow: "hidden",
  color: "var(--muted-deep)",
  fontSize: 12.2,
  lineHeight: 1.45,
  maxWidth: 720,
};

const pillRow: React.CSSProperties = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
  marginTop: 5,
};

const pill: React.CSSProperties = {
  padding: "3px 7px",
  borderRadius: 999,
  background: "var(--fill-1)",
  color: "var(--accent)",
  fontSize: 10.5,
  fontWeight: 700,
};

const chevronStyle: React.CSSProperties = {
  color: "var(--muted-deep)",
  flexShrink: 0,
  marginTop: 14,
};

const deleteButton: React.CSSProperties = {
  position: "absolute",
  top: 12,
  right: 28,
  width: 28,
  height: 28,
  borderRadius: 6,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--muted-deep)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const supportGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 10,
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
