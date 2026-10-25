"use client";

import { confirmPopup } from "@/lib/popup";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { readMcpManagementInventory } from "@shared/mcp-inventory-refresh";
import { ipc } from "@/lib/ipc";
import type { ServiceConnectRun } from "@/components/connect/ServiceConnect";
import { pluginSlugCandidates, usePluginBrandMap } from "@/components/PluginLogo";
import { ToolLogo, type LogoFrame } from "@/components/plugins/ToolLogo";
import { AuthorizeDialog } from "@/components/plugins/AuthorizeDialog";
import { SkillModal } from "@/components/plugins/SkillModal";
import { MoreMenu } from "@/components/plugins/DetailParts";
import {
  categoryLabel, groupByCategory, installPlugins, KeyStep, LoginStep, usePluginCatalog,
  mcpConnectionSetupStep, mcpConnectionAuthKind, mcpConnectionFailureMessage,
  type KeyStepState, type LoginStepState, type PluginPickerResult,
} from "@/components/plugins/PluginPickerCore";
import Link from "next/link";
import { mcpOAuthAPI, runMcpOAuthAttempt } from "@/components/plugins/McpOAuthAttempt";
import { hostProvidedIndex, isHostProvidedServer } from "@/components/plugins/hostProvided";
import {
  bundledSkills, connectionState, connectorDisplayName, listingName, listingTagline, oneLine, pluginSlugOfServer,
  type ItemType, type SkillRef,
} from "@/components/plugins/toolsModel";
import { ConnectorDetail } from "@/components/plugins/ConnectorDetail";
import { PluginDetail } from "@/components/plugins/PluginDetail";
import { SkillDetail } from "@/components/plugins/SkillDetail";
import { CardSection, Hero, RowGrid, type CardItem, type HeroSlide } from "@/components/plugins/DiscoverView";
import { GlyphSkill } from "@/components/plugins/DetailParts";
import styles from "./page.module.css";
import { useT } from "@/lib/i18n";
import type {
  InstalledMcpServer,
  MarketplaceListing,
  McpServerStatus,
  McpToolCatalogEntry,
} from "@/lib/types";
import {
  IconLock, IconSparkles, IconSearch, IconRefresh, IconSettings, IconPlus, IconChevronDown,
} from "@/components/Icon";
import { CredentialStoreWord } from "@/components/PlatformWord";

type Scope = "mine" | "discover";
type Route =
  | { kind: "browse" }
  | { kind: "plugin"; slug: string }
  | { kind: "connector"; serverId: string }
  | { kind: "catalogConnector"; id: string }
  | { kind: "skill"; pluginSlug: string; name: string; from: "plugin" | "skills" }
  | { kind: "custom" };

const HERO_SIZES = [44, 52, 70, 48, 58, 52];
const EMPTY_RESULT: PluginPickerResult = { installed: [], skipped: [], deferredKeys: [] };
/** Live skill-bundle installed probes per visit; each one reads one manifest. */
const SKILL_PROBE_LIMIT = 40;

export default function LibraryMcpsPage() {
  return <Suspense><LibraryMcpsRoute /></Suspense>;
}

function LibraryMcpsRoute() {
  const passiveEntry = useSearchParams().get("observe") === "1";
  return <LibraryMcpsView key={passiveEntry ? "observe" : "manage"} passiveEntry={passiveEntry} />;
}

function stubListing(slug: string): MarketplaceListing {
  return { slug, name: slug, nameEn: slug, tagline: "", taglineEn: "", trustGrade: "unknown", installCount: 0, manifestUrl: "" };
}

function LibraryMcpsView({ passiveEntry }: { passiveEntry: boolean }) {
  const { t, locale } = useT();
  const ko = locale === "ko";
  const [type, setType] = useState<ItemType>("plugin");
  const [scope, setScope] = useState<Scope>(passiveEntry ? "mine" : "discover");
  const [route, setRoute] = useState<Route>({ kind: "browse" });
  const [catalogRequested, setCatalogRequested] = useState(!passiveEntry);
  const brandMap = usePluginBrandMap({ enabled: catalogRequested });
  const hub = usePluginCatalog({ enabled: catalogRequested });
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /**
   * 마지막 추가에서 **못 붙은 것들**. 화면에 안 나오면 "추가했는데 없다"가 된다.
   * 실측(2026-08-20): skipped 를 버리면 사용자에게는 아무 일도 안 일어난 것처럼 보였다.
   */
  const [addSkipped, setAddSkipped] = useState<Array<{ slug: string; reason: string }>>([]);

  const [installed, setInstalled] = useState<InstalledMcpServer[]>([]);
  const [catalog, setCatalog] = useState<McpToolCatalogEntry[]>([]);
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({});
  const [connecting, setConnectingState] = useState<InstalledMcpServer | null>(null);
  const [connectMode, setConnectMode] = useState<"login" | "connect">("connect");
  const setConnecting = (server: InstalledMcpServer | null, mode: "login" | "connect" = "connect") => { setConnectMode(mode); setConnectingState(server); };
  const [skillModal, setSkillModal] = useState<SkillRef | null>(null);
  const [keyStep, setKeyStep] = useState<{ state: KeyStepState; serverIds: string[] } | null>(null);
  const [loginStep, setLoginStep] = useState<LoginStepState | null>(null);
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [installingCatalogId, setInstallingCatalogId] = useState<string | null>(null);
  const [skillInstalls, setSkillInstalls] = useState<Record<string, boolean>>({});
  const [skillProbeTick, setSkillProbeTick] = useState(0);
  // Without this the empty state renders on first paint for the 10-15s the
  // initial listing takes, pixel-identical to "nothing is connected".
  const [loaded, setLoaded] = useState(false);
  /* ★읽기 실패를 "없음" 으로 그리지 않기 위한 표식 (실측 2026-09-08). */
  const [loadFailed, setLoadFailed] = useState(false);
  // 커스텀 MCP 추가 폼
  const [cName, setCName] = useState("");
  const [cTransport, setCTransport] = useState<"stdio" | "sse" | "http">("http");
  const [cCommand, setCCommand] = useState("npx");
  const [cArgs, setCArgs] = useState("");
  const [cUrl, setCUrl] = useState("");
  const [cEnv, setCEnv] = useState("");
  const [cBusy, setCBusy] = useState(false);
  const customInFlight = useRef(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const endpointValid = validCustomMcpEndpoint(cUrl);
  const keysValid = !cEnv.trim() || cEnv.split(/[,\s]+/).every((key) => /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(key));
  const customValid = !!cName.trim() && keysValid && (cTransport === "stdio" ? !!cCommand.trim() : endpointValid);
  const customOpenCrabUrl = cTransport !== "stdio" && isOpenCrabCredentialUrl(cUrl);
  useEffect(() => {
    if (window.location.hash === "#custom") { setType("connector"); setRoute({ kind: "custom" }); }
  }, []);

  const refresh = useCallback(async (probeStatus = !passiveEntry) => {
    const api = ipc();
    if (!api) { setLoadFailed(true); setLoaded(true); return; }
    /*
     * ★못 읽었는데 화면은 "아직 연결한 도구가 없습니다" 를 그렸다 (읽기 실패 실측
     *   2026-09-08). 실패는 사실이 아니다 — 읽지 못했다는 것을 말한다.
     */
    let loadedRows;
    try {
      loadedRows = await readMcpManagementInventory(api.mcpTools, probeStatus);
    } catch {
      setLoadFailed(true);
      setLoaded(true);
      return;
    }
    const [i, s] = loadedRows;
    setLoadFailed(false);
    setInstalled(i);
    if (s) setStatuses(Object.fromEntries(s.map((status) => [status.id, status])));
    setLoaded(true);
  }, [passiveEntry]);

  const refreshCatalog = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    try { setCatalog(await api.mcpTools.listCatalog()); } catch { /* host rows stay identified by their own launch contract */ }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshCatalog();
  }, [refresh, refreshCatalog]);

  /* Skill bundles have no registry row; the bundle marker is read through the manifest preview. */
  useEffect(() => {
    if (!catalogRequested || !hub.loaded) return;
    const api = ipc();
    if (!api) return;
    let active = true;
    const candidates = hub.listings.filter((listing) => (listing.skillCount ?? 0) > 0 || listing.pluginKind === "skill").slice(0, SKILL_PROBE_LIMIT);
    void Promise.allSettled(candidates.map(async (listing) => {
      const preview = await api.mcpTools.previewHubPlugin(listing.manifestUrl) as { skillsAlreadyInstalled?: boolean };
      return [listing.slug, preview.skillsAlreadyInstalled === true] as const;
    })).then((results) => {
      if (!active) return;
      const next: Record<string, boolean> = {};
      for (const result of results) if (result.status === "fulfilled") next[result.value[0]] = result.value[1];
      setSkillInstalls(next);
    });
    return () => { active = false; };
  }, [catalogRequested, hub.loaded, hub.listings, skillProbeTick]);

  const refreshAll = async () => {
    if (refreshing) return;
    setCatalogRequested(true);
    setRefreshing(true);
    try { await Promise.all([refresh(true), hub.refresh(), refreshCatalog()]); setSkillProbeTick((tick) => tick + 1); } finally { setRefreshing(false); }
  };

  async function addCustom() {
    const api = ipc();
    if (!api || customInFlight.current || !customValid || customOpenCrabUrl) return;
    customInFlight.current = true;
    setCBusy(true);
    setActionError(null);
    try {
      const server = await api.mcpTools.installCustom({
        name: cName.trim(),
        transport: cTransport,
        command: cTransport === "stdio" ? cCommand.trim() || "npx" : undefined,
        args: cTransport === "stdio" ? cArgs.trim().split(/\s+/).filter(Boolean) : undefined,
        url: cTransport !== "stdio" ? cUrl.trim() : undefined,
        envKeys: cEnv.trim() ? cEnv.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : undefined,
      });
      setCName(""); setCArgs(""); setCUrl(""); setCEnv("");
      await refresh();
      setRoute({ kind: "connector", serverId: server.id });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "custom_install_failed");
    } finally {
      customInFlight.current = false;
      setCBusy(false);
    }
  }

  // URL을 붙여넣으면 원격 트랜스포트를 자동 감지하고 이름을 유추한다.
  function onUrlChange(v: string) {
    setCUrl(v);
    const trimmed = v.trim();
    if (!/^https?:\/\//i.test(trimmed)) return;
    try {
      const u = new URL(trimmed);
      const isSse = /(^|[/?&#])sse($|[/?&#])/i.test(u.pathname + u.search);
      setCTransport(isSse ? "sse" : "http");
      if (!cName.trim()) {
        // TLD가 포함된 완전한 호스트일 때만 이름 유추 — 미완성 호스트로 이름이 조기 확정되는 걸 막는다.
        const host = u.hostname.replace(/^www\./, "");
        if (host.includes(".")) {
          const label = host.split(".")[0];
          if (label) setCName(label);
        }
      }
    } catch {
      /* 아직 완성되지 않은 URL — 무시 */
    }
  }

  async function remove(server: InstalledMcpServer) {
    const api = ipc();
    if (!api) return;
    const name = locale === "en" ? server.nameEn || server.name : server.name;
    if (!await confirmPopup(t("mcps.confirm_remove", { name }), { locale, tone: "danger", confirmLabel: ko ? "제거" : "Remove" })) return;
    await api.mcpTools.remove(server.id);
    setStatuses((s) => { const next = { ...s }; delete next[server.id]; return next; });
    await refresh();
    setRoute({ kind: "browse" });
  }

  async function removePlugin(name: string, servers: InstalledMcpServer[]) {
    const api = ipc();
    if (!api || !servers.length) return;
    if (!await confirmPopup(t("mcps.confirm_remove", { name }), { locale, tone: "danger", confirmLabel: ko ? "제거" : "Remove" })) return;
    for (const server of servers) await api.mcpTools.remove(server.id);
    await refresh();
    setRoute({ kind: "browse" });
  }

  async function toggle(server: InstalledMcpServer) {
    const api = ipc();
    if (!api) return;
    await api.mcpTools.setEnabled(server.id, !server.enabled);
    await refresh();
  }

  async function probe(serverId: string) {
    const api = ipc();
    if (!api) return;
    try {
      const status = await api.mcpTools.test(serverId);
      setStatuses((previous) => ({ ...previous, [serverId]: status }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function logout(server: InstalledMcpServer) {
    const api = ipc();
    if (!api) return;
    await api.mcpTools.oauthDisconnect(server.id);
    await probe(server.id);
  }

  const connectServer = useCallback<ServiceConnectRun>(async (signal, update) => {
    const api = ipc();
    if (!api || !connecting) throw new Error(ko ? "연결을 사용할 수 없어요. (bridge_unavailable)" : "Connection is unavailable. (bridge_unavailable)");
    const assertActive = () => { if (signal.aborted) throw new Error("cancelled"); };
    update({ step: "setup", note: ko ? "저장된 연결 설정을 확인하고 있어요." : "Checking the saved configuration." });
    if (!connecting.enabled) { assertActive(); await api.mcpTools.setEnabled(connecting.id, true); assertActive(); }
    const probeOnce = async () => {
      assertActive();
      const result = await api.mcpTools.test(connecting.id);
      assertActive();
      setStatuses((previous) => ({ ...previous, [connecting.id]: result }));
      return result;
    };
    let status = await probeOnce();
    // A typed refusal and this exact connection's auth metadata determine the action.
    // OAuth support alone cannot turn a transport/credential-read failure into sign-in.
    const authStep = mcpConnectionSetupStep({
      authKind: mcpConnectionAuthKind(connecting, hub.listings),
      rows: [connecting], status,
    });
    if (authStep === "login") {
      const auth = await api.mcpTools.oauthStatus(connecting.id);
      assertActive();
      if (auth.supported) {
        update({ step: "login", note: ko ? "공식 로그인·동의 페이지를 열고 있어요." : "Opening official sign-in and consent." });
        await runMcpOAuthAttempt({ api: mcpOAuthAPI(api.mcpTools), serverId: connecting.id, signal, update: (progress) => {
          update({ step: "login", note: progress.status === "exchanging" ? ko ? "로그인 응답을 확인하고 있어요." : "Confirming the sign-in response." : ko ? "브라우저에서 로그인을 마쳐 주세요. 아래 공식 페이지로 직접 진행할 수도 있어요." : "Finish sign-in in the browser. You can also open the official page below.", manualUrl: progress.manualUrl });
        } });
        assertActive();
        update({ step: "verifying", note: ko ? "서버에 실제로 연결해 도구 목록을 확인하고 있어요." : "Connecting to the server to read its live tool list.", manualUrl: null });
        status = await probeOnce();
      }
    }
    if (status.missingEnv.length || !status.connected) throw new Error(mcpConnectionFailureMessage(status, ko));
    if (!status.tools.length) throw new Error(ko ? "서버 응답은 있지만 사용 가능한 도구가 없어요. (empty_tools)" : "The server responded but supplied no tools. (empty_tools)");
    return { evidence: [`tools/list · ${status.tools.length} ${ko ? "개 도구" : "tools"}`, status.tools.slice(0, 3).map((tool) => tool.name).join(", "), new Date(status.checkedAt).toLocaleTimeString()] };
  }, [connecting, ko, hub.listings]);

  /* ── derived data ─────────────────────────────────────────────── */
  const hostIndex = useMemo(() => hostProvidedIndex(catalog, installed), [catalog, installed]);
  const visible = useMemo(() => installed.filter((server) => !isHostProvidedServer(server, hostIndex)), [installed, hostIndex]);
  const connectorCatalog = useMemo(() => catalog.filter((entry) => !hostIndex.catalogIds.has(entry.id)), [catalog, hostIndex]);
  const listingBySlug = useMemo(() => new Map(hub.listings.map((listing) => [listing.slug, listing])), [hub.listings]);
  const pluginServers = useMemo(() => {
    const map = new Map<string, InstalledMcpServer[]>();
    for (const server of visible) {
      const slug = pluginSlugOfServer(server);
      if (!slug) continue;
      map.set(slug, [...(map.get(slug) ?? []), server]);
    }
    return map;
  }, [visible]);
  /** A catalog connector row for the same service as a Hub plugin (old installs). */
  const matchingStandalone = useCallback((listing: MarketplaceListing) => {
    const candidates = pluginSlugCandidates({ slug: listing.slug, name: listing.name });
    return visible.filter((server) => !pluginSlugOfServer(server) && pluginSlugCandidates({ catalogId: server.catalogId, name: server.name }).some((candidate) => candidates.includes(candidate)));
  }, [visible]);
  const connectorsOfPlugin = useCallback((slug: string) => {
    const listing = listingBySlug.get(slug);
    return [...(pluginServers.get(slug) ?? []), ...(listing ? matchingStandalone(listing) : [])];
  }, [listingBySlug, pluginServers, matchingStandalone]);
  const installedPluginSlugs = useMemo(() => {
    const slugs = new Set<string>(pluginServers.keys());
    for (const [slug, present] of Object.entries(skillInstalls)) if (present) slugs.add(slug);
    return [...slugs];
  }, [pluginServers, skillInstalls]);
  const pluginInstalled = (listing: MarketplaceListing) => !loadFailed && (installedPluginSlugs.includes(listing.slug) || matchingStandalone(listing).length > 0);
  const allSkills = useMemo(() => bundledSkills(ko), [ko]);
  const installedSkills = allSkills.filter((skill) => skillInstalls[skill.pluginSlug]);

  const needle = query.trim().toLowerCase();
  const matchesText = (...values: Array<string | undefined>) => !needle || values.filter(Boolean).join(" ").toLowerCase().includes(needle);
  const pluginMatches = hub.listings.filter((listing) => matchesText(listing.name, listing.nameEn, listing.slug, listing.tagline, listing.taglineEn, listing.category, listing.developer));
  const connectorMatches = connectorCatalog.filter((entry) => matchesText(entry.name, entry.nameEn, entry.id, entry.description, entry.descriptionEn, entry.category));
  const skillMatches = allSkills.filter((skill) => matchesText(skill.name, skill.description, skill.pluginSlug));

  const serverName = (server: InstalledMcpServer) => connectorDisplayName(server, ko);
  const serverReady = (server: InstalledMcpServer) => connectionState(server, statuses[server.id], loadFailed) === "ready";
  const pluginLabel = (slug: string) => { const listing = listingBySlug.get(slug); return listing ? listingName(listing, ko) : slug; };

  /* ── navigation ───────────────────────────────────────────────── */
  const openPlugin = (slug: string) => { setCatalogRequested(true); setRoute({ kind: "plugin", slug }); };
  const openConnector = (server: InstalledMcpServer) => setRoute({ kind: "connector", serverId: server.id });
  const openSkill = (skill: SkillRef, from: "plugin" | "skills") => setRoute({ kind: "skill", pluginSlug: skill.pluginSlug, name: skill.name, from });
  const goBrowse = (next: ItemType, nextScope?: Scope) => { setType(next); if (nextScope) setScope(nextScope); setRoute({ kind: "browse" }); if (next !== "connector" || nextScope === "discover") setCatalogRequested(true); };
  const typeLabel = (value: ItemType) => value === "plugin" ? ko ? "플러그인" : "Plugins" : value === "connector" ? ko ? "커넥터" : "Connectors" : ko ? "스킬" : "Skills";

  /* ── install flows (same steps as the picker) ─────────────────── */
  const finishInstall = async (result: PluginPickerResult, serverIds: string[] = []) => {
    setAddSkipped(result.skipped);
    for (const id of serverIds) await probe(id);
    await refreshAll();
  };

  async function addListing(listing: MarketplaceListing) {
    if (installingSlug) return;
    setInstallingSlug(listing.slug);
    setActionError(null);
    let outcome: Awaited<ReturnType<typeof installPlugins>>;
    try {
      outcome = await installPlugins({ chosen: [listing], ko });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      setInstallingSlug(null);
      return;
    }
    setInstallingSlug(null);
    await refresh(true);
    // 로그인이 먼저다 — 키 입력은 다른 사이트를 다녀와야 할 수 있다.
    if (outcome.needLogin.length > 0) { setLoginStep({ queue: outcome.needLogin, index: 0, keyQueue: outcome.needKeys, result: outcome.result }); return; }
    if (outcome.needKeys.length > 0) { setKeyStep({ state: { queue: outcome.needKeys, index: 0, result: outcome.result }, serverIds: [] }); return; }
    await finishInstall(outcome.result);
  }

  async function addCatalogConnector(entry: McpToolCatalogEntry) {
    const api = ipc();
    if (!api || installingCatalogId) return;
    setInstallingCatalogId(entry.id);
    setActionError(null);
    try {
      const server = await api.mcpTools.install(entry.id);
      await refresh(true);
      setRoute({ kind: "connector", serverId: server.id });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingCatalogId(null);
    }
  }

  const enterKeys = (server: InstalledMcpServer, keys: string[]) => {
    if (!keys.length) { setConnecting(server); return; }
    setKeyStep({ state: { queue: [{ slug: server.catalogId ?? pluginSlugOfServer(server) ?? server.name, name: serverName(server), envKeys: keys, serverIds: [server.id] }], index: 0, result: EMPTY_RESULT }, serverIds: [server.id] });
  };

  /* ── sidebar ──────────────────────────────────────────────────── */
  const sidebarGroups: Array<{ label: string; items: Array<{ key: string; icon: React.ReactNode; name: string; menu?: Array<{ label: string; onClick: () => void; danger?: boolean }>; active: boolean; onClick: () => void; title?: string }> }> = [
    { label: typeLabel("plugin"), items: installedPluginSlugs.map((slug) => {
      const listing = listingBySlug.get(slug);
      const servers = pluginServers.get(slug) ?? [];
      return { key: `p-${slug}`, icon: <ToolLogo slug={slug} name={listing?.nameEn ?? slug} frame="bare" brandColor={listing?.brandColor} brandMap={brandMap} />, name: pluginLabel(slug), menu: servers.length ? [{ label: ko ? "제거" : "Remove", danger: true, onClick: () => void removePlugin(pluginLabel(slug), connectorsOfPlugin(slug)).catch((error) => setActionError(String(error))) }] : [], active: route.kind === "plugin" && route.slug === slug, onClick: () => openPlugin(slug) };
    }) },
    // A connector that came inside a plugin lives under that plugin (its detail lists it); only standalone
    // connectors are listed on their own, so the same server never appears twice in the column.
    { label: typeLabel("connector"), items: visible.filter((server) => !pluginSlugOfServer(server)).map((server) => ({
      key: `c-${server.id}`, icon: <ToolLogo catalogId={server.catalogId} name={server.nameEn || server.name} frame="bare" brandMap={brandMap} />, name: serverName(server), menu: [{ label: server.enabled ? ko ? "끄기" : "Turn off" : ko ? "켜기" : "Turn on", onClick: () => void toggle(server).catch((error) => setActionError(String(error))) }, { label: ko ? "제거" : "Remove", danger: true, onClick: () => void remove(server).catch((error) => setActionError(String(error))) }], active: route.kind === "connector" && route.serverId === server.id, onClick: () => openConnector(server),
    })) },
    { label: typeLabel("skill"), items: installedSkills.map((skill) => ({
      key: `s-${skill.pluginSlug}-${skill.name}`, icon: <span className={styles.skillGlyph}><GlyphSkill size={15} /></span>, name: skill.name, menu: [], active: route.kind === "skill" && route.pluginSlug === skill.pluginSlug && route.name === skill.name, onClick: () => openSkill(skill, "skills"),
    })) },
  ];
  const sidebarEmpty = sidebarGroups.every((group) => group.items.length === 0);

  /* ── browse content ───────────────────────────────────────────── */
  const pluginCard = (listing: MarketplaceListing, frame: LogoFrame = "card"): CardItem => ({
    key: listing.slug, icon: <ToolLogo slug={listing.slug} name={listing.nameEn || listing.name} frame={frame} brandColor={listing.brandColor} brandMap={brandMap} />,
    name: listingName(listing, ko), description: listingTagline(listing, ko), maker: listing.developer || listing.ownerName,
    installed: hub.installedKnown && pluginInstalled(listing), onOpen: () => openPlugin(listing.slug),
  });
  const connectorCard = (entry: McpToolCatalogEntry): CardItem => {
    const server = visible.find((row) => row.catalogId === entry.id);
    return {
      key: entry.id, icon: <ToolLogo catalogId={entry.id} name={entry.nameEn || entry.name} frame="card" brandColor={entry.brandColor} brandMap={brandMap} />,
      name: ko ? entry.name : entry.nameEn || entry.name, description: ko ? entry.description : entry.descriptionEn || entry.description,
      installed: !!server, onOpen: () => server ? openConnector(server) : setRoute({ kind: "catalogConnector", id: entry.id }),
    };
  };
  const skillCard = (skill: SkillRef): CardItem => {
    const listing = listingBySlug.get(skill.pluginSlug);
    return {
      key: `${skill.pluginSlug}/${skill.name}`, icon: <GlyphSkill size={18} />, name: skill.name, description: oneLine(skill.description, 200),
      maker: listing?.developer || listing?.ownerName, installed: !!skillInstalls[skill.pluginSlug], onOpen: () => openSkill(skill, "skills"),
    };
  };
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const pluginGroups = groupByCategory(pluginMatches.filter((listing) => !listing.featured), ko);
  const featuredPlugins = pluginMatches.filter((listing) => listing.featured);
  const heroSlides: HeroSlide[] = type === "plugin"
    ? pluginGroups.slice(0, 4).map(([category, rows]) => ({
      key: category, eyebrow: "Agentlas Hub", title: category, subtitle: ko ? `플러그인 ${rows.length}개` : `${rows.length} plugins`,
      icons: rows.slice(0, 6).map((listing, index) => <ToolLogo key={listing.slug} slug={listing.slug} name={listing.nameEn || listing.name} frame="hero" size={HERO_SIZES[index % HERO_SIZES.length]} brandColor={listing.brandColor} brandMap={brandMap} />),
      onExplore: () => scrollTo(`cat-plugin-${category}`),
    }))
    : type === "connector"
      ? [...new Set(connectorMatches.map((entry) => entry.category))].map((category) => {
        const rows = connectorMatches.filter((entry) => entry.category === category);
        const title = categoryLabel(category, ko);
        return {
          key: category, eyebrow: "Agentlas", title, subtitle: ko ? `커넥터 ${rows.length}개` : `${rows.length} connectors`,
          icons: rows.slice(0, 6).map((entry, index) => <ToolLogo key={entry.id} catalogId={entry.id} name={entry.nameEn || entry.name} frame="hero" size={HERO_SIZES[index % HERO_SIZES.length]} brandColor={entry.brandColor} brandMap={brandMap} />),
          onExplore: () => scrollTo("cat-connector-all"),
        };
      }).sort((left, right) => right.icons.length - left.icons.length).slice(0, 4)
      : [];

  const discover = type === "plugin" ? <>
    <Hero slides={heroSlides} ko={ko} />
    <CardSection ko={ko} title={ko ? "추천 플러그인" : "Featured plugins"} items={featuredPlugins.map((listing) => pluginCard(listing))} />
    {pluginGroups.map(([category, rows]) => <CardSection key={category} id={`cat-plugin-${category}`} ko={ko} title={category} items={rows.map((listing) => pluginCard(listing))} />)}
    {pluginMatches.length === 0 && <Empty text={needle ? ko ? `“${query.trim()}”과 맞는 플러그인이 없어요.` : `No plugins match “${query.trim()}”.` : ko ? "카탈로그를 불러오는 중…" : "Loading the catalog…"} />}
  </> : type === "connector" ? <>
    <Hero slides={heroSlides} ko={ko} />
    <CardSection id="cat-connector-all" ko={ko} title={ko ? "인기 커넥터" : "Popular connectors"} items={connectorMatches.map(connectorCard)} />
    {connectorMatches.length === 0 && <Empty text={needle ? ko ? `“${query.trim()}”과 맞는 커넥터가 없어요.` : `No connectors match “${query.trim()}”.` : ko ? "커넥터 카탈로그를 읽지 못했어요." : "The connector catalog is unavailable."} />}
  </> : <>
    <CardSection ko={ko} title={ko ? "스킬" : "Skills"} items={skillMatches.map(skillCard)} />
    {skillMatches.length === 0 && <Empty text={ko ? "표시할 스킬이 없어요." : "No skills to show."} />}
  </>;

  const mineItems: CardItem[] = type === "plugin"
    ? installedPluginSlugs.map((slug) => { const listing = listingBySlug.get(slug); return listing ? pluginCard(listing, "row") : { key: slug, icon: <ToolLogo slug={slug} name={slug} frame="row" brandMap={brandMap} />, name: slug, installed: true, onOpen: () => openPlugin(slug) }; })
    : type === "connector"
      ? visible.map((server) => ({ key: server.id, icon: <ToolLogo catalogId={server.catalogId} name={server.nameEn || server.name} frame="row" brandMap={brandMap} />, name: serverName(server), description: pluginSlugOfServer(server) ? pluginLabel(pluginSlugOfServer(server) as string) : undefined, installed: true, onOpen: () => openConnector(server) }))
      : installedSkills.map((skill) => ({ ...skillCard(skill), icon: <span className={styles.skillRowIcon}><GlyphSkill size={18} /></span> }));
  const mine = <>
    {!loaded ? <Empty text={ko ? "불러오는 중…" : "Loading…"} /> : loadFailed ? <Empty text={ko ? "설치 상태를 읽지 못했어요" : "Could not read installed state"} /> : mineItems.length === 0
      ? <Empty text={ko ? `설치된 ${typeLabel(type)} 없음` : `No ${typeLabel(type).toLowerCase()} installed`} />
      : <RowGrid ko={ko} items={mineItems.map((item) => ({ ...item, installed: true }))} />}
  </>;

  /* ── detail routes ────────────────────────────────────────────── */
  let detail: React.ReactNode = null;
  if (route.kind === "plugin") {
    const listing = listingBySlug.get(route.slug) ?? stubListing(route.slug);
    const servers = connectorsOfPlugin(route.slug);
    detail = <PluginDetail key={route.slug} ko={ko} brandMap={brandMap} listing={listing} connectors={servers} statuses={statuses} loadFailed={loadFailed}
      trail={[{ label: typeLabel("plugin"), onClick: () => goBrowse("plugin") }, { label: listingName(listing, ko) }]}
      skillsInstalled={!!skillInstalls[route.slug]} installing={installingSlug === route.slug}
      onAdd={() => void addListing(listing)} onCustomSetup={() => { setType("connector"); setRoute({ kind: "custom" }); }}
      onOpenConnector={openConnector} onOpenSkill={(skill) => setSkillModal(skill)}
      onRemove={() => void removePlugin(listingName(listing, ko), servers).catch((error) => setActionError(String(error)))}
      onVerify={(server) => setConnecting(server)} />;
  } else if (route.kind === "connector" || route.kind === "catalogConnector") {
    const server = route.kind === "connector" ? installed.find((row) => row.id === route.serverId) : undefined;
    const entry = route.kind === "catalogConnector" ? catalog.find((row) => row.id === route.id) : server?.catalogId ? catalog.find((row) => row.id === server.catalogId) : undefined;
    const ownerSlug = server ? pluginSlugOfServer(server) : null;
    const owner = ownerSlug ? listingBySlug.get(ownerSlug) : undefined;
    const name = server ? serverName(server) : entry ? ko ? entry.name : entry.nameEn || entry.name : "";
    detail = server || entry ? <ConnectorDetail key={server?.id ?? entry?.id} ko={ko} brandMap={brandMap} server={server} entry={entry} status={server ? statuses[server.id] : undefined} loadFailed={loadFailed}
      trail={ownerSlug ? [{ label: typeLabel("plugin"), onClick: () => goBrowse("plugin") }, { label: pluginLabel(ownerSlug), onClick: () => openPlugin(ownerSlug) }, { label: name }] : [{ label: typeLabel("connector"), onClick: () => goBrowse("connector") }, { label: name }]}
      ownerName={ownerSlug ? pluginLabel(ownerSlug) : undefined} brandColor={owner?.brandColor} busy={!!entry && installingCatalogId === entry.id}
      onVerify={(row, mode) => setConnecting(row, mode)} onEnterKeys={enterKeys}
      onToggle={(row) => void toggle(row).catch((error) => setActionError(String(error)))}
      onRemove={(row) => void remove(row).catch((error) => setActionError(String(error)))}
      onInstall={(row) => void addCatalogConnector(row)} onLogout={logout} />
      : <Empty text={loaded ? ko ? "이 커넥터를 찾지 못했어요." : "This connector was not found." : ko ? "불러오는 중…" : "Loading…"} />;
  } else if (route.kind === "skill") {
    const skill = allSkills.find((row) => row.pluginSlug === route.pluginSlug && row.name === route.name);
    const listing = listingBySlug.get(route.pluginSlug) ?? stubListing(route.pluginSlug);
    detail = skill ? <SkillDetail key={`${skill.pluginSlug}/${skill.name}`} ko={ko} skill={skill} pluginName={listingName(listing, ko)}
      backLabel={route.from === "plugin" ? listingName(listing, ko) : typeLabel("skill")}
      onBack={() => route.from === "plugin" ? openPlugin(route.pluginSlug) : goBrowse("skill")}
      installed={!!skillInstalls[route.pluginSlug]} installing={installingSlug === route.pluginSlug}
      onAdd={() => void addListing(listing)} />
      : <Empty text={ko ? "이 스킬의 내용을 찾지 못했어요." : "This skill's contents were not found."} />;
  } else if (route.kind === "custom") {
    detail = <div className={styles.customPage}>
      <h1 className={styles.customTitle}>{ko ? "커스텀 MCP 추가" : "Add custom MCP"}</h1>
      <div className={styles.customCard}>
        <input className={styles.input} value={cName} onChange={(e) => setCName(e.target.value)} placeholder={t("mcps.custom.name")} aria-label={ko ? "연결 표시 이름" : "Connection display name"} />
        <div className={styles.segment} role="tablist">
          <button type="button" role="tab" aria-selected={cTransport !== "stdio"} data-active={cTransport !== "stdio"} onClick={() => setCTransport(cTransport === "stdio" ? "http" : cTransport)}>{t("mcps.custom.mode_remote")}</button>
          <button type="button" role="tab" aria-selected={cTransport === "stdio"} data-active={cTransport === "stdio"} onClick={() => setCTransport("stdio")}>{t("mcps.custom.mode_local")}</button>
        </div>
        {cTransport === "stdio" ? (
          <div className={styles.inputRow}>
            <input className={`${styles.input} ${styles.mono}`} style={{ flex: "0 0 110px" }} value={cCommand} onChange={(e) => setCCommand(e.target.value)} placeholder={t("mcps.custom.command")} aria-label={t("mcps.custom.command")} />
            <input className={`${styles.input} ${styles.mono}`} style={{ flex: "1 1 200px" }} value={cArgs} onChange={(e) => setCArgs(e.target.value)} placeholder={t("mcps.custom.args")} aria-label={t("mcps.custom.args")} />
          </div>
        ) : <>
          <input className={`${styles.input} ${styles.mono}`} value={cUrl} onChange={(e) => onUrlChange(e.target.value)} placeholder={t("mcps.custom.url")} aria-label={ko ? "MCP API 주소" : "MCP API endpoint"} aria-invalid={!!cUrl.trim() && !endpointValid} />
          {!!cUrl.trim() && !endpointValid && <p className={styles.fieldAlert} role="alert">{ko ? "인증정보가 포함되지 않은 HTTP(S) 주소를 입력하세요. 키는 Vault에 저장해 주세요." : "Enter an HTTP(S) endpoint without credentials. Store keys in Vault."}</p>}
          {cUrl.trim() && <div className={styles.detected}>
            <span>{t("mcps.custom.detected")}</span>
            <button type="button" data-active={cTransport === "http"} onClick={() => setCTransport("http")}>HTTP</button>
            <button type="button" data-active={cTransport === "sse"} onClick={() => setCTransport("sse")}>SSE</button>
          </div>}
          {customOpenCrabUrl && <p className={styles.fieldAlert} role="alert">
            {locale === "en"
              ? <>Private OpenCrab URLs contain a credential. Connect OpenCrab from Discover so the URL stays in <CredentialStoreWord ko={false} />.</>
              : <>OpenCrab 개인 URL에는 인증정보가 들어 있습니다. URL이 <CredentialStoreWord ko />에만 남도록 탐색에서 OpenCrab을 찾아 연결하세요.</>}
          </p>}
        </>}
        <input className={`${styles.input} ${styles.mono}`} value={cEnv} onChange={(e) => setCEnv(e.target.value)} placeholder={cTransport === "stdio" ? t("mcps.custom.env") : t("mcps.custom.header")} aria-label={ko ? "필수 키 또는 헤더 이름 (값 제외)" : "Required key or header names (no values)"} aria-invalid={!keysValid} />
        {!keysValid && <p className={styles.fieldAlert} role="alert">{ko ? "키 값을 붙여넣지 말고 키 또는 헤더 이름만 입력하세요." : "Enter only key or header names; do not paste values."}</p>}
        <div className={styles.customFoot}>
          <span className={styles.customHint}><IconLock size={12} />{ko ? <>값은 <CredentialStoreWord ko />에만 저장</> : <>Values stay in <CredentialStoreWord ko={false} /></>}</span>
          <button type="button" className={styles.primaryButton} onClick={() => void addCustom()} disabled={!customValid || cBusy || customOpenCrabUrl}>{cBusy ? t("mcps.testing") : t("mcps.custom.create")}</button>
        </div>
      </div>
    </div>;
  }

  const notices = <>
    {passiveEntry && route.kind === "browse" && <p className={styles.notice} role="status">{ko ? "연결 상태는 새로고침 또는 연결 확인을 누르면 검사합니다." : "Refresh or verify a connection to check its live state."}</p>}
    {actionError && <p className={styles.notice} role="alert">{actionError}<button type="button" onClick={() => setActionError(null)}>{ko ? "닫기" : "Dismiss"}</button></p>}
    {addSkipped.length > 0 && <div className={styles.notice} role="status"><strong>{ko ? "일부 항목을 추가하지 못했어요" : "Some items could not be added"}</strong>{addSkipped.map((row) => <p key={row.slug}>{row.slug} — {row.reason}</p>)}<button type="button" onClick={() => setAddSkipped([])}>{ko ? "닫기" : "Dismiss"}</button></div>}
    {route.kind === "browse" && hub.loadError && type !== "connector" && <p className={styles.notice} role="status">{ko ? "실시간 목록을 갱신하지 못했어요. 앱에 포함된 카탈로그를 표시합니다." : "The live catalog could not be refreshed. Showing the bundled catalog."}</p>}
  </>;

  return (
    <section className={styles.workspace}>
      <aside className={styles.sidebar} aria-label={ko ? "도구 설정" : "Tool settings"}>
        <h2 className={styles.sidebarTitle}>{ko ? "도구 설정" : "Tool settings"}</h2>
        <button type="button" className={styles.navItem} data-active={route.kind === "browse" && scope === "discover"} onClick={() => goBrowse(type, "discover")}><IconSparkles size={15} />{ko ? "탐색" : "Discover"}</button>
        <Link href="/library/env" className={styles.navItem}><IconLock size={15} />{ko ? "API 키" : "API keys"}</Link>
        {!loaded ? <p className={styles.sidebarHint}>{ko ? "불러오는 중…" : "Loading…"}</p>
          : loadFailed ? <p className={styles.sidebarHint}>{ko ? "설치 상태를 읽지 못했어요" : "Could not read installed state"}</p>
          : sidebarEmpty ? <><p className={styles.sidebarLabel}>{ko ? "설치됨" : "Installed"}</p><p className={styles.sidebarHint}>{ko ? "없음" : "None"}</p></>
          : sidebarGroups.filter((group) => group.items.length).map((group) => <div key={group.label}>
            <p className={styles.sidebarLabel}>{group.label}</p>
            {group.items.map((item) => <div key={item.key} role="button" tabIndex={0} className={styles.installedItem} data-active={item.active} onClick={item.onClick} onKeyDown={(event) => { if (event.key === "Enter") item.onClick(); }} title={item.name}>
              {item.icon}<span className={styles.installedName}>{item.name}</span>{item.menu && item.menu.length > 0 && <span className={styles.rowMore} onClick={(event) => event.stopPropagation()}><MoreMenu label={ko ? "더 보기" : "More"} items={item.menu} /></span>}
            </div>)}
          </div>)}
      </aside>
      <div className={styles.main}>
        {route.kind === "browse" ? <div className={styles.browse}>
          <h1 className={styles.title}>{ko ? "사용자 지정" : "Customize"}</h1>
          <div className={styles.toolbarRow}>
            <div className={styles.tabsGroup}>
              <div className={styles.typeTabs} role="tablist" aria-label={ko ? "종류" : "Type"}>
                {(["skill", "connector", "plugin"] as ItemType[]).map((value) => <button key={value} type="button" role="tab" aria-selected={type === value} className={styles.typeTab} data-active={type === value} onClick={() => goBrowse(value)}>{typeLabel(value)}</button>)}
              </div>
              <span className={styles.tabDivider} />
              <div className={styles.scopeSeg} role="tablist" aria-label={ko ? "범위" : "Scope"}>
                {(["mine", "discover"] as Scope[]).map((value) => <button key={value} type="button" role="tab" aria-selected={scope === value} data-active={scope === value} onClick={() => { setScope(value); if (value === "discover") setCatalogRequested(true); }}>{value === "mine" ? ko ? "내 항목" : "Mine" : ko ? "탐색" : "Discover"}</button>)}
              </div>
            </div>
            <div className={styles.toolbar}>
              <label className={styles.search}><IconSearch size={14} /><input ref={searchRef} value={query} onChange={(event) => { setCatalogRequested(true); setQuery(event.target.value); setScope("discover"); }} placeholder={ko ? "검색" : "Search"} aria-label={ko ? "검색" : "Search"} /></label>
              <button type="button" className={styles.iconButton} disabled={refreshing} onClick={() => void refreshAll()} aria-label={ko ? "새로고침" : "Refresh"} title={ko ? "새로고침" : "Refresh"}><IconRefresh size={16} /></button>
              <button type="button" className={styles.iconButton} onClick={() => { setType("connector"); setRoute({ kind: "custom" }); }} aria-label={ko ? "커스텀 MCP 설정" : "Custom MCP settings"} title={ko ? "커스텀 MCP" : "Custom MCP"}><IconSettings size={16} /></button>
              <div className={styles.addWrap}><button type="button" className={styles.addButton} onClick={() => setAddOpen((open) => !open)} aria-expanded={addOpen}><IconPlus size={14} />{ko ? "추가" : "Add"}<IconChevronDown size={13} /></button>{addOpen && <><button className={styles.menuDismiss} aria-label={ko ? "추가 메뉴 닫기" : "Close add menu"} onClick={() => setAddOpen(false)} /><div className={styles.addMenu}><button type="button" onClick={() => { setAddOpen(false); goBrowse("plugin", "discover"); setTimeout(() => searchRef.current?.focus(), 0); }}>{ko ? "플러그인 고르기" : "Choose plugins"}</button><button type="button" onClick={() => { setAddOpen(false); setType("connector"); setRoute({ kind: "custom" }); }}>{ko ? "커스텀 MCP 추가" : "Add custom MCP"}</button></div></>}</div>
            </div>
          </div>
          {notices}
          {scope === "discover" ? discover : mine}
        </div> : <>
          {notices && <div className={styles.detailNotices}>{notices}</div>}
          {detail}
        </>}
      </div>
      {skillModal && <SkillModal ko={ko} skill={skillModal} onClose={() => setSkillModal(null)} onOpenFull={() => { const skill = skillModal; setSkillModal(null); openSkill(skill, "plugin"); }} />}
      {connecting && <AuthorizeDialog name={serverName(connecting)} mode={connectMode} logo={<ToolLogo catalogId={connecting.catalogId} name={connecting.nameEn || connecting.name} frame="hero" brandMap={brandMap} />} ko={ko} run={connectServer} setupLink={connecting.envKeys.length ? { label: ko ? "저장된 키·연결 확인" : "Review saved keys and connections", href: "/library/env" } : undefined} onClose={() => { setConnecting(null); void refresh(); }} onDone={() => { setConnecting(null); void refresh(); }} />}
      {loginStep && <LoginStep ko={ko} state={loginStep} brandMap={brandMap} onAdvance={setLoginStep}
        onDone={(result, keyQueue) => { setLoginStep(null); if (keyQueue.length > 0) { setKeyStep({ state: { queue: keyQueue, index: 0, result }, serverIds: [] }); return; } void finishInstall(result); }} />}
      {keyStep && <KeyStep ko={ko} state={keyStep.state} brandMap={brandMap} onAdvance={(next) => setKeyStep((current) => current ? { ...current, state: next } : current)}
        onDone={(result) => { const ids = keyStep.serverIds; setKeyStep(null); void finishInstall(result, ids); }} />}
    </section>
  );
}

function validCustomMcpEndpoint(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.hash
      && ![...url.searchParams.keys()].some((key) => /(?:token|key|secret|password|authorization|credential|signature)/iu.test(key));
  } catch { return false; }
}

function isOpenCrabCredentialUrl(value: string): boolean {
  const raw = value.trim();
  if (/ocm_[A-Za-z0-9_-]{12,}/.test(raw)) return true;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return host === "opencrab.sh" || host.endsWith(".opencrab.sh");
  } catch {
    return false;
  }
}

function Empty({ text }: { text: string }) {
  return <div className={styles.empty}>{text}</div>;
}
