"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { INSTALLED_APPS } from "@/lib/apps";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import { StudioBotLogo } from "@/components/StudioBotLogo";
import {
  IconApps,
  IconCheck,
  IconChevronRight,
  IconFilm,
  IconFileUp,
  IconImage,
  IconNetwork,
  IconSearch,
  IconStore,
  IconWand,
} from "@/components/Icon";
import type { CSSProperties, ReactNode } from "react";

type StudioProbe = "idle" | "checking" | "ok" | "error";
type CatalogFilter = "all" | "original" | "studio";

type StudioTile = {
  id: string;
  href: string;
  name: string;
  tagline: string;
  meta: string;
  posterSrc?: string;
  videoSrc?: string;
  icon: ReactNode;
};

export default function AppsPage() {
  const { locale } = useT();
  const ko = locale !== "en";
  const [studioProbe, setStudioProbe] = useState<StudioProbe>("idle");
  const [studioMessage, setStudioMessage] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>("all");

  async function checkStudioRuntime() {
    const api = ipc();
    if (!api || studioProbe === "checking") return;
    setStudioProbe("checking");
    setStudioMessage("");
    try {
      const res = await api.hephaestus.startStudio();
      if (res.ok && res.url) {
        setStudioProbe("ok");
        setStudioMessage(ko ? `런타임 준비됨: ${res.url}` : `Runtime ready: ${res.url}`);
      } else {
        setStudioProbe("error");
        setStudioMessage(res.reason ?? (ko ? "Studio 런타임을 시작하지 못했습니다." : "Studio runtime could not start."));
      }
    } catch (err) {
      setStudioProbe("error");
      setStudioMessage(err instanceof Error ? err.message : String(err));
    }
  }

  const installedTiles = useMemo<StudioTile[]>(
    () =>
      INSTALLED_APPS.map((app) => {
        const loc = pickLocalized(app, locale);
        return {
          id: app.id,
          href: app.launchCommand ? `${app.route}?cmd=${encodeURIComponent(app.launchCommand)}` : app.route,
          name: loc.name,
          tagline: loc.tagline,
          meta: app.id === "startup-founder-studio" ? "ORIGINAL" : app.kind === "ai-native" ? "STUDIO" : "APP",
          posterSrc: `/apps/${app.id}.png`,
          videoSrc: `/apps/${app.id}.mp4`,
          icon:
            app.id === "startup-founder-studio" ? (
              <StudioBotLogo size={18} />
            ) : app.id === "document-studio" ? (
              <IconFileUp size={14} />
            ) : app.id === "creative-studio" ? (
              <IconWand size={14} />
            ) : app.id === "ecommerce-os" ? (
              <IconStore size={14} />
            ) : app.id === "oberon" ? (
              <IconFilm size={14} />
            ) : (
              <IconApps size={14} />
            ),
        };
      }),
    [locale],
  );

  const studioOrder = ["startup-founder-studio", "oberon", "document-studio", "creative-studio", "ecommerce-os"];
  const studioTiles = useMemo<StudioTile[]>(
    () =>
      studioOrder
        .map((id) => installedTiles.find((tile) => tile.id === id))
        .filter((tile): tile is StudioTile => Boolean(tile)),
    [installedTiles],
  );
  const featuredStudio = installedTiles.find((app) => app.id === "startup-founder-studio") ?? installedTiles[0];
  const quickLaunchTiles = useMemo(() => studioTiles.slice(0, 3), [studioTiles]);
  const filteredTiles = useMemo(
    () =>
      studioTiles.filter((tile) => {
        if (catalogFilter === "original") return tile.meta === "ORIGINAL";
        if (catalogFilter === "studio") return tile.meta === "STUDIO";
        return true;
      }),
    [catalogFilter, studioTiles],
  );
  const query = searchTerm.trim().toLowerCase();
  const visibleTiles = useMemo(
    () =>
      query
        ? filteredTiles.filter((tile) => `${tile.name} ${tile.tagline} ${tile.meta}`.toLowerCase().includes(query))
        : filteredTiles,
    [filteredTiles, query],
  );
  const activeSubtitle = ko
    ? `${visibleTiles.length}개 앱 · 전체 ${studioTiles.length}개`
    : `${visibleTiles.length} apps · ${studioTiles.length} total`;

  return (
    <div style={pageShell}>
      {featuredStudio && (
        <section style={heroSection}>
          <video
            src={featuredStudio.videoSrc}
            poster={featuredStudio.posterSrc}
            autoPlay
            muted
            loop
            playsInline
            style={heroVideo}
          />
          <div style={heroShade} />
          <div style={heroContent}>
            <StudioWordmark />
            <div style={heroEyebrow}>NOW PLAYING</div>
            <h1 style={heroTitle}>Agentlas Studio</h1>
            <div style={heroActions}>
              <Link href={featuredStudio.href} style={primaryAction}>
                {ko ? "Startup Studio 열기" : "Open Startup Studio"}
                <IconChevronRight size={15} />
              </Link>
              <button onClick={checkStudioRuntime} disabled={studioProbe === "checking"} style={secondaryAction}>
                {studioProbe === "checking" ? (ko ? "점검 중..." : "Checking...") : ko ? "런타임 점검" : "Check runtime"}
              </button>
              {studioProbe !== "idle" && (
                <span style={{ ...probeText, color: studioProbe === "ok" ? "#91e7b4" : studioProbe === "error" ? "#ff9a9a" : "#d7d4ca" }}>
                  {studioProbe === "ok" && <IconCheck size={13} />}
                  {studioMessage}
                </span>
              )}
            </div>
          </div>
          <div style={heroBottomPreview}>
            {quickLaunchTiles.map((tile) => (
              <Link key={tile.id} href={tile.href} style={miniPreviewCard}>
                <span style={{ ...miniPreviewIcon, ...appBadgeStyle(tile.id) }}>{tile.icon}</span>
                <span style={miniPreviewText}>{tile.name}</span>
              </Link>
            ))}
            <a href="#studio-catalog" style={miniPreviewCard}>
              <span style={miniPreviewIcon}>
                <IconApps size={14} />
              </span>
              <span style={miniPreviewText}>{ko ? "전체 카탈로그" : "Full catalog"}</span>
            </a>
          </div>
        </section>
      )}

      <main id="studio-catalog" style={catalogMain}>
        <div style={catalogToolbar}>
          <div>
            <h2 style={catalogTitle}>{ko ? "Studio 카탈로그" : "Studio catalog"}</h2>
            <p style={catalogCaption}>
              {ko
                ? "상단은 대표 앱만 고정하고, 실제 탐색은 검색과 필터로 처리합니다."
                : "The hero keeps only featured apps; search and filters handle full discovery."}
            </p>
          </div>
          <div style={toolbarControls}>
            <div style={filterGroup} role="tablist" aria-label={ko ? "Studio 필터" : "Studio filters"}>
              {([
                ["all", ko ? "전체" : "All"],
                ["original", "Original"],
                ["studio", "Studio"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setCatalogFilter(value)}
                  aria-selected={catalogFilter === value}
                  style={catalogFilter === value ? filterButtonActive : filterButton}
                >
                  {label}
                </button>
              ))}
            </div>
            <label style={searchBox}>
              <IconSearch size={15} />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder={ko ? "Studio 검색" : "Search Studio"}
                style={searchInput}
              />
            </label>
          </div>
        </div>

        <StudioRow
          id={query ? "studio-search-results" : "studio-apps"}
          title={query ? (ko ? "검색 결과" : "Search results") : ko ? "전체 Studio" : "All Studio"}
          subtitle={activeSubtitle}
          tiles={visibleTiles}
          emptyText={ko ? "검색 결과가 없습니다." : "No matching apps."}
        />
      </main>
    </div>
  );
}

function StudioWordmark() {
  return (
    <StudioBotLogo
      wordmark
      label="Agentlas Studio"
      size={42}
      style={wordmark}
      textStyle={{ color: "#ffffff", fontSize: 13, fontWeight: 820 }}
    />
  );
}

function StudioRow({
  id,
  title,
  subtitle,
  tiles,
  emptyText,
}: {
  id: string;
  title: string;
  subtitle: string;
  tiles: StudioTile[];
  emptyText?: string;
}) {
  return (
    <section id={id} style={rowSection}>
      <SectionTitle title={title} subtitle={subtitle} />
      {tiles.length === 0 ? (
        <div style={emptyState}>{emptyText}</div>
      ) : (
        <div style={rail}>
          {tiles.map((tile) => (
            <StudioCard key={tile.id} tile={tile} />
          ))}
        </div>
      )}
    </section>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={sectionHeading}>
      <h2 style={sectionTitle}>{title}</h2>
      <p style={sectionSubtitle}>{subtitle}</p>
    </div>
  );
}

function StudioCard({ tile }: { tile: StudioTile }) {
  const [videoFailed, setVideoFailed] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  return (
    <Link href={tile.href} style={studioCard}>
      <div style={mediaWrap}>
        {tile.videoSrc && !videoFailed ? (
          <video
            src={tile.videoSrc}
            poster={tile.posterSrc}
            autoPlay
            muted
            loop
            playsInline
            onError={() => setVideoFailed(true)}
            style={cardVideo}
          />
        ) : tile.posterSrc && !posterFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={tile.posterSrc} alt={tile.name} onError={() => setPosterFailed(true)} style={cardVideo} />
        ) : (
          <div style={mediaFallback}>
            {tile.id.includes("creative") ? <IconImage size={34} /> : tile.icon}
          </div>
        )}
        <div style={cardShade} />
        <span style={cardMeta}>{tile.meta}</span>
      </div>
      <div style={cardBody}>
        <div style={cardTitleLine}>
          <span style={{ ...cardIcon, ...appBadgeStyle(tile.id) }}>{tile.icon}</span>
          <strong style={cardTitle}>{tile.name}</strong>
        </div>
        <p style={cardCopy}>{tile.tagline}</p>
      </div>
    </Link>
  );
}

const pageShell: CSSProperties = {
  width: "100%",
  height: "100%",
  overflowY: "auto",
  background: "#080807",
  color: "#f7f4ea",
};

const heroSection: CSSProperties = {
  position: "relative",
  minHeight: "min(560px, 58vh)",
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
  padding: "54px 46px 82px",
};

const heroVideo: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
  filter: "saturate(1.08) contrast(1.06)",
};

const heroShade: CSSProperties = {
  position: "absolute",
  inset: 0,
  background:
    "linear-gradient(90deg, rgba(5,5,4,0.96) 0%, rgba(5,5,4,0.76) 42%, rgba(5,5,4,0.26) 72%, rgba(5,5,4,0.76) 100%), linear-gradient(0deg, #080807 0%, rgba(8,8,7,0.14) 28%, rgba(8,8,7,0.08) 70%, rgba(8,8,7,0.72) 100%)",
};

const heroContent: CSSProperties = {
  position: "relative",
  zIndex: 1,
  width: "min(640px, 62vw)",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
};

const wordmark: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 10,
  marginBottom: 34,
};

const heroEyebrow: CSSProperties = {
  color: "#ffefe8",
  fontSize: 12,
  fontWeight: 760,
  marginBottom: 12,
};

const heroTitle: CSSProperties = {
  margin: 0,
  color: "#ffffff",
  fontFamily: "var(--font-head)",
  fontSize: "clamp(44px, 6.2vw, 78px)",
  lineHeight: 0.96,
  fontWeight: 780,
  letterSpacing: 0,
};

const heroActions: CSSProperties = {
  marginTop: 24,
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
};

const primaryAction: CSSProperties = {
  height: 40,
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "0 16px",
  borderRadius: 6,
  background: "#e50914",
  color: "#ffffff",
  textDecoration: "none",
  fontSize: 13,
  fontWeight: 760,
};

const secondaryAction: CSSProperties = {
  height: 40,
  display: "inline-flex",
  alignItems: "center",
  padding: "0 15px",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.28)",
  background: "rgba(255,255,255,0.12)",
  color: "#ffffff",
  fontSize: 13,
  fontWeight: 720,
  cursor: "pointer",
};

const probeText: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  maxWidth: 460,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12,
};

const heroBottomPreview: CSSProperties = {
  position: "absolute",
  left: 46,
  right: 46,
  bottom: 22,
  zIndex: 2,
  display: "flex",
  gap: 10,
  overflow: "hidden",
};

const miniPreviewCard: CSSProperties = {
  width: 180,
  minWidth: 0,
  height: 38,
  display: "inline-flex",
  alignItems: "center",
  gap: 9,
  padding: "0 11px",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(0,0,0,0.42)",
  color: "#f7f4ea",
  textDecoration: "none",
  backdropFilter: "blur(10px)",
};

const miniPreviewIcon: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 5,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(109,145,255,0.24)",
  border: "1px solid rgba(255,255,255,0.16)",
  flexShrink: 0,
};

const miniPreviewText: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12,
  fontWeight: 700,
};

const catalogMain: CSSProperties = {
  position: "relative",
  padding: "30px 36px 58px",
  display: "flex",
  flexDirection: "column",
  gap: 28,
};

const catalogToolbar: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "space-between",
  gap: 18,
  flexWrap: "wrap",
};

const catalogTitle: CSSProperties = {
  margin: 0,
  color: "#ffffff",
  fontSize: 22,
  fontFamily: "var(--font-head)",
  fontWeight: 760,
  letterSpacing: 0,
};

const catalogCaption: CSSProperties = {
  margin: "7px 0 0",
  maxWidth: 540,
  color: "rgba(255,255,255,0.50)",
  fontSize: 12.5,
  lineHeight: 1.45,
};

const toolbarControls: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
  justifyContent: "flex-end",
};

const filterGroup: CSSProperties = {
  height: 38,
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  padding: 3,
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.07)",
};

const filterButton: CSSProperties = {
  height: 30,
  minWidth: 62,
  border: 0,
  borderRadius: 5,
  background: "transparent",
  color: "rgba(255,255,255,0.62)",
  fontSize: 12,
  fontWeight: 720,
  cursor: "pointer",
};

const filterButtonActive: CSSProperties = {
  ...filterButton,
  background: "rgba(255,255,255,0.16)",
  color: "#ffffff",
};

const searchBox: CSSProperties = {
  width: "min(360px, 100%)",
  height: 38,
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "0 12px",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(255,255,255,0.08)",
  color: "rgba(255,255,255,0.72)",
};

const searchInput: CSSProperties = {
  minWidth: 0,
  flex: 1,
  height: "100%",
  border: 0,
  outline: 0,
  background: "transparent",
  color: "#ffffff",
  fontSize: 13,
};

const rowSection: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  scrollMarginTop: 72,
};

const sectionHeading: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 10,
  flexWrap: "wrap",
};

const sectionTitle: CSSProperties = {
  margin: 0,
  color: "#ffffff",
  fontSize: 17,
  fontWeight: 760,
  letterSpacing: 0,
};

const sectionSubtitle: CSSProperties = {
  margin: 0,
  color: "rgba(255,255,255,0.50)",
  fontSize: 12.5,
};

const rail: CSSProperties = {
  display: "flex",
  gap: 14,
  overflowX: "auto",
  padding: "0 0 12px",
  scrollSnapType: "x proximity",
};

const studioCard: CSSProperties = {
  width: 294,
  flex: "0 0 294px",
  borderRadius: 7,
  overflow: "hidden",
  background: "#151412",
  color: "#f7f4ea",
  textDecoration: "none",
  border: "1px solid rgba(255,255,255,0.10)",
  scrollSnapAlign: "start",
};

const mediaWrap: CSSProperties = {
  position: "relative",
  aspectRatio: "16 / 9",
  overflow: "hidden",
  background: "#201f1b",
};

const cardVideo: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

const cardShade: CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.62) 100%)",
};

const mediaFallback: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "rgba(255,255,255,0.70)",
};

const cardMeta: CSSProperties = {
  position: "absolute",
  left: 10,
  bottom: 9,
  zIndex: 1,
  height: 22,
  display: "inline-flex",
  alignItems: "center",
  padding: "0 8px",
  borderRadius: 5,
  background: "rgba(0,0,0,0.56)",
  color: "#fff7f3",
  fontSize: 10.5,
  fontWeight: 760,
};

const cardBody: CSSProperties = {
  padding: "11px 12px 13px",
};

const cardTitleLine: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
};

const cardIcon: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 6,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(109,145,255,0.22)",
  border: "1px solid rgba(255,255,255,0.14)",
  color: "#ffffff",
  flexShrink: 0,
};

function appBadgeStyle(id: string): CSSProperties {
  if (id === "startup-founder-studio") return { background: "rgba(109,145,255,0.16)", color: "#ffffff" };
  if (id === "oberon") return { background: "rgba(131,247,255,0.15)", color: "#dffcff" };
  if (id === "document-studio") return { background: "rgba(226,226,224,0.16)", color: "#ffffff" };
  if (id === "creative-studio") return { background: "rgba(255,184,77,0.16)", color: "#ffe1a3" };
  if (id === "ecommerce-os") return { background: "rgba(145,231,180,0.15)", color: "#d9ffe7" };
  return {};
}

const cardTitle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#ffffff",
  fontSize: 14,
  lineHeight: 1.25,
};

const cardCopy: CSSProperties = {
  margin: "8px 0 0",
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  overflow: "hidden",
  minHeight: 34,
  color: "rgba(255,255,255,0.58)",
  fontSize: 12,
  lineHeight: 1.43,
};

const emptyState: CSSProperties = {
  minHeight: 92,
  display: "flex",
  alignItems: "center",
  padding: "0 18px",
  borderRadius: 7,
  border: "1px dashed rgba(255,255,255,0.18)",
  color: "rgba(255,255,255,0.54)",
  fontSize: 13,
};
