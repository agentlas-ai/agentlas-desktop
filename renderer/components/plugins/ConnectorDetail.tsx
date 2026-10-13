"use client";

// Connector (MCP server) detail — tools it exposes and the connection/auth card.
// Every state shown here comes from the typed status probe or the OAuth status
// read; login and keys run the existing flows owned by the page.
import Link from "next/link";
import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { IconSettings, IconUser } from "@/components/Icon";
import { ToolLogo } from "./ToolLogo";
import type { InstalledMcpServer, McpServerStatus, McpToolCatalogEntry, PluginBrandAsset } from "@/lib/types";
import { executionCommand, runtimePrerequisite } from "./PluginSetupReview";
import { Breadcrumb, CollapsedRows, DetailHeader, GlyphTool, InfoRows, MoreMenu, PromptCard, Section } from "./DetailParts";
import { connectionLabel, connectionState, hostOf, oneLine, transportLabel, type ConnectionState } from "./toolsModel";
import styles from "./ToolsUi.module.css";

type OAuthRead = { supported: boolean; connected: boolean } | null;

export function ConnectorDetail({
  ko, brandMap, trail, server, entry, ownerName, brandColor, status, loadFailed, busy,
  onVerify, onEnterKeys, onToggle, onRemove, onInstall, onLogout,
}: {
  ko: boolean;
  brandMap: Record<string, PluginBrandAsset>;
  trail: Array<{ label: string; onClick?: () => void }>;
  /** Installed row. Absent for a catalog entry that is not installed yet. */
  server?: InstalledMcpServer;
  entry?: McpToolCatalogEntry;
  /** Display name of the plugin that installed this connector. */
  ownerName?: string;
  brandColor?: string;
  status?: McpServerStatus;
  loadFailed: boolean;
  busy?: boolean;
  onVerify: (server: InstalledMcpServer, mode?: "login" | "connect") => void;
  onEnterKeys: (server: InstalledMcpServer, keys: string[]) => void;
  onToggle: (server: InstalledMcpServer) => void;
  onRemove: (server: InstalledMcpServer) => void;
  onInstall: (entry: McpToolCatalogEntry) => void;
  onLogout: (server: InstalledMcpServer) => Promise<void>;
}) {
  const name = server ? (ko ? server.name : server.nameEn || server.name) : entry ? (ko ? entry.name : entry.nameEn || entry.name) : "";
  const shortName = trail[trail.length - 1]?.label || name;
  const description = entry ? (ko ? entry.description : entry.descriptionEn || entry.description) : "";
  const transport = server?.transport ?? entry?.transport ?? "stdio";
  const state: ConnectionState | null = server ? connectionState(server, status, loadFailed) : null;
  const tools = server && status && !loadFailed ? status.tools : [];
  const [highlight, setHighlight] = useState<string | null>(null);
  const [oauth, setOauth] = useState<OAuthRead>(null);
  const remote = transport === "http" || transport === "sse";
  const serverId = server?.id;
  const checkedAt = status?.checkedAt;

  useEffect(() => {
    if (!serverId || !remote) { setOauth(null); return; }
    let active = true;
    const api = ipc();
    if (!api) return;
    // Reads the stored credential state only; never starts a consent window.
    void api.mcpTools.oauthStatus(serverId).then((value) => { if (active) setOauth({ supported: value.supported, connected: value.connected }); }).catch(() => { if (active) setOauth(null); });
    return () => { active = false; };
  }, [serverId, remote, checkedAt]);

  const logoProps = { catalogId: server?.catalogId ?? entry?.id ?? null, name: server?.name ?? entry?.nameEn ?? name, brandMap, brandColor: entry?.brandColor ?? brandColor };
  const icon = <ToolLogo {...logoProps} frame="detail" />;
  const smallIcon = <ToolLogo {...logoProps} frame="row" size={30} />;
  const chipIcon = <ToolLogo {...logoProps} frame="bare" size={13} />;

  const goTool = (toolName: string) => {
    setHighlight(toolName);
    document.getElementById(`row-tool-${toolName}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const chips = tools.filter((tool) => tool.description?.trim()).slice(0, 3).map((tool) => ({
    key: tool.name, text: oneLine(tool.description, 150), onGo: () => goTool(tool.name), goLabel: tool.name,
  }));

  const actionFor = (current: ConnectionState): { label: string; run: () => void } | null => {
    if (!server) return null;
    if (current === "keys") return { label: ko ? "키 입력" : "Enter key", run: () => onEnterKeys(server, status?.missingEnv ?? []) };
    if (current === "login") return { label: ko ? "로그인" : "Sign in", run: () => onVerify(server, "login") };
    if (current === "ready") return { label: ko ? "다시 확인" : "Recheck", run: () => onVerify(server) };
    if (current === "off" && transport === "stdio") return { label: ko ? "허용하고 연결" : "Allow and connect", run: () => onVerify(server) };
    return { label: ko ? "연결" : "Connect", run: () => onVerify(server) };
  };
  const action = state ? actionFor(state) : null;
  const tone = state === "ready" ? "ready" : state === "keys" || state === "login" ? "warn" : undefined;

  const headerActions = server ? <>
    <MoreMenu label={ko ? "더 보기" : "More"} items={[
      { label: server.enabled ? ko ? "끄기" : "Turn off" : ko ? "켜기" : "Turn on", onClick: () => onToggle(server) },
      { label: ko ? "제거" : "Remove", onClick: () => onRemove(server), danger: true },
    ]} />
    <Link href="/library/env" className={styles.lightButton}><IconSettings size={14} />{ko ? "관리" : "Manage"}</Link>
    <button type="button" className={styles.darkButton} onClick={() => onVerify(server)}>{ko ? "연결 확인" : "Verify"}</button>
  </> : entry ? <button type="button" className={styles.darkButton} disabled={busy} onClick={() => onInstall(entry)}>{busy ? ko ? "추가하는 중…" : "Adding…" : ko ? "추가" : "Add"}</button> : null;

  const command = server ? (server.transport === "stdio" ? executionCommand(server.command, server.args) : server.url) : entry ? (entry.transport === "stdio" ? executionCommand(entry.command, entry.args) : entry.url) : null;
  const requiredKeys = server ? server.envKeys : entry?.envRequirements.map((requirement) => requirement.key) ?? [];

  return <div>
    <Breadcrumb trail={trail} />
    <div className={styles.detailColumn}>
      <DetailHeader icon={icon} name={shortName} tagline={oneLine(description, 160) || undefined} actions={headerActions} />
      <PromptCard brand={shortName} brandColor={brandColor ?? entry?.brandColor} brandIcon={chipIcon} chips={chips} />

      {tools.length > 0 && <Section title={ko ? "도구" : "Tools"} count={tools.length}>
        <CollapsedRows ko={ko} rows={tools.map((tool) => ({
          key: `tool-${tool.name}`, icon: <GlyphTool />, name: tool.name, sub: oneLine(tool.description), highlight: highlight === tool.name,
        }))} />
      </Section>}

      <Section title={ko ? "연결" : "Connection"}>
        <div className={styles.card}>
          <div className={styles.cardRow}>
            {smallIcon}
            <span className={styles.cardText}>
              <span className={styles.cardTitle}>{shortName}</span>
              <span className={styles.cardSub} data-tone={tone}>{state ? `${connectionLabel(state, ko)} · ${transportLabel(transport, ko)}` : transportLabel(transport, ko)}{state === "ready" && tools.length ? ` · ${ko ? `도구 ${tools.length}개` : `${tools.length} tools`}` : ""}</span>
            </span>
            {action && <button type="button" className={styles.smallButton} onClick={action.run}>{action.label}</button>}
          </div>
          {command && <div className={styles.cardRow}>
            <span className={styles.cardText}>
              <code className={styles.mono}>{command}</code>
              {transport === "stdio" && (!server || !server.enabled) && <span className={styles.cardSub}>{runtimePrerequisite(server?.command ?? entry?.command, ko)}</span>}
            </span>
          </div>}
          {requiredKeys.length > 0 && <div className={styles.cardRow}>
            <span className={styles.cardText}>
              <span className={styles.cardTitle}>{ko ? "키" : "Keys"}</span>
              <code className={styles.mono}>{requiredKeys.join(", ")}</code>
            </span>
            {server && (status?.missingEnv.length ?? 0) > 0
              ? <button type="button" className={styles.smallButton} onClick={() => onEnterKeys(server, status?.missingEnv ?? [])}>{ko ? "키 입력" : "Enter key"}</button>
              : entry?.setupUrl && !server ? <a className={styles.smallButton} href={entry.setupUrl} target="_blank" rel="noopener noreferrer">{ko ? "키 발급" : "Get key"} ↗</a> : null}
          </div>}
          {server && oauth?.supported && <div className={styles.cardRow}>
            <span className={styles.addCircle}><IconUser size={15} /></span>
            <span className={styles.cardText}><span className={styles.cardTitle}>{oauth.connected ? ko ? "로그인됨" : "Signed in" : ko ? "로그인 안 됨" : "Not signed in"}</span></span>
            {oauth.connected
              ? <MoreMenu label={ko ? "계정 메뉴" : "Account menu"} items={[{ label: ko ? "로그아웃" : "Sign out", danger: true, onClick: () => { void onLogout(server).then(() => setOauth({ supported: true, connected: false })); } }]} />
              : <button type="button" className={styles.smallButton} onClick={() => onVerify(server, "login")}>{ko ? "로그인" : "Sign in"}</button>}
          </div>}
        </div>
        {server && status?.error && state !== "ready" && !loadFailed && <p className={styles.notice} role="status">{oneLine(status.error, 240)}</p>}
      </Section>

      <Section title={ko ? "정보" : "Information"}>
        <InfoRows rows={[
          [ko ? "전송 방식" : "Transport", transportLabel(transport, ko)],
          [ko ? "출처" : "Source", ownerName ? `${ko ? "플러그인" : "Plugin"} · ${ownerName}` : server ? server.catalogId ? ko ? "커넥터 카탈로그" : "Connector catalog" : ko ? "직접 추가" : "Added manually" : ko ? "커넥터 카탈로그" : "Connector catalog"],
          [ko ? "설치일" : "Installed", server ? new Date(server.installedAt).toLocaleDateString(ko ? "ko-KR" : "en-US") : ""],
          [ko ? "문서" : "Docs", entry?.docsUrl && hostOf(entry.docsUrl) ? <a href={entry.docsUrl} target="_blank" rel="noopener noreferrer">{hostOf(entry.docsUrl)} ↗</a> : ""],
        ]} />
      </Section>
    </div>
  </div>;
}
