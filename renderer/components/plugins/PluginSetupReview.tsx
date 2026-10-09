"use client";

import { BUNDLED_HUB_CATALOG_REVISION, getBundledHubManifest } from "../../../shared/bundled-hub-catalog";
import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { InstalledMcpServer, MarketplaceListing } from "@/lib/types";
import styles from "./PluginSetupReview.module.css";

type ServerDefinition = { name?: string; transport?: string; command?: string; args?: string[]; url?: string; envKeys?: string[]; env?: Record<string, unknown> };
type SetupManifest = { mcp?: ServerDefinition[]; auth?: { kind?: string }; docs?: string; connectSetup?: { note?: string; noteKo?: string }; skills?: unknown[] };

export function bundledSetupFor(slug: string): SetupManifest | null {
  return getBundledHubManifest(slug) as SetupManifest | null;
}

export function executionCommand(command: string | null | undefined, args: string[] = []): string {
  return [command || "", ...args].map((part) => /\s|["'\\]/.test(part) ? JSON.stringify(part) : part).join(" ");
}

export function runtimePrerequisite(command: string | null | undefined, ko: boolean): string {
  const executable = (command || "").split(/[\\/]/).pop()?.toLowerCase();
  if (executable === "npx") return ko ? "Node.js 런타임과 npm이 필요합니다. npx가 첫 연결 때 지정된 실행 패키지를 준비합니다." : "Node.js and npm are required. npx prepares the specified package on first connection.";
  if (executable === "npm" || executable === "node") return ko ? "Node.js 런타임과 지정된 로컬 스크립트·패키지가 필요합니다." : "Node.js and the specified local script or package are required.";
  if (executable === "uvx") return ko ? "Python·uv 런타임이 필요합니다. uvx가 첫 연결 때 패키지 실행 환경을 준비합니다." : "Python and uv are required. uvx prepares the package environment on first connection.";
  if (executable === "uv" || executable?.startsWith("python")) return ko ? "설정된 Python 실행 환경과 필요한 패키지가 있어야 합니다. 이 명령의 의존성을 먼저 확인하세요." : "The configured Python environment and packages must be available. Review this command's dependencies first.";
  if (executable === "docker") return ko ? "Docker가 필요합니다. 첫 연결 때 지정한 컨테이너 이미지를 준비합니다." : "Docker is required. The specified image is prepared on first connection.";
  return ko ? "이 명령과 필요한 실행 환경을 확인하세요. 연결 버튼을 누르면 로컬에서 실행합니다." : "Review this command and its runtime. Connecting executes it locally.";
}

export function LocalExecutionReview({ server, ko }: { server: InstalledMcpServer; ko: boolean }) {
  return <section className={styles.review} aria-label={ko ? "로컬 실행 검토" : "Review local execution"}>
    <h3>{ko ? "실행할 로컬 패키지" : "Local execution package"}</h3>
    <code>{executionCommand(server.command, server.args)}</code>
    <p>{runtimePrerequisite(server.command, ko)}</p>
    {server.envKeys.length > 0 && <p>{ko ? "필수 키 이름" : "Required key names"}: <code>{server.envKeys.join(", ")}</code></p>}
    {!server.enabled && <p>{ko ? "아래 버튼을 누르면 이 명령의 실행을 허용하고 연결을 확인합니다." : "The button below authorizes this command and checks the connection."}</p>}
  </section>;
}

export function usesLiveSetup(listing: MarketplaceListing): boolean {
  const revision = (listing as MarketplaceListing & { catalogRevision?: string }).catalogRevision;
  return !bundledSetupFor(listing.slug) || (!!revision && Date.parse(revision) > Date.parse(BUNDLED_HUB_CATALOG_REVISION));
}

export function PluginSetupReview({ listing, ko }: { listing: MarketplaceListing; ko: boolean }) {
  const needsLive = usesLiveSetup(listing);
  const [live, setLive] = useState<{ url: string; manifest: SetupManifest | null; error?: string } | null>(null);
  useEffect(() => {
    if (!needsLive) return;
    let active = true;
    const api = ipc();
    if (!api) { setLive({ url: listing.manifestUrl, manifest: null, error: "bridge_unavailable" }); return; }
    void api.mcpTools.previewHubPlugin(listing.manifestUrl).then((preview) => {
      if (active) setLive({ url: listing.manifestUrl, manifest: { mcp: preview.rows, auth: { kind: listing.authKind }, docs: listing.homepage } });
    }).catch((error) => {
      if (active) setLive({ url: listing.manifestUrl, manifest: null, error: error instanceof Error ? error.message : "manifest_read_failed" });
    });
    return () => { active = false; };
  }, [needsLive, listing.manifestUrl, listing.authKind, listing.homepage]);
  const currentLive = live?.url === listing.manifestUrl ? live : null;
  const manifest = needsLive ? currentLive?.manifest : bundledSetupFor(listing.slug);
  if (!manifest) return <section className={styles.review} role="status"><h3>{listing.name}</h3><p>{currentLive?.error ? ko ? `최신 연결 설정을 확인하지 못했어요: ${currentLive.error}` : `Latest setup could not be verified: ${currentLive.error}` : ko ? "최신 매니페스트의 실행 명령과 연결 주소를 읽고 있어요…" : "Reading the latest manifest's command and connection endpoint…"}</p></section>;
  const rows = manifest.mcp || [];
  const guide = manifest.connectSetup;
  const note = ko ? guide?.noteKo || guide?.note : guide?.note;
  const envKeys = [...new Set(rows.flatMap((row) => row.envKeys || Object.keys(row.env || {})))];
  const auth = manifest.auth?.kind;
  return <section className={styles.review} aria-label={`${listing.name} ${ko ? "연결 설정 검토" : "setup review"}`}>
    <h3>{listing.name} · {guide ? ko ? "제공사 설정 필요" : "Provider setup required" : ko ? "연결 전 확인" : "Review before adding"}</h3>
    {note && <p className={styles.guide}>{note}</p>}
    {rows.map((row, index) => <div key={`${row.name || index}`} className={styles.server}>
      {row.transport === "stdio" ? <><code>{executionCommand(row.command, row.args)}</code><p>{runtimePrerequisite(row.command, ko)}</p><p>{ko ? "추가하면 비활성으로 등록됩니다. 설치된 도구에서 명령을 검토하고 처음 연결할 때 실행을 허용하세요." : "Adding saves a disabled configuration. Review the command in Installed tools and authorize execution on first connection."}</p></> : <><span>Streamable HTTP{row.transport === "sse" ? " / SSE" : ""}</span><code>{row.url || row.name}</code></>}
    </div>)}
    {auth && auth !== "none" && <p>{ko ? "인증" : "Authentication"}: {auth === "oauth" ? ko ? "제공사 OAuth 로그인·동의" : "Provider OAuth sign-in and consent" : ko ? "API 키 또는 토큰" : "API key or token"}</p>}
    {envKeys.length > 0 && <p>{ko ? "필수 키 이름" : "Required key names"}: <code>{envKeys.join(", ")}</code></p>}
    {rows.length === 0 && !guide && manifest.skills?.length ? <p>{ko ? "스킬 콘텐츠를 설치합니다. 별도 MCP 서버 연결은 없습니다." : "Installs skill content. No separate MCP server connection."}</p> : null}
    {manifest.docs && /^https?:\/\//.test(manifest.docs) && <a href={manifest.docs} target="_blank" rel="noopener noreferrer">{ko ? "제공사 공식 설정 안내" : "Official provider setup guide"} ↗</a>}
  </section>;
}
