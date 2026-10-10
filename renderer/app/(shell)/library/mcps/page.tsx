"use client";

import { confirmPopup } from "@/lib/popup";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { ChipGrid, ConnectChip } from "@/components/connect/RuntimeConnect";
import { ServiceConnectPopup, type ServiceConnectRun } from "@/components/connect/ServiceConnect";
import { PluginLogo, pluginSlugCandidates, usePluginBrandMap } from "@/components/PluginLogo";
import { PluginPickerDialog } from "@/components/plugins/PluginPickerDialog";
import { groupByCategory, usePluginCatalog, mcpConnectionSetupStep, mcpConnectionAuthKind, mcpConnectionFailureMessage } from "@/components/plugins/PluginPickerCore";
import Link from "next/link";
import { mcpOAuthAPI, runMcpOAuthAttempt } from "@/components/plugins/McpOAuthAttempt";
import { LocalExecutionReview } from "@/components/plugins/PluginSetupReview";
import styles from "./page.module.css";
import { useT } from "@/lib/i18n";
import type {
  InstalledMcpServer,
  McpServerStatus,
} from "@/lib/types";
import {
  IconLock,
  IconWand, IconSearch, IconRefresh, IconSettings, IconPlus, IconChevronDown,
} from "@/components/Icon";

type Tab = "public" | "private";

export default function LibraryMcpsPage() {
  const { t, locale } = useT();
  const ko = locale === "ko";
  const brandMap = usePluginBrandMap();
  const [tab, setTab] = useState<Tab>("public");
  const hub = usePluginCatalog();
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [pickerSlugs, setPickerSlugs] = useState<string[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * 마지막 추가에서 **못 붙은 것들**. 화면에 안 나오면 "추가했는데 없다"가 된다.
   *
   * 실측(2026-08-20): 팝업이 돌려주던 skipped 를 이 페이지가 통째로 버리고 있었다.
   * 허브 목록에는 있지만 연결 정보(mcp 행)가 아직 없는 항목이 적지 않고, 그런 것을
   * 고르면 팝업이 조용히 닫히고 목록은 그대로였다 — 사용자에게는 아무 일도 안 일어난
   * 것처럼 보이고, 왜인지 알 길이 없었다.
   */
  const [addSkipped, setAddSkipped] = useState<Array<{ slug: string; reason: string }>>([]);

  const [installed, setInstalled] = useState<InstalledMcpServer[]>([]);
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({});
  const [connecting, setConnecting] = useState<InstalledMcpServer | null>(null);
  // Without this the empty state renders on first paint and stays for the
  // 10-15s the initial listing takes, pixel-identical to "nothing is
  // connected" — a user checking plugin status in that window concludes the
  // app has no tools and leaves.
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
  const endpointValid = validCustomMcpEndpoint(cUrl);
  const keysValid = !cEnv.trim() || cEnv.split(/[,\s]+/).every((key) => /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(key));
  const customValid = !!cName.trim() && keysValid && (cTransport === "stdio" ? !!cCommand.trim() : endpointValid);
  const customOpenCrabUrl = cTransport !== "stdio" && isOpenCrabCredentialUrl(cUrl);
  useEffect(() => {
    if (window.location.hash === "#custom") setTab("private");
  }, []);

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
      setCName("");
      setCArgs("");
      setCUrl("");
      setCEnv("");
      await refresh();
      setSelectedServerId(server.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "custom_install_failed");
    } finally {
      customInFlight.current = false;
      setCBusy(false);
    }
  }

  // URL을 붙여넣으면 원격 트랜스포트를 자동 감지하고 이름을 유추한다.
  // (경로/쿼리에 sse가 있으면 레거시 SSE, 아니면 현대 표준 Streamable HTTP)
  function onUrlChange(v: string) {
    setCUrl(v);
    const trimmed = v.trim();
    if (!/^https?:\/\//i.test(trimmed)) return;
    try {
      const u = new URL(trimmed);
      const isSse = /(^|[/?&#])sse($|[/?&#])/i.test(u.pathname + u.search);
      setCTransport(isSse ? "sse" : "http");
      if (!cName.trim()) {
        // TLD가 포함된 완전한 호스트일 때만 이름 유추 — 한 글자씩 타이핑하는 도중
        // "https://o" 같은 미완성 호스트("o")로 이름이 조기 확정되는 걸 막는다.
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

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) { setLoadFailed(true); setLoaded(true); return; }
    /*
     * ★못 읽었는데 화면은 "아직 연결한 도구가 없습니다" 를 그렸다 (읽기 실패 실측
     *   2026-09-08). 도구를 연결해 둔 사람에게는 거짓말이고, 다시 연결하러 가게 만든다.
     *   실패는 사실이 아니다 — 읽지 못했다는 것을 말한다.
     */
    let loadedRows;
    try {
      loadedRows = await Promise.all([
        api.mcpTools.listInstalled(),
        api.mcpTools.status(),
      ]);
    } catch {
      setLoadFailed(true);
      setLoaded(true);
      return;
    }
    const [i, s] = loadedRows;
    setLoadFailed(false);
    setInstalled(i);
    setStatuses(Object.fromEntries(s.map((status) => [status.id, status])));
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);



  async function remove(server: InstalledMcpServer) {
    const api = ipc();
    if (!api) return;
    const name = locale === "en" ? server.nameEn || server.name : server.name;
    if (!await confirmPopup(t("mcps.confirm_remove", { name }), { locale, tone: "danger", confirmLabel: locale === "ko" ? "제거" : "Remove" })) return;
    await api.mcpTools.remove(server.id);
    setStatuses((s) => {
      const next = { ...s };
      delete next[server.id];
      return next;
    });
    await refresh();
  }

  async function toggle(server: InstalledMcpServer) {
    const api = ipc();
    if (!api) return;
    await api.mcpTools.setEnabled(server.id, !server.enabled);
    await refresh();
  }

  const connectServer = useCallback<ServiceConnectRun>(async (signal, update) => {
    const api = ipc();
    if (!api || !connecting) throw new Error(ko ? "연결을 사용할 수 없어요. (bridge_unavailable)" : "Connection is unavailable. (bridge_unavailable)");
    const assertActive = () => { if (signal.aborted) throw new Error("cancelled"); };
    update({ step: "setup", note: ko ? "저장된 연결 설정을 확인하고 있어요." : "Checking the saved configuration." });
    if (!connecting.enabled) { assertActive(); await api.mcpTools.setEnabled(connecting.id, true); assertActive(); }
    const probe = async () => {
      assertActive();
      const result = await api.mcpTools.test(connecting.id);
      assertActive();
      setStatuses((previous) => ({ ...previous, [connecting.id]: result }));
      return result;
    };
    let status = await probe();
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
        status = await probe();
      }
    }
    if (status.missingEnv.length || !status.connected) throw new Error(mcpConnectionFailureMessage(status, ko));
    if (!status.tools.length) throw new Error(ko ? "서버 응답은 있지만 사용 가능한 도구가 없어요. (empty_tools)" : "The server responded but supplied no tools. (empty_tools)");
    return { evidence: [`tools/list · ${status.tools.length} ${ko ? "개 도구" : "tools"}`, status.tools.slice(0, 3).map((tool) => tool.name).join(", "), new Date(status.checkedAt).toLocaleTimeString()] };
  }, [connecting, ko, hub.listings]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return hub.listings.filter((listing) => !needle || [listing.name, listing.nameEn, listing.slug, listing.tagline, listing.taglineEn, listing.category, listing.developer].filter(Boolean).join(" ").toLowerCase().includes(needle));
  }, [hub.listings, query]);
  const featured = matches.filter((listing) => listing.featured);
  const groups = groupByCategory(matches.filter((listing) => !listing.featured), ko);
  const catalogGroups = featured.length ? [[ko ? "추천 플러그인" : "Featured plugins", featured] as (typeof groups)[number], ...groups] : groups;
  const selectedServer = installed.find((server) => server.id === selectedServerId);
  const serverForListing = (slug: string, name: string) => {
    const candidates = pluginSlugCandidates({ slug, name });
    return installed.find((server) => pluginSlugCandidates({ catalogId: server.catalogId, name: server.name }).some((candidate) => candidates.includes(candidate)));
  };
  const openPicker = (slugs: string[] = []) => { setPickerSlugs(slugs); setPickerOpen(true); setAddOpen(false); };
  const refreshAll = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await Promise.all([refresh(), hub.refresh()]); } finally { setRefreshing(false); }
  };
  const displayName = (server: InstalledMcpServer) => ko ? server.name : server.nameEn || server.name;
  const serverReady = (server: InstalledMcpServer) => {
    const status = statuses[server.id];
    return !loadFailed && server.enabled && !!status?.connected && !!status.tools.length && status.missingEnv.length === 0;
  };
  const connectionBadge = (server: InstalledMcpServer) => {
    if (loadFailed) return ko ? "상태 확인 불가" : "State unverified";
    const status = statuses[server.id];
    if (!server.enabled) return ko ? "꺼짐" : "Off";
    if (status?.failureCode === "configuration_missing" && status.missingEnv.length) return ko ? "연결 설정 확인" : "Review connection settings";
    if (status?.connected && status.tools.length > 0) return ko ? "연결됨" : "Connected";
    return ko ? "연결 확인 필요" : "Unverified";
  };

  return (
    <section className={styles.workspace}>
      <aside className={styles.sidebar} aria-label={ko ? "플러그인 관리" : "Plugin management"}>
        <h2 className={styles.sidebarTitle}>{ko ? "도구 설정" : "Tool settings"}</h2>
        <button type="button" className={styles.navItem} data-active={!selectedServerId && tab === "public"} onClick={() => { setSelectedServerId(null); setTab("public"); }}><IconWand size={15} />{ko ? "플러그인" : "Plugins"}</button>
        <Link href="/library/env" className={styles.navItem}><IconLock size={15} />{ko ? "API 키" : "API keys"}</Link>
        <p className={styles.sidebarLabel}>{ko ? "설치됨" : "Installed"}</p>
        {!loaded ? <p className={styles.sidebarHint}>{ko ? "불러오는 중…" : "Loading…"}</p> : loadFailed ? <p className={styles.sidebarHint}>{ko ? "설치 상태를 읽지 못했어요" : "Could not read installed state"}</p> : installed.length === 0 ? <p className={styles.sidebarHint}>{ko ? "아직 설치된 MCP가 없어요" : "No MCP servers installed yet"}</p> : installed.map((server) => <button key={server.id} type="button" data-connection-id={server.id} className={styles.installedItem} data-active={selectedServerId === server.id} onClick={() => setSelectedServerId(server.id)} title={`${displayName(server)} · ${connectionBadge(server)}`} aria-label={`${displayName(server)} · ${connectionBadge(server)}`}><PluginLogo catalogId={server.catalogId} name={server.name} size={20} brandMap={brandMap} /><span>{displayName(server)}</span><span className={styles.statusDot} data-ready={serverReady(server)} aria-label={connectionBadge(server)} /></button>)}
        <p className={styles.sidebarFoot}>{ko ? "설치한 도구는 모든 에이전트가 함께 사용해요." : "Every agent shares your installed tools."}</p>
      </aside>
      <div className={styles.main}>
        <header className={styles.header}>
          <div><h1 className={styles.title}>{ko ? "플러그인" : "Plugins"}</h1><p className={styles.subtitle}>{ko ? "자주 쓰는 앱과 도구를 연결하고, Agentlas의 작업 범위를 넓히세요." : "Connect your everyday apps and tools to work with Agentlas."}</p></div>
          <div className={styles.toolbar}>
            <label className={styles.search}><IconSearch size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); setSelectedServerId(null); setTab("public"); }} placeholder={ko ? "플러그인 검색" : "Search plugins"} aria-label={ko ? "플러그인 검색" : "Search plugins"} /></label>
            <button type="button" className={styles.iconButton} disabled={refreshing} onClick={() => void refreshAll()} aria-label={ko ? "목록 새로고침" : "Refresh catalog"} title={ko ? "새로고침" : "Refresh"}><IconRefresh size={16} /></button>
            <button type="button" className={styles.iconButton} onClick={() => { setSelectedServerId(null); setTab("private"); }} aria-label={ko ? "커스텀 MCP 설정" : "Custom MCP settings"} title={ko ? "커스텀 MCP 설정" : "Custom MCP settings"}><IconSettings size={16} /></button>
            <div className={styles.addWrap}><button type="button" className={styles.addButton} onClick={() => setAddOpen((open) => !open)} aria-expanded={addOpen}>{ko ? "추가" : "Add"}<IconChevronDown size={13} /></button>{addOpen && <><button className={styles.menuDismiss} aria-label={ko ? "추가 메뉴 닫기" : "Close add menu"} onClick={() => setAddOpen(false)} /><div className={styles.addMenu}><button type="button" onClick={() => openPicker()}>{ko ? "플러그인 고르기" : "Choose plugins"}</button><button type="button" onClick={() => { setTab("private"); setSelectedServerId(null); setAddOpen(false); }}>{ko ? "커스텀 MCP 추가" : "Add custom MCP"}</button></div></>}</div>
          </div>
        </header>
        <div className={styles.tabs} role="tablist" aria-label={ko ? "플러그인 출처" : "Plugin source"}>{(["public", "private"] as Tab[]).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value && !selectedServerId} className={styles.tab} data-active={tab === value && !selectedServerId} onClick={() => { setTab(value); setSelectedServerId(null); }}>{value === "public" ? ko ? "공개" : "Public" : ko ? "개인용" : "Private"}</button>)}</div>
        {actionError && <p className={styles.notice} role="alert">{actionError}</p>}
        {addSkipped.length > 0 && <div className={styles.notice} role="status"><strong>{ko ? "일부 플러그인을 추가하지 못했어요" : "Some plugins could not be added"}</strong>{addSkipped.map((row) => <p key={row.slug}>{row.slug} — {row.reason}</p>)}<button type="button" onClick={() => setAddSkipped([])}>{ko ? "닫기" : "Dismiss"}</button></div>}
        {selectedServer ? <div className={styles.serverDetail}><h2>{displayName(selectedServer)}</h2><p className={styles.detailNote}>{ko ? "등록 상태와 실제 연결 상태를 확인하세요." : "Review configuration and verify the live connection."}</p>{selectedServer.transport === "stdio" && <LocalExecutionReview server={selectedServer} ko={ko} />}<ChipGrid label={ko ? "MCP 연결" : "MCP connection"}><ConnectChip icon={<PluginLogo catalogId={selectedServer.catalogId} name={selectedServer.name} size={28} brandMap={brandMap} />} name={displayName(selectedServer)} sub={selectedServer.transport === "http" ? "Streamable HTTP" : selectedServer.transport === "sse" ? "SSE" : ko ? "로컬 명령" : "Local command"} ready={serverReady(selectedServer)} badge={connectionBadge(selectedServer)} facts={loadFailed ? [] : serverReady(selectedServer) ? [`tools/list · ${statuses[selectedServer.id].tools.length}`, statuses[selectedServer.id].tools.slice(0, 3).map((tool) => tool.name).join(", ")] : statuses[selectedServer.id]?.missingEnv || []} action={{ label: selectedServer.transport === "stdio" && !selectedServer.enabled ? ko ? "실행 패키지 설치 후 연결" : "Install execution package and connect" : ko ? "연결 확인" : "Verify connection", onClick: () => setConnecting(selectedServer) }} secondaryActions={[{ label: selectedServer.enabled ? t("mcps.off") : selectedServer.transport === "stdio" ? ko ? "로컬 실행 허용" : "Allow local execution" : t("mcps.on"), onClick: () => void toggle(selectedServer).catch((error) => setActionError(String(error))) }, { label: t("mcps.remove"), onClick: () => void remove(selectedServer).then(() => setSelectedServerId(null)).catch((error) => setActionError(String(error))) }]} /></ChipGrid>{selectedServer.envKeys.length > 0 && <Link href="/library/env" className={styles.textLink}>{ko ? "저장된 키·연결 확인" : "Review saved keys and connections"}</Link>}</div> : tab === "public" ? <>
          {hub.loadError && <p className={styles.notice} role="status">{ko ? "실시간 목록을 갱신하지 못했어요. 앱에 포함된 카탈로그를 표시합니다." : "The live catalog could not be refreshed. Showing the bundled catalog."}</p>}
          {loadFailed && <p className={styles.notice} role="status">{ko ? "설치 상태를 읽지 못했어요. 새로고침으로 다시 확인해 주세요." : "Installed state could not be read. Refresh to check again."}</p>}
          <p className={styles.catalogNote}>{ko ? "전체 Hub 카탈로그 · 필요한 도구를 고르면 연결 설정을 안내해요." : "The full Hub catalog · choose a tool to review its setup."}</p>
          {catalogGroups.map(([category, rows]) => <section className={styles.group} key={category}><h2 className={styles.groupTitle}>{category}<span>{rows.length}</span></h2><div className={styles.grid}>{rows.map((listing) => {
            const server = serverForListing(listing.slug, listing.name);
            const already = !loadFailed && hub.installedKnown && (!!server || hub.isInstalled(listing));
            const name = !ko ? listing.nameEn || listing.name : listing.name;
            return <button key={listing.slug} type="button" className={styles.pluginRow} onClick={() => server ? setSelectedServerId(server.id) : openPicker([listing.slug])} aria-label={`${name} · ${already ? ko ? "설치 관리" : "Manage installation" : ko ? "추가 설정" : "Review setup"}`}><PluginLogo slug={listing.slug} name={name} size={36} brandColor={listing.brandColor} brandMap={brandMap} /><span className={styles.rowText}><strong>{name}</strong><span>{!ko ? listing.taglineEn || listing.tagline : listing.tagline}</span></span><span className={styles.rowAction} title={already ? ko ? "설치됨" : "Installed" : ko ? "추가 설정" : "Review setup"}>{already ? "···" : <IconPlus size={19} />}</span></button>;
          })}</div></section>)}
          {matches.length === 0 && <Empty text={query.trim() ? ko ? `“${query.trim()}”과 맞는 플러그인이 없어요.` : `No plugins match “${query.trim()}”.` : ko ? "카탈로그를 불러오는 중…" : "Loading the catalog…"} />}
        </> : <div className={styles.customSection}><h2>{ko ? "나만의 MCP 연결" : "Your custom MCP connection"}</h2><p className={styles.detailNote}>{ko ? "MCP를 지원하는 API 주소 또는 로컬 실행 명령을 등록하세요. 일반 REST API는 해당 서비스 커넥터가 필요합니다. 표시 이름으로 저장된 키를 자동 선택하지 않습니다." : "Add an MCP API endpoint or a local command. Ordinary REST APIs need their service connector. Display names do not automatically select stored keys."}</p>

        <div style={{ marginBottom: 12 }}>
          {(
            <div
              className="glass-strong"
              style={{ padding: 14, borderRadius: "var(--radius-md)", display: "flex", flexDirection: "column", gap: 8 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 13, flex: 1 }}>{t("mcps.custom.title")}</strong>
              </div>
              <input
                value={cName}
                onChange={(e) => setCName(e.target.value)}
                placeholder={t("mcps.custom.name")}
                aria-label={ko ? "연결 표시 이름" : "Connection display name"}
                style={{ ...customInput, width: "100%" }}
              />
              {/* 로컬(명령) / 원격(URL) 세그먼트 — 원격 URL 진입로를 명확히 노출 */}
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" onClick={() => setCTransport("stdio")} style={segBtn(cTransport === "stdio")}>
                  {t("mcps.custom.mode_local")}
                </button>
                <button
                  type="button"
                  onClick={() => setCTransport(cTransport === "stdio" ? "http" : cTransport)}
                  style={segBtn(cTransport !== "stdio")}
                >
                  {t("mcps.custom.mode_remote")}
                </button>
              </div>
              {cTransport === "stdio" ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input value={cCommand} onChange={(e) => setCCommand(e.target.value)} placeholder={t("mcps.custom.command")} style={{ ...customInput, flex: "0 0 100px", fontFamily: "var(--font-mono)" }} />
                  <input value={cArgs} onChange={(e) => setCArgs(e.target.value)} placeholder={t("mcps.custom.args")} style={{ ...customInput, flex: "1 1 200px", fontFamily: "var(--font-mono)" }} />
                </div>
              ) : (
                <>
                  <input
                    value={cUrl}
                    onChange={(e) => onUrlChange(e.target.value)}
                    placeholder={t("mcps.custom.url")}
                    aria-label={ko ? "MCP API 주소" : "MCP API endpoint"}
                    aria-invalid={!!cUrl.trim() && !endpointValid}
                    style={{ ...customInput, width: "100%", fontFamily: "var(--font-mono)" }}
                  />
                  {!!cUrl.trim() && !endpointValid && <p role="alert">{ko ? "인증정보가 포함되지 않은 HTTP(S) 주소를 입력하세요. 키는 Vault에 저장해 주세요." : "Enter an HTTP(S) endpoint without credentials. Store keys in Vault."}</p>}
                  {cUrl.trim() ? (
                    <div style={{ fontSize: 11, color: "var(--muted-deep)", display: "flex", alignItems: "center", gap: 6 }}>
                      <span>{t("mcps.custom.detected")}:</span>
                      <button type="button" onClick={() => setCTransport("http")} style={detBtn(cTransport === "http")}>HTTP</button>
                      <button type="button" onClick={() => setCTransport("sse")} style={detBtn(cTransport === "sse")}>SSE</button>
                    </div>
                  ) : null}
                  {customOpenCrabUrl && (
                    <div role="alert" style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--peach-ink)" }}>
                      {/* 카탈로그가 허브 화면으로 옮겨졌으므로 "아래 카드"가 아니라 그 화면을 가리킨다. */}
                      {locale === "en"
                        ? "Private OpenCrab URLs contain a credential. Connect OpenCrab from the Public tab so the URL stays in Keychain."
                        : "OpenCrab 개인 URL에는 인증정보가 들어 있습니다. URL이 키체인에만 남도록 공개 탭에서 OpenCrab을 찾아 연결하세요."}
                    </div>
                  )}
                </>
              )}
              <input
                value={cEnv}
                onChange={(e) => setCEnv(e.target.value)}
                placeholder={cTransport === "stdio" ? t("mcps.custom.env") : t("mcps.custom.header")}
                aria-label={ko ? "필수 키 또는 헤더 이름 (값 제외)" : "Required key or header names (no values)"}
                aria-invalid={!keysValid}
                style={{ ...customInput, width: "100%", fontFamily: "var(--font-mono)" }}
              />
              <p className={styles.detailNote}>{ko ? "여기에는 키·헤더 이름만 입력하세요. 값은 저장된 키 설정 또는 이 요청의 전용 Vault에서 관리합니다. 저장과 실제 연결 확인은 별도 단계입니다." : "Enter key or header names only. Manage values in saved key settings or this request's dedicated Vault. Saving and connection verification are separate."}</p>
              {!keysValid && <p role="alert">{ko ? "키 값을 붙여넣지 말고 키 또는 헤더 이름만 입력하세요." : "Enter only key or header names; do not paste values."}</p>}
              <button
                onClick={() => void addCustom()}
                disabled={!customValid || cBusy || customOpenCrabUrl}
                style={{
                  alignSelf: "flex-start",
                  padding: "7px 16px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 700,
                  border: "1px solid var(--paper-edge)",
                  boxShadow: cName.trim() && !cBusy && !customOpenCrabUrl ? "var(--neu-raised)" : "none",
                  background: cName.trim() && !cBusy && !customOpenCrabUrl ? "var(--paper)" : "var(--paper-2)",
                  color: cName.trim() && !cBusy && !customOpenCrabUrl ? "var(--ink)" : "var(--muted-deep)",
                }}
              >
                {cBusy ? t("mcps.testing") : t("mcps.custom.create")}
              </button>
            </div>
          )}
        </div>


        <p className={styles.securityNote}><IconLock size={13} />{t("env.security_note")}</p></div>}
      </div>
      {pickerOpen && <PluginPickerDialog ko={ko} initialSlugs={pickerSlugs} onCustomSetup={() => { setPickerOpen(false); setSelectedServerId(null); setTab("private"); }} onClose={() => { setPickerOpen(false); void refreshAll(); }} onCompleted={(result) => { setAddSkipped(result?.skipped ?? []); void refreshAll(); }} />}
      {connecting && <ServiceConnectPopup name={displayName(connecting)} icon={<PluginLogo catalogId={connecting.catalogId} name={connecting.name} size={28} brandMap={brandMap} />} ko={ko} run={connectServer} setupLink={connecting.envKeys.length ? { label: ko ? "저장된 키·연결 확인" : "Review saved keys and connections", href: "/library/env" } : undefined} onClose={() => { setConnecting(null); void refresh(); }} onDone={() => { setConnecting(null); void refresh(); }} />}
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

const customInput: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  fontSize: 12.5,
  outline: "none",
};

/** 로컬/원격 세그먼트 버튼 스타일 (active면 강조). */
function segBtn(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: "7px 12px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: "var(--radius-md)",
    border: active ? "1px solid var(--ink)" : "1px solid var(--paper-edge)",
    background: active ? "var(--paper)" : "var(--paper-2)",
    color: active ? "var(--ink)" : "var(--muted-deep)",
    boxShadow: active ? "var(--neu-raised)" : "none",
    cursor: "pointer",
  };
}

/** 감지된 트랜스포트(HTTP/SSE) 배지 버튼 — 클릭으로 수동 오버라이드. */
function detBtn(active: boolean): React.CSSProperties {
  return {
    padding: "2px 9px",
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 999,
    border: active ? "1px solid var(--ink)" : "1px solid var(--paper-edge)",
    background: active ? "var(--paper)" : "transparent",
    color: active ? "var(--ink)" : "var(--muted-deep)",
    cursor: "pointer",
  };
}

function Empty({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: 32,
        textAlign: "center",
        color: "var(--muted-deep)",
        border: "1px dashed var(--paper-edge)",
        borderRadius: "var(--radius-md)",
        fontSize: 13,
      }}
    >
      {text}
    </div>
  );
}
