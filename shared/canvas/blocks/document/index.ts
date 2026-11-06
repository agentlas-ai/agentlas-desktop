import type { AnyAsset } from "../contract";
import { ASSETS as business } from "./business";
import { ASSETS as messages } from "./messages";
import { ASSETS as pages } from "./pages";
import { ASSETS as people } from "./people";

/** The document assets (one file per group of related blocks; this list is the category's index). */
export const ASSETS: readonly AnyAsset[] = [...pages, ...business, ...people, ...messages];
