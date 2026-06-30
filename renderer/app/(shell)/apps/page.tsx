// Agent Apps — 아틀리에/컨트롤룸 컨셉 (넷플릭스 그리드 폐기).
//   A) 컨트롤룸 헤더(워드마크 + 런타임 상태 칩)
//   B) 더 벤치(대표 에이전트 앱 1개 — poster 기본, hover 시 video)
//   C) 더 랙(나머지를 콘솔 행으로)
// 색은 전부 앱 레벨 CSS 변수 → 라이트/다크 양쪽 정상. (이 페이지는 .rd 래핑이 아니다)
"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { INSTALLED_APPS } from "@/lib/apps";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import { StudioBotLogo } from "@/components/StudioBotLogo";
import {
  IconApps,
  IconChevronRight,
  IconFilm,
  IconFileUp,
  IconSearch,
} from "@/components/Icon";
import type { CSSProperties, ReactNode } from "react";

type StudioProbe = "idle" | "checking" | "ok" | "error";

type StudioTile = {
  id: string;
  href: string;
  name: string;
  tagline: string;
  engines: string[];
  posterSrc?: string;
  videoSrc?: string;
  icon: ReactNode;
};

function tintFor(id: string): CSSProperties {
  // [틴트 배경 기준색, 아이콘 전경색] — 라이트모드에서 아이콘이 흐리지 않도록 전경은 deep 변형.
  const map: Record<string, [string, string]> = {
    "startup-founder-studio": ["var(--accent)", "var(--accent-strong)"],
    oberon: ["var(--blue)", "var(--blue-deep)"],
    "document-studio": ["var(--purple)", "var(--purple-deep)"],
  };
  const [base, ink] = map[id] ?? ["var(--accent)", "var(--accent-strong)"];
  return { background: `color-mix(in oklch, ${base} 16%, transparent)`, color: ink };
}

export default function AppsPage() {
  const { locale } = useT();
  const ko = locale !== "en";
  const [studioProbe, setStudioProbe] = useState<StudioProbe>("idle");
  const [studioMessage, setStudioMessage] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

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
        setStudioMessage(res.reason ?? (ko ? "앱 런타임을 시작하지 못했습니다." : "Agent app runtime could not start."));
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
          engines: app.engines ?? [],
          posterSrc: `/apps/${app.id}.png`,
          videoSrc: `/apps/${app.id}.mp4`,
          icon:
            app.id === "startup-founder-studio" ? (
              <StudioBotLogo size={18} />
            ) : app.id === "document-studio" ? (
              <IconFileUp size={16} />
            ) : app.id === "oberon" ? (
              <IconFilm size={16} />
            ) : (
              <IconApps size={16} />
            ),
        };
      }),
    [locale],
  );

  const studioOrder = ["startup-founder-studio", "oberon", "document-studio"];
  const studioTiles = useMemo<StudioTile[]>(() => {
    const ordered = studioOrder
      .map((id) => installedTiles.find((tile) => tile.id === id))
      .filter((tile): tile is StudioTile => Boolean(tile));
    const extra = installedTiles.filter((tile) => !studioOrder.includes(tile.id));
    return [...ordered, ...extra];
  }, [installedTiles]);

  const featuredStudio = studioTiles.find((app) => app.id === "startup-founder-studio") ?? studioTiles[0];

  const query = searchTerm.trim().toLowerCase();
  const rackTiles = useMemo(() => {
    const rest = studioTiles.filter((tile) => tile.id !== featuredStudio?.id);
    if (!query) return rest;
    return rest.filter((tile) => `${tile.name} ${tile.tagline} ${tile.engines.join(" ")}`.toLowerCase().includes(query));
  }, [studioTiles, featuredStudio?.id, query]);

  const subtitle = ko
    ? `에이전트 앱 ${studioTiles.length}개`
    : `${studioTiles.length} agent apps`;

  const runtimeLabel =
    studioProbe === "checking"
      ? ko ? "런타임 점검 중" : "Checking runtime"
      : studioProbe === "ok"
        ? ko ? "런타임 준비됨" : "Runtime ready"
        : studioProbe === "error"
          ? ko ? "런타임 오류" : "Runtime error"
          : ko ? "런타임 점검" : "Check runtime";

  return (
    <div className="studio-page">
      <header className="studio-bar">
        <StudioBotLogo wordmark label="Agent Apps" size={22} />
        <button
          type="button"
          className="studio-runtime"
          data-state={studioProbe}
          onClick={checkStudioRuntime}
          disabled={studioProbe === "checking"}
          title={studioMessage || runtimeLabel}
        >
          <span className="studio-runtime-dot" />
          <span>{runtimeLabel}</span>
        </button>
      </header>

      {featuredStudio && (
        <section className="studio-bench">
          <Link href={featuredStudio.href} className="studio-bench-media" aria-label={featuredStudio.name}>
            {featuredStudio.posterSrc && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={featuredStudio.posterSrc} alt="" />
            )}
            {featuredStudio.videoSrc && (
              <video src={featuredStudio.videoSrc} poster={featuredStudio.posterSrc} muted loop playsInline autoPlay preload="metadata" />
            )}
            <span className="studio-bench-dot" data-state={studioProbe} />
          </Link>
          <div className="studio-bench-info">
            <h1 className="studio-bench-name">{featuredStudio.name}</h1>
            <p className="studio-bench-tag">{featuredStudio.tagline}</p>
            {featuredStudio.engines.length > 0 && (
              <div className="studio-patchbay">
                {featuredStudio.engines.slice(0, 6).map((e) => (
                  <span key={e} className="studio-chip">{e}</span>
                ))}
              </div>
            )}
            <Link href={featuredStudio.href} className="studio-open studio-open--primary">
              {ko ? "앱 열기" : "Open app"}
              <IconChevronRight size={15} />
            </Link>
          </div>
        </section>
      )}

      <section className="studio-rack">
        <div className="studio-rack-head">
          <h2 className="studio-rack-title">{ko ? "에이전트 앱" : "Agent Apps"}</h2>
          <span className="studio-rack-count">{subtitle}</span>
          {studioTiles.length > 6 && (
            <label className="studio-search">
              <IconSearch size={15} />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder={ko ? "앱 검색" : "Search apps"}
              />
            </label>
          )}
        </div>

        {rackTiles.length === 0 ? (
          <div className="studio-empty">{ko ? "검색 결과가 없습니다." : "No matching apps."}</div>
        ) : (
          rackTiles.map((tile) => (
            <Link key={tile.id} href={tile.href} className="studio-row">
              <span className="studio-row-icon" style={tintFor(tile.id)}>{tile.icon}</span>
              <span className="studio-row-text">
                <strong className="studio-row-name">{tile.name}</strong>
                <span className="studio-row-tag">{tile.tagline}</span>
              </span>
              <span className="studio-row-meta">
                {tile.engines.length} {ko ? "엔진" : "engines"}
                <span className="studio-row-dot" data-state={studioProbe} />
              </span>
              <span className="studio-row-open">
                {ko ? "열기" : "Open"}
                <IconChevronRight size={14} />
              </span>
            </Link>
          ))
        )}
      </section>
    </div>
  );
}
