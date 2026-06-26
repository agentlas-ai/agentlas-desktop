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
import { IconBuilding } from "@/components/Icon";
import type { InstalledAgent, InstalledFirm, ResolvedOrg } from "@/lib/types";

type Mode = "multi" | "single";
type Source = "local" | "cloud" | "hub";

const ROW = { display: "flex", alignItems: "center", gap: 6 } as const;

// 시스템/인프라 에이전트(오케스트레이터·PM 소울·큐레이터·메타에이전트·앱빌더·마켓 패키저 등)는 로스터에서 숨긴다.
// visibility가 "background"뿐 아니라 "private"(web-only 제어 에이전트)인 경우도 있어 둘 다 거르고, slug 패턴도 함께 차단.
const SYSTEM_SLUG_RE =
  /(orchestrator|pm-soul|memory-curator|task-bias|meta-agent|app-builder|marketplace-packager|packager|governance)/i;

// 회사 안에 주입되는 표준 인프라 역할(이름/역할 텍스트 기준): 오케스트레이터·PM 소울·메모리 큐레이터·
// 폴리시 게이트·Eval QA·태스크 바이어스·메타에이전트·앱 빌더·마켓 패키저. 비즈니스 에이전트는 매칭 안 됨.
const SYSTEM_NODE_RE =
  /(orchestrator|pm[\s-]?soul|memory[\s-]?curator|policy[\s-]?gate|eval[\s-]?qa|task[\s-]?bias|meta[\s-]?agent|app[\s-]?builder|marketplace[\s-]?packager|governance)/i;

/** 이름/역할 텍스트로 시스템·인프라 노드 판별 (resolvedOrg 노드용 — slug 없음). */
function isSystemNode(name?: string | null, role?: string | null): boolean {
  return SYSTEM_NODE_RE.test(`${name ?? ""} ${role ?? ""}`);
}

function isRosterAgent(a: InstalledAgent): boolean {
  if (a.visibility === "background" || a.visibility === "private") return false;
  if (SYSTEM_SLUG_RE.test(a.slug)) return false;
  if (isSystemNode(a.name, a.nameEn)) return false;
  if ((a.kind ?? "agent") === "team") return false;
  return true;
}

function dedupById(list: InstalledAgent[]): InstalledAgent[] {
  return Array.from(new Map(list.map((a) => [a.id, a])).values());
}

export function OrgTree() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [mode, setMode] = useState<Mode>("multi");
  const [query, setQuery] = useState("");
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
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
    const [a, f] = await Promise.all([api.team.list(), api.firms.list()]);
    setAgents(dedupById(a).filter(isRosterAgent));
    setFirms(f);
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
  const firmSource = (f: InstalledFirm): Source =>
    agentById.get(f.ceoAgentId)?.localPath ? "local" : "cloud";

  const matches = (name: string) =>
    !query.trim() || name.toLowerCase().includes(query.trim().toLowerCase());

  async function importFolder() {
    const api = ipc();
    if (!api || busy) return;
    setBusy(true);
    try {
      const dir = await api.fs.pickDirectory();
      if (dir) {
        await api.team.importLocalFolder(dir);
        await load();
      }
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
      <Shell mode={mode} setMode={setMode} query={query} setQuery={setQuery} onImport={importFolder} busy={busy} ko={ko}>
        <div style={{ padding: "14px 4px", fontSize: 12, color: "var(--muted-deep)" }}>
          {ko ? "불러오는 중…" : "Loading…"}
        </div>
      </Shell>
    );
  }

  return (
    <Shell mode={mode} setMode={setMode} query={query} setQuery={setQuery} onImport={importFolder} busy={busy} ko={ko}>
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {cats.map((cat) => {
          const { firms: cf, agents: ca } = bySource(cat.key);
          const count = cf.length + ca.length;
          const open = openCats[cat.key];
          return (
            <div key={cat.key}>
              <button
                onClick={() => setOpenCats((p) => ({ ...p, [cat.key]: !p[cat.key] }))}
                style={{ ...ROW, width: "100%", padding: "6px 3px", background: "transparent", border: "none", cursor: "pointer" }}
              >
                <Chevron open={open} />
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)", flex: 1, textAlign: "left" }}>
                  {cat.label}
                </span>
                <span style={{ fontSize: 10.5, color: "var(--muted-deep)", fontFamily: "var(--font-mono)" }}>{count}</span>
              </button>

              {open && cat.key === "hub" && (
                <div style={{ padding: "4px 3px 8px 24px", fontSize: 11, color: "var(--muted-deep)" }}>
                  {ko ? "북마크한 허브 에이전트가 여기 모입니다." : "Bookmarked hub agents appear here."}
                </div>
              )}

              {open &&
                cf.filter((f) => matches(dn(f))).map((f) => (
                  <div key={f.id}>
                    <button
                      onClick={() => void toggleFirm(f.id)}
                      style={{ ...ROW, width: "100%", padding: "4px 3px 4px 15px", background: "transparent", border: "none", cursor: "pointer" }}
                    >
                      <Chevron open={!!openFirms[f.id]} small />
                      <IconBuilding size={13} style={{ color: "var(--accent)" }} />
                      <span style={{ fontSize: 12, fontWeight: 500, color: "var(--ink)", flex: 1, textAlign: "left" }}>
                        {dn(f)}
                      </span>
                    </button>
                    {openFirms[f.id] && <FirmBody org={orgs[f.id]} ko={ko} />}
                  </div>
                ))}

              {open &&
                ca.filter((a) => matches(dn(a))).map((a) => (
                  <button
                    key={a.id}
                    onClick={() => navigate("/")}
                    style={{ ...ROW, gap: 7, width: "100%", padding: "3px 3px 3px 24px", background: "transparent", border: "none", cursor: "pointer" }}
                  >
                    <Dot />
                    <span style={{ fontSize: 11.5, color: "var(--ink)", flex: 1, textAlign: "left" }}>{dn(a)}</span>
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
}: {
  children: React.ReactNode;
  mode: Mode;
  setMode: (m: Mode) => void;
  query: string;
  setQuery: (s: string) => void;
  onImport: () => void;
  busy: boolean;
  ko: boolean;
}) {
  return (
    <aside
      style={{
        background: "var(--paper-2)",
        border: "1px solid var(--paper-edge)",
        borderRadius: 12,
        padding: 11,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", gap: 4, background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: 8, padding: 3 }}>
        {(["multi", "single"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              flex: 1,
              fontSize: 12,
              padding: "4px 0",
              borderRadius: 5,
              border: "none",
              cursor: "pointer",
              fontWeight: mode === m ? 600 : 400,
              background: mode === m ? "var(--paper-2)" : "transparent",
              color: mode === m ? "var(--ink)" : "var(--muted-deep)",
            }}
          >
            {m === "multi" ? (ko ? "멀티" : "Multi") : ko ? "싱글" : "Single"}
          </button>
        ))}
      </div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={ko ? "조직·에이전트 검색" : "Search org, agents"}
        style={{
          height: 31,
          padding: "0 10px",
          fontSize: 12,
          background: "var(--paper-2)",
          border: "1px solid var(--paper-edge)",
          borderRadius: 8,
          color: "var(--ink)",
        }}
      />
      <button
        onClick={onImport}
        disabled={busy}
        className="titlebar-nodrag"
        style={{
          height: 32,
          fontSize: 12,
          borderRadius: 8,
          border: "1px solid var(--accent)",
          color: "var(--accent)",
          background: "transparent",
          cursor: busy ? "default" : "pointer",
          fontWeight: 600,
        }}
      >
        {busy ? (ko ? "가져오는 중…" : "Importing…") : ko ? "에이전트 가져오기" : "Import agents"}
      </button>
      {children}
    </aside>
  );
}

function Chevron({ open, small }: { open: boolean; small?: boolean }) {
  return (
    <span
      style={{
        fontSize: small ? 9 : 10,
        color: "var(--muted-deep)",
        display: "inline-block",
        width: 10,
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform .15s",
      }}
    >
      ▶
    </span>
  );
}

function Dot() {
  return <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--muted-deep)", flexShrink: 0 }} />;
}

// 회사 하위 구조 렌더 — 분류 규칙:
//   · 시스템/인프라 노드(오케스트레이터·PM 소울·큐레이터·폴리시게이트·Eval QA 등)는 제거.
//   · 본부(division)에 하위 에이전트(specialists)가 있을 때만 "HQ"로 표시하고 그 아래 에이전트를 분해.
//   · 하위가 없는 노드는 HQ가 아니라 회사 직속 "에이전트"로 표시(HQ 태그 없음).
function FirmBody({ org, ko }: { org: ResolvedOrg | null | undefined; ko: boolean }) {
  if (org === undefined) {
    return (
      <div style={{ padding: "3px 3px 3px 30px", fontSize: 11, color: "var(--muted-deep)" }}>
        {ko ? "불러오는 중…" : "Loading…"}
      </div>
    );
  }
  const hqs: Array<{ id: string; name: string; agents: Array<{ id: string; name: string }> }> = [];
  const direct: Array<{ id: string; name: string }> = [];
  for (const div of org?.divisions ?? []) {
    if (isSystemNode(div.name, div.role)) continue;
    const specs = div.specialists.filter((s) => !isSystemNode(s.name, s.role));
    if (specs.length > 0) {
      hqs.push({ id: div.id, name: div.name, agents: specs.map((s) => ({ id: s.id, name: s.name })) });
    } else {
      direct.push({ id: div.id, name: div.name });
    }
  }
  if (hqs.length === 0 && direct.length === 0) {
    return (
      <div style={{ padding: "3px 3px 3px 30px", fontSize: 11, color: "var(--muted-deep)" }}>
        {ko ? "구성원 없음" : "No members"}
      </div>
    );
  }
  return (
    <>
      {hqs.map((hq) => (
        <div key={hq.id}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 3px 3px 30px" }}>
            <span style={{ fontSize: 11.5, color: "var(--muted-deep)", flex: 1 }}>{hq.name}</span>
            <span style={{ fontSize: 9.5, color: "var(--muted-deep)", fontFamily: "var(--font-mono)" }}>HQ</span>
          </div>
          {hq.agents.map((a) => (
            <button
              key={a.id}
              onClick={() => navigate("/")}
              style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "3px 3px 3px 44px", background: "transparent", border: "none", cursor: "pointer" }}
            >
              <Dot />
              <span style={{ fontSize: 11.5, color: "var(--ink)", flex: 1, textAlign: "left" }}>{a.name}</span>
            </button>
          ))}
        </div>
      ))}
      {direct.map((a) => (
        <button
          key={a.id}
          onClick={() => navigate("/")}
          style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "3px 3px 3px 30px", background: "transparent", border: "none", cursor: "pointer" }}
        >
          <Dot />
          <span style={{ fontSize: 11.5, color: "var(--ink)", flex: 1, textAlign: "left" }}>{a.name}</span>
        </button>
      ))}
    </>
  );
}
