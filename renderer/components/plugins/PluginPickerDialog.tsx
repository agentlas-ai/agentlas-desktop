"use client";

// MCP·플러그인 고르기 팝업 — 설정 화면과 Connect 화면이 버튼으로 여는 자리.
//
// 왜 팝업인가: 예전에는 "MCP 추가"가 마켓플레이스 화면으로 **나가는** 문이었다. 도구를
// 하나 붙이려던 사람이 에이전트·팀·그래프가 섞인 장터로 튕겨 나가 자기가 뭘 하려 했는지
// 잃어버렸고, 돌아오는 길도 스스로 찾아야 했다. 고르는 일은 원래 있던 자리에서 끝나야
// 한다 — 그래서 이 화면은 라우팅하지 않고 그 자리에 뜬다.
//
// 처음 실행 온보딩은 이 팝업을 쓰지 않는다. 그때는 이미 전체화면이 열려 있어서 그 위에
// 또 창을 띄우면 흐름이 끊긴다 — 온보딩은 같은 전체화면 안의 스텝으로 그리고, 목록·설치
// 로직만 PluginPickerCore 에서 함께 쓴다.
//
// 두 가지를 지킨다:
//  · 복수 선택. 도구는 보통 한 번에 여러 개를 켠다.
//  · 키는 나중에 넣어도 된다. 지금 API 키가 없다는 이유로 설치 자체를 막으면, 사용자는
//    키를 찾으러 갔다가 이 화면으로 다시 돌아오지 못한다. 등록은 지금 하고 키는 남겨 둔다
//    (미입력 서버는 MCP 화면에 "키 필요"로 남아 스스로를 설명한다).

import { useEffect, useMemo, useRef, useState } from "react";
import { IconFilter } from "@/components/Icon";
import { PluginLogo, usePluginBrandMap } from "@/components/PluginLogo";
import type { MarketplaceListing, PluginKind } from "@/lib/types";
import {
  countByKind,
  groupByCategory,
  installPlugins,
  KeyStep,
  LoginStep,
  setupHintFor,
  usePluginCatalog,
  type KeyStepState,
  type LoginStepState,
  type PluginPickerResult,
} from "./PluginPickerCore";
import styles from "./PluginPickerDialog.module.css";
import { LoadingEstimate } from "@/components/LoadingEstimate";

export type { PluginPickerResult } from "./PluginPickerCore";
export { setupKindFor, serviceDomainOf, domainMatches, type PluginSetupKind } from "./PluginPickerCore";

/** 온보딩 첫 화면이 보여주는 최대 개수. 나머지는 "더 찾아보기"가 맡는다. */
const ONBOARDING_VISIBLE = 12;

type TypeFilter = "all" | PluginKind;
type OwnershipFilter = "all" | "installed" | "not-installed";

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
  const brandMap = usePluginBrandMap();
  const catalog = usePluginCatalog();
  const { listings, loaded, loadError, refresh, isInstalled, hasBrowserLogin } = catalog;

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

  const install = async () => {
    if (chosen.length === 0 || installing) return;
    setInstalling(true);
    let outcome: Awaited<ReturnType<typeof installPlugins>>;
    try {
      outcome = await installPlugins({ chosen, ko, onProgress: setProgress });
    } finally {
      setInstalling(false);
    }

    await refresh();

    // 로그인이 먼저다. 키 입력은 사용자가 다른 사이트를 다녀와야 할 수도 있어
    // 흐름이 길어지는데, 로그인은 대개 클릭 두 번이라 여기서 끝내는 편이 낫다.
    if (outcome.needLogin.length > 0) {
      setLoginStep({ queue: outcome.needLogin, index: 0, keyQueue: outcome.needKeys, result: outcome.result });
      return;
    }
    if (outcome.needKeys.length > 0) {
      setKeyStep({ queue: outcome.needKeys, index: 0, result: outcome.result });
      return;
    }
    onCompleted?.(outcome.result);
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
              : ko ? "도구 추가" : "Add tools"}
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
              <IconFilter size={16} />
            </button>
            {filterOpen && (
              <div className={styles.filterMenu} role="menu">
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
            placeholder={ko ? "도구 검색…" : "Search tools…"}
            aria-label={ko ? "도구 검색" : "Search tools"}
          />
        </div>

        {showTypeFilter && (
          <div className={styles.typeTabs} role="tablist" aria-label={ko ? "도구 종류" : "Tool type"}>
            {([
              ["all", ko ? "전체" : "All"],
              ["skill", ko ? "플러그인" : "Plugins"],
              ["mcp", "MCP"],
            ] as Array<[TypeFilter, string]>).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={typeFilter === value}
                className={styles.typeTab}
                data-active={typeFilter === value ? "true" : "false"}
                onClick={() => setTypeFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div className={styles.body}>
          {!loaded && <div className={styles.hint} style={{ display: "grid", gap: 5 }}><span>{ko ? "목록을 불러오는 중…" : "Loading…"}</span><LoadingEstimate locale={ko ? "ko" : "en"} operationKey="desktop-plugin-catalog" expectedSeconds={[2, 20]} /></div>}
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
                : ko ? "표시할 도구가 없습니다." : "No tools to show."}
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

/** 고르기 전에 "그다음에 무슨 일이 생기는지"를 말하는 줄. 색으로도 구분되지만 색만으로
    구분되지는 않는다 — 문구가 항상 함께 있다. */
function SetupHint({
  listing,
  ko,
  hasLogin,
}: {
  listing: MarketplaceListing;
  ko: boolean;
  hasLogin: boolean;
}) {
  const hint = setupHintFor({ listing, ko, hasLogin });
  if (!hint) return null;
  return <span className={styles.cardHint} data-tone={hint.tone}>{hint.text}</span>;
}
