"use client";

// Plugin (Hub package) detail — the package and what it bundles: 커넥터 N and
// 스킬 N, like the ChatGPT plugin page (앱 N / 스킬 N).
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { IconSettings } from "@/components/Icon";
import { ToolLogo } from "./ToolLogo";
import { startChatWithPrompt } from "@/components/PromptPickerDialog";
import type { InstalledMcpServer, MarketplaceListing, McpServerStatus, PluginBrandAsset } from "@/lib/types";
import { categoryLabel } from "./PluginPickerCore";
import { bundledSetupFor, executionCommand, usesLiveSetup } from "./PluginSetupReview";
import { Breadcrumb, CollapsedRows, DetailHeader, GlyphSkill, InfoRows, MoreMenu, PromptCard, Section } from "./DetailParts";
import {
  bundledPluginFacts, hostOf, connectionLabel, connectionState, factsFromPreview, listingName, listingTagline, oneLine, transportLabel,
  type ManifestConnector, type SkillRef,
} from "./toolsModel";
import styles from "./ToolsUi.module.css";

export function PluginDetail({
  ko, brandMap, trail, listing, connectors, statuses, loadFailed, skillsInstalled, installing,
  onAdd, onCustomSetup, onOpenConnector, onOpenSkill, onRemove, onVerify,
}: {
  ko: boolean;
  brandMap: Record<string, PluginBrandAsset>;
  trail: Array<{ label: string; onClick?: () => void }>;
  listing: MarketplaceListing;
  /** Registry rows this plugin installed. */
  connectors: InstalledMcpServer[];
  statuses: Record<string, McpServerStatus>;
  loadFailed: boolean;
  skillsInstalled: boolean;
  installing: boolean;
  onAdd: () => void;
  onCustomSetup: () => void;
  onOpenConnector: (server: InstalledMcpServer) => void;
  onOpenSkill: (skill: SkillRef) => void;
  onRemove: () => void;
  onVerify: (server: InstalledMcpServer) => void;
}) {
  const name = listingName(listing, ko);
  const bundled = useMemo(() => bundledPluginFacts(listing.slug, ko), [listing.slug, ko]);
  const live = usesLiveSetup(listing);
  const [preview, setPreview] = useState<{ slug: string; connectors: ManifestConnector[]; skills: SkillRef[] } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    if ((!live && bundled) || !listing.manifestUrl) return;
    let active = true;
    const api = ipc();
    if (!api) return;
    setPreviewError(null);
    void api.mcpTools.previewHubPlugin(listing.manifestUrl).then((value) => {
      if (active) setPreview({ slug: listing.slug, ...factsFromPreview(listing.slug, value as unknown as { rows?: unknown; skills?: unknown }) });
    }).catch((error) => { if (active) setPreviewError(error instanceof Error ? error.message : "manifest_read_failed"); });
    return () => { active = false; };
  }, [live, bundled, listing.slug, listing.manifestUrl]);

  const current = preview?.slug === listing.slug ? preview : null;
  const manifestConnectors = current?.connectors ?? bundled?.connectors ?? [];
  const skills = current?.skills.length ? current.skills.map((skill) => ({ ...skill, files: bundled?.skills.find((row) => row.name === skill.name)?.files ?? [] })) : bundled?.skills ?? [];
  const installed = connectors.length > 0 || skillsInstalled;
  const guide = bundledSetupFor(listing.slug)?.connectSetup;
  const guideNote = ko ? guide?.noteKo || guide?.note : guide?.note;
  const guidedOnly = !!guide && manifestConnectors.length === 0 && skills.length === 0;

  const rowFor = (row: ManifestConnector) => connectors.find((server) => server.name === `${listing.slug}:${row.name}`);
  const extra = connectors.filter((server) => !manifestConnectors.some((row) => rowFor(row)?.id === server.id));
  const connectorRows = [
    ...manifestConnectors.map((row) => {
      const server = rowFor(row);
      const state = server ? connectionState(server, statuses[server.id], loadFailed) : null;
      return {
        key: `connector-${row.name}`, icon: <ToolLogo slug={listing.slug} name={listing.nameEn || listing.name} frame="bare" size={20} brandColor={listing.brandColor} brandMap={brandMap} />, name: row.name,
        sub: `${transportLabel(row.transport, ko)} · ${row.transport === "stdio" ? executionCommand(row.command, row.args) : row.url ?? ""}`,
        meta: state ? connectionLabel(state, ko) : undefined,
        onClick: server ? () => onOpenConnector(server) : undefined,
      };
    }),
    ...extra.map((server) => {
      const state = connectionState(server, statuses[server.id], loadFailed);
      return { key: `connector-${server.id}`, icon: <ToolLogo slug={listing.slug} catalogId={server.catalogId} name={server.name} frame="bare" size={20} brandColor={listing.brandColor} brandMap={brandMap} />, name: server.name.slice(listing.slug.length + 1) || server.name, sub: transportLabel(server.transport, ko), meta: connectionLabel(state, ko), onClick: () => onOpenConnector(server) };
    }),
  ];

  const tryPrompt = async (text: string) => {
    setStartError(null);
    const result = await startChatWithPrompt(text, { promptSlug: `plugin-${listing.slug}`, seedOnly: true });
    if (!result.ok) setStartError(`${ko ? "새 대화를 열지 못했어요" : "Could not open a new chat"} (${result.code})`);
  };
  const toolChips = connectors.flatMap((server) => (statuses[server.id]?.tools ?? []).filter((tool) => tool.description?.trim()).map((tool) => ({ server, tool })));
  const chips = bundled?.defaultPrompts.length
    ? bundled.defaultPrompts.slice(0, 3).map((text, index) => ({ key: `prompt-${index}`, text, onGo: () => void tryPrompt(text), goLabel: ko ? "대화에서 써 보기" : "Try in chat" }))
    : toolChips.slice(0, 3).map(({ server, tool }) => ({ key: `${server.id}-${tool.name}`, text: oneLine(tool.description, 150), onGo: () => onOpenConnector(server), goLabel: tool.name }));

  const firstUnready = connectors.find((server) => connectionState(server, statuses[server.id], loadFailed) !== "ready");
  const headerActions = installed ? <>
    {connectors.length > 0 && <MoreMenu label={ko ? "더 보기" : "More"} items={[{ label: ko ? "제거" : "Remove", danger: true, onClick: onRemove }]} />}
    <Link href="/library/env" className={styles.lightButton}><IconSettings size={14} />{ko ? "관리" : "Manage"}</Link>
    {connectors.length > 0 && <button type="button" className={styles.darkButton} onClick={() => onVerify(firstUnready ?? connectors[0])}>{firstUnready ? ko ? "연결" : "Connect" : ko ? "연결 확인" : "Verify"}</button>}
  </> : guidedOnly
    ? <button type="button" className={styles.darkButton} onClick={onCustomSetup}>{ko ? "직접 연결" : "Connect manually"}</button>
    : <button type="button" className={styles.darkButton} disabled={installing} onClick={onAdd}>{installing ? ko ? "추가하는 중…" : "Adding…" : ko ? "추가" : "Add"}</button>;

  return <div>
    <Breadcrumb trail={trail} />
    <div className={styles.detailColumn}>
      <DetailHeader icon={<ToolLogo slug={listing.slug} name={listing.nameEn || listing.name} frame="detail" brandColor={listing.brandColor} brandMap={brandMap} />} name={name} tagline={listingTagline(listing, ko)} actions={headerActions} />
      <PromptCard brand={name} brandColor={listing.brandColor} brandIcon={<ToolLogo slug={listing.slug} name={listing.nameEn || listing.name} frame="bare" size={13} brandColor={listing.brandColor} brandMap={brandMap} />} chips={chips} />
      {startError && <p className={styles.notice} role="alert">{startError}</p>}
      {bundled?.description && bundled.description.trim() !== listingTagline(listing, ko).trim() && <p className={styles.description}>{bundled.description}</p>}
      {guideNote && <p className={styles.notice}>{guideNote}</p>}
      {previewError && <p className={styles.notice} role="status">{ko ? "최신 구성을 읽지 못했어요" : "Latest contents unavailable"} ({previewError})</p>}

      {connectorRows.length > 0 && <Section title={ko ? "커넥터" : "Connectors"} count={connectorRows.length}>
        <CollapsedRows ko={ko} rows={connectorRows} />
      </Section>}

      {skills.length > 0 && <Section title={ko ? "스킬" : "Skills"} count={skills.length}>
        <CollapsedRows ko={ko} rows={skills.map((skill) => ({ key: `skill-${skill.name}`, icon: <GlyphSkill />, name: skill.name, sub: oneLine(skill.description), onClick: () => onOpenSkill(skill) }))} />
      </Section>}

      <Section title={ko ? "정보" : "Information"}>
        <InfoRows rows={[
          [ko ? "기능" : "Capabilities", bundled?.capabilities.join(", ") ?? ""],
          [ko ? "개발자" : "Developer", listing.developer || listing.ownerName || ""],
          [ko ? "카테고리" : "Category", listing.category ? categoryLabel(listing.category, ko) : ""],
          [ko ? "웹사이트" : "Website", listing.homepage && hostOf(listing.homepage) ? <a href={listing.homepage} target="_blank" rel="noopener noreferrer">{hostOf(listing.homepage)} ↗</a> : ""],
        ]} />
      </Section>
    </div>
  </div>;
}
