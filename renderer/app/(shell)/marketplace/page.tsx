"use client";
import { Suspense, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { visibleAgents } from "@/lib/agent-visibility";
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
  IconCheck,
  IconChevronRight,
  IconFolder,
} from "@/components/Icon";

type HubCategory = "team" | "plugin" | "agent";

const TEAM_CALL_CREDITS = 10;
const AGENT_CALL_CREDITS = 1;

const C = {
  purple: "color-mix(in oklch, #5A56DC 20%, var(--rd-surface))",
  peach: "var(--rd-accent-2)",
  green: "color-mix(in oklch, var(--rd-ok) 24%, var(--rd-surface))",
};

export default function MarketplacePageWrapper() {
  return (
    <Suspense fallback={null}>
      <MarketplacePage />
    </Suspense>
  );
}

function MarketplacePage() {
  const { t, locale } = useT();
  const ko = locale === "ko";
  const searchParams = useSearchParams();

  const [active, setActive] = useState<HubCategory>("team");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 12;

  const [bundles, setBundles] = useState<TeamBundle[]>([]);
  const [firms, setFirms] = useState<FirmListing[]>([]);
  const [installedFirms, setInstalledFirms] = useState<InstalledFirm[]>([]);
  const [pluginCatalog, setPluginCatalog] = useState<McpToolCatalogEntry[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledMcpServer[]>([]);
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [installedAgentSlugs, setInstalledAgentSlugs] = useState<Set<string>>(new Set());
  const [sourceStatus, setSourceStatus] = useState<MarketplaceSourceStatus | null>(null);
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const [installing, setInstalling] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  // 좌측 사이드바 검색 등 외부에서 ?q= 로 진입하면 검색어를 반영.
  useEffect(() => {
    const urlQ = searchParams.get("q");
    if (urlQ != null) setQ(urlQ);
  }, [searchParams]);

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
    setInstalledAgentSlugs(new Set(visibleAgents(ag).map((a) => a.slug)));
    setSourceStatus(status);
    setSignedIn(session.signedIn);
  }

  async function importLocalFolderFromMarket() {
    const api = ipc();
    if (!api || importing) return;
    setImportNotice(null);
    const dir = await api.fs.pickDirectory();
    if (!dir) return;
    setImporting(true);
    try {
      const agent = await api.team.importLocalFolder(dir);
      await refresh();
      if (agent && agent.kind === "team") {
        const inst = (await api.firms.list()).find((f) => f.slug === `firm-${agent.slug}`);
        if (inst) {
          setImportNotice({ tone: "ok", text: ko ? `${agent.name || agent.slug} 가져오기 완료` : `Imported ${agent.name || agent.slug}` });
          navigate(`/firm/detail?id=${inst.id}`);
          return;
        }
      }
      setImportNotice({ tone: "ok", text: ko ? `${agent.name || agent.slug} 가져오기 완료` : `Imported ${agent.name || agent.slug}` });
      setActive("agent");
    } catch (err) {
      setImportNotice({
        tone: "error",
        text:
          err instanceof Error
            ? err.message
            : ko
              ? "가져오기에 실패했습니다. 폴더 구조와 권한을 확인하세요."
              : "Import failed. Check the folder structure and permissions.",
      });
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
  const hubLive = sourceStatus ? sourceStatus.online && !sourceStatus.usingFallback : false;
  const usingFallbackCatalog = sourceStatus ? !hubLive : false;
  const sourceLabel = !sourceStatus
    ? ko ? "Hub 확인 중" : "Checking Hub"
    : hubLive
      ? ko ? "Hub 실시간" : "Hub live"
      : ko ? "Hub 오프라인" : "Hub offline";
  const accountLabel = signedIn
    ? ko ? "계정 로그인됨" : "Account signed in"
    : ko ? "로그인 필요" : "Signed out";

  const CATEGORY_NAV = [
    { key: "team" as HubCategory, ko: "팀", en: "Team", tone: C.purple, note: { ko: `여러 에이전트가 함께 일하는 팀 · 호출 ${TEAM_CALL_CREDITS}크레딧`, en: `Multi-agent teams · ${TEAM_CALL_CREDITS} credits per call` } },
    { key: "plugin" as HubCategory, ko: "플러그인", en: "Plugin", tone: C.peach, note: { ko: "필요 시 검색·설치 후보로 제안되는 도구", en: "Tools suggested for install when a Hub agent needs them" } },
    { key: "agent" as HubCategory, ko: "에이전트", en: "Agent", tone: C.green, note: { ko: `단일 에이전트 · 호출 ${AGENT_CALL_CREDITS}크레딧`, en: `Single agents · ${AGENT_CALL_CREDITS} credits per call` } },
  ];

  return (
    <div className="rd hub-desktop-root">
      <div className="titlebar-nodrag hub-desktop-scroll">
        <div className="hub-web-frame">
          <div className="hub-web-main">
            <div className="hub-web-topbar">
              <div className="hub-web-topbar-title">Hub</div>
              <div className="hub-web-topbar-actions" aria-label={ko ? "허브 계정 상태" : "Hub account state"}>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void importLocalFolderFromMarket()}
                  disabled={importing}
                  title={ko ? "로컬 폴더의 에이전트를 가져옵니다" : "Import an agent from a local folder"}
                >
                  <IconFolder size={13} />
                  <span style={{ marginLeft: 4 }}>
                    {importing ? (ko ? "가져오는 중" : "Importing") : ko ? "로컬 폴더 가져오기" : "Import local folder"}
                  </span>
                </button>
                <span>{accountLabel}</span>
                <span
                  style={{
                    border: "1px solid var(--rd-border)",
                    borderRadius: 999,
                    padding: "3px 8px",
                    color: hubLive ? "var(--rd-ok)" : "var(--rd-warn)",
                    background: "var(--rd-surface)",
                    fontSize: 12,
                    fontWeight: 650,
                    whiteSpace: "nowrap",
                  }}
                >
                  {sourceLabel}
                </span>
              </div>
            </div>
            <main className="rd-page hub-web-content">
              <div className="hub-page-root">
          <div className="portal-hero-row">
            <div className="portal-hero-main">
              <div className="portal-eyebrow">{ko ? "레지스트리 허브" : "REGISTRY HUB"}</div>
              <h1 className="portal-hero-title">{ko ? "필요한 에이전트를 찾거나 연동하세요" : "Find and call the right agent"}</h1>
              <div className="portal-hero-sub">
                {ko
                  ? "팀과 에이전트는 일을 실행하고, 플러그인은 필요할 때 설치 후보로 제안되는 도구 레이어입니다."
                  : "Teams and agents do the work. Plugins are the tool layer suggested for install when a run needs more capability."}
              </div>
              <div className="portal-hero-sub" style={{ marginTop: 8, fontSize: 13, color: "var(--ink-soft)" }}>
                {ko
                  ? "설치·다운로드는 무료예요. 받은 에이전트는 내 구독(Claude · ChatGPT 등)으로 직접 돌아갑니다 — 크레딧은 클라우드에 올라간 에이전트를 직접 호출할 때만 들어요."
                  : "Installing and downloading is free — agents run on your own subscription. Credits apply only when you call a cloud-hosted agent directly."}
              </div>
            </div>
            <div className="portal-hero-side">
              <div className="portal-eyebrow">{ko ? "빠른 검색" : "QUICK SEARCH"}</div>
              <div className="portal-panel-title">{ko ? "필요한 걸 바로 찾기" : "Search the Registry"}</div>
              <div className="portal-panel-sub">
                {ko
                  ? "에이전트·플러그인·팀을 한 검색창에서 찾을 수 있습니다."
                  : "Search agents, plugins, and teams in a single search."}
              </div>
            </div>
          </div>

          <div className="card portal-search-panel rd-card-cream">
              <input
                className="portal-input"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={ko ? "에이전트, 플러그인, 팀 검색..." : "Search agents, plugins, and teams..."}
                aria-label={ko ? "허브 검색" : "Search the Hub"}
              />
            <div className="portal-chip-row" style={{ marginTop: 10 }}>
              <RdTag bg={C.purple}>{ko ? `팀 ${counts.team}` : `${counts.team} Teams`}</RdTag>
              <RdTag bg={C.peach}>{ko ? `플러그인 ${counts.plugin}` : `${counts.plugin} Plugins`}</RdTag>
              <RdTag bg={C.green}>{ko ? `에이전트 ${counts.agent}` : `${counts.agent} Agents`}</RdTag>
            </div>
            {sourceStatus && (
              <div className="hub-status-line" style={{ marginTop: 10 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    background: sourceStatus.online && !sourceStatus.usingFallback ? "var(--rd-ok)" : "var(--rd-warn)",
                    flexShrink: 0,
                  }}
                />
                <span>
                  {hubLive
                    ? ko ? "허브 실시간 연결됨" : "Hub live source"
                    : ko ? "오프라인 · 기본 추천 목록 표시 중 (실제 Hub 연결 아님)" : "Offline · showing built-in catalog, not live Hub"}
                </span>
                {!hubLive && sourceStatus.lastError && (
                  <span style={{ color: "var(--rd-accent-2-text)", overflowWrap: "anywhere" }}>
                    {sourceStatus.lastError}
                  </span>
                )}
              </div>
            )}
          </div>

          {sourceStatus && !hubLive && (
            <div className="hub-signin-notice" role="status" style={{ borderColor: "var(--rd-warn)", background: "color-mix(in oklch, var(--rd-warn) 10%, var(--rd-surface))" }}>
              <span>
                <strong style={{ color: "var(--rd-ink)", fontWeight: 650 }}>
                  {ko ? "실제 Hub에 연결되지 않았습니다." : "Live Hub is not connected."}
                </strong>
                <span style={{ marginLeft: 8 }}>
                  {ko
                    ? "지금 보이는 팀/에이전트는 앱에 포함된 기본 목록입니다. 실시간 Hub 등록, 호출 가능 여부, 최신 공개 목록 검증으로 보지 마세요."
                    : "The teams and agents shown now are the built-in catalog. Do not treat them as live Hub registration, callable status, or the latest public list."}
                </span>
                {sourceStatus.baseUrl && (
                  <span style={{ display: "block", marginTop: 4, color: "var(--rd-ink-3)", overflowWrap: "anywhere" }}>
                    {sourceStatus.baseUrl}
                  </span>
                )}
              </span>
            </div>
          )}

          {importNotice && (
            <div className="hub-import-notice" data-tone={importNotice.tone} role="status">
              <span>{importNotice.text}</span>
            </div>
          )}

          {signedIn === false && (
            <div className="hub-signin-notice" role="status">
              <span>
                <strong style={{ color: "var(--rd-ink)", fontWeight: 600 }}>{t("account.required.title")}</strong>
                <span style={{ marginLeft: 8 }}>{t("account.required.body")}</span>
              </span>
              <button type="button" className="btn sm" onClick={() => void ensureSignedIn()}>
                {t("account.sign_in")}
              </button>
            </div>
          )}

          <div className="hub-cat-nav" role="tablist" aria-label={ko ? "허브 카테고리" : "Hub categories"}>
            {CATEGORY_NAV.map((cat) => (
              <button
                key={cat.key}
                type="button"
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
              <SectionHead
                kicker={ko ? `팀 · 호출 시 ${TEAM_CALL_CREDITS}크레딧` : `TEAM · ${TEAM_CALL_CREDITS} CREDITS PER CALL`}
                title={ko ? "여러 에이전트가 함께 일하는 팀" : "Multi-Agent Teams"}
                sub={ko ? "여러 전문 에이전트가 유기적으로 연동하여 동작하는 워크플로 단위입니다. 실행은 호출 크레딧으로 과금되고, 다운로드 패키지와는 별개입니다." : "Collaborative agent teams for complex, multi-stage workflows. Invocation uses call credits and is separate from downloadable packages."}
              />
              {pagedTeams.length > 0 ? (
                <div className="market-card-grid">
                  {pagedTeams.map((team: any) => {
                    const isFirm = !("agents" in team);
                    return isFirm ? (
                      <FirmCard key={team.slug} firm={team} locale={locale} offlineCatalog={usingFallbackCatalog} installed={installedFirmSlugs.has(team.slug)} installing={installing === team.slug} onInstall={() => installFirm(team)} onOpen={() => {
                        const inst = installedFirms.find((f) => f.slug === team.slug);
                        if (inst) navigate(`/firm/detail?id=${inst.id}`);
                      }} />
                    ) : (
                      <BundleCard key={team.id} bundle={team} locale={locale} offlineCatalog={usingFallbackCatalog} installing={installing === team.id} onInstall={() => installBundle(team)} />
                    );
                  })}
                </div>
              ) : (
                <HubEmpty message={ko ? "조건에 맞는 팀이 없습니다." : "No teams match that search."} />
              )}
            </section>
          )}

          {active === "plugin" && (
            <section className="portal-panel" id="hub-plugin">
              <div className="hub-panel-headrow">
                <SectionHead
                  kicker={ko ? "플러그인 · 도구 레이어" : "PLUGIN · TOOL LAYER"}
                  title={ko ? "필요한 능력에 맞춰 제안되는 도구" : "Tools suggested when work needs more capability"}
                  sub={ko ? "플러그인은 자동 실행 보장이 아니라 설치·인증 후보입니다. 실행 중 필요한 능력이 있으면 적합한 도구를 제안하고, 외부 API가 필요하면 사용자 연결과 허용 범위가 갖춰진 뒤 사용할 수 있습니다." : "Plugins are install and auth candidates, not a guarantee of automatic execution. When a run needs a capability, Agentlas can suggest matching tools and use them only after install, account access, and approved scope are available."}
                />
              </div>
              {pagedPlugins.length > 0 ? (
                <div className="plugin-featured-grid">
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
                <HubEmpty message={ko ? "조건에 맞는 플러그인이 없습니다." : "No plugins match that search."} />
              )}
            </section>
          )}

          {active === "agent" && (
            <section className="portal-panel" id="hub-agent">
              <SectionHead
                kicker={ko ? `에이전트 · 호출 시 ${AGENT_CALL_CREDITS}크레딧` : `AGENT · ${AGENT_CALL_CREDITS} CREDITS PER CALL`}
                title={ko ? "다른 사람이 공유한 에이전트" : "Community Agents"}
                sub={ko ? "다른 사용자가 공개한 단일 에이전트입니다. Hub에서 명령으로 바로 호출합니다." : "Single-purpose agents shared by the community. Call them directly from the Hub."}
              />
              {pagedAgents.length > 0 ? (
                <div className="market-card-grid">
                  {pagedAgents.map((agent) => (
                    <AgentCard key={agent.slug} listing={agent} locale={locale} offlineCatalog={usingFallbackCatalog} installed={installedAgentSlugs.has(agent.slug)} installing={installing === agent.slug} onInstall={() => installOne(agent.slug)} />
                  ))}
                </div>
              ) : (
                <div className="card portal-empty-panel" style={{ padding: 18 }}>
                  <div style={{ fontFamily: "var(--rd-f-display)", fontSize: 20, fontWeight: 400 }}>
                    {ko ? "아직 공개된 에이전트가 없습니다" : "No public agents yet"}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--rd-ink-3)", lineHeight: 1.55, marginTop: 6 }}>
                    {ko ? "Hub에 공개된 에이전트가 있으면 이곳에 표시됩니다." : "Published Hub agents will appear here."}
                  </div>
                </div>
              )}
            </section>
          )}

          {totalPages > 1 && (
            <nav className="hub-pager" aria-label={ko ? "페이지" : "Pagination"}>
              <button type="button" className="hub-pager-btn" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>{ko ? "이전" : "Prev"}</button>
              <span className="hub-pager-status">
                {ko ? `${safePage} / ${totalPages} 페이지` : `Page ${safePage} of ${totalPages}`}
                <span className="hub-pager-total">{ko ? ` · 총 ${activeTotal}개` : ` · ${activeTotal} total`}</span>
              </span>
              <button type="button" className="hub-pager-btn" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>{ko ? "다음" : "Next"}</button>
            </nav>
          )}
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}

function RdTag({
  dashed,
  bg,
  size,
  className,
  style,
  children,
}: {
  dashed?: boolean;
  bg?: string;
  size?: "s" | "m";
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <span
      className={["chip", dashed ? "dashed" : "", className || ""].filter(Boolean).join(" ")}
      style={{
        background: bg,
        fontSize: size === "s" ? 10.5 : undefined,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function SectionHead({ kicker, title, sub }: { kicker: ReactNode; title: ReactNode; sub: ReactNode }) {
  return (
    <div>
      <div className="portal-eyebrow">{kicker}</div>
      <div className="portal-panel-title">{title}</div>
      <div className="portal-panel-sub">{sub}</div>
    </div>
  );
}

function HubEmpty({ message }: { message: string }) {
  return (
    <div className="card portal-empty-panel" style={{ padding: 18, marginTop: 14 }}>
      <div style={{ fontFamily: "var(--rd-f-display)", fontSize: 18, fontWeight: 500 }}>{message}</div>
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
  const mark = plugin.mark ?? name.slice(0, 2).toUpperCase();
  return (
    <div className="plugin-featured-tile">
      <div className="plugin-featured-icon" style={{ background: plugin.brandColor ?? "var(--rd-accent-2)" }}>
        {mark}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="plugin-featured-name">{name}</div>
        <div className="plugin-featured-desc">{description}</div>
      </div>
      <span className="plugin-featured-add" aria-hidden="true">
        {installed ? <IconCheck size={13} /> : "+"}
      </span>
      <button
        type="button"
        className={"btn sm" + (installed ? "" : " primary")}
        onClick={installed ? undefined : onInstall}
        disabled={installing || installed}
      >
        {installing ? (ko ? "설치 중" : "Installing") : installed ? (ko ? "설치됨" : "Installed") : (ko ? "설치" : "Install")}
      </button>
      {plugin.docsUrl && (
        <a className="btn sm" href={plugin.docsUrl} target="_blank" rel="noreferrer" title={ko ? "문서 열기" : "Open docs"}>
          <IconChevronRight size={14} />
        </a>
      )}
    </div>
  );
}

function FirmCard({ firm, locale, offlineCatalog, installed, installing, onInstall, onOpen }: any) {
  const loc = pickLocalized(firm, locale);
  const ko = locale === "ko";
  const sourceName = offlineCatalog ? (ko ? "앱 내장 기본 목록" : "Built-in catalog") : "Agentlas Hub";
  return (
    <div className="card portal-entity-card hub-entity-card">
      <div className="hub-card-head">
        <div className="hub-card-main">
          <div className="hub-card-kicker">{offlineCatalog ? (ko ? "기본 팀" : "BUILT-IN TEAM") : (ko ? "허브 팀" : "HUB TEAM")}</div>
          <button type="button" className="portal-card-title hub-card-title" onClick={installed ? onOpen : undefined}>
            {loc.name}
          </button>
          <div className="hub-card-author">{sourceName}</div>
        </div>
        <RdTag className="hub-credit-tag" bg={C.purple}>{ko ? `크레딧 ${TEAM_CALL_CREDITS}` : `${TEAM_CALL_CREDITS} credits`}</RdTag>
      </div>
      <div className="hub-card-copy">{loc.tagline}</div>
      <div className="portal-chip-row hub-card-meta">
        {offlineCatalog && <RdTag dashed>{ko ? "실시간 Hub 아님" : "Not live Hub"}</RdTag>}
        <RdTag dashed>{ko ? "본부형 팀" : "Firm"}</RdTag>
        <RdTag className="hub-command-chip" dashed>{`/hep-call ${firm.slug}`}</RdTag>
      </div>
      <div className="hub-card-actions">
        <button type="button" className={"btn sm" + (installed ? "" : " primary")} onClick={installed ? onOpen : onInstall} disabled={installing}>
          {installing ? (ko ? "설치 중" : "Installing") : installed ? (ko ? "열기" : "Open") : offlineCatalog ? (ko ? "기본 설치" : "Install built-in") : (ko ? "설치" : "Install")}
        </button>
      </div>
    </div>
  );
}

function BundleCard({ bundle, locale, offlineCatalog, installing, onInstall }: any) {
  const loc = pickLocalized(bundle, locale);
  const ko = locale === "ko";
  return (
    <div className="card portal-entity-card hub-entity-card">
      <div className="hub-card-head">
        <div className="hub-card-main">
          <div className="hub-card-kicker">{offlineCatalog ? (ko ? "기본 팀 번들" : "BUILT-IN TEAM BUNDLE") : (ko ? "팀 번들" : "TEAM BUNDLE")}</div>
          <div className="portal-card-title hub-card-title">{loc.name}</div>
          <div className="hub-card-author">{offlineCatalog ? (ko ? "앱 내장 기본 목록" : "Built-in catalog") : (ko ? "Agentlas Starter" : "Agentlas Starter")}</div>
        </div>
        <RdTag className="hub-credit-tag" bg={C.purple}>{ko ? `크레딧 ${TEAM_CALL_CREDITS}` : `${TEAM_CALL_CREDITS} credits`}</RdTag>
      </div>
      <div className="hub-card-copy">{loc.tagline}</div>
      <div className="portal-chip-row hub-card-meta">
        {offlineCatalog && <RdTag dashed>{ko ? "실시간 Hub 아님" : "Not live Hub"}</RdTag>}
        <RdTag dashed>{ko ? `에이전트 ${bundle.agents?.length ?? 0}명` : `${bundle.agents?.length ?? 0} Specialist Roles`}</RdTag>
        <RdTag className="hub-command-chip" dashed>{`/hep-call ${bundle.id}`}</RdTag>
      </div>
      <div className="hub-card-actions">
        <button type="button" className="btn sm primary" onClick={onInstall} disabled={installing}>
          {installing ? (ko ? "설치 중" : "Installing") : offlineCatalog ? (ko ? "기본 설치" : "Install built-in") : (ko ? "설치" : "Install")}
        </button>
      </div>
    </div>
  );
}

function AgentCard({ listing, locale, offlineCatalog, installed, installing, onInstall }: any) {
  const loc = pickLocalized(listing, locale);
  const ko = locale === "ko";
  const author = offlineCatalog
    ? ko ? "앱 내장 기본 목록" : "Built-in catalog"
    : listing.ownerName ? (ko ? `${listing.ownerName} 제작` : `by ${listing.ownerName}`) : "Agentlas Hub";
  return (
    <div className="card portal-entity-card hub-entity-card">
      <div className="hub-card-head">
        <div className="hub-card-main">
          <div className="hub-card-kicker">{offlineCatalog ? (ko ? "기본 에이전트" : "BUILT-IN AGENT") : (ko ? "에이전트" : "AGENT")}</div>
          <div className="portal-card-title hub-card-title">{loc.name}</div>
          <div className="hub-card-author">{author}</div>
        </div>
        <RdTag className="hub-credit-tag" bg={C.green}>{ko ? `크레딧 ${AGENT_CALL_CREDITS}` : `${AGENT_CALL_CREDITS} credits`}</RdTag>
      </div>
      <div className="hub-card-copy">{loc.tagline}</div>
      <div className="portal-chip-row hub-card-meta">
        {offlineCatalog && <RdTag dashed>{ko ? "실시간 Hub 아님" : "Not live Hub"}</RdTag>}
        <RdTag dashed>{ko ? "단일 에이전트" : "Single agent"}</RdTag>
        <RdTag className="hub-command-chip" dashed>{`/hep-call ${listing.slug}`}</RdTag>
      </div>
      <div className="hub-card-actions">
        <button type="button" className={"btn sm" + (installed ? "" : " primary")} onClick={installed ? undefined : onInstall} disabled={installing || installed}>
          {installing ? (ko ? "설치 중" : "Installing") : installed ? (ko ? "설치됨" : "Installed") : offlineCatalog ? (ko ? "기본 설치" : "Install built-in") : (ko ? "설치" : "Install")}
        </button>
      </div>
    </div>
  );
}
