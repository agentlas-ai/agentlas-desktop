"use client";
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { pickLocalized, type Locale } from "@/lib/i18n";
import { isCallOnlyHubAgent } from "@shared/call-only-agent";
import type { MarketplaceListing } from "@/lib/types";

type Phase = { phase: "idle" } | { phase: "installing" } | { phase: "done"; message: string } | { phase: "error"; message: string };

/**
 * Hub 메뉴의 "내 Cloud" 탭 — 내 Agent Cloud 에 저장한 에이전트를 이 Mac 에 내려받는다.
 * 내려받은 사본은 로컬 에이전트라서 조직도 '에이전트 추가'에 그대로 나타난다.
 * 목록은 로그인한 계정의 것이고, 로그인은 앱이 이미 가진 흐름(onSignIn)으로만 한다.
 */
export function CloudAgentsPanel({
  locale,
  signedIn,
  installedSlugs,
  onSignIn,
  onInstalled,
}: {
  locale: Locale;
  signedIn: boolean | null;
  installedSlugs: Set<string>;
  onSignIn: () => Promise<boolean>;
  onInstalled: () => void;
}) {
  const ko = locale === "ko";
  const [rows, setRows] = useState<MarketplaceListing[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<Record<string, Phase>>({});

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) { setRows([]); return; }
    setLoadFailed(false);
    try {
      setRows(await api.marketplace.listMine());
    } catch {
      // 읽지 못한 것을 "저장한 에이전트가 없다"로 그리지 않는다.
      setLoadFailed(true);
      setRows((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    if (signedIn === false) { setRows([]); return; }
    if (signedIn === true) void load();
  }, [signedIn, load]);

  const download = (listing: MarketplaceListing) => {
    const api = ipc();
    if (!api || state[listing.slug]?.phase === "installing") return;
    setState((current) => ({ ...current, [listing.slug]: { phase: "installing" } }));
    void api.team.installMine(listing.slug)
      .then((installed) => {
        onInstalled();
        const name = pickLocalized(listing, locale).name;
        setState((current) => ({
          ...current,
          [listing.slug]: {
            phase: "done",
            message: isCallOnlyHubAgent(installed)
              ? (ko ? `"${name}"을(를) 호출용으로 등록했습니다.` : `Registered "${name}" for calls.`)
              : (ko ? `"${name}"을(를) 이 Mac에 내려받았습니다. 조직도의 '에이전트 추가'에서 앉힐 수 있습니다.` : `Downloaded "${name}" to this Mac. Add it to your organisation from "Add agent".`),
          },
        }));
      })
      .catch((error: unknown) => {
        setState((current) => ({
          ...current,
          [listing.slug]: {
            phase: "error",
            message: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, "") : String(error),
          },
        }));
      });
  };

  if (signedIn === false) {
    return (
      <div className="hub-signin-notice" role="status" data-testid="cloud-agents-signin">
        <span>
          <strong style={{ color: "var(--rd-ink)", fontWeight: 600 }}>{ko ? "Agentlas 로그인이 필요합니다." : "Sign in to Agentlas."}</strong>
          <span style={{ marginLeft: 8 }}>{ko ? "로그인하면 내 Agent Cloud 에 저장한 에이전트가 여기 나타납니다." : "Once signed in, the agents saved in your Agent Cloud appear here."}</span>
        </span>
        <button type="button" className="btn sm" onClick={() => void onSignIn().then((ok) => { if (ok) void load(); })}>
          {ko ? "로그인" : "Sign in"}
        </button>
      </div>
    );
  }

  const needle = query.trim().toLocaleLowerCase();
  const visible = (rows ?? []).filter((listing) => !needle
    || `${listing.name} ${listing.nameEn} ${listing.tagline} ${listing.taglineEn} ${listing.slug}`.toLocaleLowerCase().includes(needle));

  return (
    <section className="portal-panel hub-results-panel" id="hub-cloud" data-testid="cloud-agents-panel">
      <div className="card portal-search-panel rd-card-cream">
        <input
          className="portal-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={ko ? "내 Cloud 에이전트 검색..." : "Search my Cloud agents..."}
          aria-label={ko ? "내 Cloud 에이전트 검색" : "Search my Cloud agents"}
        />
      </div>
      {loadFailed && (
        <div className="hub-searching-notice" role="alert">
          <span>{ko ? "Agent Cloud 목록을 불러오지 못했습니다. 비어 있는 것이 아니라 읽지 못한 것입니다 — 잠시 뒤 다시 열어 주세요." : "The Agent Cloud list could not be loaded. It is not empty — the read failed. Try again in a moment."}</span>
          <button type="button" className="btn sm" onClick={() => void load()}>{ko ? "다시 시도" : "Retry"}</button>
        </div>
      )}
      {rows === null || (signedIn === null && rows.length === 0) ? (
        <div className="card portal-empty-panel" style={{ padding: 18 }}>{ko ? "Agent Cloud 불러오는 중…" : "Loading your Agent Cloud…"}</div>
      ) : visible.length > 0 ? (
        <div className="market-card-grid">
          {visible.map((listing) => {
            const loc = pickLocalized(listing, locale);
            const current = state[listing.slug] ?? { phase: "idle" as const };
            const have = installedSlugs.has(listing.slug) || current.phase === "done";
            return (
              <div key={listing.slug} className="card portal-entity-card hub-entity-card" data-entity-kind="cloud-agent">
                <div className="hub-card-head">
                  <div className="hub-card-main">
                    <div className="hub-card-kicker">{ko ? "내 Agent Cloud" : "MY AGENT CLOUD"}</div>
                    <div className="portal-card-title hub-card-title">{loc.name}</div>
                    <div className="hub-card-author">{listing.slug}</div>
                  </div>
                </div>
                <div className="hub-card-copy">{loc.tagline}</div>
                {(current.phase === "done" || current.phase === "error") && (
                  <div className="hub-plugin-approval-note" data-tone={current.phase === "error" ? "error" : "ok"}>{current.message}</div>
                )}
                <div className="hub-card-actions">
                  <button
                    type="button"
                    className={"btn sm hub-card-action-btn" + (!have && current.phase !== "installing" ? " primary" : "")}
                    disabled={have || current.phase === "installing"}
                    onClick={() => download(listing)}
                  >
                    {current.phase === "installing"
                      ? (ko ? "내려받는 중…" : "Downloading…")
                      : have ? (ko ? "내려받음" : "Downloaded") : (ko ? "내려받기" : "Download")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card portal-empty-panel" style={{ padding: 18 }}>
          <div style={{ fontFamily: "var(--rd-f-display)", fontSize: 20, fontWeight: 400 }}>
            {needle ? (ko ? "일치하는 에이전트가 없습니다" : "No agent matches") : (ko ? "Agent Cloud 에 저장한 에이전트가 없습니다" : "No agents are saved in your Agent Cloud")}
          </div>
        </div>
      )}
    </section>
  );
}
