"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT, type Locale } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import type {
  FirmListing,
  InstalledFirm,
  InstalledMcpServer,
  MarketplaceListing,
  MarketplaceSourceStatus,
  McpToolCatalogEntry,
  TeamBundle,
} from "@/lib/types";
import {
  IconBuilding,
  IconChat,
  IconCheck,
  IconChevronRight,
  IconFilm,
  IconFolder,
  IconHome,
  IconMegaphone,
  IconMoreHorizontal,
  IconNetwork,
  IconPlus,
  IconSearch,
  IconShoppingBag,
  IconSparkles,
  IconUsers,
  IconWand,
} from "@/components/Icon";

type HubCategory = "team" | "plugin" | "agent";

export default function MarketplacePageWrapper() {
  return (
    <Suspense fallback={null}>
      <MarketplacePage />
    </Suspense>
  );
}

function MarketplacePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t, locale } = useT();
  const ko = locale === "ko";

  const [active, setActive] = useState<HubCategory>("team");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 12;

  const [bundles, setBundles] = useState<TeamBundle[]>([]);
  const [firms, setFirms] = useState<FirmListing[]>([]);
  const [installedFirms, setInstalledFirms] = useState<InstalledFirm[]>([]);
  const [pluginCatalog, setPluginCatalog] = useState<McpToolCatalogEntry[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledMcpServer[]>([]);
  const [importing, setImporting] = useState(false);
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [installedAgentSlugs, setInstalledAgentSlugs] = useState<Set<string>>(new Set());
  const [sourceStatus, setSourceStatus] = useState<MarketplaceSourceStatus | null>(null);
  const [q, setQ] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    setPage(1);
  }, [active, q]);

  async function ensureSignedIn(): Promise<boolean> {
    const api = ipc();
    if (!api) return false;
    const current = await api.auth.getSession();
    if (current.signedIn) {
      if (!signedIn) setSignedIn(true);
      return true;
    }
    const next = await api.auth.signInWithGoogle();
    setSignedIn(next.signedIn);
    return next.signedIn;
  }

  async function refresh() {
    const api = ipc();
    if (!api) return;
    const [bd, sf, lf, ls, ag, plugins, installedMcp, status, session] = await Promise.all([
      api.marketplace.listBundles(),
      api.marketplace.listFirms(),
      api.firms.list(),
      api.marketplace.search(""),
      api.team.list(),
      api.mcpTools.listCatalog(),
      api.mcpTools.listInstalled(),
      api.marketplace.status(),
      api.auth.getSession(),
    ]);
    setBundles(bd);
    setFirms(sf);
    setInstalledFirms(lf);
    setPluginCatalog(plugins);
    setInstalledPlugins(installedMcp);
    setListings(ls);
    setInstalledAgentSlugs(new Set(ag.map((a) => a.slug)));
    setSourceStatus(status);
    setSignedIn(session.signedIn);
  }

  async function importLocalFolderFromMarket() {
    const api = ipc();
    if (!api || importing) return;
    const dir = await api.fs.pickDirectory();
    if (!dir) return;
    setImporting(true);
    try {
      const agent = await api.team.importLocalFolder(dir);
      await refresh();
      if (agent && agent.kind === "team") {
        const inst = (await api.firms.list()).find((f) => f.slug === `firm-${agent.slug}`);
        if (inst) {
          navigate(`/firm/detail?id=${inst.id}`);
          return;
        }
      }
      setActive("agent");
    } finally {
      setImporting(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    const t = setTimeout(() => {
      void api.marketplace.search(q).then(async (results) => {
        setListings(results);
        setSourceStatus(await api.marketplace.status());
      });
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  const installedFirmSlugs = new Set(installedFirms.map((f) => f.slug));

  async function installFirm(firm: FirmListing) {
    const api = ipc();
    if (!api) return;
    if (!(await ensureSignedIn())) return;
    setInstalling(firm.slug);
    try {
      const inst = await api.firms.install(firm.slug);
      await refresh();
      navigate(`/firm/detail?id=${inst.id}`);
    } finally {
      setInstalling(null);
    }
  }

  async function installBundle(bundle: TeamBundle) {
    const api = ipc();
    if (!api) return;
    if (!(await ensureSignedIn())) return;
    setInstalling(bundle.id);
    try {
      for (const a of bundle.agents) await api.team.install(a.slug);
      await refresh();
    } finally {
      setInstalling(null);
    }
  }

  async function installOne(slug: string) {
    const api = ipc();
    if (!api) return;
    if (!(await ensureSignedIn())) return;
    setInstalling(slug);
    try {
      await api.team.install(slug);
      await refresh();
    } finally {
      setInstalling(null);
    }
  }

  async function installPlugin(plugin: McpToolCatalogEntry) {
    const api = ipc();
    if (!api) return;
    setInstalling(`plugin:${plugin.id}`);
    try {
      await api.mcpTools.install(plugin.id);
      const [catalog, installed] = await Promise.all([
        api.mcpTools.listCatalog(),
        api.mcpTools.listInstalled(),
      ]);
      setPluginCatalog(catalog);
      setInstalledPlugins(installed);
    } finally {
      setInstalling(null);
    }
  }

  const normalizedQuery = q.trim().toLowerCase();
  const matchesQuery = (item: any) => {
    if (!normalizedQuery) return true;
    const loc = pickLocalized(item, locale);
    return (
      (loc.name || "").toLowerCase().includes(normalizedQuery) ||
      (loc.tagline || "").toLowerCase().includes(normalizedQuery)
    );
  };

  const pluginMatchesQuery = (plugin: McpToolCatalogEntry) => {
    if (!normalizedQuery) return true;
    return (
      plugin.name.toLowerCase().includes(normalizedQuery) ||
      plugin.nameEn.toLowerCase().includes(normalizedQuery) ||
      plugin.description.toLowerCase().includes(normalizedQuery) ||
      plugin.descriptionEn.toLowerCase().includes(normalizedQuery) ||
      plugin.category.toLowerCase().includes(normalizedQuery)
    );
  };

  const filteredTeams = [...firms, ...bundles].filter(matchesQuery);
  const filteredPlugins = pluginCatalog.filter(pluginMatchesQuery);
  const filteredAgents = listings.filter((l) => {
    if (!normalizedQuery) return true;
    return (l.name || "").toLowerCase().includes(normalizedQuery) || (l.tagline || "").toLowerCase().includes(normalizedQuery);
  });

  const counts = {
    agent: filteredAgents.length,
    plugin: filteredPlugins.length,
    team: filteredTeams.length,
  };

  const activeTotal = counts[active];
  const totalPages = Math.max(1, Math.ceil(activeTotal / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageEnd = pageStart + PAGE_SIZE;

  const pagedTeams = filteredTeams.slice(pageStart, pageEnd);
  const pagedPlugins = filteredPlugins.slice(pageStart, pageEnd);
  const pagedAgents = filteredAgents.slice(pageStart, pageEnd);
  const installedPluginIds = new Set(installedPlugins.map((plugin) => plugin.catalogId).filter(Boolean));

  const CATEGORY_NAV = [
    { key: "team" as HubCategory, ko: "팀", en: "Team", tone: "#a07cfa", note: { ko: "여러 에이전트가 함께 일하는 팀", en: "Multi-agent teams" } },
    { key: "plugin" as HubCategory, ko: "플러그인", en: "Plugin", tone: "#f2795a", note: { ko: "Hub 에이전트가 찾아 쓰는 도구", en: "Tools Hub agents can use" } },
    { key: "agent" as HubCategory, ko: "에이전트", en: "Agent", tone: "#0ca678", note: { ko: "단일 에이전트", en: "Single agents" } },
  ];

  return (
    <div className="rd" style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--rd-page-bg, #fcfaf6)" }}>
      {/* Titlebar with basic actions */}
      <header className="titlebar-drag glass-thin" style={{ display: "flex", alignItems: "center", padding: "0 16px 0 90px", minHeight: 44, borderBottom: "1px solid var(--glass-border)", flexShrink: 0 }}>
        <div className="titlebar-nodrag" style={{ flex: 1 }} />
        <div className="titlebar-nodrag" style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button onClick={() => void importLocalFolderFromMarket()} disabled={importing} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 11px", borderRadius: 6, fontSize: 12, fontWeight: 600, color: "var(--ink-soft)", background: "var(--paper)", border: "1px solid var(--paper-edge)", cursor: importing ? "default" : "pointer", opacity: importing ? 0.6 : 1 }}>
            <IconFolder size={12} />
            {importing ? t("import.importing") : t("library.agents.import_local")}
          </button>
        </div>
      </header>

      {signedIn === false && (
        <div className="titlebar-nodrag" role="status" style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", background: "var(--paper-2)", borderBottom: "1px solid var(--paper-edge)", fontSize: 12, color: "var(--ink-soft)" }}>
          <span style={{ flex: 1 }}>
            <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{t("account.required.title")}</strong>
            <span style={{ marginLeft: 8 }}>{t("account.required.body")}</span>
          </span>
          <button onClick={() => void ensureSignedIn()} style={{ padding: "5px 12px", borderRadius: 999, background: "var(--paper)", color: "var(--ink)", fontSize: 12, fontWeight: 600, border: "1px solid var(--paper-edge)", cursor: "pointer" }}>
            {t("account.sign_in")}
          </button>
        </div>
      )}

      <div className="titlebar-nodrag" style={{ flex: 1, overflowY: "auto", padding: "0 0 60px" }}>
        <div className="hub-page-root" style={{ maxWidth: 1120, margin: "0 auto", padding: "48px 32px 0" }}>
          <div className="portal-hero-row" style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 18 }}>
            <div className="portal-hero-main" style={{ minWidth: 0, flex: 1, minHeight: 132 }}>
              <div className="portal-eyebrow" style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, color: "var(--rd-muted-deep)", marginBottom: 8 }}>{ko ? "레지스트리 허브" : "REGISTRY HUB"}</div>
              <h1 className="portal-hero-title" style={{ fontSize: 28, fontWeight: 600, color: "var(--rd-ink)", margin: "0 0 12px", letterSpacing: 0 }}>{ko ? "필요한 에이전트를 찾거나 연동하세요" : "Find and call the right agent"}</h1>
              <div className="portal-hero-sub" style={{ fontSize: 14, color: "var(--rd-ink-2)", lineHeight: 1.5 }}>
                {ko ? "팀과 에이전트는 일을 실행하고, 플러그인은 그들이 필요할 때 찾아 쓰는 도구 레이어입니다." : "Teams and agents do the work. Plugins are the tool layer they can discover and use."}
              </div>
            </div>
            <div className="portal-hero-side" style={{ width: 240, minHeight: 132 }}>
              <div className="portal-eyebrow" style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, color: "var(--rd-muted-deep)", marginBottom: 8 }}>{ko ? "빠른 검색" : "QUICK SEARCH"}</div>
              <div className="portal-panel-title" style={{ fontSize: 14, fontWeight: 600, color: "var(--rd-ink)", marginBottom: 6 }}>{ko ? "필요한 걸 바로 찾기" : "Search the Registry"}</div>
              <div className="portal-panel-sub" style={{ fontSize: 12, color: "var(--rd-ink-3)", lineHeight: 1.5 }}>
                {ko ? "에이전트·플러그인·팀을 한 검색창에서 찾을 수 있습니다." : "Search agents, plugins, and teams in a single search."}
              </div>
            </div>
          </div>

          <div className="portal-search-panel" style={{ background: "#fff", padding: 18, borderRadius: 16, border: "1px solid var(--rd-hair)", boxShadow: "0 8px 30px rgba(15,23,42,0.04)", marginBottom: 32 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--rd-surface)", borderRadius: 8, padding: "10px 14px", border: "1px solid var(--rd-hair)" }}>
              <IconSearch size={16} color="var(--rd-muted-deep)" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={ko ? "에이전트, 플러그인, 팀 검색..." : "Search agents, plugins, and teams..."}
                style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: 14, color: "var(--rd-ink)" }}
              />
            </div>
            <div className="portal-chip-row" style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <div style={{ background: "#f2eefe", color: "#6a2cf0", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4 }}>{ko ? `팀 ${counts.team}` : `${counts.team} Teams`}</div>
              <div style={{ background: "#feede9", color: "#d64620", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4 }}>{ko ? `플러그인 ${counts.plugin}` : `${counts.plugin} Plugins`}</div>
              <div style={{ background: "#e0f6ec", color: "#067c59", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4 }}>{ko ? `에이전트 ${counts.agent}` : `${counts.agent} Agents`}</div>
            </div>
            {sourceStatus && (
              <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 7, fontSize: 11.5, color: "var(--rd-ink-3)" }}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: sourceStatus.online && !sourceStatus.usingFallback ? "#0ca678" : "#f59f00", flexShrink: 0 }} />
                <span>
                  {sourceStatus.online && !sourceStatus.usingFallback
                    ? (ko ? "Hub MCP live source" : "Hub MCP live source")
                    : (ko ? "Fallback registry source" : "Fallback registry source")}
                </span>
                {sourceStatus.lastError && <span style={{ color: "var(--peach-ink)" }}>{sourceStatus.lastError}</span>}
              </div>
            )}
          </div>

          <div className="hub-cat-nav" role="tablist" style={{ marginBottom: 32 }}>
            {CATEGORY_NAV.map((cat) => (
              <button
                key={cat.key}
                role="tab"
                aria-selected={active === cat.key}
                className={"hub-cat-chip" + (active === cat.key ? " active" : "")}
                onClick={() => setActive(cat.key)}
              >
                <span className="hub-cat-dot" style={{ background: cat.tone }} aria-hidden="true" />
                <span className="hub-cat-label">{ko ? cat.ko : cat.en}</span>
                <span className="hub-cat-count">{counts[cat.key]}</span>
              </button>
            ))}
          </div>

          {active === "team" && (
            <section className="portal-panel" id="hub-team">
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#a07cfa", marginBottom: 6 }}>TEAM</div>
                <h2 style={{ fontSize: 20, fontWeight: 600, color: "var(--rd-ink)", margin: "0 0 6px" }}>{ko ? "여러 에이전트가 함께 일하는 팀" : "Multi-Agent Teams"}</h2>
                <div style={{ fontSize: 13, color: "var(--rd-ink-2)" }}>{ko ? "여러 전문 에이전트가 연동하여 동작하는 워크플로 단위입니다." : "Collaborative agent teams for complex workflows."}</div>
              </div>
              {pagedTeams.length > 0 ? (
                <div className="market-card-grid">
                  {pagedTeams.map((team: any) => {
                    const isFirm = "agents" in team ? false : true;
                    return isFirm ? (
                      <FirmCard key={team.slug} firm={team} locale={locale} installed={installedFirmSlugs.has(team.slug)} installing={installing === team.slug} onInstall={() => installFirm(team)} onOpen={() => {
                        const inst = installedFirms.find((f) => f.slug === team.slug);
                        if (inst) navigate(`/firm/detail?id=${inst.id}`);
                      }} />
                    ) : (
                      <BundleCard key={team.id} bundle={team} locale={locale} installing={installing === team.id} onInstall={() => installBundle(team)} />
                    );
                  })}
                </div>
              ) : (
                <div style={{ padding: 24, background: "#fff", borderRadius: 12, border: "1px solid var(--rd-hair)", textAlign: "center", color: "var(--rd-ink-2)", fontSize: 14 }}>{ko ? "조건에 맞는 팀이 없습니다." : "No teams match."}</div>
              )}
            </section>
          )}

          {active === "plugin" && (
            <section className="portal-panel" id="hub-plugin">
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#f2795a", marginBottom: 6 }}>PLUGIN</div>
                <h2 style={{ fontSize: 20, fontWeight: 600, color: "var(--rd-ink)", margin: "0 0 6px" }}>{ko ? "Hub 에이전트가 필요할 때 찾아 쓰는 도구" : "Tools Hub agents can call"}</h2>
                <div style={{ fontSize: 13, color: "var(--rd-ink-2)" }}>{ko ? "에이전트 실행 중 필요한 능력을 붙이는 레이어입니다." : "Capability layer for Hub agents."}</div>
              </div>
              {pagedPlugins.length > 0 ? (
                <div className="market-card-grid">
                  {pagedPlugins.map((plugin) => (
                    <PluginCard
                      key={plugin.id}
                      plugin={plugin}
                      locale={locale}
                      installed={installedPluginIds.has(plugin.id)}
                      installing={installing === `plugin:${plugin.id}`}
                      onInstall={() => installPlugin(plugin)}
                    />
                  ))}
                </div>
              ) : (
                <div style={{ padding: 24, background: "#fff", borderRadius: 12, border: "1px solid var(--rd-hair)", textAlign: "center", color: "var(--rd-ink-2)", fontSize: 14 }}>
                  {ko ? "조건에 맞는 플러그인이 없습니다." : "No plugins match."}
                </div>
              )}
            </section>
          )}

          {active === "agent" && (
            <section className="portal-panel" id="hub-agent">
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#0ca678", marginBottom: 6 }}>AGENT</div>
                <h2 style={{ fontSize: 20, fontWeight: 600, color: "var(--rd-ink)", margin: "0 0 6px" }}>{ko ? "다른 사람이 공유한 에이전트" : "Community Agents"}</h2>
                <div style={{ fontSize: 13, color: "var(--rd-ink-2)" }}>{ko ? "단일 에이전트입니다. 허브에서 바로 설치하세요." : "Single-purpose agents shared by the community."}</div>
              </div>
              {pagedAgents.length > 0 ? (
                <div className="market-card-grid">
                  {pagedAgents.map((agent) => (
                    <AgentCard key={agent.slug} listing={agent} locale={locale} installed={installedAgentSlugs.has(agent.slug)} installing={installing === agent.slug} onInstall={() => installOne(agent.slug)} />
                  ))}
                </div>
              ) : (
                <div style={{ padding: 24, background: "#fff", borderRadius: 12, border: "1px solid var(--rd-hair)", textAlign: "center", color: "var(--rd-ink-2)", fontSize: 14 }}>{ko ? "아직 공개된 에이전트가 없습니다." : "No public agents yet."}</div>
              )}
            </section>
          )}

          {totalPages > 1 && (
            <nav className="hub-pager">
              <button className="hub-pager-btn" disabled={safePage <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>{ko ? "이전" : "Prev"}</button>
              <span className="hub-pager-status">
                {ko ? `${safePage} / ${totalPages} 페이지` : `Page ${safePage} of ${totalPages}`}
              </span>
              <button className="hub-pager-btn" disabled={safePage >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>{ko ? "다음" : "Next"}</button>
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}

function PluginCard({
  plugin,
  locale,
  installed,
  installing,
  onInstall,
}: {
  plugin: McpToolCatalogEntry;
  locale: Locale;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  const ko = locale === "ko";
  const name = ko ? plugin.name : plugin.nameEn;
  const description = ko ? plugin.description : plugin.descriptionEn;
  const requiredKeys = plugin.envRequirements.filter((env) => env.required).map((env) => env.key);
  const mark = plugin.mark ?? name.slice(0, 2).toUpperCase();
  return (
    <div
      className="hub-entity-card"
      style={{
        display: "flex",
        flexDirection: "column",
        padding: 20,
        background: "#fff",
        borderRadius: 12,
        border: "1px solid var(--rd-hair)",
        boxShadow: "0 4px 12px rgba(15,23,42,0.03)",
        minHeight: 230,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: 10,
            background: plugin.brandColor ?? "#f2795a",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: 0,
          }}
        >
          {mark}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 650, color: "var(--rd-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {name}
            </div>
            {installed && <IconCheck size={13} style={{ color: "var(--green-deep)", flexShrink: 0 }} />}
          </div>
          <div style={{ fontSize: 12, color: "var(--rd-ink-3)", textTransform: "capitalize" }}>
            {plugin.category} · {plugin.trust}
          </div>
        </div>
      </div>

      <div style={{ fontSize: 13, color: "var(--rd-ink-2)", lineHeight: 1.5, marginBottom: 14, flex: 1 }}>
        {description}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        <span className="hub-command-chip">{plugin.transport}</span>
        {requiredKeys.length > 0 ? (
          requiredKeys.slice(0, 3).map((key) => (
            <span key={key} className="hub-command-chip">
              {key}
            </span>
          ))
        ) : (
          <span className="hub-command-chip">{ko ? "키 불필요" : "No key"}</span>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          onClick={installed ? undefined : onInstall}
          disabled={installing || installed}
          style={{
            flex: 1,
            padding: "8px 0",
            borderRadius: 8,
            background: installed ? "var(--rd-surface-2)" : "var(--rd-ink)",
            color: installed ? "var(--rd-ink)" : "#fff",
            fontSize: 13,
            fontWeight: 650,
            border: installed ? "1px solid var(--rd-hair)" : "none",
            cursor: installing || installed ? "default" : "pointer",
          }}
        >
          {installing ? (ko ? "설치 중..." : "Installing...") : installed ? (ko ? "설치됨" : "Installed") : (ko ? "설치" : "Install")}
        </button>
        {plugin.docsUrl && (
          <a
            href={plugin.docsUrl}
            target="_blank"
            rel="noreferrer"
            title={ko ? "문서 열기" : "Open docs"}
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              border: "1px solid var(--rd-hair)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--rd-ink-2)",
              textDecoration: "none",
              flexShrink: 0,
            }}
          >
            <IconChevronRight size={14} />
          </a>
        )}
      </div>
    </div>
  );
}

function FirmCard({ firm, locale, installed, installing, onInstall, onOpen }: any) {
  const loc = pickLocalized(firm, locale);
  return (
    <div style={{ display: "flex", flexDirection: "column", padding: 20, background: "#fff", borderRadius: 12, border: "1px solid var(--rd-hair)", boxShadow: "0 4px 12px rgba(15,23,42,0.03)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 8, background: "linear-gradient(135deg, rgba(202,198,250,0.7) 0%, rgba(255,214,198,0.6) 100%)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink)" }}>
          <IconBuilding size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--rd-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{loc.name}</div>
          <div style={{ fontSize: 12, color: "var(--rd-ink-3)" }}>Firm</div>
        </div>
      </div>
      <div style={{ fontSize: 13, color: "var(--rd-ink-2)", lineHeight: 1.5, marginBottom: 16, flex: 1 }}>{loc.tagline}</div>
      <div>
        <button onClick={installed ? onOpen : onInstall} disabled={installing} style={{ width: "100%", padding: "8px 0", borderRadius: 8, background: installed ? "var(--rd-surface-2)" : "var(--rd-ink)", color: installed ? "var(--rd-ink)" : "#fff", fontSize: 13, fontWeight: 600, border: installed ? "1px solid var(--rd-hair)" : "none", cursor: installing ? "default" : "pointer" }}>
          {installing ? "설치 중..." : (installed ? "열기" : "설치")}
        </button>
      </div>
    </div>
  );
}

function BundleCard({ bundle, locale, installing, onInstall }: any) {
  const loc = pickLocalized(bundle, locale);
  return (
    <div style={{ display: "flex", flexDirection: "column", padding: 20, background: "#fff", borderRadius: 12, border: "1px solid var(--rd-hair)", boxShadow: "0 4px 12px rgba(15,23,42,0.03)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 8, background: "var(--fill-2)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <IconUsers size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--rd-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{loc.name}</div>
          <div style={{ fontSize: 12, color: "var(--rd-ink-3)" }}>Team Bundle</div>
        </div>
      </div>
      <div style={{ fontSize: 13, color: "var(--rd-ink-2)", lineHeight: 1.5, marginBottom: 16, flex: 1 }}>{loc.tagline}</div>
      <div>
        <button onClick={onInstall} disabled={installing} style={{ width: "100%", padding: "8px 0", borderRadius: 8, background: "var(--rd-ink)", color: "#fff", fontSize: 13, fontWeight: 600, border: "none", cursor: installing ? "default" : "pointer" }}>
          {installing ? "설치 중..." : "설치"}
        </button>
      </div>
    </div>
  );
}

function AgentCard({ listing, locale, installed, installing, onInstall }: any) {
  const loc = pickLocalized(listing, locale);
  return (
    <div style={{ display: "flex", flexDirection: "column", padding: 20, background: "#fff", borderRadius: 12, border: "1px solid var(--rd-hair)", boxShadow: "0 4px 12px rgba(15,23,42,0.03)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 8, background: "var(--fill-2)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <IconWand size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--rd-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{loc.name}</div>
          <div style={{ fontSize: 12, color: "var(--rd-ink-3)" }}>Agent</div>
        </div>
      </div>
      <div style={{ fontSize: 13, color: "var(--rd-ink-2)", lineHeight: 1.5, marginBottom: 16, flex: 1 }}>{loc.tagline}</div>
      <div>
        <button onClick={installed ? undefined : onInstall} disabled={installing || installed} style={{ width: "100%", padding: "8px 0", borderRadius: 8, background: installed ? "var(--rd-surface-2)" : "var(--rd-ink)", color: installed ? "var(--rd-ink)" : "#fff", fontSize: 13, fontWeight: 600, border: installed ? "1px solid var(--rd-hair)" : "none", cursor: (installing || installed) ? "default" : "pointer" }}>
          {installing ? "설치 중..." : (installed ? "설치됨" : "설치")}
        </button>
      </div>
    </div>
  );
}
