"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { INSTALLED_APPS } from "@/lib/apps";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import type { AppFactoryAppRecord } from "@/lib/types";
import { sanitizePublicAppCopy } from "@shared/brand-safety";
import { IconApps, IconCheck, IconChevronRight, IconImage, IconStore, IconWand } from "@/components/Icon";

type StudioProbe = "idle" | "checking" | "ok" | "error";

export default function AppsPage() {
  const { locale } = useT();
  const [generatedApps, setGeneratedApps] = useState<AppFactoryAppRecord[]>([]);
  const [studioProbe, setStudioProbe] = useState<StudioProbe>("idle");
  const [studioMessage, setStudioMessage] = useState("");

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

  async function checkStudioRuntime() {
    const api = ipc();
    if (!api || studioProbe === "checking") return;
    setStudioProbe("checking");
    setStudioMessage("");
    try {
      const res = await api.hephaestus.startStudio();
      if (res.ok && res.url) {
        setStudioProbe("ok");
        setStudioMessage(`Runtime ready at ${res.url}`);
      } else {
        setStudioProbe("error");
        setStudioMessage(res.reason ?? "Studio runtime could not start.");
      }
    } catch (err) {
      setStudioProbe("error");
      setStudioMessage(err instanceof Error ? err.message : String(err));
    }
  }

  const featuredStudio = INSTALLED_APPS.find((app) => app.id === "startup-founder-studio");
  const firstPartyApps = INSTALLED_APPS.filter((app) => app.id !== "startup-founder-studio");

  return (
    <div style={{ width: "100%", height: "100%", overflowY: "auto", background: "var(--paper)", color: "var(--ink)" }}>
      <main style={{ maxWidth: 1180, margin: "0 auto", padding: "34px 34px 64px", display: "flex", flexDirection: "column", gap: 28 }}>
        <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, color: "var(--muted-deep)", textTransform: "uppercase", marginBottom: 8 }}>
              Agentlas Apps
            </div>
            <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 26, lineHeight: 1.15, fontWeight: 750 }}>
              실행 가능한 Studio와 생성 앱
            </h1>
            <p style={{ margin: "8px 0 0", color: "var(--ink-soft)", fontSize: 13.5, lineHeight: 1.55, maxWidth: 680 }}>
              각 타일은 실제 라우트와 런타임으로 이동합니다. 생성 앱은 로컬 App Factory 상태에서 active 항목만 표시합니다.
            </p>
          </div>
          <Link
            href="/build"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              height: 36,
              padding: "0 13px",
              borderRadius: 8,
              border: "1px solid var(--paper-edge)",
              background: "var(--fill-1)",
              color: "var(--ink)",
              textDecoration: "none",
              fontSize: 12.5,
              fontWeight: 700,
            }}
          >
            <IconWand size={14} />
            Build 새 에이전트
          </Link>
        </header>

        {featuredStudio && (
          <section style={{ border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--fill-1)", overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(280px, 0.8fr)", minHeight: 250 }}>
              <div style={{ padding: 24, display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 18 }}>
                <div>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 800, color: "var(--accent)", marginBottom: 10 }}>
                    <IconStore size={13} />
                    REAL STUDIO RUNTIME
                  </div>
                  <h2 style={{ margin: 0, fontSize: 23, fontWeight: 750, fontFamily: "var(--font-head)" }}>
                    {pickLocalized(featuredStudio, locale).name}
                  </h2>
                  <p style={{ margin: "10px 0 0", color: "var(--ink-soft)", fontSize: 13.5, lineHeight: 1.55, maxWidth: 680 }}>
                    {pickLocalized(featuredStudio, locale).tagline}
                  </p>
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <Link href={featuredStudio.route} style={primaryLinkStyle}>
                    열기
                    <IconChevronRight size={14} />
                  </Link>
                  <button onClick={checkStudioRuntime} disabled={studioProbe === "checking"} style={secondaryButtonStyle}>
                    {studioProbe === "checking" ? "점검 중..." : "런타임 점검"}
                  </button>
                  {studioProbe !== "idle" && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: studioProbe === "ok" ? "var(--green-deep)" : studioProbe === "error" ? "var(--red-deep)" : "var(--muted-deep)" }}>
                      {studioProbe === "ok" && <IconCheck size={13} />}
                      {studioMessage || (studioProbe === "checking" ? "Studio runtime starting" : "")}
                    </span>
                  )}
                </div>
              </div>
              <AppMedia appId={featuredStudio.id} label={pickLocalized(featuredStudio, locale).name} large />
            </div>
          </section>
        )}

        <section>
          <SectionHeader title="First-Party Studio" count={firstPartyApps.length} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 }}>
            {firstPartyApps.map((app) => (
              <AppCard key={app.id} href={app.launchCommand ? `${app.route}?cmd=${encodeURIComponent(app.launchCommand)}` : app.route}>
                <AppMedia appId={app.id} label={pickLocalized(app, locale).name} />
                <div style={{ padding: 14 }}>
                  <div style={{ fontSize: 15, fontWeight: 750, color: "var(--ink)", marginBottom: 5 }}>{pickLocalized(app, locale).name}</div>
                  <div style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>{pickLocalized(app, locale).tagline}</div>
                </div>
              </AppCard>
            ))}
          </div>
        </section>

        <section>
          <SectionHeader title="Generated Apps" count={generatedApps.length} />
          {generatedApps.length === 0 ? (
            <div style={{ border: "1px dashed var(--paper-edge)", borderRadius: 8, background: "var(--fill-1)", padding: 24, color: "var(--muted-deep)", fontSize: 13 }}>
              아직 생성된 앱이 없습니다. Chat에서 Apps 생성 모드를 켜거나 Build에서 새 도구를 만든 뒤 여기에 표시됩니다.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 }}>
              {generatedApps.map((app) => {
                const title = sanitizePublicAppCopy(app.appName || app.manifest?.app?.name || app.manifest?.title, "Generated App");
                const tagline = sanitizePublicAppCopy(app.manifest?.app?.valueProp || app.manifest?.description || "Agent-made web app", "Agent-made web app");
                return (
                  <AppCard key={app.id} href={`/apps/generated?id=${app.id}`}>
                    <div style={{ height: 136, background: "linear-gradient(135deg, var(--fill-2), var(--paper-2))", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)" }}>
                      <IconWand size={38} />
                    </div>
                    <div style={{ padding: 14 }}>
                      <div style={{ fontSize: 15, fontWeight: 750, color: "var(--ink)", marginBottom: 5 }}>{title}</div>
                      <div style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>{tagline}</div>
                    </div>
                  </AppCard>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 750 }}>{title}</h2>
      <span style={{ fontSize: 11, color: "var(--muted-deep)", border: "1px solid var(--paper-edge)", borderRadius: 999, padding: "1px 7px" }}>{count}</span>
    </div>
  );
}

function AppCard({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 250,
        overflow: "hidden",
        border: "1px solid var(--paper-edge)",
        borderRadius: 8,
        background: "var(--paper)",
        color: "inherit",
        textDecoration: "none",
        boxShadow: "var(--shadow-1)",
      }}
    >
      {children}
    </Link>
  );
}

function AppMedia({ appId, label, large = false }: { appId: string; label: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <div style={{ minHeight: large ? 250 : 136, background: "var(--paper-2)", position: "relative", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      {!failed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/apps/${appId}.png`}
          alt={label}
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      {failed && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, color: "var(--muted-deep)" }}>
          {appId === "creative-studio" ? <IconImage size={34} /> : appId === "ecommerce-os" ? <IconStore size={34} /> : <IconApps size={34} />}
          <span style={{ fontSize: 12, fontWeight: 650 }}>{label}</span>
        </div>
      )}
    </div>
  );
}

const primaryLinkStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 36,
  padding: "0 14px",
  borderRadius: 8,
  background: "var(--ink)",
  color: "var(--paper)",
  textDecoration: "none",
  fontSize: 13,
  fontWeight: 750,
};

const secondaryButtonStyle: React.CSSProperties = {
  height: 36,
  padding: "0 13px",
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink)",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
};
