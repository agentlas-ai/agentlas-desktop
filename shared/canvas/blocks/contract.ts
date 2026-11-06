import type { z } from "zod";

/**
 * The asset contract: one declarative record per block type. A card is composed from blocks (schema.ts holds the 12 base blocks that
 * carry Finance figures; every other block is an asset declared here). An asset names its fields, draws itself, writes its own plain-text
 * summary and carries one realistic sample. Nothing else registers it: the catalog (ui.asset.catalog), the card's validation, the
 * HTML (desktop and phone), the stills gallery and the plain-text fallback all read this record.
 *
 * Rules an asset keeps (scripts/test-ui-assets.cjs locks each one):
 *  - `type` is lower_snake, unique across every asset and the base blocks, and is the wire name of the block.
 *  - `fields` use the readers of ../fields (text, list, num, loose ...): a value over its limit is cut and a synonym is read, never refused;
 *    a value that is genuinely missing still fails, so a card never shows a guess. `title` and `width` are added by the host.
 *  - `render` is pure and returns markup for the card; every string reaches it through `esc` / `bold` (../kit). No script, no style
 *    attribute built from input, no external address (no font, image or link); colours come from the card's variables or ../kit.
 *  - `summary` is the same card read aloud: plain text, at most 400 characters, the figures and labels, no markup.
 *  - `sample` validates against `fields` and fills the block the way a real answer would (the gallery draws it).
 *  - `css` is only what the shared card styles do not already give, every selector under `.fpc .a-<type>`, at most 3000 characters.
 */
export const ASSET_CATEGORIES = ["document", "thumbnail", "chart", "table", "diagram", "motion", "slide"] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

/** The frame an asset is drawn in: `card` flows with the grid; the others keep their aspect ratio and scale their type with the frame's width. */
export const ASSET_FRAMES = ["card", "16:9", "4:3", "1:1", "9:16", "a4", "thumb"] as const;
export type AssetFrame = (typeof ASSET_FRAMES)[number];

export interface AssetRenderContext {
  /** Distinct per block on a page: prefix every SVG id (gradients, clip paths) with it. */
  uid: string;
  /** True when the card's language is Korean. */
  ko: boolean;
  /** The text for the card's language. */
  T(en: string, ko: string): string;
}

export interface AssetBlock<Shape extends z.ZodRawShape = z.ZodRawShape> {
  type: string;
  category: AssetCategory;
  /** What the model uses it for, one English sentence (shown by the catalog). */
  use: string;
  /** The same in Korean. */
  useKo: string;
  /** Search words, English and Korean, lower case. */
  tags: readonly string[];
  fields: Shape;
  /** Default grid width. */
  width: "full" | "two_thirds" | "half" | "third";
  frame?: AssetFrame;
  render(input: z.output<z.ZodObject<Shape>> & { title?: string }, ctx: AssetRenderContext): string;
  summary(input: z.output<z.ZodObject<Shape>> & { title?: string }): string;
  sample: unknown;
  /** One optional line of guidance the catalog shows with the sample (limits, units, what to leave out). */
  notes?: string;
  css?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAsset = AssetBlock<any>;

/** Declares an asset; returns it unchanged (the generic carries the field types into `render` and `summary`). */
export function defineAsset<Shape extends z.ZodRawShape>(asset: AssetBlock<Shape>): AssetBlock<Shape> { return asset; }

/**
 * A day for a sample, as an offset from a fixed base: the samples hold no date literal and draw the same every time (a sample that read the clock
 * would change the stills, the hashes and the catalog from one day to the next).
 */
export const sampleDay = (offset: number): string => new Date(Date.UTC(2026, 5, 1) + offset * 864e5).toISOString().slice(0, 10);
