// 허브 빌려쓰기 방 — 검증된 Hub 에이전트를 찾아 북마크한다(가치1: 네트워크).
// 북마크는 로컬 설치가 아니라 Hub 라우팅 참조다. 설치/소유와 섞지 않는다.
//
// 실측 원칙: marketplace.search(실제 허브 검색) + marketplace.status(소스 온라인=게시자 가용성 proxy).
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { classifyHubEntity, entityClassLabel } from "@/lib/agent-entity-kind";
import {
  announceHubBookmarkChange,
  hubBookmarkIdentityKey,
  hubBookmarkIdentityKeyFromParts,
  hubListingIdentityKey,
  onHubBookmarkChange,
} from "@/lib/hub-bookmark-events";
import {
  hubSecurityGradeExplanation,
  hubSecurityGradeLabel,
  hubVerificationFacts,
  isCallableHubListing,
} from "@/lib/hub-verification";
import { useT } from "@/lib/i18n";
import { IconSearch, IconCheck } from "@/components/Icon";
import type { MarketplaceListing, MarketplaceSourceStatus } from "@/lib/types";

const INTENT_STOP_WORDS = new Set([
  "agent", "agents", "help", "make", "create", "build", "please", "need", "want", "with", "for", "the",
  "에이전트", "도와줘", "만들어", "만들어줘", "필요해", "해주세요",
]);

function intentTerms(value: string): string[] {
  return [...new Set(
    value.toLocaleLowerCase()
      .match(/[a-z0-9가-힣]{2,}/g)
      ?.filter((term) => !INTENT_STOP_WORDS.has(term)) ?? [],
  )].slice(0, 12);
}

function isUsableIntent(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 4 || normalized.length > 240) return false;
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+){2,}$/i.test(normalized)) return false;
  return intentTerms(normalized).length > 0;
}

function listingEvidence(listing: MarketplaceListing, terms: string[]): string[] {
  const publicCopy = [
    listing.name,
    listing.nameEn,
    listing.tagline,
    listing.taglineEn,
    listing.category ?? "",
  ].join(" ").toLocaleLowerCase();
  return terms.filter((term) => publicCopy.includes(term)).slice(0, 4);
}

export function HubBorrowRoom() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MarketplaceListing[] | null>(null);
  const [status, setStatus] = useState<MarketplaceSourceStatus | null>(null);
  const [bookmarked, setBookmarked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bookmarkGenerationRef = useRef(0);

  // locale을 ref로 읽어 search 콜백 identity를 고정한다 — 언어 토글 시 search가 재생성돼
  // 마운트 effect가 재실행되며 현재 검색 결과가 초기화되던 글리치 방지.
  const koRef = useRef(ko);
  koRef.current = ko;
  const search = useCallback(async (q: string) => {
    const api = ipc();
    if (!api) {
      setResults([]);
      return;
    }
    try {
      const res = await api.marketplace.search(q);
      const st = await api.marketplace.status();
      setResults(res.filter((item) => item.entityKind !== "plugin" && item.source !== "hub-plugin"));
      setStatus(st);
      setMessage("");
    } catch {
      setResults([]);
      setMessage(koRef.current ? "허브 검색을 불러오지 못했습니다. 설치된 에이전트에는 영향이 없습니다." : "Hub search could not be loaded. Installed agents were not changed.");
    }
  }, []);

  useEffect(() => {
    void search("");
    const generation = ++bookmarkGenerationRef.current;
    ipc()?.marketplace.bookmarks()
      .then((items) => {
        if (bookmarkGenerationRef.current === generation) {
          setBookmarked(new Set(items.map(hubBookmarkIdentityKey)));
        }
      })
      .catch(() => {});
    return () => {
      if (bookmarkGenerationRef.current === generation) bookmarkGenerationRef.current += 1;
    };
  }, [search]);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void search(query), 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, search]);

  useEffect(
    () => onHubBookmarkChange((change) => {
      bookmarkGenerationRef.current += 1;
      if (change.action === "synced") {
        setBookmarked(new Set(change.bookmarks.map(hubBookmarkIdentityKey)));
      } else if (change.action === "added") {
        setBookmarked((previous) => new Set(previous).add(hubBookmarkIdentityKey(change.bookmark)));
      } else {
        setBookmarked((previous) => {
          const next = new Set(previous);
          if (change.entityKind) {
            next.delete(hubBookmarkIdentityKeyFromParts(change.slug, change.entityKind));
          } else {
            const slugSuffix = `:${change.slug.trim().toLowerCase()}`;
            for (const identity of next) {
              if (identity.endsWith(slugSuffix)) next.delete(identity);
            }
          }
          return next;
        });
      }
    }),
    [],
  );

  async function bookmarkListing(listing: MarketplaceListing) {
    const api = ipc();
    if (!api?.marketplace?.bookmarkAdd || busy) return;
    const listingIdentity = hubListingIdentityKey(listing);
    setBusy(listingIdentity);
    try {
      const bookmark = await api.marketplace.bookmarkAdd(listing);
      bookmarkGenerationRef.current += 1;
      setBookmarked((prev) => new Set(prev).add(hubBookmarkIdentityKey(bookmark)));
      announceHubBookmarkChange({ action: "added", bookmark });
      setMessage(ko ? "Hub 북마크에 추가했습니다." : "Added to Hub bookmarks.");
    } catch {
      setMessage(ko ? "북마크하지 못했습니다. Hub 연결 상태를 확인한 뒤 다시 시도하세요." : "Could not bookmark it. Check the Hub connection, then try again.");
    } finally {
      setBusy(null);
    }
  }

  const online = status ? status.online && !status.usingFallback : false;
  const intent = query.trim();
  const usableIntent = isUsableIntent(intent);
  const terms = useMemo(() => intentTerms(intent), [intent]);
  const visibleResults = useMemo(() => {
    if (!results || !intent) return results;
    if (!usableIntent) return [];
    return results
      .map((listing, sourceRank) => ({
        listing,
        sourceRank,
        evidence: listingEvidence(listing, terms),
      }))
      .filter((item) => item.evidence.length > 0)
      .sort((left, right) => right.evidence.length - left.evidence.length || left.sourceRank - right.sourceRank)
      .map((item) => item.listing);
  }, [intent, results, terms, usableIntent]);

  return (
    <div className="dashboard-module hub-borrow">
      <div className="dashboard-module-head">
        <span>{ko ? "허브 · 빌려쓰기" : "Hub · borrow"}</span>
        <span className="hub-borrow-source" data-online={online ? "true" : "false"}>
          {online ? (ko ? "게시자 온라인" : "publishers online") : ko ? "오프라인" : "offline"}
        </span>
      </div>

      <label className="hub-borrow-search">
        <IconSearch size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            ko
              ? "검증된 에이전트 검색 — 하려는 일을 문장으로 입력 (예: API 백엔드 만들어줘)"
              : "Search verified agents — describe the outcome you need"
          }
        />
      </label>

      {intent && (
        <div className="hub-borrow-context" role="status" aria-live="polite">
          <strong>{usableIntent ? (ko ? "공개 설명 근거 추천" : "Public-evidence recommendations") : (ko ? "요청을 조금 더 설명해 주세요" : "Describe the outcome more clearly")}</strong>
          <span>
            {usableIntent
              ? (ko
                  ? "입력한 목적어가 공개 이름·설명에 실제로 나타나는 결과만 보여줍니다."
                  : "Only results with words from your request in their public name or description are shown.")
              : (ko
                  ? "식별자나 테스트 문자열 대신 원하는 결과와 분야를 문장으로 입력하세요."
                  : "Use a sentence with the desired result and domain, not an identifier or test string.")}
          </span>
        </div>
      )}

      {visibleResults === null ? (
        <div className="dashboard-module-empty">{ko ? "허브 에이전트를 불러오는 중…" : "Loading Hub agents…"}</div>
      ) : visibleResults.length === 0 ? (
        <div className="dashboard-module-empty">
          {intent
            ? (usableIntent
                ? (ko ? "공개 설명에서 확인되는 적합한 결과가 없어요. 다른 결과나 분야를 더 구체적으로 입력해 주세요." : "No result has enough public evidence of fit. Describe a more specific result or domain.")
                : (ko ? "검색할 일을 문장으로 더 구체적으로 적어 주세요." : "Describe the work in a more specific sentence."))
            : (ko ? "검색 결과가 없어요." : "No results.")}
        </div>
      ) : (
        <div className="hub-borrow-carousel" role="list">
          {visibleResults.slice(0, 6).map((r, index) => {
            const entityClass = classifyHubEntity(r);
            const listingIdentity = hubListingIdentityKey(r);
            const isBookmarked = bookmarked.has(listingIdentity);
            const callable = isCallableHubListing(r);
            const verificationFacts = hubVerificationFacts(r, locale).slice(0, 2);
            const evidence = listingEvidence(r, terms);
            return (
              <div
                key={listingIdentity}
                className="hub-borrow-card"
                role="listitem"
                data-entity-kind={entityClass}
                data-contextual={intent ? "true" : "false"}
              >
                <div className="hub-borrow-card-top">
                  {intent && (
                    <span className="hub-borrow-rank" data-primary={index === 0 ? "true" : "false"}>
                      {index === 0 ? (ko ? "근거 가장 많음" : "Most evidence") : ko ? `근거 ${index + 1}` : `Evidence ${index + 1}`}
                    </span>
                  )}
                  <span
                    className="hub-borrow-trust"
                    data-grade={r.trustGrade}
                    title={hubSecurityGradeExplanation(locale)}
                  >
                    {hubSecurityGradeLabel(r, locale)}
                  </span>
                  <span className="agent-entity-badge" data-entity-kind={entityClass}>
                    {entityClassLabel(entityClass, locale)}
                  </span>
                </div>
                <div className="hub-borrow-card-name" title={ko ? r.name : r.nameEn || r.name}>
                  {ko ? r.name : r.nameEn || r.name}
                </div>
                <div
                  className="hub-borrow-card-tagline"
                  title={(ko ? r.tagline : r.taglineEn || r.tagline) || ""}
                >
                  {(ko ? r.tagline : r.taglineEn || r.tagline) || ""}
                </div>
                {intent && (
                  <div className="hub-borrow-card-reason">
                    {ko
                      ? `공개 설명에서 확인: ${evidence.join(", ")}`
                      : `Found in public description: ${evidence.join(", ")}`}
                  </div>
                )}
                <div className="hub-borrow-card-facts" aria-label={ko ? "검증 사실" : "Verification facts"}>
                  <span data-callable={callable ? "true" : "false"}>
                    {callable ? (ko ? "Hub 호출 가능" : "Hub callable") : (ko ? "설치 전용" : "Install only")}
                  </span>
                  {verificationFacts.map((fact) => <span key={fact}>{fact}</span>)}
                </div>
                <div className="hub-borrow-card-foot">
                  {isBookmarked ? (
                    <span className="hub-borrow-owned">
                      <IconCheck size={12} /> {ko ? "북마크됨" : "bookmarked"}
                    </span>
                  ) : (
                    <button
                      onClick={() => bookmarkListing(r)}
                      disabled={busy === listingIdentity}
                      className="titlebar-nodrag hub-borrow-card-add"
                      data-dashboard-action="true"
                      title={ko ? "Hub 북마크에 추가" : "Add to Hub bookmarks"}
                    >
                      {busy === listingIdentity ? (ko ? "북마크 중…" : "Bookmarking…") : ko ? "북마크" : "Bookmark"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {message && <div className="hub-borrow-note">{message}</div>}
    </div>
  );
}
