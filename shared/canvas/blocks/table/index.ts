import type { AnyAsset } from "../contract";
import { ASSETS as compare } from "./compare";
import { ASSETS as work } from "./work";
import { ASSETS as numbers } from "./numbers";

/** The table assets (one file per group of related blocks; this list is the category's index). */
export const ASSETS: readonly AnyAsset[] = [...compare, ...work, ...numbers];
