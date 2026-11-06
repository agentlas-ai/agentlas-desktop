import { z } from "zod";
import { base } from "../fields";
import { esc } from "../kit";
import { ASSET_CATEGORIES, type AnyAsset, type AssetCategory } from "./contract";

/**
 * The asset registry's mechanics, without any asset in it. `registry.ts` is the entry that loads every category and installs it here.
 * The split keeps the assets (hundreds of KB of drawing code) out of any bundle that only draws figure cards: the card's schema and renderer
 * import this file, and a page that meets an asset block loads `registry.ts` once (renderer/components/finance/FinancePresentCard.tsx),
 * while the host (electron/canvas, the phone projection) imports `registry.ts` up front.
 */

/** Block types the card's own schema owns (schema.ts); an asset may not take one of these names. */
export const BASE_BLOCK_TYPES: readonly string[] = ["kpis", "bars", "ranges", "chart", "leans", "table", "heatmap", "allocation", "timeline", "checklist", "gauge", "note"];

/** Every installed asset, grouped by category in the contract's order (the same array object for the life of the process). */
export const ASSET_BLOCKS: AnyAsset[] = [];
const byType = new Map<string, AnyAsset>();
const schemas = new Map<string, z.ZodTypeAny>();

/** True once the assets are installed. */
export const assetsInstalled = (): boolean => ASSET_BLOCKS.length > 0;

/** Installs the categories' assets, once. A duplicate or a base name is dropped (scripts/test-ui-assets.cjs fails on it). */
export function installAssets(byCategory: Record<AssetCategory, readonly AnyAsset[]>): void {
  if (ASSET_BLOCKS.length) return;
  const seen = new Set<string>(BASE_BLOCK_TYPES);
  for (const category of ASSET_CATEGORIES) for (const asset of byCategory[category]) if (asset.category === category && !seen.has(asset.type)) { seen.add(asset.type); ASSET_BLOCKS.push(asset); byType.set(asset.type, asset); }
}

export const assetByType = (type: unknown): AnyAsset | undefined => (typeof type === "string" ? byType.get(type) : undefined);
/** The block's validator: its own fields with the host's `type`, `title` and `width`. */
export function assetSchema(asset: AnyAsset): z.ZodTypeAny {
  let schema = schemas.get(asset.type);
  if (!schema) { schema = z.object({ type: z.literal(asset.type), ...base, ...asset.fields }).strip(); schemas.set(asset.type, schema); }
  return schema;
}

/** The block's markup, wrapped in the frame it keeps. A block that fails to draw is a short note, never a broken card. */
export function assetHtml(block: { type: string } & Record<string, unknown>, uid: string, ko: boolean): string {
  const asset = byType.get(block.type);
  if (!asset) return `<p class="muted">${esc(block.type)}</p>`;
  const frame = asset.frame && asset.frame !== "card" ? ` af af-${asset.frame.replace(":", "x")}` : "";
  try {
    const inner = asset.render(block as never, { uid, ko, T: (en, kr) => (ko ? kr : en) });
    return `<figure class="asset a-${asset.type}${frame}" aria-label="${esc(assetSummary(block))}">${inner}</figure>`;
  } catch { return `<p class="muted">${esc(assetSummary(block))}</p>`; }
}

/** The block as plain text: what an old phone, a screen reader or a refused visual shows. */
export function assetSummary(block: { type: string } & Record<string, unknown>): string {
  const asset = byType.get(block.type);
  try { return asset ? asset.summary(block as never).replace(/\s+/g, " ").trim().slice(0, 400) : ""; } catch { return ""; }
}

/** The styles of just the assets a card uses (a phone's visual carries no others). */
export function assetCssFor(types: Iterable<string>): string {
  const seen = new Set<string>(); let css = "";
  for (const type of types) { const asset = byType.get(type); if (asset?.css && !seen.has(type)) { seen.add(type); css += asset.css; } }
  return css;
}

/** The catalog's compact index: category → [{ type, use }]. Names only, so it stays small. */
export function assetIndex(): Record<AssetCategory, { type: string; use: string; useKo: string }[]> {
  const out = Object.fromEntries(ASSET_CATEGORIES.map(category => [category, [] as { type: string; use: string; useKo: string }[]])) as Record<AssetCategory, { type: string; use: string; useKo: string }[]>;
  for (const asset of ASSET_BLOCKS) out[asset.category].push({ type: asset.type, use: asset.use, useKo: asset.useKo });
  return out;
}

/** One asset's catalog entry: what it is for, the fields it needs, and one sample to copy the shape from. */
export function assetEntry(type: string) {
  const asset = byType.get(type);
  if (!asset) return null;
  const shape = asset.fields as Record<string, z.ZodTypeAny>;
  const required = Object.keys(shape).filter(key => !shape[key].isOptional()), optional = Object.keys(shape).filter(key => shape[key].isOptional());
  return { type: asset.type, category: asset.category, use: asset.use, useKo: asset.useKo, width: asset.width, ...(asset.frame && asset.frame !== "card" ? { frame: asset.frame } : {}), required, optional, ...(asset.notes ? { notes: asset.notes } : {}), sample: asset.sample };
}

/** Search the catalog by words: a type name, a tag or a word of its use. Returns types, best first. */
export function assetSearch(query: string, limit = 12): string[] {
  const words = query.toLowerCase().split(/[^a-z0-9가-힣]+/).filter(Boolean);
  if (!words.length) return [];
  const scored = ASSET_BLOCKS.map(asset => {
    const hay = { type: asset.type.replace(/_/g, " "), tags: asset.tags.join(" "), use: `${asset.use} ${asset.useKo}`.toLowerCase() };
    const score = words.reduce((sum, word) => sum + (hay.type.includes(word) ? 3 : 0) + (hay.tags.includes(word) ? 2 : 0) + (hay.use.includes(word) ? 1 : 0), 0);
    return { type: asset.type, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.type.localeCompare(b.type));
  return scored.slice(0, limit).map(item => item.type);
}
