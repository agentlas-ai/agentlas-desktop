// 대시보드 좌측 조직도/로스터.
// 출처 카테고리(로컬·클라우드·허브) > firm > HQ(division) > agent.
//   - 멀티/싱글 토글: 멀티=회사 계층, 싱글=에이전트 평면.
//   - 로컬 판별: agent.localPath 유무. 회사는 CEO 에이전트의 localPath로 판별.
//   - 허브(북마크)는 아직 저장소가 없어 빈 카테고리(placeholder).
//   - 가져오기: 폴더 선택 → team.importLocalFolder → 리로드.
"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { isVisibleAgent, isUserFacingAgentText } from "@/lib/agent-visibility";
import { IconBuilding, IconFileUp, IconSearch } from "@/components/Icon";
import type { InstalledAgent, InstalledFirm, MarketplaceListing, ResolvedNode, ResolvedOrg } from "@/lib/types";

type Mode = "multi" | "single";
type Source = "local" | "cloud" | "hub";

function dedupById(list: InstalledAgent[]): InstalledAgent[] {
  return Array.from(new Map(list.map((a) => [a.id, a])).values());
}

function agentLibraryRoute(input: { agentId?: string; nodeId?: string; firmId?: string }): string {
  const params = new URLSearchParams();
  if (input.agentId) params.set("agentId", input.agentId);
  if (input.nodeId) params.set("nodeId", input.nodeId);
  if (input.firmId) params.set("firmId", input.firmId);
  const query = params.toString();
  return query ? `/library/agents?${query}` : "/library/agents";
}

export function OrgTree() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [mode, setMode] = useState<Mode>("multi");
  const [query, setQuery] = useState("");
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  // 로그인한 계정의 실제 서버 클라우드(cargo) 에이전트 — "클라우드" 카테고리에 리스트업.
  const [cloudListings, setCloudListings] = useState<MarketplaceListing[]>([]);
  const [loading, setLoading] = useState(true);
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
    const [a, f, mine] = await Promise.all([
      api.team.list(),
      api.firms.list(),
      api.marketplace.listMine().catch(() => [] as MarketplaceListing[]),
    ]);
    setAgents(dedupById(a).filter(isVisibleAgent));
    setFirms(f);
    setCloudListings(mine);
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const dn = useCallback(
    (o: { name: string; nameEn?: string }) => (ko ? o.name : o.nameEn || o.name),
    [ko],
  );
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const firmAgentIds = useMemo(() => {
    const s = new Set<string>();
    for (const f of firms) for (const n of f.orgChart) s.add(n.agentId);
    return s;
  }, [firms]);

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

  async function importFolder() {
    const api = ipc();
    if (!api || busy) return;
    setBusy(true);
    setImportMessage(null);
    try {
      const dir = await api.fs.pickDirectory();
      if (dir) {
        const agent = await api.team.importLocalFolder(dir);
        await load();
        setImportMessage({
          tone: "ok",
          text: ko ? `${agent.name || agent.slug} 가져오기 완료` : `Imported ${agent.name || agent.slug}`,
        });
      }
    } catch (err) {
      setImportMessage({
        tone: "error",
        text:
          err instanceof Error
            ? err.message
            : ko
              ? "가져오기에 실패했습니다. 폴더 구조와 권한을 확인하세요."
              : "Import failed. Check the folder structure and permissions.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function toggleFirm(id: string) {
    setOpenFirms((p) => ({ ...p, [id]: !p[id] }));
    if (orgs[id] === undefined) {
      const api = ipc();
      if (!api) return;
      const org = await api.firms.getResolvedOrg(id);
      setOrgs((p) => ({ ...p, [id]: org }));
    }
  }

  const cats: Array<{ key: Source; label: string }> = [
    { key: "local", label: ko ? "로컬" : "Local" },
    { key: "cloud", label: ko ? "클라우드" : "Cloud" },
    { key: "hub", label: ko ? "허브 · 북마크" : "Hub · bookmarks" },
  ];

  // 멀티 = 회사(firm) 계층만. 싱글 = 회사에 속하지 않은 개별 에이전트만. (두 모드는 서로 겹치지 않음 → 중복 없음)
  function bySource(src: Source) {
    const f = mode === "multi" ? firms.filter((x) => firmSource(x) === src) : [];
    const indiv =
      mode === "single"
        ? agents.filter((a) => agentSource(a) === src && !firmAgentIds.has(a.id))
        : [];
    return { firms: f, agents: indiv };
  }

  if (loading) {
    return (
      <Shell mode={mode} setMode={setMode} query={query} setQuery={setQuery} onImport={importFolder} busy={busy} ko={ko} importMessage={importMessage}>
        <div className="dashboard-org-empty">
          {ko ? "불러오는 중…" : "Loading…"}
        </div>
      </Shell>
    );
  }

  return (
    <Shell mode={mode} setMode={setMode} query={query} setQuery={setQuery} onImport={importFolder} busy={busy} ko={ko} importMessage={importMessage}>
      <div className="dashboard-org-list">
        {cats.map((cat) => {
          const { firms: cf, agents: ca } = bySource(cat.key);
          // 클라우드 카테고리(싱글 모드)엔 로컬에 아직 안 받은 서버 클라우드 에이전트도 함께 보여준다.
          const installedSlugs = new Set(agents.map((a) => a.slug));
          const cloudOnly =
            cat.key === "cloud" && mode === "single"
              ? cloudListings.filter((m) => !installedSlugs.has(m.slug) && matches(ko ? m.name : m.nameEn || m.name))
              : [];
          const count = cf.length + ca.length + cloudOnly.length;
          const open = openCats[cat.key];
          return (
            <div key={cat.key}>
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

              {open && cat.key === "hub" && (
                <div className="dashboard-org-empty dashboard-org-nested">
                  {ko ? "북마크한 허브 에이전트가 여기 모입니다." : "Bookmarked hub agents appear here."}
                </div>
              )}

              {open &&
                cf.filter((f) => matches(dn(f))).map((f) => (
                  <div key={f.id}>
                    <button
                      onClick={() => void toggleFirm(f.id)}
                      className="dashboard-org-row dashboard-org-firm"
                    >
                      <Chevron open={!!openFirms[f.id]} small />
                      <IconBuilding size={13} />
                      <span className="dashboard-org-label">
                        {dn(f)}
                      </span>
                    </button>
                    {openFirms[f.id] && <FirmBody org={orgs[f.id]} firmId={f.id} ko={ko} />}
                  </div>
                ))}

              {open &&
                ca.filter((a) => matches(dn(a))).map((a) => (
                  <button
                    key={a.id}
                    onClick={() => navigate(agentLibraryRoute({ agentId: a.id }))}
                    className="dashboard-org-row dashboard-org-agent"
                  >
                    <Dot />
                    <span className="dashboard-org-label">{dn(a)}</span>
                  </button>
                ))}

              {open &&
                cloudOnly.map((m) => (
                  <button
                    key={`cloud:${m.slug}`}
                    onClick={() => navigate("/cloud")}
                    className="dashboard-org-row dashboard-org-agent"
                    title={ko ? "서버 클라우드에 있는 에이전트 — 클라우드에서 관리" : "On your server cloud — manage in Cloud"}
                  >
                    <Dot />
                    <span className="dashboard-org-label">{ko ? m.name : m.nameEn || m.name}</span>
                    <span className="dashboard-org-count">{ko ? "클라우드" : "cloud"}</span>
                  </button>
                ))}
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
  ko,
  importMessage,
}: {
  children: React.ReactNode;
  mode: Mode;
  setMode: (m: Mode) => void;
  query: string;
  setQuery: (s: string) => void;
  onImport: () => void;
  busy: boolean;
  ko: boolean;
  importMessage?: { tone: "ok" | "error"; text: string } | null;
}) {
  return (
    <aside
      className="dashboard-org-tree"
    >
      <div className="dashboard-org-title">
        <span>{ko ? "조직도" : "Org chart"}</span>
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
            {m === "multi" ? (ko ? "멀티" : "Multi") : ko ? "싱글" : "Single"}
          </button>
        ))}
      </div>
      <label className="dashboard-org-search">
        <IconSearch size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={ko ? "조직·에이전트 검색" : "Search org, agents"}
        />
      </label>
      <button
        onClick={onImport}
        disabled={busy}
        className="titlebar-nodrag"
        data-dashboard-import="true"
      >
        <IconFileUp size={14} />
        {busy ? (ko ? "가져오는 중…" : "Importing…") : ko ? "에이전트 가져오기" : "Import agents"}
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
function FirmBody({ org, firmId, ko }: { org: ResolvedOrg | null | undefined; firmId: string; ko: boolean }) {
  if (org === undefined) {
    return (
      <div className="dashboard-org-empty dashboard-org-deep">
        {ko ? "불러오는 중…" : "Loading…"}
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
        {ko ? "구성원 없음" : "No members"}
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
