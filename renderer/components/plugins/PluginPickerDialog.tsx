"use client";

// MCP·플러그인 고르기 팝업 — 온보딩과 설정이 같은 화면을 쓴다.
//
// 왜 팝업인가: 예전에는 "MCP 추가"가 마켓플레이스 화면으로 **나가는** 문이었다. 도구를
// 하나 붙이려던 사람이 에이전트·팀·그래프가 섞인 장터로 튕겨 나가 자기가 뭘 하려 했는지
// 잃어버렸고, 돌아오는 길도 스스로 찾아야 했다. 고르는 일은 원래 있던 자리에서 끝나야
// 한다 — 그래서 이 화면은 라우팅하지 않고 그 자리에 뜬다.
//
// 두 가지를 지킨다:
//  · 복수 선택. 도구는 보통 한 번에 여러 개를 켠다.
//  · 키는 나중에 넣어도 된다. 지금 API 키가 없다는 이유로 설치 자체를 막으면, 사용자는
//    키를 찾으러 갔다가 이 화면으로 다시 돌아오지 못한다. 등록은 지금 하고 키는 남겨 둔다
//    (미입력 서버는 MCP 화면에 "키 필요"로 남아 스스로를 설명한다).
//
// 경계: 키 "값"은 이 컴포넌트를 지나 곧바로 env.set(키체인 vault)으로만 간다. 설치 IPC는
// 값을 싣지 않는다 — 값을 나르는 유일한 통로는 vault 하나다.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { PluginLogo, usePluginBrandMap, pluginSlugCandidates } from "@/components/PluginLogo";
import type {
  BrowserSite,
  InstalledMcpServer,
  MarketplaceListing,
  PluginAuthKind,
  PluginKind,
} from "@/lib/types";
import styles from "./PluginPickerDialog.module.css";

/** 온보딩 첫 화면이 보여주는 최대 개수. 나머지는 "더 찾아보기"가 맡는다. */
const ONBOARDING_VISIBLE = 12;

type TypeFilter = "all" | PluginKind;
type OwnershipFilter = "all" | "installed" | "not-installed";

export interface PluginPickerResult {
  /** 이번에 실제로 서버가 등록된 플러그인. */
  installed: string[];
  /** 고르긴 했지만 붙일 서버가 없거나 실패한 항목 — 조용히 성공으로 위장하지 않는다. */
  skipped: Array<{ slug: string; reason: string }>;
  /** 사용자가 "나중에 입력"을 고른 환경변수 이름들. 값은 담지 않는다. */
  deferredKeys: string[];
}

export function PluginPickerDialog({
  ko,
  variant = "browse",
  onClose,
  onCompleted,
}: {
  ko: boolean;
  /** onboarding이면 대표 항목만 먼저 보이고 "더 찾아보기"로 전체를 편다. */
  variant?: "browse" | "onboarding";
  onClose: () => void;
  onCompleted?: (result: PluginPickerResult) => void;
}) {
  const api = ipc();
  const brandMap = usePluginBrandMap();

  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [installed, setInstalled] = useState<InstalledMcpServer[]>([]);
  const [linkedSites, setLinkedSites] = useState<BrowserSite[]>([]);
  // 첫 페인트에 "결과 없음"을 띄우면 목록이 도착하기 전 몇 초 동안 빈 화면과
  // 픽셀 단위로 같아진다 — 그 창에서 사용자는 "도구가 하나도 없다"로 읽는다.
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [ownership, setOwnership] = useState<OwnershipFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [expanded, setExpanded] = useState(variant !== "onboarding");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState(false);
  const [keyStep, setKeyStep] = useState<KeyStepState | null>(null);
  const [loginStep, setLoginStep] = useState<LoginStepState | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const [rows, servers, sites] = await Promise.all([
        api.marketplace.search(""),
        api.mcpTools.listInstalled().catch(() => [] as InstalledMcpServer[]),
        // 이미 브라우저 자격증명을 붙여 둔 사이트. 로그인이 필요한 도구가 "이미
        // 로그인돼 있다"를 말할 수 있는 유일한 근거다.
        api.browser.listSites().catch(() => [] as BrowserSite[]),
      ]);
      setListings((Array.isArray(rows) ? rows : []).filter(isPluginListing));
      setInstalled(servers ?? []);
      setLinkedSites(sites ?? []);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "load failed");
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Esc로 닫기 — 팝업은 되돌아 나가는 길이 늘 보여야 한다.
  // 필터 메뉴가 열려 있으면 Esc는 그 메뉴부터 닫는다(안쪽부터 벗겨진다).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (filterOpen) { setFilterOpen(false); return; }
      if (!installing && !keyStep) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filterOpen, installing, keyStep, onClose]);

  /*
   * 필터 메뉴는 바깥을 누르면 닫혀야 한다.
   *
   * 없을 때 무슨 일이 벌어지는지 실제로 겪었다: 필터를 한 번 열면 메뉴가 목록 위에
   * 그대로 떠 있고, 그 아래 카드를 누르려 하면 클릭이 전부 메뉴에 먹힌다. 화면은
   * 멀쩡해 보이는데 아무것도 선택되지 않는다 — 사용자는 목록이 고장 났다고 읽는다.
   * 메뉴 자체를 누른 경우만 살려 두고 나머지는 닫는다.
   */
  useEffect(() => {
    if (!filterOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && filterRef.current?.contains(target)) return;
      setFilterOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [filterOpen]);

  const installedSlugs = useMemo(() => {
    const set = new Set<string>();
    for (const server of installed) {
      for (const candidate of pluginSlugCandidates({
        catalogId: server.catalogId,
        name: server.name,
      })) set.add(candidate);
    }
    return set;
  }, [installed]);

  const isInstalled = useCallback(
    (listing: MarketplaceListing) =>
      pluginSlugCandidates({ slug: listing.slug, name: listing.name }).some((key) => installedSlugs.has(key)),
    [installedSlugs],
  );

  /**
   * 이 도구가 붙는 서비스에 이미 브라우저 로그인이 있는가.
   *
   * 있으면 로그인 타입 도구도 "아이디를 다시 치는 일"이 아니라 "동의 한 번"으로 끝난다.
   * 인가 창이 Agentlas 전용 Chrome에서 열리고 그 프로필에 세션이 이미 있기 때문이다.
   * 그래서 화면은 그 사실을 미리 말해 준다 — 사용자가 로그인 버튼을 보고 물러서지
   * 않도록. 다만 "자동 로그인됨"이라고는 쓰지 않는다: 서비스에 따라 동의 화면은
   * 여전히 뜨고, 안 뜬다고 단정하면 그건 우리가 확인하지 않은 사실이다.
   */
  const hasBrowserLogin = useCallback(
    (listing: MarketplaceListing) => {
      const domain = serviceDomainOf(listing);
      if (!domain) return false;
      return linkedSites.some((entry) => {
        // `site`는 보통 도메인이지만 주소 형태로 저장된 행도 있다. 둘 다 받는다.
        const host = (() => {
          try { return new URL(/^https?:\/\//i.test(entry.site) ? entry.site : `https://${entry.site}`).hostname; }
          catch { return entry.site; }
        })();
        return domainMatches(domain, host);
      });
    },
    [linkedSites],
  );

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return listings.filter((listing) => {
      if (typeFilter !== "all" && (listing.pluginKind ?? "mcp") !== typeFilter) return false;
      if (ownership === "installed" && !isInstalled(listing)) return false;
      if (ownership === "not-installed" && isInstalled(listing)) return false;
      if (!needle) return true;
      return [listing.name, listing.slug, listing.tagline, listing.category, listing.developer]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [listings, query, typeFilter, ownership, isInstalled]);

  // 온보딩 첫 화면은 카탈로그 전체가 아니라 허브가 대표로 고른 것부터 보여준다.
  // 검색을 시작하면 그 축소는 의미가 없다 — 사용자가 이미 목표를 말했기 때문이다.
  const narrowed = variant === "onboarding" && !expanded && !query.trim();
  const visible = useMemo(() => {
    if (!narrowed) return matches;
    const featured = matches.filter((listing) => listing.featured);
    const rest = matches.filter((listing) => !listing.featured);
    return [...featured, ...rest].slice(0, ONBOARDING_VISIBLE);
  }, [matches, narrowed]);

  const grouped = useMemo(() => groupByCategory(visible, ko), [visible, ko]);

  const toggle = (slug: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const chosen = useMemo(
    () => listings.filter((listing) => selected.has(listing.slug)),
    [listings, selected],
  );

  /**
   * 고른 항목을 차례로 설치한다.
   *
   * 실패는 그 항목에서 멈추고 나머지를 계속한다 — 하나가 안 붙었다고 나머지 선택을
   * 버리면 사용자는 무엇이 됐고 무엇이 안 됐는지 모른 채 처음부터 다시 골라야 한다.
   */
  const install = async () => {
    if (!api || chosen.length === 0 || installing) return;
    setInstalling(true);
    const result: PluginPickerResult = { installed: [], skipped: [], deferredKeys: [] };
    const needKeys: Array<{ slug: string; name: string; envKeys: string[] }> = [];
    const needLogin: Array<{ slug: string; name: string; serverId: string }> = [];

    try {
      for (const listing of chosen) {
        setProgress(listing.name);
        try {
          const preview = await api.mcpTools.previewHubPlugin(listing.manifestUrl);
          if (!preview || preview.rows.length === 0) {
            result.skipped.push({
              slug: listing.slug,
              reason: listing.connectSetupRequired
                ? ko
                  ? "계정별로 연결 주소가 달라 자동 설치할 수 없습니다. 제공사 안내를 따라 연결하세요."
                  : "Its connection is minted per account, so it cannot be installed automatically. Follow the provider's setup guide."
                : ko
                  ? "연결할 수 있는 MCP 서버 정보가 아직 없습니다."
                  : "No connectable MCP server information yet.",
            });
            continue;
          }
          // stdio 행은 이 기계에서 명령을 실행한다는 뜻이다. 사용자가 명령 원문을 보고
          // 누른 것이 아니라 목록에서 체크만 했으므로 여기서 승인으로 취급하지 않는다 —
          // 비활성으로 등록되고 MCP 화면이 승인 대기로 표면화한다.
          const receipt = await api.mcpTools.installHubPlugin({
            slug: listing.slug,
            manifestUrl: listing.manifestUrl,
            approveLocalExecution: false,
          });
          const connected = receipt.receipts.filter(
            (row) => row.action === "connected" || row.action === "already-installed",
          );
          const pending = receipt.receipts.filter((row) => row.action === "needs-approval");
          const failed = receipt.receipts.filter((row) => row.action === "skipped");

          if (connected.length > 0 || pending.length > 0) {
            result.installed.push(listing.slug);
            /*
             * 여기서 두 갈래가 갈린다.
             *
             * 로그인(OAuth) 도구는 키를 물어봐야 할 것이 없다 — 물어보면 사용자는
             * 있지도 않은 토큰을 찾으러 간다. 대신 인가 흐름을 돌린다. 동의 창은
             * Agentlas 전용 Chrome에서 열리므로, 브라우저 자격증명을 이미 붙여 둔
             * 사용자는 로그인 화면 없이 동의만 누른다.
             *
             * 키 도구만 키 시트로 간다. 그것도 "나중에"가 늘 열려 있다.
             */
            if (setupKindFor(listing) === "login") {
              const serverId = connected.find((row) => row.serverId)?.serverId
                ?? pending.find((row) => row.serverId)?.serverId
                ?? null;
              if (serverId) needLogin.push({ slug: listing.slug, name: listing.name, serverId });
              continue;
            }
            const envKeys = [...new Set(preview.rows.flatMap((row) => row.envKeys ?? []))];
            if (envKeys.length > 0) needKeys.push({ slug: listing.slug, name: listing.name, envKeys });
          } else if (failed.length > 0) {
            result.skipped.push({
              slug: listing.slug,
              reason: failed[0]?.reason ?? (ko ? "설치하지 못했습니다." : "Install failed."),
            });
          }
        } catch (error) {
          result.skipped.push({
            slug: listing.slug,
            reason: error instanceof Error ? error.message.slice(0, 200) : "install failed",
          });
        }
      }
    } finally {
      setProgress(null);
      setInstalling(false);
    }

    await refresh();

    // 로그인이 먼저다. 키 입력은 사용자가 다른 사이트를 다녀와야 할 수도 있어
    // 흐름이 길어지는데, 로그인은 대개 클릭 두 번이라 여기서 끝내는 편이 낫다.
    if (needLogin.length > 0) {
      setLoginStep({ queue: needLogin, index: 0, keyQueue: needKeys, result });
      return;
    }
    if (needKeys.length > 0) {
      setKeyStep({ queue: needKeys, index: 0, result });
      return;
    }
    onCompleted?.(result);
    onClose();
  };

  if (loginStep) {
    return (
      <LoginStep
        ko={ko}
        state={loginStep}
        brandMap={brandMap}
        onDone={(finalResult, keyQueue) => {
          setLoginStep(null);
          if (keyQueue.length > 0) {
            setKeyStep({ queue: keyQueue, index: 0, result: finalResult });
            return;
          }
          onCompleted?.(finalResult);
          onClose();
        }}
        onAdvance={setLoginStep}
      />
    );
  }

  if (keyStep) {
    return (
      <KeyStep
        ko={ko}
        state={keyStep}
        brandMap={brandMap}
        onDone={(finalResult) => {
          setKeyStep(null);
          onCompleted?.(finalResult);
          onClose();
        }}
        onAdvance={setKeyStep}
      />
    );
  }

  const typeCounts = countByKind(listings);
  // 종류가 한 가지뿐이면 종류 필터는 아무것도 나누지 못한다 — 고르면 결과가 그대로인
  // 컨트롤은 도움이 아니라 소음이다.
  const showTypeFilter = typeCounts.mcp > 0 && typeCounts.skill > 0;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="plugin-picker-title">
      <div className={styles.panel} ref={dialogRef}>
        <header className={styles.header}>
          <h2 id="plugin-picker-title" className={styles.title}>
            {variant === "onboarding"
              ? ko ? "어떤 도구를 자주 쓰세요?" : "What do you use every day?"
              : ko ? "MCP · 플러그인 추가" : "Add MCP & plugins"}
          </h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label={ko ? "닫기" : "Close"}>
            ×
          </button>
        </header>

        {variant === "onboarding" && (
          <p className={styles.subtitle}>
            {ko
              ? "고른 도구는 모든 에이전트가 함께 씁니다. 지금 고르지 않아도 나중에 환경설정에서 추가할 수 있어요."
              : "Every agent shares the tools you pick. You can also add them later in Settings."}
          </p>
        )}

        <div className={styles.toolbar}>
          <div className={styles.filterWrap} ref={filterRef}>
            <button
              type="button"
              className={styles.filterButton}
              onClick={() => setFilterOpen((open) => !open)}
              aria-expanded={filterOpen}
              aria-label={ko ? "필터" : "Filter"}
            >
              <FilterIcon />
            </button>
            {filterOpen && (
              <div className={styles.filterMenu} role="menu">
                {showTypeFilter && (
                  <>
                    <div className={styles.filterGroupLabel}>{ko ? "종류" : "Type"}</div>
                    {([
                      ["all", ko ? "전체" : "All types"],
                      ["mcp", ko ? "MCP (계정 연결)" : "MCP (account-backed)"],
                      ["skill", ko ? "플러그인 (스킬)" : "Plugins (skills)"],
                    ] as Array<[TypeFilter, string]>).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={typeFilter === value}
                        className={styles.filterItem}
                        onClick={() => setTypeFilter(value)}
                      >
                        <span>{label}</span>
                        {typeFilter === value && <span className={styles.check}>✓</span>}
                      </button>
                    ))}
                  </>
                )}
                <div className={styles.filterGroupLabel}>{ko ? "설치 상태" : "Status"}</div>
                {([
                  ["all", ko ? "전체" : "All"],
                  ["not-installed", ko ? "설치 안 됨" : "Not installed"],
                  ["installed", ko ? "설치됨" : "Installed"],
                ] as Array<[OwnershipFilter, string]>).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={ownership === value}
                    className={styles.filterItem}
                    onClick={() => setOwnership(value)}
                  >
                    <span>{label}</span>
                    {ownership === value && <span className={styles.check}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <input
            className={styles.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={ko ? "도구 검색…" : "Search plugins…"}
            aria-label={ko ? "도구 검색" : "Search plugins"}
          />
        </div>

        <div className={styles.body}>
          {!loaded && <p className={styles.hint}>{ko ? "목록을 불러오는 중…" : "Loading…"}</p>}
          {loaded && loadError && (
            <p className={styles.error}>
              {ko ? "목록을 불러오지 못했습니다: " : "Could not load the catalog: "}
              {loadError}
            </p>
          )}
          {loaded && !loadError && matches.length === 0 && (
            <p className={styles.hint}>
              {query.trim()
                ? ko ? `"${query.trim()}"과 맞는 도구가 없습니다.` : `Nothing matches "${query.trim()}".`
                : ko ? "표시할 도구가 없습니다." : "No plugins to show."}
            </p>
          )}

          {grouped.map(([category, rows]) => (
            <section key={category} className={styles.group}>
              <h3 className={styles.groupTitle}>{category}</h3>
              <div className={styles.grid}>
                {rows.map((listing) => {
                  const already = isInstalled(listing);
                  const picked = selected.has(listing.slug);
                  return (
                    <button
                      key={listing.slug}
                      type="button"
                      className={styles.card}
                      data-selected={picked || undefined}
                      data-installed={already || undefined}
                      aria-pressed={picked}
                      onClick={() => toggle(listing.slug)}
                    >
                      <PluginLogo
                        slug={listing.slug}
                        name={listing.name}
                        size={32}
                        brandColor={listing.brandColor}
                        brandMap={brandMap}
                      />
                      <span className={styles.cardText}>
                        <strong className={styles.cardName}>{listing.name}</strong>
                        <span className={styles.cardTagline}>{listing.tagline}</span>
                        <SetupHint listing={listing} ko={ko} hasLogin={hasBrowserLogin(listing)} />
                      </span>
                      <span className={styles.cardAction}>
                        {already
                          ? ko ? "설치됨" : "Installed"
                          : picked
                            ? ko ? "선택됨" : "Selected"
                            : ko ? "추가" : "Add"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}

          {narrowed && matches.length > visible.length && (
            <button type="button" className={styles.more} onClick={() => setExpanded(true)}>
              {ko
                ? `더 찾아보기 (${matches.length - visible.length}개 더)`
                : `Browse all (${matches.length - visible.length} more)`}
            </button>
          )}
        </div>

        <footer className={styles.footer}>
          <span className={styles.count}>
            {installing && progress
              ? ko ? `${progress} 설치 중…` : `Installing ${progress}…`
              : selected.size > 0
                ? ko ? `${selected.size}개 선택됨` : `${selected.size} selected`
                : ko ? "여러 개를 함께 고를 수 있어요" : "You can pick more than one"}
          </span>
          <div className={styles.footerActions}>
            <button type="button" className={styles.ghost} onClick={onClose} disabled={installing}>
              {variant === "onboarding"
                ? ko ? "건너뛰기" : "Skip"
                : ko ? "취소" : "Cancel"}
            </button>
            <button
              type="button"
              className={styles.primary}
              onClick={() => void install()}
              disabled={installing || selected.size === 0}
            >
              {installing
                ? ko ? "추가하는 중…" : "Adding…"
                : ko ? `${selected.size || ""}개 추가`.trim() : `Add ${selected.size || ""}`.trim()}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ── 로그인(OAuth) 단계 ────────────────────────────────────────────────────────

interface LoginStepState {
  queue: Array<{ slug: string; name: string; serverId: string }>;
  index: number;
  /** 로그인이 끝난 뒤에 이어서 물어볼 키 목록. */
  keyQueue: Array<{ slug: string; name: string; envKeys: string[] }>;
  result: PluginPickerResult;
}

/**
 * 서비스에 로그인해 권한을 준다.
 *
 * 버튼을 누르면 Agentlas 전용 Chrome에 동의 화면이 열린다. 그 프로필에는 사용자가
 * 가져온 브라우저 로그인이 들어 있으므로, 대개 아이디를 다시 칠 일이 없다. 창을
 * 못 열었으면 주소를 그대로 보여 준다 — 다른 브라우저로 조용히 흘려보내면 그
 * 로그인을 못 쓰고, 사용자는 왜 또 로그인해야 하는지 알 수 없다.
 *
 * 건너뛰기는 언제나 열려 있다. 서버는 이미 등록돼 있으므로 나중에 MCP 화면에서
 * 연결해도 된다.
 */
function LoginStep({
  ko,
  state,
  brandMap,
  onDone,
  onAdvance,
}: {
  ko: boolean;
  state: LoginStepState;
  brandMap: Record<string, import("@/lib/types").PluginBrandAsset>;
  onDone: (result: PluginPickerResult, keyQueue: LoginStepState["keyQueue"]) => void;
  onAdvance: (next: LoginStepState) => void;
}) {
  const api = ipc();
  const current = state.queue[state.index];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setError(null);
    setManualUrl(null);
    setConnected(false);
  }, [state.index]);

  if (!current) {
    onDone(state.result, state.keyQueue);
    return null;
  }

  const advance = () => {
    if (state.index + 1 >= state.queue.length) onDone(state.result, state.keyQueue);
    else onAdvance({ ...state, index: state.index + 1 });
  };

  const connect = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.mcpTools.oauthConnect(current.serverId);
      if (out.ok) {
        setManualUrl(out.manualUrl);
        setConnected(true);
        // 창이 정상으로 열려 인가까지 끝났으면 바로 다음으로. 수동 URL이 남았다면
        // 사용자가 그 주소를 볼 수 있게 화면을 유지한다.
        if (!out.manualUrl) advance();
      } else {
        setError(out.error);
      }
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "connection failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="plugin-login-title">
      <div className={styles.keyPanel}>
        <header className={styles.keyHeader}>
          <PluginLogo slug={current.slug} name={current.name} size={36} brandMap={brandMap} />
          <div>
            <h2 id="plugin-login-title" className={styles.title}>
              {ko ? `${current.name}에 로그인` : `Sign in to ${current.name}`}
            </h2>
            <p className={styles.keySub}>
              {ko
                ? "Agentlas 브라우저에서 동의 화면이 열립니다. 이미 로그인해 두셨다면 아이디를 다시 칠 필요 없이 허용만 누르시면 됩니다."
                : "A consent screen opens in the Agentlas browser. If you are already signed in there, just approve — no need to type your credentials again."}
            </p>
          </div>
        </header>

        {error && <p className={styles.error}>{error}</p>}

        {manualUrl && (
          <p className={styles.keyNote}>
            {ko
              ? "Agentlas 브라우저를 열지 못했습니다. 아래 주소를 직접 열어 로그인하세요:"
              : "The Agentlas browser could not be opened. Open this address yourself to sign in:"}
            <br />
            <code style={{ wordBreak: "break-all" }}>{manualUrl}</code>
          </p>
        )}

        {connected && !manualUrl && (
          <p className={styles.keyNote}>{ko ? "연결됐습니다." : "Connected."}</p>
        )}

        <footer className={styles.footer}>
          <span className={styles.count}>
            {state.queue.length > 1
              ? ko ? `${state.index + 1} / ${state.queue.length}` : `${state.index + 1} of ${state.queue.length}`
              : ""}
          </span>
          <div className={styles.footerActions}>
            <button type="button" className={styles.ghost} disabled={busy} onClick={advance}>
              {ko ? "나중에 로그인" : "Sign in later"}
            </button>
            <button type="button" className={styles.primary} onClick={() => void connect()} disabled={busy}>
              {busy
                ? ko ? "연결하는 중…" : "Connecting…"
                : manualUrl
                  ? ko ? "다음" : "Next"
                  : ko ? "로그인하고 연결" : "Sign in and connect"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ── 키 입력 단계 ──────────────────────────────────────────────────────────────

interface KeyStepState {
  queue: Array<{ slug: string; name: string; envKeys: string[] }>;
  index: number;
  result: PluginPickerResult;
}

/**
 * 설치된 서버가 요구하는 환경변수를 받는다.
 *
 * "나중에 입력하기"가 1급 선택지인 이유: 키는 대개 다른 사이트에 로그인해야 나온다.
 * 그걸 지금 강제하면 사용자는 이 흐름을 떠나고, 떠난 사람은 대부분 돌아오지 않는다.
 * 서버는 이미 등록돼 있으므로 키만 나중에 채우면 그대로 살아난다.
 */
function KeyStep({
  ko,
  state,
  brandMap,
  onDone,
  onAdvance,
}: {
  ko: boolean;
  state: KeyStepState;
  brandMap: Record<string, import("@/lib/types").PluginBrandAsset>;
  onDone: (result: PluginPickerResult) => void;
  onAdvance: (next: KeyStepState) => void;
}) {
  const api = ipc();
  const current = state.queue[state.index];
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 다음 플러그인으로 넘어갈 때 앞 항목의 입력값이 남아 있으면 안 된다.
  useEffect(() => {
    setValues({});
    setError(null);
  }, [state.index]);

  if (!current) {
    onDone(state.result);
    return null;
  }

  const advance = (deferred: string[]) => {
    const result: PluginPickerResult = {
      ...state.result,
      deferredKeys: [...state.result.deferredKeys, ...deferred],
    };
    if (state.index + 1 >= state.queue.length) onDone(result);
    else onAdvance({ ...state, index: state.index + 1, result });
  };

  const save = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    const deferred: string[] = [];
    try {
      for (const key of current.envKeys) {
        const value = (values[key] ?? "").trim();
        // 값은 여기서 곧장 vault로 간다. 빈 칸은 저장하지 않고 "나중에"로 남긴다 —
        // 빈 문자열을 저장하면 "키가 있다"고 잘못 보고된다.
        if (!value) { deferred.push(key); continue; }
        await api.env.set(key, value);
      }
      advance(deferred);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="plugin-key-title">
      <div className={styles.keyPanel}>
        <header className={styles.keyHeader}>
          <PluginLogo slug={current.slug} name={current.name} size={36} brandMap={brandMap} />
          <div>
            <h2 id="plugin-key-title" className={styles.title}>
              {ko ? `${current.name} 연결` : `Connect ${current.name}`}
            </h2>
            <p className={styles.keySub}>
              {ko
                ? "이 도구를 쓰려면 아래 값이 필요합니다. 지금 없으면 나중에 넣어도 됩니다."
                : "This tool needs the values below. If you don't have them now, you can add them later."}
            </p>
          </div>
        </header>

        <div className={styles.keyFields}>
          {current.envKeys.map((key) => (
            <label key={key} className={styles.keyField}>
              <span className={styles.keyLabel}>{key}</span>
              <input
                type="password"
                className={styles.keyInput}
                value={values[key] ?? ""}
                onChange={(event) => setValues((prev) => ({ ...prev, [key]: event.target.value }))}
                autoComplete="off"
                spellCheck={false}
                placeholder={ko ? "붙여넣기" : "Paste value"}
              />
            </label>
          ))}
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <p className={styles.keyNote}>
          {ko
            ? "값은 이 컴퓨터의 키체인에만 저장되고 화면이나 기록에 남지 않습니다."
            : "Values are stored only in this computer's keychain — never shown or logged."}
        </p>

        <footer className={styles.footer}>
          <span className={styles.count}>
            {state.queue.length > 1
              ? ko ? `${state.index + 1} / ${state.queue.length}` : `${state.index + 1} of ${state.queue.length}`
              : ""}
          </span>
          <div className={styles.footerActions}>
            <button
              type="button"
              className={styles.ghost}
              disabled={busy}
              onClick={() => advance(current.envKeys)}
            >
              {ko ? "다음에 입력하기" : "Add later"}
            </button>
            <button type="button" className={styles.primary} onClick={() => void save()} disabled={busy}>
              {busy ? (ko ? "저장 중…" : "Saving…") : ko ? "저장하고 계속" : "Save and continue"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isPluginListing(listing: MarketplaceListing): boolean {
  return listing.entityKind === "plugin" || listing.source === "hub-plugin";
}

/**
 * 설치 뒤에 사용자가 무엇을 더 해야 하는가. 셋은 완전히 다른 일이라 화면도 갈려야 한다.
 *
 *  · "ready"  — 아무것도 없다. 고르면 그 자리에서 끝.
 *  · "login"  — 그 서비스에 로그인해 권한을 준다. 우리가 대신 줄여 줄 수 있는 유일한 갈래다.
 *  · "key"    — 사용자가 다른 사이트에서 키를 받아 와야 한다. 우리가 할 수 있는 건
 *               발급 페이지를 열어 주는 것까지 — 그래서 "나중에"가 1급 선택지다.
 *  · "unknown"— 허브가 종류를 알려주지 않았다(구버전 응답). 단정하지 않는다.
 */
export type PluginSetupKind = "ready" | "login" | "key" | "unknown";

export function setupKindFor(listing: MarketplaceListing): PluginSetupKind {
  const auth: PluginAuthKind | undefined = listing.authKind;
  if (auth === "none") return "ready";
  if (auth === "oauth") return "login";
  if (auth === "api_key" || auth === "token") return "key";
  return "unknown";
}

/**
 * 이 플러그인이 붙는 서비스의 도메인. 브라우저 자격증명에 그 사이트 로그인이 이미
 * 있는지 맞춰 보는 데 쓴다. 허브가 준 homepage 를 근거로 하고, 없으면 아무 도메인도
 * 지어내지 않는다 — 슬러그로 도메인을 추측하면(slack → slack.com 은 맞지만
 * atlassian → ? 는 틀린다) 틀린 "이미 로그인됨"을 보여주게 된다.
 */
export function serviceDomainOf(listing: MarketplaceListing): string | null {
  const raw = listing.homepage;
  if (!raw) return null;
  try {
    return new URL(raw).hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/** 등록 가능 도메인 수준에서 같은 서비스인가 (docs.gitlab.com ↔ gitlab.com). */
export function domainMatches(serviceDomain: string, linkedDomain: string): boolean {
  const a = serviceDomain.toLowerCase();
  const b = linkedDomain.toLowerCase().replace(/^www\./, "");
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function countByKind(listings: MarketplaceListing[]): { mcp: number; skill: number } {
  let mcp = 0;
  let skill = 0;
  for (const listing of listings) {
    if ((listing.pluginKind ?? "mcp") === "skill") skill += 1;
    else mcp += 1;
  }
  return { mcp, skill };
}

const CATEGORY_LABELS_KO: Record<string, string> = {
  analytics: "분석", business: "비즈니스", creative: "크리에이티브", design: "디자인",
  developer: "개발", productivity: "생산성", security: "보안", communication: "커뮤니케이션",
  crm: "CRM", finance: "금융", database: "데이터베이스", cloud: "클라우드",
  automation: "자동화", email: "메일·캘린더", marketing: "마케팅", search: "검색",
  ecommerce: "커머스", ai: "AI", media: "미디어", support: "고객지원", maps: "지도",
  reference: "레퍼런스",
};

function groupByCategory(listings: MarketplaceListing[], ko: boolean): Array<[string, MarketplaceListing[]]> {
  const groups = new Map<string, MarketplaceListing[]>();
  for (const listing of listings) {
    const raw = (listing.category ?? "").trim() || "other";
    const label = ko ? CATEGORY_LABELS_KO[raw] ?? raw : raw.replace(/(^|\s)\w/g, (c) => c.toUpperCase());
    const bucket = groups.get(label);
    if (bucket) bucket.push(listing);
    else groups.set(label, [listing]);
  }
  // 항목이 많은 갈래부터. 한 줄짜리 갈래가 위에 깔리면 스크롤만 길어진다.
  return [...groups.entries()].sort((left, right) => right[1].length - left[1].length);
}

/**
 * 이 카드를 고르면 그다음에 무슨 일이 생기는가.
 *
 * 고르기 전에 말해 주는 이유: 예전에는 전부 똑같이 "추가"였고, 누른 뒤에야 어떤 것은
 * 바로 끝나고 어떤 것은 API 키를 물었다. 그 차이를 미리 알면 사용자는 지금 할 수 있는
 * 것과 나중에 할 것을 스스로 나눠 고른다.
 */
function SetupHint({
  listing,
  ko,
  hasLogin,
}: {
  listing: MarketplaceListing;
  ko: boolean;
  hasLogin: boolean;
}) {
  const kind = setupKindFor(listing);
  if (kind === "unknown") return null;
  if (kind === "ready") {
    return <span className={styles.cardHint} data-tone="ready">{ko ? "바로 사용" : "Ready to use"}</span>;
  }
  if (kind === "login") {
    return hasLogin
      ? <span className={styles.cardHint} data-tone="ready">{ko ? "로그인 있음 · 동의만 하면 됩니다" : "Already signed in · just approve"}</span>
      : <span className={styles.cardHint} data-tone="login">{ko ? "로그인 필요" : "Sign-in required"}</span>;
  }
  if (listing.connectSetupRequired) {
    return <span className={styles.cardHint} data-tone="key">{ko ? "제공사 안내에 따라 직접 연결" : "Connect via the provider's guide"}</span>;
  }
  return <span className={styles.cardHint} data-tone="key">{ko ? "API 키 필요 (나중에 입력 가능)" : "API key needed (can add later)"}</span>;
}

function FilterIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
