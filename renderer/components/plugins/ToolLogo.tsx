"use client";

// Brand logo for the tool library. Order of sources, all real:
//  1. the Hub brand asset served by Main (`agentlas://plugin-icon/?slug=`, electron/mcp-tools/plugin-brand.ts)
//  2. the bundled simple-icons mark for that brand (brandGlyphs.ts, generated)
//  3. the Hub catalog's own Latin monogram on its brand colour (bundled-hub-catalog.json `monogram`)
//  4. a neutral plug glyph for anything unknown — never a localized initial.
import { useState } from "react";
import { pluginSlugCandidates } from "@/components/PluginLogo";
import type { PluginBrandAsset } from "@/lib/types";
import { BRAND_GLYPHS } from "./brandGlyphs";
import { bundledBrand } from "./toolsModel";
import styles from "./ToolsUi.module.css";

export type LogoFrame = "bare" | "row" | "card" | "hero" | "detail";

const FRAME: Record<LogoFrame, { box: number; mark: number }> = {
  bare: { box: 16, mark: 16 },
  row: { box: 36, mark: 22 },
  card: { box: 48, mark: 28 },
  hero: { box: 56, mark: 34 },
  detail: { box: 60, mark: 36 },
};

export function ToolLogo({ slug, catalogId, name, frame = "row", size, brandMap, brandColor }: {
  slug?: string | null;
  catalogId?: string | null;
  name: string;
  frame?: LogoFrame;
  /** Overrides the frame's outer size (the mark scales with it). */
  size?: number;
  brandMap?: Record<string, PluginBrandAsset>;
  brandColor?: string;
}) {
  const [failed, setFailed] = useState(false);
  const base = FRAME[frame];
  const box = size ?? base.box;
  const mark = Math.round(box * (base.mark / base.box));
  const candidates = pluginSlugCandidates({ slug, catalogId, name });
  const asset = candidates.map((key) => brandMap?.[key]).find((value) => value && (value.iconUrl || value.brandGlyphUrl));
  const glyph = candidates.map((key) => BRAND_GLYPHS[key]).find(Boolean);
  const bundled = candidates.map((key) => bundledBrand(key)).find(Boolean);

  let content: React.ReactNode;
  if (asset && !failed) {
    const glyphOnly = !asset.iconUrl && !!asset.brandGlyphUrl;
    // eslint-disable-next-line @next/next/no-img-element
    const img = <img src={`agentlas://plugin-icon/?slug=${encodeURIComponent(asset.slug)}`} alt="" width={mark} height={mark} onError={() => setFailed(true)} style={{ width: glyphOnly ? Math.round(mark * 0.7) : mark, height: glyphOnly ? Math.round(mark * 0.7) : mark, objectFit: "contain", display: "block" }} />;
    content = glyphOnly
      ? <span className={styles.logoMono} style={{ width: mark, height: mark, background: asset.brandColor ?? brandColor ?? "var(--ink)" }}>{img}</span>
      : img;
  } else if (glyph) {
    content = <svg width={mark} height={mark} viewBox="0 0 24 24" role="img" aria-label={glyph.title}><path d={glyph.path} fill={`#${glyph.hex}`} /></svg>; // colour-literal-allowed: official brand colour from simple-icons
  } else if (bundled?.monogram) {
    content = <span className={styles.logoMono} style={{ width: mark, height: mark, background: bundled.brandColor ?? brandColor ?? "var(--ink)", fontSize: Math.round(mark * (bundled.monogram.length > 1 ? 0.42 : 0.56)) }}>{bundled.monogram}</span>;
  } else {
    content = <svg width={Math.round(mark * 0.72)} height={Math.round(mark * 0.72)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5" /></svg>;
  }
  if (frame === "bare") return <span className={styles.logoBare} style={{ width: box, height: box }} aria-hidden="true">{content}</span>;
  return <span className={styles.logoTile} data-frame={frame} style={{ width: box, height: box }} aria-hidden="true">{content}</span>;
}
