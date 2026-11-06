import { z } from 'zod';
import '../../shared/canvas/blocks/registry'; // installs every asset: the catalog reads them
import { ASSET_BLOCKS, ASSET_CATEGORIES, BASE_BLOCK_TYPES, assetEntry, assetIndex, assetSearch } from '../../shared/canvas';

/**
 * ui.asset.catalog: what the card's asset blocks are and how to write one. Read on demand, so the ui.canvas description stays short:
 *   no argument    the category names and every type name, nothing else (small)
 *   category       that category's types with a one-line use, default width and frame
 *   type           one block: what it is for, its required and optional fields, and a sample to copy the shape from
 *   query          the types matching some words (a type name, a tag, a word of its use), best first
 * A read only: it changes nothing and shows nothing to the owner.
 */
export const AssetCatalogInputSchema = z.object({
  category: z.preprocess(value => (typeof value === 'string' ? value.trim().toLowerCase() : value), z.enum(ASSET_CATEGORIES)).optional(),
  type: z.preprocess(value => (typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : value), z.string().max(40)).optional(),
  query: z.string().trim().max(80).optional(),
}).strip();

export const assetCatalogInputJsonSchema = { type: 'object', additionalProperties: false, properties: {
  category: { enum: [...ASSET_CATEGORIES], description: 'List this category\'s types with a one-line use.' },
  type: { type: 'string', maxLength: 40, description: 'One asset type: its fields and a sample.' },
  query: { type: 'string', maxLength: 80, description: 'Words (English or Korean) for the kind of block wanted: finds matching types.' },
} };

type CatalogOutcome = { status: 'ok'; data: unknown } | { status: 'refused'; reason: string; next: string; data?: unknown };

export function readAssetCatalog(raw: Record<string, unknown>): CatalogOutcome {
  const parsed = AssetCatalogInputSchema.safeParse(raw);
  if (!parsed.success) return { status: 'refused', reason: 'asset_catalog_arguments_invalid', next: `category is one of ${ASSET_CATEGORIES.join(', ')}; type is one type name; query is some words. Send none of them to list every name.`, data: { issues: parsed.error.issues.slice(0, 4).map(issue => ({ path: issue.path.join('.'), message: issue.message })) } };
  const { category, type, query } = parsed.data;
  if (type) {
    const entry = assetEntry(type);
    if (entry) return { status: 'ok', data: { ...entry, next: 'Send the block as { type, ...fields } inside ui.canvas blocks; the sample is a valid block. title and width are optional on any block.' } };
    if (BASE_BLOCK_TYPES.includes(type)) return { status: 'ok', data: { type, base: true, next: 'This is one of the figure blocks: its fields are in the ui.canvas input schema.' } };
    const near = assetSearch(type.replace(/_/g, ' '), 6);
    return { status: 'refused', reason: 'asset_type_unknown', next: `${near.length ? `Did you mean ${near.join(', ')}? ` : ''}ui.asset.catalog with a query lists types for the words you give.`, data: { near } };
  }
  if (query) return { status: 'ok', data: { matches: assetSearch(query, 12).map(name => { const entry = assetEntry(name)!; return { type: name, category: entry.category, use: entry.use }; }), next: 'Read one with { type } before writing it.' } };
  if (category) return { status: 'ok', data: { category, types: ASSET_BLOCKS.filter(asset => asset.category === category).map(asset => ({ type: asset.type, use: asset.use, width: asset.width, ...(asset.frame && asset.frame !== 'card' ? { frame: asset.frame } : {}) })), next: 'Read one with { type } for its fields and a sample.' } };
  const index = assetIndex();
  return { status: 'ok', data: { categories: Object.fromEntries(Object.entries(index).map(([name, rows]) => [name, rows.map(row => row.type)])), figureBlocks: BASE_BLOCK_TYPES, next: 'Read a category with { category } for one-line uses, one block with { type } for its fields and sample, or { query } to search.' } };
}
