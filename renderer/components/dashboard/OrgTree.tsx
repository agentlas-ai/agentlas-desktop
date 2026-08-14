// 대시보드 좌측 조직도/로스터.
// 출처 카테고리(로컬·클라우드·허브) > firm > HQ(division) > agent.
//   - 멀티/싱글 토글: 멀티=회사 계층, 싱글=에이전트 평면.
//   - 로컬 판별: agent.localPath 유무. 회사는 CEO 에이전트의 localPath로 판별.
//   - 허브(북마크)는 로컬 설치와 별개인 Hub 라우팅 참조.
//   - 가져오기: 폴더 선택 → team.importLocalFolder → 리로드.
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { classifyHubEntity, classifyInstalledAgent, entityClassShortLabel } from "@/lib/agent-entity-kind";
import { buildAgentRoster, visibleRosterAgents } from "@/lib/agent-roster";
import { onAgentRosterChange } from "@/lib/agent-roster-events";
import { hubBookmarkIdentityKey, hubBookmarksWithoutLocalDuplicates, onHubBookmarkChange } from "@/lib/hub-bookmark-events";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { isUserFacingAgentText } from "@/lib/agent-visibility";
import { IconBuilding, IconFileUp, IconSearch } from "@/components/Icon";
import { loadViewData, readViewData } from "@/lib/view-data-cache";
import type { HubAgentBookmark, InstalledAgent, InstalledFirm, MarketplaceListing, ResolvedNode, ResolvedOrg } from "@/lib/types";

type Mode = "multi" | "single";
type Source = "local" | "cloud" | "hub";
type OrgTreeTranslate = ReturnType<typeof useT>["t"];

function agentLibraryRoute(input: { agentId?: string; nodeId?: string; firmId?: string }): string {
  const params = new URLSearchParams();
  if (input.agentId) params.set("agentId", input.agentId);
  if (input.nodeId) params.set("nodeId", input.nodeId);
  if (input.firmId) params.set("firmId", input.firmId);
  const query = params.toString();
  return query ? `/library/agents?${query}` : "/library/agents";
}

export function OrgTree() {
  const { locale, t } = useT();
  const ko = locale === "ko";
  const [mode, setMode] = useState<Mode>("multi");
  const [query, setQuery] = useState("");
  const [agents, setAgents] = useState<InstalledAgent[]>(() => (
    readViewData<InstalledAgent[]>("dashboard.team")?.value ?? []
  ));
  const [firms, setFirms] = useState<InstalledFirm[]>(() => (
    readViewData<InstalledFirm[]>("dashboard.firms")?.value ?? []
  ));
  // 로그인한 계정의 실제 서버 클라우드(cargo) 에이전트 — "클라우드" 카테고리에 리스트업.
  const [cloudListings, setCloudListings] = useState<MarketplaceListing[]>(() => (
    readViewData<MarketplaceListing[]>("dashboard.cloud-listings")?.value ?? []
  ));
  const [hubBookmarks, setHubBookmarks] = useState<HubAgentBookmark[]>(() => (
    readViewData<HubAgentBookmark[]>("dashboard.hub-bookmarks")?.value ?? []
  ));
  const [loading, setLoading] = useState(() => (
    !readViewData<InstalledAgent[]>("dashboard.team") && !readViewData<InstalledFirm[]>("dashboard.firms")
  ));
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [importMessage, setImportMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [openCats, setOpenCats] = useState<Record<Source, boolean>>({
    local: true,
    cloud: true,
    hub: false,
  });
  const [openFirms, setOpenFirms] = useState<Record<string, boolean>>({});
  const [orgs, setOrgs] = useState<Record<string, ResolvedOrg | null>>({});
  // A full roster load can be slower than the local bookmark write that happens
  // while it is in flight. Only the newest bookmark read may replace renderer
  // state, so an old mount snapshot can never erase an optimistic add.
  const hubBookmarkGenerationRef = useRef(0);
  const rosterLoadGenerationRef = useRef(0);

  const refreshHubBookmarks = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const generation = ++hubBookmarkGenerationRef.current;
    try {
      const bookmarks = await loadViewData(
        "dashboard.hub-bookmarks",
        () => api.marketplace.bookmarks(),
        { maxAgeMs: 15_000, force: true },
      );
      if (hubBookmarkGenerationRef.current === generation) setHubBookmarks(bookmarks);
    } catch {
      // Keep the last known/optimistic state. A local read failure is not proof
      // that the durable bookmark row disappeared.
    }
  }, []);

  const load = useCallback(async (force = false) => {
    const api = ipc();
    if (!api) {
      setLoading(false);
      return;
    }
    const generation = ++rosterLoadGenerationRef.current;
    const bookmarkGeneration = ++hubBookmarkGenerationRef.current;
    try {
      const [a, f, mine, bookmarks] = await Promise.all([
        loadViewData("dashboard.team", () => api.team.list(), { maxAgeMs: 15_000, force }),
        loadViewData("dashboard.firms", () => api.firms.list(), { maxAgeMs: 15_000, force }),
        loadViewData("dashboard.cloud-listings", () => api.marketplace.listMine(), { maxAgeMs: 60_000, force }).catch(() => readViewData<MarketplaceListing[]>("dashboard.cloud-listings")?.value ?? []),
        loadViewData("dashboard.hub-bookmarks", () => api.marketplace.bookmarks(), { maxAgeMs: 15_000, force }).catch(() => null),
      ]);
      if (rosterLoadGenerationRef.current !== generation) return;
      setAgents(visibleRosterAgents(a));
      setFirms(f);
      setCloudListings(mine);
      if (bookmarks && hubBookmarkGenerationRef.current === bookmarkGeneration) {
        setHubBookmarks(bookmarks);
      }
      setLoadError("");
    } catch {
      if (rosterLoadGenerationRef.current !== generation) return;
      setLoadError(t("org.load_error"));
    } finally {
      if (rosterLoadGenerationRef.current === generation) setLoading(false);
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () =>
      onHubBookmarkChange((change) => {
        hubBookmarkGenerationRef.current += 1;
        if (change.action === "synced") {
          setHubBookmarks(change.bookmarks);
          if (change.bookmarks.length > 0) {
            setOpenCats((previous) => ({ ...previous, hub: true }));
            const classes = new Set(change.bookmarks.map((bookmark) => classifyHubEntity(bookmark.listing)));
            if (classes.size === 1 && classes.has("multi")) setMode("multi");
            else if (classes.size === 1 && classes.has("single")) setMode("single");
          }
          return;
        }
        if (change.action === "added") {
          setHubBookmarks((previous) => [
            change.bookmark,
            ...previous.filter((bookmark) => hubBookmarkIdentityKey(bookmark) !== hubBookmarkIdentityKey(change.bookmark)),
          ]);
          setMode(classifyHubEntity(change.bookmark.listing) === "multi" ? "multi" : "single");
          setOpenCats((previous) => ({ ...previous, hub: true }));
        } else {
          setHubBookmarks((previous) => previous.filter((bookmark) =>
            bookmark.slug !== change.slug ||
            (change.entityKind && bookmark.listing.entityKind !== change.entityKind)
          ));
        }
        // Reconcile only the bookmark slice. A slow full roster/listMine load
        // must not overwrite this event with a snapshot taken before the add.
        void refreshHubBookmarks();
      }),
    [refreshHubBookmarks],
  );
  useEffect(
    () =>
      onAgentRosterChange((change) => {
        // The import is already committed. Show the returned agent in the same
        // frame, then reconcile the firm/org projection from the local DB.
        setAgents((previous) =>
          visibleRosterAgents([change.agent, ...previous.filter((agent) => agent.id !== change.agent.id)]),
        );
        setMode(classifyInstalledAgent(change.agent) === "multi" ? "multi" : "single");
        setOpenCats((previous) => ({ ...previous, local: true }));
        void load(true);
      }),
    [load],
  );

  const dn = useCallback(
    (o: { name: string; nameEn?: string }) => (ko ? o.name : o.nameEn || o.name),
    [ko],
  );
  const roster = useMemo(() => buildAgentRoster(agents, firms), [agents, firms]);
  const { agentById, singleFirmByAgentId } = roster;
  const visibleHubBookmarks = useMemo(
    () => hubBookmarksWithoutLocalDuplicates(hubBookmarks, agents),
    [agents, hubBookmarks],
  );

  const isLocalSource = (a: InstalledAgent | undefined) =>
    Boolean(a?.assetSource === "local-import" || (a?.localPath && a.assetSource !== "agent-cloud" && a.assetSource !== "hub"));
  const agentSource = (a: InstalledAgent): Source => {
    if (a.assetSource === "hub") return "hub";
    if (a.assetSource === "agent-cloud") return "cloud";
    return isLocalSource(a) ? "local" : "cloud";
  };
  // firm 출처: CEO 에이전트의 권위 출처가 1차. Cloud/Hub 복원본도 localPath를 가지므로
  // 경로 유무만으로 local로 분류하지 않는다. CEO가 visible 필터에서 빠져 map에 없을 수 있으므로
  // 로컬 임포트 firm(slug: firm-local-*) 이거나 조직도의 어떤 에이전트라도 로컬이면 로컬로 본다.
  const firmSource = (f: InstalledFirm): Source => {
    const sources = [
      agentById.get(f.ceoAgentId),
      ...f.orgChart.map((node) => agentById.get(node.agentId)),
    ].filter(Boolean).map((agent) => agentSource(agent!));
    if (sources.includes("hub")) return "hub";
    if (sources.includes("cloud")) return "cloud";
    if (sources.includes("local") || f.slug?.startsWith("firm-local-")) return "local";
    return "cloud";
  };

  const matches = (name: string) =>
    !query.trim() || name.toLowerCase().includes(query.trim().toLowerCase());

  async function importFolder() {
    const api = ipc();
    if (!api || busy) return;
    setBusy(true);
    setImportMessage(null);
    try {
      const dir = await api.fs.pickDirectory();
      if (dir) {
        const agent = await api.team.importLocalFolder({ path: dir.path, scope: dir.scope });
        await load();
        setImportMessage({
          tone: "ok",
          text: t("org.import.success", { name: agent.name || agent.slug }),
        });
      }
    } catch (err) {
      setImportMessage({
        tone: "error",
        text:
          err instanceof Error
            ? err.message
            : t("org.import.failed"),
      });
    } finally {
      setBusy(false);
    }
  }

  function sourceLabel(source: Source): string {
    if (source === "local") return ko ? "로컬 폴더" : "local folder";
    if (source === "cloud") return "Agent Cloud";
    return "Agentlas Hub 북마크";
  }

  async function removeAgentCore(api: NonNullable<ReturnType<typeof ipc>>, agent: InstalledAgent): Promise<void> {
    const source = agentSource(agent);
    if (source === "cloud") await api.marketplace.deleteMine(agent.slug);
    if (source === "hub") await api.marketplace.bookmarkRemove(agent.slug, agent.kind === "team" ? "team" : "agent");
    const result = await api.team.uninstall(agent.id, { removeSource: source === "local" });
    if (source === "local" && !result.sourceMovedToTrash && agent.localPath) {
      throw new Error(ko ? "레지스트리는 제거됐지만 원본 폴더를 휴지통으로 옮기지 못했습니다." : "The registry was removed, but the original folder could not be moved to Trash.");
    }
  }

  async function removeFirmCore(api: NonNullable<ReturnType<typeof ipc>>, firm: InstalledFirm): Promise<void> {
    const source = firmSource(firm);
    const controller = agentById.get(firm.ceoAgentId) ?? agents.find((agent) => agent.id === firm.ceoAgentId);
    if (source === "cloud" && controller?.slug) await api.marketplace.deleteMine(controller.slug);
    if (source === "hub" && controller?.slug) await api.marketplace.bookmarkRemove(controller.slug, "team");
    const result = await api.firms.uninstall(firm.id, {
      removeMembers: true,
      removeSource: source === "local",
    });
    if (source === "local" && !result.sourceMovedToTrash && controller?.localPath) {
      throw new Error(ko ? "팀은 제거됐지만 원본 팀 폴더를 휴지통으로 옮기지 못했습니다." : "The team was removed, but its source folder could not be moved to Trash.");
    }
    if (result.retainedAgentIds?.length) {
      setImportMessage({
        tone: "ok",
        text: ko ? `공유 중인 구성원 ${result.retainedAgentIds.length}개는 다른 조직도 때문에 유지했습니다.` : `${result.retainedAgentIds.length} shared member(s) remain because another organization still uses them.`,
      });
    }
  }

  // 조직도 X는 출처별 소유권 정리까지 한 번에 수행한다: 로컬=휴지통,
  // Cloud=내 Cloud 원본 삭제, Hub=북마크 삭제. 팀은 CEO가 아닌 조직도 단위다.
  async function removeAgent(id: string, name: string) {
    const api = ipc();
    if (!api || busy) return;
    const agent = agentById.get(id);
    const source = agent ? agentSource(agent) : "local";
    if (!window.confirm(ko
      ? `${name}을(를) 조직도에서 삭제할까요? 출처: ${sourceLabel(source)}. 로컬이면 원본 폴더를 휴지통으로 옮기고, Cloud/Hub이면 원본 또는 북마크도 함께 정리합니다.`
      : `Remove ${name} from the org chart? Source: ${sourceLabel(source)}. Local sources move to Trash; Cloud/Hub also removes the owned source or bookmark.`)) return;
    setBusy(true);
    try {
      if (agent) await removeAgentCore(api, agent);
      else await api.team.uninstall(id);
    } catch (err) {
      setImportMessage({ tone: "error", text: t("org.error.remove_agent", { error: String(err) }) });
    } finally {
      await load(true);
      setBusy(false);
    }
  }
  async function removeFirm(id: string, name: string) {
    const api = ipc();
    if (!api || busy) return;
    const firm = firms.find((item) => item.id === id);
    const source = firm ? firmSource(firm) : "local";
    if (!window.confirm(ko
      ? `${name} 팀을 조직도에서 삭제할까요? 출처: ${sourceLabel(source)}. 팀 구성원 설치와 로컬 원본/Cloud 원본/Hub 북마크 정리를 함께 처리합니다.`
      : `Remove team ${name} from the org chart? Source: ${sourceLabel(source)}. This removes member installs and cleans the local source, Cloud source, or Hub bookmark.`)) return;
    setBusy(true);
    try {
      if (firm) await removeFirmCore(api, firm);
      else await api.firms.uninstall(id, { removeMembers: true });
    } catch (err) {
      setImportMessage({ tone: "error", text: t("org.error.remove_firm", { error: String(err) }) });
    } finally {
      await load(true);
      setBusy(false);
    }
  }
  async function removeGroup(src: Source, label: string) {
    const api = ipc();
    if (!api || busy) return;
    const gFirms = (mode === "multi" ? roster.multiFirms : roster.singleFirms).filter((f) => firmSource(f) === src);
    const gAgents = (mode === "multi" ? roster.standaloneMultiAgents : roster.standaloneSingleAgents).filter((a) => agentSource(a) === src);
    const total = gFirms.length + gAgents.length;
    if (total === 0) return;
    if (!window.confirm(t("org.confirm.remove_group", { name: label, count: total }))) return;
    setBusy(true);
    try {
      for (const f of gFirms) await removeFirmCore(api, f);
      for (const a of gAgents) await removeAgentCore(api, a);
    } catch (err) {
      setImportMessage({ tone: "error", text: t("org.error.remove_group", { error: String(err) }) });
    } finally {
      await load(true);
      setBusy(false);
    }
  }

  async function removeCloudListing(listing: MarketplaceListing) {
    const api = ipc();
    if (!api || busy) return;
    const name = ko ? listing.name : listing.nameEn || listing.name;
    if (!window.confirm(ko ? `${name}을 Agent Cloud에서 영구 삭제할까요?` : `Delete ${name} permanently from Agent Cloud?`)) return;
    setBusy(true);
    try {
      await api.marketplace.deleteMine(listing.slug);
    } catch (err) {
      setImportMessage({ tone: "error", text: String(err) });
    } finally {
      await load(true);
      setBusy(false);
    }
  }

  async function removeHubBookmark(slug: string, listing: MarketplaceListing) {
    const api = ipc();
    if (!api || busy) return;
    const name = ko ? listing.name : listing.nameEn || listing.name;
    if (!window.confirm(ko ? `${name}의 Hub 북마크를 조직도에서 삭제할까요?` : `Remove the Hub bookmark for ${name} from the org chart?`)) return;
    setBusy(true);
    try {
      await api.marketplace.bookmarkRemove(slug, listing.entityKind);
    } catch (err) {
      setImportMessage({ tone: "error", text: String(err) });
    } finally {
      await load(true);
      setBusy(false);
    }
  }

  async function toggleFirm(id: string) {
    setOpenFirms((p) => ({ ...p, [id]: !p[id] }));
    if (orgs[id] === undefined) {
      const api = ipc();
      if (!api) return;
      try {
        const org = await api.firms.getResolvedOrg(id);
        setOrgs((p) => ({ ...p, [id]: org }));
      } catch (err) {
        setImportMessage({ tone: "error", text: t("org.error.open_nested", { error: String(err) }) });
      }
    }
  }

  const cats: Array<{ key: Source; label: string }> = [
    { key: "local", label: t("org.source.local") },
    { key: "cloud", label: t("org.source.cloud") },
    { key: "hub", label: t("org.source.hub") },
  ];

  // 멀티 = 실제 구성원이 2명 이상인 회사(firm). 싱글 = 개별 에이전트 + 1명짜리 firm 포장.
  function bySource(src: Source) {
    const f = mode === "multi" ? roster.multiFirms.filter((x) => firmSource(x) === src) : [];
    const sourceAgents = mode === "multi" ? roster.standaloneMultiAgents : roster.singleModeAgents;
    const indiv =
      sourceAgents.filter((a) => agentSource(a) === src);
    return { firms: f, agents: indiv };
  }

  if (loading) {
    return (
      <Shell mode={mode} setMode={setMode} query={query} setQuery={setQuery} onImport={importFolder} busy={busy} t={t} importMessage={importMessage}>
        <div className="dashboard-org-empty">
          {t("org.loading")}
        </div>
      </Shell>
    );
  }

  return (
    <Shell mode={mode} setMode={setMode} query={query} setQuery={setQuery} onImport={importFolder} busy={busy} t={t} importMessage={importMessage}>
      {loadError && <div className="dashboard-org-empty">{loadError}</div>}
      <div className="dashboard-org-list">
        {cats.map((cat) => {
          const { firms: cf, agents: ca } = bySource(cat.key);
          // 클라우드 카테고리(싱글 모드)엔 로컬에 아직 안 받은 서버 클라우드 에이전트도 함께 보여준다.
          const installedSlugs = new Set(agents.map((a) => a.slug));
          const cloudOnly =
            cat.key === "cloud" && mode === "single"
              ? cloudListings.filter((m) => !installedSlugs.has(m.slug) && matches(ko ? m.name : m.nameEn || m.name))
              : [];
          const hubOnly =
            cat.key === "hub"
              ? visibleHubBookmarks
                .filter((bookmark) => classifyHubEntity(bookmark.listing) === (mode === "multi" ? "multi" : "single"))
                .filter((bookmark) => matches(ko ? bookmark.listing.name : bookmark.listing.nameEn || bookmark.listing.name))
              : [];
          const count = cf.length + ca.length + cloudOnly.length + hubOnly.length;
          const open = openCats[cat.key];
          return (
            <div key={cat.key}>
              <div className="dashboard-org-rowwrap">
                <button
                  onClick={() => setOpenCats((p) => ({ ...p, [cat.key]: !p[cat.key] }))}
                  className="dashboard-org-row dashboard-org-category"
                >
                  <Chevron open={open} />
                  <span className="dashboard-org-label">
                    {cat.label}
                  </span>
                  <span className="dashboard-org-count">{count}</span>
                </button>
                {count > 0 && cat.key !== "hub" && (
                  <button
                    type="button"
                    className="dashboard-org-remove dashboard-org-remove-group"
                    title={t("org.action.remove_group")}
                    aria-label={t("org.action.remove_group")}
                    onClick={() => void removeGroup(cat.key, String(cat.label))}
                  >
                    {t("org.action.clear")}
                  </button>
                )}
              </div>

              {open && cat.key === "hub" && hubOnly.length === 0 && (
                <div className="dashboard-org-empty dashboard-org-nested">
                  {t("org.no_hub_for_mode")}
                </div>
              )}

              {open &&
                cf.filter((f) => matches(dn(f))).map((f) => (
                  <div key={f.id}>
                    <div className="dashboard-org-rowwrap">
                      <button
                        onClick={() => void toggleFirm(f.id)}
                        className="dashboard-org-row dashboard-org-firm"
                      >
                        <Chevron open={!!openFirms[f.id]} small />
                        <IconBuilding size={13} />
                        <span className="dashboard-org-label">
                          {dn(f)}
                        </span>
                        <span className="dashboard-org-count">{t("org.kind.multi")}</span>
                      </button>
                      <button
                        type="button"
                        className="dashboard-org-remove"
                        title={t("org.action.remove")}
                        aria-label={t("org.action.remove")}
                        onClick={() => void removeFirm(f.id, dn(f))}
                      >
                        ×
                      </button>
                    </div>
                    {openFirms[f.id] && <FirmBody org={orgs[f.id]} firmId={f.id} t={t} />}
                  </div>
                ))}

              {open &&
                ca.filter((a) => matches(dn(a))).map((a) => {
                  const entityClass = classifyInstalledAgent(a);
                  return (
                    <div key={a.id} className="dashboard-org-rowwrap">
                      <button
                        onClick={() => navigate(agentLibraryRoute({ agentId: a.id, firmId: singleFirmByAgentId.get(a.id)?.id }))}
                        className={`dashboard-org-row dashboard-org-agent dashboard-org-agent-${entityClass}`}
                      >
                        <Dot />
                        <span className="dashboard-org-label">{dn(a)}</span>
                        <span className="dashboard-org-count">{entityClassShortLabel(entityClass, locale)}</span>
                      </button>
                    <button
                        type="button"
                        className="dashboard-org-remove"
                        title={t("org.action.remove")}
                        aria-label={t("org.action.remove")}
                        onClick={() => {
                          const singleFirm = singleFirmByAgentId.get(a.id);
                          if (singleFirm) void removeFirm(singleFirm.id, dn(singleFirm));
                          else void removeAgent(a.id, dn(a));
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}

              {open &&
                cloudOnly.map((m) => (
                  <div key={`cloud:${m.slug}`} className="dashboard-org-rowwrap">
                    <button
                      onClick={() => navigate("/cloud")}
                      className="dashboard-org-row dashboard-org-agent dashboard-org-agent-single"
                      title={t("org.cloud_only.title")}
                    >
                      <Dot />
                      <span className="dashboard-org-label">{ko ? m.name : m.nameEn || m.name}</span>
                      <span className="dashboard-org-count">{t("org.kind.single")}</span>
                    </button>
                    <button
                      type="button"
                      className="dashboard-org-remove"
                      title={ko ? "Agent Cloud 원본 삭제" : "Delete Agent Cloud source"}
                      aria-label={ko ? "Agent Cloud 원본 삭제" : "Delete Agent Cloud source"}
                      onClick={() => void removeCloudListing(m)}
                    >
                      ×
                    </button>
                  </div>
                ))}

              {open &&
                hubOnly.map(({ slug, listing }) => {
                  const entityClass = classifyHubEntity(listing);
                  return (
                    <div key={`hub:${String(listing.entityKind || "agent")}:${slug}`} className="dashboard-org-rowwrap">
                      <button
                        onClick={() => navigate(`/marketplace?q=${encodeURIComponent(slug)}`)}
                        className={`dashboard-org-row dashboard-org-agent dashboard-org-agent-${entityClass}`}
                        title={t("org.hub_bookmark.title")}
                      >
                        <Dot />
                        <span className="dashboard-org-label">{ko ? listing.name : listing.nameEn || listing.name}</span>
                        <span className="dashboard-org-count">{entityClassShortLabel(entityClass, locale)}</span>
                      </button>
                      <button
                        type="button"
                        className="dashboard-org-remove"
                        title={ko ? "Hub 북마크 삭제" : "Remove Hub bookmark"}
                        aria-label={ko ? "Hub 북마크 삭제" : "Remove Hub bookmark"}
                        onClick={() => void removeHubBookmark(slug, listing)}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

function Shell({
  children,
  mode,
  setMode,
  query,
  setQuery,
  onImport,
  busy,
  t,
  importMessage,
}: {
  children: React.ReactNode;
  mode: Mode;
  setMode: (m: Mode) => void;
  query: string;
  setQuery: (s: string) => void;
  onImport: () => void;
  busy: boolean;
  t: OrgTreeTranslate;
  importMessage?: { tone: "ok" | "error"; text: string } | null;
}) {
  return (
    <aside
      className="dashboard-org-tree"
    >
      <div className="dashboard-org-title">
        <span>{t("org.title")}</span>
        <span>{mode === "multi" ? "HQ" : "1:1"}</span>
      </div>
      <div className="dashboard-org-segmented">
        {(["multi", "single"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className="dashboard-org-mode"
            data-active={mode === m ? "true" : "false"}
          >
            {m === "multi" ? t("org.mode.multi") : t("org.mode.single")}
          </button>
        ))}
      </div>
      <label className="dashboard-org-search">
        <IconSearch size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("org.search.placeholder")}
        />
      </label>
      <button
        onClick={onImport}
        disabled={busy}
        className="titlebar-nodrag"
        data-dashboard-import="true"
      >
        <IconFileUp size={14} />
        {busy ? t("org.import.busy") : t("org.import.action")}
      </button>
      {importMessage && (
        <div
          role="status"
          className="dashboard-org-message"
          data-tone={importMessage.tone}
        >
          {importMessage.text}
        </div>
      )}
      {children}
    </aside>
  );
}

function Chevron({ open, small }: { open: boolean; small?: boolean }) {
  return (
    <span
      className="dashboard-org-chevron"
      data-open={open ? "true" : "false"}
      data-small={small ? "true" : "false"}
    >
      ▶
    </span>
  );
}

function Dot() {
  return <span className="dashboard-org-dot" />;
}

// 회사 하위 구조 렌더 — 분류 규칙:
//   · 시스템/인프라 노드(오케스트레이터·PM 소울·큐레이터·폴리시게이트·Eval QA 등)는 제거.
//   · 본부(division)에 하위 에이전트(specialists)가 있을 때만 "HQ"로 표시하고 그 아래 에이전트를 분해.
//   · 하위가 없는 노드는 HQ가 아니라 회사 직속 "에이전트"로 표시(HQ 태그 없음).
function FirmBody({ org, firmId, t }: { org: ResolvedOrg | null | undefined; firmId: string; t: OrgTreeTranslate }) {
  if (org === undefined) {
    return (
      <div className="dashboard-org-empty dashboard-org-deep">
        {t("org.loading")}
      </div>
    );
  }
  const hqs: Array<{ id: string; name: string; agents: Array<Pick<ResolvedNode, "id" | "name" | "agentId">> }> = [];
  const direct: Array<Pick<ResolvedNode, "id" | "name" | "agentId">> = [];
  for (const div of org?.divisions ?? []) {
    if (!isUserFacingAgentText(div.name, div.role)) continue;
    const specs = div.specialists.filter((s) => isUserFacingAgentText(s.name, s.role));
    if (specs.length > 0) {
      hqs.push({ id: div.id, name: div.name, agents: specs.map((s) => ({ id: s.id, name: s.name, agentId: s.agentId })) });
    } else {
      direct.push({ id: div.id, name: div.name, agentId: div.agentId });
    }
  }
  if (hqs.length === 0 && direct.length === 0) {
    return (
      <div className="dashboard-org-empty dashboard-org-deep">
        {t("org.no_members")}
      </div>
    );
  }
  return (
    <>
      {hqs.map((hq) => (
        <div key={hq.id}>
          <div className="dashboard-org-hq">
            <span>{hq.name}</span>
            <span>HQ</span>
          </div>
          {hq.agents.map((a) => (
            <button
              key={a.id}
              onClick={() => navigate(agentLibraryRoute({ agentId: a.agentId, nodeId: a.id, firmId }))}
              className="dashboard-org-row dashboard-org-agent dashboard-org-agent-deep"
            >
              <Dot />
              <span className="dashboard-org-label">{a.name}</span>
            </button>
          ))}
        </div>
      ))}
      {direct.map((a) => (
        <button
          key={a.id}
          onClick={() => navigate(agentLibraryRoute({ agentId: a.agentId, nodeId: a.id, firmId }))}
          className="dashboard-org-row dashboard-org-agent dashboard-org-agent-mid"
        >
          <Dot />
          <span className="dashboard-org-label">{a.name}</span>
        </button>
      ))}
    </>
  );
}
