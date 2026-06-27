// 허브 빌려쓰기 방 — 검증된 남의 에이전트를 찾아 내 함대에 들인다(가치1: 네트워크).
// 기획안: hub 에이전트는 "원격 게스트(borrowed)"로, 내 라이브러리에 추가하면 "내 직원(owned)"이 된다.
// owned/borrowed 를 외형이 아니라 사실로 가른다 — 추가 전엔 로컬 파일 없음(원격), 추가 후엔 내 자산.
//
// 실측 원칙: marketplace.search(실제 허브 검색) + marketplace.status(소스 온라인=게시자 가용성 proxy).
// 현재 런타임이 제공하는 실제 동작은 "내 라이브러리에 추가(team.install)"다. 존재하지 않는 별도의
// '호출형 전용 빌림'을 지어내지 않는다 — 추가하면 owned-cloud 가 된다고 정직하게 표기한다.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { IconSearch, IconCheck } from "@/components/Icon";
import type { MarketplaceListing, MarketplaceSourceStatus } from "@/lib/types";

export function HubBorrowRoom() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MarketplaceListing[] | null>(null);
  const [status, setStatus] = useState<MarketplaceSourceStatus | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(async (q: string) => {
    const api = ipc();
    if (!api) {
      setResults([]);
      return;
    }
    try {
      const [res, st] = await Promise.all([api.marketplace.search(q), api.marketplace.status()]);
      setResults(res);
      setStatus(st);
    } catch {
      setResults([]);
    }
  }, []);

  useEffect(() => {
    void search("");
    // 이미 설치된 슬러그는 owned 로 표시.
    ipc()?.team.list()
      .then((a) => setInstalled(new Set(a.map((x) => x.slug))))
      .catch(() => {});
  }, [search]);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void search(query), 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, search]);

  async function addToLibrary(slug: string) {
    const api = ipc();
    if (!api || busy) return;
    setBusy(slug);
    try {
      await api.team.install(slug);
      setInstalled((prev) => new Set(prev).add(slug));
    } catch {
      /* 무시 — 다음 시도 */
    } finally {
      setBusy(null);
    }
  }

  const online = status ? status.online : true;

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
          placeholder={ko ? "검증된 에이전트 검색 (예: 마케팅, 리서치)" : "Search verified agents"}
        />
      </label>

      {results === null ? (
        <div className="dashboard-module-empty">{ko ? "불러오는 중…" : "Loading…"}</div>
      ) : results.length === 0 ? (
        <div className="dashboard-module-empty">{ko ? "검색 결과가 없어요." : "No results."}</div>
      ) : (
        <div className="hub-borrow-list">
          {results.slice(0, 8).map((r) => {
            const owned = installed.has(r.slug);
            return (
              <div key={r.slug} className="hub-borrow-row">
                <div className="hub-borrow-copy">
                  <div className="hub-borrow-name">
                    {ko ? r.name : r.nameEn || r.name}
                    <span className="hub-borrow-trust" data-grade={r.trustGrade}>Trust {r.trustGrade}</span>
                    <span className="agent-ownership-badge" data-owned={owned ? "true" : "false"}>
                      {owned ? "내 직원 · owned" : "원격 게스트 · borrowed"}
                    </span>
                  </div>
                  <div className="hub-borrow-tagline">
                    {(ko ? r.tagline : r.taglineEn || r.tagline) || ""}
                    {r.installCount > 0 ? ` · ${r.installCount}${ko ? "회 사용" : " installs"}` : ""}
                  </div>
                </div>
                {owned ? (
                  <span className="hub-borrow-owned">
                    <IconCheck size={13} /> {ko ? "보유" : "owned"}
                  </span>
                ) : (
                  <button
                    onClick={() => addToLibrary(r.slug)}
                    disabled={busy === r.slug}
                    className="titlebar-nodrag"
                    data-dashboard-action="true"
                    title={ko ? "내 라이브러리에 추가하면 내 자산(owned)이 됩니다" : "Adding makes it yours (owned)"}
                  >
                    {busy === r.slug ? (ko ? "추가 중…" : "Adding…") : ko ? "내 팀에 추가" : "Add to my team"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="hub-borrow-note">
        {ko
          ? "허브 에이전트는 원격 게스트입니다 — 내 팀에 추가하면 내 라이브러리(owned)가 되어 게시자와 무관하게 동작합니다."
          : "Hub agents are remote guests — adding to your team makes them owned, independent of the publisher."}
      </div>
    </div>
  );
}
