"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { IconArrowLeft, IconArrowUp, IconClose, IconFileText, IconMail, IconPlus, IconSearch, IconSun, IconWand } from "@/components/Icon";
import { Select } from "@/components/Select";
import { ServiceConnectionsButton } from "@/components/connect/ServiceConnectionsButton";
import { AgentAvatar } from "@/components/AgentAvatar";
import { agentFaceSeedName } from "@shared/agent-face";
import { visibleAgents } from "@/lib/agent-visibility";
import { classifyHubEntity } from "@/lib/agent-entity-kind";
import { onAgentRosterChange } from "@/lib/agent-roster-events";
import { onHubBookmarkChange } from "@/lib/hub-bookmark-events";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import type { AgentUsageSummaryRow, HubAgentBookmark, InstalledAgent, MarketplaceListing, McpToolCatalogEntry, SkillCatalogEntry } from "@/lib/types";
import type { BuildListItem } from "@shared/build-workbench";
import { BuildsList, useBuildList } from "./BuildsList";
import styles from "./BuildWorkbench.module.css";

interface Props {
  ko: boolean; screen: "home" | "intro"; request: string; hasBuild: boolean;
  onRequest: (text: string) => void; onResume: () => void; onHome: () => void;
  onNew: () => void; onBlank: () => void; onCompose: (text: string) => void;
  /** media-carousel pictures, videos and files dropped or pasted on the intro composer join the build's attachments. */
  onAttachFiles?: (files: File[]) => void; attachmentCount?: number;
  /** F-D10: a row of the Builds tab was pressed (the page opens that saved build). */
  onOpenBuild?: (item: BuildListItem) => void;
}
type GallerySource = "local" | "cloud" | "hub";
type LoadState = "loading" | "ready" | "error" | "signed-out";
interface GalleryItem {
  key: string; source: GallerySource; agentId?: string; slug: string; name: string; nameEn: string;
  description: string; descriptionEn: string; href: string; saved: boolean;
  verified: number; installs: number;
  /** Real data only: connection names of a local agent, and the counts a Hub/Cloud listing reports. Empty / 0 = not shown. */
  connections: string[]; category: string; skills: number; connectionCount: number;
}
function positiveCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
function readWithin<T>(read: () => Promise<T>, timeout = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve().then(read),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Agent catalog timed out")), timeout); }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}
function isAgentListing(item: MarketplaceListing): boolean {
  if (!item || typeof item.slug !== "string" || !item.slug.trim()) return false;
  const kind = classifyHubEntity(item);
  return kind !== "plugin" && kind !== "graph";
}
function isLiveHubListing(item: MarketplaceListing): boolean {
  return item.source === "hub-index" || item.source === "hub-profile" || item.kind === "cloud-callable" || item.callable === true;
}
function usableDescription(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  // Some local package metadata contains adapter instructions rather than a
  // description. Do not present those instructions as product copy.
  return /(?:\bAGENTS\.md\b|\bagentlas\.json\b|package file reader|system.?prompt)/i.test(text) ? "" : text;
}
function galleryItemForLocal(item: InstalledAgent): GalleryItem {
  return { key: `local:${item.id}`, source: "local", agentId: item.id, slug: item.slug, name: item.localDisplayName || item.name,
    nameEn: item.localDisplayName || item.nameEn || item.name, description: usableDescription(item.tagline),
    descriptionEn: usableDescription(item.taglineEn || item.tagline), href: `/library/agents?agentId=${encodeURIComponent(item.id)}`,
    saved: Boolean(item.bookmarkedAt), verified: 0, installs: 0,
    connections: (Array.isArray(item.mcpServers) ? item.mcpServers : []).filter(value => typeof value === "string" && value.trim()).map(value => value.trim()),
    category: "", skills: 0, connectionCount: 0 };
}
function galleryItemForRemote(item: MarketplaceListing, source: "cloud" | "hub", saved = false): GalleryItem {
  const name = item.name || item.nameEn || item.slug;
  const kind = item.entityKind || "agent";
  return { key: `${source}:${kind}:${item.slug}`, source, slug: item.slug, name, nameEn: item.nameEn || name,
    description: usableDescription(item.tagline), descriptionEn: usableDescription(item.taglineEn || item.tagline),
    href: source === "cloud" ? `/marketplace?tab=cloud&q=${encodeURIComponent(item.slug)}`
      : `/marketplace/profile?slug=${encodeURIComponent(item.slug)}&name=${encodeURIComponent(name)}`,
    saved, verified: Number.isFinite(item.verifiedInvocations) ? Math.max(0, item.verifiedInvocations!) : 0,
    installs: Number.isFinite(item.installCount) ? Math.max(0, item.installCount) : 0,
    connections: [], category: typeof item.category === "string" ? item.category.trim() : "",
    skills: positiveCount(item.skillCount), connectionCount: positiveCount(item.mcpServerCount) };
}
function isMotion(item: GalleryItem): boolean {
  return /motion|animation|motiongraphic|모션|애니메이션/i.test(`${item.slug} ${item.name} ${item.nameEn} ${item.description} ${item.descriptionEn}`);
}
function rankedExamples(items: GalleryItem[]): GalleryItem[] {
  const compare = (a: GalleryItem, b: GalleryItem) => Number(isMotion(b)) - Number(isMotion(a))
    || Number(b.saved) - Number(a.saved) || b.verified - a.verified || b.installs - a.installs || a.name.localeCompare(b.name);
  const local = items.filter(item => item.source === "local").sort(compare);
  const cloud = items.filter(item => item.source === "cloud").sort(compare);
  const saved = items.filter(item => item.source === "hub" && item.saved).sort(compare);
  const hub = items.filter(item => item.source === "hub" && !item.saved).sort(compare);
  const queues = [local, cloud, saved, hub];
  const result: GalleryItem[] = [];
  for (let index = 0; index < 12; index += 1) {
    for (const queue of queues) if (queue[index] && result.length < 12) result.push(queue[index]);
  }
  return result;
}

/** Only real local, owned Cloud, and Hub entries are offered here. Browsing never installs or executes one. */
export function BuildLaunch({ ko, screen, request, hasBuild, onRequest, onResume, onHome, onNew, onBlank, onCompose, onAttachFiles, attachmentCount = 0, onOpenBuild }: Props) {
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [usage, setUsage] = useState<AgentUsageSummaryRow[]>([]);
  const [usageStatus, setUsageStatus] = useState<LoadState>("loading");
  const [localStatus, setLocalStatus] = useState<LoadState>("loading");
  const [cloud, setCloud] = useState<MarketplaceListing[]>([]);
  const [cloudStatus, setCloudStatus] = useState<LoadState>("loading");
  const [hub, setHub] = useState<MarketplaceListing[]>([]);
  const [hubStatus, setHubStatus] = useState<LoadState>("loading");
  const [bookmarks, setBookmarks] = useState<HubAgentBookmark[]>([]);
  const [agentTab, setAgentTab] = useState<"builds" | "recent" | "mine">("recent");
  // The Builds tab leads the list when there are saved builds (picture build-v5-home); a person's own tab choice is never overridden.
  const builds = useBuildList();
  const tabChosen = useRef(false);
  useEffect(() => { if (!tabChosen.current && builds.status === "ready" && builds.items.length > 0) setAgentTab("builds"); }, [builds.status, builds.items.length]);
  const pickTab = (tab: "builds" | "recent" | "mine") => { tabChosen.current = true; setAgentTab(tab); };
  const [heroSlide, setHeroSlide] = useState(0);
  const [query, setQuery] = useState("");
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryQuery, setGalleryQuery] = useState("");
  const [gallerySource, setGallerySource] = useState<"all" | GallerySource>("all");
  const [selected, setSelected] = useState("");
  const [refreshNumber, setRefreshNumber] = useState(0);
  const dialog = useRef<HTMLDialogElement | null>(null);
  // The source Select opens its list inside this dialog (a modal sits in the top layer; a list on <body> would be unreachable).
  const [dialogElement, setDialogElement] = useState<HTMLDialogElement | null>(null);
  const setDialog = useCallback((node: HTMLDialogElement | null) => { dialog.current = node; setDialogElement(node); }, []);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let alive = true, localVersion = 0, remoteVersion = 0;
    const api = ipc();
    const refreshLocal = () => {
      const version = ++localVersion;
      if (!api) { if (alive) { setLocalStatus("error"); setUsageStatus("error"); } return; }
      void readWithin(() => api.team.list()).then(rows => {
        if (alive && version === localVersion) {
          if (!Array.isArray(rows)) throw new Error("invalid local catalog");
          setAgents(visibleAgents(rows, { includeTeams: true }).filter(item => !item.parentTeamId && !item.sourceMissingSince)); setLocalStatus("ready");
        }
      }).catch(() => { if (alive && version === localVersion) setLocalStatus("error"); });
      void readWithin(() => api.agents.usageSummary()).then(rows => {
        if (alive && version === localVersion) { if (Array.isArray(rows)) { setUsage(rows); setUsageStatus("ready"); } else setUsageStatus("error"); }
      }).catch(() => { if (alive && version === localVersion) setUsageStatus("error"); });
    };
    const refreshRemote = (force = false) => {
      const version = ++remoteVersion;
      setCloud([]); setBookmarks([]); setCloudStatus("loading"); setHubStatus("loading");
      if (!api) { if (alive) { setCloudStatus("error"); setHubStatus("error"); } return; }
      const sessionRead = readWithin(() => api.auth.getSession(), 15_000);
      void sessionRead.then(async session => {
        if (!session?.signedIn) { if (alive && version === remoteVersion) setCloudStatus("signed-out"); return; }
        if (!alive || version !== remoteVersion) return;
        if (force && (api.marketplace.builderCatalogFresh !== true || !api.marketplace.listMineFresh || !api.marketplace.searchBuilderFresh)) throw new Error("fresh catalog unavailable");
        const rows = force
          ? await readWithin(() => api.marketplace.listMineFresh!(), 25_000).then(response => response?.fresh === true ? response.rows : null)
          : await readWithin(() => api.marketplace.listMine(), 25_000);
        if (alive && version === remoteVersion) { if (!Array.isArray(rows)) throw new Error("invalid cloud catalog"); setCloud(rows); setCloudStatus("ready"); }
      }).catch(() => { if (alive && version === remoteVersion) setCloudStatus("error"); });
      void sessionRead.then(session => session?.signedIn ? readWithin(() => api.marketplace.bookmarks(), 20_000) : []).then(rows => {
        if (alive && version === remoteVersion && Array.isArray(rows)) setBookmarks(rows);
      }).catch(() => undefined);
      void (force
        ? readWithin(() => api.marketplace.searchBuilderFresh!(), 25_000).then(response => response?.fresh === true ? response.rows : null)
        : readWithin(() => api.marketplace.search(""), 25_000)).then(rows => {
        if (alive && version === remoteVersion) { if (!Array.isArray(rows)) throw new Error("invalid hub catalog"); setHub(rows); setHubStatus("ready"); }
      }).catch(() => { if (alive && version === remoteVersion) setHubStatus("error"); });
    };
    refreshLocal(); refreshRemote(refreshNumber > 0);
    const offRoster = onAgentRosterChange(refreshLocal);
    const offBookmarks = onHubBookmarkChange(() => refreshRemote());
    const offAuth = api?.auth?.onSessionChanged?.(() => refreshRemote());
    return () => { alive = false; localVersion += 1; remoteVersion += 1; offRoster(); offBookmarks(); offAuth?.(); };
  }, [refreshNumber]);
  useEffect(() => {
    const element = dialog.current;
    if (galleryOpen && element && !element.open) element.showModal();
    if (!galleryOpen && element?.open) element.close();
  }, [galleryOpen]);

  const localItems = agents.map(galleryItemForLocal);
  const cloudItems = cloud.filter(isAgentListing).map(item => galleryItemForRemote(item, "cloud"));
  const hubMap = new Map<string, GalleryItem>();
  for (const bookmark of bookmarks) if (bookmark?.listing && isAgentListing(bookmark.listing)) {
    const item = galleryItemForRemote(bookmark.listing, "hub", bookmark.bookmarked !== false); hubMap.set(item.key, item);
  }
  for (const listing of hub) if (isAgentListing(listing) && isLiveHubListing(listing) && listing.visibility !== "background" && listing.visibility !== "private") {
    const item = galleryItemForRemote(listing, "hub"); if (!hubMap.has(item.key)) hubMap.set(item.key, item);
  }
  const gallery = [...localItems, ...cloudItems, ...hubMap.values()];
  const featured = rankedExamples(gallery);
  const pages = Math.max(1, Math.ceil(featured.length / 4));
  const fan = featured.slice(0, 5);
  const visibleSlide = Math.min(heroSlide, pages - 1);
  const sourceLabel = (source: GallerySource) => source === "local" ? (ko ? "내 데스크탑" : "On this computer") : source === "cloud" ? (ko ? "내 Cloud" : "My Cloud") : "Hub";
  const displayName = (item: GalleryItem) => ko ? item.name : item.nameEn || item.name;
  const displayDescription = (item: GalleryItem) => (ko ? item.description : item.descriptionEn || item.description) || (ko ? "에이전트 상세 정보를 확인하세요." : "Open this agent to see its details.");
  const normalizedQuery = galleryQuery.trim().toLocaleLowerCase();
  const options = gallery.filter(item => (gallerySource === "all" || item.source === gallerySource)
    && (!normalizedQuery || [item.name, item.nameEn, item.description, item.descriptionEn, item.slug].some(value => value.toLocaleLowerCase().includes(normalizedQuery))));
  const active = options.find(item => item.key === selected) ?? options[0];
  useEffect(() => {
    if (galleryOpen) dialog.current?.querySelector('[aria-pressed="true"][data-gallery-item]')?.scrollIntoView({ block: "nearest" });
  }, [galleryOpen, active?.key]);
  const openGallery = (key = "") => { setGalleryQuery(""); setGallerySource("all"); setSelected(key); setGalleryOpen(true); };
  const openItem = (item: GalleryItem) => { setGalleryOpen(false); navigate(item.href); };
  const recentById = new Map(usage.filter(row => row.installed).map(row => [row.agentId, row.lastUsedAt]));
  const filteredAgents = agents.filter(agent => [agent.localDisplayName, agent.name, agent.nameEn, agent.tagline, agent.taglineEn].some(value => value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const displayedAgents = agentTab === "recent" ? filteredAgents.filter(agent => recentById.has(agent.id)).sort((a, b) => (recentById.get(b.id) ?? "").localeCompare(recentById.get(a.id) ?? "")) : filteredAgents;
  const catalogLoading = localStatus === "loading" || cloudStatus === "loading" || hubStatus === "loading";
  const sourceIssue = (source: GallerySource): { text: string; retry: boolean } | null => {
    if (source === "cloud") {
      if (cloudStatus === "signed-out") return { text: ko ? "내 Cloud를 보려면 Agentlas에 로그인하세요." : "Sign in to see My Cloud.", retry: false };
      if (cloudStatus === "error") return { text: ko ? "내 Cloud 목록을 불러오지 못했어요." : "Could not load My Cloud.", retry: true };
    }
    if (source === "hub" && hubStatus === "error") return { text: ko ? "Hub 목록을 불러오지 못했어요." : "Could not load the Hub.", retry: true };
    return null;
  };
  const issues = (gallerySource === "all" ? [sourceIssue("cloud"), sourceIssue("hub")] : [sourceIssue(gallerySource)]).filter((issue): issue is { text: string; retry: boolean } => issue !== null);
  const issueText = issues.map(issue => issue.text).join(" · ");
  const issueRetry = issues.some(issue => issue.retry);
  const showStrip = issues.length > 0 && (gallerySource === "all" || options.length > 0);
  const retryButton = <button type="button" className={styles.noticeAction} onClick={() => setRefreshNumber(value => value + 1)}>{ko ? "다시 불러오기" : "Refresh"}</button>;
  const emptyListText = catalogLoading ? (ko ? "불러오는 중…" : "Loading…")
    : gallerySource === "cloud" && cloudStatus === "ready" && cloud.length === 0 ? (ko ? "내 Cloud가 비어 있거나 연결할 수 없어요." : "My Cloud may be empty or unavailable.")
    : (ko ? "표시할 에이전트가 없습니다." : "No agents to show.");
  const facts = (item: GalleryItem): { label: string; value: string }[] => {
    const rows: { label: string; value: string }[] = [{ label: ko ? "출처" : "Source", value: sourceLabel(item.source) + (item.saved ? (ko ? " · 저장한 에이전트" : " · Saved agent") : "") }];
    if (item.category) rows.push({ label: ko ? "분류" : "Category", value: item.category });
    if (item.skills > 0) rows.push({ label: ko ? "스킬" : "Skills", value: ko ? `${item.skills}개` : String(item.skills) });
    if (item.connectionCount > 0) rows.push({ label: ko ? "연결" : "Connections", value: ko ? `${item.connectionCount}개` : String(item.connectionCount) });
    if (item.verified > 0) rows.push({ label: ko ? "검증된 호출" : "Verified calls", value: ko ? `${item.verified}회` : String(item.verified) });
    if (item.installs > 0) rows.push({ label: ko ? "설치" : "Installs", value: ko ? `${item.installs}회` : String(item.installs) });
    return rows;
  };
  // Examples of what to ask for. Pressing one only fills the input; nothing is sent.
  const examples = [
    { icon: <IconMail size={18} />, title: ko ? "들어오는 요청 정리" : "Sort incoming requests",
      body: ko ? "받은 메일과 메시지를 읽고 급한 것부터 정리해 답장 초안을 만들어 줘요." : "Reads your mail and messages, sorts by urgency and drafts replies.",
      prompt: ko ? "받은 메일과 메시지를 읽고 급한 것부터 정리해서 답장 초안을 만들어 주는 에이전트를 만들어 줘." : "Create an agent that reads my incoming mail and messages, sorts them by urgency and drafts replies." },
    { icon: <IconSun size={18} />, title: ko ? "매일 아침 브리핑" : "Daily morning briefing",
      body: ko ? "정한 시간에 일정, 뉴스, 할 일을 모아 한 장으로 알려 줘요." : "Gathers your schedule, news and to-dos into one page at a set time.",
      prompt: ko ? "매일 아침 정한 시간에 내 일정과 뉴스, 할 일을 모아 한 장으로 정리해서 알려 주는 에이전트를 만들어 줘." : "Create an agent that, every morning at a set time, gathers my schedule, news and to-dos into a one-page briefing." },
    { icon: <IconFileText size={18} />, title: ko ? "자료 조사와 보고서" : "Research and reports",
      body: ko ? "주제를 조사해 출처가 붙은 보고서로 정리해 줘요." : "Researches a topic and writes it up as a report with sources.",
      prompt: ko ? "내가 정한 주제를 조사해서 출처가 붙은 보고서로 정리해 주는 에이전트를 만들어 줘." : "Create an agent that researches a topic I choose and writes a report with sources." },
  ];
  return <>
    {screen === "home" ? <section className={styles.home} aria-labelledby="build-home-title">
      <header className={styles.homeHeader}>
        <h1 id="build-home-title">{ko ? "에이전트" : "Agents"}</h1>
        <div className={styles.homeActions}>
          <label className={styles.search}><IconSearch size={15} /><input aria-label={ko ? "에이전트 검색" : "Search agents"} placeholder={ko ? "에이전트 검색" : "Search agents"} value={query} onChange={event => setQuery(event.target.value)} /></label>
          <button type="button" className={styles.primary} onClick={onNew}>{ko ? "만들기" : "Create"}</button>
        </div>
      </header>
      <p className={styles.homeLead}>{ko ? "내 일을 맡길 에이전트를 만들고 관리하세요" : "Create and manage agents for your work"}</p>
      <section className={styles.hero} aria-labelledby="build-hero-title">
        <div className={styles.heroText}><h2 id="build-hero-title">{ko ? <>내 에이전트와<br />Hub에서 시작하기</> : <>Start with your agents<br />and the Hub</>}</h2><p>{ko ? "내 데스크탑과 Cloud, Hub에서 실제 에이전트를 살펴보세요." : "Explore real agents on this computer, in your Cloud, and in the Hub."}</p><button className={styles.primary} onClick={() => navigate("/marketplace")}>{ko ? "에이전트 둘러보기" : "Explore agents"}</button></div>
        {featured.length ? <div className={styles.heroCards}>{featured.slice(visibleSlide * 4, visibleSlide * 4 + 4).map(item => <button key={item.key} onClick={() => openGallery(item.key)}><span className={styles.heroCardTop}><AgentAvatar name={displayName(item)} seedName={item.name} agentId={item.agentId} size={35} /><small className={styles.sourceTag}>{sourceLabel(item.source)}</small></span><strong>{displayName(item)}</strong><span className={styles.heroCardText}>{displayDescription(item)}</span></button>)}</div> : <p className={styles.heroEmpty}>{catalogLoading ? (ko ? "에이전트를 불러오는 중…" : "Loading agents…") : (ko ? "에이전트 목록을 확인해 주세요." : "Check your agent catalog.")}</p>}
        {pages > 1 && <div className={styles.heroPages} aria-label={ko ? "추천 에이전트 페이지" : "Featured agent pages"}>{Array.from({ length: pages }, (_, index) => <button key={index} aria-label={ko ? `추천 ${index + 1} 보기` : `Show featured page ${index + 1}`} aria-pressed={visibleSlide === index} onClick={() => setHeroSlide(index)} />)}</div>}
      </section>
      <div className={styles.libraryHeading}>
        <div className={styles.agentTabs} role="group" aria-label={ko ? "에이전트 목록" : "Agent lists"}>
          <button aria-pressed={agentTab === "recent"} aria-controls="build-agent-list" onClick={() => pickTab("recent")}>{ko ? "최근 사용" : "Recently used"}</button>
          <button aria-pressed={agentTab === "mine"} aria-controls="build-agent-list" onClick={() => pickTab("mine")}>{ko ? "내 에이전트" : "Your agents"}</button>
          {builds.status !== "unavailable" && (builds.items.length > 0 || agentTab === "builds") && <button aria-pressed={agentTab === "builds"} aria-controls="build-agent-list" onClick={() => pickTab("builds")}>{ko ? "빌드" : "Builds"}</button>}
        </div>
        <div className={styles.homeLinks}><Link href="/marketplace">{ko ? "에이전트 허브" : "Agent Hub"}</Link><button type="button" onClick={() => navigate("/library/agents")}>{ko ? "라이브러리 열기" : "Open library"}</button></div>
      </div>
      {hasBuild && <button className={styles.resume} onClick={onResume}><IconWand size={19} /><span><strong>{ko ? "만들던 에이전트 이어서 보기" : "Return to your build"}</strong><span>{request || (ko ? "진행 상태와 결과 확인" : "View progress and results")}</span></span></button>}
      <div id="build-agent-list">{agentTab === "builds" && builds.status !== "unavailable" ? <BuildsList ko={ko} items={builds.items} status={builds.status} onOpen={(item) => onOpenBuild?.(item)} /> : localStatus === "loading" || (agentTab === "recent" && usageStatus === "loading") ? <p role="status">{ko ? "에이전트를 불러오는 중…" : "Loading agents…"}</p> : localStatus === "error" || (agentTab === "recent" && usageStatus === "error") ? <p role="status" className={styles.empty}>{ko ? "에이전트 목록을 불러오지 못했어요." : "Could not load your agents."}</p> : displayedAgents.length ? <div className={styles.agentGrid}>{displayedAgents.map(agent => {
        const name = agent.localDisplayName || (ko ? agent.name : agent.nameEn || agent.name);
        return <button className={styles.agentCard} key={agent.id} onClick={() => navigate(`/library/agents?agentId=${encodeURIComponent(agent.id)}`)}><AgentAvatar name={name} seedName={agentFaceSeedName(agent)} agentId={agent.id} size={38} /><span><strong>{name}</strong><span>{usableDescription(ko ? agent.tagline : agent.taglineEn || agent.tagline)}</span></span></button>;
      })}</div> : <div className={styles.empty}><strong>{query ? (ko ? "검색 결과가 없습니다" : "No matching agents") : agentTab === "recent" ? (ko ? "최근 사용한 에이전트가 없습니다" : "No recently used agents") : (ko ? "내 에이전트가 없습니다" : "No agents on this computer")}</strong>{!query && <><p>{ko ? "에이전트를 만들거나 허브에서 둘러보세요." : "Create an agent or browse the Hub."}</p><div className={styles.emptyActions}><button className={styles.primary} onClick={onNew}><IconPlus size={15} />{ko ? "에이전트 만들기" : "Create agent"}</button><button className={styles.secondary} onClick={() => navigate("/marketplace")}>{ko ? "허브 둘러보기" : "Browse the Hub"}</button></div></>}</div>}</div>
    </section> : <section className={styles.intro} aria-labelledby="build-intro-title">
      <header className={styles.introHeader}><button className={styles.quietButton} onClick={onHome}><IconArrowLeft size={16} />{ko ? "뒤로" : "Back"}</button><button className={styles.quietButton} onClick={onBlank}>{ko ? "빈 상태로 시작" : "Start from scratch"}</button></header>
      <div className={styles.introBody}><img className={styles.introAvatar} src="/brand/one-characters/blue-wave.webp" alt="" /><h1 id="build-intro-title">{ko ? "에이전트에게 무엇을 시킬까요?" : "What should your agent do?"}</h1>
        <form className={styles.introComposer} onSubmit={event => { event.preventDefault(); if (request.trim()) onCompose(request.trim()); }}
          onDragOver={event => { if (onAttachFiles && event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
          onDrop={event => { if (!onAttachFiles || !event.dataTransfer.files.length) return; event.preventDefault(); onAttachFiles(Array.from(event.dataTransfer.files)); }}
          onPaste={event => { const files = Array.from(event.clipboardData?.files ?? []); if (!onAttachFiles || !files.length) return; event.preventDefault(); onAttachFiles(files); }}>
          <textarea ref={composerInput} autoFocus rows={2} aria-label={ko ? "에이전트가 할 일" : "What the agent should do"} placeholder={ko ? "다음과 같은 에이전트 만들기…" : "Create an agent that…"} value={request} onChange={event => onRequest(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (request.trim()) onCompose(request.trim()); } }} />
          <div className={styles.composerBar}>
            <button type="button" className={styles.iconButton} aria-label={ko ? (attachmentCount ? `제작 설정과 첨부 열기 (첨부 ${attachmentCount}개)` : "제작 설정과 첨부 열기") : (attachmentCount ? `Open configuration and attachments (${attachmentCount} attached)` : "Open configuration and attachments")} onClick={onResume}><IconPlus size={20} />{attachmentCount > 0 && <span data-build-intro-attachments="true" className={styles.attachBadge}>{attachmentCount}</span>}</button>
            <button type="submit" className={styles.sendButton} aria-label={ko ? "제작 설정으로 계속" : "Continue to build settings"} disabled={!request.trim()}><IconArrowUp size={18} /></button>
          </div>
        </form>
        <div className={styles.examples} role="group" aria-label={ko ? "시킬 일 예시" : "Examples of what to ask"}>{examples.map(example => <button key={example.title} type="button" onClick={() => { onRequest(example.prompt); composerInput.current?.focus(); }}><span className={styles.exampleIcon} aria-hidden="true">{example.icon}</span><strong>{example.title}</strong><span>{example.body}</span></button>)}</div>
      </div>
      <div className={styles.fanZone}>
        <button type="button" className={styles.templateLabel} onClick={() => openGallery()}>{ko ? "내 에이전트와 Hub 둘러보기" : "Explore my agents and the Hub"}</button>
        {fan.length > 0 && <div className={styles.templateFan} role="group" aria-label={ko ? "내 에이전트와 Hub의 에이전트" : "Agents from your computer, Cloud and Hub"}>{fan.map((item, index) => {
          const offset = index - (fan.length - 1) / 2;
          return <button key={item.key} type="button" data-outer={Math.abs(offset) > 1.75 ? "true" : undefined} style={{ "--fan-offset": offset } as CSSProperties} onClick={() => openGallery(item.key)}><AgentAvatar name={displayName(item)} seedName={item.name} agentId={item.agentId} size={44} /><strong>{displayName(item)}</strong><small className={styles.sourceTag}>{sourceLabel(item.source)}</small><span>{displayDescription(item)}</span></button>;
        })}</div>}
      </div>
    </section>}
    <dialog ref={setDialog} className={styles.templateDialog} onCancel={() => setGalleryOpen(false)} onClose={() => setGalleryOpen(false)} aria-labelledby="build-gallery-title">
      <button className={styles.dialogClose} aria-label={ko ? "에이전트 목록 닫기" : "Close agent catalog"} onClick={() => setGalleryOpen(false)}><IconClose size={19} /></button>
      <div className={styles.templateLayout}><aside>
        <div className={styles.galleryTools}>
          <label className={styles.search}><IconSearch size={14} /><input aria-label={ko ? "에이전트 목록 검색" : "Search agent catalog"} placeholder={ko ? "에이전트 검색" : "Search agents"} value={galleryQuery} onChange={event => setGalleryQuery(event.target.value)} /></label>
          <Select className={styles.sourceSelect} aria-label={ko ? "에이전트 출처" : "Agent source"} value={gallerySource} menuHost={dialogElement} onChange={event => setGallerySource(event.target.value as "all" | GallerySource)}>
            <option value="all">{ko ? "전체" : "All"}</option>
            {(["local", "cloud", "hub"] as const).map(source => <option key={source} value={source}>{sourceLabel(source)}</option>)}
          </Select>
        </div>
        {showStrip && <p className={styles.galleryNotice} role="status">{issueText}{issueRetry && retryButton}</p>}
        <div className={styles.templateList}>{options.map(item => <button key={item.key} data-gallery-item aria-pressed={active?.key === item.key} onClick={() => setSelected(item.key)}><AgentAvatar name={displayName(item)} seedName={item.name} agentId={item.agentId} size={26} /><span className={styles.listName}>{displayName(item)}</span>{gallerySource === "all" && <small>{sourceLabel(item.source)}</small>}</button>)}{!options.length && (issues.length > 0 && !showStrip ? <p className={styles.listEmpty} role="status">{issueText}{issueRetry && retryButton}</p> : <p className={styles.listEmpty}>{emptyListText}</p>)}</div></aside>
        <section>{active ? <>
          <div className={styles.galleryBody}>
            <AgentAvatar name={displayName(active)} seedName={active.name} agentId={active.agentId} size={64} />
            <h2 id="build-gallery-title">{displayName(active)}</h2>
            <p className={styles.galleryLead}>{displayDescription(active)}</p>
            {active.connections.length > 0 && <><h3>{ko ? "연결" : "Connections"}</h3><ul className={styles.chips}>{active.connections.map(name => <li key={name}>{name}</li>)}</ul></>}
            <h3>{ko ? "정보" : "Details"}</h3>
            <dl className={styles.facts}>{facts(active).map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
          </div>
          <footer className={styles.galleryFooter}><button className={styles.primary} onClick={() => openItem(active)}>{ko ? "상세 보기" : "View details"}</button></footer>
        </> : <div className={styles.galleryBody}><h2 id="build-gallery-title">{ko ? "내 에이전트와 Hub" : "My agents and Hub"}</h2><p className={styles.galleryLead}>{catalogLoading ? (ko ? "실제 에이전트 목록을 불러오고 있습니다." : "Loading your real agent catalog.") : (ko ? "검색을 바꾸거나 출처를 바꿔 보세요." : "Try another search or source.")}</p></div>}
        </section>
      </div>
    </dialog>
  </>;
}


/** Catalog browsing never installs a tool, injects a prompt or edits an agent. */
export function BuildResources({ ko, canAttach, canConfigure = canAttach, onAttachFolder, onStop, registered, connectionsTarget, onConnectionsOpenChange, connectionsCloseRequest, connectionsActive }: {
  ko: boolean; canAttach: boolean; canConfigure?: boolean; onAttachFolder: () => void; onStop?: () => void;
  registered: { id: string; kind: "agent" | "team"; name: string } | null;
  connectionsTarget: HTMLElement | null; onConnectionsOpenChange: (open: boolean) => void; connectionsCloseRequest: number; connectionsActive: boolean;
}) {
  const [catalog, setCatalog] = useState<"apps" | "skills" | null>(null);
  const [apps, setApps] = useState<McpToolCatalogEntry[]>([]);
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<Set<string> | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [skillText, setSkillText] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const readGeneration = useRef(0);
  const readOwner = useRef<string | null>(null);
  // Both agent and team import receipts identify the installed controller agent.
  const library = registered ? `/library/agents?agentId=${encodeURIComponent(registered.id)}` : null;

  useEffect(() => {
    const element = dialog.current;
    if (catalog && element && !element.open) element.showModal();
    if (!catalog) { if (element?.open) element.close(); trigger.current?.focus(); }
    let alive = true;
    readGeneration.current += 1;
    setQuery(""); setSelected(""); setSkillText(null); setFailed(false); setReadFailed(false); setReading(false);
    if (!catalog) return () => { alive = false; };
    setLoading(true);
    const api = ipc();
    void (async () => {
      try {
        if (catalog === "apps") {
          if (!api?.mcpTools?.listCatalog) throw new Error("catalog unavailable");
          const [rows, configured] = await Promise.allSettled([api.mcpTools.listCatalog(), Promise.resolve().then(() => api.mcpTools.listInstalled())]);
          if (!alive) return;
          if (rows.status !== "fulfilled") throw new Error("catalog unavailable");
          setApps(rows.value);
          setInstalled(configured.status === "fulfilled" ? new Set(configured.value.flatMap(row => row.catalogId ? [row.catalogId, row.id] : [row.id])) : null);
        } else {
          if (!api?.skills?.listCatalog) throw new Error("catalog unavailable");
          const rows = await api.skills.listCatalog();
          if (alive) setSkills(rows);
        }
      } catch { if (alive) setFailed(true); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; readGeneration.current += 1; };
  }, [catalog]);

  const rows = (catalog === "apps" ? apps.map(item => ({ id: item.id, name: ko ? item.name : item.nameEn || item.name, description: ko ? item.description : item.descriptionEn || item.description })) : skills.map(item => ({ id: item.slug, name: item.name, description: item.description })))
    .filter(item => `${item.name} ${item.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const active = rows.find(item => item.id === selected) ?? rows[0];
  readOwner.current = catalog === "skills" && active ? active.id : null;
  const readSkill = async () => {
    const owner = readOwner.current;
    if (!owner) return;
    const generation = ++readGeneration.current;
    setReading(true); setReadFailed(false); setSkillText(null);
    try {
      const api = ipc();
      if (!api?.skills?.readCatalog) throw new Error("catalog unavailable");
      const asset = await api.skills.readCatalog(owner);
      if (readGeneration.current === generation && readOwner.current === owner) setSkillText(asset.content);
    } catch { if (readGeneration.current === generation && readOwner.current === owner) setReadFailed(true); }
    finally { if (readGeneration.current === generation) setReading(false); }
  };
  const select = (id: string) => { readGeneration.current += 1; setSelected(id); setSkillText(null); setReading(false); setReadFailed(false); };

  // 만들기 전에는 연결·앱·스킬을 찾는 링크, 만든 뒤에는 그 에이전트를 다루는 링크 — 한 줄에 상태에 맞는 것만 둔다.
  return <section className={styles.resources} aria-label={ko ? "연결과 추가 설정" : "Connections and additional settings"}>
    <div className={styles.resourceActions}>
      {library ? <>
        <Link href={library}>{ko ? "이름·파일 설정" : "Name and file settings"}</Link>
        <Link href="/automation/new">{ko ? "자동화 만들기" : "Create automation"}</Link>
        <Link href={`${library}&tab=memory`}>{ko ? "메모리" : "Memory"}</Link>
      </> : <>
        <ServiceConnectionsButton className={styles.resourceLink} locale={ko ? "ko" : "en"} disabled={!canConfigure || Boolean(onStop)} embedded active={connectionsActive} portalTarget={connectionsTarget} onOpenChange={onConnectionsOpenChange} closeRequest={connectionsCloseRequest} />
        <button type="button" onClick={event => { trigger.current = event.currentTarget; setCatalog("apps"); }}>{ko ? "앱 찾아보기" : "Browse apps"}</button>
        <button type="button" onClick={event => { trigger.current = event.currentTarget; setCatalog("skills"); }}>{ko ? "스킬 찾아보기" : "Browse skills"}</button>
      </>}
    </div>
    <dialog ref={dialog} className={styles.resourceDialog} aria-label={catalog === "skills" ? (ko ? "엔진 스킬 카탈로그" : "Engine skill catalog") : (ko ? "앱 연결 카탈로그" : "App connection catalog")} onCancel={() => setCatalog(null)} onClose={() => setCatalog(null)}>
      <button type="button" className={styles.dialogClose} aria-label={ko ? "닫기" : "Close"} onClick={() => setCatalog(null)}><IconClose size={18} /></button>
      <header><h2>{catalog === "skills" ? (ko ? "엔진 스킬" : "Engine skills") : (ko ? "앱과 연결" : "Apps and connections")}</h2><p>{catalog === "skills" ? (ko ? "둘러보기만으로는 스킬이 추가되지 않아요." : "Browsing does not add a skill to an agent.") : (ko ? "연결돼 있어도 이 초안에서 사용하려면 승인이 필요해요." : "A configured connection is not approval for this draft.")}</p></header>
      <label className={styles.search}><IconSearch size={14} /><input aria-label={ko ? "카탈로그 검색" : "Search catalog"} value={query} onChange={event => { readGeneration.current += 1; setQuery(event.target.value); setSkillText(null); setReadFailed(false); setReading(false); }} /></label>
      {loading ? <p role="status">{ko ? "불러오는 중…" : "Loading…"}</p> : failed ? <p role="alert">{ko ? "카탈로그를 불러오지 못했어요." : "Could not load the catalog."}</p> : <div className={styles.resourceCatalog}>
        <aside>{rows.length ? rows.map(item => <button type="button" key={item.id} aria-pressed={active?.id === item.id} onClick={() => select(item.id)}>{item.name}</button>) : <p>{query.trim() ? (ko ? "검색 결과가 없습니다." : "No matching entries.") : (ko ? "현재 카탈로그에 항목이 없습니다." : "The current catalog is empty.")}</p>}</aside>
        <article>{active && <><h3>{active.name}</h3><p>{active.description}</p>{catalog === "apps" ? <p>{installed === null ? (ko ? "설정 상태를 확인하지 못했어요." : "Configuration status is unavailable.") : installed.has(active.id) ? (ko ? "이 데스크탑에 구성됨 · 이번 빌드 사용은 별도 검토" : "Configured on this computer · build access requires review") : (ko ? "이 데스크탑에 구성되지 않음" : "Not configured on this computer")}</p> : <><button type="button" disabled={reading} onClick={() => void readSkill()}>{ko ? "스킬 원문 읽기" : "Read skill source"}</button>{reading && <p role="status">{ko ? "읽는 중…" : "Reading…"}</p>}{readFailed && <p role="alert">{ko ? "원문을 불러오지 못했어요." : "Could not read this skill."}</p>}{skillText !== null && <pre>{skillText}</pre>}</>}</>}</article>
      </div>}
      <footer>{onStop && <button type="button" onClick={() => { setCatalog(null); onStop(); }}>{ko ? "제작 중지" : "Stop build"}</button>}{catalog === "apps" ? <Link href="/library/mcps">{ko ? "연결 관리 열기" : "Open connection settings"}</Link> : <button type="button" disabled={!canAttach} onClick={() => { setCatalog(null); onAttachFolder(); }}>{ko ? "실제 스킬 폴더 첨부" : "Attach a real skill folder"}</button>}<Link href="/marketplace">{ko ? "Hub에서 앱·스킬 찾기" : "Find apps and skills in Hub"}</Link><span>{ko ? "설치·저장은 각 화면에서 확인 후 진행해요." : "Confirm installation and saves in their respective screens."}</span></footer>
    </dialog>
  </section>;
}
