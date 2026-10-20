import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { useCallback, useMemo, useState } from "react";
import type { ToolchainsApi } from "@shared/toolchain";
import { IconToolchain } from "@/components/Icon";
import { navigate } from "@/lib/navigation";
import { toolchainCopy, toolchainErrorText } from "@/components/toolchains/toolchain-copy";
import styles from "./OneToolchains.module.css";

/** Wrap Toolchains + Computer History so they stack as one rail. */
export const toolchainStackClassName = styles.stack;

type Asset = Awaited<ReturnType<ToolchainsApi["listAssets"]>>[number];

/**
 * A Toolchain is an MCP tool the agents call for an app or web page they used to operate by hand
 * The rail lists them with where each stands: callable, in trial, being repaired, or failing often.
 */
function stateLabel(asset: Asset, ko: boolean): string {
  if (asset.health?.state === "pulled_back") return ko ? "수리 중" : "Under repair";
  if (asset.health?.state === "degraded") return ko ? "오류 잦음" : "Failing often";
  if (asset.status === "callable") return ko ? `호출 가능 · v${asset.stableVersion}` : `Callable · v${asset.stableVersion}`;
  if (asset.status === "draft") return ko ? "실제 사용으로 검증 중" : "Proving itself in real use";
  return ko ? "호출 중단" : "Withdrawn";
}

export function OneToolchains({ api, locale }: { api: ToolchainsApi | null | undefined; locale: string }) {
  const copy = useMemo(() => toolchainCopy(locale), [locale]);
  const ko = locale === "ko";
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!api) return;
    try { setAssets(await api.listAssets()); setError(null); }
    catch (cause) { setError(toolchainErrorText(cause, copy)); }
  }, [api, copy]);
  useVisibleInterval(load, 60_000, { initial: load });
  if (!api) return <section className={styles.root}><p className={styles.empty}>{copy.unavailable}</p></section>;
  const visible = assets.filter((asset) => asset.status !== "withdrawn");
  return <section className={styles.root} aria-label={copy.title}>
    <header className={styles.header}><div><h2>{copy.title}</h2><p>{ko ? "앱·웹 페이지를 다루는 MCP 도구 · 손으로 하던 일을 굳힌 것" : "MCP tools for apps and web pages · work once done by hand"}</p></div><button onClick={() => navigate("/library/toolchains")}>{copy.viewAll}</button></header>
    {error && <p className={styles.error} role="status">{error}</p>}
    {visible.length === 0 && <p className={styles.empty}>{ko ? "아직 툴체인이 없습니다. 같은 앱·페이지 작업이 반복되면 자동으로 만들어집니다." : "No Toolchains yet. They are made when the same app or page work keeps coming back."}</p>}
    {visible.slice(0, 6).map((asset) => <button key={asset.id} className={styles.asset} data-toolchain-asset={asset.id} data-health={asset.health?.state ?? "unknown"}
      onClick={() => navigate(`/library/toolchains?asset=${encodeURIComponent(asset.id)}`)}><IconToolchain size={14}/><span>{asset.name}</span><small>{stateLabel(asset, ko)}</small></button>)}
  </section>;
}
