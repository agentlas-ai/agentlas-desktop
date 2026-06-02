// 마켓플레이스 — Codex 데스크톱의 플러그인/스킬 마켓 디자인을 따른다.
// 구조:
//   상단 탭 좌측: 회사 / 번들 / 에이전트   |   우측: 관리 · 만들기
//   가운데 큰 타이틀: "원하는 방식으로 Agentlas를 활용하세요"
//   검색바 + 페르소나 필터
//   추천 히어로 카드 (회전, 글래스)
//   Featured: 2-col 카드 그리드 (왼쪽: 아이콘+이름+설명, 우측: 설치 상태)
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
  MarketplaceListing,
  MarketplaceSourceStatus,
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
  IconPlus,
  IconSearch,
  IconSettings,
  IconShoppingBag,
  IconSparkles,
  IconUsers,
  IconWand,
} from "@/components/Icon";

type Tab = "firms" | "bundles" | "agents";
type Persona = "all" | "쇼핑몰" | "마케터" | "부동산" | "크리에이터";

const PERSONA_ICONS: Record<Persona, React.ReactNode> = {
  all: <IconSparkles size={12} />,
  쇼핑몰: <IconShoppingBag size={12} />,
  마케터: <IconMegaphone size={12} />,
  부동산: <IconHome size={12} />,
  크리에이터: <IconFilm size={12} />,
};

const PERSONA_T_KEY: Record<Persona, "persona.all" | "persona.shop" | "persona.marketer" | "persona.realestate" | "persona.creator"> = {
  all: "persona.all",
  쇼핑몰: "persona.shop",
  마케터: "persona.marketer",
  부동산: "persona.realestate",
  크리에이터: "persona.creator",
};
const PERSONA_IDS: Persona[] = ["all", "쇼핑몰", "마케터", "부동산", "크리에이터"];

const PERSONA_PREFIX: Record<Exclude<Persona, "all">, string> = {
  쇼핑몰: "shop-",
  마케터: "marketer-",
  부동산: "realestate-",
  크리에이터: "creator-",
};

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
  const initialTab = (searchParams.get("tab") as Tab) || "firms";
  const [tab, setTab] = useState<Tab>(initialTab);

  const TABS: { id: Tab; label: string }[] = [
    { id: "firms", label: t("market.tab.firms") },
    { id: "bundles", label: t("market.tab.bundles") },
    { id: "agents", label: t("market.tab.agents") },
  ];
  const [bundles, setBundles] = useState<TeamBundle[]>([]);
  const [firms, setFirms] = useState<FirmListing[]>([]);
  const [installedFirms, setInstalledFirms] = useState<InstalledFirm[]>([]);
  const [importing, setImporting] = useState(false);
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [installedAgentSlugs, setInstalledAgentSlugs] = useState<Set<string>>(new Set());
  const [sourceStatus, setSourceStatus] = useState<MarketplaceSourceStatus | null>(null);
  const [q, setQ] = useState("");
  const [persona, setPersona] = useState<Persona>("all");
  const [installing, setInstalling] = useState<string | null>(null);
  const [heroIdx, setHeroIdx] = useState(0);
  // 로그인 세션 — marketplace install은 로그인 필수 (서버에 사용자 묶음 동기화 필요).
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  // 로그인 가드 — 미로그인이면 BrowserWindow 로그인 흐름을 띄우고 결과를 반환.
  // true면 진행해도 OK, false면 사용자가 로그인 취소했으니 install 중단.
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
    const [bd, sf, lf, ls, ag, status, session] = await Promise.all([
      api.marketplace.listBundles(),
      api.marketplace.listFirms(),
      api.firms.list(),
      api.marketplace.search(""),
      api.team.list(),
      api.marketplace.status(),
      api.auth.getSession(),
    ]);
    setBundles(bd);
    setFirms(sf);
    setInstalledFirms(lf);
    setListings(ls);
    setInstalledAgentSlugs(new Set(ag.map((a) => a.slug)));
    setSourceStatus(status);
    setSignedIn(session.signedIn);
  }

  // 로컬 폴더에서 회사/에이전트 임포트 — Agents 화면과 동일하게 마켓에서도 가능.
  // 팀으로 감지되면 firms에 등록되므로 그 회사 상세로 이동한다.
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
      setTab("agents");
      router.replace("/marketplace?tab=agents");
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

  // 히어로 자동 회전 — 5초마다
  const heroItems = useMemo(() => firms.slice(0, 4), [firms]);
  useEffect(() => {
    if (heroItems.length === 0) return;
    const t = setInterval(() => setHeroIdx((i) => (i + 1) % heroItems.length), 5000);
    return () => clearInterval(t);
  }, [heroItems.length]);

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

  const filteredFirms = persona === "all" ? firms : firms.filter((f) => f.persona === persona);
  const filteredBundles = persona === "all" ? bundles : bundles.filter((b) => b.persona === persona);
  const filteredListings = useMemo(() => {
    const base = persona === "all"
      ? listings
      : listings.filter((l) => l.slug.startsWith(PERSONA_PREFIX[persona]));
    if (!q.trim()) return base;
    const needle = q.toLowerCase();
    return base.filter(
      (l) => l.name.toLowerCase().includes(needle) || l.tagline.toLowerCase().includes(needle),
    );
  }, [listings, persona, q]);

  return (
    <div
      style={{
        flex: 1,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "transparent",
      }}
    >
      {/* ── 상단 바: 탭 좌측 + 관리/만들기 우측 ───────── */}
      <header
        className="titlebar-drag glass-thin"
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 16px 0 90px",
          minHeight: 44,
          borderBottom: "1px solid var(--glass-border)",
          flexShrink: 0,
        }}
      >
        <nav
          className="titlebar-nodrag"
          style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}
        >
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => {
                  setTab(t.id);
                  router.replace(`/marketplace?tab=${t.id}`);
                }}
                style={{
                  padding: "5px 11px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                  color: active ? "var(--ink)" : "var(--muted-deep)",
                  background: active ? "var(--paper)" : "transparent",
                  boxShadow: active
                    ? "0 1px 0 rgba(11,11,15,0.04), 0 1px 2px rgba(11,11,15,0.04)"
                    : "none",
                  border: active ? "1px solid var(--paper-edge)" : "1px solid transparent",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
        <div
          className="titlebar-nodrag"
          style={{ display: "flex", alignItems: "center", gap: 4 }}
        >
          <button
            onClick={() => void importLocalFolderFromMarket()}
            disabled={importing}
            title={t("library.agents.import_local_hint")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "5px 11px",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              color: "var(--ink-soft)",
              background: "var(--paper)",
              border: "1px solid var(--paper-edge)",
              boxShadow: "0 1px 0 rgba(11,11,15,0.04)",
              cursor: importing ? "default" : "pointer",
              opacity: importing ? 0.6 : 1,
            }}
          >
            <IconFolder size={12} />
            {importing ? t("import.importing") : t("library.agents.import_local")}
          </button>
          <Link
            href="/apps"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "5px 11px",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              color: "var(--ink-soft)",
              background: "var(--paper)",
              border: "1px solid var(--paper-edge)",
              boxShadow: "0 1px 0 rgba(11,11,15,0.04)",
              textDecoration: "none",
            }}
          >
            <IconSettings size={12} />
            {t("market.btn.manage")}
          </Link>
          <Link
            href="https://agentlas.cloud/build"
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "5px 11px",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              color: "var(--ink-soft)",
              background: "var(--paper)",
              border: "1px solid var(--paper-edge)",
              boxShadow: "0 1px 0 rgba(11,11,15,0.04)",
              textDecoration: "none",
            }}
          >
            {t("market.btn.create")}
            <IconChevronRight size={11} />
          </Link>
          <button
            aria-label={t("generic.more")}
            style={{
              padding: 6,
              borderRadius: 6,
              color: "var(--ink-soft)",
              background: "transparent",
            }}
          >
            <IconMoreHorizontal size={14} />
          </button>
        </div>
      </header>

      {signedIn === false && (
        <div
          className="titlebar-nodrag"
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 16px",
            background: "var(--paper-2)",
            borderBottom: "1px solid var(--paper-edge)",
            fontSize: 12,
            color: "var(--ink-soft)",
          }}
        >
          <span style={{ flex: 1 }}>
            <strong style={{ color: "var(--ink)", fontWeight: 600 }}>
              {t("account.required.title")}
            </strong>
            <span style={{ marginLeft: 8 }}>{t("account.required.body")}</span>
          </span>
          <button
            onClick={() => void ensureSignedIn()}
            style={{
              padding: "5px 12px",
              borderRadius: 999,
              background: "var(--paper)",
              color: "var(--ink)",
              fontSize: 12,
              fontWeight: 600,
              border: "1px solid var(--paper-edge)",
              boxShadow: "var(--neu-raised)",
              cursor: "pointer",
            }}
          >
            {t("account.sign_in")}
          </button>
        </div>
      )}

      {/* ── 본문 스크롤 ─────────────────────────────── */}
      <div
        className="titlebar-nodrag"
        style={{ flex: 1, overflowY: "auto", padding: "0 0 60px" }}
      >
        <div style={{ maxWidth: 840, margin: "0 auto", padding: "48px 32px 0" }}>
          <h1
            style={{
              textAlign: "center",
              fontFamily: "var(--font-head)",
              fontSize: 26,
              fontWeight: 600,
              margin: 0,
              letterSpacing: -0.5,
              color: "var(--ink)",
            }}
          >
            {t("market.title.before")}{" "}
            <span style={{ color: "var(--accent)" }}>Agentlas</span>
            {t("market.title.after")}
          </h1>

          {/* 검색 + 필터 */}
          <div style={{ marginTop: 24, display: "flex", gap: 8, alignItems: "center" }}>
            <div
              className="glass-strong"
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "9px 14px",
                borderRadius: 999,
              }}
            >
              <IconSearch size={14} color="var(--muted-deep)" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={
                  tab === "firms"
                    ? t("market.search.firms")
                    : tab === "bundles"
                    ? t("market.search.bundles")
                    : t("market.search.agents")
                }
                style={{
                  flex: 1,
                  border: "none",
                  outline: "none",
                  fontSize: 13,
                  background: "transparent",
                  color: "var(--ink)",
                }}
              />
            </div>
            <PersonaSelect persona={persona} setPersona={setPersona} t={t} />
          </div>

          {sourceStatus?.usingFallback && (
            <div
              role="status"
              style={{
                marginTop: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "9px 12px",
                borderRadius: 8,
                background: "var(--paper-2)",
                border: "1px solid rgba(181, 87, 46, 0.2)",
                color: "var(--ink-soft)",
                fontSize: 11.5,
                lineHeight: 1.35,
              }}
            >
              <span style={{ minWidth: 0 }}>
                {locale === "ko"
                  ? "Agentlas MCP에 연결하지 못해 오프라인 캐시를 보여주고 있어요."
                  : "Showing offline cache because Agentlas MCP is unreachable."}
              </span>
              <button
                onClick={() => void refresh()}
                style={{
                  flexShrink: 0,
                  border: "1px solid var(--paper-edge)",
                  background: "var(--paper)",
                  borderRadius: 6,
                  padding: "4px 8px",
                  color: "var(--ink)",
                  fontSize: 11.5,
                  fontWeight: 600,
                }}
              >
                {locale === "ko" ? "다시 연결" : "Retry"}
              </button>
            </div>
          )}

          {/* 추천 히어로 카드 */}
          {heroItems.length > 0 && (
            <HeroCard
              firm={heroItems[heroIdx]}
              locale={locale}
              installed={installedFirmSlugs.has(heroItems[heroIdx].slug)}
              installLabel={t("market.hero.install")}
              chatLabel={t("market.hero.chat")}
              onInstall={() => void installFirm(heroItems[heroIdx])}
              onSeeChat={() => router.push("/")}
              total={heroItems.length}
              activeIdx={heroIdx}
              onSelect={setHeroIdx}
            />
          )}
        </div>

        <div style={{ maxWidth: 840, margin: "0 auto", padding: "0 32px" }}>
          {tab === "firms" && (
            <Section
              title={t("market.section.recommended_firms")}
              empty={filteredFirms.length === 0 ? t("market.empty_firms") : undefined}
            >
              {filteredFirms.map((firm) => (
                <FirmRow
                  key={firm.slug}
                  firm={firm}
                  locale={locale}
                  installed={installedFirmSlugs.has(firm.slug)}
                  installing={installing === firm.slug}
                  onInstall={() => void installFirm(firm)}
                  onOpen={() => {
                    const inst = installedFirms.find((f) => f.slug === firm.slug);
                    if (inst) navigate(`/firm/detail?id=${inst.id}`);
                  }}
                />
              ))}
            </Section>
          )}

          {tab === "bundles" && (
            <Section
              title={t("market.section.recommended_bundles")}
              empty={filteredBundles.length === 0 ? t("market.empty_bundles") : undefined}
            >
              {filteredBundles.map((b) => (
                <BundleRow
                  key={b.id}
                  bundle={b}
                  locale={locale}
                  installing={installing === b.id}
                  onInstall={() => void installBundle(b)}
                />
              ))}
            </Section>
          )}

          {tab === "agents" && (
            <Section
              title={t("market.section.recommended_agents")}
              empty={filteredListings.length === 0 ? t("market.empty_agents") : undefined}
            >
              {filteredListings.map((l) => (
                <AgentRow
                  key={l.slug}
                  listing={l}
                  locale={locale}
                  installed={installedAgentSlugs.has(l.slug)}
                  installing={installing === l.slug}
                  onInstall={() => void installOne(l.slug)}
                />
              ))}
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 페르소나 드롭다운 ────────────────────────────────
type PersonaT = (typeof PERSONA_T_KEY)[Persona];
function PersonaSelect({
  persona,
  setPersona,
  t,
}: {
  persona: Persona;
  setPersona: (p: Persona) => void;
  t: (k: PersonaT) => string;
}) {
  return (
    <label
      className="glass-strong"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 14px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: "var(--ink-soft)",
        position: "relative",
        cursor: "pointer",
      }}
    >
      {PERSONA_ICONS[persona]}
      <span>{t(PERSONA_T_KEY[persona])}</span>
      <IconChevronRight size={10} style={{ transform: "rotate(90deg)" }} />
      <select
        value={persona}
        onChange={(e) => setPersona(e.target.value as Persona)}
        style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
      >
        {PERSONA_IDS.map((p) => (
          <option key={p} value={p}>
            {t(PERSONA_T_KEY[p])}
          </option>
        ))}
      </select>
    </label>
  );
}

// ── 히어로 카드 (Codex 스크린샷의 보라 카드 자리) ────────────
function HeroCard({
  firm,
  locale,
  installed,
  installLabel,
  chatLabel,
  onInstall,
  onSeeChat,
  total,
  activeIdx,
  onSelect,
}: {
  firm: FirmListing;
  locale: Locale;
  installed: boolean;
  installLabel: string;
  chatLabel: string;
  onInstall: () => void;
  onSeeChat: () => void;
  total: number;
  activeIdx: number;
  onSelect: (i: number) => void;
}) {
  const loc = pickLocalized(firm, locale);
  return (
    <article
      className="glass-lift"
      style={{
        marginTop: 28,
        borderRadius: var_radius_xl(),
        padding: 28,
        position: "relative",
        overflow: "hidden",
        minHeight: 200,
        background:
          "linear-gradient(135deg, rgba(202, 198, 250, 0.55) 0%, rgba(255, 214, 198, 0.45) 50%, rgba(168, 217, 155, 0.4) 100%)",
        backdropFilter: "saturate(160%) blur(20px)",
        WebkitBackdropFilter: "saturate(160%) blur(20px)",
        border: "1px solid var(--glass-border)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
          minHeight: 160,
        }}
      >
        <div
          className="glass-strong"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 16px",
            borderRadius: 999,
          }}
        >
          <IconBuilding size={14} style={{ color: "var(--accent)" }} />
          <span style={{ fontWeight: 600, fontSize: 13, color: "var(--ink)" }}>
            {loc.name}
          </span>
          <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
            {loc.tagline}
          </span>
        </div>
        <button
          onClick={installed ? onSeeChat : onInstall}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 18px",
            borderRadius: 999,
            background: "var(--paper)",
            color: "var(--ink)",
            fontWeight: 600,
            fontSize: 12.5,
            border: "1px solid var(--paper-edge)",
            boxShadow: "var(--neu-raised)",
          }}
        >
          {installed ? (
            <>
              <IconChat size={14} />
              {chatLabel}
            </>
          ) : (
            <>
              <IconPlus size={14} />
              {installLabel}
            </>
          )}
        </button>
      </div>
      {/* 인디케이터 — 우측 점 */}
      <div
        style={{
          position: "absolute",
          right: 16,
          top: "50%",
          transform: "translateY(-50%)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {Array.from({ length: total }).map((_, i) => (
          <button
            key={i}
            onClick={() => onSelect(i)}
            aria-label={`히어로 ${i + 1}`}
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: i === activeIdx ? "var(--ink)" : "var(--paper-edge)",
              border: "none",
              padding: 0,
              cursor: "pointer",
            }}
          />
        ))}
      </div>
    </article>
  );
}

function var_radius_xl() {
  return "var(--radius-xl)";
}

// ── 섹션 헤더 + children ───────────────────────────────
function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: 36 }}>
      <h2
        style={{
          fontFamily: "var(--font-head)",
          fontSize: 13,
          fontWeight: 600,
          color: "var(--ink-soft)",
          margin: "0 0 12px",
          paddingBottom: 8,
          borderBottom: "1px solid var(--glass-border)",
        }}
      >
        {title}
      </h2>
      {empty ? (
        <div
          style={{
            padding: "40px 24px",
            textAlign: "center",
            color: "var(--muted-deep)",
            fontSize: 13,
          }}
        >
          {empty}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            columnGap: 32,
            rowGap: 0,
          }}
        >
          {children}
        </div>
      )}
    </section>
  );
}

// ── 카드 row (Codex 스크린샷의 2-col 그리드 행) ──────────
function Row({
  iconBox,
  title,
  subtitle,
  right,
  onClick,
}: {
  iconBox: React.ReactNode;
  title: string;
  subtitle: string;
  right: React.ReactNode;
  onClick?: () => void;
}) {
  // right slot에 actionable button(InstallChip)이 들어오므로 외곽은 <div role="button">로 둠.
  // <button> 안 <button> 중첩은 React hydration 에러.
  const interactive = Boolean(onClick);
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 4px",
        background: "transparent",
        border: "none",
        borderRadius: 0,
        textAlign: "left",
        cursor: interactive ? "pointer" : "default",
        width: "100%",
      }}
    >
      <span
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {iconBox}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--muted-deep)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            marginTop: 2,
          }}
        >
          {subtitle}
        </div>
      </div>
      <div style={{ flexShrink: 0 }}>{right}</div>
    </div>
  );
}

function FirmRow({
  firm,
  locale,
  installed,
  installing,
  onInstall,
  onOpen,
}: {
  firm: FirmListing;
  locale: Locale;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
  onOpen: () => void;
}) {
  const loc = pickLocalized(firm, locale);
  return (
    <Row
      onClick={installed ? onOpen : undefined}
      iconBox={
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background:
              "linear-gradient(135deg, rgba(202,198,250,0.7) 0%, rgba(255,214,198,0.6) 100%)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ink)",
          }}
        >
          <IconBuilding size={16} />
        </span>
      }
      title={loc.name}
      subtitle={loc.tagline}
      right={<InstallChip installed={installed} installing={installing} onInstall={onInstall} />}
    />
  );
}

function BundleRow({
  bundle,
  locale,
  installing,
  onInstall,
}: {
  bundle: TeamBundle;
  locale: Locale;
  installing: boolean;
  onInstall: () => void;
}) {
  const loc = pickLocalized(bundle, locale);
  return (
    <Row
      onClick={onInstall}
      iconBox={
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: "var(--fill-1)",
            color: "var(--accent)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <IconUsers size={16} />
        </span>
      }
      title={loc.name}
      subtitle={loc.tagline}
      right={<InstallChip installed={false} installing={installing} onInstall={onInstall} />}
    />
  );
}

function AgentRow({
  listing,
  locale,
  installed,
  installing,
  onInstall,
}: {
  listing: MarketplaceListing;
  locale: Locale;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  const loc = pickLocalized(listing, locale);
  return (
    <Row
      onClick={installed ? undefined : onInstall}
      iconBox={
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: "var(--fill-1)",
            color: "var(--accent)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <IconWand size={15} />
        </span>
      }
      title={loc.name}
      subtitle={loc.tagline}
      right={<InstallChip installed={installed} installing={installing} onInstall={onInstall} />}
    />
  );
}

function InstallChip({
  installed,
  installing,
  onInstall,
}: {
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  const { t } = useT();
  if (installed) {
    return (
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--green-deep)",
        }}
        aria-label={t("generic.installed")}
        title={t("generic.installed")}
      >
        <IconCheck size={15} />
      </span>
    );
  }
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (!installing) onInstall();
      }}
      disabled={installing}
      aria-label={t("generic.install")}
      title={t("generic.install")}
      style={{
        width: 28,
        height: 28,
        borderRadius: "50%",
        background: "var(--paper-2)",
        border: "1px solid var(--paper-edge)",
        color: "var(--ink-soft)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: installing ? "default" : "pointer",
      }}
    >
      <IconPlus size={14} />
    </button>
  );
}
