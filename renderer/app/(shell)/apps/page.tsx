"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { INSTALLED_APPS } from "@/lib/apps";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import type { AppFactoryAppRecord } from "@/lib/types";
import { sanitizePublicAppCopy } from "@shared/brand-safety";
import { IconApps, IconChevronRight, IconWand, IconFilm, IconImage, IconStore } from "@/components/Icon";

export default function AppsPage() {
  const { locale, t } = useT();
  const router = useRouter();
  const [generatedApps, setGeneratedApps] = useState<AppFactoryAppRecord[]>([]);
  const [launching, setLaunching] = useState(false);
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const [fadeOpacity, setFadeOpacity] = useState(1);

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

  // Carousel Effect
  useEffect(() => {
    const interval = setInterval(() => {
      setFadeOpacity(0); // Fade out
      setTimeout(() => {
        setFeaturedIndex((prev) => (prev + 1) % INSTALLED_APPS.length);
        setFadeOpacity(1); // Fade in
      }, 500); // 500ms fade transition
    }, 5000); // Change every 5 seconds
    return () => clearInterval(interval);
  }, []);

  const featuredApp = INSTALLED_APPS[featuredIndex];
  const builtInApps = INSTALLED_APPS; // Show all in the grid below

  const getAppBg = (id: string) => {
    if (id === "creative-studio") return "linear-gradient(135deg, rgba(236,72,153,0.4), rgba(0,0,0,0.8))";
    if (id === "ecommerce-os") return "linear-gradient(135deg, rgba(59,130,246,0.4), rgba(0,0,0,0.8))";
    if (id === "document-studio") return "linear-gradient(135deg, rgba(16,185,129,0.4), rgba(0,0,0,0.8))";
    if (id === "oberon") return "linear-gradient(135deg, rgba(132,94,247,0.4), rgba(0,0,0,0.8))";
    return "linear-gradient(135deg, rgba(255,255,255,0.2), rgba(0,0,0,0.8))";
  };

  return (
    <div style={{ width: "100%", height: "100%", overflowY: "auto", background: "#000", color: "#fff", display: "block" }}>
      {/* Netflix-style Hero Section */}
      {featuredApp && (
        <section style={{ 
          position: "relative", 
          width: "100%", 
          height: 480, 
          display: "flex", 
          flexDirection: "column", 
          justifyContent: "flex-end", 
          padding: "40px 60px",
          background: `linear-gradient(to top, #000 0%, transparent 100%), ${getAppBg(featuredApp.id)}`,
          borderBottom: "1px solid rgba(255,255,255,0.1)",
          transition: "opacity 0.5s ease-in-out",
          opacity: fadeOpacity,
          flexShrink: 0
        }}>
          <div style={{ position: "relative", zIndex: 10, maxWidth: 600 }}>
            <h1 style={{ fontSize: 48, fontWeight: 800, margin: "0 0 16px", fontFamily: "var(--font-head)", letterSpacing: -1, textShadow: "0 4px 20px rgba(0,0,0,0.5)" }}>
              {pickLocalized(featuredApp, locale).name}
            </h1>
            <p style={{ fontSize: 16, color: "rgba(255,255,255,0.8)", lineHeight: 1.5, margin: "0 0 24px", textShadow: "0 2px 10px rgba(0,0,0,0.5)" }}>
              {pickLocalized(featuredApp, locale).tagline}
            </p>
            <div style={{ display: "flex", gap: 12 }}>
              <Link href={featuredApp.launchCommand ? `${featuredApp.route}?cmd=${encodeURIComponent(featuredApp.launchCommand)}` : featuredApp.route} style={{ 
                background: "#fff", color: "#000", padding: "12px 28px", borderRadius: 8, 
                fontWeight: 700, fontSize: 16, textDecoration: "none", display: "flex", alignItems: "center", gap: 8,
                transition: "transform 0.2s"
              }} className="hero-btn">
                <IconApps size={20} /> {t("settings.update.install") || "Get Started"}
              </Link>
            </div>
          </div>
        </section>
      )}

      <main style={{ padding: "30px 60px 60px", display: "flex", flexDirection: "column", gap: 40, overflowX: "hidden" }}>
        
        {/* Built-in Apps Grid */}
        <section>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 16px", color: "#fff", display: "flex", alignItems: "center", gap: 8 }}>
            First-Party Studio
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
            {builtInApps.map((app) => (
                  <Link 
                key={app.id} 
                href={app.launchCommand ? `${app.route}?cmd=${encodeURIComponent(app.launchCommand)}` : app.route} 
                className="netflix-card"
                style={{ 
                  borderRadius: 12, 
                  background: "#141414", 
                  border: "1px solid rgba(255,255,255,0.1)",
                  textDecoration: "none", 
                  color: "inherit",
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                  transition: "transform 0.3s, box-shadow 0.3s",
                }}
              >
                <div style={{ height: 140, background: app.accent || "linear-gradient(135deg, #333, #111)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
                  {app.id === "creative-studio" ? <IconImage size={40} /> : app.id === "ecommerce-os" ? <IconStore size={40} /> : <IconApps size={40} />}
                </div>
                <div style={{ padding: 16 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, margin: "0 0 6px", color: "#fff" }}>{pickLocalized(app, locale).name}</div>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {pickLocalized(app, locale).tagline}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* Generated Apps Grid */}
        {generatedApps.length > 0 && (
          <section>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 16px", color: "#fff", display: "flex", alignItems: "center", gap: 8 }}>
              Agent Generated Apps
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
              {generatedApps.map((app) => {
                const title = sanitizePublicAppCopy(app.appName || app.manifest?.app?.name || app.manifest?.title, "Generated App");
                const tagline = sanitizePublicAppCopy(app.manifest?.app?.valueProp || app.manifest?.description || "Agent-made web app", "Agent-made web app");
                return (
                  <Link 
                    key={app.id} 
                    href={`/apps/generated?id=${app.id}`}
                    className="netflix-card"
                    style={{ 
                      borderRadius: 12, 
                      background: "#141414", 
                      border: "1px solid rgba(255,255,255,0.1)",
                      textDecoration: "none", 
                      color: "inherit",
                      display: "flex",
                      flexDirection: "column",
                      overflow: "hidden",
                      transition: "transform 0.3s, box-shadow 0.3s",
                    }}
                  >
                    <div style={{ height: 140, background: "linear-gradient(135deg, #1f2937, #111827)", position: "relative" }}>
                      <div style={{ position: "absolute", top: 12, right: 12, background: "rgba(0,0,0,0.6)", padding: "4px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>GENERATED</div>
                      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <IconWand size={40} style={{ color: "#3b82f6" }} />
                      </div>
                    </div>
                    <div style={{ padding: 16 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, margin: "0 0 6px", color: "#fff" }}>{title}</div>
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                        {tagline}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        )}
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        .hero-btn:hover {
          transform: scale(1.05);
        }
        .netflix-card:hover {
          transform: translateY(-4px) scale(1.02);
          box-shadow: 0 12px 30px rgba(0,0,0,0.5);
          border-color: rgba(255,255,255,0.3) !important;
          z-index: 10;
        }
      `}} />
    </div>
  );
}

