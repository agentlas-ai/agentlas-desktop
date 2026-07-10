// 대시보드 좌측 조직도/로스터.
// 출처 카테고리(로컬·클라우드·허브) > firm > HQ(division) > agent.
//   - 멀티/싱글 토글: 멀티=회사 계층, 싱글=에이전트 평면.
//   - 로컬 판별: agent.localPath 유무. 회사는 CEO 에이전트의 localPath로 판별.
//   - 허브(북마크)는 로컬 설치와 별개인 Hub 라우팅 참조.
//   - 가져오기: 폴더 선택 → team.importLocalFolder → 리로드.
"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { classifyHubEntity, classifyInstalledAgent, entityClassShortLabel } from "@/lib/agent-entity-kind";
import { buildAgentRoster, visibleRosterAgents } from "@/lib/agent-roster";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { isUserFacingAgentText } from "@/lib/agent-visibility";
import { IconBuilding, IconFileUp, IconLayers, IconSearch } from "@/components/Icon";
import type { AgentGroupResolved, HubAgentBookmark, InstalledAgent, InstalledFirm, MarketplaceListing, ResolvedNode, ResolvedOrg } from "@/lib/types";

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
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [agentGroups, setAgentGroups] = useState<AgentGroupResolved[]>([]);
  // 로그인한 계정의 실제 서버 클라우드(cargo) 에이전트 — "클라우드" 카테고리에 리스트업.
  const [cloudListings, setCloudListings] = useState<MarketplaceListing[]>([]);
  const [hubBookmarks, setHubBookmarks] = useState<HubAgentBookmark[]>([]);
  const [loading, setLoading] = useState(true);
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

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) {
      setLoading(false);
      return;
    }
    try {
      const [a, f, groups, mine, bookmarks] = await Promise.all([
        api.team.list(),
        api.firms.list(),
        api.agentGroups.listResolved(),
        api.marketplace.listMine().catch(() => [] as MarketplaceListing[]),
        api.marketplace.bookmarks().catch(() => [] as HubAgentBookmark[]),
      ]);
      setAgents(visibleRosterAgents(a));
      setFirms(f);
      setAgentGroups(groups);
      setCloudListings(mine);
      setHubBookmarks(bookmarks);
      setLoadError("");
    } catch {
      setAgents([]);
      setFirms([]);
      setAgentGroups([]);
      setCloudListings([]);
      setHubBookmarks([]);
      setLoadError(t("org.load_error"));
    } finally {
      setLoading(false);
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);

  const dn = useCallback(
    (o: { name: string; nameEn?: string }) => (ko ? o.name : o.nameEn || o.name),
    [ko],
  );
  const roster = useMemo(() => buildAgentRoster(agents, firms), [agents, firms]);
  const { agentById, singleFirmByAgentId } = roster;

  const agentSource = (a: InstalledAgent): Source => (a.localPath ? "local" : "cloud");
  // firm 출처: CEO 에이전트의 localPath가 1차. CEO가 visible 필터에서 빠져 map에 없을 수 있으므로
  // 로컬 임포트 firm(slug: firm-local-*) 이거나 조직도의 어떤 에이전트라도 로컬이면 로컬로 본다.
  const firmSource = (f: InstalledFirm): Source => {
    if (agentById.get(f.ceoAgentId)?.localPath) return "local";
    if (f.slug?.startsWith("firm-local-")) return "local";
    if (f.orgChart.some((n) => agentById.get(n.agentId)?.localPath)) return "local";
    return "cloud";
  };

  const matches = (name: string) =>
    !query.trim() || name.toLowerCase().includes(query.trim().toLowerCase());
  const visibleAgentGroups = agentGroups.filter((group) => matches(group.name));

  async function importFolder() {
    const api = ipc();
    if (!api || busy) return;
    setBusy(true);
    setImportMessage(null);
    try {
      const dir = await api.fs.pickDirectory();
      if (dir) {
        const agent = await api.team.importLocalFolder(dir.path);
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

  // 제거 — 개별 에이전트/회사, 그리고 최상단 그룹(local/cloud/hub) 전체.
  async function removeAgent(id: string, name: string) {
    const api = ipc();
    if (!api || busy) return;
    if (!window.confirm(t("org.confirm.remove_agent", { name }))) return;
    setBusy(true);
    try {
      await api.team.uninstall(id);
    } catch (err) {
      setImportMessage({ tone: "error", text: t("org.error.remove_agent", { error: String(err) }) });
    } finally {
      await load();
      setBusy(false);
    }
  }
  async function removeFirm(id: string, name: string) {
    const api = ipc();
    if (!api || busy) return;
    if (!window.confirm(t("org.confirm.remove_firm", { name }))) return;
    setBusy(true);
    try {
      await api.firms.uninstall(id);
    } catch (err) {
      setImportMessage({ tone: "error", text: t("org.error.remove_firm", { error: String(err) }) });
    } finally {
      await load();
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
      for (const f of gFirms) await api.firms.uninstall(f.id);
      for (const a of gAgents) await api.team.uninstall(a.id);
    } catch (err) {
      setImportMessage({ tone: "error", text: t("org.error.remove_group", { error: String(err) }) });
    } finally {
      await load();
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
        {visibleAgentGroups.length > 0 && (
          <div>
            <button
              onClick={() => navigate("/library/agent-groups")}
              className="dashboard-org-row dashboard-org-category"
            >
              <IconLayers size={13} />
              <span className="dashboard-org-label">
                {t("org.agent_groups")}
              </span>
              <span className="dashboard-org-count">{visibleAgentGroups.length}</span>
            </button>
            {visibleAgentGroups.slice(0, 5).map((group) => (
              <button
                key={group.id}
                onClick={() => navigate("/library/agent-groups")}
                className="dashboard-org-row dashboard-org-agent dashboard-org-agent-mid dashboard-org-agent-multi"
              >
                <Dot />
                <span className="dashboard-org-label">{group.name}</span>
                <span className="dashboard-org-count">
                  {group.warningCount > 0 ? "!" : group.members.length}
                </span>
              </button>
            ))}
          </div>
        )}
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
              ? hubBookmarks
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
                  <button
                    key={`cloud:${m.slug}`}
                    onClick={() => navigate("/cloud")}
                    className="dashboard-org-row dashboard-org-agent dashboard-org-agent-single"
                    title={t("org.cloud_only.title")}
                  >
                    <Dot />
                    <span className="dashboard-org-label">{ko ? m.name : m.nameEn || m.name}</span>
                    <span className="dashboard-org-count">{t("org.kind.single")}</span>
                  </button>
                ))}

              {open &&
                hubOnly.map(({ slug, listing }) => {
                  const entityClass = classifyHubEntity(listing);
                  return (
                    <button
                      key={`hub:${slug}`}
                      onClick={() => navigate(`/marketplace?q=${encodeURIComponent(slug)}`)}
                      className={`dashboard-org-row dashboard-org-agent dashboard-org-agent-${entityClass}`}
                      title={t("org.hub_bookmark.title")}
                    >
                      <Dot />
                      <span className="dashboard-org-label">{ko ? listing.name : listing.nameEn || listing.name}</span>
                      <span className="dashboard-org-count">{entityClassShortLabel(entityClass, locale)}</span>
                    </button>
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
